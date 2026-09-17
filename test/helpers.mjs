// test/helpers.mjs — shared boot helpers for the http-level tests.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

/**
 * Boot a shim on an ephemeral port with its OWN runs file, so no suite can
 * touch the real repo-root runs.jsonl.
 */
export function startServer(overrides = {}) {
  const runsFile = overrides.runsFile
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jev-runs-')) + '/runs.jsonl';
  const server = createServer({ rateLimit: 100_000, ...overrides, runsFile });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}`, runsFile });
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

// A valid polar chakravyuha state the shim will accept, with the full
// first-step fan-out the policy loop actually sends.
export const CH_PAYLOAD = {
  state: {
    task: 'chakravyuha_policy',
    maze: { rings: 3, sectors: 6, centre_gate_sector: 2 },
    open_radial: [
      [true, true, true, true, true, true],
      [true, true, true, true, true, true],
    ],
    open_circ: [
      [true, true, true, true, true, true],
      [true, true, true, true, true, true],
      [true, true, true, true, true, true],
    ],
    warriors: [{ ring: 2, sector: 5 }],
    abhimanyu: { ring: 3, sector: 0 },
    goal: 'the centre (ring 0)',
    visited: [{ ring: 3, sector: 0 }],
    step: 1,
    maxSteps: 36,
    rules: 'polar moves: inward, outward, clockwise, counterclockwise',
    objective: 'pick the best next move toward the centre',
  },
  questions: {
    reachable: { type: 'noul', instructions: 'reachable?', criteria: { true: 'yes', false: 'no' } },
    route_length: { type: 'choice', instructions: 'how long?', criteria: { '1-5': null, '6-10': null } },
    maze_difficulty: { type: 'score', instructions: 'how hard?', criteria: ['easy', 'hard'] },
    warriors_blocking: { type: 'noul', instructions: 'blocked?', criteria: { true: 'yes', false: 'no' } },
    move_inward: { type: 'noul', instructions: 'good?' },
    move_outward: { type: 'noul', instructions: 'good?' },
    move_clockwise: { type: 'noul', instructions: 'good?' },
    move_counterclockwise: { type: 'noul', instructions: 'good?' },
  },
};

// The same shape with exactly 4 questions — used by the debug-log test, which
// asserts the logged `questions` count.
export const SMALL_PAYLOAD = {
  state: CH_PAYLOAD.state,
  questions: {
    reachable: { type: 'noul' },
    move_inward: { type: 'noul' },
    route_length: { type: 'choice' },
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