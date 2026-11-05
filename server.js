// Soil Moisture Dashboard — zero-dependency Node backend (Node 18+).
// Proxies + caches Open-Meteo (weather + geocoding) and Nominatim (reverse geocoding),
// and serves the static frontend from ./public.
// All "is my soil thirsty?" analysis happens in the browser, so the time slider,
// plant presets and soil types update instantly without another request.
//
// Why so much care around caching: Open-Meteo's free limits are counted per IP address, and on
// shared hosts (Render, Vercel, ...) that address is shared with other apps. So this server
//   - caches every place for 30 min and merges identical in-flight requests into one,
//   - retries once, and tells the page the *real* reason when Open-Meteo refuses,
//   - serves the last good data (marked "stale") for up to 12 h if Open-Meteo keeps refusing.
// If the server still can't get data, the page asks Open-Meteo directly from the visitor's own IP.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TTL_MS = Number(process.env.WEATHER_TTL_MS) || 30 * 60 * 1000;   // models update hourly at most
const STALE_MS = 12 * 60 * 60 * 1000;                                  // how long old data may stand in for a failed refresh
const RETRY_MS = process.env.RETRY_MS != null ? Number(process.env.RETRY_MS) : 1500;
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const UA = 'soil-moisture-dashboard (personal project)';

// Soil layers provided by Open-Meteo (values in m³/m³).
const LAYERS = [
  { key: 'soil_moisture_0_to_1cm', label: '0–1 cm', from: 0, to: 1 },
  { key: 'soil_moisture_1_to_3cm', label: '1–3 cm', from: 1, to: 3 },
  { key: 'soil_moisture_3_to_9cm', label: '3–9 cm', from: 3, to: 9 },
  { key: 'soil_moisture_9_to_27cm', label: '9–27 cm', from: 9, to: 27 },
  { key: 'soil_moisture_27_to_81cm', label: '27–81 cm', from: 27, to: 81 },
];

// ---------- cache: TTL + in-flight merging + stale-on-error ----------
const cache = new Map();
const inflight = new Map();
async function cached(key, producer, ttl = TTL_MS, staleMs = 0) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return { v: hit.v, t: hit.t, stale: false };
  if (inflight.has(key)) return inflight.get(key);          // someone is already fetching this: share the answer
  const p = (async () => {
    try {
      const v = await producer();
      const t = Date.now();
      cache.set(key, { t, v });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return { v, t, stale: false };
    } catch (e) {
      if (hit && Date.now() - hit.t < staleMs) return { v: hit.v, t: hit.t, stale: true };
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------- upstream access ----------
class UpstreamError extends Error {
  constructor(status, reason) {
    super(reason || `Upstream ${status}`);
    this.upstream = status;   // HTTP status from the weather service (0 = no answer at all)
    this.reason = reason || '';
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 2) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    } catch (e) {
      if (i + 1 < tries) { await sleep(RETRY_MS); continue; }
      throw new UpstreamError(0, `no answer (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
    }
    if (res.ok) return res.json();
    let reason = '';
    try { const j = await res.json(); reason = typeof j.reason === 'string' ? j.reason : typeof j.error === 'string' ? j.error : ''; } catch {}
    // a daily/monthly quota won't clear in a second, so only retry short-lived refusals
    const retryable = (res.status === 429 && !/daily|monthly/i.test(reason)) || res.status >= 500;
    if (retryable && i + 1 < tries) { await sleep(RETRY_MS); continue; }
    console.warn(`[upstream] ${res.status} ${new URL(url).hostname}${new URL(url).pathname} ${reason}`);
    throw new UpstreamError(res.status, reason);
  }
}

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const col = (arr, d = 1) => arr.map(v => round(v, d));

// ---- NOTE: buildQuery() and shapeWeather() are mirrored in public/index.html (used when the
// ---- browser has to ask Open-Meteo directly). Keep the two copies identical.
function buildQuery(lat, lon) {
  return new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current: 'temperature_2m',
    hourly: [
      ...LAYERS.map(l => l.key),
      'soil_temperature_6cm', 'temperature_2m', 'relative_humidity_2m', 'precipitation',
      'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'is_day',
    ].join(','),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,et0_fao_evapotranspiration',
    past_days: '5',
    forecast_days: '7',
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
}
function shapeWeather(raw, lat, lon) {
  const h = raw.hourly;
  // index of the current hour (times are local ISO strings, so string compare works)
  let nowIdx = 0;
  for (let i = 0; i < h.time.length; i++) if (h.time[i] <= raw.current.time) nowIdx = i;
  return {
    location: { lat, lon, timezone: raw.timezone, elevation: raw.elevation },
    nowIdx,
    layers: LAYERS.map(({ label, from, to }) => ({ label, from, to })),
    hourly: {
      time: h.time,
      m: LAYERS.map(l => col(h[l.key], 3)),
      soilTemp: col(h.soil_temperature_6cm),
      temp: col(h.temperature_2m),
      rh: col(h.relative_humidity_2m, 0),
      rain: col(h.precipitation),
      wind: col(h.wind_speed_10m),
      gust: col(h.wind_gusts_10m),
      dir: col(h.wind_direction_10m, 0),
      isDay: h.is_day,
    },
    daily: raw.daily.time.map((d, i) => ({
      date: d,
      tMax: raw.daily.temperature_2m_max[i],
      tMin: raw.daily.temperature_2m_min[i],
      rain: raw.daily.precipitation_sum[i],
      wind: raw.daily.wind_speed_10m_max[i],
      et0: raw.daily.et0_fao_evapotranspiration[i],
    })),
    source: 'Open-Meteo.com',
  };
}

// ---------- API handlers ----------
const snap = n => Math.round(n * 100) / 100;   // ~1 km: nearby clicks share one cache entry (the model grid is ~10 km anyway)

async function handleWeather(params) {
  const lat0 = Number(params.get('lat'));
  const lon0 = Number(params.get('lon'));
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0) || Math.abs(lat0) > 90 || Math.abs(lon0) > 180) {
    throw Object.assign(new Error('Invalid lat/lon'), { status: 400 });
  }
  const lat = snap(lat0), lon = snap(lon0);
  const key = `w:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const { v: raw, t, stale } = await cached(key, () => getJSON(`${FORECAST_URL}?${buildQuery(lat, lon)}`), TTL_MS, STALE_MS);
  return { ...shapeWeather(raw, lat, lon), fetchedAt: new Date(t).toISOString(), stale };
}

// UI languages the page offers; place names come back in the chosen one.
const LANGS = ['en', 'es', 'fr', 'de', 'pt'];
const langOf = params => (LANGS.includes(params.get('lang')) ? params.get('lang') : 'en');

async function handleSearch(params) {
  const q = (params.get('q') || '').trim();
  if (q.length < 2) return { results: [] };
  const lang = langOf(params);
  const url = `${GEO_URL}?${new URLSearchParams({ name: q, count: '6', language: lang, format: 'json' })}`;
  const { v: data } = await cached(`g:${lang}:${q.toLowerCase()}`, () => getJSON(url), 60 * 60 * 1000, STALE_MS);
  return {
    results: (data.results || []).map(r => ({
      name: r.name, admin: r.admin1 || '', country: r.country || '', lat: r.latitude, lon: r.longitude,
    })),
  };
}

// Name a point picked on the map. Best-effort: the client keeps a "Pin lat, lon" fallback.
async function handleReverse(params) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw Object.assign(new Error('Invalid lat/lon'), { status: 400 });
  }
  const lang = langOf(params);
  const url = `${REVERSE_URL}?${new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4), format: 'jsonv2', zoom: '10', 'accept-language': lang })}`;
  const { v: data } = await cached(`r:${lang}:${lat.toFixed(2)},${lon.toFixed(2)}`, () => getJSON(url), 60 * 60 * 1000);
  const a = data.address || {};
  const place = a.city || a.town || a.village || a.municipality || a.county || a.state || '';
  const name = [place, a.country].filter(Boolean).join(', ');
  return { name: name || null };
}

// ---------- server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  try {
    if (url.pathname === '/api/weather') return send(200, await handleWeather(url.searchParams));
    if (url.pathname === '/api/search') return send(200, await handleSearch(url.searchParams));
    if (url.pathname === '/api/reverse') {
      // never fail the UI over a nicety: answer with a null name if the lookup breaks
      try { return send(200, await handleReverse(url.searchParams)); }
      catch (e) { if (e.status) throw e; return send(200, { name: null }); }
    }

    // static files (no directory traversal)
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(404, { error: 'Not found' });
      send(200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    if (e instanceof UpstreamError) {
      // tell the page what really happened so it can explain it (or ask Open-Meteo itself)
      return send(e.upstream === 429 ? 429 : 502, { error: e.upstream === 429 ? 'rate_limited' : 'upstream', reason: e.reason, upstream: e.upstream });
    }
    send(e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Soil moisture dashboard → http://localhost:${PORT}`));
