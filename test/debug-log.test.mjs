// test/debug-log.test.mjs — the debug log the operator asked for, and the
// promise that goes with it: it must be USEFUL (upstream status + body on a
// failure) and it must never contain the key.
//
// The log goes to stderr via console.error, so these tests capture it by
// swapping console.error for the duration of one request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintKey, redact } from '../server.mjs';
import { startServer, stopServer, postJev, SMALL_PAYLOAD, startMockUpstream } from './helpers.mjs';

/** Run `fn` with console.error captured; returns the captured lines. */
async function captureStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.error = real; }
  return lines;
}

const KEY = 'sk-live-supersecret-abcdef0123456789';

test('debug off (the default): no debug lines at all', async () => {
  const ctx = await startServer({});
  try {
    const lines = await captureStderr(async () => { await postJev(ctx.base, SMALL_PAYLOAD); });
    assert.deepEqual(lines.filter((l) => l.includes('[jev-debug]')), []);
  } finally { await stopServer(ctx); }
});

test('debug on: one line per request, with questions/hasKey/fingerprint but NEVER the key', async () => {
  const upstream = await startMockUpstream({ status: 200, body: { answers: { reachable: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10 } } });
  const ctx = await startServer({ debug: '1', upstream: `${upstream.base}/v1/systemone` });
  try {
    const lines = await captureStderr(async () => {
      await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': KEY } });
    });
    const dbg = lines.filter((l) => l.includes('[jev-debug]'));
    assert.equal(dbg.length, 1, 'exactly one line per request');

    const line = JSON.parse(dbg[0].replace('[jev-debug] ', ''));
    assert.equal(line.kind, 'jev');
    assert.match(line.rid, /^[0-9a-f]{8}$/, 'a short request id');
    assert.equal(line.questions, 4);
    assert.equal(line.hasKey, true);
    assert.equal(line.mode, 'live');
    assert.equal(line.ok, true);
    assert.ok(line.upMs >= 0, 'upstream duration recorded');
    assert.equal(line.keyFp, fingerprintKey(KEY), 'fingerprint identifies the key without revealing it');

    assert.ok(!dbg[0].includes(KEY), 'the key itself never appears');
    assert.ok(!dbg[0].includes('supersecret'), 'nor any part of it');
  } finally { await stopServer(ctx); await upstream.close(); }
});

test('debug on: a failed upstream logs the status and the raw body — the diagnosis the operator wanted', async () => {
  const upstream = await startMockUpstream({
    status: 401,
    body: { detail: { error_type: 'authentication_error', message: 'Cannot authenticate with the server. Please check your API key and try again.' } },
  });
  const ctx = await startServer({ debug: '1', upstream: `${upstream.base}/v1/systemone` });
  try {
    let res;
    const lines = await captureStderr(async () => {
      res = await postJev(ctx.base, SMALL_PAYLOAD, { headers: { 'x-jev-key': KEY } });
    });
    assert.equal(res.status, 502, 'the client still gets a clean typed error');
    assert.ok(!JSON.stringify(res.body).includes('Cannot authenticate'), 'the raw upstream body is not echoed to the client');

    const line = JSON.parse(lines.find((l) => l.includes('[jev-debug]')).replace('[jev-debug] ', ''));
    assert.equal(line.ok, false);
    assert.equal(line.code, 'upstream_error');
    assert.equal(line.upStatus, 401, 'the upstream status is logged');
    assert.match(line.upstream, /Cannot authenticate/, 'the upstream body is logged — this is the missing piece that made a 401 look like a bare 502');
    assert.ok(!lines.join('\n').includes(KEY), 'still no key in the log');
  } finally { await stopServer(ctx); await upstream.close(); }
});

test('redact: credentials are masked, and the fingerprint is not the key', () => {
  assert.equal(redact('Bearer sk-abcdefghijklmnop'), 'Bearer <redacted>');
  assert.ok(!redact('token sk-live-abcdefghijklmnop').includes('abcdefghijklmnop'));
  const fp = fingerprintKey('sk-live-supersecret-abcdef0123456789');
  assert.ok(fp.startsWith('sk-l'), 'first 4 chars kept');
  assert.ok(!fp.includes('supersecret'), 'the middle never survives');
  assert.equal(fingerprintKey(''), null);
});
