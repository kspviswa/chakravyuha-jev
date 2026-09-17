// test/geo.test.mjs — the real-map feed: Overpass is MOCKED throughout, so the
// suite passes with the network unplugged. Covers lib/geo.js (pure helpers) and
// the /api/geo endpoint (live → cache → snapshot → honest errors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROAD_COSTS, roadCost, parseBbox, expandBbox, rasterize, parseOverpass,
  snapCell, boardFromGeo, cellDistance, PLACE_PAIRS,
} from '../lib/geo.js';
import { shortestCost } from '../lib/referee.js';
import {
  geoCacheKey, buildGeoResponse, parseGeoPoint, matchGeoPair,
} from '../server.mjs';
import { startServer, stopServer } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---- synthetic roads over bbox [0,0,4,4], 4×4 -------------------------------
// Row 0 is the north edge. A primary road across it, a secondary down the east
// edge, a motorway across the south edge and a residential stub in the middle.
const SYNTH_ROADS = [
  { class: 'primary', points: [[3.5, 0], [3.5, 4]] },
  { class: 'secondary', points: [[4, 3.5], [0, 3.5]] },
  { class: 'motorway', points: [[0.5, 0], [0.5, 4]] },
  { class: 'residential', points: [[2.25, 1.25], [2.75, 1.75]] },
];

const SYNTH_BBOX = [0, 0, 4, 4];

/** A raw Overpass `out geom` body for a compact roads list. */
function overpassBody(roads) {
  return {
    version: 0.6,
    generator: 'mock-overpass',
    elements: roads.map((r, i) => ({
      type: 'way',
      id: i + 1,
      tags: { highway: r.class, ...(r.name ? { name: r.name } : {}) },
      geometry: r.points.map(([lat, lon]) => ({ lat, lon })),
    })),
  };
}

/** A throwaway Overpass stand-in that counts requests. */
async function makeMock(body) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    hits,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-geo-'));
}

// ---- lib/geo.js pure helpers -------------------------------------------------
test('roadCost: the exported table matches the spec', () => {
  assert.equal(ROAD_COSTS.motorway, 1);
  assert.equal(ROAD_COSTS.trunk_link, 1);
  assert.equal(ROAD_COSTS.primary, 2);
  assert.equal(ROAD_COSTS.secondary, 3);
  assert.equal(ROAD_COSTS.tertiary, 4);
  assert.equal(ROAD_COSTS.residential, 6);
  assert.equal(ROAD_COSTS.unclassified, 6);
  assert.equal(ROAD_COSTS.service, 8);
  assert.equal(ROAD_COSTS.footway, 8);
  assert.equal(roadCost('primary'), 2);
  assert.equal(roadCost('construction'), null);
  assert.equal(roadCost('elevator'), null);
});

test('rasterize: exact cost matrix + walls for a synthetic road set', () => {
  const { base, walls } = rasterize(SYNTH_ROADS, SYNTH_BBOX, 4, 4);
  assert.deepEqual(base, [
    [2, 2, 2, 2],
    [0, 6, 0, 3],
    [0, 0, 0, 3],
    [1, 1, 1, 1],
  ]);
  assert.deepEqual(walls, [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
    [1, 1, 1, 0],
    [0, 0, 0, 0],
  ]);
});

test('parseOverpass: keeps priced ways, rounds coordinates, drops junk', () => {
  const json = {
    elements: [
      { type: 'way', tags: { highway: 'primary', name: 'Bank St' }, geometry: [{ lat: 45.4245, lon: -75.69996 }, { lat: 45.42604, lon: -75.6972 }] },
      { type: 'way', tags: { highway: 'service' }, geometry: [{ lat: 1.0, lon: 1.0 }, { lat: 2.0, lon: 2.0 }] },
      { type: 'way', tags: { highway: 'construction', name: 'dig' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
      { type: 'way', tags: { highway: 'service' }, geometry: [{ lat: 5, lon: 5 }] },
      { type: 'node', tags: { highway: 'primary' }, geometry: [{ lat: 3, lon: 3 }, { lat: 4, lon: 4 }] },
    ],
  };
  const roads = parseOverpass(json);
  assert.equal(roads.length, 2);
  assert.equal(roads[0].class, 'primary');
  assert.equal(roads[0].name, 'Bank St');
  assert.deepEqual(roads[0].points[0], [45.4245, -75.69996]);
  assert.deepEqual(roads[0].points[1], [45.42604, -75.6972]);
  assert.equal(roads[1].class, 'service');
});

test('snapCell: exact-hit, nearest-ring, out-of-bounds, and no-road cases', () => {
  const walls = [
    [0, 1, 0],
    [1, 1, 1],
    [0, 1, 1],
  ];
  assert.deepEqual(snapCell(walls, 0, 0), { r: 0, c: 0 });   // exact hit
  assert.deepEqual(snapCell(walls, 1, 1), { r: 0, c: 0 });   // nearest in ring 1
  assert.deepEqual(snapCell(walls, 2, 1), { r: 2, c: 0 });   // wall → nearest open row
  assert.equal(snapCell(walls, 99, 99), null);               // out of bounds
  assert.equal(snapCell([[1], [1]], 0, 0), null);            // no road within radius
});

test('parseBbox / expandBbox / matchGeoPair / parseGeoPoint basics', () => {
  assert.deepEqual(parseBbox('0,0,4,4'), [0, 0, 4, 4]);
  assert.equal(parseBbox('4,0,0,4'), null); // south >= north
  assert.equal(parseBbox('0,0,4,4,9'), null);
  assert.equal(parseBbox('nope'), null);
  const expanded = expandBbox(SYNTH_BBOX, 0.15);
  assert.ok(expanded[0] < 0 && expanded[3] > 4, 'expands south/west/north/east');
  const pair = matchGeoPair(PLACE_PAIRS['byward-parliament'].bbox);
  assert.equal(pair.from.name, 'ByWard Market, Ottawa');
  assert.equal(matchGeoPair([1, 2, 3, 4]), null);
  assert.deepEqual(parseGeoPoint('45.42,-75.7'), { lat: 45.42, lon: -75.7 });
  assert.equal(parseGeoPoint('91,10'), null);
  assert.equal(parseGeoPoint('10,181'), null);
  assert.equal(parseGeoPoint('x,y'), null);
});

test('geoCacheKey is a stable sha1 of bbox+shape (and spec-shaped)', () => {
  const a = geoCacheKey(SYNTH_BBOX, 4, 4);
  const b = geoCacheKey(SYNTH_BBOX, 4, 4);
  assert.equal(a, b);
  assert.notEqual(a, geoCacheKey(SYNTH_BBOX, 5, 4));
  assert.notEqual(a, geoCacheKey([0, 0, 4, 5], 4, 4));
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('boardFromGeo + referee: the baked optimum is the least-cost verdict', () => {
  const src = { lat: 3.5, lon: 0.5, name: 'Start St' };
  const dst = { lat: 3.5, lon: 3.5, name: 'End Ave' };
  const built = buildGeoResponse({
    roads: SYNTH_ROADS, bbox: SYNTH_BBOX, rows: 4, cols: 4,
    endpoints: { from: src, to: dst },
    seed: 'test-seed', source: 'overpass', fetchedAt: 't',
  });
  assert.equal(built.ok, true, built.reason);
  const geo = built.data;
  assert.equal(geo.rows, 4);
  assert.equal(geo.cols, 4);
  assert.equal(geo.attribution, '© OpenStreetMap contributors');
  assert.ok(geo.optimum > 0, 'a real, finite optimum');

  const board = boardFromGeo(geo);
  assert.equal(shortestCost(board), geo.optimum, 'referee agrees with the server-baked optimum');
  assert.equal(board.weighted, true);
  assert.ok(cellDistance(board.src, board.dst) > 0);
});

test('buildGeoResponse: a goal inside road-free cells gets opened or snapped', () => {
  const built = buildGeoResponse({
    roads: SYNTH_ROADS, bbox: SYNTH_BBOX, rows: 8, cols: 8,
    endpoints: {
      from: { lat: 2.0, lon: 0.2, name: 'Start' },
      to: { lat: 2.0, lon: 3.8, name: 'Goal' },
    },
    seed: 'p', source: 'overpass', fetchedAt: 't',
  });
  assert.equal(built.ok, true, built.reason);
  const board = boardFromGeo(built.data);
  assert.ok(shortestCost(board) !== null, 'patched openings keep the board solvable');
  const note = built.data.notes.join(' ');
  assert.ok(/opened|snapped/.test(note), `notes explain the fix: ${note}`);
});

// ---- /api/geo server behaviour (mock Overpass) --------------------------------
test('/api/geo: live fetch returns a solvable board from the mocked Overpass', async () => {
  const mock = await makeMock(overpassBody([...SYNTH_ROADS, { class: 'primary', name: 'Main St', points: [[3.0, 0], [3.0, 4]] }]));
  const ctx = await startServer({ geoUpstream: mock.base, geoCacheDir: tmpdir(), geoSnapshotDir: tmpdir() });
  try {
    const r = await fetch(`${ctx.base}/api/geo?bbox=${SYNTH_BBOX.join(',')}&rows=4&cols=4&from=3.5,0.5&to=3.5,3.5`);
    assert.equal(r.status, 200);
    const geo = await r.json();
    assert.equal(geo.source, 'overpass');
    assert.ok(geo.places.from.name && geo.places.to.name, 'places carry names');
    assert.ok(geo.roads.length >= 5);
    assert.equal(geo.attribution, '© OpenStreetMap contributors');
    assert.equal(shortestCost(boardFromGeo(geo)), geo.optimum);
    assert.equal(mock.hits.length, 1, 'one upstream call for a live request');
  } finally {
    await stopServer(ctx);
    await mock.close();
  }
});

test('/api/geo: the cache serves a second identical request without upstream', async () => {
  const mock = await makeMock(overpassBody(SYNTH_ROADS));
  const cacheDir = tmpdir();
  const ctx = await startServer({ geoUpstream: mock.base, geoCacheDir: cacheDir, geoSnapshotDir: tmpdir() });
  try {
    const q = `bbox=${SYNTH_BBOX.join(',')}&rows=4&cols=4&from=3.5,0.5&to=3.5,3.5`;
    const r1 = await fetch(`${ctx.base}/api/geo?${q}`);
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).source, 'overpass');
    assert.equal(mock.hits.length, 1);

    const r2 = await fetch(`${ctx.base}/api/geo?${q}`);
    assert.equal(r2.status, 200);
    const cached = await r2.json();
    assert.equal(cached.source, 'cache');
    assert.equal(mock.hits.length, 1, 'cache hit must not re-query upstream');

    assert.equal(fs.readdirSync(cacheDir).length, 1, 'one cache file on disk');
    const r3 = await fetch(`${ctx.base}/api/geo?${q}&refresh=1`);
    assert.equal(r3.status, 200);
    assert.equal((await r3.json()).source, 'overpass');
    assert.equal(mock.hits.length, 2, 'refresh=1 bypasses the cache');
  } finally {
    await stopServer(ctx);
    await mock.close();
  }
});

test('/api/geo: upstream down but a snapshot exists → source=snapshot, solvable', async () => {
  // A dead port guarantees the network path fails fast; the committed fixtures
  // under fixtures/geo cover the byward-parliament preset.
  const ctx = await startServer({
    geoUpstream: 'http://127.0.0.1:1',
    geoCacheDir: tmpdir(),
    geoSnapshotDir: path.join(ROOT, 'fixtures', 'geo'),
  });
  try {
    const pair = PLACE_PAIRS['byward-parliament'];
    const r = await fetch(`${ctx.base}/api/geo?bbox=${pair.bbox.join(',')}&rows=16&cols=16`);
    assert.equal(r.status, 200);
    const geo = await r.json();
    assert.equal(geo.source, 'snapshot');
    assert.ok(geo.optimum > 0, 'a snapshot board is solvable');
    assert.equal(geo.places.from.name, 'ByWard Market, Ottawa');
    assert.ok(geo.notes.some((n) => /snapshot|offline/.test(n)), 'notes label the snapshot');
    assert.equal(shortestCost(boardFromGeo(geo)), geo.optimum);
  } finally {
    await stopServer(ctx);
  }
});

test('/api/geo: upstream down, no snapshot → typed upstream_error', async () => {
  const ctx = await startServer({ geoUpstream: 'http://127.0.0.1:1', geoCacheDir: tmpdir(), geoSnapshotDir: tmpdir() });
  try {
    const r = await fetch(`${ctx.base}/api/geo?bbox=${SYNTH_BBOX.join(',')}&rows=4&cols=4`);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error.code, 'upstream_error');
    assert.ok(body.error.message);
  } finally {
    await stopServer(ctx);
  }
});

test('/api/geo: an unsolvable grid is retried on an expanded bbox once, then an honest error', async () => {
  // Two disconnected motorways: the endpoints snap onto different components.
  const disconnected = [
    { class: 'motorway', points: [[3.5, 0], [3.5, 4]] },
    { class: 'motorway', points: [[0.5, 0], [0.5, 4]] },
  ];
  const mock = await makeMock(overpassBody(disconnected));
  const ctx = await startServer({ geoUpstream: mock.base, geoCacheDir: tmpdir(), geoSnapshotDir: tmpdir() });
  try {
    const q = `bbox=${SYNTH_BBOX.join(',')}&rows=8&cols=8&from=3.8,0.5&to=0.2,3.5`;
    const r = await fetch(`${ctx.base}/api/geo?${q}`);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.error.code, 'unsolvable');
    assert.match(body.error.message, /no route/);
    assert.equal(mock.hits.length, 2, 'one expansion retry, then give up');
  } finally {
    await stopServer(ctx);
    await mock.close();
  }
});

test('/api/geo: validation rejects bad bbox / rows / columns without network', async () => {
  const ctx = await startServer({ geoUpstream: 'http://127.0.0.1:1', geoCacheDir: tmpdir(), geoSnapshotDir: tmpdir() });
  try {
    for (const q of ['bbox=oops', 'bbox=9,0,1,4', 'bbox=0,0,4,4&rows=1000', 'bbox=0,0,4,4&rows=3&cols=3']) {
      const r = await fetch(`${ctx.base}/api/geo?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal((await r.json()).error.code, 'bad_request');
    }
  } finally {
    await stopServer(ctx);
  }
});