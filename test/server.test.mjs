// test/server.test.mjs — http-level tests against a freshly booted shim on
// an ephemeral port: smoke, BYOK header handling, static allowlist, stub
// round-trips (unweighted + weighted), replay, hardening, and the live
// branch against a mock upstream (no real key, no real network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  startServer, stopServer, postJev, FIXED_PAYLOAD, SMALL_PAYLOAD, NAV_PAYLOAD, startMockUpstream,
} from './helpers.mjs';
import { requestHash, RECORDED_DIR } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- smoke ---------------------------------------------------------------
test('smoke: health, index, and 404 for a missing asset (no key set)', async () => {
  const ctx = await startServer({});
  try {
    const health = await fetch(`${ctx.base}/api/health`);
    assert.equal(health.status, 200);
    const h = await health.json();
    assert.deepEqual(h, { ok: true, mode: 'proxy', hasEnvKey: false });

    const index = await fetch(`${ctx.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /<title>PathPuzzle/);

    const missing = await fetch(`${ctx.base}/definitely-not-here.svg`);
    assert.equal(missing.status, 404);
    const b = await missing.json();
    assert.equal(b.error?.code, 'not_found');
  } finally {
    await stopServer(ctx);
  }
});

test('health reports hasEnvKey when a server-side key exists', async () => {
  const ctx = await startServer({ apiKey: 'sk-env-fake' });
  try {
    const h = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.deepEqual(h, { ok: true, mode: 'proxy', hasEnvKey: true });
  } finally {
    await stopServer(ctx);
  }
});

// ---- static allowlist ------------------------------------------------------
test('the client tree is served, the server source is not', async () => {
  const ctx = await startServer({});
  try {
    for (const asset of ['/app.js', '/style.css', '/lib/referee.js', '/skins/gmaps.js', '/history.html', '/history.js']) {
      const r = await fetch(`${ctx.base}${asset}`);
      assert.equal(r.status, 200, `${asset} served`);
      assert.match(r.headers.get('content-type'), /javascript|css|html/, `${asset} MIME`);
    }
    for (const secret of ['/server.mjs', '/package.json', '/.git/config', '/fixtures/index.json', '/test/helpers.mjs', '/runs.jsonl']) {
      const r = await fetch(`${ctx.base}${secret}`);
      assert.equal(r.status, 404, `${secret} must not be served`);
    }
  } finally {
    await stopServer(ctx);
  }
});

test('unknown /api/ endpoint is a structured 404', async () => {
  const ctx = await startServer({});
  try {
    const r = await fetch(`${ctx.base}/api/nope`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error?.code, 'not_found');
  } finally {
    await stopServer(ctx);
  }
});

// ---- stub round-trip -------------------------------------------------------
test('stub round-trip (unweighted): one typed answer per question plus the meters', async () => {
  const ctx = await startServer({});
  try {
    const { status, body } = await postJev(ctx.base, FIXED_PAYLOAD);
    assert.equal(status, 200);

    const expectedTypes = {
      reachable: 'noul',
      path_length: 'choice',
      maze_difficulty: 'score',
      move_1: 'choice',
      move_2: 'choice',
    };
    const qids = Object.keys(FIXED_PAYLOAD.questions).sort();
    const aids = Object.keys(body.answers).sort();
    assert.deepEqual(aids, qids, 'one answer per question, no extras, no gaps');

    for (const id of qids) {
      assert.equal(body.answers[id].type, expectedTypes[id], `type for ${id}`);
    }
    assert.equal(body.mode, 'stub');
    assert.equal(body._stub, true);
    assert.equal(typeof body._ms, 'number');
    assert.ok(body._ms >= 0);
    assert.equal(typeof body._cost_usd, 'number');
    assert.ok(body._cost_usd >= 0);
    assert.equal(body._questions, qids.length);
    assert.equal(typeof body.usage?.input_tokens, 'number');
  } finally {
    await stopServer(ctx);
  }
});

test('stub round-trip (weighted navigation): least-cost answers from Dijkstra', async () => {
  const ctx = await startServer({});
  try {
    const { status, body } = await postJev(ctx.base, NAV_PAYLOAD);
    assert.equal(status, 200);
    assert.equal(body.mode, 'stub');
    const types = {
      reachable: 'noul',
      cost_band: 'choice',
      eta_band: 'choice',
      route_difficulty: 'score',
      move_1: 'choice',
      move_2: 'choice',
      move_3: 'choice',
    };
    for (const [id, type] of Object.entries(types)) {
      assert.equal(body.answers[id]?.type, type, `type for ${id}`);
      assert.ok(body.answers[id], `answered ${id}`);
    }
    // the stub's least-cost route must actually be least cost per the referee
    const { shortestCost, walkPath } = await import('../lib/referee.js');
    const board = {
      R: 2, C: 3,
      rows: NAV_PAYLOAD.state.grid,
      weights: NAV_PAYLOAD.state.weights,
      src: { r: NAV_PAYLOAD.state.source.row, c: NAV_PAYLOAD.state.source.col },
      dst: { r: NAV_PAYLOAD.state.destination.row, c: NAV_PAYLOAD.state.destination.col },
    };
    const moves = Object.keys(body.answers).filter((k) => k.startsWith('move_'))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((k) => body.answers[k].choice);
    const opt = shortestCost(board);
    const w = walkPath(board, moves);
    assert.equal(w.reached, true);
    assert.equal(w.cost, opt, 'stub move list is least-cost');
  } finally {
    await stopServer(ctx);
  }
});

// ---- hardening ------------------------------------------------------------
test('invalid JSON body is a 400 bad_request', async () => {
  const ctx = await startServer({});
  try {
    const { status, body } = await postJev(ctx.base, '{not json');
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'bad_request');
    assert.equal(typeof body.error?.message, 'string');
  } finally {
    await stopServer(ctx);
  }
});

test('missing questions object is a 400 bad_request', async () => {
  const ctx = await startServer({});
  try {
    const { status, body } = await postJev(ctx.base, { state: { grid: ['S'] } });
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'bad_request');
  } finally {
    await stopServer(ctx);
  }
});

test('oversized body is a 413 payload_too_large', async () => {
  const ctx = await startServer({ maxBodyBytes: 512 });
  try {
    const big = JSON.stringify({ state: { grid: ['S'] }, questions: { x: 'y'.repeat(2000) } });
    const { status, body } = await postJev(ctx.base, big);
    assert.equal(status, 413);
    assert.equal(body.error?.code, 'payload_too_large');
  } finally {
    await stopServer(ctx);
  }
});

test('too many questions per request is a typed 400', async () => {
  const ctx = await startServer({ maxQuestions: 2 });
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD); // 4 questions
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'too_many_questions');
  } finally {
    await stopServer(ctx);
  }
});

test('per-IP rate limit kicks in past RATE_LIMIT', async () => {
  const ctx = await startServer({ rateLimit: 1 });
  try {
    const first = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(first.status, 200);
    const second = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(second.status, 429);
    assert.equal(second.body.error?.code, 'rate_limited');
  } finally {
    await stopServer(ctx);
  }
});

// ---- replay ---------------------------------------------------------------
function readFixtureEntry(name) {
  const manifestPath = path.join(__dirname, '..', 'fixtures', 'index.json');
  const idx = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = idx[name];
  const envelopeRaw = fs.readFileSync(path.join(__dirname, '..', entry.file), 'utf8');
  return JSON.parse(envelopeRaw);
}

test('replay (hash mode): known requests are served from the recorded fixture', async () => {
  const ctx = await startServer({ replay: '1' });
  try {
    for (const name of ['easy', 'hard']) {
      const fixture = readFixtureEntry(name);
      const { status, body } = await postJev(ctx.base, fixture.request);
      assert.equal(status, 200, `${name} replay status`);
      assert.equal(body.mode, 'replay');
      assert.deepEqual(body.answers, fixture.response.answers, `${name} answers match recording`);
    }
  } finally {
    await stopServer(ctx);
  }
});

test('replay (named mode): TYPESAFE_REPLAY=easy serves the easy fixture whatever the request', async () => {
  const ctx = await startServer({ replay: 'easy' });
  try {
    const fixture = readFixtureEntry('easy');
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 200);
    assert.equal(body.mode, 'replay');
    assert.deepEqual(body.answers, fixture.response.answers);
    const other = await postJev(ctx.base, FIXED_PAYLOAD);
    assert.deepEqual(other.body.answers, fixture.response.answers);
  } finally {
    await stopServer(ctx);
  }
});

test('replay (hash mode): an unknown request is a 404 no_fixture, not a crash', async () => {
  const ctx = await startServer({ replay: '1' });
  try {
    const unique = crypto.randomBytes(8).toString('hex');
    const payload = { ...SMALL_PAYLOAD, state: { ...SMALL_PAYLOAD.state, salt: unique } };
    const { status, body } = await postJev(ctx.base, payload);
    assert.equal(status, 404);
    assert.equal(body.error?.code, 'no_fixture');
  } finally {
    await stopServer(ctx);
  }
});

// ---- live (against a mock upstream; never the real API) --------------------
const MOCK_LIVE_BODY = {
  model: 'mock-jevv-9000',
  answers: {
    reachable: { type: 'noul', noul: 0.42 },
    move_1: { type: 'choice', choice: 'right', probabilities: { right: 0.99 }, confidence: 0.99 },
    path_length: { type: 'choice', choice: '1-5', probabilities: { '1-5': 0.8 }, confidence: 0.8 },
    maze_difficulty: { type: 'score', score: 1, probabilities: { '1': 0.6 }, confidence: 0.6 },
  },
  usage: { input_tokens: 1000, output_tokens: 7 },
};

function runLive(ctx, upstream) {
  const hash = requestHash(SMALL_PAYLOAD);
  // Each test server records into its own scratch directory (see
  // test/helpers.mjs), so this path is private to this test.
  const recordedFile = path.join(ctx.recordedDir, `${hash}.live.json`);
  return { recordedFile, cleanup: () => { try { fs.rmSync(recordedFile, { force: true }); } catch { /* best-effort */ } } };
}

test('live (env key): proxies to the upstream, meters and records the run', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ apiKey: 'sk-env-key', upstream: `${upstream.base}/v1/systemone` });
  const { recordedFile, cleanup } = runLive(ctx, upstream);
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 200);
    assert.equal(body.mode, 'live');
    assert.deepEqual(body.answers, MOCK_LIVE_BODY.answers);
    assert.equal(body._questions, 4);
    assert.equal(body._cost_usd, (1000 / 1e6) * 0.042);
    assert.ok(!JSON.stringify(body).includes('sk-env-key'));

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstream.lastRequest().auth, 'Bearer sk-env-key');
    assert.match(upstream.lastRequest().url, /^\/v1\/systemone/);

    assert.ok(fs.existsSync(recordedFile), 'live response recorded');
    const recorded = JSON.parse(fs.readFileSync(recordedFile, 'utf8'));
    assert.ok(!JSON.stringify(recorded).includes('sk-env-key'));
    assert.deepEqual(recorded.response.answers, MOCK_LIVE_BODY.answers);
  } finally {
    cleanup();
    await stopServer(ctx);
    await upstream.close();
  }
});

test('live (BYOK): the x-jev-key header drives the reminder, per request, no env key', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ upstream: `${upstream.base}/v1/systemone` });
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': 'sk-browser-key-42' } });
    assert.equal(status, 200);
    assert.equal(body.mode, 'live', 'a browser-supplied key flips the shim to live');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstream.lastRequest().auth, 'Bearer sk-browser-key-42');
    assert.ok(!JSON.stringify(body).includes('sk-browser-key-42'));
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});

test('live (BYOK): the authorization Bearer header is a fallback for x-jev-key', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ upstream: `${upstream.base}/v1/systemone` });
  try {
    // x-jev-key wins over authorization when both present
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD, {
      headers: { 'authorization': 'Bearer sk-auth-key', 'x-jev-key': 'sk-xjev-key' },
    });
    assert.equal(status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstream.lastRequest().auth, 'Bearer sk-xjev-key');
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});

test('live: a fake per-request key against a 401 upstream yields a clean typed 502', async () => {
  const upstream = await startMockUpstream({ status: 401, body: { detail: { message: 'bad key' } } });
  const ctx = await startServer({ upstream: `${upstream.base}/v1/systemone` });
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': 'sk-definitely-wrong' } });
    assert.equal(status, 502);
    assert.equal(body.error?.code, 'upstream_error');
    assert.ok(!JSON.stringify(body).includes('bad key'), 'raw upstream body is never echoed');
    assert.ok(!JSON.stringify(body).includes('sk-definitely-wrong'), 'the key is never echoed');
    const h = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(h.ok, true, 'the shim keeps serving after a failed live call');
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});

test('live: an unreachable upstream is a typed 502, not a crash', async () => {
  const gone = await startMockUpstream({ status: 200, body: {} });
  const deadUrl = gone.base;
  await gone.close();
  const ctx = await startServer({ upstream: deadUrl });
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': 'sk-x' } });
    assert.equal(status, 502);
    assert.equal(body.error?.code, 'upstream_error');
    const h = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(h.ok, true);
  } finally {
    await stopServer(ctx);
  }
});

// ---- no pathfinding in the live path ---------------------------------------
test('live: the stub never runs when any key is present', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ upstream: `${upstream.base}/v1/systemone` });
  try {
    const { body } = await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': 'sk-x' } });
    assert.equal(body.mode, 'live');
    assert.equal(body._stub, undefined, 'live answers carry no _stub marker');
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});