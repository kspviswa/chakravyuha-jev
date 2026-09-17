// test/helpers.mjs — shared boot helpers for the http-level tests.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

/**
 * Boot a shim on an ephemeral port. Each server gets its OWN recordings
 * directory by default: two suites that share `fixtures/recorded` race on the
 * same `<hash>.live.json` filename and clobber each other's fixture. Pass
 * `recordedDir` (or `useRealFixtures: true`) to opt back into the real one.
 */
export function startServer(overrides = {}) {
  const { useRealFixtures, ...rest } = overrides;
  const scratch = useRealFixtures
    ? undefined
    : rest.recordedDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fixtures-'));
  // Each server also gets its OWN runs file: the run-history suite (and any
  // accidental /api/runs traffic from other tests) must never touch the real
  // repo-root runs.jsonl — the recorded-fixtures race, redux.
  const runsFile = rest.runsFile
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jev-runs-')) + '/runs.jsonl';
  const server = createServer({ rateLimit: 100_000, recordedDir: scratch, runsFile, ...rest });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}`, recordedDir: scratch, runsFile });
    });
  });
}

export async function stopServer(ctx) {
  ctx.server.closeAllConnections?.();
  await new Promise((resolve) => ctx.server.close(resolve));
}

export async function postJev(base, payload, opts = {}) {
  const r = await fetch(`${base}/api/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body };
}

// A weighted navigation board: S top-left, D top-right, a cheap corridor on
// the bottom row vs a congested direct row. stubAnswer must route around.
export const NAV_PAYLOAD = {
  state: {
    task: 'navigation_weighted',
    grid: ['S.D', '...'],
    weights: [[0, 9, 0], [1, 1, 1]],
    legend: { S: 'pickup', D: 'drop-off', '.': 'road', weights: '1-5 congestion' },
    source: { row: 0, col: 0 },
    destination: { row: 0, col: 2 },
    rules: 'Entering a cell costs its weight; start free.',
    objective: 'least-cost route',
  },
  questions: {
    reachable: { type: 'noul' },
    cost_band: { type: 'choice' },
    eta_band: { type: 'choice' },
    route_difficulty: { type: 'score' },
    move_1: { type: 'choice' },
    move_2: { type: 'choice' },
    move_3: { type: 'choice' },
    move_4: { type: 'choice' },
  },
};

// A small fixed board + question set shared by several tests.
export const FIXED_PAYLOAD = {
  state: {
    task: 'grid_pathfinding',
    grid: ['S....', '.....', '....D'],
    legend: { S: 'source', D: 'destination' },
    source: { row: 0, col: 0 },
    destination: { row: 2, col: 4 },
    rules: '4-directional moves',
    objective: 'shortest path',
  },
  questions: {
    reachable: { type: 'noul', instructions: 'reachable?' },
    path_length: { type: 'choice', criteria: { '1-5': null, '6-10': null } },
    maze_difficulty: { type: 'score', criteria: ['trivial', 'hard'] },
    move_1: { type: 'choice', criteria: { up: null, down: null, left: null, right: null } },
    move_2: { type: 'choice', criteria: { up: null, down: null, left: null, right: null } },
  },
};

export const SMALL_PAYLOAD = {
  state: {
    task: 'grid_pathfinding',
    grid: ['SD'],
    legend: {},
    source: { row: 0, col: 0 },
    destination: { row: 0, col: 1 },
    rules: '4-directional moves',
    objective: 'shortest path',
  },
  questions: {
    reachable: { type: 'noul' },
    move_1: { type: 'choice' },
    path_length: { type: 'choice' },
    maze_difficulty: { type: 'score' },
  },
};

/** Start a throwaway http server that answers a canned body with a status. */
export function startMockUpstream({ status = 200, body }) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      server.lastRequest = { method: req.method, url: req.url, auth: req.headers.authorization || null, raw };
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
        lastRequest: () => server.lastRequest,
      });
    });
  });
}