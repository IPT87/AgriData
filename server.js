// Soil Moisture Dashboard — zero-dependency Node backend (Node 18+).
// Proxies + caches Open-Meteo, derives a simple "is my soil thirsty?" analysis,
// and serves the static frontend from ./public.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TTL_MS = 10 * 60 * 1000; // Open-Meteo models update hourly; 10 min cache is plenty
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Soil layers provided by Open-Meteo (values in m³/m³) with thickness in cm.
const LAYERS = [
  { key: 'soil_moisture_0_to_1cm', label: '0–1 cm', thickness: 1 },
  { key: 'soil_moisture_1_to_3cm', label: '1–3 cm', thickness: 2 },
  { key: 'soil_moisture_3_to_9cm', label: '3–9 cm', thickness: 6 },
  { key: 'soil_moisture_9_to_27cm', label: '9–27 cm', thickness: 18 },
  { key: 'soil_moisture_27_to_81cm', label: '27–81 cm', thickness: 54 },
];

// Rough, typical values (m³/m³). wilt = wilting point, fc = field capacity.
const SOILS = {
  sand: { name: 'Sandy', wilt: 0.06, fc: 0.15 },
  loam: { name: 'Loam', wilt: 0.12, fc: 0.30 },
  clay: { name: 'Clay', wilt: 0.22, fc: 0.42 },
};

// ---------- tiny TTL cache ----------
const cache = new Map();
async function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const v = await producer();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'soil-moisture-dashboard' } });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  return res.json();
}

// ---------- analysis ----------
function analyze({ layersNow, soil, rainNext48h, etToday }) {
  // "Root zone" = top 27 cm, weighted by layer thickness.
  const rz = LAYERS.slice(0, 4);
  const totalT = rz.reduce((s, l) => s + l.thickness, 0);
  const rootZone = rz.reduce((s, l, i) => s + layersNow[i] * l.thickness, 0) / totalT;

  // 0 = wilting point, 1 = field capacity
  const available = (rootZone - soil.wilt) / (soil.fc - soil.wilt);

  let status, emoji, headline;
  if (available < 0.2) { status = 'thirsty'; emoji = '🥵'; headline = 'Bone dry'; }
  else if (available < 0.5) { status = 'drying'; emoji = '🌤️'; headline = 'Getting dry'; }
  else if (available <= 1.0) { status = 'happy'; emoji = '🌱'; headline = 'Nicely moist'; }
  else { status = 'saturated'; emoji = '💧'; headline = 'Saturated'; }

  let advice;
  if (status === 'saturated') advice = 'Soil is at or above field capacity. Skip watering; water may run off or drain below the roots.';
  else if (status === 'happy') advice = 'Root zone has plenty of plant-available water. No action needed.';
  else if (rainNext48h >= 5) advice = `Soil is ${headline.toLowerCase()}, but about ${rainNext48h.toFixed(0)} mm of rain is forecast in the next 48 h. Consider waiting.`;
  else if (status === 'thirsty') advice = 'Plants may be under stress. Water deeply, and soon.';
  else advice = 'Soil is drying out. Plan to water within a day or two, especially for shallow-rooted plants.';
  if (etToday != null && status !== 'saturated') advice += ` Today’s evaporative demand is about ${etToday.toFixed(1)} mm.`;

  return {
    rootZone: round(rootZone, 3),
    availablePct: Math.round(Math.max(0, available) * 100),
    status, emoji, headline, advice,
  };
}

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// ---------- API handlers ----------
async function handleWeather(params) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw Object.assign(new Error('Invalid lat/lon'), { status: 400 });
  }
  const soilKey = SOILS[params.get('soil')] ? params.get('soil') : 'loam';
  const soil = SOILS[soilKey];

  const q = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
    hourly: [...LAYERS.map(l => l.key), 'soil_temperature_6cm', 'precipitation'].join(','),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,et0_fao_evapotranspiration',
    past_days: '5',
    forecast_days: '7',
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  const key = `w:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const raw = await cached(key, () => getJSON(`${FORECAST_URL}?${q}`));

  const h = raw.hourly;
  // index of the current hour (times are local ISO strings, so string compare works)
  let idx = 0;
  for (let i = 0; i < h.time.length; i++) if (h.time[i] <= raw.current.time) idx = i;

  const layersNow = LAYERS.map(l => h[l.key][idx]);
  const today = raw.current.time.slice(0, 10);
  const dIdx = raw.daily.time.indexOf(today);
  const rainNext48h = raw.daily.precipitation_sum.slice(dIdx, dIdx + 2).reduce((a, b) => a + (b || 0), 0);
  const etToday = raw.daily.et0_fao_evapotranspiration[dIdx];

  // Root-zone series for the chart (every 3 h to keep payload small)
  const series = [];
  for (let i = 0; i < h.time.length; i += 3) {
    const rz = LAYERS.slice(0, 4).reduce((s, l) => s + h[l.key][i] * l.thickness, 0) / 27;
    series.push({
      t: h.time[i],
      surface: round(h.soil_moisture_0_to_1cm[i], 3),
      rootZone: round(rz, 3),
      deep: round(h.soil_moisture_27_to_81cm[i], 3),
    });
  }

  return {
    location: { lat, lon, timezone: raw.timezone, elevation: raw.elevation },
    soil: { type: soilKey, ...soil },
    now: {
      time: raw.current.time,
      isDay: !!raw.current.is_day,
      airTemp: raw.current.temperature_2m,
      humidity: raw.current.relative_humidity_2m,
      precipitation: raw.current.precipitation,
      windSpeed: raw.current.wind_speed_10m,
      windGusts: raw.current.wind_gusts_10m,
      windDir: raw.current.wind_direction_10m,
      soilTemp: h.soil_temperature_6cm[idx],
    },
    layers: LAYERS.map((l, i) => ({ label: l.label, thickness: l.thickness, value: round(layersNow[i], 3) })),
    analysis: analyze({ layersNow, soil, rainNext48h, etToday }),
    series,
    nowIndex: Math.floor(idx / 3),
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

async function handleSearch(params) {
  const q = (params.get('q') || '').trim();
  if (q.length < 2) return { results: [] };
  const url = `${GEO_URL}?${new URLSearchParams({ name: q, count: '6', language: 'en', format: 'json' })}`;
  const data = await cached(`g:${q.toLowerCase()}`, () => getJSON(url));
  return {
    results: (data.results || []).map(r => ({
      name: r.name, admin: r.admin1 || '', country: r.country || '', lat: r.latitude, lon: r.longitude,
    })),
  };
}

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  try {
    if (url.pathname === '/api/weather') return send(200, await handleWeather(url.searchParams));
    if (url.pathname === '/api/search') return send(200, await handleSearch(url.searchParams));

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
