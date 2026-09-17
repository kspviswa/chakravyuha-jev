// test/jev.test.mjs — the { state, questions } builders and answer parsers.
// Pure serialisation: no pathfinding, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGridState, buildGridQuestions, buildNavState, buildNavQuestions,
  answerMoves, answerCells, askJev,
} from '../lib/jev.js';

const GRID = {
  R: 3, C: 3,
  rows: ['S..', '.#.', '.D.'].map((s) => s.split('')),
  src: { r: 0, c: 0 }, dst: { r: 2, c: 1 },
};

const CITY = {
  R: 2, C: 3,
  rows: ['S.D', '...'].map((s) => s.split('')),
  weights: [[0, 9, 0], [2, 2, 2]],
  src: { r: 0, c: 0 }, dst: { r: 0, c: 2 },
};

function gridState(b) { return b.rows.map((row) => row.join('')); }

test('grid state serialises the board with legend + objective', () => {
  const s = buildGridState(GRID);
  assert.equal(s.task, 'grid_pathfinding');
  assert.deepEqual(gridState(GRID), ['S..', '.#.', '.D.']);
  assert.deepEqual(s.grid, ['S..', '.#.', '.D.']);
  assert.deepEqual(s.source, { row: 0, col: 0 });
  assert.deepEqual(s.destination, { row: 2, col: 1 });
  assert.match(s.objective, /shortest path/i);
  assert.equal(typeof s.rules, 'string');
});

test('grid questions: reachable/path_length/difficulty + one move per step', () => {
  const q = buildGridQuestions(GRID);
  assert.equal(q.reachable.type, 'noul');
  assert.equal(q.path_length.type, 'choice');
  assert.equal(q.maze_difficulty.type, 'score');
  assert.equal(q.move_1.type, 'choice');
  assert.equal(q.move_5.type, 'choice');
  assert.equal(q.move_10, undefined, 'capped at 64 moves');
  assert.equal(q.cell_1_1, undefined, 'no cell questions unless asked');
});

test('grid questions: cell_* heatmap questions appear with withCells', () => {
  const q = buildGridQuestions(GRID, true);
  assert.equal(q.cell_0_0.type, 'noul');
  assert.equal(q.cell_1_1, undefined, 'wall cell excluded');
});

test('nav state carries the weight grid and a least-cost objective', () => {
  const s = buildNavState(CITY);
  assert.equal(s.task, 'navigation_weighted');
  assert.deepEqual(s.weights, [[0, 9, 0], [2, 2, 2]]);
  assert.match(s.objective, /least-cost/i);
  assert.match(s.rules, /congestion weight/i);
});

test('nav questions: cost_band, eta_band, difficulty and moves', () => {
  const q = buildNavQuestions(CITY);
  assert.equal(q.reachable.type, 'noul');
  assert.equal(q.cost_band.type, 'choice');
  assert.equal(q.eta_band.type, 'choice');
  assert.equal(q.route_difficulty.type, 'score');
  assert.equal(q.move_1.type, 'choice');
  assert.equal(q.move_4.type, 'choice');
});

test('answerMoves: sorts move_* questions and keeps only choice answers', () => {
  const answers = {
    reachable: { type: 'noul', noul: 1 },
    move_2: { type: 'choice', choice: 'right' },
    move_10: { type: 'choice', choice: 'down' },
    move_3: { type: 'noul', noul: 0.2 },   // wrong type -> skipped
    move_1: { type: 'choice', choice: 'up' },
  };
  assert.deepEqual(answerMoves(answers), ['up', 'right', 'down']);
});

test('answerCells: maps cell_r_c answers into a heat map', () => {
  const heat = answerCells({
    cell_0_0: { type: 'noul', noul: 0.9 },
    cell_1_2: { type: 'noul', noul: 0.1 },
  });
  assert.equal(heat.get('0,0'), 0.9);
  assert.equal(heat.get('1,2'), 0.1);
});

test('askJev: a single call delegated to the transport with a default model', async () => {
  let called = null;
  const t = { ask: (p) => { called = p; return { ok: true, body: { mode: 'live' } }; } };
  const res = await askJev(t, { state: { grid: ['SD'] }, questions: {} });
  assert.equal(res.ok, true);
  assert.equal(called.model, 'jev-latest');
  assert.deepEqual(called.state, { grid: ['SD'] });
});