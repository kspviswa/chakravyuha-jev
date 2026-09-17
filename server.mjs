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
import {
  PLACE_PAIRS, ATTRIBUTION, parseBbox, validateBbox, expandBbox, bboxKey,
  latLonToCell, cellCenter, parseOverpass, rasterize, snapCell, applyCongestion,
  boardFromGeo,
} from './lib/geo.js';
import { shortestCost } from './lib/referee.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_ROOT = __dirname;
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');
export const RECORDED_DIR = path.join(FIXTURES_DIR, 'recorded');

export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_MTOK = 0.042; // USD per 1M input tokens
const PING = 0; // stub recordings pretend the round trip was instant

// Only the client tree is served. server.mjs, package.json, test/, fixtures/,
// .git/ … are deliberately NOT static assets.
const STATIC_FILES = new Set(['index.html', 'app.js', 'history.html', 'history.js', 'style.css']);
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
  UNSOLVABLE: 'unsolvable',
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
  // Policy mode issues ONE call per step (plus a re-ask per reversal), so a
  // single Hard run can legitimately make 40–90 calls in a minute. The limit
  // protects the server from abuse, not the user from themselves — keep it
  // generous. Override with RATE_LIMIT.
  rateLimit: 1200,
  maxBodyBytes: 2_000_000,
  maxQuestions: 512,
  recordedDir: RECORDED_DIR,
  // Server-side run history (append-only JSONL). Overridable for tests so they
  // never touch the real runs.jsonl — the same isolation lesson as the
  // recorded-fixtures race.
  runsFile: path.join(__dirname, 'runs.jsonl'),
  // /api/geo — the real-map feed. Overpass is reached keylessly; responses are
  // cached on disk and, when the network is down, served from committed
  // snapshots under fixtures/geo/.
  geoUpstream: 'https://overpass-api.de/api/interpreter',
  geoUserAgent: 'jev-pathpuzzle/0.1 (real-map navigation demo; no API key; https://openstreetmap.org)',
  geoTimeoutMs: 20_000,
  geoCacheDir: path.join(__dirname, 'cache', 'geo'),
  geoSnapshotDir: path.join(__dirname, 'fixtures', 'geo'),
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
    // Where live responses are recorded. Overridable so tests can keep their
    // recordings to themselves — two suites sharing this directory race on the
    // same filename and corrupt each other's fixture.
    recordedDir: env.TYPESAFE_RECORDED_DIR || DEFAULTS.recordedDir,
    // JEV_DEBUG=1/true/yes/on → one redacted JSON line per /api/jev to stderr
    debug: env.JEV_DEBUG || '',
    // test-only override so the suite can point at a mock upstream
    upstream: env.TYPESAFE_UPSTREAM || UPSTREAM,
    // test-only override so the run-history suite writes to a scratch file
    runsFile: env.RUNS_FILE || DEFAULTS.runsFile,
    geoUpstream: env.GEO_UPSTREAM || DEFAULTS.geoUpstream,
    geoUserAgent: env.GEO_UA || DEFAULTS.geoUserAgent,
    geoTimeoutMs: Number(env.GEO_TIMEOUT_MS || DEFAULTS.geoTimeoutMs),
    geoCacheDir: env.GEO_CACHE_DIR || DEFAULTS.geoCacheDir,
    geoSnapshotDir: env.GEO_SNAPSHOT_DIR || DEFAULTS.geoSnapshotDir,
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

function err(res, status, code, message, extra = {}) {
  return send(res, status, { error: { code, message, ...extra } });
}

// ---- debug logging (JEV_DEBUG=1 → stderr, key-redacting) -------------------
const DEBUG_ON = new Set(['1', 'true', 'yes', 'on']);

export function debugEnabled(config) {
  return DEBUG_ON.has(String(config?.debug ?? '').toLowerCase());
}

/** First 4 chars of the key + sha256[0:8]. Enables "which key was used?" without the key. */
export function fingerprintKey(key) {
  if (!key) return null;
  const s = String(key);
  const tail = crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  return `${s.slice(0, 4)}…${tail}`;
}

/** Mask anything that looks like a credential before it reaches a log. */
export function redact(value) {
  if (value === undefined || value === null) return value;
  return String(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-<redacted>')
    .replace(/\b[A-Za-z0-9._~+/=-]{32,}\b/g, '<redacted-token>');
}

function truncate(value, max = 1024) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…[${s.length - max} more chars]` : s;
}

/** One structured, redacted JSON line per finished /api/jev request. */
function evlog(config, base, extra = {}) {
  if (!debugEnabled(config)) return;
  const line = { t: new Date().toISOString(), kind: 'jev', ...base, ...extra };
  if (line.upstream !== undefined) line.upstream = redact(line.upstream);
  console.error('[jev-debug] ' + JSON.stringify(line));
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

/**
 * Solve from `state.position` (policy mode) or, when no position is given,
 * from S (plan mode). BFS for unweighted grids, Dijkstra for weighted maps.
 */
function solveGrid(state, from = null) {
  const grid = state.grid;
  const weights = Array.isArray(state.weights) ? state.weights : null;
  const R = grid.length, C = grid[0].length;
  // Cells travel in two shapes on purpose: the board/solver as `{r,c}`, the
  // policy API (position, destination, neighbours) as `{row,col}`. Normalize
  // once on entry so the BFS never sees undefined.
  const cell = (p) => (p ? { r: p.row ?? p.r, c: p.col ?? p.c } : null);
  const find = (ch) => {
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (grid[r][c] === ch) return { r, c };
    return null;
  };
  const src = cell(from || state.position || find('S'));
  const dst = cell(state.destination) ||
    find('D') ||
    (typeof state.destination?.row === 'number' ? { r: state.destination.row, c: state.destination.col } : null);
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

/** Cells of the optimal S→D route (from `moves`), or null when unreachable. */
function routeCells(state, reached, moves, src) {
  if (!reached) return null;
  // `src` arrives in either shape: the board/solver uses `{r, c}`, while the
  // policy API (position, neighbours) uses `{row, col}`. Normalize before use,
  // or every cell below becomes NaN and the route silently matches nothing.
  const origin = { row: src?.row ?? src?.r, col: src?.col ?? src?.c };
  if (!Number.isFinite(origin.row) || !Number.isFinite(origin.col)) return null;
  const cells = [{ row: origin.row, col: origin.col }];
  let r = origin.row, c = origin.col;
  for (const m of moves) {
    const d = DIRS[m];
    if (!d) break;
    r += d[0]; c += d[1];
    cells.push({ row: r, col: c });
  }
  return cells;
}

/**
 * Policy (per-step) answers: a single `move_<dir>` Noul. The stub is the one
 * place allowed to do pathfinding, so it answers as a near-perfect driver:
 * walking the known optimal route scores highest; anything else is scored by
 * remaining cost; already-visited and illegal targets are penalised hard.
 */
export function policyMoveAnswer(state, dir, route) {
  const grid = state.grid;
  const weights = Array.isArray(state.weights) ? state.weights : null;
  const R = grid.length, C = grid[0].length;
  const pos = state.position || { row: 0, col: 0 };
  const d = DIRS[dir];
  if (!d) return 0.01;
  const nr = pos.row + d[0], nc = pos.col + d[1];
  if (nr < 0 || nr >= R || nc < 0 || nc >= C) return 0.01;
  if (BLOCKED_CHARS[grid[nr][nc]]) return 0.01;

  const visited = new Set((state.visited || []).map((v) => `${v.row},${v.col}`));
  let score;
  if (route) {
    const posIdx = route.findIndex((p) => p.row === pos.row && p.col === pos.col);
    const nextIdx = route.findIndex((p) => p.row === nr && p.col === nc);
    if (posIdx >= 0 && nextIdx === posIdx + 1) {
      score = 0.95; // keep walking the optimal route
    } else {
      const sub = solveGrid(state, { row: nr, col: nc });
      const rem = weights ? sub.cost : sub.moves.length;
      score = sub.reached ? 0.05 + 0.4 * (1 / (1 + (rem || 0))) : 0.02;
    }
  } else {
    score = 0.05;
  }
  if (visited.has(`${nr},${nc}`)) score -= 0.6;
  return Math.max(0.01, Math.min(0.95, score));
}

export function stubAnswer(payload) {
  const { state } = payload;
  const src = state.position || (() => {
    for (let r = 0; r < state.grid.length; r++) for (let c = 0; c < state.grid[0].length; c++)
      if (state.grid[r][c] === 'S') return { r, c };
    return null;
  })();
  const { reached, moves, cost } = solveGrid(state);
  const weighted = Array.isArray(state.weights);
  const route = routeCells(state, reached, moves, src);

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
      if (Number.isFinite(k)) {
        // plan mode: move number k along the global route, or "stop"
        const m = moves[k - 1] || 'stop';
        answers[id] = { type: 'choice', choice: m, probabilities: { [m]: 0.93 }, confidence: 0.93 };
      } else {
        // policy mode: a single per-step Noul for the candidate `dir`
        const p = policyMoveAnswer(state, id.slice(5), route);
        answers[id] = { type: 'noul', noul: p };
      }
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

async function loadFixtureByHash(hash, config) {
  const dir = config?.recordedDir || RECORDED_DIR;
  const candidates = [
    path.join(dir, `${hash}.live.json`),
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
    if (entry?.hash) return loadFixtureByHash(entry.hash, config);
    return null;
  }
  return loadFixtureByHash(hash, config);
}

async function recordLive(hash, payload, out, config) {
  try {
    const dir = config?.recordedDir || RECORDED_DIR;
    await fs.promises.mkdir(dir, { recursive: true });
    const envelope = {
      kind: 'live',
      mode: 'live',
      model: out?.model ?? null,
      recordedAt: new Date().toISOString(),
      request: payload,
      response: out,
    };
    await fs.promises.writeFile(
      path.join(dir, `${hash}.live.json`),
      JSON.stringify(envelope, null, 2),
    );
  } catch (e) {
    // Recording must never take the request down with it.
    console.error(`recordLive: could not write fixture for ${hash}: ${e.message}`);
  }
}

// ---- run history storage (/api/runs) --------------------------------------
// Server-side, append-only JSONL (one run object per line), so the history
// survives a browser change and is visible from any device. Cap keeps the
// most recent 500 runs; past that the file is rewritten atomically
// (runs.jsonl.tmp → rename) dropping the oldest. A corrupt line is skipped.
// Validation is strictly whitelist-based: unknown keys are dropped, secret-ish
// field names are dropped (and noted), numbers are Number.isFinite-checked and
// clamped, strings are length-capped.

export const RUNS_CAP = 500;
export const RUN_RECORD_MAX_BYTES = 8 * 1024;

const RUN_SKINS = ['grid', 'gmaps'];
const RUN_MODES = ['policy', 'plan'];
const RUN_SOURCES = ['live', 'stub', 'replay'];
const RUN_OUTCOMES = ['reached', 'stuck', 'exhausted', 'wall', 'error'];
const SECRET_FIELD = /key|token|secret|auth/i;

class BadRun extends Error {}

/** strip any credential-shaped field names before anything else touches them */
function dropSecrets(obj, note) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD.test(k)) { note.push(k); continue; }
    out[k] = v;
  }
  return out;
}

function needStr(src, key, maxLen = 200) {
  const v = src[key];
  if (typeof v !== 'string') throw new BadRun(`field '${key}' must be a string`);
  if (v.length > maxLen) throw new BadRun(`field '${key}' exceeds ${maxLen} chars`);
  return v;
}

function optionalStr(src, key, maxLen = 200) {
  const v = src[key];
  if (v === undefined || v === null) return null;
  return needStr(src, key, maxLen);
}

function needEnum(src, key, allowed) {
  const v = needStr(src, key, 200);
  if (!allowed.includes(v)) throw new BadRun(`field '${key}' must be one of ${allowed.join(', ')}`);
  return v;
}

function needNum(src, key, min, max) {
  const v = src[key];
  if (!(typeof v === 'number' && Number.isFinite(v))) throw new BadRun(`field '${key}' must be a finite number`);
  return Math.min(max, Math.max(min, v));
}

function optionalNum(src, key, min, max) {
  const v = src[key];
  if (v === undefined || v === null) return null;
  return needNum(src, key, min, max);
}

function needBool(src, key) {
  const v = src[key];
  if (typeof v !== 'boolean') throw new BadRun(`field '${key}' must be a boolean`);
  return v;
}

function intish(v, min, max) {
  return Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : null;
}

function normaliseBoard(v, note) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadRun('board must be an object');
  const b = dropSecrets(v, note);
  const out = {};
  if (b.rows !== undefined && b.rows !== null) {
    const rows = intish(b.rows, 1, 1000);
    if (rows === null) throw new BadRun('board.rows must be a finite number');
    out.rows = rows;
  }
  if (b.cols !== undefined && b.cols !== null) {
    const cols = intish(b.cols, 1, 1000);
    if (cols === null) throw new BadRun('board.cols must be a finite number');
    out.cols = cols;
  }
  if (b.difficulty !== undefined) out.difficulty = optionalStr(b, 'difficulty', 200);
  if (b.hash !== undefined) out.hash = optionalStr(b, 'hash', 200);
  return out;
}

/**
 * Whitelist + coerce a client run record. Never trusts a single field:
 * unknown keys and secret-ish fields are dropped, numbers are finite-and-
 * clamped, strings are length-capped. The server stamps `id`/`at` later.
 * Returns { ok, record, dropped } or { ok: false, error: { status, code, message } }.
 */
export function normaliseRunRecord(input) {
  const note = [];
  const src = dropSecrets(input, note);
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, error: { status: 400, code: ERROR_CODES.BAD_REQUEST, message: 'run record must be a single JSON object' } };
  }
  try {
    const rec = {
      skin: needEnum(src, 'skin', RUN_SKINS),
      mode: needEnum(src, 'mode', RUN_MODES),
      source: needEnum(src, 'source', RUN_SOURCES),
      outcome: needEnum(src, 'outcome', RUN_OUTCOMES),
      reached: needBool(src, 'reached'),
      steps: needNum(src, 'steps', 0, 1e6),
      totalMs: needNum(src, 'totalMs', 0, 1e9),
    };
    for (const [key, min, max] of [
      ['optimalSteps', 0, 1e6], ['cost', 0, 1e7], ['optimalCost', 0, 1e7],
      ['checksPassed', 0, 1e6], ['checksTotal', 0, 1e6],
      ['lastStepMs', 0, 1e9], ['calls', 0, 1e6], ['questions', 0, 1e6],
      ['costUsd', 0, 1e6],
    ]) {
      if (key in src) rec[key] = optionalNum(src, key, min, max);
    }
    for (const key of ['optimalityScore', 'accuracyScore']) {
      if (key in src) rec[key] = optionalNum(src, key, 0, 1);
    }
    if ('model' in src) rec.model = optionalStr(src, 'model', 200);
    if ('board' in src) rec.board = normaliseBoard(src.board, note);
    return { ok: true, record: rec, dropped: note };
  } catch (e) {
    if (e instanceof BadRun) {
      return { ok: false, error: { status: 400, code: ERROR_CODES.BAD_REQUEST, message: e.message } };
    }
    throw e;
  }
}

/** Read all stored runs (append order), skipping unparseable lines. */
export async function readRuns(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const runs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { runs.push(JSON.parse(line)); } catch { /* corrupt line — never break the read */ }
  }
  return runs;
}

// Serialise per-file so a burst of concurrent POSTs can't interleave the
// append + cap-trim into a corrupt file.
const fileLocks = new Map();
function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(file, next.catch(() => {}));
  return next;
}

/** Append one run; past RUNS_CAP rewrite atomically keeping the newest 500. */
export async function appendRun(file, record) {
  return withFileLock(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      if (lines.length > RUNS_CAP) {
        const keep = lines.slice(lines.length - RUNS_CAP);
        const tmp = `${file}.tmp`;
        await fs.promises.writeFile(tmp, keep.join('\n') + '\n', 'utf8');
        await fs.promises.rename(tmp, file);
      }
    } catch (e) {
      // The append already succeeded; a failed cap-trim must not fail the request.
      console.error(`appendRun: cap-trim failed for ${file}: ${e.message}`);
    }
  });
}

/** Remove the whole history. Returns the number of runs cleared. */
export async function clearRuns(file) {
  return withFileLock(file, async () => {
    const runs = await readRuns(file);
    try { await fs.promises.rm(file, { force: true }); } catch { /* best-effort */ }
    return runs.length;
  });
}

async function handleApiRuns(req, res, config, rateLimited) {
  const ip = req.socket.remoteAddress || 'x';
  if (rateLimited(ip)) {
    return err(res, 429, ERROR_CODES.RATE_LIMITED, 'too many requests from this address — wait a minute and retry');
  }

  if (req.method === 'GET') {
    const runs = await readRuns(config.runsFile);
    const rawLimit = new URL(req.url, 'http://x').searchParams.get('limit');
    let limit = runs.length;
    if (rawLimit !== null) {
      const n = Number(rawLimit);
      if (Number.isFinite(n) && n >= 0) limit = Math.min(runs.length, Math.floor(n));
    }
    const kept = limit >= runs.length ? runs : runs.slice(runs.length - limit);
    return send(res, 200, { runs: [...kept].reverse(), count: runs.length });
  }

  if (req.method === 'DELETE') {
    const cleared = await clearRuns(config.runsFile);
    return send(res, 200, { cleared });
  }

  if (req.method !== 'POST') {
    return err(res, 405, ERROR_CODES.FORBIDDEN, 'method not allowed on /api/runs');
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
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'request body is not valid JSON');
  }
  const norm = normaliseRunRecord(data);
  if (!norm.ok) {
    return err(res, norm.error.status, norm.error.code, norm.error.message);
  }
  if (norm.dropped?.length) {
    console.error(`[runs-debug] dropped secret-ish run fields: ${norm.dropped.join(', ')}`);
  }
  const record = norm.record;
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > RUN_RECORD_MAX_BYTES) {
    return err(res, 413, ERROR_CODES.PAYLOAD_TOO_LARGE, `run record exceeds the ${RUN_RECORD_MAX_BYTES}-byte cap`);
  }
  record.id = crypto.randomUUID();
  record.at = new Date().toISOString();
  await appendRun(config.runsFile, record);
  return send(res, 201, record);
}

// ---- real-map feed: GET /api/geo -----------------------------------------
// Keyless. Overpass roads -> rasterised cost grid (walls = no road). The CELL
// COST is the real road class; applyCongestion() adds a SIMULATED multiplier
// (documented as such in the UI). Disks cache under cache/geo/, and committed
// snapshot fixtures under fixtures/geo/ keep the skin alive offline.

const GEO_MIN_GRID = 4;
const GEO_MAX_GRID = 64;
const GEO_DEFAULT_GRID = 16;
const GEO_SNAP_MAX_RADIUS = 4;
const GEO_RETRY_EXPAND = 0.15;

/** `<sha1(bboxKey)>` — the disk-cache / snapshot key the spec names. */
export function geoCacheKey(bbox, rows, cols) {
  return crypto.createHash('sha1').update(bboxKey(bbox, rows, cols)).digest('hex');
}

/** Parse "lat,lon"; validate ranges. Null when absent or malformed. */
export function parseGeoPoint(value) {
  if (value === null || value === undefined) return null;
  const parts = String(value).split(',').map((n) => Number(n.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** The PLACE_PAIRS entry whose bbox matches this bbox (tolerance 1e-4°). */
export function matchGeoPair(bbox) {
  const [s, w, n, e] = bbox;
  for (const pair of Object.values(PLACE_PAIRS)) {
    const [ps, pw, pn, pe] = pair.bbox;
    if (Math.abs(s - ps) < 1e-4 && Math.abs(n - pn) < 1e-4
      && Math.abs(w - pw) < 1e-4 && Math.abs(e - pe) < 1e-4) return pair;
  }
  return null;
}

/** Clean the roads array down to the compact shape the response carries. */
function compactRoads(roads) {
  return roads.map((r) => {
    const out = { class: r.class, points: r.points };
    if (r.name) out.name = r.name;
    return out;
  });
}

/**
 * Rasterise roads into a response-shaped object and verify S→D is solvable.
 * Endpoints come from `endpoints` ({from,to} geo points, optional names); when
 * absent we pick two real, reachable road cells. Unreachable goals snap to the
 * nearest road cell; a goal with no road within the radius opens a small patch.
 * Returns { ok, data } on success, { ok: false, reason } when unsolvable.
 */
export function buildGeoResponse({ roads, bbox, rows, cols, endpoints, seed, source, fetchedAt }) {
  const notes = [];
  const { base, walls } = rasterize(roads, bbox, rows, cols);

  const openPatch = (r, c) => {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && walls[nr][nc]) {
          walls[nr][nc] = 0;
          base[nr][nc] = 8; // cheapest priced class, so the opening is drivable
        }
      }
  };

  const roadCells = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) if (!walls[r][c]) roadCells.push({ r, c });

  let from = endpoints?.from;
  let to = endpoints?.to;
  if (!from || !to) {
    if (roadCells.length < 2) return { ok: false, reason: 'no roads in this bbox' };
    if (!from) {
      const cell = roadCells[0];
      from = { ...cellCenter(bbox, rows, cols, cell.r, cell.c), name: 'Start' };
    }
    if (!to) {
      const cell = roadCells[roadCells.length - 1];
      to = { ...cellCenter(bbox, rows, cols, cell.r, cell.c), name: 'Destination' };
    }
  }

  const place = (pt, role) => {
    const cell = latLonToCell(bbox, rows, cols, pt.lat, pt.lon);
    if (!cell) return { ok: false };
    const snapped = snapCell(walls, cell.r, cell.c, GEO_SNAP_MAX_RADIUS);
    if (snapped && (snapped.r !== cell.r || snapped.c !== cell.c)) {
      notes.push(`${role} had no road exactly at the point — snapped to the nearest drivable cell`);
      return { ok: true, cell: snapped, point: { lat: pt.lat, lon: pt.lon, name: pt.name || role } };
    }
    if (!snapped) {
      notes.push(`${role} is surrounded by roads-free cells — opened a small drivable opening`);
      openPatch(cell.r, cell.c);
      return { ok: true, cell, point: { lat: pt.lat, lon: pt.lon, name: pt.name || role } };
    }
    return { ok: true, cell: snapped, point: { lat: pt.lat, lon: pt.lon, name: pt.name || role } };
  };

  const fromP = place(from, 'start');
  if (!fromP.ok) return { ok: false, reason: 'start outside bbox' };
  const toP = place(to, 'destination');
  if (!toP.ok) return { ok: false, reason: 'destination outside bbox' };

  const cells = applyCongestion(base, walls, seed);
  const places = { from: { ...fromP.point, cell: fromP.cell }, to: { ...toP.point, cell: toP.cell } };
  const board = boardFromGeo({ rows, cols, walls, cells, places });
  const optimal = shortestCost(board);
  if (optimal === null) return { ok: false, reason: 'no route connects the endpoints on these roads' };

  return {
    ok: true,
    data: {
      bbox, rows, cols,
      roads: compactRoads(roads),
      places,
      cells, walls,
      source, fetchedAt,
      attribution: ATTRIBUTION,
      notes,
      optimum: optimal,
    },
  };
}

function geoQuery(bbox) {
  // Overpass needs a real UA or it 406s; the query is `way["highway"](bbox)`
  // with `out geom` so every road point carries lat/lon (no id/way joins).
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:20];way["highway"](${s},${w},${n},${e});out geom;`;
}

async function fetchOverpass(bbox, config) {
  const url = new URL(config.geoUpstream);
  url.searchParams.set('data', geoQuery(bbox));
  const r = await fetch(url.toString(), {
    headers: { 'user-agent': config.geoUserAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(config.geoTimeoutMs),
  });
  if (!r.ok) throw new Error(`Overpass returned HTTP ${r.status}`);
  const json = await r.json();
  const roads = parseOverpass(json);
  if (!Array.isArray(roads)) throw new Error('Overpass response was not parseable');
  return roads;
}

async function readGeoCache(config, key) {
  try {
    const raw = await fs.promises.readFile(path.join(config.geoCacheDir, `${key}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeGeoCache(config, key, data) {
  try {
    await fs.promises.mkdir(config.geoCacheDir, { recursive: true });
    await fs.promises.writeFile(path.join(config.geoCacheDir, `${key}.json`), JSON.stringify(data));
  } catch (e) {
    console.error(`writeGeoCache: ${e.message}`);
  }
}

/** Fraction of the requested bbox covered by a snapshot's bbox (0..1). */
function bboxOverlap(requested, snapBBox) {
  const [as, aw, an, ae] = requested;
  const [bs, bw, bn, be] = snapBBox;
  const s = Math.max(as, bs), w = Math.max(aw, bw), n = Math.min(an, bn), e = Math.min(ae, be);
  if (n <= s || e <= w) return 0;
  const overlap = (n - s) * (e - w);
  const requestedArea = (an - as) * (ae - aw);
  return requestedArea > 0 ? overlap / requestedArea : 0;
}

async function listGeoSnapshots(config) {
  let names;
  try {
    names = await fs.promises.readdir(config.geoSnapshotDir);
  } catch {
    return [];
  }
  const snaps = [];
  for (const name of names) {
    if (!name.endsWith('.snapshot.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(config.geoSnapshotDir, name), 'utf8');
      snaps.push({ file: name, ...JSON.parse(raw) });
    } catch { /* skip corrupt snapshots */ }
  }
  return snaps;
}

/** Best snapshot for this bbox (exact preset first, then best overlap). */
async function loadGeoSnapshot(config, bbox, rows, cols, endpoints) {
  const snaps = await listGeoSnapshots(config);
  if (!snaps.length) return null;
  const scored = snaps
    .map((s) => ({ s, overlap: bboxOverlap(bbox, s.bbox) }))
    .sort((a, b) => b.overlap - a.overlap);
  if (!scored.length || scored[0].overlap <= 0) return null;
  const snap = scored[0].s;
  const built = buildGeoResponse({
    roads: snap.roads, bbox, rows, cols, endpoints,
    seed: geoCacheKey(bbox, rows, cols), source: 'snapshot',
    fetchedAt: snap.fetchedAt || new Date().toISOString(),
  });
  if (!built.ok) return null;
  built.data.notes = [...(built.data.notes || []), `offline snapshot "${snap.label || snap.file}" — not live road data`];
  return built.data;
}

async function handleApiGeo(req, res, config, rateLimited) {
  const ip = req.socket.remoteAddress || 'x';
  if (rateLimited(ip)) {
    return err(res, 429, ERROR_CODES.RATE_LIMITED, 'too many requests from this address — wait a minute and retry');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return err(res, 405, ERROR_CODES.FORBIDDEN, 'method not allowed on /api/geo');
  }

  const url = new URL(req.url, 'http://x');
  const bbox = parseBbox(url.searchParams.get('bbox'));
  const rawRows = Number(url.searchParams.get('rows') ?? GEO_DEFAULT_GRID);
  const rawCols = Number(url.searchParams.get('cols') ?? GEO_DEFAULT_GRID);
  const rows = Number.isInteger(rawRows) ? rawRows : GEO_DEFAULT_GRID;
  const cols = Number.isInteger(rawCols) ? rawCols : GEO_DEFAULT_GRID;
  if (!bbox) {
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'bbox must be "south,west,north,east" within plausible lat/lon, with south<north and west<east');
  }
  if (rows < GEO_MIN_GRID || rows > GEO_MAX_GRID || cols < GEO_MIN_GRID || cols > GEO_MAX_GRID) {
    return err(res, 400, ERROR_CODES.BAD_REQUEST, `rows/cols must be integers between ${GEO_MIN_GRID} and ${GEO_MAX_GRID}`);
  }
  const refresh = ['1', 'true', 'yes', 'on'].includes(String(url.searchParams.get('refresh')).toLowerCase());

  const explicitFrom = parseGeoPoint(url.searchParams.get('from'));
  const explicitTo = parseGeoPoint(url.searchParams.get('to'));
  const pair = matchGeoPair(bbox);
  const endpoints = (explicitFrom && explicitTo)
    ? { from: explicitFrom, to: explicitTo }
    : pair
      ? { from: { lat: pair.from.lat, lon: pair.from.lon, name: pair.from.name }, to: { lat: pair.to.lat, lon: pair.to.lon, name: pair.to.name } }
      : null;

  const key = geoCacheKey(bbox, rows, cols);
  if (!refresh) {
    const cached = await readGeoCache(config, key);
    if (cached && Array.isArray(cached.cells) && cached.places?.from?.cell) {
      return send(res, 200, { ...cached, source: 'cache' });
    }
  }

  const fetchedAt = new Date().toISOString();
  let liveData = null;
  let attemptBbox = bbox;
  let unsolvableReason = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const roads = await fetchOverpass(attemptBbox, config);
      const built = buildGeoResponse({
        roads, bbox: attemptBbox, rows, cols, endpoints,
        seed: key, source: 'overpass', fetchedAt,
      });
      if (built.ok) {
        if (attempt > 0) built.data.notes.push('bbox expanded ~15% because the endpoint pair was unreachable on the first window');
        liveData = built.data;
        break;
      }
      unsolvableReason = built.reason;
      attemptBbox = expandBbox(bbox, GEO_RETRY_EXPAND);
    }
  } catch (e) {
    // Overpass down / timed out / malformed -> fall back to a committed snapshot.
    const snap = await loadGeoSnapshot(config, bbox, rows, cols, endpoints);
    if (snap) {
      return send(res, 200, snap);
    }
    const sanitized = String(e?.message || e).slice(0, 200);
    return err(res, 502, ERROR_CODES.UPSTREAM_ERROR,
      `could not fetch road data (${sanitized}) and no offline snapshot covers this area`);
  }

  if (!liveData) {
    // Network fine but the roads genuinely never connect the two endpoints.
    return err(res, 502, ERROR_CODES.UNSOLVABLE,
      `this area has no route between the chosen places on priced roads${unsolvableReason ? ` — ${unsolvableReason}` : ''}`);
  }

  writeGeoCache(config, key, liveData);
  return send(res, 200, liveData);
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
  const rid = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  const log = (extra) => evlog(config, { rid, ip }, extra);

  if (rateLimited(ip)) {
    log({ ok: false, code: ERROR_CODES.RATE_LIMITED, ms: Date.now() - t0 });
    return err(res, 429, ERROR_CODES.RATE_LIMITED, 'too many requests from this address — wait a minute and retry');
  }

  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      log({ ok: false, code: ERROR_CODES.PAYLOAD_TOO_LARGE, ms: Date.now() - t0 });
      return err(res, 413, ERROR_CODES.PAYLOAD_TOO_LARGE, `request body exceeds the ${config.maxBodyBytes}-byte cap`);
    }
    log({ ok: false, code: ERROR_CODES.BAD_REQUEST, ms: Date.now() - t0 });
    return err(res, 400, ERROR_CODES.BAD_REQUEST, `could not read request body: ${e.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    log({ ok: false, code: ERROR_CODES.BAD_REQUEST, bytes: raw.length, ms: Date.now() - t0 });
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'request body is not valid JSON');
  }
  if (!isValidPayload(payload)) {
    log({ ok: false, code: ERROR_CODES.BAD_REQUEST, bytes: raw.length, ms: Date.now() - t0 });
    return err(res, 400, ERROR_CODES.BAD_REQUEST, 'expected { state: { grid: [strings], weights? }, questions: {...} }');
  }

  const questionCount = Object.keys(payload.questions).length;
  if (questionCount > config.maxQuestions) {
    log({ ok: false, code: ERROR_CODES.TOO_MANY_QUESTIONS, bytes: raw.length, questions: questionCount, ms: Date.now() - t0 });
    return err(res, 400, ERROR_CODES.TOO_MANY_QUESTIONS,
      `${questionCount} questions exceeds the per-request cap of ${config.maxQuestions}`);
  }

  const reqKey = keyFromHeaders(req.headers);
  const key = reqKey || config.apiKey;
  const hash = requestHash(payload);
  const mode = resolveMode(config, reqKey);
  const base = {
    rid, ip, bytes: raw.length, questions: questionCount,
    hasKey: !!key, keyFp: fingerprintKey(key), mode,
  };

  let out;

  if (mode === 'replay') {
    const hit = await findFixture(config, hash);
    if (!hit) {
      log({ ...base, ok: false, code: ERROR_CODES.NO_FIXTURE, ms: Date.now() - t0 });
      return err(res, 404, ERROR_CODES.NO_FIXTURE,
        'no recorded fixture matches this request hash — run once in LIVE or STUB mode to record one');
    }
    const envelope = JSON.parse(hit.raw);
    out = { ...envelope.response, mode: 'replay' };
    log({ ...base, ok: true, ms: Date.now() - t0, upstream: `<replay:${hit.file.split('/').pop()}>` });
  } else if (mode === 'stub') {
    out = stubAnswer(payload);
    out.mode = 'stub';
    decorateResponse(out, payload, Date.now() - t0);
    log({ ...base, ok: true, ms: Date.now() - t0, upstream: '<stub>' });
  } else {
    const upT0 = Date.now();
    try {
      const r = await fetch(config.upstream, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, model: payload.model || config.model }),
        signal: AbortSignal.timeout(30_000),
      });
      const upMs = Date.now() - upT0;
      if (!r.ok) {
        // The raw upstream body goes to the DEBUG LOG (truncated + redacted)
        // so a failed deploy can be diagnosed from the journal — but never to
        // the client: the client error carries only a sanitized message.
        const upstreamText = await r.text().catch(() => '');
        const upstreamStatus = r.status;
        const hint = upstreamStatus === 401
          ? 'cannot authenticate — check your API key'
          : upstreamStatus === 403
            ? 'forbidden — check your API key and permissions'
            : upstreamStatus === 429
              ? 'rate limited by the upstream'
              : upstreamStatus === 400
                ? 'the upstream rejected the payload'
                : 'upstream error';
        const upstreamMessage = `upstream TypeSafe API returned HTTP ${upstreamStatus} — ${hint}`;
        log({
          ...base, ok: false, code: ERROR_CODES.UPSTREAM_ERROR,
          upStatus: upstreamStatus, upMs,
          upstream: truncate(upstreamText, 1024),
          ms: Date.now() - t0,
        });
        return err(res, 502, ERROR_CODES.UPSTREAM_ERROR, upstreamMessage, { upstreamStatus });
      }
      out = await r.json();
      out.mode = 'live';
      decorateResponse(out, payload, Date.now() - t0);
      await recordLive(hash, payload, out, config);
      log({
        ...base, ok: true, upStatus: r.status, upMs, ms: Date.now() - t0,
        upstream: `<live ok, ${Object.keys(out.answers || {}).length} answers>`,
      });
    } catch (e) {
      log({ ...base, ok: false, code: ERROR_CODES.UPSTREAM_ERROR, ms: Date.now() - t0 });
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
  // Callers may pass a PARTIAL config (e.g. createServer({}) or a test helper
  // that only overrides a field or two). Fill the gaps from DEFAULTS rather
  // than from readConfig(), so a stray TYPESAFE_* env var can never leak a real
  // key or upstream into a test. Without this, createServer({}) produced a
  // config with no runsFile and every /api/runs request 500'd.
  const cfg = { ...DEFAULTS, ...config };
  const rateLimited = makeRateLimiter(cfg.rateLimit);
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return err(res, 400, ERROR_CODES.BAD_REQUEST, 'malformed request URL');
    }

    if (url.pathname === '/api/jev' && req.method === 'POST') {
      return handleApiJev(req, res, cfg, rateLimited).catch(() =>
        err(res, 500, ERROR_CODES.INTERNAL, 'internal error'));
    }
    if (url.pathname === '/api/runs') {
      return handleApiRuns(req, res, cfg, rateLimited).catch(() =>
        err(res, 500, ERROR_CODES.INTERNAL, 'internal error'));
    }
    if (url.pathname === '/api/geo') {
      return handleApiGeo(req, res, cfg, rateLimited).catch(() =>
        err(res, 500, ERROR_CODES.INTERNAL, 'internal error'));
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        mode: 'proxy',
        hasEnvKey: !!cfg.apiKey,
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
    if (debugEnabled(config)) console.log('  JEV_DEBUG=1 — one redacted JSON debug line per request on stderr');
  });
}