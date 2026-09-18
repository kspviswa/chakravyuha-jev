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
