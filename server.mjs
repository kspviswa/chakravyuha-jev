// server.mjs — static file server + a thin proxy for the TypeSafe API.
//
// Why a proxy at all: the TypeSafe API key must never reach the browser.
// The browser POSTs the board to /api/jev; this process attaches the key.
//
// There are exactly three answer modes, surfaced to the UI via `mode`:
//
//   STUB    no API key, no replay -> local BFS fakes a Jev-shaped answer.
//           Not Jev. Labelled loudly. Confined to the stubAnswer() function.
//   REPLAY  TYPESAFE_REPLAY set -> answer comes verbatim from a recorded
//           fixture (deterministic, no key, no network).
//   LIVE    TYPESAFE_API_KEY set, no replay -> real Jev, one request.
//
// The API key is never logged and never returned to the client.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC = path.join(__dirname, 'public');
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');
export const RECORDED_DIR = path.join(FIXTURES_DIR, 'recorded');

export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_MTOK = 0.042; // USD per 1M input tokens
const PING = 0; // stub recordings pretend the round trip was instant

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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

/** Replay > live > stub. */
export function resolveMode(config) {
  if (config.replay) return 'replay';
  if (config.apiKey) return 'live';
  return 'stub';
}

function isAutoReplay(value) {
  return AUTO_REPLAY.has(String(value).toLowerCase());
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

// ---- stub: a local BFS that fakes a Jev-shaped answer --------------------
// This is the ONE pathfinding implementation outside public/referee.js.
// It is allowed (documented exception) but: it is confined to this function,
// and the live branch below never calls it, so it never runs with a key set.
export function stubAnswer(payload) {
  const grid = payload.state.grid;
  const R = grid.length, C = grid[0].length;
  const find = (ch) => {
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (grid[r][c] === ch) return { r, c };
    return null;
  };
  const src = find('S'), dst = find('D');
  const open = (r, c) => r >= 0 && r < R && c >= 0 && c < C && grid[r][c] !== '#';
  const prev = new Map(), seen = new Set([`${src.r},${src.c}`]);
  const q = [src];
  const D = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
  while (q.length) {
    const cur = q.shift();
    if (cur.r === dst.r && cur.c === dst.c) break;
    for (const [name, [dr, dc]] of Object.entries(D)) {
      const nr = cur.r + dr, nc = cur.c + dc, k = `${nr},${nc}`;
      if (open(nr, nc) && !seen.has(k)) { seen.add(k); prev.set(k, { from: cur, dir: name }); q.push({ r: nr, c: nc }); }
    }
  }
  const moves = [];
  let cur = dst, reached = seen.has(`${dst.r},${dst.c}`);
  while (reached && !(cur.r === src.r && cur.c === src.c)) {
    const p = prev.get(`${cur.r},${cur.c}`);
    if (!p) { reached = false; break; }
    moves.unshift(p.dir);
    cur = p.from;
  }
  const answers = {};
  for (const id of Object.keys(payload.questions)) {
    if (id === 'reachable') answers[id] = { type: 'noul', noul: reached ? 0.99 : 0.01 };
    else if (id === 'path_length') {
      const n = moves.length;
      const bucket = n <= 5 ? '1-5' : n <= 10 ? '6-10' : n <= 15 ? '11-15' : n <= 20 ? '16-20' : n <= 30 ? '21-30' : n <= 50 ? '31-50' : '51+';
      answers[id] = { type: 'choice', choice: bucket, probabilities: { [bucket]: 0.9 }, confidence: 0.9 };
    } else if (id === 'maze_difficulty') {
      answers[id] = { type: 'score', score: 2.0, legend: { '0': 'trivial', '1': 'easy', '2': 'moderate', '3': 'hard', '4': 'brutal' }, probabilities: { '2': 0.7 }, confidence: 0.7 };
    } else if (id.startsWith('move_')) {
      const k = Number(id.slice(5));
      const m = moves[k - 1] || 'stop';
      answers[id] = { type: 'choice', choice: m, probabilities: { [m]: 0.93 }, confidence: 0.93 };
    } else if (id.startsWith('cell_')) {
      answers[id] = { type: 'noul', noul: 0.5 };
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
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'expected { state: { grid: [strings] }, questions: {...} }');
  }

  const questionCount = Object.keys(payload.questions).length;
  if (questionCount > config.maxQuestions) {
    return err(res, 400, ERROR_CODES.TOO_MANY_QUESTIONS,
      `${questionCount} questions exceeds the per-request cap of ${config.maxQuestions}`);
  }

  const hash = requestHash(payload);
  const t0 = Date.now();
  const mode = resolveMode(config);
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
    try {
      const r = await fetch(config.upstream, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
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
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  const rel = path.relative(PUBLIC, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return err(res, 403, ERROR_CODES.FORBIDDEN, 'forbidden');
  }
  fs.readFile(file, (readErr, data) => {
    if (readErr) return err(res, 404, ERROR_CODES.NOT_FOUND, `not found: ${url.pathname}`);
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// ---- app & entry point ---------------------------------------------------
export function createServer(config = readConfig()) {
  const mode = resolveMode(config);
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
        stub: mode === 'stub',
        mode,
        model: mode === 'stub' ? 'STUB-LOCAL-SOLVER' : config.model,
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
  const mode = resolveMode(config);
  server.listen(config.port, () => {
    console.log(`jev-pathpuzzle on http://localhost:${config.port}`);
    if (mode === 'replay') {
      console.log(`  mode: REPLAY${isAutoReplay(config.replay) ? ' (hash lookup)' : ` (named fixture "${config.replay}")`} — deterministic, no network`);
    } else if (mode === 'live') {
      console.log(`  mode: LIVE (${config.model})`);
    } else {
      console.log('  mode: STUB — set TYPESAFE_API_KEY for live Jev');
    }
  });
}