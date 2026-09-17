// test/subpath.test.mjs — the app must serve correctly under a hub subpath
// (`/abhimanyu/`) AND at `/`. nginx strips the prefix before hitting the
// shim, so we simulate exactly that: a tiny prefix-stripping reverse proxy
// in front of the real server, then assert the classic routes all work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, stopServer, SMALL_PAYLOAD, startMockUpstream } from './helpers.mjs';

const PREFIX = '/abhimanyu';

/** forward every request to the inner server; strip PREFIX when present. */
function startPrefixedProxy(inner) {
  const server = http.createServer((req, res) => {
    const p = req.url;
    const stripped = p === PREFIX ? '/' : p.startsWith(`${PREFIX}/`) ? p.slice(PREFIX.length) : p;
    const proxy = http.request({
      host: '127.0.0.1',
      port: inner.address().port,
      method: req.method,
      path: stripped,
      headers: req.headers,
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502).end(); });
    req.pipe(proxy);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function withPrefixed(t, fn) {
  const inner = await startServer({});
  const outer = await startPrefixedProxy(inner.server);
  const base = `http://127.0.0.1:${outer.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => outer.server.close(r));
    await stopServer(inner);
  }
}

test('subpath: the game page and every asset exist under /abhimanyu/', async () => {
  await withPrefixed(null, async (base) => {
    const index = await fetch(`${base}/abhimanyu/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /<title>PathPuzzle/);

    for (const asset of ['/abhimanyu/app.js', '/abhimanyu/style.css', '/abhimanyu/lib/referee.js', '/abhimanyu/skins/gmaps.js']) {
      const r = await fetch(`${base}${asset}`);
      assert.equal(r.status, 200, asset);
    }
  });
});

test('subpath: /abhimanyu/api/health reports the shim up', async () => {
  await withPrefixed(null, async (base) => {
    const h = await (await fetch(`${base}/abhimanyu/api/health`)).json();
    assert.deepEqual(h, { ok: true, mode: 'proxy', hasEnvKey: false });
  });
});

test('subpath: a stub round-trip answers through the prefixed /api/jev', async () => {
  await withPrefixed(null, async (base) => {
    const r = await fetch(`${base}/abhimanyu/api/jev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SMALL_PAYLOAD),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.mode, 'stub');
    assert.deepEqual(Object.keys(body.answers).sort(), Object.keys(SMALL_PAYLOAD.questions).sort());
  });
});

test('subpath: a BYOK key crosses the prefix and drives live against the mock', async () => {
  const upstream = await startMockUpstream({ status: 200, body: { answers: {}, usage: { input_tokens: 1 } } });
  try {
    const innerBase = await new Promise((resolve) => {
      // boot a live-capable inner server pointing at the mock
      return (async () => {
        const inner = await startServer({ upstream: `${upstream.base}/v1/systemone` });
        resolve(inner);
      })();
    });
    const outer = await startPrefixedProxy(innerBase.server);
    const base = `http://127.0.0.1:${outer.port}`;
    try {
      const r = await fetch(`${base}/abhimanyu/api/jev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jev-key': 'sk-subpath-key' },
        body: JSON.stringify(SMALL_PAYLOAD),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.mode, 'live');
      await new Promise((r2) => setTimeout(r2, 50));
      assert.equal(upstream.lastRequest().auth, 'Bearer sk-subpath-key');
    } finally {
      await new Promise((r) => outer.server.close(r));
      await stopServer(innerBase);
    }
  } finally {
    await upstream.close();
  }
});

test('subpath: secrets stay unservable under the prefix too', async () => {
  await withPrefixed(null, async (base) => {
    for (const secret of ['/abhimanyu/server.mjs', '/abhimanyu/package.json', '/abhimanyu/.git/config', '/abhimanyu/test/helpers.mjs']) {
      const r = await fetch(`${base}${secret}`);
      assert.equal(r.status, 404, secret);
    }
  });
});

test('subpath: the unprefixed root still works through the same proxy', async () => {
  await withPrefixed(null, async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.ok, true);
  });
});