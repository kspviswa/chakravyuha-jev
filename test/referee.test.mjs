// test/referee.test.mjs — referee.js is verification-only; these unit tests
// pin down the three exports app.js relies on: shortestPathLength, walkPath,
// verdict (plus the boardQuality helper used for board-generation sanity).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shortestPathLength,
  walkPath,
  verdict,
  boardQuality,
  inBounds,
  isOpen,
} from '../public/referee.js';

function mk(rows, src, dst) {
  const R = rows.length;
  const C = rows[0].length;
  const s = src || [0, 0];
  const d = dst || [R - 1, C - 1];
  return { R, C, rows, src: { r: s[0], c: s[1] }, dst: { r: d[0], c: d[1] } };
}

const OPEN_3 = mk(['S..', '...', '..D']);
const OPEN_5 = mk(['S....', '.....', '.....', '.....', '....D']);

test('shortestPathLength: returns the minimal move count on an open grid', () => {
  assert.equal(shortestPathLength(OPEN_3), 4); // (0,0) -> (2,2)
  assert.equal(shortestPathLength(OPEN_5), 8); // (0,0) -> (4,4)
});

test('shortestPathLength: routes around walls', () => {
  const b = mk(['S.#', '...', '#.D']);
  assert.equal(shortestPathLength(b), 4); // S - (0,1) - (1,1) - (2,1) - D
});

test('shortestPathLength: unreachable destination is null', () => {
  const b = mk(['S.#', '###', '##D']);
  assert.equal(shortestPathLength(b), null);
});

test('shortestPathLength: S === D is zero moves', () => {
  const b = mk(['D']);
  assert.equal(shortestPathLength(b), 0);
});

test('walkPath: an optimal path reaches D and reports its steps', () => {
  const w = walkPath(OPEN_3, ['down', 'down', 'right', 'right']);
  assert.equal(w.reached, true);
  assert.equal(w.hitWall, false);
  assert.equal(w.outOfBounds, false);
  assert.equal(w.steps, 4);
  assert.equal(w.cells.length, 5);
  assert.deepEqual(w.cells[0], { r: 0, c: 0 });
  assert.deepEqual(w.cells[w.cells.length - 1], { r: 2, c: 2 });
});

test('walkPath: a wall collision is flagged, path stops there', () => {
  const w = walkPath(mk(['S.#', '...', '#.D']), ['right', 'right', 'down', 'down']);
  assert.equal(w.hitWall, true);
  assert.equal(w.outOfBounds, false);
  assert.equal(w.reached, false);
  assert.equal(w.cells.length, 2); // S and the open cell that preceded the wall
});

test('walkPath: walking out of bounds is flagged', () => {
  const w = walkPath(OPEN_3, ['up']);
  assert.equal(w.outOfBounds, true);
  assert.equal(w.reached, false);
});

test('walkPath: "stop" halts the walk early without penalties', () => {
  const w = walkPath(OPEN_3, ['down', 'stop', 'left']);
  assert.equal(w.hitWall, false);
  assert.equal(w.outOfBounds, false);
  assert.equal(w.steps, 1);
  assert.equal(w.reached, false); // stopped one move short of D
});

test('walkPath: unknown direction counts as a collision', () => {
  const w = walkPath(OPEN_3, ['teleport']);
  assert.equal(w.hitWall, true);
  assert.equal(w.cells.length, 1);
});

test('verdict: an optimal answer passes every check', () => {
  const v = verdict(OPEN_3, ['down', 'down', 'right', 'right']);
  assert.equal(v.ok, true);
  assert.equal(v.optimal, 4);
  assert.equal(v.checks.length, 4);
  assert.ok(v.checks.every((c) => c.pass));
});

test('verdict: a non-optimal (longer) path that still reaches D fails the minimality check', () => {
  // 5x5 open grid; a winding 10-move path reaches D but optimal is 8.
  const moves = ['right', 'down', 'left', 'down', 'right', 'right', 'down', 'right', 'right', 'down'];
  const w = walkPath(OPEN_5, moves);
  assert.equal(w.reached, true);
  assert.equal(w.steps, 10);
  const v = verdict(OPEN_5, moves);
  assert.equal(v.ok, false);
  const minimality = v.checks.find((c) => c.name === 'is the shortest path');
  assert.equal(minimality.pass, false);
  assert.match(minimality.detail, /10 vs optimal 8/);
  assert.ok(minimality.pass === (w.steps === v.optimal));
});

test('verdict: hitting a wall fails the walk checks', () => {
  const v = verdict(mk(['S.#', '...', '#.D']), ['right', 'right']);
  assert.equal(v.ok, false);
  assert.ok(v.checks.find((c) => c.name === 'never enters a wall').pass === false);
});

test('verdict: an unreachable board reports optimal null without crashing', () => {
  const b = mk(['S.#', '###', '##D']);
  const v = verdict(b, ['down']);
  assert.equal(v.optimal, null);
  assert.equal(v.ok, false);
});

test('boardQuality: solvable boards report minimumMoves, unsolvable report solvable=false', () => {
  assert.deepEqual(boardQuality(OPEN_5), { solvable: true, minimumMoves: 8 });
  const bad = mk(['S.#', '###', '##D']);
  assert.deepEqual(boardQuality(bad), { solvable: false, minimumMoves: null });
});

test('inBounds / isOpen: edge semantics', () => {
  const b = mk(['S#', '..']);
  assert.equal(inBounds(b, 0, 0), true);
  assert.equal(inBounds(b, -1, 0), false);
  assert.equal(inBounds(b, 2, 0), false);
  assert.equal(isOpen(b, 0, 0), true);
  assert.equal(isOpen(b, 0, 1), false); // wall
  assert.equal(isOpen(b, 5, 5), false); // out of bounds is not open
});