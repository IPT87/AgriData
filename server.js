// Soil Moisture Dashboard — zero-dependency Node backend (Node 18+).
// Proxies + caches Open-Meteo (weather + geocoding) and Nominatim (reverse geocoding),
// and serves the static frontend from ./public.
// All "is my soil thirsty?" analysis happens in the browser, so the time slider,
// plant presets and soil types update instantly without another request.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TTL_MS = 10 * 60 * 1000; // Open-Meteo models update hourly; 10 min cache is plenty
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

// ---------- tiny TTL cache ----------
const cache = new Map();
async function cached(key, producer, ttl = TTL_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await producer();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  return res.json();
}

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const col = (arr, d = 1) => arr.map(v => round(v, d));

// ---------- API handlers ----------
async function handleWeather(params) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw Object.assign(new Error('Invalid lat/lon'), { status: 400 });
  }

  const q = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
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
  const key = `w:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const raw = await cached(key, () => getJSON(`${FORECAST_URL}?${q}`));

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

// UI languages the page offers; place names come back in the chosen one.
const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'bg'];
const langOf = params => (LANGS.includes(params.get('lang')) ? params.get('lang') : 'en');

async function handleSearch(params) {
  const q = (params.get('q') || '').trim();
  if (q.length < 2) return { results: [] };
  const lang = langOf(params);
  const url = `${GEO_URL}?${new URLSearchParams({ name: q, count: '6', language: lang, format: 'json' })}`;
  const data = await cached(`g:${lang}:${q.toLowerCase()}`, () => getJSON(url));
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
  const data = await cached(`r:${lang}:${lat.toFixed(2)},${lon.toFixed(2)}`, () => getJSON(url), 60 * 60 * 1000);
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
    send(e.status || 502, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Soil moisture dashboard → http://localhost:${PORT}`));
