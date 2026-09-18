// scripts/verify-deployed.mjs — smoke-test a RUNNING deployment over HTTP.
//
// verify-browser.mjs proves the app works against a mock upstream it starts
// itself. This proves the thing actually served on a port is the same app: the
// page, the artwork, the drawn maze, and the no-auto-solve rule — checked in a
// real browser against the live URL.
//
//   node scripts/verify-deployed.mjs [url]      (default http://127.0.0.1/abhimanyu/)
// No npm deps: it drives Chromium over CDP using Node's global WebSocket.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeChakraBoard } from '../lib/chakra.js';
import { buildPolicyChakraState, chakraPathQuestions, PATH_ASK_MOVES } from '../lib/jev.js';

const URL_BASE = process.argv[2] || 'http://127.0.0.1/abhimanyu/';
const CHROME = process.env.CHROME_BIN
  || path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux/chrome');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method) {
        for (const h of (this.handlers.get(m.method) || [])) h(m.params);
        this.handlers.delete(m.method);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 25000);
      this.handlers.set(method, [...(this.handlers.get(method) || []),
        (p) => { clearTimeout(t); resolve(p); }]);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result?.value;
}

async function waitFor(cdp, expr, timeout = 25000) {
  const t0 = Date.now();
  for (;;) {
    const v = await evaluate(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting: ${expr}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

const main = async () => {
  console.log(`smoke-testing the deployment at ${URL_BASE}`);

  // ---- the HTTP surface first, without a browser -------------------------
  const page = await fetch(URL_BASE);
  check(page.status === 200, `GET ${URL_BASE} → 200`, `got ${page.status}`);
  const html = await page.text();
  check(/<title>Chakravyuha/.test(html), 'the served page is Chakravyuha');
  check(/abhimanyu\.jpg/.test(html), 'the page references the artwork');
  check(!/PathPuzzle|stub|replay/i.test(html), 'no stale PathPuzzle/stub/replay in the page');

  const health = await (await fetch(new URL('api/health', URL_BASE))).json();
  check(health.ok === true && health.mode === 'proxy', `health ok, mode=${health.mode}`);
  check(health.hasEnvKey === false, 'hasEnvKey is false (BYOK)', String(health.hasEnvKey));

  // Build the payload with the app's OWN builders, so this proves the real
  // request shape passes the server's validator (not just a hand-written stub).
  const board = makeChakraBoard('easy');
  const payload = {
    state: buildPolicyChakraState(board, {
      ring: board.src.ring, sector: board.src.sector,
      visited: [board.src], askMoves: PATH_ASK_MOVES,
    }),
    questions: chakraPathQuestions(board, {
      ring: board.src.ring, sector: board.src.sector, askMoves: PATH_ASK_MOVES,
    }),
  };

  const noKey = await fetch(new URL('api/jev', URL_BASE), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const noKeyBody = await noKey.json();
  check(noKey.status === 401 && noKeyBody.error?.code === 'no_key',
    'keyless POST /api/jev → 401 no_key', `${noKey.status} ${JSON.stringify(noKeyBody)}`);
  check(noKeyBody.answers === undefined, 'the refusal carries no answers');

  for (const asset of ['app.js', 'style.css', 'history.html', 'history.js', 'skins/chakravyuha.js', 'assets/abhimanyu.jpg']) {
    const r = await fetch(new URL(asset, URL_BASE));
    check(r.status === 200, `${asset} → 200`, String(r.status));
  }
  for (const secret of ['server.mjs', 'package.json', 'runs.jsonl', 'test/static.test.mjs']) {
    const r = await fetch(new URL(secret, URL_BASE));
    check(r.status === 404, `${secret} → 404 (not served)`, String(r.status));
  }

  // ---- then a real browser, to prove it actually renders ------------------
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-deployed-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const port = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => {
        const f = path.join(prof, 'DevToolsActivePort');
        if (fs.existsSync(f)) resolve(fs.readFileSync(f, 'utf8').split('\n')[0].trim());
        else if (Date.now() - t0 > 20000) reject(new Error('chrome did not open a debugging port'));
        else setTimeout(poll, 200);
      };
      poll();
    });
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: URL_BASE });
    await loaded;

    await waitFor(cdp, `document.readyState === 'complete' && !!window.__chakraLastRender`);
    const art = await evaluate(cdp, `(() => {
      const img = document.querySelector('.abhi-portrait');
      return { loaded: !!img && img.complete && img.naturalWidth > 0, w: img ? img.naturalWidth : 0 };
    })()`);
    check(art.loaded, `the artwork loads in the browser (${art.w}px)`);

    const idle = await evaluate(cdp, `(() => {
      const r = window.__chakraLastRender;
      return { verdict: r.verdict, atCentre: r.atCentre, steps: r.trailCells.length - 1, ring: r.pos.ring, rings: r.rings };
    })()`);
    check(!idle.verdict, 'nothing is solved on load');
    check(!idle.atCentre && idle.ring === idle.rings, 'the sprite starts on the outermost ring');
    check(idle.steps === 0, 'the trail is empty on load');

    const px = await evaluate(cdp, `(() => {
      const c = document.getElementById('board');
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const near = (i, t) => Math.abs(data[i]-t[0])<=26 && Math.abs(data[i+1]-t[1])<=26 && Math.abs(data[i+2]-t[2])<=26;
      const want = { token:[0xa7,0x8b,0xfa], target:[0x4a,0xde,0x80], warrior:[0xf8,0x71,0x71] };
      const n = { token:0, target:0, warrior:0 };
      for (let i = 0; i < data.length; i += 4) for (const [k,t] of Object.entries(want)) if (near(i,t)) n[k]++;
      return n;
    })()`);
    check(px.token > 50, `Abhimanyu is drawn (${px.token} px)`);
    check(px.target > 30, `the target icon is drawn (${px.target} px)`);
    check(px.warrior > 30, `warrior dots are drawn (${px.warrior} px)`);

    const overflow = await evaluate(cdp, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    check(overflow <= 1, `no horizontal overflow at 390×844 (${overflow}px)`);
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    fs.rmSync(prof, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} deployment check(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nthe deployment is serving the chakravyuha app correctly.');
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
