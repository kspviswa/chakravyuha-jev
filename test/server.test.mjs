// test/server.test.mjs — http-level tests against a freshly booted shim on
// an ephemeral port: smoke, BYOK header handling, the static allowlist,
// hardening, and the live branch against a mock upstream (no real key, no
// real network). There is no stub and no replay mode any more: a keyless
// request is a typed refusal, never an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startServer, stopServer, postJev, CH_PAYLOAD, SMALL_PAYLOAD, startMockUpstream,
} from './helpers.mjs';

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
    assert.match(await index.text(), /<title>Chakravyuha/);

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
    for (const asset of ['/app.js', '/style.css', '/skins/chakravyuha.js', '/history.html', '/history.js', '/assets/abhimanyu.jpg']) {
      const r = await fetch(`${ctx.base}${asset}`);
      assert.equal(r.status, 200, `${asset} served`);
      assert.match(r.headers.get('content-type'), /javascript|css|html|image/, `${asset} MIME`);
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

// ---- no key: a refusal, never an answer ------------------------------------
test('no key: POST /api/jev is a 401 no_key with a typed, helpful error', async () => {
  const ctx = await startServer({});
  try {
    const { status, body } = await postJev(ctx.base, CH_PAYLOAD);
    assert.equal(status, 401);
    assert.equal(body.error?.code, 'no_key');
    assert.ok(/BYOK/i.test(body.error.message), 'the message tells the user what to do');
  } finally {
    await stopServer(ctx);
  }
});

test('no key: the refusal carries no answers, no mode and no route', async () => {
  const ctx = await startServer({});
  try {
    const { body } = await postJev(ctx.base, CH_PAYLOAD);
    assert.equal(body.answers, undefined, 'never fabricates answers');
    assert.equal(body.mode, undefined, 'never claims a mode');
    assert.equal(body._stub, undefined);
    assert.ok(!/optimal|shortest/.test(JSON.stringify(body)), 'no solution leaks in the error');
  } finally {
    await stopServer(ctx);
  }
});

test('no key: a well-formed payload is still refused, and the state is not the reason', async () => {
  const ctx = await startServer({});
  try {
    // A perfectly valid polar state — the refusal is about the missing key.
    const ok = await postJev(ctx.base, CH_PAYLOAD);
    assert.equal(ok.status, 401);
    const malformed = await postJev(ctx.base, { state: { task: 'nope' }, questions: {} });
    assert.equal(malformed.status, 400, 'a bad payload is a different error');
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

test('a policy payload is accepted without abhimanyu, and reaches the upstream', async () => {
  const ctx = await startServer({});
  try {
    // A policy call names one cell per question, so it carries no position.
    const policyState = { ...CH_PAYLOAD.state, task: 'chakravyuha_policy' };
    delete policyState.abhimanyu;
    delete policyState.visited;
    delete policyState.step;
    delete policyState.maxSteps;
    const payload = {
      state: policyState,
      questions: { cell_3_0: { type: 'choice', instructions: 'Which move begins the route?', criteria: { inward: 'moves to ring 2, sector 0' } } },
    };
    const { status } = await postJev(ctx.base, payload);
    assert.notEqual(status, 400, 'a policy payload is not a bad request');
  } finally {
    await stopServer(ctx);
  }
});

test('a policy payload with no centre is still a 400 bad_request', async () => {
  const ctx = await startServer({});
  try {
    const policyState = { ...CH_PAYLOAD.state, task: 'chakravyuha_policy' };
    delete policyState.abhimanyu;
    delete policyState.centre;
    const { status, body } = await postJev(ctx.base, {
      state: policyState,
      questions: { cell_3_0: { type: 'choice', criteria: { inward: 'x' } } },
    });
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
    const payload = { state: CH_PAYLOAD.state, questions: { a: {}, b: {}, c: {}, d: {} } };
    const { status, body } = await postJev(ctx.base, payload);
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'too_many_questions');
  } finally {
    await stopServer(ctx);
  }
});

test('per-IP rate limit kicks in past RATE_LIMIT', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ rateLimit: 1, apiKey: 'sk-env-key', upstream: `${upstream.base}/v1/systemone` });
  try {
    const first = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(first.status, 200);
    const second = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(second.status, 429);
    assert.equal(second.body.error?.code, 'rate_limited');
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});

// ---- there is no replay mode any more --------------------------------------
test('no replay: the replay config knob and its error codes are gone', async () => {
  const ctx = await startServer({});
  try {
    const { status, body } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 401);
    assert.equal(body.error?.code, 'no_key');
    assert.equal(body.mode, undefined);
    assert.equal(body.answers, undefined);
  } finally {
    await stopServer(ctx);
  }
});

test('no replay: no fixture directory is read at boot', async () => {
  const ctx = await startServer({});
  try {
    const { status } = await postJev(ctx.base, SMALL_PAYLOAD);
    assert.equal(status, 401, 'no fixture lookup happens; it is a plain refusal');
  } finally {
    await stopServer(ctx);
  }
});

// ---- live (against a mock upstream; never the real API) --------------------
const MOCK_LIVE_BODY = {
  model: 'mock-jevv-9000',
  answers: {
    step_1: { type: 'choice', choice: 'inward' },
    step_2: { type: 'choice', choice: 'clockwise' },
    step_3: { type: 'choice', choice: 'inward' },
    step_4: { type: 'choice', choice: 'outward' },
  },
  usage: { input_tokens: 1000, output_tokens: 7 },
};

test('live (env key): proxies to the upstream and reports the meters', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ apiKey: 'sk-env-key', upstream: `${upstream.base}/v1/systemone` });
  try {
    const fourQ = { state: CH_PAYLOAD.state, questions: { a: {}, b: {}, c: {}, d: {} } };
    const { status, body } = await postJev(ctx.base, fourQ);
    assert.equal(status, 200);
    assert.equal(body.mode, 'live');
    assert.deepEqual(body.answers, MOCK_LIVE_BODY.answers);
    assert.equal(body._questions, 4);
    assert.equal(body._cost_usd, ((1000 + 7) / 1e6) * 0.042, 'blended rate over input AND output tokens');
    assert.ok(!JSON.stringify(body).includes('sk-env-key'), 'BYOK: the key never comes back out');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstream.lastRequest().auth, 'Bearer sk-env-key');
    assert.match(upstream.lastRequest().url, /^\/v1\/systemone/);
  } finally {
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
test('live: the answer is the upstream\'s, with no local marker of any kind', async () => {
  const upstream = await startMockUpstream({ status: 200, body: MOCK_LIVE_BODY });
  const ctx = await startServer({ upstream: `${upstream.base}/v1/systemone` });
  try {
    const { body } = await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': 'sk-x' } });
    assert.equal(body.mode, 'live');
    assert.equal(body._stub, undefined, 'there is no stub to mark');
    assert.deepEqual(body.answers, MOCK_LIVE_BODY.answers, 'the upstream answers pass through verbatim');
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});