// test/board.test.mjs — board generation produces playable, sane boards for
// both skins (sanitised by the verification-only referee).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGridBoard, makeCityBoard, GRID_PRESETS, MAP_SIZES } from '../lib/board.js';
import { boardQuality } from '../lib/referee.js';

test('grid boards: correct shape, symbols, and always solvable', () => {
  for (const key of Object.keys(GRID_PRESETS)) {
    const b = makeGridBoard(key);
    assert.equal(b.R, GRID_PRESETS[key].R);
    assert.equal(b.C, GRID_PRESETS[key].C);
    assert.equal(b.rows[0][0], 'S');
    assert.equal(b.rows[b.R - 1][b.C - 1], 'D');
    assert.equal(boardQuality(b).solvable, true, `${key} solvable`);
    assert.equal(b.rows.flat().filter((ch) => ch === '#').length > 0, true, `${key} has walls`);
  }
});

test('city boards: weights in 1..5, blocks + a park, solvable', () => {
  for (const key of Object.keys(MAP_SIZES)) {
    const b = makeCityBoard(key);
    assert.equal(b.R, MAP_SIZES[key].R);
    assert.equal(b.C, MAP_SIZES[key].C);
    assert.equal(b.rows[0][0], 'S');
    assert.equal(b.rows[b.R - 1][b.C - 1], 'D');
    for (let r = 0; r < b.R; r++) {
      for (let c = 0; c < b.C; c++) {
        if (b.rows[r][c] === '.') {
          const w = b.weights[r][c];
          assert.ok(w >= 1 && w <= 5, `road cell weight in 1..5 (got ${w}) at ${r},${c}`);
        }
        if (['S', 'D'].includes(b.rows[r][c])) {
          assert.equal(b.weights[r][c], 0, `start/goal cells are not paid at ${r},${c}`);
        }
      }
    }
    assert.equal(b.rows.join('').includes('P'), true, `${key} has a park`);
    assert.equal(b.rows.join('').includes('#'), true, `${key} has building blocks`);
    assert.equal(boardQuality(b).solvable, true, `${key} solvable`);
  }
});

test('board objects are fresh each call (the caller may mutate weights)', () => {
  const a = makeCityBoard('small');
  const b = makeCityBoard('small');
  a.weights[0][1] = 99;
  assert.notEqual(b.weights[0][1], 99);
});