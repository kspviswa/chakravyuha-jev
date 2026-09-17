// scripts/record-geo-snapshots.mjs — record REAL Overpass responses into
// committed offline snapshots under fixtures/geo/.
//
//   node scripts/record-geo-snapshots.mjs [pairId ...]
//
// Each preset (lib/geo.js PLACE_PAIRS) is fetched once with a real User-Agent
// (Overpass 406s without one) and stored as `<id>.snapshot.json` holding the
// compact parsed roads. Offline / REPLAY traffic is re-rasterised from these.
// The road data is ODbL-licensed OpenStreetMap data (attribution is carried in
// the response and drawn on the page).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'fixtures', 'geo');
const UPSTREAM = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'jev-pathpuzzle/0.1 (real-map navigation demo; no API key; https://openstreetmap.org)';

const { PLACE_PAIRS, parseOverpass, ATTRIBUTION } = await import('../lib/geo.js');
const { validateBbox } = await import('../lib/geo.js');

function queryFor([s, w, n, e]) {
  return `[out:json][timeout:20];way["highway"](${s},${w},${n},${e});out geom;`;
}

async function fetchRoads(bbox) {
  const url = new URL(UPSTREAM);
  url.searchParams.set('data', queryFor(bbox));
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url.toString(), {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
      const json = await r.json();
      const roads = parseOverpass(json);
      if (!Array.isArray(roads)) throw new Error('unparseable Overpass response');
      if (attempt > 1) console.log(`  (retry ${attempt - 1} succeeded for ${bbox.join(',')})`);
      return roads;
    } catch (e) {
      lastErr = e;
      console.log(`  attempt ${attempt} failed: ${e.message} — retrying in 5s…`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

// The live /api/geo response keeps full Overpass fidelity; the committed
// snapshots are the OFFLINE fallback, so they are down-sampled to ~12 m
// spacing to keep the repo small — plenty for the 16×16 rasteriser.
const POINT_STEP_LAT = 0.00011;   // ≈ 12 m of latitude
const POINT_STEP_LON = 0.00017;   // ≈ 12 m of longitude at Ottawa's latitude

function downsample(points) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || Math.abs(p[0] - last[0]) > POINT_STEP_LAT || Math.abs(p[1] - last[1]) > POINT_STEP_LON) {
      out.push([Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
      last = p;
    }
  }
  return out.length >= 2 ? out : points;
}

async function main() {
  const want = new Set(process.argv.slice(2));
  const ids = Object.keys(PLACE_PAIRS).filter((id) => want.size === 0 || want.has(id));
  if (!ids.length) {
    console.error('no matching preset ids — pick from:', Object.keys(PLACE_PAIRS).join(', '));
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const id of ids) {
    const pair = PLACE_PAIRS[id];
    if (!validateBbox(pair.bbox)) throw new Error(`bad bbox for ${id}`);
    const roads = await fetchRoads(pair.bbox);
    const snapshot = {
      kind: 'geo-snapshot',
      id,
      label: pair.label,
      bbox: pair.bbox,
      places: pair.from && pair.to
        ? { from: { lat: pair.from.lat, lon: pair.from.lon, name: pair.from.name }, to: { lat: pair.to.lat, lon: pair.to.lon, name: pair.to.name } }
        : undefined,
      attribution: ATTRIBUTION,
      fetchedAt: new Date().toISOString(),
      roads: roads.map((r) => {
        const out = { class: r.class, points: downsample(r.points) };
        if (r.name) out.name = r.name;
        return out;
      }),
    };
    const file = path.join(OUT, `${id}.snapshot.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 1) + '\n');
    console.log(`${id}: ${roads.length} roads, ${pair.label} → ${path.basename(file)}`);
  }
  console.log('snapshots written to fixtures/geo/.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});