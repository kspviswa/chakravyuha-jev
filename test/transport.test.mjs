// test/transport.test.mjs — the browser transport + BYOK store, exercised
// under Node with an injected storage and fetch (no DOM, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTransport, memoryStorage, loadSavedKey, rememberKey, forgetKey,
  deriveBase, KEY_STORAGE, TRANSPORT_STORAGE, UPSTREAM,
} from '../lib/transport.js';

// ---- deriveBase: base-path awareness ---------------------------------------
test('deriveBase: root, subpath, and index.html are all handled', () => {
  assert.equal(deriveBase('/'), '/');
  assert.equal(deriveBase('/index.html'), '/');
  assert.equal(deriveBase('/abhimanyu/'), '/abhimanyu/');
  assert.equal(deriveBase('/abhimanyu/index.html'), '/abhimanyu/');
  assert.equal(deriveBase('/abhimanyu/some/deep/path'), '/abhimanyu/some/deep/');
});

// ---- key store --------------------------------------------------------------
test('BYOK store: remember/forget round-trip through an injected storage', () => {
  const s = memoryStorage();
  assert.equal(loadSavedKey(s), '');
  rememberKey(s, '  sk-hunter2  ');
  assert.equal(loadSavedKey(s), 'sk-hunter2');
  forgetKey(s);
  assert.equal(loadSavedKey(s), '');
  assert.equal(s.getItem(KEY_STORAGE), null);
});

test('BYOK store: transport choice persists and defaults to proxy', () => {
  const s = memoryStorage();
  assert.equal(s.getItem(TRANSPORT_STORAGE), null);
  const t = createTransport({ storage: s, fetchImpl: () => { throw new Error('no net'); } });
  assert.equal(t.mode, 'proxy');
  t.setMode('direct');
  assert.equal(t.mode, 'direct');
  // a fresh transport reads the persisted choice
  const t2 = createTransport({ storage: s, fetchImpl: () => { throw new Error('no net'); } });
  assert.equal(t2.mode, 'direct');
});

// ---- proxy transport ---------------------------------------------------------
function mockFetch(records) {
  return async (url, init) => {
    records.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: {}, mode: 'stub' }),
    };
  };
}

test('proxy transport: posts to <BASE>api/jev with x-jev-key', async () => {
  const records = [];
  const t = createTransport({ base: '/abhimanyu/', storage: memoryStorage(), fetchImpl: mockFetch(records) });
  const res = await t.ask({ state: { grid: ['SD'] }, questions: { reachable: {} }, key: 'sk-browser-key' });
  assert.equal(res.ok, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].url, '/abhimanyu/api/jev');
  assert.equal(records[0].init.headers['x-jev-key'], 'sk-browser-key');
  assert.equal(records[0].init.method, 'POST');
  const body = JSON.parse(records[0].init.body);
  assert.deepEqual(body.state, { grid: ['SD'] });
});

test('proxy transport at root: url is /api/jev and no key header when empty', async () => {
  const records = [];
  const t = createTransport({ base: '/', storage: memoryStorage(), fetchImpl: mockFetch(records) });
  await t.ask({ state: {}, questions: {}, key: '' });
  assert.equal(records[0].url, '/api/jev');
  assert.equal(records[0].init.headers['x-jev-key'], undefined);
});

test('direct transport: posts to the TypeSafe endpoint with Bearer', async () => {
  const records = [];
  const t = createTransport({ base: '/', storage: memoryStorage(), fetchImpl: mockFetch(records) });
  t.setMode('direct');
  await t.ask({ state: {}, questions: {}, key: 'sk-direct-key' });
  assert.equal(records[0].url, UPSTREAM);
  assert.equal(records[0].init.headers.authorization, 'Bearer sk-direct-key');
});

test('a non-2xx proxy response surfaces a typed error, body intact', async () => {
  const t = createTransport({
    base: '/', storage: memoryStorage(),
    fetchImpl: async () => ({
      ok: false, status: 502,
      json: async () => ({ error: { code: 'upstream_error', message: 'nope' } }),
    }),
  });
  const res = await t.ask({ state: {}, questions: {}, key: '' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.equal(res.error.code, 'upstream_error');
});

test('a fetch-level failure (CORS/offline) is a clean network error, with a direct-mode hint', async () => {
  const t = createTransport({
    base: '/', storage: memoryStorage(),
    fetchImpl: () => { throw new TypeError('Failed to fetch'); },
  });
  const prox = await t.ask({ state: {}, questions: {} });
  assert.equal(prox.ok, false);
  assert.equal(prox.error.code, 'network');
  assert.doesNotMatch(prox.error.message, /Bearer|key/i, 'network error must not mention any key handling');

  t.setMode('direct');
  const direct = await t.ask({ state: {}, questions: {}, key: 'sk-x' });
  assert.equal(direct.ok, false);
  assert.match(direct.error.message, /CORS/i, 'direct failures explain the CORS block');
});