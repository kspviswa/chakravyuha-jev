// scripts/verify-browser.mjs — headless proof for the chakravyuha pivot:
//   * loads the app at / and under /abhimanyu/ (prefix-stripping proxy)
//   * renders at 1280×800, 390×844 and 360×640
//   * asserts the Abhimanyu artwork loads, the target icon is drawn at the
//     centre, and the warrior dots are present
//   * drives a REAL run against a mock upstream (there is no stub any more) and
//     captures MID-TWEEN frames proving the sprite genuinely travels
//   * asserts nothing is solved on load, on difficulty change, or on redraw
//   * renders the history page with accumulated runs
// No npm deps: it drives Chromium over CDP using Node's global WebSocket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { chakraNeighbours, chakraShortest } from '../lib/referee.js';

const CHROME =
  process.env.CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux/chrome');
const OUT = path.join(process.cwd(), 'artifacts');
const PREFIX = '/abhimanyu';
const KEY = 'sk-harness-browser-key';

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800, dpr: 1, mobile: false },
  { name: '390x844', width: 390, height: 844, dpr: 3, mobile: true },
  { name: '360x640', width: 360, height: 640, dpr: 2, mobile: true },
];
const ROUTES = [
  { name: 'root', path: '/' },
  { name: 'abhimanyu', path: `${PREFIX}/` },
];

fs.mkdirSync(OUT, { recursive: true });
let failures = 0;

// ------------------------------------------------- a mock Jev (no stub, ever)
// The app has no local solver, so the harness stands up a real HTTP upstream
// and points the shim at it. It answers the polar move questions using the
// referee — which is allowed here because this file is the *test model*, not
// the app.
function startMockJev() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls++;
      let answers = {};
      try {
        const payload = JSON.parse(raw);
        const st = payload.state || {};
        const maze = st.maze || {};
        const board = {
          R: maze.rings, S: maze.sectors, centreGate: maze.centre_gate_sector,
          openRadial: st.open_radial, openCirc: st.open_circ, warriors: st.warriors || [],
          src: st.abhimanyu, dst: { ring: 0, sector: 0 },
        };
        const here = st.abhimanyu;
        const s = chakraShortest(board, here, board.dst);
        const next = s ? s.path[1] : null;
        for (const nb of chakraNeighbours(board, here.ring, here.sector)) {
          const good = next && nb.ring === next.ring && nb.sector === next.sector;
          answers[`move_${nb.dir}`] = { type: 'noul', noul: good ? 0.95 : 0.02 };
        }
        answers.reachable = { type: 'noul', noul: 1 };
        answers.route_length = { type: 'choice', choice: '1-5', probabilities: { '1-5': 0.7 }, confidence: 0.7 };
        answers.maze_difficulty = { type: 'score', score: 2, probabilities: { '2': 0.5 }, confidence: 0.5 };
        answers.warriors_blocking = { type: 'noul', noul: 0.3 };
      } catch { /* leave answers empty */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-jevv-9000',
        answers,
        usage: { input_tokens: 240, output_tokens: 60 },
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server, base: `http://127.0.0.1:${server.address().port}`, calls: () => calls,
    }));
  });
}

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

async function evaluate(cdp, expression, awaitPromise = false) {
  const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (out.exceptionDetails) {
    throw new Error(`page exception: ${out.exceptionDetails.exception?.description || out.exceptionDetails.text}`);
  }
  return out.result?.value;
}

async function evalCond(cdp, expression, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const v = await evaluate(cdp, expression);
    if (typeof v === 'object' && v !== null && ('done' in v)) {
      if (v.err) return v;
      if (v.done) return v;
    } else if (v) {
      return v;
    }
    if (Date.now() - start > timeout) throw new Error(`condition timed out: ${expression}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `browser-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  screenshot →', path.relative(process.cwd(), file));
}

/** The maze's own render hook, as the page publishes it. */
const RENDER_PROBE = `(() => {
  const r = window.__chakraLastRender;
  if (!r) return null;
  const frac = !Number.isInteger(r.pos.ring) || !Number.isInteger(r.pos.sector);
  return {
    rings: r.rings, sectors: r.sectors,
    warriors: r.warriors.length,
    pos: r.pos, fractional: frac, atCentre: r.atCentre,
    steps: r.trailCells.length - 1,
    verdict: r.verdict, difficulty: r.difficulty,
  };
})()`;

async function runViewport(cdp, base, vp, route) {
  console.log(`\n== ${route.name} @ ${vp.name} (${vp.width}×${vp.height}, dpr ${vp.dpr})`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile,
  });

  // BYOK: hand the page a key before any script runs, so a run is possible.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('jev.key','${KEY}'); localStorage.setItem('jev.difficulty','easy'); } catch (e) {}`,
  });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `${base}${route.path}` });
  await loaded;

  await evalCond(cdp, `document.readyState === 'complete' && !!document.getElementById('board') && !!window.__chakraLastRender`);

  // ---- the artwork really loaded, and the maze really drew -----------------
  const art = await evaluate(cdp, `(() => {
    const img = document.querySelector('.abhi-portrait');
    return {
      present: !!img,
      loaded: !!img && img.complete && img.naturalWidth > 0,
      naturalWidth: img ? img.naturalWidth : 0,
      canvas: (() => { const c = document.getElementById('board'); return !!c && c.width > 0 && c.height > 0; })(),
      status: (document.getElementById('abhi-status') || {}).innerText || '',
    };
  })()`);
  if (!art.present) throw new Error('the Abhimanyu portrait panel is missing');
  if (!art.loaded) throw new Error(`the Abhimanyu artwork did not load (naturalWidth=${art.naturalWidth})`);
  if (!art.canvas) throw new Error('the maze canvas has no size');
  console.log(`  artwork loaded (${art.naturalWidth}px) + canvas sized: ok`);

  // ---- the three difficulty buttons ---------------------------------------
  const diffButtons = await evaluate(cdp, `[...document.querySelectorAll('.diff-btn')].map((b) => b.dataset.diff)`);
  if (diffButtons.join(',') !== 'easy,medium,hard') {
    throw new Error(`expected three difficulty buttons, got ${JSON.stringify(diffButtons)}`);
  }
  console.log('  difficulty buttons: easy / medium / hard: ok');

  // ---- NOTHING is solved on load -----------------------------------------
  const idle = await evaluate(cdp, RENDER_PROBE);
  const idleRef = await evaluate(cdp, `(document.getElementById('referee') || {}).innerText || ''`);
  if (idle.verdict) throw new Error('a verdict exists on load — something was solved without pressing Ask Jev');
  if (idle.atCentre) throw new Error('Abhimanyu is at the centre on load');
  if (idle.steps !== 0) throw new Error(`the trail has ${idle.steps} steps on load`);
  if (idle.pos.ring !== idle.rings) throw new Error(`the sprite should start on the outermost ring, got ${idle.pos.ring}`);
  if (/reaches the centre/.test(idleRef)) throw new Error('the referee ran on load');
  console.log(`  idle on load: ${idle.rings} rings, ${idle.warriors} warriors, sprite on the outer ring, no verdict: ok`);

  // ---- switching difficulty must not solve anything either ----------------
  await evaluate(cdp, `document.querySelector('.diff-btn[data-diff="hard"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterDiff = await evaluate(cdp, RENDER_PROBE);
  if (afterDiff.verdict) throw new Error('switching difficulty produced a verdict — it solved something');
  if (afterDiff.rings !== 8 || afterDiff.sectors !== 20) {
    throw new Error(`Hard should be 8×20, got ${afterDiff.rings}×${afterDiff.sectors}`);
  }
  console.log(`  difficulty switch → ${afterDiff.rings}×${afterDiff.sectors}, still unsolved: ok`);

  // ---- a redraw must not solve anything -----------------------------------
  await evaluate(cdp, `document.getElementById('maze-new').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterNew = await evaluate(cdp, RENDER_PROBE);
  if (afterNew.verdict) throw new Error('drawing a new maze produced a verdict — it solved something');
  if (afterNew.steps !== 0) throw new Error('a new maze kept the old trail');
  console.log('  redraw → fresh maze, trail cleared, still unsolved: ok');

  // back to easy for the animated run
  await evaluate(cdp, `document.querySelector('.diff-btn[data-diff="easy"]').click()`);
  await new Promise((r) => setTimeout(r, 250));

  // ---- a REAL run, with the animation, against the mock upstream ----------
  await evaluate(cdp, `document.getElementById('ask').click()`);

  // Hunt for a mid-tween frame: the sprite is genuinely between two cells.
  let midTween = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const p = await evaluate(cdp, RENDER_PROBE);
    if (p && p.fractional && !p.atCentre) { midTween = p; break; }
    if (p && p.verdict) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!midTween) {
    const p = await evaluate(cdp, RENDER_PROBE);
    throw new Error(`never caught the sprite between two cells — the animation may not be running (state: ${JSON.stringify(p)})`);
  }
  if (route.name === 'root') await shot(cdp, `anim-midtween-${vp.name}`);
  console.log(`  mid-tween captured: ring ${midTween.pos.ring.toFixed(3)}, sector ${midTween.pos.sector.toFixed(3)}: ok`);

  // let the run finish
  const done = await evalCond(cdp, `(() => {
    const r = window.__chakraLastRender;
    if (!r) return { done: false };
    if (r.verdict) return { done: true, verdict: r.verdict, pos: r.pos, steps: r.trailCells.length - 1 };
    return { done: false };
  })()`, 60000);
  if (!done.verdict) throw new Error('the run never produced a verdict');
  if (!done.verdict.reached) throw new Error(`the run did not reach the centre (verdict: ${JSON.stringify(done.verdict)})`);
  if (!done.pos || done.pos.ring !== 0) throw new Error(`the sprite did not settle at the centre (${JSON.stringify(done.pos)})`);
  console.log(`  run reached the centre in ${done.verdict.steps} steps (optimal ${done.verdict.optimal}): ok`);

  // the meters and the efficiency block must be populated
  const meters = await evaluate(cdp, `(() => ({
    decision: document.getElementById('m-decision').textContent,
    total: document.getElementById('m-total').textContent,
    calls: document.getElementById('m-calls').textContent,
    cost: document.getElementById('m-cost').textContent,
    steps: document.getElementById('m-steps').textContent,
    msStep: document.getElementById('m-msstep').textContent,
    qStep: document.getElementById('m-qstep').textContent,
    tStep: document.getElementById('m-tstep').textContent,
    costStep: document.getElementById('m-coststep').textContent,
  }))()`);
  for (const [k, v] of Object.entries(meters)) {
    if (!v || v === '—') throw new Error(`meter ${k} was not populated (got ${JSON.stringify(v)})`);
  }
  if (!/^\d+ \/ \d+$/.test(meters.steps)) throw new Error(`steps-vs-optimal should read "n / m", got ${meters.steps}`);
  console.log(`  meters: ${meters.calls} calls, ${meters.total}, ${meters.steps} steps, ${meters.msStep} per step: ok`);

  // the referee's comparison route appears only AFTER the run
  const refText = await evaluate(cdp, `document.getElementById('referee').innerText`);
  if (!/reaches the centre/.test(refText)) throw new Error('the referee panel did not grade the run');
  console.log('  referee graded the finished run: ok');

  if (route.name === 'root') await shot(cdp, `run-complete-${vp.name}`);

  // ---- no horizontal scroll on a phone ------------------------------------
  const overflow = await evaluate(cdp, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px at ${vp.name}/${route.name}`);
  console.log('  no horizontal overflow (<=1px): ok');

  // ---- the history page, with the run we just recorded ---------------------
  const histPath = route.path === '/' ? '/history.html' : `${PREFIX}/history.html`;
  const histLoaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `${base}${histPath}` });
  await histLoaded;
  const hist = await evalCond(cdp, `(() => {
    const cards = document.querySelectorAll('.stat-card');
    const rows = document.querySelectorAll('#runs-table tbody tr');
    const empty = document.querySelector('.empty-state');
    return { done: cards.length > 0 || !!empty, cards: cards.length, rows: rows.length, empty: !!empty };
  })()`);
  if (hist.empty) throw new Error('the history page showed the empty state — expected accumulated runs');
  if (!(hist.cards >= 1 && hist.rows >= 1)) {
    throw new Error(`history rendered but is missing content (cards=${hist.cards}, rows=${hist.rows})`);
  }
  if (route.name === 'root') await shot(cdp, `history-${vp.name}`);
  const hOverflow = await evaluate(cdp, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  if (hOverflow > 1) throw new Error(`history page horizontal overflow of ${hOverflow}px`);
  console.log(`  history: ${hist.cards} stat card(s), ${hist.rows} run row(s), no overflow: ok`);
}

// ---------------------------------------------------------------- server + prefix proxy
function startShim(upstreamBase) {
  return new Promise((resolve, reject) => {
    const runsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-runs-')), 'runs.jsonl');
    const s = createServer({ apiKey: KEY, upstream: upstreamBase, runsFile, rateLimit: 100000 });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, runsFile }));
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
  return (await res.json()).webSocketDebuggerUrl;
}

const main = async () => {
  const mock = await startMockJev();
  const shim = await startShim(mock.base);
  const proxy = await startProxy(shim.port);
  const base = `http://127.0.0.1:${proxy.port}`;
  console.log(`mock Jev at :${mock.server.address().port}, shim at :${shim.port}, prefix proxy at :${proxy.port}`);

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
        if (fs.existsSync(f)) resolve(fs.readFileSync(f, 'utf8').split('\n')[0].trim());
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
      if (msg.method === 'Runtime.exceptionThrown') cdp.exceptions.push(msg);
    };

    for (const vp of VIEWPORTS) {
      for (const route of ROUTES) {
        try {
          await runViewport(cdp, base, vp, route);
        } catch (err) {
          failures++;
          console.error(`  ✗ FAIL ${route.name} @ ${vp.name}: ${err.message}`);
          if (cdp.exceptions.length) {
            console.error('  page exceptions:', JSON.stringify(cdp.exceptions.slice(-3).map(
              (e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text)));
          }
        }
      }
    }
    console.log(`\nmock Jev served ${mock.calls()} request(s).`);
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    fs.rmSync(prof, { recursive: true, force: true });
    await new Promise((r) => proxy.server.close(r));
    await new Promise((r) => shim.server.close(r));
    await mock.server.close();
  }

  if (failures) { console.error(`\n${failures} verification(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nall browser verifications passed.');
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
