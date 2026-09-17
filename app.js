// app.js — the shell: skin switch, transport switch, BYOK key UI, meters,
// export, the referee panel, and the game loop. Two question modes:
//   policy (default)  ask → apply → ask: per-step local snap judgments
//   plan              the old global ask (move k of the whole path), kept
//                     for comparison — live runs collapse and Jev's low
//                     confidence shows it
//
// THE RULE (unchanged): there is no pathfinding in this file, nor in lib/ or
// skins/. The board is serialised into a `state`, typed questions are sent to
// Jev, and the direction list Jev returns is applied verbatim. In policy
// mode the loop enumerates the legal action space (one noul per candidate) and
// applies the argmax over Jev's own probabilities — that is not a search, and
// lib/referee.js is used only to *check* the answer afterwards.
//
// BYOK: the key is never logged, never put in a URL, never written to a
// file, and never exported. It lives in localStorage only if the user ticks
// "remember".

import {
  createTransport, deriveBase, loadSavedKey, rememberKey, forgetKey, memoryStorage,
} from './lib/transport.js';
import {
  askJev, answerMoves, runPolicyGame, buildPolicyBody,
  buildPolicyGridState, buildPolicyNavState,
} from './lib/jev.js';
import { gridSkin } from './skins/grid.js';
import { gmapsSkin } from './skins/gmaps.js';

const BASE = deriveBase(typeof location !== 'undefined' ? location.pathname : '/');
const storage = typeof localStorage !== 'undefined' ? localStorage : memoryStorage();
const transport = createTransport({ base: BASE, storage });

const SKINS = { grid: gridSkin, gmaps: gmapsSkin };

const MODE_STORAGE = 'jev.gameMode';

const num = (s) => Number(s.slice(5));
const confPct = (c) => { const n = Number(c); return Number.isFinite(n) ? Math.round(n * 100) : 100; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

// ------------------------------------------------------------------ state
let currentSkin = null;
let busy = false;
let lastRun = null;
let lastMode = null;

const $ = (id) => document.getElementById(id);

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

// ----------------------------------------------------------- transport UI
const transportSelect = $('transport');
transportSelect.value = transport.mode;
const directNote = $('direct-note');
const transportChip = $('transport-chip');
const stubNote = $('stub-note');

function refreshTransportUI() {
  const m = transport.mode;
  transportSelect.value = m;
  transportChip.textContent = m === 'direct' ? 'transport: direct' : 'transport: proxy';
  directNote.hidden = m !== 'direct';
  if (m === 'direct' && !currentKey()) directNote.textContent =
    'direct needs a key in the box above — and it is CORS-blocked by api.typesafe.ai today (no Access-Control-Allow-Origin). Prefer the proxy transport.';
  else if (m === 'direct') directNote.textContent =
    'CORS block: api.typesafe.ai sends no Access-Control-Allow-Origin, so a browser cannot call it directly today. Prefer the proxy transport.';
}

transportSelect.addEventListener('change', () => {
  transport.setMode(transportSelect.value);
  refreshTransportUI();
});

// --------------------------------------------------------------- mode badge
const MODE_BADGES = {
  live:   { label: 'LIVE', cls: 'live' },
  replay: { label: 'REPLAY', cls: 'replay' },
  stub:   { label: 'STUB — local solver, not Jev', cls: 'stub' },
};

function setModeBadge(mode) {
  const el = $('mode');
  const b = MODE_BADGES[mode] || { label: String(mode || 'ready').toUpperCase(), cls: '' };
  lastMode = mode || null;
  el.textContent = b.label;
  el.className = 'mode ' + b.cls;
}

// -------------------------------------------------------------- skin switch
const skinBar = $('skin-bar');

function mountSkin(id) {
  if (currentSkin) currentSkin.dispose?.();
  currentSkin = SKINS[id] || gridSkin;
  skinBar.querySelectorAll('.skin-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.skin === currentSkin.id));
  const box = $('skin-controls');
  box.textContent = '';
  $('skin-result').hidden = currentSkin.id !== 'gmaps';
  if (currentSkin.id === 'gmaps') $('skin-result').innerHTML = '';
  currentSkin.mount({ container: box, autoAsk: () => ask(), resultEl: $('skin-result') });
  $('board-caption').innerHTML = currentSkin.caption();
  currentSkin.begin();
}

skinBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.skin-btn');
  if (!btn || busy) return;
  try { storage.setItem('jev.skin', btn.dataset.skin); } catch { /* ignore */ }
  mountSkin(btn.dataset.skin);
});

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
    ? 'Plan mode is the OLD global question (“move k of the path”) — kept for comparison. In live runs its per-move answers collapse and Jev’s own low confidence shows it.'
    : 'Policy mode is the new loop: at each step Jev only judges the legal next moves, and the loop applies its best guess.';
}

modeBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || busy) return;
  try { storage.setItem(MODE_STORAGE, btn.dataset.gameMode); } catch { /* ignore */ }
  refreshModeUI();
});

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
  btn.disabled = true;
  busy = true;
  hideErrorCard();
  $('export-btn').disabled = true;

  // BYOK bookkeeping: persist only when the user asked to remember.
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
  }
  if (!ok) $('export-btn').disabled = true;
}

async function askPlan(key) {
  const { state, questions } = currentSkin.begin();
  $('state-pre').textContent =
    JSON.stringify({ state, questions: Object.fromEntries(Object.entries(questions).slice(0, 3)) }, null, 2) +
    `\n… plus ${Object.keys(questions).length - 3} more questions in the same request.`;

  const res = await askJev(transport, { state, questions, key });

  if (!res.ok) {
    const hint = res.error?.code === 'network'
      ? 'Check the server is running, or switch to the proxy transport.'
      : res.error?.code === 'forbidden'
        ? 'Blocked by the server. It must be running for the proxy transport.'
        : 'Server said no — see the code above. With the proxy transport, a bad/absent key yields STUB or a clean error.';
    showErrorCard(res.error?.code || 'error', res.error?.message || 'request failed', hint);
    if (res.body?.mode) setModeBadge(res.body.mode);
    return false;
  }

  const body = res.body;
  if (!body) {
    showErrorCard('bad_response', 'server returned an empty or non-JSON response');
    return false;
  }

  if (body.mode) setModeBadge(body.mode);
  else setModeBadge(lastMode);
  noteMode(body.mode);

  lastRun = {
    sent: { mode: 'plan', state, questions },
    received: body,
  };
  setRunOutcome(null);
  renderAnswers(body);
  const moves = answerMoves(body.answers);
  const v = currentSkin.check(moves);
  renderReferee(v);
  renderMeters(body, {
    calls: 1, lastMs: body._ms, optimal: v.optimal,
    steps: v.steps, cost: v.cost, weighted: !!currentSkin.weighted,
  });
  currentSkin.render(body);
  return true;
}

async function askPolicy(key) {
  // Reset the skin's visuals; the per-step loop owns the state from here on.
  currentSkin.begin();
  const board = currentSkin.board;
  $('state-pre').textContent = JSON.stringify({
    mode: 'policy',
    weighted: !!currentSkin.weighted,
    loop: 'ask → apply → ask',
    cap: `maxSteps = 4 × (R + C) = ${4 * (board.R + board.C)}`,
    sampleState: runPolicyPreview(board, currentSkin.weighted),
  }, null, 2);

  const game = await runPolicyGame({
    board, transport, model: 'jev-latest', key,
    weighted: !!currentSkin.weighted,
  });

  if (game.outcome === 'error') {
    const e = game.error || {};
    const hint = e.code === 'network'
      ? 'Check the server is running, or switch to the proxy transport.'
      : 'Server said no — see the code above. With the proxy transport, a bad/absent key yields STUB or a clean error.';
    showErrorCard(e.code || 'error', e.message || 'request failed', hint);
    return false;
  }

  const body = buildPolicyBody(game);
  body.mode = game.calls[0]?.res?.mode || 'stub';
  setModeBadge(body.mode);
  noteMode(body.mode);

  lastRun = {
    sent: { mode: 'policy', skin: currentSkin.id, weighted: !!currentSkin.weighted, game },
    received: body,
  };
  renderAnswers(body);
  const moves = answerMoves(body.answers);
  const v = currentSkin.check(moves);
  renderReferee(v);
  renderMeters(body, {
    calls: game.calls.length, lastMs: body._last_ms,
    optimal: v.optimal, steps: v.steps, cost: v.cost,
    weighted: !!currentSkin.weighted,
    qPerCall: game.lastQuestions,
  });
  currentSkin.render(body);
  setRunOutcome(game, v);
  return true;
}

/** A tiny taste of the first per-step state, for the "what we sent" panel. */
function runPolicyPreview(board, weighted) {
  const r = board.src.r, c = board.src.c;
  const maxSteps = 4 * (board.R + board.C);
  const state = weighted
    ? buildPolicyNavState(board, { r, c, visited: [{ row: r, col: c }], step: 1, maxSteps })
    : buildPolicyGridState(board, { r, c, visited: [{ row: r, col: c }], step: 1, maxSteps });
  return state;
}

function noteMode(mode) {
  if (mode === 'stub' || mode === 'replay') {
    stubNote.textContent = mode === 'stub'
      ? 'This answer is from the local STUB solver — paste a key for real Jev.'
      : 'REPLAY — this answer is verbatim from a recorded fixture.';
  } else if (mode === 'live') {
    stubNote.textContent = 'LIVE — this answer is from real Jev via your key.';
  }
}

function renderAnswers(res) {
  const entries = Object.entries(res.answers || {});
  const moves = entries.filter(([k]) => k.startsWith('move_')).sort((a, b) => num(a[0]) - num(b[0]));
  const cells = entries.filter(([k]) => k.startsWith('cell_'));
  const meta = entries.filter(([k]) => !k.startsWith('move_') && !k.startsWith('cell_'));

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
  if (cells.length) {
    html += `<div class="ans"><span class="id">cell_*</span><span class="val">${cells.length} per-cell probabilities → heat overlay</span><span class="conf"></span></div>`;
  }
  const box = $('answers');
  box.classList.remove('empty');
  box.innerHTML = html;
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
      ? (v.weighted ? 'Jev found the least-cost route.' : 'Jev solved it optimally.')
      : (v.weighted ? 'Jev did not pick the least-cost route.' : 'Jev did not solve it optimally.')}</div>`;
}

function renderMeters(body, extra = {}) {
  const lastMs = extra.lastMs ?? body._last_ms ?? body._ms;
  const totalMs = extra.totalMs ?? body._total_ms ?? body._ms;
  const calls = extra.calls ?? body._calls ?? 1;
  const optimal = extra.optimal;
  const steps = extra.steps;
  const cost = extra.cost;
  const weighted = !!extra.weighted;
  $('m-decision').textContent = `${lastMs ?? '?'} ms`;
  $('m-total').textContent = `${totalMs ?? '?'} ms`;
  $('m-calls').textContent = String(calls);
  $('m-cost').textContent = body._cost_usd !== undefined ? `$${body._cost_usd.toFixed(6)}` : '—';
  $('m-q').textContent = String(extra.qPerCall ?? body._questions ?? '—');
  // On the weighted (navigation) skin the optimum is a congestion COST, not a
  // step count — comparing steps against it would be nonsense like "26 / 53".
  const label = document.querySelector('#m-steps')?.closest('.meter')?.querySelector('.m-label');
  if (label) label.textContent = weighted ? 'cost vs optimal' : 'steps vs optimal';
  const actual = weighted ? cost : steps;
  $('m-steps').textContent = optimal === null
    ? 'unreachable'
    : actual !== undefined
      ? `${actual} / ${optimal}`
      : (body._steps ?? '—');
}

/** Honest outcome banner: reached / stuck / exhausted / error. */
function setRunOutcome(game, v) {
  const el = $('run-outcome');
  if (!el) return;
  if (!game) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.remove('reached', 'stuck', 'exhausted', 'error');
  const prefix = `${game.calls?.length ?? 1} calls`;
  if (game.outcome === 'reached') {
    el.classList.add('reached');
    const optimalNote = (v && v.optimal !== null)
      ? `, optimal ${v.optimal}`
      : (v && v.optimal === null ? ' (no route exists)' : '');
    el.textContent = `${prefix} · reached the goal${optimalNote} · ${game.moves.length} steps${game.reversals ? ` · ${game.reversals} reversal${game.reversals > 1 ? 's' : ''}` : ''}`;
  } else if (game.outcome === 'stuck') {
    el.classList.add('stuck');
    el.textContent = `${prefix} · STUCK — every legal neighbour was already visited. No backtracking search: the run stops here.`;
  } else if (game.outcome === 'exhausted') {
    el.classList.add('exhausted');
    el.textContent = `${prefix} · EXHAUSTED — hit the ${game.maxSteps}-step cap without reaching the goal.`;
  } else {
    el.classList.add('error');
    el.textContent = `${prefix} · error — the run could not finish.`;
  }
}

// ----------------------------------------------------------------- export
function exportRun() {
  if (!lastRun) return;
  const blob = new Blob([JSON.stringify(lastRun, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `pathpuzzle-run-${lastMode || 'x'}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------- boot
$('ask').addEventListener('click', ask);
$('export-btn').addEventListener('click', exportRun);

const savedSkin = (() => { try { return storage.getItem('jev.skin'); } catch { return null; } })();

// initial health ping: is the shim up and does it hold an env key?
fetch(`${BASE}api/health`).then((r) => r.json()).then((h) => {
  if (h && h.ok) {
    if (h.hasEnvKey) stubNote.textContent = 'Server holds an env key — requests without a browser key will go LIVE.';
    else stubNote.textContent = 'No key set anywhere — answers will come from the local STUB solver unless you paste a key.';
    refreshTransportUI();
  }
}).catch(() => {
  stubNote.textContent = 'Server unreachable — the page cannot reach Jev at all.';
});

refreshKeyUI();
refreshTransportUI();
refreshModeUI();
mountSkin(savedSkin === 'gmaps' ? 'gmaps' : 'grid');