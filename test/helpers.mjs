// test/helpers.mjs — shared boot helpers for the http-level tests.
import http from 'node:http';
import { createServer } from '../server.mjs';

export function startServer(overrides = {}) {
  const server = createServer({ rateLimit: 100_000, ...overrides });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

export async function stopServer(ctx) {
  ctx.server.closeAllConnections?.();
  await new Promise((resolve) => ctx.server.close(resolve));
}

export async function postJev(base, payload) {
  const r = await fetch(`${base}/api/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body };
}

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