// server.mjs — static file server + a thin proxy for the TypeSafe API.
//
// Why a proxy at all: the TypeSafe API key must never reach the browser.
// The browser POSTs the board to /api/jev; this process attaches the key.
//
// STUB MODE: if TYPESAFE_API_KEY is not set, the server answers with a locally
// computed response so the demo still runs. Those answers are marked
// "_stub": true and the UI labels them loudly. They are NOT Jev.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.TYPESAFE_API_KEY || '';
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_MTOK = 0.042; // USD per 1M input tokens

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- crude per-IP rate limit (public demo hardening) ----------------------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 60_000, max = Number(process.env.RATE_LIMIT || 40);
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body
    : typeof body === 'string' ? Buffer.from(body)
    : Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 2_000_000) reject(new Error('too large')); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

// ---- stub: a local BFS that fakes a Jev-shaped answer ---------------------
function stubAnswer(payload) {
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
  return { model: 'STUB-LOCAL-BFS', answers, usage: { input_tokens, output_tokens: 0 }, _stub: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/jev' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    if (rateLimited(ip)) return send(res, 429, { error: 'rate limited — try again shortly' });

    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, { error: `bad request body: ${e.message}` }); }

    const t0 = Date.now();
    let out;
    if (!API_KEY) {
      out = stubAnswer(payload);
    } else {
      try {
        const r = await fetch(UPSTREAM, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, model: payload.model || MODEL }),
        });
        out = await r.json();
        if (!r.ok) return send(res, r.status, { error: out });
      } catch (e) {
        return send(res, 502, { error: `upstream failed: ${e.message}` });
      }
    }
    out._ms = Date.now() - t0;
    const it = out?.usage?.input_tokens ?? 0;
    out._cost_usd = (it / 1e6) * PRICE_PER_MTOK;
    out._questions = Object.keys(payload.questions || {}).length;
    return send(res, 200, out);
  }

  if (url.pathname === '/api/health') {
    return send(res, 200, { ok: true, stub: !API_KEY, model: API_KEY ? MODEL : 'STUB-LOCAL-BFS' });
  }

  // static
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' }, 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log(`jev-pathpuzzle on http://localhost:${PORT}`);
  console.log(API_KEY ? `  mode: LIVE (${MODEL})` : '  mode: STUB — set TYPESAFE_API_KEY for live Jev');
});
