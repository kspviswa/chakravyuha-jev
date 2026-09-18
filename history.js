// history.js — the run-history page: per-group statistics (difficulty · mode),
// a sortable run table, filters, CSV export, clear-history and a graceful
// "server down → localStorage cache" fallback. It never merges dissimilar runs
// together and never throws an unhandled rejection.

import { deriveBase } from './lib/transport.js';
import { summarize } from './lib/stats.js';

const BASE = deriveBase(typeof location !== 'undefined' ? location.pathname : '/');
const CACHE_KEY = 'jev.runsCache';

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

// ------------------------------------------------------------------ state
let allRuns = [];
let sortCol = 'at';
let sortDesc = true;
const filters = { difficulty: 'all', mode: 'all' };

// --------------------------------------------------------------- helpers
const msPerStep = (r) => (Number.isFinite(r.totalMs) ? r.totalMs / Math.max(r.steps || 0, 1) : null);
const score = (n) => (Number.isFinite(n) ? n : null);

function localTime(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at || '') : d.toLocaleString();
}

function display(v, mode) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return mode === 'sc' ? v.toFixed(3) : String(Math.round(v));
}

function cache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); }
  catch { return null; }
}

function saveCache(runs) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), runs })); }
  catch { /* quota full — the cache is best-effort */ }
}

function showCacheFallback(saved) {
  if (saved && Array.isArray(saved.runs) && saved.runs.length) {
    const when = new Date(saved.at).toLocaleString();
    setNotice(`Server unreachable — showing the last cached data (fetched ${when}). New runs can’t be saved until it’s back.`);
  } else {
    setNotice('Server unreachable — run history is not available right now. Try again in a moment.');
  }
}

function setNotice(text) {
  const el = $('notice');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
}

// ---------------------------------------------------------------- loading
async function loadRuns() {
  try {
    const resp = await fetch(`${BASE}api/runs`, { method: 'GET' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    allRuns = Array.isArray(data.runs) ? data.runs : [];
    const saved = cache();
    if (!Array.isArray(saved?.runs) || saved.runs.length !== allRuns.length) saveCache(allRuns);
    setNotice('');
  } catch (e) {
    const saved = cache();
    allRuns = Array.isArray(saved?.runs) ? saved.runs : [];
    showCacheFallback(saved);
    console.warn('history: falling back to cache:', e && e.message ? e.message : e);
  }
  render();
}

// ---------------------------------------------------------------- filtering
function currentFiltered() {
  return allRuns.filter((r) =>
    (filters.difficulty === 'all' || r.difficulty === filters.difficulty) &&
    (filters.mode === 'all' || r.mode === filters.mode));
}

function groupKey(r) { return `${r.difficulty}|${r.mode}`; }

function populateFilters() {
  const sets = { difficulty: new Set(), mode: new Set() };
  for (const r of allRuns) {
    if (r.difficulty) sets.difficulty.add(r.difficulty);
    if (r.mode) sets.mode.add(r.mode);
  }
  for (const [kind, values] of Object.entries(sets)) {
    const sel = $(`f-${kind}`);
    const chosen = sel.value;
    sel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'all';
    sel.appendChild(allOpt);
    for (const v of [...values].sort()) {
      const o = document.createElement('option');
      o.value = o.textContent = v;
      sel.appendChild(o);
    }
    sel.value = [...values].includes(chosen) ? chosen : 'all';
  }
}

// ------------------------------------------------------------ stats blocks
const METRICS = [
  { key: 'totalMs', label: 'speed · totalMs', round: 'ms' },
  { key: 'msPerStep', label: 'speed · ms/step', round: 'ms' },
  { key: 'stepAccuracy', label: 'step accuracy', round: 'sc' },
];

function valueOf(run, key) {
  if (key === 'msPerStep') return msPerStep(run);
  return score(run[key]);
}

function statGridHtml(groups) {
  if (!groups.length) return '';
  const roundNum = (v, mode) => (v === null ? '—' : display(v, mode));

  return groups.map(([key, runs]) => {
    const [difficulty, mode] = key.split('|');
    const rows = METRICS.map((m) => {
      const s = summarize(runs.map((r) => valueOf(r, m.key)));
      return `
        <tr>
          <td class="m-label">${m.label}</td>
          <td>${s.n}</td>
          <td>${roundNum(s.mean, m.round)}</td>
          <td>${roundNum(s.median, m.round)}</td>
          <td>${roundNum(s.variance, m.round)}</td>
          <td>${roundNum(s.stddev, m.round)}</td>
          <td>${roundNum(s.min, m.round)}</td>
          <td>${roundNum(s.max, m.round)}</td>
        </tr>`;
    }).join('');
    return `
      <section class="stat-card">
        <h3 class="group-key"><span class="src live">${escapeHtml(difficulty)}</span> · ${escapeHtml(mode)} <em>n=${runs.length}</em></h3>
        <div class="stat-table-scroll">
          <table class="stat-table">
            <thead>
              <tr><th>metric</th><th>n</th><th>mean</th><th>median</th><th>variance</th><th>stddev</th><th>min</th><th>max</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${runs.length < 2 ? '<p class="var-note">variance needs at least two runs — shown as —</p>' : ''}
      </section>`;
  }).join('');
}

// ------------------------------------------------------------------ table
function sortValue(run, col) {
  switch (col) {
    case 'at': return new Date(run.at).getTime() || 0;
    case 'difficulty': return run.difficulty;
    case 'mode': return run.mode;
    case 'outcome': return run.outcome;
    case 'steps': return Number.isFinite(run.steps) ? run.steps : -1;
    // Accuracy and confidence were falling through to 0, so clicking those
    // headers did nothing. Runs that never recorded the metric sort as -1 —
    // absent is not the same as zero.
    case 'accuracy': return Number.isFinite(run.stepAccuracy) ? run.stepAccuracy : -1;
    case 'confidence': return Number.isFinite(run.confidentSteps) && run.steps
      ? run.confidentSteps / run.steps : -1;
    case 'green': return Number.isFinite(run.greenSteps) && run.steps
      ? run.greenSteps / run.steps : -1;
    case 'totalMs': return Number.isFinite(run.totalMs) ? run.totalMs : -1;
    case 'board': return String(run.rings || '');
    default: return 0;
  }
}

function compare(a, b) {
  const av = sortValue(a, sortCol);
  const bv = sortValue(b, sortCol);
  if (av < bv) return sortDesc ? 1 : -1;
  if (av > bv) return sortDesc ? -1 : 1;
  return 0;
}

function stepsCell(run) {
  const o = run.optimalSteps;
  return `${escapeHtml(run.steps)} / ${o === null || o === undefined ? '—' : escapeHtml(o)}`;
}

function boardCell(run) {
  const size = (run.rings && run.sectors) ? `${escapeHtml(run.rings)}×${escapeHtml(run.sectors)}` : '—';
  const hash = run.boardHash ? ` · ${escapeHtml(String(run.boardHash))}` : '';
  return `${size}${hash}`;
}

function outcomeHtml(run) {
  const ok = run.outcome === 'reached';
  return `<span class="verdict ${ok ? 'ok' : 'no'}">${escapeHtml(run.outcome)}</span>`;
}

/** "7/11" — steps where the model's OWN move was played, out of all steps. The
 *  rest were corrected. This is the run's headline now: a red step is one the
 *  model did not earn. Blank for runs recorded before it was captured. */
function greenCell(r) {
  const n = Number.isFinite(r.greenSteps) ? r.greenSteps : null;
  const total = Number.isFinite(r.steps) ? r.steps : null;
  if (n === null || !total) return '<span class="dim">—</span>';
  const red = Number.isFinite(r.redSteps) ? r.redSteps : 0;
  return `${n}/${total}${red ? ` <span class="dim">(${red} corrected)</span>` : ''}`;
}

/** "7/11" — steps taken with a clear read, out of all steps. Blank for runs
 *  recorded before confidence was captured. */
/** A 0..1 rate as a percentage, for the confidence tiles. */
function pctOf(v) {
  return v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`;
}

function confidenceCell(r) {
  const n = Number.isFinite(r.confidentSteps) ? r.confidentSteps : null;
  const total = Number.isFinite(r.steps) ? r.steps : null;
  if (n === null || !total) return '<span class="dim">—</span>';
  return `${n}/${total}`;
}

function tableRows(runs) {
  const sorted = [...runs].sort(compare);
  return sorted.map((r) => `
      <tr>
        <td class="nowrap" title="${escapeHtml(r.at || '')}">${escapeHtml(localTime(r.at))}</td>
        <td>${escapeHtml(r.difficulty)}</td>
        <td>${escapeHtml(r.mode)}</td>
        <td>${outcomeHtml(r)}</td>
        <td>${stepsCell(r)}</td>
        <td>${display(r.stepAccuracy, 'sc')}</td>
        <td title="steps where the model's own move was played, of all steps">${greenCell(r)}</td>
        <td title="steps taken with a clear read, of all steps">${confidenceCell(r)}</td>
        <td>${display(score(r.totalMs), 'ms')} ms</td>
        <td>${boardCell(r)}</td>
      </tr>`).join('');
}

function headerArrow(col) {
  if (col !== sortCol) return '';
  return sortDesc ? ' ↓' : ' ↑';
}

function renderTable(runs) {
  const thead = document.querySelector('#runs-table thead');
  thead.querySelectorAll('th').forEach((th) => {
    th.textContent = th.textContent.replace(/ [↓↑]$/, '');
    if (th.dataset.col === sortCol) th.textContent += headerArrow(sortCol);
  });
  $('runs-table').querySelector('tbody').innerHTML = tableRows(runs);
}

// --------------------------------------------------------------------- csv
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRows(runs) {
  const head = ['at', 'difficulty', 'mode', 'outcome', 'steps', 'optimalSteps',
    'stepAccuracy', 'correctSteps', 'confidentSteps', 'unsureSteps', 'mediumSteps',
    'greenSteps', 'redSteps', 'jevProposed', 'jevCorrect', 'jevAccuracy',
    'totalMs', 'msPerStep', 'lastStepMs',
    'calls', 'questions', 'tokensIn', 'tokensOut', 'costUsd',
    'rings', 'sectors', 'boardHash', 'model', 'id'];
  const rows = [...runs].sort(compare).map((r) => [
    r.at, r.difficulty, r.mode, r.outcome, r.steps, r.optimalSteps,
    r.stepAccuracy, r.correctSteps, r.confidentSteps, r.unsureSteps, r.mediumSteps,
    r.greenSteps, r.redSteps, r.jevProposed, r.jevCorrect, r.jevAccuracy,
    r.totalMs, msPerStep(r), r.lastStepMs,
    r.calls, r.questions, r.tokensIn, r.tokensOut, r.costUsd,
    r.rings, r.sectors, r.boardHash, r.model, r.id,
  ]);
  return [head, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function exportCsv() {
  const runs = currentFiltered();
  const blob = new Blob([csvRows(runs) + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `chakravyuha-runs-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------- cumulative footer
// Totals across the filtered view, plus mean ± sample stddev for the three
// per-step rates. The rates are the honest ones to average: a 40-step run and a
// 4-step run are not comparable on raw ms, but they are on ms/step.
function cumulativeHtml(runs) {
  const sum = (f) => runs.reduce((s, r) => s + (Number.isFinite(f(r)) ? f(r) : 0), 0);
  const totalRuns = runs.length;
  const totalSteps = sum((r) => r.steps);
  const totalQuestions = sum((r) => r.questions);
  const totalCalls = sum((r) => r.calls);
  const tokensIn = sum((r) => r.tokensIn);
  const tokensOut = sum((r) => r.tokensOut);
  const totalCost = sum((r) => r.costUsd);
  const totalMs = sum((r) => r.totalMs);
  const reached = runs.filter((r) => r.outcome === 'reached').length;

  const perStep = (r) => {
    const s = Number.isFinite(r.steps) && r.steps > 0 ? r.steps : null;
    return s ? {
      ms: Number.isFinite(r.totalMs) ? r.totalMs / s : null,
      q: Number.isFinite(r.questions) ? r.questions / s : null,
      cost: Number.isFinite(r.costUsd) ? r.costUsd / s : null,
    } : { ms: null, q: null, cost: null };
  };

  const stat = (key, mode, unit) => {
    const s = summarize(runs.map((r) => perStep(r)[key]));
    const num = (v) => (v === null || !Number.isFinite(v) ? '—' : (mode === 'sc' ? v.toFixed(3) : v.toFixed(1)));
    if (s.n < 2) return `${num(s.mean)} ${unit} <em>(n&lt;2)</em>`;
    return `${num(s.mean)} ± ${num(s.stddev)} ${unit} <em>(n=${s.n})</em>`;
  };

  const opt = summarize(runs.map((r) => (Number.isFinite(r.stepAccuracy) ? r.stepAccuracy : null)));
  // Confidence as its own rate: of every step these runs took, how many came
  // with a clear read. Runs from before confidence was captured contribute
  // nothing — they are excluded, not counted as zero.
  const confSteps = summarize(runs.map((r) => (Number.isFinite(r.confidentSteps) && r.steps
    ? r.confidentSteps / r.steps : null)));
  // The headline rate: of every step these runs took, how many were the model's
  // own move rather than a correction. Runs from before capture contribute
  // nothing — excluded, never counted as zero.
  const greenRate = summarize(runs.map((r) => (Number.isFinite(r.greenSteps) && r.steps
    ? r.greenSteps / r.steps : null)));
  const jevAcc = summarize(runs.map((r) => (Number.isFinite(r.jevAccuracy) ? r.jevAccuracy : null)));

  const tiles = [
    ['runs recorded', String(totalRuns)],
    ['reached the centre', `${reached} / ${totalRuns}${totalRuns ? ` · ${Math.round((reached / totalRuns) * 100)}%` : ''}`],
    ['total steps', String(totalSteps)],
    ['total questions', String(totalQuestions)],
    ['total calls', String(totalCalls)],
    ['total tokens · in / out', `${tokensIn} / ${tokensOut}`],
    ['total spent', `$${totalCost.toFixed(6)}`],
    ['total time', `${Math.round(totalMs)} ms`],
  ];

  const rates = [
    ['ms / step', stat('ms', 'ms', 'ms')],
    ['questions / step', stat('q', 'sc', '')],
    ['cost / step', stat('cost', 'sc', '$')],
    ['step accuracy', opt.n < 2
      ? `${opt.mean === null ? '—' : opt.mean.toFixed(3)} <em>(n&lt;2)</em>`
      : `${opt.mean.toFixed(3)} ± ${opt.stddev.toFixed(3)} <em>(n=${opt.n})</em>`],
    ["steps the model's own", greenRate.n === 0
      ? '<em>not captured yet</em>'
      : greenRate.n < 2
        ? `${pctOf(greenRate.mean)} <em>(n&lt;2)</em>`
        : `${pctOf(greenRate.mean)} ± ${pctOf(greenRate.stddev)} <em>(n=${greenRate.n})</em>`],
    ["Jev's accuracy", jevAcc.n === 0
      ? '<em>not captured yet</em>'
      : jevAcc.n < 2
        ? `${pctOf(jevAcc.mean)} <em>(n&lt;2)</em>`
        : `${pctOf(jevAcc.mean)} ± ${pctOf(jevAcc.stddev)} <em>(n=${jevAcc.n})</em>`],
    ['confident steps', confSteps.n === 0
      ? '<em>not captured yet</em>'
      : confSteps.n < 2
        ? `${pctOf(confSteps.mean)} <em>(n&lt;2)</em>`
        : `${pctOf(confSteps.mean)} ± ${pctOf(confSteps.stddev)} <em>(n=${confSteps.n})</em>`],
  ];

  return `
    <div class="cum-tiles">
      ${tiles.map(([label, value]) => `
        <div class="cum-tile"><span class="cum-label">${escapeHtml(label)}</span><span class="cum-value">${value}</span></div>`).join('')}
    </div>
    <div class="cum-tiles rates">
      ${rates.map(([label, value]) => `
        <div class="cum-tile"><span class="cum-label">${escapeHtml(label)}</span><span class="cum-value">${value}</span></div>`).join('')}
    </div>`;
}

// ------------------------------------------------------------------ render
function render() {
  populateFilters();
  const filtered = currentFiltered();
  $('run-count').textContent = filtered.length
    ? `· ${filtered.length} of ${allRuns.length} shown`
    : '· none';

  const emptyState = `
    <div class="empty-state block">
      <p>No runs recorded yet — go thread a chakravyuha.</p>
      <a class="navlink" href="./index.html">← Back to the maze</a>
    </div>`;

  if (filtered.length === 0) {
    $('stats').innerHTML = emptyState;
    $('cum-grid').innerHTML = '';
    $('cum-note').textContent = '';
    renderTable([]);
    return;
  }

  const groups = new Map();
  for (const r of filtered) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  $('stats').innerHTML = statGridHtml([...groups.entries()]);
  $('cum-grid').innerHTML = cumulativeHtml(filtered);
  $('cum-note').textContent = `Totals over the ${filtered.length} run(s) currently shown`
    + (filtered.length !== allRuns.length ? ` (of ${allRuns.length} recorded — clear the filters to see everything).` : '.');
  renderTable(filtered);
}

// --------------------------------------------------------------- actions
async function clearHistory() {
  if (!confirm('Clear the entire run history? This cannot be undone.')) return;
  setNotice('');
  try {
    const resp = await fetch(`${BASE}api/runs`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await resp.json();
    allRuns = [];
    saveCache(allRuns);
  } catch (e) {
    setNotice('Could not reach the server to clear history — try again in a moment.');
    console.warn('history: clear failed:', e && e.message ? e.message : e);
    return;
  }
  render();
}

document.querySelectorAll('#runs-table th[data-col]').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (col === sortCol) sortDesc = !sortDesc;
    else { sortCol = col; sortDesc = col === 'at'; }
    render();
  });
});

for (const kind of ['difficulty', 'mode']) {
  $(`f-${kind}`).addEventListener('change', (e) => {
    filters[kind] = e.target.value;
    render();
  });
}

$('export-csv').addEventListener('click', exportCsv);
$('clear-history').addEventListener('click', clearHistory);

loadRuns();