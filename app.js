// app.js — the Chakravyuha shell. One skin, one transport (the same-origin
// shim), BYOK, live-only. Two question modes:
//   policy (default)  ask → apply → ask: at each step Jev judges the legal
//                     next moves; the loop applies its argmax and ANIMATES the hop
//   plan              one global ask ("move k of the route"), kept for
//                     comparison and animated hop by hop afterwards
//
// THE RULE: there is no pathfinding in this file, nor in lib/ (outside
// lib/referee.js) or skins/. The maze is serialised into a `state`, typed
// questions are sent to Jev, and the directions Jev returns are applied
// verbatim — animated through lib/animator.js. lib/referee.js is used only to
// CHECK the answer afterwards; its comparison route is drawn only once a run
// has finished, and labelled "referee's".
//
// BYOK: the key is never logged, never put in a URL, never written to a file,
// and never exported. It lives in localStorage only if the user ticks
// "remember". Opening the page, changing difficulty or drawing a new maze
// never calls Jev and never reveals a route.

import {
  createTransport, deriveBase, loadSavedKey, rememberKey, forgetKey, memoryStorage,
} from './lib/transport.js';
import {
  askJev, answerMoves, runPolicyGame, buildPolicyBody,
  buildPolicyChakraState, chakraPlanState, chakraPlanQuestions,
} from './lib/jev.js';
import { boardHash } from './lib/chakra.js';
import { chakraSkin } from './skins/chakravyuha.js';

const BASE = deriveBase(typeof location !== 'undefined' ? location.pathname : '/');
const storage = typeof localStorage !== 'undefined' ? localStorage : memoryStorage();
const transport = createTransport({ base: BASE, storage });

const DIFF_STORAGE = 'jev.difficulty';
const MODE_STORAGE = 'jev.gameMode';
const INSTANT_STORAGE = 'jev.instant';

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
let lastMode = null;

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

// --------------------------------------------------------------- mode badge
const MODE_BADGES = {
  live: { label: 'LIVE', cls: 'live' },
  ready: { label: 'READY', cls: '' },
};

function setModeBadge(mode) {
  const el = $('mode');
  const b = MODE_BADGES[mode] || { label: String(mode || 'ready').toUpperCase(), cls: '' };
  lastMode = mode || null;
  el.textContent = b.label;
  el.className = 'mode ' + b.cls;
}

// ------------------------------------------------------------- game-mode toggle
const modeBar = $('mode-bar');

function currentMode() {
  try { return storage.getItem(MODE_STORAGE) === 'plan' ? 'plan' : 'policy'; } catch { return 'policy'; }
}

function refreshModeUI() {
  const mode = currentMode();
  modeBar.querySelectorAll('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.gameMode === mode));
  $('mode-note').textContent = mode === 'plan'
    ? 'Plan mode asks for the whole route up front (move 1, move 2, …). Kept for comparison: on a real maze its per-move confidence usually collapses.'
    : 'Policy mode is the real loop: at each step Jev only judges the legal next moves, and the shell applies the strongest one — then animates it.';
}

modeBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || busy) return;
  try { storage.setItem(MODE_STORAGE, btn.dataset.gameMode); } catch { /* ignore */ }
  refreshModeUI();
});

// --------------------------------------------------------------- difficulty
function loadDifficulty() {
  try {
    const d = storage.getItem(DIFF_STORAGE);
    return ['easy', 'medium', 'hard'].includes(d) ? d : 'easy';
  } catch { return 'easy'; }
}

function loadInstant() {
  try { return storage.getItem(INSTANT_STORAGE) === '1'; } catch { return false; }
}

// ------------------------------------------------------------------ errors
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
    ok = currentMode() === 'plan' ? await askPlan(key) : await askPolicy(key);
  } finally {
    btn.disabled = false;
    busy = false;
    $('cancel').hidden = true;
  }
  if (!ok) $('export-btn').disabled = true;
}

async function askPolicy(key) {
  currentSkin.begin();
  const board = currentSkin.board;
  $('state-pre').textContent = JSON.stringify({
    mode: 'policy',
    loop: 'ask → apply → ask',
    cap: `maxSteps = 2 × R × S = ${2 * board.R * board.S}`,
    sampleState: buildPolicyChakraState(board, {
      ring: board.src.ring, sector: board.src.sector,
      visited: [board.src], step: 1, maxSteps: 2 * board.R * board.S,
    }),
  }, null, 2);

  const game = await runPolicyGame({
    board, transport, model: 'jev-latest', key,
    onStep: (h) => currentSkin.animateHop(h),
  });

  if (game.outcome === 'error') {
    const e = game.error || {};
    const hint = e.code === 'no_key'
      ? 'BYOK: paste your TypeSafe key in the keycard above, then press Ask Jev again.'
      : e.code === 'network'
        ? 'Check the server is running (the same-origin shim is required — api.typesafe.ai is CORS-blocked).'
        : 'The server said no — see the code above.';
    showErrorCard(e.code || 'error', e.message || 'request failed', hint);
    recordRun({ game, v: null, body: { mode: 'live' }, outcome: 'error' });
    return false;
  }

  const body = buildPolicyBody(game);
  body.mode = 'live';
  setModeBadge('live');

  lastRun = { sent: { mode: 'policy', skin: currentSkin.id, game }, received: body };
  renderAnswers(body);
  const moves = answerMoves(body.answers);
  const v = currentSkin.check(moves);
  currentSkin.render();
  renderReferee(v);
  renderMeters(body, {
    calls: game.calls.length, lastMs: body._last_ms,
    optimal: v.optimal, steps: v.steps, qPerCall: game.lastQuestions,
  });
  setRunOutcome(game, v);
  recordRun({ game, v, body });
  return true;
}

async function askPlan(key) {
  currentSkin.begin();
  const board = currentSkin.board;
  const state = chakraPlanState(board);
  const questions = chakraPlanQuestions(board);
  const sample = Object.fromEntries(Object.entries(questions).slice(0, 3));
  $('state-pre').textContent =
    JSON.stringify({ mode: 'plan', state, questions: sample }, null, 2) +
    `\n… plus ${Object.keys(questions).length - 3} more move questions in the same request.`;

  const res = await askJev(transport, { state, questions, key });

  if (!res.ok) {
    const e = res.error || {};
    const hint = e.code === 'no_key'
      ? 'BYOK: paste your TypeSafe key in the keycard above, then press Ask Jev again.'
      : 'Check the server is running.';
    showErrorCard(e.code || 'error', e.message || 'request failed', hint);
    recordRun({ mode: 'plan', body: { mode: 'live' }, v: null, outcome: 'error' });
    return false;
  }

  const body = res.body;
  if (!body) {
    showErrorCard('bad_response', 'server returned an empty or non-JSON response');
    recordRun({ mode: 'plan', body: {}, v: null, outcome: 'error' });
    return false;
  }

  body.mode = 'live';
  setModeBadge('live');
  lastRun = { sent: { mode: 'plan', state, questions }, received: body };
  renderAnswers(body);
  const moves = answerMoves(body.answers);
  const v = currentSkin.check(moves);
  for (let i = 1; i < v.path.length; i++) {
    await currentSkin.animateHop({ from: v.path[i - 1], to: v.path[i], step: i });
  }
  currentSkin.render();
  renderReferee(v);
  renderMeters(body, { calls: 1, lastMs: body._ms, optimal: v.optimal, steps: v.steps });
  setRunOutcome({ outcome: v.reached ? 'reached' : 'stuck', moves, calls: [{ res: body }], maxSteps: null, reversals: 0, reached: v.reached }, v);
  recordRun({ mode: 'plan', body, v });
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
    html += `<div class="ans"><span class="id">…</span><span class="val">${moves.length - shown.length} more move questions</span><span class="conf"></span></div>`;
  }
  const box = $('answers');
  box.classList.remove('empty');
  box.innerHTML = html || 'No typed answers came back.';
}

function renderReferee(v) {
  const box = $('referee');
  box.classList.remove('empty');
  box.innerHTML =
    v.checks.map((c) => `<div class="chk ${c.pass ? 'pass' : 'fail'}">
        <span class="mark">${c.pass ? '✓' : '✗'}</span>
        <span>${escapeHtml(c.name)}${c.detail ? ` <span class="why">(${escapeHtml(c.detail)})</span>` : ''}</span>
      </div>`).join('') +
    `<div class="verdict ${v.ok ? 'ok' : 'no'}">${v.ok
      ? 'Jev threaded the chakravyuha by the shortest route.'
      : 'Jev did not take the shortest route.'}</div>`;
}

function renderMeters(body, extra = {}) {
  const lastMs = extra.lastMs ?? body._last_ms ?? body._ms;
  const totalMs = extra.totalMs ?? body._ms;
  const calls = extra.calls ?? body._calls ?? 1;
  $('m-decision').textContent = `${lastMs ?? '?'} ms`;
  $('m-total').textContent = `${totalMs ?? '?'} ms`;
  $('m-calls').textContent = String(calls);
  $('m-cost').textContent = body._cost_usd !== undefined ? `$${body._cost_usd.toFixed(6)}` : '—';
  $('m-q').textContent = String(extra.qPerCall ?? body._questions ?? '—');
  const optimal = extra.optimal;
  const steps = extra.steps;
  $('m-steps').textContent = optimal === null
    ? 'unreachable'
    : steps !== undefined
      ? `${steps} / ${optimal}`
      : (body._steps ?? '—');
}

/** Honest outcome banner: reached / stuck / exhausted / error. */
function setRunOutcome(game, v) {
  const el = $('run-outcome');
  if (!el || !game) { if (el) el.hidden = true; return; }
  el.hidden = false;
  el.classList.remove('reached', 'stuck', 'exhausted', 'error');
  const calls = Array.isArray(game.calls) ? game.calls.length : 0;
  const prefix = `${calls} call${calls === 1 ? '' : 's'}`;
  if (game.outcome === 'reached') {
    el.classList.add('reached');
    const optimalNote = (v && v.optimal !== null) ? `, optimal ${v.optimal}` : (v && v.optimal === null ? ' (no route exists)' : '');
    const rev = game.reversals ? ` · ${game.reversals} reversal${game.reversals > 1 ? 's' : ''}` : '';
    el.textContent = `${prefix} · reached the centre${optimalNote} · ${game.moves.length} steps${rev}`;
  } else if (game.outcome === 'stuck') {
    el.classList.add('stuck');
    el.textContent = `${prefix} · STUCK — every legal neighbour was already visited. No backtracking search: the run stops here.`;
  } else if (game.outcome === 'exhausted') {
    el.classList.add('exhausted');
    el.textContent = `${prefix} · EXHAUSTED — hit the ${game.maxSteps}-step cap without reaching the centre.`;
  } else {
    el.classList.add('error');
    el.textContent = `${prefix} · error — the run could not finish.`;
  }
}

// ------------------------------------------------------- run recording
// Every completed run is recorded server-side via POST /api/runs. The server
// only whitelists/validates and stamps id/at. Recording is fire-and-forget: it
// must never alter the play flow, so a save failure is logged, not thrown.
// BYOK: the key never travels in this POST and never reaches the record.

/**
 * Assemble the §9 run record. `v` is the referee verdict; `game` is the policy
 * run object (null in plan mode); `body` is the Jev-shaped response used for
 * the meters (mode, model, times, cost).
 */
function buildRunRecord({ game, v, body, mode, outcome }) {
  const board = currentSkin.board;
  if (!board || !body) return null;
  const runMode = 'live';
  const reached = v ? !!v.reached : (game ? !!game.reached : false);
  const checks = v ? v.checks : [];
  const passed = checks.filter((c) => c.pass).length;
  const optimal = v ? v.optimal : null;
  const steps = v ? v.steps : (game ? game.steps : 0);
  const runOutcome = outcome || (game ? game.outcome : (v ? (v.hitWall ? 'stuck' : v.reached ? 'reached' : 'stuck') : 'error'));
  const totalMs = game && Array.isArray(game.calls) && game.outcome !== 'error'
    ? game.totalMs
    : (body._ms ?? 0);
  const calls = game && Array.isArray(game.calls) ? game.calls.length : 1;
  const questions = game && Array.isArray(game.calls) ? game.totalQuestions : (body._questions ?? 0);
  const tokensIn = game ? game.totalTokensIn : (body.usage?.input_tokens ?? 0);
  const tokensOut = game ? game.totalTokensOut : (body.usage?.output_tokens ?? 0);
  const costUsd = game ? game.totalCostUsd : (body._cost_usd ?? 0);

  let optimalityScore;
  if (!reached) optimalityScore = optimal === null ? null : 0;
  else if (optimal === null) optimalityScore = null;
  else optimalityScore = Math.max(0, Math.min(1, optimal / (steps || 1)));

  return {
    difficulty: board.difficulty || loadDifficulty(),
    mode: runMode,
    outcome: runOutcome,
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
    optimalityScore,
    accuracyScore: checks.length ? passed / checks.length : null,
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

// ----------------------------------------------------------------- export
function exportRun() {
  if (!lastRun) return;
  const blob = new Blob([JSON.stringify(lastRun, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `chakravyuha-run-${lastMode || 'x'}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------- boot
$('ask').addEventListener('click', ask);
$('export-btn').addEventListener('click', exportRun);
$('cancel').addEventListener('click', () => {
  currentSkin.animator?.cancel();
});

refreshKeyUI();
refreshModeUI();

currentSkin.setInstant(loadInstant());
currentSkin.setDifficulty(loadDifficulty());
currentSkin.mount({ container: $('skin-controls') });
$('board-caption').innerHTML = currentSkin.caption();
setModeBadge('ready');

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