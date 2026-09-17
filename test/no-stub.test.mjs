// test/no-stub.test.mjs — the invariants that must not rot.
//
//   1. There is no stub solver and no replay mode anywhere. The app is LIVE-only:
//      a key, or a typed refusal. Nothing is ever answered from local code.
//   2. No pathfinding lives in the game loop. lib/referee.js is the ONLY place a
//      route may be computed, and only to check an answer.
//   3. POST /api/jev without a key is a 401 no_key — and it never fabricates an
//      answer, and never even contacts the upstream.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer, postJev, CH_PAYLOAD, startMockUpstream } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that ships to the browser or runs in the shim. */
function runtimeFiles() {
  const out = [];
  for (const f of ['server.mjs', 'app.js', 'history.js', 'index.html', 'history.html']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) out.push({ name: f, text: fs.readFileSync(p, 'utf8') });
  }
  for (const dir of ['lib', 'skins']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
      out.push({ name: `${dir}/${f}`, text: fs.readFileSync(path.join(d, f), 'utf8') });
    }
  }
  return out;
}

// ---- 1 · there is no stub and no replay ------------------------------------
test('no stub: the words "stub" and "replay" appear nowhere in the shipped code', () => {
  const offenders = [];
  for (const { name, text } of runtimeFiles()) {
    text.split('\n').forEach((line, i) => {
      if (/\bstub\b|\bstubbed\b|\breplay\b/i.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `stub/replay references must be gone:\n${offenders.join('\n')}`);
});

test('no stub: the stub solver, the replay mode and their env vars are gone', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.ok(!/stubAnswer/.test(server), 'stubAnswer() is deleted');
  assert.ok(!/TYPESAFE_REPLAY/.test(server), 'the replay env var is deleted');
  assert.ok(!/RECORDED_DIR|record-fixtures/.test(server), 'the fixture machinery is deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'fixtures', 'index.json')), 'the old fixtures are deleted');
});

test('no stub: no recorded fixtures or geo snapshots remain in the tree', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'fixtures', 'geo')), 'geo snapshots are gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'record-fixtures.mjs')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'record-geo-snapshots.mjs')));
});

// ---- 2 · no pathfinding in the loop ---------------------------------------
test('no solver: no search algorithm is implemented outside lib/referee.js', () => {
  const banned = /\bastar\b|\ba\s*\*\s*search\b|dijkstra|\bbfs\b|heuristic|priorityqueue|minheap/i;
  const offenders = [];
  for (const { name, text } of runtimeFiles()) {
    if (name === 'lib/referee.js') continue; // the one allowed place
    text.split('\n').forEach((line, i) => {
      if (banned.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `search code must live only in lib/referee.js:\n${offenders.join('\n')}`);
});

test('no solver: the game loop never asks the referee for a route', () => {
  const loop = ['app.js', 'history.js', 'skins/chakravyuha.js', 'server.mjs'];
  for (const name of loop) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(!/chakraShortest/.test(text), `${name} must not compute a shortest route`);
    assert.ok(!/chakraQuality/.test(text), `${name} must not run the generation quality check`);
  }
});

test('no solver: lib/chakra.js uses the referee only for generation sanity', () => {
  const chakra = fs.readFileSync(path.join(ROOT, 'lib', 'chakra.js'), 'utf8');
  assert.ok(!/chakraShortest/.test(chakra), 'generation never needs the shortest route itself');
  assert.ok(/chakraQuality/.test(chakra), 'but it does verify solvability');
});

test('no solver: the skin only ever verifies, via chakraVerdict', () => {
  const skin = fs.readFileSync(path.join(ROOT, 'skins', 'chakravyuha.js'), 'utf8');
  assert.ok(/chakraVerdict/.test(skin), 'the skin asks for a verdict after the run');
  assert.ok(!/chakraShortest/.test(skin), 'and never for the route up front');
});

// ---- 3 · no key means a refusal, never an answer --------------------------
let ctx;
let mock;
before(async () => {
  mock = await startMockUpstream({ status: 200, body: { answers: { move_inward: { type: 'noul', noul: 1 } } } });
  ctx = await startServer({ apiKey: '', upstream: mock.base });
});
after(async () => {
  await stopServer(ctx);
  await mock.close();
});

test('no key: POST /api/jev is a 401 no_key', async () => {
  const { status, body } = await postJev(ctx.base, CH_PAYLOAD);
  assert.equal(status, 401);
  assert.equal(body.error.code, 'no_key');
  assert.ok(/BYOK/i.test(body.error.message), 'the message tells the user what to do');
});

test('no key: the refusal carries no answers and no route', async () => {
  const { body } = await postJev(ctx.base, CH_PAYLOAD);
  assert.equal(body.answers, undefined, 'never fabricates answers');
  assert.equal(body.mode, undefined, 'and never claims a mode');
  assert.equal(body._stub, undefined);
  assert.ok(!/optimal|path|shortest/i.test(JSON.stringify(body)), 'no solution leaks in the error');
});

test('no key: the upstream is never even contacted', async () => {
  mock.server.lastRequest = undefined;
  await postJev(ctx.base, CH_PAYLOAD);
  assert.equal(mock.server.lastRequest, undefined, 'a keyless request must not reach TypeSafe');
});

test('health: reports whether the server holds an env key', async () => {
  const r = await fetch(`${ctx.base}/api/health`);
  const h = await r.json();
  assert.equal(h.ok, true);
  assert.equal(h.mode, 'proxy');
  assert.equal(h.hasEnvKey, false);
});

test('with a key: the request is proxied and the answer is live, not fabricated', async () => {
  const { status, body } = await postJev(ctx.base, CH_PAYLOAD, { headers: { 'x-jev-key': 'sk-test-123' } });
  assert.equal(status, 200);
  assert.equal(body.mode, 'live');
  assert.ok(body.answers, 'the upstream answers are passed through');
  assert.equal(body._stub, undefined, 'no stub marker can exist');
  const seen = mock.server.lastRequest;
  assert.ok(seen, 'the upstream was contacted');
  assert.equal(seen.auth, 'Bearer sk-test-123', 'the user key is forwarded as a bearer token');
});

test('with a key: the key never appears in the response body', async () => {
  const { body } = await postJev(ctx.base, CH_PAYLOAD, { headers: { 'x-jev-key': 'sk-secret-xyz' } });
  assert.ok(!/sk-secret-xyz/.test(JSON.stringify(body)), 'BYOK: the key never comes back out');
});
