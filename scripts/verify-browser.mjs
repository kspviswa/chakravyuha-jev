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
import { makeChakraBoard } from '../lib/chakra.js';
import { buildPolicyChakraState, chakraPathQuestions, legalCandidates, PATH_ASK_MOVES } from '../lib/jev.js';
import { shortest } from '../lib/chakra.js';

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
// and points the shim at it. It answers the WHOLE chain — move_1 … move_K — in
// one response, the way the real parallel fan-out does, by walking the quickest
// route — which is allowed here because this file is the *test model*, not the
// app. The app itself never searches.
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
        const asked = Object.keys(payload.questions || {}).length || 1;
        let here = { ...st.abhimanyu };
        const visitedSet = new Set((st.visited || []).map((v) => `${v.ring},${v.sector}`));
        for (let k = 1; k <= asked; k++) {
          if (here.ring === 0 && here.sector === 0) break;
          const fresh = legalCandidates(board, here.ring, here.sector)
            .filter((c) => !visitedSet.has(`${c.ring},${c.sector}`));
          if (fresh.length === 0) break;
          // NB: shortest() returns path cells as { ring, sector } with NO `dir`
          // field — the direction must be read back off the fresh candidate
          // that lands on that cell. (Reading `next.dir` directly yields
          // undefined, which the app then honestly reports as UNPARSED.)
          const s = shortest(board, here, board.dst);
          const next = s ? s.path[1] : null;
          const chosen = next
            ? fresh.find((c) => c.ring === next.ring && c.sector === next.sector)
            : null;
          const pick = chosen ?? fresh[0];
          if (!pick) break;
          answers[`move_${k}`] = {
            type: 'choice', choice: pick.dir,
            probabilities: { [pick.dir]: 0.95 },
            confidence: 0.95,
          };
          here = { ring: pick.ring, sector: pick.sector };
          visitedSet.add(`${here.ring},${here.sector}`);
        }
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

/**
 * Read the canvas back and count pixels of the app's palette. This proves the
 * maze is *drawn*, not merely that some state variable moved — the difference
 * between "the model updated" and "the user can see Abhimanyu".
 */
const PIXEL_PROBE = `(() => {
  const c = document.getElementById('board');
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  const want = {
    token:  [0xa7, 0x8b, 0xfa],  // Abhimanyu
    target: [0x4a, 0xde, 0x80],  // the goal icon
    warrior:[0xf8, 0x71, 0x71],  // warrior dots
    trail:  [0x38, 0xbd, 0xf8],  // the trail ribbon
    crown:  [0xfb, 0xbf, 0x24],  // the crown badge
  };
  const counts = { token: 0, target: 0, warrior: 0, trail: 0, crown: 0, nonBg: 0 };
  const near = (i, c3, tol) => Math.abs(data[i] - c3[0]) <= tol
    && Math.abs(data[i + 1] - c3[1]) <= tol
    && Math.abs(data[i + 2] - c3[2]) <= tol;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (Math.abs(r - 0x0e) > 12 || Math.abs(g - 0x11) > 12 || Math.abs(b - 0x18) > 12) counts.nonBg++;
    for (const [k, c3] of Object.entries(want)) if (near(i, c3, 26)) counts[k]++;
  }
  // Where is the token centroid? It must sit inside the maze, not in a corner.
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (near(i, want.token, 26)) { sx += x; sy += y; n++; }
    }
  }
  return { ...counts, width, height, tokenCentroid: n ? { x: sx / n, y: sy / n, n } : null };
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
  const idleOutcome = await evaluate(cdp, `(() => { const el = document.getElementById('run-outcome'); return el && !el.hidden ? el.innerText : ''; })()`);
  if (idle.verdict) throw new Error('a verdict exists on load — something was solved without pressing Ask Jev');
  if (idle.atCentre) throw new Error('Abhimanyu is at the centre on load');
  if (idle.steps !== 0) throw new Error(`the trail has ${idle.steps} steps on load`);
  if (idle.pos.ring !== idle.rings) throw new Error(`the sprite should start on the outermost ring, got ${idle.pos.ring}`);
  if (idleOutcome) throw new Error(`the outcome banner is showing on load: ${JSON.stringify(idleOutcome)}`);
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

  // ---- the obstacle toggle: warriors off is a pure wall maze --------------
  const withWarriors = await evaluate(cdp, `(() => { const r = window.__chakraLastRender; return r ? r.warriors.length : null; })()`);
  if (!(withWarriors > 0)) throw new Error(`obstacles on should draw warriors, got ${withWarriors}`);
  await evaluate(cdp, `(() => { const b = document.getElementById('maze-warriors'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const noWarriors = await evaluate(cdp, `(() => { const r = window.__chakraLastRender; return r ? r.warriors.length : null; })()`);
  if (noWarriors !== 0) throw new Error(`obstacles off must leave no warrior cells, got ${noWarriors}`);
  const offState = await evaluate(cdp, `(() => { const r = window.__chakraLastRender; return r ? { verdict: r.verdict, steps: r.trailCells.length - 1 } : null; })()`);
  if (offState.verdict) throw new Error('toggling obstacles solved something');
  if (offState.steps !== 0) throw new Error('toggling obstacles kept the old trail');
  console.log(`  obstacles toggle: ${withWarriors} warriors on → 0 off, still unsolved: ok`);
  // back on, so the run below is the real game
  await evaluate(cdp, `(() => { const b = document.getElementById('maze-warriors'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const backOn = await evaluate(cdp, `(() => { const r = window.__chakraLastRender; return r ? r.warriors.length : null; })()`);
  if (!(backOn > 0)) throw new Error(`obstacles back on should draw warriors, got ${backOn}`);

  // back to easy for the animated run
  await evaluate(cdp, `document.querySelector('.diff-btn[data-diff="easy"]').click()`);
  await new Promise((r) => setTimeout(r, 250));

  // ---- a REAL run, with the animation, against the mock upstream ----------
  await evaluate(cdp, `document.getElementById('ask').click()`);

  // Hunt for a mid-tween frame: the sprite is genuinely between two cells.
  let midTween = null;
  let teleported = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const p = await evaluate(cdp, `(() => {
      const r = window.__chakraLastRender;
      if (!r) return null;
      return { ...r, frac: !Number.isInteger(r.pos.ring) || !Number.isInteger(r.pos.sector) };
    })()`);
    if (p) {
      // THE INVARIANT: he can only be at the goal if he WALKED there — the last
      // cell of his trail must be the centre. A sprite that appears at the goal
      // before the trail reaches it has been teleported by a leaked route.
      if (p.atCentre) {
        const last = p.trailCells[p.trailCells.length - 1];
        if (!last || last.ring !== 0 || last.sector !== 0) teleported = true;
      }
      if (p.frac && !p.atCentre && !midTween) midTween = p;
    }
    if (p && p.verdict) break;
    if (midTween) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (teleported) throw new Error('the sprite appeared at the goal without walking there — a route leaked into the render');
  if (!midTween) {
    const p = await evaluate(cdp, RENDER_PROBE);
    throw new Error(`never caught the sprite between two cells — the animation may not be running (state: ${JSON.stringify(p)})`);
  }
  if (route.name === 'root') await shot(cdp, `anim-midtween-${vp.name}`);
  console.log(`  mid-tween captured: ring ${midTween.pos.ring.toFixed(3)}, sector ${midTween.pos.sector.toFixed(3)}: ok`);

  // ---- the pixels prove it: Abhimanyu, the target, warriors, the crown -----
  const px = await evaluate(cdp, PIXEL_PROBE);
  if (!(px.token > 80)) throw new Error(`Abhimanyu is not drawn (${px.token} token pixels)`);
  if (!(px.target > 30)) throw new Error(`the target icon is not drawn at the centre (${px.target} px)`);
  if (!(px.warrior > 30)) throw new Error(`the warrior dots are not drawn (${px.warrior} px)`);
  if (!(px.crown > 8)) throw new Error(`Abhimanyu's crown badge is missing (${px.crown} px)`);
  if (!px.tokenCentroid) throw new Error('no token centroid — the sprite has no visible pixels');
  // Abhimanyu starts on (and mostly walks) the OUTER rings, so he is expected
  // to sit well away from the centre. What must hold is that he is inside the
  // drawn maze: on-canvas, and no further out than the outer ring plus his own
  // radius (the outer ring centre sits at 0.875 × the half-width for R=4).
  const cx = px.tokenCentroid.x, cy = px.tokenCentroid.y;
  const mid = px.width / 2;
  const dist = Math.hypot(cx - mid, cy - mid);
  if (dist > mid) {
    throw new Error(`the sprite is outside the maze disc (centroid ${cx.toFixed(0)},${cy.toFixed(0)} `
      + `= ${dist.toFixed(0)}px from centre, half-width ${mid.toFixed(0)})`);
  }
  const margin = px.width * 0.02;
  if (cx < margin || cy < margin || cx > px.width - margin || cy > px.height - margin) {
    throw new Error(`the sprite is against/over the canvas edge (${cx.toFixed(0)},${cy.toFixed(0)})`);
  }
  console.log(`  pixels: ${px.token} sprite · ${px.target} target · ${px.warrior} warrior · ${px.crown} crown; `
    + `centroid ${cx.toFixed(0)},${cy.toFixed(0)} (${(dist / mid).toFixed(2)} of half-width): ok`);

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

  // the outcome banner and the step-accuracy meter appear only AFTER the run
  const banner = await evaluate(cdp, `(() => { const el = document.getElementById('run-outcome'); return el && !el.hidden ? el.innerText : ''; })()`);
  if (!/reached the centre/.test(banner)) throw new Error(`the outcome banner did not report the finish (got ${JSON.stringify(banner)})`);
  const stepAcc = await evaluate(cdp, `document.getElementById('m-stepacc').textContent`);
  if (!/\d\.\d\d \(\d+\/\d+\)/.test(stepAcc)) throw new Error(`the step-accuracy meter was not populated (got ${JSON.stringify(stepAcc)})`);
  console.log(`  outcome banner graded the run (${banner.replace(/\s+/g, ' ').slice(0, 70)}), step accuracy ${stepAcc}: ok`);

  if (route.name === 'root') await shot(cdp, `anim-settled-${vp.name}`);

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
    const cum = document.querySelectorAll('#cum-grid .cum-tile');
    const note = document.getElementById('cum-note');
    return {
      done: (cards.length > 0 && cum.length > 0) || !!empty,
      cards: cards.length, rows: rows.length, empty: !!empty,
      cumTiles: cum.length, note: note ? note.textContent : '',
      cumText: document.getElementById('cum-grid') ? document.getElementById('cum-grid').innerText : '',
    };
  })()`);
  if (hist.empty) throw new Error('the history page showed the empty state — expected accumulated runs');
  if (!(hist.cards >= 1 && hist.rows >= 1)) {
    throw new Error(`history rendered but is missing content (cards=${hist.cards}, rows=${hist.rows})`);
  }
  // §9: the cumulative footer — totals including total tokens and $ spent, plus
  // mean ± sample stddev.
  if (!(hist.cumTiles >= 10)) throw new Error(`the cumulative footer is missing tiles (${hist.cumTiles})`);
  for (const want of ['total spent', 'total tokens', 'ms / step', 'questions / step', 'step accuracy']) {
    if (!hist.cumText.toLowerCase().includes(want)) {
      throw new Error(`the cumulative footer is missing "${want}" (got: ${hist.cumText.replace(/\n/g, ' | ')})`);
    }
  }
  if (!/\$\d/.test(hist.cumText)) throw new Error('the cumulative footer shows no dollar total');
  if (route.name === 'root') await shot(cdp, `history-${vp.name}`);
  const hOverflow = await evaluate(cdp, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  if (hOverflow > 1) throw new Error(`history page horizontal overflow of ${hOverflow}px`);
  console.log(`  history: ${hist.cards} stat card(s), ${hist.rows} run row(s), ${hist.cumTiles} cumulative tile(s), no overflow: ok`);
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
