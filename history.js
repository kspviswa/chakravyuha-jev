// history.js — the run-history page: per-group statistics (source · mode ·
// skin), a sortable run table, filters, CSV export, clear-history and a
// graceful "server down → localStorage cache" fallback. It never merges
// dissimilar runs together and never throws an unhandled rejection.

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
const filters = { source: 'all', mode: 'all', skin: 'all' };

const SOURCE_COLORS = { live: 'live', stub: 'stub', replay: 'replay' };

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
    (filters.source === 'all' || r.source === filters.source) &&
    (filters.mode === 'all' || r.mode === filters.mode) &&
    (filters.skin === 'all' || r.skin === filters.skin));
}

function groupKey(r) { return `${r.source}|${r.mode}|${r.skin}`; }

function populateFilters() {
  const sets = { source: new Set(), mode: new Set(), skin: new Set() };
  for (const r of allRuns) {
    if (r.source) sets.source.add(r.source);
    if (r.mode) sets.mode.add(r.mode);
    if (r.skin) sets.skin.add(r.skin);
  }
  for (const [kind, values] of Object.entries(sets)) {
    const sel = $(`f-${kind}`);
    const chosen = sel.value;
    sel.innerHTML = '';
    const opt = (v) => {
      const o = document.createElement('option');
      o.value = o.textContent = v;
      return o;
    };
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'all';
    sel.appendChild(allOpt);
    for (const v of [...values].sort()) sel.appendChild(opt(v));
    sel.value = [...values].includes(chosen) ? chosen : 'all';
  }
}

// ------------------------------------------------------------ stats blocks
const METRICS = [
  { key: 'totalMs', label: 'speed · totalMs', round: 'ms' },
  { key: 'msPerStep', label: 'speed · ms/step', round: 'ms' },
  { key: 'optimalityScore', label: 'optimality', round: 'sc' },
  { key: 'accuracyScore', label: 'accuracy', round: 'sc' },
];

function valueOf(run, key) {
  if (key === 'msPerStep') return msPerStep(run);
  return score(run[key]);
}

function statGridHtml(groups) {
  if (!groups.length) return '';
  const roundNum = (v, mode) => (v === null ? '—' : display(v, mode));

  return groups.map(([key, runs]) => {
    const [source, mode, skin] = key.split('|');
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
        <h3 class="group-key"><span class="src ${SOURCE_COLORS[source]}">${escapeHtml(source)}</span> · ${escapeHtml(mode)} · ${escapeHtml(skin)} <em>n=${runs.length}</em></h3>
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
    case 'skin': return run.skin;
    case 'mode': return run.mode;
    case 'source': return run.source;
    case 'outcome': return run.outcome;
    case 'steps': return Number.isFinite(run.steps) ? run.steps : -1;
    case 'cost': return Number.isFinite(run.cost) ? run.cost : -1;
    case 'accuracy': return Number.isFinite(run.accuracyScore) ? run.accuracyScore : -1;
    case 'totalMs': return Number.isFinite(run.totalMs) ? run.totalMs : -1;
    case 'board': return String(run.board?.rows || '');
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

function costCell(run) {
  if (run.cost === null || run.cost === undefined) return '—';
  const o = run.optimalCost;
  return `${escapeHtml(run.cost)} / ${o === null || o === undefined ? '—' : escapeHtml(o)}`;
}

function boardCell(run) {
  const b = run.board || {};
  const size = (b.rows && b.cols) ? `${escapeHtml(b.rows)}×${escapeHtml(b.cols)}` : '—';
  const diff = b.difficulty ? ` ${escapeHtml(b.difficulty)}` : '';
  return `${size}${diff}`;
}

function outcomeHtml(run) {
  const ok = run.outcome === 'reached';
  return `<span class="verdict ${ok ? 'ok' : 'no'}">${escapeHtml(run.outcome)}</span>`;
}

function tableRows(runs) {
  const sorted = [...runs].sort(compare);
  return sorted.map((r) => {
    const srcCls = SOURCE_COLORS[r.source] || '';
    return `
      <tr>
        <td class="nowrap" title="${escapeHtml(r.at || '')}">${escapeHtml(localTime(r.at))}</td>
        <td>${escapeHtml(r.skin)}</td>
        <td>${escapeHtml(r.mode)}</td>
        <td><span class="src ${srcCls}">${escapeHtml(r.source)}</span></td>
        <td>${outcomeHtml(r)}</td>
        <td>${stepsCell(r)}</td>
        <td>${costCell(r)}</td>
        <td>${display(score(r.accuracyScore), 'sc')}</td>
        <td>${display(score(r.totalMs), 'ms')} ms</td>
        <td>${boardCell(r)}</td>
      </tr>`;
  }).join('');
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
  const head = ['at', 'skin', 'mode', 'source', 'outcome', 'reached', 'steps', 'optimalSteps',
    'cost', 'optimalCost', 'optimalityScore', 'accuracyScore', 'checksPassed', 'checksTotal',
    'totalMs', 'msPerStep', 'lastStepMs', 'calls', 'questions', 'costUsd',
    'boardRows', 'boardCols', 'difficulty', 'boardHash'];
  const rows = [...runs].sort(compare).map((r) => {
    const b = r.board || {};
    return [
      r.at, r.skin, r.mode, r.source, r.outcome, r.reached, r.steps, r.optimalSteps,
      r.cost, r.optimalCost, r.optimalityScore, r.accuracyScore, r.checksPassed, r.checksTotal,
      r.totalMs, msPerStep(r), r.lastStepMs, r.calls, r.questions, r.costUsd,
      b.rows, b.cols, b.difficulty, b.hash,
    ];
  });
  return [head, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function exportCsv() {
  const runs = currentFiltered();
  const blob = new Blob([csvRows(runs) + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `pathpuzzle-runs-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
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
      <p>No runs recorded yet — go play one.</p>
      <a class="navlink" href="./index.html">← Back to the puzzle</a>
    </div>`;

  if (filtered.length === 0) {
    $('stats').innerHTML = emptyState;
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

for (const kind of ['source', 'mode', 'skin']) {
  $(`f-${kind}`).addEventListener('change', (e) => {
    filters[kind] = e.target.value;
    render();
  });
}

$('export-csv').addEventListener('click', exportCsv);
$('clear-history').addEventListener('click', clearHistory);

loadRuns();