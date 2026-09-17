// test/policy.test.mjs — the policy-mode game loop (ask → apply → ask).
//
//  1. regression: the recorded LIVE run that started this whole job. Jev was
//     asked for the WHOLE path in one call (plan mode); per-move answers
//     collapsed, confidence ~0.3, and the walk punched into a wall at step 4.
//     Replayed verbatim, so the failure is pinned down even without a key.
//  2. policy mode against the local STUB (a near-perfect driver) on easy /
//     medium / hard grids and a weighted city: it must REACH D and pass the
//     referee, no matter the collapse trap of the old plan mode.
//  3. scripted transports: stuck, exhausted-cap, and one-reversal mechanics
//     are exercised deterministically, plus unit checks on the builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPolicyGame, legalNeighbours, keyOf, choiceProbability, stepArgmax,
  buildPolicyGridState, buildPolicyNavState, buildGridState, buildGridQuestions,
  buildPolicyGridQuestions, buildPolicyNavQuestions, buildPolicyBody, answerMoves,
} from '../lib/jev.js';
import { makeGridBoard, makeCityBoard } from '../lib/board.js';
import { createTransport, memoryStorage } from '../lib/transport.js';
import { verdict, verdictWeighted } from '../lib/referee.js';
import { policyMoveAnswer } from '../server.mjs';
import { startServer, stopServer } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RECORDED = path.join(
  __dirname, '..', 'fixtures', 'recorded',
  'd2734370d38e34dcc980c9bc92a6488dbd5f01f9b0f16c249ceac796ee0a30c3.live.json',
);
const hasRecording = fs.existsSync(RECORDED);

// ---- board reconstruction for a recorded request state ----------------------
function stateBoard(state) {
  const rows = state.grid.map((r) => [...r]);
  const find = (ch) => {
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < rows[r].length; c++)
        if (rows[r][c] === ch) return { r, c };
    return null;
  };
  const cell = (p, fallback) => {
    if (!p) return fallback;
    return { r: p.row ?? p.r, c: p.col ?? p.c };
  };
  return {
    R: rows.length, C: rows[0].length, rows,
    src: cell(state.source, find('S')), dst: cell(state.destination, find('D')),
    weights: Array.isArray(state.weights) ? state.weights : null,
    weightless: state.weightless ?? !Array.isArray(state.weights),
  };
}

/** Build a {R, C, rows, src, dst} board from ASCII strings. */
function boardOf(rows) {
  const R = rows.length, C = rows[0].length;
  const find = (ch) => {
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        if (rows[r][c] === ch) return { r, c };
    return null;
  };
  return { R, C, rows: rows.map((r) => [...r]), src: find('S'), dst: find('D'), weightless: true };
}

const DIRV = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

// ---- scripted transports ----------------------------------------------------
function planTransport(plans) {
  let call = 0;
  return {
    mode: 'script',
    async ask({ state, questions }) {
      const plan = plans[Math.min(call, plans.length - 1)];
      call++;
      const answers = {};
      for (const id of Object.keys(questions)) {
        if (id === 'reachable') answers[id] = { type: 'noul', noul: 0.99 };
        else if (id === 'path_length') answers[id] = { type: 'choice', choice: '6-10', probabilities: { '6-10': 0.9 }, confidence: 0.9 };
        else if (id === 'maze_difficulty') answers[id] = { type: 'score', score: 2, probabilities: { '2': 0.7 }, confidence: 0.7 };
        else if (id === 'cost_band') answers[id] = { type: 'choice', choice: '21-40', probabilities: { '21-40': 0.9 }, confidence: 0.9 };
        else if (id === 'eta_band') answers[id] = { type: 'choice', choice: '10–20 min', probabilities: { '10–20 min': 0.9 }, confidence: 0.9 };
        else if (id === 'route_difficulty') answers[id] = { type: 'score', score: 2, probabilities: { '2': 0.7 }, confidence: 0.7 };
        else if (id.startsWith('move_')) answers[id] = { type: 'noul', noul: answerNoul(plan, state, id) };
        else answers[id] = { type: 'noul', noul: 0.5 };
      }
      return { ok: true, body: { answers, mode: 'stub', _ms: 2, _cost_usd: 0.000001, _questions: Object.keys(questions).length } };
    },
  };
}

function answerNoul(plan, state, id) {
  if (plan && typeof plan.state === 'function') return plan.state(state, id);
  const dir = id.slice(5);
  return plan?.[dir] ?? 0.1;
}

// ---------------------------------------------------------------------------
// 1 · the recorded failure, replay-locked
// ---------------------------------------------------------------------------
test('regression: the recorded live run (plan mode) walks into a wall — replay-locked', { skip: hasRecording ? false : 'fixture not recorded in this environment' }, () => {
  const rec = JSON.parse(fs.readFileSync(RECORDED, 'utf8'));
  const board = stateBoard(rec.request.state);
  const moves = answerMoves(rec.response.answers);
  assert.equal(moves.length, 64, 'the recorded answers carry 64 move questions');

  const confs = Object.entries(rec.response.answers)
    .filter(([k, a]) => k.startsWith('move_'))
    .map(([, a]) => Number(a.confidence) || 0);
  assert.ok(confs.length > 0);
  const mean = confs.reduce((s, n) => s + n, 0) / confs.length;

  const v = verdict(board, moves);
  assert.equal(v.reached, false, 'plan mode did not reach D on the 16×16 Hard board');
  assert.equal(v.walk.hitWall, true, 'the collapsed answer punched into a wall');
  assert.equal(v.walk.steps, 3, 'the walk died attempting move 4 into the recorded (4,0) wall — 3 clean steps, then the crash');
  assert.ok(mean < 0.5, `per-move confidence was collapsed (mean ${mean.toFixed(2)}) — the model itself doubted the global-plan ask`);
});

// ---------------------------------------------------------------------------
// 2 · policy mode against the local stub on real boards
// ---------------------------------------------------------------------------
test('policy mode vs the stub reaches D on Easy/Medium/Hard grids and passes the referee', async () => {
  const ctx = await startServer({});
  try {
    const transport = createTransport({ base: `${ctx.base}/`, storage: memoryStorage() });
    for (const diff of ['easy', 'medium', 'hard']) {
      const board = makeGridBoard(diff);
      const game = await runPolicyGame({ board, transport, weighted: false });
      assert.equal(game.outcome, 'reached', `${diff}: stub policy reached D`);
      assert.equal(game.error, null);
      const v = verdict(board, game.moves);
      assert.equal(v.reached, true, `${diff}: referee confirms the walk reached D`);
      assert.ok(v.walk.hitWall === false && v.walk.outOfBounds === false, `${diff}: no walls hit`);
      assert.equal(v.steps === v.optimal, true, `${diff}: the stub driver was optimal ${v.steps}/${v.optimal}`);
      assert.ok(game.calls.length >= game.steps && game.calls.length <= game.steps * 2, `${diff}: one ask per step (two only on reversals)`);
    }
  } finally {
    await stopServer(ctx);
  }
});

test('policy mode vs the stub reaches D on a weighted city map and passes the weighted referee', async () => {
  const ctx = await startServer({});
  try {
    const transport = createTransport({ base: `${ctx.base}/`, storage: memoryStorage() });
    const board = makeCityBoard('small');
    const game = await runPolicyGame({ board, transport, weighted: true });
    assert.equal(game.outcome, 'reached', 'stub policy reached the flag');
    const v = verdictWeighted(board, game.moves);
    assert.equal(v.reached, true, 'referee confirms reach');
    assert.equal(v.ok, true, 'stub picked the least-cost route');
  } finally {
    await stopServer(ctx);
  }
});

test('plan mode (the OLD global ask) against the stub still answers optimally on a fixed board', async () => {
  const ctx = await startServer({});
  try {
    const board = boardOf(['S...#', '..##D', '..##.', '.....']);
    const payload = { state: buildGridState(board), questions: buildGridQuestions(board) };
    const res = await fetch(`${ctx.base}/api/jev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const moves = answerMoves(body.answers);
    const v = verdict(board, moves);
    assert.equal(v.reached, true, 'stub plan answers form a valid path');
    assert.equal(v.steps === v.optimal, true, `plan mode is optimal (${v.steps}/${v.optimal})`);
  } finally {
    await stopServer(ctx);
  }
});

// ---------------------------------------------------------------------------
// 3 · scripted mechanics: stuck, exhausted, single reversal
// ---------------------------------------------------------------------------
test('stuck: every legal neighbour already visited ends the run honestly (no backtracking)', async () => {
  const board = boardOf(['S.', '##', 'D.']);
  const transport = planTransport([{ state: () => 0.5 }]);
  const game = await runPolicyGame({ board, transport });
  assert.equal(game.outcome, 'stuck');
  assert.equal(game.reached, false);
  assert.equal(game.calls.length, 1, 'one ask before the dead end');
  assert.deepEqual(game.moves, ['right']);
  assert.equal(game.error, null);
});

test('exhausted: hitting the 4×(R+C) cap without D and without getting stuck', async () => {
  // 3×5 open board. The scripted answer shuttles the walker between the
  // D-adjacent cells (1,2)↔(2,2): fresh cells (0,2),(1,3) and the goal
  // itself stay unvisited, so the run is neither reached nor stuck and must
  // stop at the 32-step cap.
  const board = boardOf(['S....', '.....', '...D.']);
  const plans = new Map([
    ['0,0', 'down'], ['1,0', 'right'], ['1,1', 'right'], ['1,2', 'down'], ['2,2', 'up'],
  ]);
  const transport = planTransport([{
    state(appState, id) {
      const pos = appState.position;
      const plan = plans.get(keyOf(pos.row, pos.col));
      const dir = id.slice(5);
      const [dr, dc] = DIRV[dir] || [0, 0];
      const tr = pos.row + dr, tc = pos.col + dc;
      if (dir === plan) return 0.95;
      if (appState.grid[tr]?.[tc] === 'D') return 0.01;
      return 0.1;
    },
  }]);
  const game = await runPolicyGame({ board, transport });
  assert.equal(game.outcome, 'exhausted');
  assert.equal(game.reached, false);
  assert.equal(game.steps, game.maxSteps, 'ran the full cap');
  assert.equal(game.steps, 4 * (board.R + board.C));
  assert.ok(game.reversals > 0, 'the shuttling used single-step reversals');
  assert.equal(game.calls.length, game.steps + game.reversals, 'one ask per clean step + a re-ask per reversal');
});

test('one reversal: an ask that would step back re-asks ONCE with the reversal note, then applies', async () => {
  const board = boardOf(['SD', '..']);
  const transport = planTransport([
    { up: 0.05, down: 0.95, left: 0.05, right: 0.05 },   // step 1: go down
    { up: 0.95, right: 0.05 },                           // step 2 ask 1: picks the visited cell above
    { up: 0.95, right: 0.05 },                           // step 2 ask 2: re-asks, applies it
    { down: 0.05, right: 0.95 },                         // step 3: finally right onto D
  ]);
  const game = await runPolicyGame({ board, transport });
  assert.equal(game.outcome, 'reached');
  assert.equal(game.reversals, 1);
  assert.deepEqual(game.reversedDirs, ['2:up']);
  assert.equal(game.calls.length, 4);
  assert.deepEqual(game.moves, ['down', 'up', 'right']);
  const v = verdict(board, game.moves);
  assert.equal(v.reached, true);
  assert.equal(v.ok, false, 'the 3-step detour is non-optimal (optimal is 1)');
});

// ---------------------------------------------------------------------------
// 4 · unit checks on the builders
// ---------------------------------------------------------------------------
test('legalNeighbours returns in-bounds, non-wall cells in DIRS order', () => {
  const board = boardOf(['S.#', '...', '#.D']);
  assert.deepEqual(legalNeighbours(board, 0, 0).map((n) => n.dir), ['down', 'right']);
  assert.deepEqual(legalNeighbours(board, 1, 1).map((n) => n.dir), ['up', 'down', 'left', 'right']);
  assert.deepEqual(legalNeighbours(board, 2, 2).map((n) => n.dir), ['up', 'left']);
});

test('choiceProbability reads noul, choice probabilities, or confidence, clamped to 0..1', () => {
  assert.equal(choiceProbability({ type: 'noul', noul: 0.42 }), 0.42);
  assert.equal(choiceProbability({ type: 'choice', choice: 'a', probabilities: { a: 0.9 } }), 0.9);
  assert.equal(choiceProbability({ type: 'choice', choice: 'a', probabilities: { a: 0.9 }, confidence: 0.2 }), 0.9);
  assert.equal(choiceProbability({ type: 'score', confidence: 0.7 }), 0.7);
  assert.equal(choiceProbability({ noul: 1.4 }), 1);
  assert.equal(choiceProbability({ noul: -1 }), 0);
  assert.equal(choiceProbability(null), 0);
});

test('stepArgmax picks the max-probability candidate, first on ties', () => {
  const candidates = [
    { dir: 'up', row: 0, col: 1 },
    { dir: 'down', row: 2, col: 1 },
    { dir: 'left', row: 1, col: 0 },
    { dir: 'right', row: 1, col: 2 },
  ];
  const answers = {
    move_up: { type: 'noul', noul: 0.2 },
    move_down: { type: 'noul', noul: 0.7 },
    move_left: { type: 'noul', noul: 0.4 },
    move_right: { type: 'noul', noul: 0.4 },
  };
  const picked = stepArgmax(candidates, answers);
  assert.equal(picked.dir, 'down');
  assert.equal(picked.p, 0.7);
  const tie = stepArgmax(candidates, { move_up: { noul: 0.5 }, move_down: { noul: 0.5 }, move_left: { noul: 0.5 }, move_right: { noul: 0.5 } });
  assert.equal(tie.dir, 'up', 'ties resolve to the first candidate in DIRS order');
  assert.equal(stepArgmax(candidates, {}), null);
});

test('policy state builders expose position, visited, step, cap and reversal', () => {
  // A fixed board, not a random one: this asserts serialisation, and a random
  // grid would make the cell-content check flaky.
  const board = boardOf(['.....', '.....', '.....', '.....', '....D']);
  board.src = { r: 0, c: 0 };
  const args = { r: 3, c: 4, visited: [{ row: 3, col: 4 }], step: 2, maxSteps: 64, reversal: 'left' };
  const g = buildPolicyGridState(board, args);
  assert.equal(g.task, 'grid_policy');
  assert.deepEqual(g.position, { row: 3, col: 4 });
  assert.equal(g.reversal, 'left');
  assert.equal(g.maxSteps, 64);
  assert.ok(g.grid[3][4] === '.', 'grid serialised from the board');

  const n = buildPolicyNavState(makeCityBoard('small'), args);
  assert.equal(n.task, 'navigation_policy');
  assert.equal(n.reversal, 'left');
  assert.ok(Array.isArray(n.weights[0]) && typeof n.weights[0][0] === 'number');
});

test('policy question builders fan out one move_<dir> per candidate, extras only on first step', () => {
  const board = makeGridBoard('easy');
  const candidates = legalNeighbours(board, board.src.r, board.src.c);
  const q1 = buildPolicyGridQuestions(board, candidates, { r: 0, c: 0, firstStep: true });
  const expected1 = ['reachable', 'path_length', 'maze_difficulty', ...candidates.map((c) => `move_${c.dir}`)].sort();
  assert.deepEqual(Object.keys(q1).sort(), expected1);
  const q2 = buildPolicyGridQuestions(board, candidates, { r: 0, c: 0, firstStep: false });
  assert.equal(q2.reachable, undefined, 'extras only once');
  assert.equal(q2.move_down.type, 'noul');
  assert.equal(q2.move_down.instructions.includes('dead end'), true);
  assert.equal(q1.move_down.instructions.includes('row 0, col 0'), true);

  const n1 = buildPolicyNavQuestions(board, candidates, { r: 0, c: 0, firstStep: true });
  const expectedN = ['reachable', 'cost_band', 'eta_band', 'route_difficulty', ...candidates.map((c) => `move_${c.dir}`)].sort();
  assert.deepEqual(Object.keys(n1).sort(), expectedN);
  assert.equal(n1.move_down.instructions.includes('congestion weight'), true);
});

test('policyMoveAnswer (stub driver): route-following is 0.95, illegal is 0.01, visited is penalised, off-route is low', () => {
  const state = {
    grid: ['S...', '....', '...D'],
    source: { row: 0, col: 0 }, destination: { row: 2, col: 3 },
    position: { row: 0, col: 0 }, visited: [{ row: 0, col: 0 }],
  };
  const route = [
    { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 },
    { row: 0, col: 3 }, { row: 1, col: 3 }, { row: 2, col: 3 },
  ];
  assert.equal(policyMoveAnswer(state, 'right', route), 0.95, 'next cell on the route');
  assert.equal(policyMoveAnswer(state, 'up', route), 0.01, 'out of bounds');
  const off = policyMoveAnswer(state, 'down', route);
  assert.ok(off > 0.05 && off < 0.95, `off-route but open is between floor and route (${off})`);
  assert.equal(policyMoveAnswer(state, 'down', null), 0.05, 'no route reference → neutral floor');
  const back = { ...state, position: { row: 0, col: 1 }, visited: [{ row: 0, col: 0 }, { row: 0, col: 1 }] };
  assert.equal(policyMoveAnswer(back, 'left', route), 0.01, 'target already visited → clamped to the floor');
});

test('buildPolicyBody: one typed move_<n> per applied step + first-step extras + honest meters', () => {
  const game = {
    applied: [
      { step: 1, dir: 'right', confidence: 0.9, probabilities: { right: 0.9, down: 0.1 } },
      { step: 2, dir: 'down', confidence: 0.7, probabilities: { down: 0.7, up: 0.3 } },
    ],
    calls: [
      { step: 1, ask: 1, firstStep: true, res: { answers: { reachable: { type: 'noul', noul: 0.99 }, move_right: { type: 'noul', noul: 0.9 }, move_down: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 300 }, _ms: 5, _cost_usd: 0.0000126, _questions: 5 } },
      { step: 2, ask: 1, firstStep: false, res: { answers: { move_down: { type: 'noul', noul: 0.7 }, move_up: { type: 'noul', noul: 0.3 } }, usage: { input_tokens: 100 }, _ms: 4, _cost_usd: 0.0000042, _questions: 2 } },
    ],
    moves: ['right', 'down'], steps: 2, maxSteps: 64,
    reversals: 0, reversedDirs: [],
    totalMs: 9, lastMs: 4,
    totalCostUsd: 0.0000168, totalQuestions: 7, lastQuestions: 2,
    outcome: 'reached', reached: true, error: null,
  };
  const body = buildPolicyBody(game);
  assert.deepEqual(Object.keys(body.answers).sort(), ['move_1', 'move_2', 'reachable'].sort(), 'extras once, no move_* inner ids leaked');
  assert.equal(body.answers.move_1.type, 'choice');
  assert.equal(body.answers.move_1.choice, 'right');
  assert.equal(body.answers.move_1.probabilities.right, 0.9);
  assert.equal(body.answers.move_2.confidence, 0.7);
  assert.equal(body.answers.reachable.noul, 0.99);
  assert.equal(body.usage.input_tokens, 400);
  assert.equal(body._ms, 9);
  assert.equal(body._last_ms, 4);
  assert.equal(body._cost_usd, 0.0000168);
  assert.equal(body._questions, 7);
  assert.equal(body._calls, 2);
  assert.equal(body._steps, 2);
  assert.equal(body._maxSteps, 64);
  assert.equal(body._outcome, 'reached');
  assert.equal(body._reversals, 0);
});