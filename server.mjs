// server.mjs — the same-origin shim: static files + `POST /api/jev`.
//
// Why the shim exists at all (a hard finding, documented in the README):
// the TypeSafe API sends NO `Access-Control-Allow-Origin` for any origin and
// rejects the preflight with `400 Disallowed CORS origin`, so a browser
// page can never call `https://api.typesafe.ai/v1/systemone` directly. This
// process is the necessary same-origin pass-through and nothing more.
//
// LIVE-only, BYOK, server-side: the key comes from the BROWSER per request in
// the `x-jev-key` header (proxy transport), falling back to an `Authorization:
// Bearer` header, and then to an optional env `TYPESAFE_API_KEY`. The shim
// stores nothing. The key is never logged and never echoed to the client.
//
// Two states, nothing else:
//   LIVE   a key is present (header or env) -> one forwarded request to TypeSafe
//   no key -> a clean, typed 401 `no_key`. The shim never answers from local code.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = __dirname;

export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_MTOK = 0.042; // USD per 1M tokens (single blended rate, documented)

// Only the client tree is served. server.mjs, package.json, test/, runs.jsonl,
// .git/ … are deliberately NOT static assets.
const STATIC_FILES = new Set(['index.html', 'app.js', 'history.html', 'history.js', 'style.css']);
const STATIC_DIRS = new Set(['lib', 'skins', 'assets']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export const ERROR_CODES = {
  RATE_LIMITED: 'rate_limited',
  BAD_REQUEST: 'bad_request',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  TOO_MANY_QUESTIONS: 'too_many_questions',
  NO_KEY: 'no_key',
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
  // Policy mode issues ONE call per step (plus a re-ask per reversal), so a
  // single Hard run can legitimately make 40–90 calls in a minute. The limit
  // protects the server from abuse, not the user from themselves — keep it
  // generous. Override with RATE_LIMIT.
  rateLimit: 1200,
  maxBodyBytes: 2_000_000,
  maxQuestions: 512,
  // Server-side run history (append-only JSONL). Overridable for tests so they
  // never touch the real runs.jsonl.
  runsFile: path.join(__dirname, 'runs.jsonl'),
};

export function readConfig(env = process.env) {
  return {
    port: Number(env.PORT || DEFAULTS.port),
    apiKey: env.TYPESAFE_API_KEY || '',
    model: env.TYPESAFE_MODEL || DEFAULTS.model,
    rateLimit: Number(env.RATE_LIMIT || DEFAULTS.rateLimit),
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    maxQuestions: DEFAULTS.maxQuestions,
    // JEV_DEBUG=1/true/yes/on → one redacted JSON line per /api/jev to stderr
    debug: env.JEV_DEBUG || '',
    // debug-only: where the last raw answers payload is dumped for diagnosis
    answersFile: env.JEV_ANSWERS_FILE || '/tmp/jev-last-answers.json',
    // test-only override so the suite can point at a mock upstream
    upstream: env.TYPESAFE_UPSTREAM || UPSTREAM,
    // test-only override so the run-history suite writes to a scratch file
    runsFile: env.RUNS_FILE || DEFAULTS.runsFile,
  };
}

function keyFromHeaders(headers) {
  const x = headers['x-jev-key'];
  if (x) return String(x).trim();
  const auth = headers.authorization;
  if (auth) return String(auth).replace(/^Bearer\s+/i, '').trim();
  return '';
}

// ---- small helpers -------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = null) {
  const buf = Buffer.isBuffer(body) ? body
    : typeof body === 'string' ? Buffer.from(body)
    : Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length, ...(extra || {}) });
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

/**
 * A compact, redacted shape summary of an answers payload — enough to diagnose a
 * parsing failure from the journal alone, without dumping the whole body.
 * Answers are never secret, but they can be large.
 */
export function answerShape(answers) {
  if (answers === undefined) return { kind: 'absent' };
  if (answers === null) return { kind: 'null' };
  if (Array.isArray(answers)) {
    return { kind: 'array', count: answers.length, first: truncate(JSON.stringify(answers[0]), 200) };
  }
  if (typeof answers !== 'object') return { kind: typeof answers, value: truncate(String(answers), 200) };
  const keys = Object.keys(answers);
  const sample = keys.slice(0, 3).map((k) => `${k}=${truncate(JSON.stringify(answers[k]), 160)}`);
  const withChoice = keys.filter((k) => typeof answers[k]?.choice === 'string').length;
  return { kind: 'object', count: keys.length, keys: keys.slice(0, 6), withChoice, sample };
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
  const ot = out?.usage?.output_tokens ?? 0;
  out._cost_usd = ((it + ot) / 1e6) * PRICE_PER_MTOK;
  out._questions = Object.keys(payload.questions || {}).length;
  out._output_tokens = ot;
  return out;
}

// ---- run history storage (/api/runs) --------------------------------------
// Server-side, append-only JSONL (one run object per line), so the history
// survives a browser change and is visible from any device. Cap keeps the
// most recent 500 runs; past that the file is rewritten atomically
// (runs.jsonl.tmp → rename) dropping the oldest. A corrupt line is skipped.
// Validation is strictly whitelist-based: unknown keys are dropped, secret-ish
// field names are dropped (and noted), numbers are Number.isFinite-checked and
// clamped, strings are length-capped. The record MUST be `mode: "live"` — the
// app is live-only, so anything else is rejected on purpose.

export const RUNS_CAP = 500;
export const RUN_RECORD_MAX_BYTES = 8 * 1024;

const RUN_MODES = ['live'];
const RUN_OUTCOMES = ['reached', 'stuck', 'unparsed', 'illegal', 'revisited', 'exhausted', 'error'];
const RUN_DIFFICULTIES = ['easy', 'medium', 'hard'];
const SECRET_FIELD = /key|token|secret|auth/i;

// Field names that LOOK credential-shaped but are legitimate, validated metrics.
// `tokensIn` / `tokensOut` are numbers clamped by optionalNum(), so they can
// never carry a credential — without this allowlist the scrubber silently ate
// the token counts and the history page lost a whole column.
const SAFE_METRIC_FIELDS = new Set(['tokensIn', 'tokensOut']);

class BadRun extends Error {}

/** strip any credential-shaped field names before anything else touches them */
function dropSecrets(obj, note) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD.test(k) && !SAFE_METRIC_FIELDS.has(k)) { note.push(k); continue; }
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
      difficulty: needEnum(src, 'difficulty', RUN_DIFFICULTIES),
      mode: needEnum(src, 'mode', RUN_MODES),
      outcome: needEnum(src, 'outcome', RUN_OUTCOMES),
      steps: needNum(src, 'steps', 0, 1e6),
      rings: needNum(src, 'rings', 0, 1e3),
      sectors: needNum(src, 'sectors', 0, 1e3),
      totalMs: needNum(src, 'totalMs', 0, 1e9),
    };
    for (const [key, min, max] of [
      ['optimalSteps', 0, 1e6], ['lastStepMs', 0, 1e9], ['msPerStep', 0, 1e9],
      ['calls', 0, 1e6], ['questions', 0, 1e6],
      ['tokensIn', 0, 1e10], ['tokensOut', 0, 1e10],
      ['costUsd', 0, 1e6], ['stepAccuracy', 0, 1], ['correctSteps', 0, 1e6],
      ['elapsedMs', 0, 1e12],
    ]) {
      if (key in src) rec[key] = optionalNum(src, key, min, max);
    }
    if ('moves' in src && Array.isArray(src.moves)) rec.moves = src.moves;
    if ('boardHash' in src) rec.boardHash = optionalStr(src, 'boardHash', 200);
    if ('model' in src) rec.model = optionalStr(src, 'model', 200);
    if ('reject' in src) rec.reject = optionalStr(src, 'reject', 40);
    if ('rejectDir' in src) rec.rejectDir = optionalStr(src, 'rejectDir', 40);
    if ('chainAgreement' in src) rec.chainAgreement = optionalNum(src, 'chainAgreement', 0, 1);
    if ('chainAnswered' in src) rec.chainAnswered = optionalNum(src, 'chainAnswered', 0, 1e6);
    if ('chainApplied' in src) rec.chainApplied = optionalNum(src, 'chainApplied', 0, 1e6);
    if ('pathCalls' in src) rec.pathCalls = optionalNum(src, 'pathCalls', 0, 1e6);
    if ('obstacles' in src) rec.obstacles = src.obstacles === true;
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

// ---- /api/jev -------------------------------------------------------------
function isValidPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const s = payload.state;
  if (!s || typeof s !== 'object') return false;
  if (!(s.maze && typeof s.maze === 'object' && Number.isFinite(s.maze.rings) && s.maze.rings > 0)) return false;
  if (!(Array.isArray(s.open_radial) && s.open_radial.length > 0)) return false;
  if (!(Array.isArray(s.open_circ) && s.open_circ.length > 0)) return false;
  if (!(payload.questions && typeof payload.questions === 'object' && !Array.isArray(payload.questions))) return false;
  // A policy call asks about every cell at once, naming one cell per question,
  // so there is no single position for it to carry. Every other call is about
  // where Abhimanyu is standing, and must say so.
  if (s.task === 'chakravyuha_policy') {
    return Number.isFinite(s.centre?.ring) && Number.isFinite(s.centre?.sector);
  }
  return !!(s.abhimanyu && Number.isFinite(s.abhimanyu.ring) && Number.isFinite(s.abhimanyu.sector));
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
    return err(res, 400, ERROR_CODES.BAD_REQUEST,
      'expected { state: { maze, open_radial, open_circ, centre, … }, questions: {...} } ' +
      '— with abhimanyu unless the task is chakravyuha_policy, which names a cell per question');
  }

  const questionCount = Object.keys(payload.questions).length;
  if (questionCount > config.maxQuestions) {
    log({ ok: false, code: ERROR_CODES.TOO_MANY_QUESTIONS, bytes: raw.length, questions: questionCount, ms: Date.now() - t0 });
    return err(res, 400, ERROR_CODES.TOO_MANY_QUESTIONS,
      `${questionCount} questions exceeds the per-request cap of ${config.maxQuestions}`);
  }

  const reqKey = keyFromHeaders(req.headers);
  const key = reqKey || config.apiKey;
  const base = {
    rid, ip, bytes: raw.length, questions: questionCount,
    hasKey: !!key, keyFp: fingerprintKey(key),
  };

  if (!key) {
    log({ ...base, ok: false, code: ERROR_CODES.NO_KEY, ms: Date.now() - t0 });
    return err(res, 401, ERROR_CODES.NO_KEY,
      'BYOK: paste your TypeSafe key in the keycard to send the maze to Jev.');
  }

  const upT0 = Date.now();
  let out;
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
    // DEBUG ONLY: keep the last raw answers payload on disk so a parsing failure
    // can be diagnosed exactly, not guessed at. Answers carry no credential.
    if (debugEnabled(config)) {
      try {
        await fs.promises.writeFile(
          config.answersFile || '/tmp/jev-last-answers.json',
          JSON.stringify({ at: new Date().toISOString(), model: out.model, questions: Object.keys(payload.questions || {}), answers: out.answers }, null, 1),
        );
      } catch { /* a debug dump must never break a live request */ }
    }
    log({
      ...base, ok: true, mode: 'live', upStatus: r.status, upMs, ms: Date.now() - t0,
      upstream: `<live ok, ${Object.keys(out.answers || {}).length} answers>`,
      answersShape: answerShape(out.answers),
    });
  } catch (e) {
    log({ ...base, ok: false, code: ERROR_CODES.UPSTREAM_ERROR, ms: Date.now() - t0 });
    return err(res, 502, ERROR_CODES.UPSTREAM_ERROR, `upstream TypeSafe API unreachable: ${e.message}`);
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
    // Revalidate every time. These are small local assets and the app is
    // redeployed in place; without this the browser may keep serving app.js
    // and skins/* from its own cache and the user runs the previous build.
    const headers = { 'cache-control': 'no-cache' };
    if (req.method === 'HEAD') return send(res, 200, '', 'text/plain; charset=utf-8', headers);
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', headers);
  });
}

// ---- app & entry point ---------------------------------------------------
export function createServer(config = readConfig()) {
  // Callers may pass a PARTIAL config (e.g. createServer({}) or a test helper
  // that only overrides a field or two). Fill the gaps from DEFAULTS rather
  // than from readConfig(), so a stray TYPESAFE_* env var can never leak a real
  // key or upstream into a test.
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
    console.log(`chakravyuha on http://localhost:${config.port}`);
    if (config.apiKey) {
      console.log('  mode: LIVE-capable (env key present; the browser may also send its own per-request key)');
    } else {
      console.log('  mode: no key set — requests without a browser key answer 401 no_key (BYOK)');
    }
    console.log('  the shim exists because api.typesafe.ai sends no Access-Control-Allow-Origin (CORS finding)');
    if (debugEnabled(config)) console.log('  JEV_DEBUG=1 — one redacted JSON debug line per request on stderr');
  });
}