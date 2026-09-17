// test/server.test.mjs — http-level tests against a freshly booted server on
// an ephemeral port: smoke, stub round-trip, replay, hardening, and the live
// branch against a mock upstream (no real key, no real network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  startServer, stopServer, postJev, FIXED_PAYLOAD, SMALL_PAYLOAD, startMockUpstream,
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
    assert.deepEqual({ ok: h.ok, stub: h.stub }, { ok: true, stub: true });
    assert.equal(h.mode, 'stub');

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

test('health reports replay mode when TYPESAFE_REPLAY is set', async () => {
  const ctx = await startServer({ replay: '1' });
  try {
    const h = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(h.mode, 'replay');
    assert.equal(h.stub, false);
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
test('stub round-trip: one typed answer per question plus the meters', async () => {
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
      assert.equal(body._questions, fixture.response._questions);
      assert.deepEqual(body.answers, fixture.response.answers, `${name} answers match recording`);
      assert.equal(body._ms, fixture.response._ms);
      assert.equal(body._cost_usd, fixture.response._cost_usd);
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
    // the reportedly-different request still gets the named fixture
    const other = await postJev(ctx.base, FIXED_PAYLOAD);
    assert.deepEqual(other.body.answers, fixture.response.answers);
  } finally {
    await stopServer(ctx);
  }
});

test('replay (hash mode): an unknown request is a 404 no_fixture, not a crash', async () => {
  const ctx = await startServer({ replay: '1' });
  try {
    // a guaranteed-unique payload so no other test can have recorded its hash
    const unique = crypto.randomBytes(8).toString('hex');
    const payload = {
      ...SMALL_PAYLOAD,
      state: { ...SMALL_PAYLOAD.state, salt: unique },
    };
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

test('live: proxies to the upstream, attaches the key, meters and records the run', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({
    apiKey: 'sk-test-secret-123',
    upstream: `${upstream.base}/v1/systemone`,
  });
  const hash = requestHash(SMALL_PAYLOAD);
  const recordedFile = path.join(RECORDED_DIR, `${hash}.live.json`);
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 200);
    assert.equal(body.mode, 'live');
    assert.equal(body.model, 'mock-jevv-9000');
    assert.deepEqual(body.answers, MOCK_LIVE_BODY.answers);
    assert.equal(body._questions, 4);
    assert.equal(body._cost_usd, (1000 / 1e6) * 0.042);
    assert.equal(typeof body._ms, 'number');
    // the key must never be returned
    assert.ok(!JSON.stringify(body).includes('sk-test-secret-123'));

    // the proxy really attached the key without leaking it
    await new Promise((r) => setTimeout(r, 50)); // give the mock a beat
    assert.equal(upstream.lastRequest().auth, 'Bearer sk-test-secret-123');
    assert.match(upstream.lastRequest().url, /^\/v1\/systemone/);

    // a live success is auto-recorded for later replay
    assert.ok(fs.existsSync(recordedFile), 'live response recorded to fixtures/recorded/');
    const recorded = JSON.parse(fs.readFileSync(recordedFile, 'utf8'));
    assert.equal(recorded.kind, 'live');
    assert.equal(recorded.mode, 'live');
    assert.ok(!JSON.stringify(recorded).includes('sk-test-secret-123'));
    assert.deepEqual(recorded.response.answers, MOCK_LIVE_BODY.answers);
  } finally {
    try { fs.rmSync(recordedFile, { force: true }); } catch { /* best-effort */ }
    await stopServer(ctx);
    await upstream.close();
  }
});

test('live: a non-2xx upstream is a typed 502 and the server keeps serving', async () => {
  const upstream = await startMockUpstream({ status: 500, body: { oops: 'raw blob must never leak' } });
  const ctx = await startServer({ apiKey: 'sk-x', upstream: upstream.base });
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 502);
    assert.equal(body.error?.code, 'upstream_error');
    assert.equal(typeof body.error?.message, 'string');
    assert.ok(!JSON.stringify(body).includes('raw blob'));
    // still serving: next health check succeeds
    const h = await fetch(`${ctx.base}/api/health`);
    assert.equal(h.status, 200);
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});

test('live: an unreachable upstream is a typed 502, not a crash', async () => {
  const gone = await startMockUpstream({ status: 200, body: {} });
  const deadUrl = gone.base;
  await gone.close();
  const ctx = await startServer({ apiKey: 'sk-x', upstream: deadUrl });
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 502);
    assert.equal(body.error?.code, 'upstream_error');
    const h = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(h.ok, true);
  } finally {
    await stopServer(ctx);
  }
});

// ---- no pathfinding in the live path ---------------------------------------
test('live: the stub BFS never runs when a key is present', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ apiKey: 'sk-x', upstream: `${upstream.base}/v1/systemone` });
  const hash = requestHash(SMALL_PAYLOAD);
  const recordedFile = path.join(RECORDED_DIR, `${hash}.live.json`);
  try {
    const { body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(body.mode, 'live');
    assert.equal(body._stub, undefined, 'live answers carry no _stub marker');
    assert.notDeepEqual(body.answers.reachable, { type: 'noul', noul: 0.99 });
  } finally {
    try { fs.rmSync(recordedFile, { force: true }); } catch { /* best-effort */ }
    await stopServer(ctx);
    await upstream.close();
  }
});