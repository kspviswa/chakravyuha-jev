// server.mjs — the same-origin shim: static files + `POST /api/jev`.
//
// Why the shim exists at all (a hard finding, documented in the README):
// the TypeSafe API sends NO `Access-Control-Allow-Origin` for any origin and
// rejects the preflight with `400 Disallowed CORS origin`, so a browser
// page can never call `https://api.typesafe.ai/v1/systemone` directly. This
// process is the necessary same-origin pass-through and nothing more.
//
// BYOK, server-side: the key comes from the BROWSER per request in the
// `x-jev-key` header (proxy transport), falling back to an `Authorization:
// Bearer` header, and then to an optional env `TYPESAFE_API_KEY`. The shim
// stores nothing. The key is never logged and never echoed to the client.
//
// Answer modes, surfaced to the UI via the response `mode`:
//   STUB    no key anywhere -> a local offline solver fakes a Jev-shaped
//           answer. Not Jev. Labelled loudly. Confined to stubAnswer().
//   REPLAY  TYPESAFE_REPLAY set -> a recorded fixture, verbatim.
//   LIVE    any key present -> one forwarded request to TypeSafe.
//
// The stub solver (BFS for unweighted, Dijkstra for weighted congestion
// maps) is the ONLY pathfinding outside lib/referee.js, and the live branch
// below never calls it, so it never runs when a key is present.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_ROOT = __dirname;
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');
export const RECORDED_DIR = path.join(FIXTURES_DIR, 'recorded');

export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_MTOK = 0.042; // USD per 1M input tokens
const PING = 0; // stub recordings pretend the round trip was instant

// Only the client tree is served. server.mjs, package.json, test/, fixtures/,
// .git/ … are deliberately NOT static assets.
const STATIC_FILES = new Set(['index.html', 'app.js', 'style.css']);
const STATIC_DIRS = new Set(['lib', 'skins']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export const ERROR_CODES = {
  RATE_LIMITED: 'rate_limited',
  BAD_REQUEST: 'bad_request',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  TOO_MANY_QUESTIONS: 'too_many_questions',
  NO_FIXTURE: 'no_fixture',
  UPSTREAM_ERROR: 'upstream_error',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  INTERNAL: 'internal_error',
};

// ---- config --------------------------------------------------------------
const DEFAULTS = {
  port: 8787,
  apiKey: '',
  model: 'jev-latest',
  replay: '',
  rateLimit: 40,
  maxBodyBytes: 2_000_000,
  maxQuestions: 512,
};

export function readConfig(env = process.env) {
  return {
    port: Number(env.PORT || DEFAULTS.port),
    apiKey: env.TYPESAFE_API_KEY || '',
    model: env.TYPESAFE_MODEL || DEFAULTS.model,
    replay: env.TYPESAFE_REPLAY || '',
    rateLimit: Number(env.RATE_LIMIT || DEFAULTS.rateLimit),
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    maxQuestions: DEFAULTS.maxQuestions,
    // test-only override so the suite can point at a mock upstream
    upstream: env.TYPESAFE_UPSTREAM || UPSTREAM,
  };
}

const AUTO_REPLAY = new Set(['1', 'true', 'yes', 'on']);

/** Replay > live > stub. A request-scoped key swings the live decision. */
export function resolveMode(config, reqKey = '') {
  if (config.replay) return 'replay';
  if (reqKey || config.apiKey) return 'live';
  return 'stub';
}

function isAutoReplay(value) {
  return AUTO_REPLAY.has(String(value).toLowerCase());
}

function keyFromHeaders(headers) {
  const x = headers['x-jev-key'];
  if (x) return String(x).trim();
  const auth = headers.authorization;
  if (auth) return String(auth).replace(/^Bearer\s+/i, '').trim();
  return '';
}

/** Stable id for a request: sha256 of the (state, questions) payload. */
export function requestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---- small helpers -------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body
    : typeof body === 'string' ? Buffer.from(body)
    : Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length });
  res.end(buf);
}

function err(res, status, code, message) {
  return send(res, status, { error: { code, message } });
}

class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`request body exceeds the ${maxBytes}-byte cap`);
    this.name = 'BodyTooLargeError';
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes && !over) {
        over = true;
        req.pause();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- per-IP rate limit (public demo hardening) ---------------------------
function makeRateLimiter(maxPerMinute) {
  const hits = new Map();
  const windowMs = 60_000;
  return (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > maxPerMinute;
  };
}

/** Add the meters promised by the API contract to any response object. */
export function decorateResponse(out, payload, ms) {
  out._ms = ms;
  const it = out?.usage?.input_tokens ?? 0;
  out._cost_usd = (it / 1e6) * PRICE_PER_MTOK;
  out._questions = Object.keys(payload.questions || {}).length;
  return out;
}

// ---- the stub: a local offline solver that fakes a Jev-shaped answer ----
// This is the ONE pathfinding implementation outside lib/referee.js. It is
// allowed (documented exception) but: it is confined to this function, and
// the live branch below never calls it, so it never runs with a key present.
// BFS answers the unweighted grid questions; Dijkstra answers the weighted
// "least-congestion" navigation questions. '#' and 'P' (park/buildings) block.

const BLOCKED_CHARS = { '#': true, P: true };
const DIRS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

function solveGrid(state) {
  const grid = state.grid;
  const weights = Array.isArray(state.weights) ? state.weights : null;
  const R = grid.length, C = grid[0].length;
  const find = (ch) => {
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (grid[r][c] === ch) return { r, c };
    return null;
  };
  const src = find('S'), dst = find('D');
  if (!src || !dst) return { reached: false, moves: [], cost: 0 };
  const open = (r, c) => r >= 0 && r < R && c >= 0 && c < C && !BLOCKED_CHARS[grid[r][c]];
  if (!open(src.r, src.c) || !open(dst.r, dst.c)) return { reached: false, moves: [], cost: 0 };
  const stepCost = (r, c) => (weights ? weights[r][c] : 1);

  if (!weights) {
    // ---- BFS: fewest moves
    const prev = new Map();
    const seen = new Set([`${src.r},${src.c}`]);
    const q = [src];
    let reached = false;
    while (q.length) {
      const cur = q.shift();
      if (cur.r === dst.r && cur.c === dst.c) { reached = true; break; }
      for (const [name, [dr, dc]] of Object.entries(DIRS)) {
        const nr = cur.r + dr, nc = cur.c + dc, k = `${nr},${nc}`;
        if (open(nr, nc) && !seen.has(k)) { seen.add(k); prev.set(k, { from: cur, dir: name }); q.push({ r: nr, c: nc }); }
      }
    }
    const moves = [];
    let cur = dst;
    while (reached && !(cur.r === src.r && cur.c === src.c)) {
      const p = prev.get(`${cur.r},${cur.c}`);
      if (!p) { reached = false; break; }
      moves.unshift(p.dir);
      cur = p.from;
    }
    return { reached, moves, cost: moves.length };
  }

  // ---- Dijkstra: least congestion cost (enter a cell, pay its weight)
  const INF = Infinity;
  const dist = Array.from({ length: R }, () => new Array(C).fill(INF));
  const prev = Array.from({ length: R }, () => new Array(C).fill(null)); // { r, c, dir }
  const done = Array.from({ length: R }, () => new Array(C).fill(false));
  dist[src.r][src.c] = 0;
  let reached = false;
  for (;;) {
    let best = null;
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        if (!done[r][c] && dist[r][c] < INF && (best === null || dist[r][c] < dist[best[0]][best[1]])) {
          best = [r, c];
        }
    if (best === null) break;
    const [r, c] = best;
    if (r === dst.r && c === dst.c) { reached = true; break; }
    done[r][c] = true;
    for (const [name, [dr, dc]] of Object.entries(DIRS)) {
      const nr = r + dr, nc = c + dc;
      if (!open(nr, nc)) continue;
      const alt = dist[r][c] + stepCost(nr, nc);
      if (alt < dist[nr][nc]) {
        dist[nr][nc] = alt;
        prev[nr][nc] = { r, c, dir: name };
      }
    }
  }
  const moves = [];
  let cur = dst;
  while (reached && !(cur.r === src.r && cur.c === src.c)) {
    const p = prev[cur.r][cur.c];
    if (!p) { reached = false; break; }
    moves.unshift(p.dir);
    cur = p;
  }
  return { reached, moves, cost: reached ? dist[dst.r][dst.c] : 0 };
}

const LENGTH_BUCKETS = [5, 10, 15, 20, 30, 50];
const COST_BUCKETS = [20, 40, 60, 80, 100];

function bucket(list, n) {
  for (let i = 0; i < list.length; i++) if (n <= list[i]) return i === 0 ? `1-${list[i]}` : `${list[i - 1] + 1}-${list[i]}`;
  return `${list[list.length - 1] + 1}+`;
}

function etaOf(cost) {
  if (cost < 10) return 'under 10 min';
  if (cost <= 20) return '10–20 min';
  if (cost <= 30) return '20–30 min';
  if (cost <= 45) return '30–45 min';
  return '45+ min';
}

export function stubAnswer(payload) {
  const { state } = payload;
  const { reached, moves, cost } = solveGrid(state);
  const weighted = Array.isArray(state.weights);

  const answers = {};
  for (const id of Object.keys(payload.questions)) {
    if (id === 'reachable') {
      answers[id] = { type: 'noul', noul: reached ? 0.99 : 0.01 };
    } else if (id === 'path_length') {
      const n = moves.length;
      answers[id] = { type: 'choice', choice: bucket(LENGTH_BUCKETS, n), probabilities: { [bucket(LENGTH_BUCKETS, n)]: 0.9 }, confidence: 0.9 };
    } else if (id === 'cost_band') {
      const b = bucket(COST_BUCKETS, cost);
      answers[id] = { type: 'choice', choice: b, probabilities: { [b]: 0.9 }, confidence: 0.9 };
    } else if (id === 'eta_band') {
      const e = etaOf(cost);
      answers[id] = { type: 'choice', choice: e, probabilities: { [e]: 0.9 }, confidence: 0.9 };
    } else if (id.endsWith('_difficulty')) {
      answers[id] = { type: 'score', score: weighted ? 3.0 : 2.0, legend: { '0': 'trivial', '1': 'easy', '2': 'moderate', '3': 'hard', '4': 'brutal' }, probabilities: { [weighted ? '3' : '2']: 0.7 }, confidence: 0.7 };
    } else if (id.startsWith('move_')) {
      const k = Number(id.slice(5));
      const m = moves[k - 1] || 'stop';
      answers[id] = { type: 'choice', choice: m, probabilities: { [m]: 0.93 }, confidence: 0.93 };
    } else if (id.startsWith('cell_')) {
      answers[id] = { type: 'noul', noul: 0.5 };
    } else {
      answers[id] = { type: 'choice', choice: 'yes', probabilities: { yes: 0.9 }, confidence: 0.9 };
    }
  }
  const input_tokens = Math.round((JSON.stringify(payload).length) / 4);
  return { model: 'STUB-LOCAL-SOLVER', answers, usage: { input_tokens, output_tokens: 0 }, _stub: true };
}

// ---- fixtures / replay ---------------------------------------------------
async function fixtureManifest() {
  try {
    const raw = await fs.promises.readFile(path.join(FIXTURES_DIR, 'index.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadFixtureByHash(hash) {
  const candidates = [
    path.join(RECORDED_DIR, `${hash}.live.json`),
    path.join(FIXTURES_DIR, `${hash}.json`),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      return { raw, file };
    } catch { /* try next */ }
  }
  return null;
}

async function findFixture(config, hash) {
  if (!isAutoReplay(config.replay)) {
    const index = await fixtureManifest();
    const entry = index[config.replay];
    if (entry?.hash) return loadFixtureByHash(entry.hash);
    return null;
  }
  return loadFixtureByHash(hash);
}

async function recordLive(hash, payload, out) {
  try {
    await fs.promises.mkdir(RECORDED_DIR, { recursive: true });
    const envelope = {
      kind: 'live',
      mode: 'live',
      model: out?.model ?? null,
      recordedAt: new Date().toISOString(),
      request: payload,
      response: out,
    };
    await fs.promises.writeFile(
      path.join(RECORDED_DIR, `${hash}.live.json`),
      JSON.stringify(envelope, null, 2),
    );
  } catch (e) {
    // Recording must never take the request down with it.
    console.error(`recordLive: could not write fixture for ${hash}: ${e.message}`);
  }
}

// ---- request handling ----------------------------------------------------
function isValidPayload(payload) {
  return payload && typeof payload === 'object'
    && payload.state && typeof payload.state === 'object'
    && Array.isArray(payload.state.grid) && payload.state.grid.length > 0
    && typeof payload.state.grid[0] === 'string'
    && payload.questions && typeof payload.questions === 'object'
    && !Array.isArray(payload.questions);
}

async function handleApiJev(req, res, config, rateLimited) {
  const ip = req.socket.remoteAddress || 'x';
  if (rateLimited(ip)) {
    return err(res, 429, ERROR_CODES.RATE_LIMITED, 'too many requests from this address — wait a minute and retry');
  }

  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return err(res, 413, ERROR_CODES.PAYLOAD_TOO_LARGE, `request body exceeds the ${config.maxBodyBytes}-byte cap`);
    }
    return err(res, 400, ERROR_CODES.BAD_REQUEST, `could not read request body: ${e.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'request body is not valid JSON');
  }
  if (!isValidPayload(payload)) {
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'expected { state: { grid: [strings], weights? }, questions: {...} }');
  }

  const questionCount = Object.keys(payload.questions).length;
  if (questionCount > config.maxQuestions) {
    return err(res, 400, ERROR_CODES.TOO_MANY_QUESTIONS,
      `${questionCount} questions exceeds the per-request cap of ${config.maxQuestions}`);
  }

  const reqKey = keyFromHeaders(req.headers);
  const hash = requestHash(payload);
  const t0 = Date.now();
  const mode = resolveMode(config, reqKey);
  let out;

  if (mode === 'replay') {
    const hit = await findFixture(config, hash);
    if (!hit) {
      return err(res, 404, ERROR_CODES.NO_FIXTURE,
        'no recorded fixture matches this request hash — run once in LIVE or STUB mode to record one');
    }
    const envelope = JSON.parse(hit.raw);
    out = { ...envelope.response, mode: 'replay' };
  } else if (mode === 'stub') {
    out = stubAnswer(payload);
    out.mode = 'stub';
    decorateResponse(out, payload, Date.now() - t0);
  } else {
    const key = reqKey || config.apiKey;
    try {
      const r = await fetch(config.upstream, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, model: payload.model || config.model }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        await r.text(); // drain; the raw upstream body is never echoed to the client
        return err(res, 502, ERROR_CODES.UPSTREAM_ERROR, `upstream TypeSafe API returned HTTP ${r.status}`);
      }
      out = await r.json();
      out.mode = 'live';
      decorateResponse(out, payload, Date.now() - t0);
      await recordLive(hash, payload, out);
    } catch (e) {
      return err(res, 502, ERROR_CODES.UPSTREAM_ERROR, `upstream TypeSafe API unreachable: ${e.message}`);
    }
  }

  return send(res, 200, out);
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return err(res, 405, ERROR_CODES.FORBIDDEN, 'method not allowed on static assets');
  }
  let p = url.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'badly encoded path');
  }
  if (p === '/') p = '/index.html';
  const parts = p.split('/').filter(Boolean);
  let file;
  if (parts.length === 1) {
    if (!STATIC_FILES.has(parts[0])) return err(res, 404, ERROR_CODES.NOT_FOUND, `not found: ${url.pathname}`);
    file = path.join(STATIC_ROOT, parts[0]);
  } else {
    if (!STATIC_DIRS.has(parts[0])) return err(res, 404, ERROR_CODES.NOT_FOUND, `not found: ${url.pathname}`);
    if (parts.some((part) => part === '..' || part === '.')) return err(res, 403, ERROR_CODES.FORBIDDEN, 'forbidden');
    file = path.join(STATIC_ROOT, ...parts);
  }
  const rel = path.relative(STATIC_ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return err(res, 403, ERROR_CODES.FORBIDDEN, 'forbidden');
  }
  fs.readFile(file, (readErr, data) => {
    if (readErr) return err(res, 404, ERROR_CODES.NOT_FOUND, `not found: ${url.pathname}`);
    if (req.method === 'HEAD') return send(res, 200, '', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// ---- app & entry point ---------------------------------------------------
export function createServer(config = readConfig()) {
  const rateLimited = makeRateLimiter(config.rateLimit);
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return err(res, 400, ERROR_CODES.BAD_REQUEST, 'malformed request URL');
    }

    if (url.pathname === '/api/jev' && req.method === 'POST') {
      return handleApiJev(req, res, config, rateLimited).catch(() =>
        err(res, 500, ERROR_CODES.INTERNAL, 'internal error'));
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        mode: 'proxy',
        hasEnvKey: !!config.apiKey,
      });
    }
    if (url.pathname.startsWith('/api/')) {
      return err(res, 404, ERROR_CODES.NOT_FOUND, `no such endpoint: ${url.pathname}`);
    }
    return handleStatic(req, res, url);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = readConfig();
  const server = createServer(config);
  server.listen(config.port, () => {
    console.log(`jev-pathpuzzle on http://localhost:${config.port}`);
    if (config.replay) {
      console.log(`  mode: REPLAY${isAutoReplay(config.replay) ? ' (hash lookup)' : ` (named fixture "${config.replay}")`} — deterministic, no network`);
    } else if (config.apiKey) {
      console.log('  mode: LIVE-capable (env key present; the browser may also send its own per-request key)');
    } else {
      console.log('  mode: STUB by default — paste a key in the page (BYOK) to go LIVE');
    }
    console.log('  the shim exists because api.typesafe.ai sends no Access-Control-Allow-Origin (CORS finding)');
  });
}