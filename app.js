// app.js — the Chakravyuha shell. One skin, one transport (the same-origin
// shim), BYOK, live-only. At each step Jev judges the legal next moves;
// the loop applies the strongest one and ANIMATES the hop.
//
// THE RULE: there is no pathfinding in this file, nor in lib/ (outside
// lib/chakra.js) or skins/. The maze is serialised into a `state`, typed
// questions are sent to Jev, and the directions Jev returns are applied
// verbatim — animated through lib/animator.js. lib/chakra.js is used only to
// CHECK the answer afterwards and to compute the shortest route for
// comparison, which is drawn only after the run ends.
//
// BYOK: the key is never logged, never put in a URL, never written to a file,
// and never exported. It lives in localStorage only if the user ticks
// "remember". Opening the page, changing difficulty or drawing a new maze
// never calls Jev and never reveals a route.

import {
  createTransport, deriveBase, loadSavedKey, rememberKey, forgetKey, memoryStorage,
} from './lib/transport.js';
import {
  askJev, runPolicyGame, buildPolicyBody,
  chakraPolicyQuestions, policyCells,
} from './lib/jev.js';
import { boardHash, computeStepAccuracy, optimalRoute, chakraPolicyState } from './lib/chakra.js';
import { chakraSkin } from './skins/chakravyuha.js';
import { APP_VERSION } from './lib/version.js';

const BASE = deriveBase(typeof location !== 'undefined' ? location.pathname : '/');
const storage = typeof localStorage !== 'undefined' ? localStorage : memoryStorage();
const transport = createTransport({ base: BASE, storage });

const DIFF_STORAGE = 'jev.difficulty';
const INSTANT_STORAGE = 'jev.instant';
const OBSTACLE_STORAGE = 'jev.obstacles';
const STEP_STORAGE = 'jev.step';

const currentSkin = chakraSkin;

const num = (s) => Number(s.slice(5));
const confPct = (c) => { const n = Number(c); return Number.isFinite(n) ? Math.round(n * 100) : 100; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state
let busy = false;
let lastRun = null;

// ------------------------------------------------------------- key handling
const keyField = $('key-field');
const rememberBox = $('remember-key');

function refreshKeyUI() {
  const stored = loadSavedKey(storage);
  rememberBox.checked = !!stored;
  if (stored && !keyField.value) keyField.value = stored;
}

function currentKey() {
  return keyField.value.trim();
}

function forget() {
  keyField.value = '';
  rememberBox.checked = false;
  forgetKey(storage);
  refreshKeyUI();
}

$('forget-key').addEventListener('click', forget);

// --------------------------------------------------------------- errors
function showErrorCard(code, message, hint) {
  $('error-code').textContent = code || 'error';
  $('error-msg').textContent = message;
  $('error-hint').textContent = hint || '';
  $('error-card').hidden = false;
}
function hideErrorCard() { $('error-card').hidden = true; }

// ------------------------------------------------------------- state -> ask
async function ask() {
  if (busy) return;
  const btn = $('ask');
  $('cancel').hidden = true;
  btn.disabled = true;
  busy = true;
  hideErrorCard();
  $('export-btn').disabled = true;

  const key = currentKey();
  if (key) {
    if (rememberBox.checked) rememberKey(storage, key);
    else forgetKey(storage);
  }

  let ok = false;
  try {
    ok = await askPolicy(key);
  } finally {
    btn.disabled = false;
    busy = false;
    $('cancel').hidden = true;
    // The step trace is live progress, not a result — the outcome card carries
    // the numbers. Return the chip to its idle state like every other mode.
    $('mode').textContent = 'ready';
  }
  if (!ok) $('export-btn').disabled = true;
}

async function askPolicy(key) {
  currentSkin.begin();
  const board = currentSkin.board;
  const stepMode = currentSkin.stepByStep === true;
  $('state-pre').textContent = JSON.stringify({
    loop: stepMode
      ? 'ask about the cell Abhimanyu stands on → follow that one move → ask again from there'
      : 'ask for the policy for every cell → follow it → re-ask only if the walk doubles back',
    obstacles: currentSkin.obstacles !== false ? 'on (warriors)' : 'off (pure wall maze)',
    cells: stepMode ? 1 : policyCells(board).length,
    sampleState: chakraPolicyState(board),
    sampleQuestions: (() => {
      const q = chakraPolicyQuestions(board);
      const id = `cell_${board.src.ring}_${board.src.sector}`;
      return { [id]: q[id] };
    })(),
  }, null, 2);

  const wall0 = performance.now();
  const game = await runPolicyGame({
    board, transport, model: 'jev-latest', key,
    mode: stepMode ? 'step' : 'policy',
    onStep: (h) => {
      // Step mode: the ask and the move alternate, so name the cell being asked
      // next — the run should read as "step 1, step 2, step 3", not as a blur.
      if (stepMode) {
        $('mode').textContent = `step ${h.step} · now at ring ${h.to.ring}, sector ${h.to.sector}`;
      }
      return currentSkin.animateHop(h);
    },
  });
  const elapsedMs = performance.now() - wall0;

  if (game.outcome === 'error') {
    const e = game.error || {};
    const hint = e.code === 'no_key'
      ? 'BYOK: paste your TypeSafe key in the keycard above, then press Ask Jev again.'
      : e.code === 'network'
        ? 'Check the server is running (the same-origin shim is required — api.typesafe.ai is CORS-blocked).'
        : 'The server said no — see the code above.';
    showErrorCard(e.code || 'error', e.message || 'request failed', hint);
    recordRun({ game, v: null, body: { mode: 'live' }, outcome: 'error', elapsedMs });
    return false;
  }

  const body = buildPolicyBody(game);
  body.mode = 'live';

  lastRun = { sent: { mode: 'policy', skin: currentSkin.id, game }, received: body };
  renderAnswers(body);
  // The run is over: only NOW may the shell look at the route.
  const routeFromSrc = optimalRoute(board, board.src, board.dst);
  const routeFromHere = optimalRoute(board, currentSkin.pos, board.dst);
  const v = currentSkin.check(game.moves, {
    optimal: routeFromSrc ? routeFromSrc.length : null,
    optimalPath: routeFromSrc ? routeFromSrc.path : null,
    optimalFromHere: routeFromHere ? routeFromHere.length : null,
  });
  // One honest measure of judgment: the fraction of steps that shortened the
  // distance to the centre by exactly one. Computed once, reused everywhere.
  game._stepAccuracy = (game.outcome === 'reached' || game.outcome === 'stuck')
    ? computeStepAccuracy(board, game.moves, board.src)
    : null;
  currentSkin.render();
  renderMeters(body, game, v, elapsedMs);
  setRunOutcome(game, v);
  recordRun({ game, v, body, elapsedMs });
  return true;
}

function renderAnswers(res) {
  const entries = Object.entries(res.answers || {});
  const moves = entries.filter(([k]) => k.startsWith('move_')).sort((a, b) => num(a[0]) - num(b[0]));
  const meta = entries.filter((k) => !k[0].startsWith('move_'));

  const row = (id, val, conf, low) => `
    <div class="ans ${low ? 'low' : ''}">
      <span class="id">${escapeHtml(id)}</span>
      <span class="val">${escapeHtml(String(val))}</span>
      <span class="conf">${conf}</span>
      <div class="bar"><i style="width:${confPct(conf)}%"></i></div>
    </div>`;

  let html = '';
  for (const [id, a] of meta) {
    html += row(id, String(a.choice ?? a.noul ?? a.score ?? '?'),
      a.confidence !== undefined ? a.confidence.toFixed(2) : 'prob', (a.confidence ?? 1) < 0.6);
  }
  const shown = moves.slice(0, 14);
  for (const [id, a] of shown) {
    const p = a.probabilities?.[a.choice];
    html += row(id, a.choice, p !== undefined ? p.toFixed(2) : '', (a.confidence ?? 1) < 0.6);
  }
  if (moves.length > shown.length) {
    html += `<div class="ans"><span class="id">…</span><span class="val">${moves.length - shown.length} more moves</span><span class="conf"></span></div>`;
  }
  const box = $('answers');
  box.classList.remove('empty');
  box.innerHTML = html || 'No typed answers came back.';
}

const fmt = (n, dp = 1) => (Number.isFinite(n) ? n.toFixed(dp) : '—');

function renderMeters(body, game, v, elapsedMs) {
  const steps = game.steps;
  const optimal = v ? v.optimal : null;
  const stepAccuracy = game._stepAccuracy ?? null;

  $('m-decision').textContent = `${game.lastMs ?? '?'} ms`;
  $('m-total').textContent = `${game.totalMs ?? '?'} ms`;
  $('m-calls').textContent = String(game.calls.length);
  $('m-cost').textContent = Number.isFinite(game.totalCostUsd) ? `$${game.totalCostUsd.toFixed(6)}` : '—';
  $('m-q').textContent = String(game.totalQuestions ?? '—');
  $('m-steps').textContent = optimal === null
    ? 'unreachable'
    : `${steps} / ${optimal}`;

  if (stepAccuracy !== null) {
    const correct = Math.round(stepAccuracy * steps);
    $('m-stepacc').textContent = `${stepAccuracy.toFixed(2)} (${correct}/${steps})`;
  } else {
    $('m-stepacc').textContent = '—';
  }

  const n = steps > 0 ? steps : null;
  $('m-msstep').textContent = n && Number.isFinite(game.totalMs) ? `${fmt(game.totalMs / n)} ms` : '—';
  $('m-qstep').textContent = n && Number.isFinite(game.totalQuestions) ? fmt(game.totalQuestions / n, 2) : '—';
  $('m-cstep').textContent = n ? fmt(game.calls.length / n, 2) : '—';
  // Parallel-policy calibration: how much of the policy Jev returned for every
  // cell the walk actually consumed. Whether those answers were the RIGHT ones
  // is the post-run step accuracy, measured after the run ends.
  const chainEl = $('m-chain');
  if (chainEl) {
    const ca = game.chainAgreement;
    chainEl.textContent = ca === null || ca === undefined
      ? '—'
      : `${game.chainApplied}/${game.chainAnswered} (${Math.round(ca * 100)}%)`;
  }
  $('m-tstep').textContent = n && Number.isFinite(game.totalTokensIn) && Number.isFinite(game.totalTokensOut)
    ? `${fmt(game.totalTokensIn / n, 0)} / ${fmt(game.totalTokensOut / n, 0)}`
    : '—';
  $('m-coststep').textContent = n && Number.isFinite(game.totalCostUsd) ? `$${(game.totalCostUsd / n).toFixed(6)}` : '—';
  $('m-elapsed').textContent = `${Math.round(elapsedMs)} ms`;
}

/** Honest outcome banner: reached / stuck / unparsed / exhausted / error. */
function setRunOutcome(game, v) {
  const el = $('run-outcome');
  if (!el || !game) { if (el) el.hidden = true; return; }
  el.hidden = false;
  el.classList.remove('reached', 'stuck', 'unparsed', 'illegal', 'revisited', 'exhausted', 'error');
  const calls = Array.isArray(game.calls) ? game.calls.length : 0;
  const rep = game.repairs ? ` · ${game.repairs} repair${game.repairs === 1 ? '' : 's'}` : '';
  const prefix = `${calls} call${calls === 1 ? '' : 's'}${rep}`;
  if (game.outcome === 'reached') {
    el.classList.add('reached');
    const optimalNote = v && v.optimal !== null ? ` · ${v.optimal} optimal` : '';
    el.textContent = `${prefix} · reached the centre${optimalNote} · ${game.steps} steps`;
  } else if (game.outcome === 'stuck') {
    el.classList.add('stuck');
    // Honest wording: running out of UNVISITED moves is not being trapped. The
    // centre is normally still reachable — the walk would just have to retrace,
    // which the fresh-only rule forbids.
    const why = game.reject === 'nowhere' ? 'no door opens from here' : 'no unvisited move left';
    const optLen = v && v.optimalFromHere !== null && v.optimalFromHere !== undefined
      ? `${why}; the centre was still ${v.optimalFromHere} moves away`
      : why;
    const correctSteps = Math.round((game._stepAccuracy || 0) * game.steps);
    el.textContent = `${prefix} · STUCK at step ${game.steps} · ${optLen} · ${correctSteps}/${game.steps} steps on a shortest route`;
  } else if (game.outcome === 'unparsed') {
    el.classList.add('unparsed');
    el.textContent = `${prefix} · UNREADABLE — Jev returned no usable move for ring ${currentSkin.pos?.ring ?? '?'}, sector ${currentSkin.pos?.sector ?? '?'}.`;
  } else if (game.outcome === 'revisited') {
    el.classList.add('illegal');
    const where = `ring ${currentSkin.pos?.ring ?? '?'}, sector ${currentSkin.pos?.sector ?? '?'}`;
    el.textContent = `${prefix} · DOUBLED BACK — the policy sent '${game.rejectDir}' from ${where}, onto a cell already walked, and the repair budget was spent.`;
  } else if (game.outcome === 'illegal') {
    el.classList.add('illegal');
    const where = `ring ${currentSkin.pos?.ring ?? '?'}, sector ${currentSkin.pos?.sector ?? '?'}`;
    el.textContent = `${prefix} · UNPLAYABLE — Jev answered '${game.rejectDir}' at ${where}, but no door opens that way.`;
  } else if (game.outcome === 'exhausted') {
    el.classList.add('exhausted');
    el.textContent = `${prefix} · EXHAUSTED — hit the ${game.maxSteps}-step cap without reaching the centre.`;
  } else {
    el.classList.add('error');
    el.textContent = `${prefix} · error — the run could not finish.`;
  }
}

// ------------------------------------------------------- run recording
function buildRunRecord({ game, v, body, mode, outcome, elapsedMs }) {
  const board = currentSkin.board;
  if (!board || !body) return null;
  // 'live-step' vs 'live' is the whole point of the toggle: the two must be
  // separable in runs.jsonl, or the comparison they exist to enable is lost.
  const runMode = game && game.mode === 'step' ? 'live-step' : 'live';
  const reached = v ? !!v.reached : (game ? !!game.reached : false);
  const optimal = v ? v.optimal : null;
  const steps = v ? v.steps : (game ? game.steps : 0);
  const stepAccuracy = game._stepAccuracy ?? null;
  const totalMs = game && Array.isArray(game.calls) && game.outcome !== 'error'
    ? game.totalMs
    : (body._ms ?? 0);
  const calls = game && Array.isArray(game.calls) ? game.calls.length : 1;
  const questions = game && Array.isArray(game.calls) ? game.totalQuestions : (body._questions ?? 0);
  const tokensIn = game ? game.totalTokensIn : (body.usage?.input_tokens ?? 0);
  const tokensOut = game ? game.totalTokensOut : (body.usage?.output_tokens ?? 0);
  const costUsd = game ? game.totalCostUsd : (body._cost_usd ?? 0);

  return {
    difficulty: board.difficulty || loadDifficulty(),
    mode: runMode,
    // Which build produced this run. The history outlives the code, so without
    // this a comparison across revisions silently becomes a comparison of
    // revisions — the one thing the toggle exists to rule out.
    build: APP_VERSION,
    outcome: outcome || (game ? game.outcome : (v ? (v.hitWall ? 'stuck' : v.reached ? 'reached' : 'stuck') : 'error')),
    steps,
    rings: board.R,
    sectors: board.S,
    boardHash: boardHash(board),
    optimalSteps: optimal,
    lastStepMs: game ? game.lastMs : (body._ms ?? 0),
    msPerStep: steps > 0 ? totalMs / steps : totalMs,
    calls,
    questions,
    tokensIn,
    tokensOut,
    totalMs,
    costUsd,
    stepAccuracy,
    correctSteps: stepAccuracy !== null ? Math.round(stepAccuracy * steps) : null,
    moves: game ? game.moves : [],
    elapsedMs,
    obstacles: currentSkin.obstacles !== false,
    pathCalls: game ? game.calls.length : 1,
    reject: game ? game.reject : null,
    rejectDir: game ? game.rejectDir : null,
    chainAnswered: game ? game.chainAnswered : null,
    chainApplied: game ? game.chainApplied : null,
    chainAgreement: game ? game.chainAgreement : null,
    cellsAsked: game ? game.cellsAsked : null,
    repairs: game ? game.repairs : null,
    mismatchCount: game ? game.mismatchCount : null,
    model: body.model || null,
  };
}

function recordRun(opts) {
  const record = buildRunRecord(opts);
  if (!record) return;
  fetch(`${BASE}api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record),
  }).then((r) => {
    if (!r.ok) console.warn(`run record not saved (HTTP ${r.status})`);
  }).catch((e) => {
    console.warn('run record not saved:', e && e.message ? e.message : e);
  });
}

function loadDifficulty() {
  try {
    const d = storage.getItem(DIFF_STORAGE);
    return ['easy', 'medium', 'hard'].includes(d) ? d : 'easy';
  } catch { return 'easy'; }
}

function loadInstant() {
  try { return storage.getItem(INSTANT_STORAGE) === '1'; } catch { return false; }
}

function loadObstacles() {
  try { return storage.getItem(OBSTACLE_STORAGE) !== 'off'; } catch { return true; }
}

function loadStepByStep() {
  try { return storage.getItem(STEP_STORAGE) === '1'; } catch { return false; }
}

// ------------------------------------------------------------------- boot
$('ask').addEventListener('click', ask);
$('export-btn').addEventListener('click', () => {
  if (!lastRun) return;
  const blob = new Blob([JSON.stringify(lastRun, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `chakravyuha-run-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('cancel').addEventListener('click', () => {
  currentSkin.animator?.cancel();
});

refreshKeyUI();
currentSkin.setInstant(loadInstant());
currentSkin.setStepByStep(loadStepByStep());
currentSkin.setDifficulty(loadDifficulty());
currentSkin.setObstacles(loadObstacles());
currentSkin.mount({ container: $('skin-controls') });
$('board-caption').innerHTML = currentSkin.caption();

fetch(`${BASE}api/health`).then((r) => r.json()).then((h) => {
  const note = $('key-note');
  if (h && h.ok) {
    note.textContent = h.hasEnvKey
      ? 'The server holds an env key, but BYOK still wins: the key you paste is used for your request.'
      : 'No key set anywhere yet — press Ask Jev without a key and the server answers 401 no_key (BYOK).';
    $('transport-chip').textContent = 'transport: proxy';
  }
}).catch(() => {
  $('key-note').textContent = 'Server unreachable — the page cannot reach Jev at all.';
  $('transport-chip').textContent = 'transport: proxy (down)';
});
