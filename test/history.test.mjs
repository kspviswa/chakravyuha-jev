// test/history.test.mjs — the History page's confidence surface.
//
// "Where is it recorded?" has to be answerable on the page, not only in the
// file: the runs table needs the column, and it needs to sort by it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';


test('history: the runs table has a confidence column, and it sorts', async () => {
  // "Where is it recorded?" must be answerable on the page, not only in the
  // file. And a column that cannot sort is a column that lies about ordering.
  const src = await readFile(new URL('../history.js', import.meta.url), 'utf8');
  assert.match(src, /confidenceCell/, 'the table renders a confidence cell');
  assert.match(src, /case 'confidence':/, 'the column sorts');
  assert.match(src, /case 'accuracy':/, 'and so does accuracy, which never did');
  assert.match(src, /'confidentSteps', 'unsureSteps', 'mediumSteps'/, 'the CSV export carries the counts');
});

test('history: confidenceCell shows y/total, and — when it was never captured', async () => {
  const src = await readFile(new URL('../history.js', import.meta.url), 'utf8');
  // Pull the function out and run it, so the formatting itself is checked.
  const body = src.slice(src.indexOf('function confidenceCell'));
  const fn = new Function(`${body.slice(0, body.indexOf('\n}') + 2)}; return confidenceCell;`)();
  assert.equal(fn({ confidentSteps: 7, steps: 11 }), '7/11');
  assert.equal(fn({ confidentSteps: 0, steps: 4 }), '0/4', 'zero confident is a real value, not blank');
  assert.match(fn({ steps: 11 }), /—/, 'a run from before capture shows a dash');
  assert.match(fn({ confidentSteps: 3 }), /—/, 'no step count means no rate');
});

// ---- calibration: does the confidence score predict accuracy? --------------
// The functions are extracted and run, so the arithmetic is checked — not just
// the presence of the code.
async function calibFns() {
  const src = await readFile(new URL('../history.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const CAL_MIN_N'), src.indexOf('function calibHtml'));
  return new Function(`${block}; return { calibration, calibVerdict, CAL_BANDS, CAL_MIN_N };`)();
}

const stepRun = (bands, flags) => ({ confidenceBands: bands, jevFlags: flags });

test('calibration: tallies hits and misses per band', async () => {
  const { calibration } = await calibFns();
  const c = calibration([
    stepRun(['high', 'high', 'low', 'low', 'medium'], [true, true, false, true, false]),
  ]);
  assert.equal(c.acc.get('high').n, 2);
  assert.equal(c.acc.get('high').right, 2);
  assert.equal(c.acc.get('low').n, 2);
  assert.equal(c.acc.get('low').right, 1);
  assert.equal(c.acc.get('medium').n, 1);
  assert.equal(c.acc.get('medium').right, 0);
  assert.equal(c.steps, 5, 'every graded step is counted once');
});

test('calibration: a silent answer is neither a hit nor a miss', async () => {
  // null means Jev gave no usable answer — no prediction was made. Counting it
  // as a miss would slander the score; as a hit, it would flatter it.
  const { calibration } = await calibFns();
  const c = calibration([stepRun(['high', 'high', 'high'], [true, null, null])]);
  assert.equal(c.acc.get('high').n, 1, 'the nulls are excluded from the denominator');
  assert.equal(c.acc.get('high').right, 1);
});

test('calibration: silence is not counted as low confidence either', async () => {
  const { calibration } = await calibFns();
  const c = calibration([stepRun(['unknown', 'unknown'], [null, null])]);
  assert.equal(c.acc.get('unknown').n, 0);
  assert.equal(c.steps, 0);
});

test('calibration: runs without confidence data are excluded, never zeroed', async () => {
  const { calibration } = await calibFns();
  const c = calibration([{ steps: 12 }, stepRun(['high'], [true])]);
  assert.equal(c.used, 1, 'only the run with data is used');
  assert.equal(c.skipped, 1);
  assert.equal(c.acc.get('high').n, 1, 'the silent run contributes nothing');
});

test('calibration: pre-override runs fall back to stepFlags as Jev\'s own moves', async () => {
  // Before the override existed, every move applied WAS Jev's own move, so the
  // stored stepFlags are its own correctness. That is recoverable history.
  const { calibration } = await calibFns();
  const c = calibration([{ confidenceBands: ['high', 'low'], stepFlags: [true, false] }]);
  assert.equal(c.acc.get('high').right, 1);
  assert.equal(c.acc.get('low').n, 1);
  assert.equal(c.acc.get('low').right, 0);
});

test('calibration: the fallback is refused once a run has verdicts', async () => {
  // With verdicts present, stepFlags grade the move we PLAYED — and a red step
  // always plays the correct move. Trusting it would score low confidence at
  // 100% for exactly the reason we stopped trusting it.
  const { calibration } = await calibFns();
  const c = calibration([{
    confidenceBands: ['high', 'low'], stepFlags: [true, true], stepVerdicts: ['green', 'red'],
  }]);
  assert.equal(c.acc.get('high').n, 0, 'stepFlags are not used as a stand-in');
  assert.equal(c.acc.get('low').n, 0);
});

test('calibration: a short array never reads past its end', async () => {
  const { calibration } = await calibFns();
  const c = calibration([{ confidenceBands: ['high', 'high', 'high'], jevFlags: [true] }]);
  assert.equal(c.acc.get('high').n, 1, 'aligned by position, stopping at the shorter array');
});

test('calibration: an unrecognised band is ignored, not invented', async () => {
  const { calibration } = await calibFns();
  const c = calibration([stepRun(['high', 'bogus'], [true, true])]);
  assert.equal(c.steps, 1);
  assert.equal(c.acc.get('high').n, 1);
});

test('verdict: a perfect record below the sample threshold is SUGGESTIVE, not reliable', async () => {
  const { calibration, calibVerdict, CAL_MIN_N } = await calibFns();
  const c = calibration([stepRun(Array(5).fill('high'), Array(5).fill(true))]);
  const v = calibVerdict(c);
  assert.equal(v.tone, 'thin', 'no misses, but too few to conclude');
  assert.match(v.head, /5\/5/);
  assert.match(v.body, new RegExp(String(CAL_MIN_N)), 'it names the threshold it has not met');
  assert.match(v.body, /not yet conclusive/);
});

test('verdict: a perfect record at the threshold IS called reliable', async () => {
  const { calibration, calibVerdict, CAL_MIN_N } = await calibFns();
  const c = calibration([stepRun(Array(CAL_MIN_N).fill('high'), Array(CAL_MIN_N).fill(true))]);
  const v = calibVerdict(c);
  assert.equal(v.tone, 'good');
  assert.match(v.head, /right every time/);
  assert.match(v.body, /reliable/);
});

test('verdict: one miss at high confidence is called out, whatever the sample', async () => {
  const { calibration, calibVerdict } = await calibFns();
  const flags = [...Array(29).fill(true), false];
  const v = calibVerdict(calibration([stepRun(Array(30).fill('high'), flags)]));
  assert.equal(v.tone, 'bad', 'a confident move is not a guarantee');
  assert.match(v.head, /wrong 1 of 30/);
});

test('verdict: no confident steps means nothing to conclude', async () => {
  const { calibration, calibVerdict } = await calibFns();
  const v = calibVerdict(calibration([]));
  assert.equal(v.tone, 'none');
  assert.match(v.head, /No confident steps/);
});

test('verdict: it reports whether the score actually SEPARATES high from low', async () => {
  const { calibration, calibVerdict } = await calibFns();
  const separated = calibVerdict(calibration([
    stepRun(['high', 'high', 'low', 'low'], [true, true, false, false]),
  ]));
  assert.match(separated.body, /does separate the two/);

  // A score that points the wrong way is worse than no score, and must say so.
  const inverted = calibVerdict(calibration([
    stepRun(['high', 'high', 'low', 'low'], [false, false, true, true]),
  ]));
  assert.match(inverted.body, /wrong way/);

  const flat = calibVerdict(calibration([
    stepRun(['high', 'high', 'low', 'low'], [true, false, true, false]),
  ]));
  assert.match(flat.body, /does not separate/);
});

test('calibration: the page renders the block, and the table has the columns', async () => {
  const html = await readFile(new URL('../history.html', import.meta.url), 'utf8');
  assert.match(html, /id="calib-grid"/, 'the calibration block is on the page');
  assert.match(html, /id="calib"/);
  const js = await readFile(new URL('../history.js', import.meta.url), 'utf8');
  assert.match(js, /calibHtml\(filtered\)/, 'and it is rendered from the filtered runs');
  assert.match(js, /JEV'S OWN moves only/, 'the doc explains why it is Jev own moves, not the walk played');
});
