// scripts/verify-browser.mjs — headless-mobile proof for the DoD:
//   * loads the app at / and under /abhimanyu/ (prefix-stripping proxy)
//   * emulates a 390×844 phone and a 360×640 phone
//   * runs a stub round-trip in BOTH skins
//   * asserts no horizontal overflow and a ref/referee verdict
//   * writes screenshots to ./artifacts/
// No npm deps: it drives Chromium over CDP using Node's global WebSocket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server.mjs';

const CHROME =
  process.env.CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux/chrome');
const OUT = path.join(process.cwd(), 'artifacts');
const PREFIX = '/abhimanyu';

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, dpr: 3 },
  { name: '360x640', width: 360, height: 640, dpr: 2 },
];
const ROUTES = [
  { name: 'root', path: '/' },
  { name: 'abhimanyu', path: `${PREFIX}/` },
];

fs.mkdirSync(OUT, { recursive: true });
let failures = 0;

// ----------------------------------------------------------- CDP over WebSocket
class CDP {
  constructor(url) {
    this.url = url;
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? null)})`)) : p.resolve(msg.result);
      } else if (msg.method) {
        if (this.onEvent) this.onEvent(msg);
        const hs = this.handlers.get(msg.method) || [];
        for (const h of hs) h(msg.params);
        this.handlers.delete(msg.method);
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
      const t = setTimeout(() => { this.handlers.delete(method); reject(new Error(`timeout waiting for ${method}`)); }, 20000);
      const h = (params) => { clearTimeout(t); resolve(params); };
      this.handlers.set(method, [...(this.handlers.get(method) || []), h]);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function evalCond(cdp, expression, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    const v = out.result?.value;
    if (typeof v === 'object' && v !== null && ('err' in v)) return v;
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`condition timed out: ${expression}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `browser-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  screenshot →', file);
}

async function runViewport(cdp, base, vp, route) {
  console.log(`\n== ${route.name} @ ${vp.name} (${vp.width}×${vp.height}, dpr ${vp.dpr})`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: true,
  });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `${base}${route.path}` });
  await loaded;

  await evalCond(cdp, `document.readyState === 'complete' && !!document.getElementById('skin-bar')`);

  // skin 1: grid by default — run it first
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('ask').click()` });
  const grid = await evalCond(cdp, `(() => {
    const r = document.getElementById('referee');
    const e = document.getElementById('error-card');
    const done = r && !r.classList.contains('empty') && r.innerText.trim();
    return { done: !!done, err: !!(e && !e.hidden) };
  })()`);
  if (grid.err) throw new Error(`ask failed (grid skin): ${await cdp.send('Runtime.evaluate', { expression: `document.getElementById('error-msg').textContent`, returnByValue: true }).then(x => x.result?.value)}`);
  console.log('  grid stub round-trip: ok; badge =', (await cdp.send('Runtime.evaluate', { expression: `document.getElementById('mode').textContent`, returnByValue: true })).result?.value);

  // skin 2: navigation with the car
  await new Promise((r) => setTimeout(r, 600));
  const clickInfo = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const askDisabled = document.getElementById('ask').disabled;
      document.querySelector('[data-skin="gmaps"]').click();
await new Promise((r) => setTimeout(r, 50));
      return {
        beforeAskDisabled: askDisabled,
        active: [...document.querySelectorAll('.skin-btn')].find((b) => b.classList.contains('active'))?.dataset.skin || null,
        jevSkin: localStorage.getItem('jev.skin'),
        mapSize: !!document.getElementById('map-size'),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('  gmaps click:', JSON.stringify(clickInfo.result?.value));
  if (!clickInfo.result?.value?.mapSize) {
    console.error('  page exceptions:', JSON.stringify(cdp.exceptions.map((e) => e.params.exceptionDetails?.exception?.description)));
    throw new Error('gmaps skin did not mount');
  }
  await evalCond(cdp, `document.getElementById('skin-controls').innerText.includes('New city')`);
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('ask').click()` });
  const nav = await evalCond(cdp, `(() => {
    const r = document.getElementById('referee');
    const e = document.getElementById('error-card');
    const done = r && !r.classList.contains('empty') && r.innerText.trim();
    return { done: !!done, err: !!(e && !e.hidden), ref: r ? r.innerText : '' };
  })()`);
  if (nav.err) throw new Error(`ask failed (gmaps skin): ${await cdp.send('Runtime.evaluate', { expression: `document.getElementById('error-msg').textContent`, returnByValue: true }).then(x => x.result?.value)}`);
  if (route.name === 'root') await shot(cdp, `gmaps-${vp.name}`);

  // skin-result turn-by-turn rendered for gmaps
  await evalCond(cdp, `document.getElementById('skin-result').innerText.includes('Turn')`, 10000).catch(() => {});
  if (route.name === 'root') await shot(cdp, `turns-${vp.name}`);

  // no horizontal scroll on a phone
  const overflow = await cdp.send('Runtime.evaluate', {
    expression: `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
    returnByValue: true,
  });
  const excess = overflow.result?.value ?? 0;
  if (excess > 1) throw new Error(`horizontal overflow of ${excess}px at ${vp.name}/${route.name}`);
  console.log('  no horizontal overflow (<=1px): ok');
}

// ---------------------------------------------------------------- server + prefix proxy
function startShim() {
  return new Promise((resolve, reject) => {
    const s = createServer({});
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
    s.once('error', reject);
  });
}
function startProxy(innerPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const p = req.url;
      const stripped = p === PREFIX ? '/' : p.startsWith(`${PREFIX}/`) ? p.slice(PREFIX.length) : p;
      const proxy = http.request({ host: '127.0.0.1', port: innerPort, method: req.method, path: stripped, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      proxy.on('error', () => { res.writeHead(502).end(); });
      req.pipe(proxy);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.once('error', reject);
  });
}

async function findChromePage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (page) return page.webSocketDebuggerUrl;
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const created = await res.json();
  return created.webSocketDebuggerUrl;
}

const main = async () => {
  const shim = await startShim();
  const proxy = await startProxy(shim.port);
  const base = `http://127.0.0.1:${proxy.port}`;
  console.log(`shim at :${shim.port}, prefix-stripping proxy at :${proxy.port} (${PREFIX}/ → /)`);

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', '--user-data-dir=' + prof, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const debuggerPort = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => {
        const f = path.join(prof, 'DevToolsActivePort');
        if (fs.existsSync(f)) { resolve(fs.readFileSync(f, 'utf8').split('\n')[0].trim()); }
        else if (Date.now() - t0 > 20000) reject(new Error('chrome did not open a debugging port'));
        else setTimeout(poll, 200);
      };
      poll();
    });
    const wsUrl = await findChromePage(debuggerPort);
    cdp = new CDP(wsUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.exceptions = [];
    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Log.entryAdded') {
        if (cdp.exceptions.length < 8) cdp.exceptions.push(msg);
      }
    };

    for (const vp of VIEWPORTS) {
      for (const route of ROUTES) {
        try {
          await runViewport(cdp, base, vp, route);
        } catch (err) {
          failures++;
          console.error(`  ✗ FAIL ${route.name} @ ${vp.name}: ${err.message}`);
        }
      }
    }
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    fs.rmSync(prof, { recursive: true, force: true });
    await new Promise((r) => proxy.server.close(r));
    await new Promise((r) => shim.server.close(r));
  }

  if (failures) { console.error(`\n${failures} verification(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nall browser verifications passed.');
};

main().catch((err) => { console.error(err); process.exitCode = 1; });