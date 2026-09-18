// scripts/compare-modes.mjs — batch vs step-by-step, from the run history.
//
// The toggle exists to be measured, not to be believed. This reads runs.jsonl
// and reports the two ask modes side by side, so "step by step is better" has to
// survive contact with the numbers.
//
//   node scripts/compare-modes.mjs            # both modes, all difficulties
//   node scripts/compare-modes.mjs --json     # machine-readable
//   node scripts/compare-modes.mjs --since 2026-09-18T02:00:00Z
//   node scripts/compare-modes.mjs --build 0.4.0     # one revision only
//
// --since matters more than it looks. The history spans many revisions of the
// app (questions-per-call has been 1, 15, 43, 48, 64, 128, 144, 192), so an
// all-time average compares the ASK MODE and the APP VERSION at the same time
// and proves nothing about either. Compare like with like.
//
// Run records are written by the browser, so this is the only place the two
// modes can be compared without a key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = process.argv.find((a) => a.endsWith('.jsonl')) || path.join(HERE, '..', 'runs.jsonl');

const sinceIdx = process.argv.indexOf('--since');
const SINCE = sinceIdx > -1 ? Date.parse(process.argv[sinceIdx + 1]) : null;
if (sinceIdx > -1 && Number.isNaN(SINCE)) {
  console.error('--since needs an ISO timestamp, e.g. --since 2026-09-18T02:00:00Z');
  process.exit(2);
}

const all = fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const buildIdx = process.argv.indexOf('--build');
const BUILD = buildIdx > -1 ? process.argv[buildIdx + 1] : null;

let rows = SINCE ? all.filter((r) => Date.parse(r.at) >= SINCE) : all;
if (BUILD) rows = rows.filter((r) => (r.build || 'untagged (pre-0.4.0)') === BUILD);

const asJson = process.argv.includes('--json');
const MODES = [
  { key: 'live', label: 'batch (all cells in one call)' },
  { key: 'live-step', label: 'step by step (one cell per call)' },
];

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (n) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
const num = (n, d = 1) => (n === null ? '—' : n.toFixed(d));

function summarise(mode) {
  const rs = rows.filter((r) => r.mode === mode);
  if (!rs.length) return null;
  const reached = rs.filter((r) => r.outcome === 'reached');
  const graded = rs.filter((r) => typeof r.stepAccuracy === 'number');
  // Confidence as a signal: of every step in these runs, how many were taken
  // with a clear read — and, of those, how many were actually right.
  const conf = { high: { n: 0, right: 0 }, medium: { n: 0, right: 0 }, low: { n: 0, right: 0 }, unknown: { n: 0, right: 0 } };
  for (const r of rs) {
    const bands = Array.isArray(r.confidenceBands) ? r.confidenceBands : null;
    const flags = Array.isArray(r.stepFlags) ? r.stepFlags : null;
    if (!bands) continue;
    for (let i = 0; i < bands.length; i++) {
      const b = conf[bands[i]] ? bands[i] : 'unknown';
      conf[b].n++;
      if (flags && flags[i] === true) conf[b].right++;
    }
  }
  const byDiff = {};
  for (const d of ['easy', 'medium', 'hard']) {
    const g = rs.filter((r) => r.difficulty === d);
    if (!g.length) continue;
    byDiff[d] = {
      runs: g.length,
      reached: g.filter((r) => r.outcome === 'reached').length,
      reachRate: g.filter((r) => r.outcome === 'reached').length / g.length,
      stepAccuracy: mean(g.filter((r) => typeof r.stepAccuracy === 'number').map((r) => r.stepAccuracy)),
    };
  }
  return {
    mode,
    runs: rs.length,
    reachRate: reached.length / rs.length,
    stepAccuracy: mean(graded.map((r) => r.stepAccuracy)),
    cellsAsked: mean(rs.map((r) => r.cellsAsked).filter((n) => typeof n === 'number')),
    questions: mean(rs.map((r) => r.questions).filter((n) => typeof n === 'number')),
    calls: mean(rs.map((r) => r.calls).filter((n) => typeof n === 'number')),
    msPerStep: mean(rs.map((r) => r.msPerStep).filter((n) => typeof n === 'number')),
    costPerRun: mean(rs.map((r) => r.costUsd).filter((n) => typeof n === 'number')),
    repairs: mean(rs.map((r) => r.repairs).filter((n) => typeof n === 'number')),
    conf,
    byDiff,
  };
}

const out = MODES.map((m) => summarise(m.key)).filter(Boolean);

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`runs file: ${RUNS}`);
if (SINCE) console.log(`filtered to runs at or after ${new Date(SINCE).toISOString()}`);
if (BUILD) console.log(`filtered to build ${BUILD}`);
console.log(`${rows.length} records · ${rows.filter((r) => r.mode === 'live').length} batch · ${rows.filter((r) => r.mode === 'live-step').length} step`);

// Build tags make this exact rather than guessed: a record knows which revision
// produced it, so a mixed window is reported as fact. Records predating the tag
// carry none, and are named as such rather than silently averaged in.
const builds = new Map();
for (const r of rows) {
  const k = r.build || 'untagged (pre-0.4.0)';
  builds.set(k, (builds.get(k) || 0) + 1);
}
console.log('builds in this window:');
for (const [k, n] of [...builds].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(22)} ${n} run${n === 1 ? '' : 's'}`);
if (builds.size > 1) {
  console.log('\n⚠ more than one build here — the ask mode is not the only thing that differs.');
  console.log('  Re-run both modes on the CURRENT build and compare those alone.');
}
console.log('');

if (!out.length) { console.log('No runs recorded yet. Run both modes in the browser first.'); process.exit(0); }

for (const s of out) {
  const m = MODES.find((x) => x.key === s.mode);
  console.log(`── ${m.label} — ${s.runs} runs`);
  console.log(`   reached the centre : ${pct(s.reachRate)}`);
  console.log(`   step accuracy      : ${pct(s.stepAccuracy)}   ← the measure of Jev's judgment`);
  console.log(`   questions per run  : ${num(s.questions, 0)}   across ${num(s.calls)} calls`);
  console.log(`   cells asked/call   : ${num(s.cellsAsked, 0)}`);
  console.log(`   ms per step        : ${num(s.msPerStep, 0)}`);
  console.log(`   cost per run       : $${(s.costPerRun ?? 0).toFixed(5)}`);
  console.log(`   repairs per run    : ${num(s.repairs, 2)}`);
  const ct = s.conf;
  const bandLine = ['high', 'medium', 'low', 'unknown']
    .filter((b) => ct[b].n > 0)
    .map((b) => `${b} ${ct[b].n} step${ct[b].n === 1 ? '' : 's'} (${pct(ct[b].n ? ct[b].right / ct[b].n : null)} right)`);
  if (bandLine.length) {
    console.log(`   confidence         : ${bandLine.join('  ·  ')}`);
    console.log('                        ← does certainty track correctness? if high ≈ low, the signal is not worth gating on');
  }
  for (const d of ['easy', 'medium', 'hard']) {
    const g = s.byDiff[d];
    if (!g) continue;
    console.log(`     ${d.padEnd(6)} ${g.reached}/${g.runs} reached · step accuracy ${pct(g.stepAccuracy)}`);
  }
  console.log('');
}

if (out.length === 2) {
  const [a, b] = out;
  const d = (x, y) => (x === null || y === null ? '—' : `${((y - x) * 100).toFixed(1)} pts`);
  console.log('── verdict');
  console.log(`   reach rate     ${pct(a.reachRate)} → ${pct(b.reachRate)}   (${d(a.reachRate, b.reachRate)})`);
  console.log(`   step accuracy  ${pct(a.stepAccuracy)} → ${pct(b.stepAccuracy)}   (${d(a.stepAccuracy, b.stepAccuracy)})`);
  console.log(`   cost per run   $${(a.costPerRun ?? 0).toFixed(5)} → $${(b.costPerRun ?? 0).toFixed(5)}`);
  console.log('\n   Step accuracy is the honest comparison: it is the fraction of moves');
  console.log('   that were right, so it does not reward a run for happening to be short.');
}
