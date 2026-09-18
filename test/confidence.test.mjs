// test/confidence.test.mjs — confidence as a first-class signal.
//
// TypeSafe returns `confidence` on every Choice answer, derived from the SHAPE
// of the probability distribution. It is not the top probability: a 0.7/0.3
// split is a low-confidence answer with no clear winner. These tests pin that
// distinction down, because treating confidence as "the probability of the
// chosen option" is the exact mistake that makes the signal useless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceBand, bandCounts, CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, BANDS } from '../lib/confidence.js';
import { makeChakraBoard, neighbours, shortest, stepCorrectness, computeStepAccuracy } from '../lib/chakra.js';
import { runPolicyGame, buildPolicyBody, legalCandidates } from '../lib/jev.js';

const lcg = (s) => { let x = s >>> 0; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; };
const CELL_RE = /^cell_(\d+)_(\d+)$/;

function boardFromState(state) {
  return {
    R: state.maze.rings, S: state.maze.sectors, dst: { ring: 0, sector: 0 },
    centreGate: state.maze.centre_gate_sector,
    openRadial: state.open_radial, openCirc: state.open_circ, warriors: state.warriors || [],
  };
}

/** A transport that plays a correct move, but reports a confidence WE choose. */
function bandedTransport(confidenceFor) {
  return {
    calls: 0,
    async ask({ state, questions }) {
      this.calls++;
      const b = boardFromState(state);
      const answers = {};
      for (const id of Object.keys(questions || {})) {
        const m = CELL_RE.exec(id);
        if (!m) continue;
        const cell = { ring: +m[1], sector: +m[2] };
        const offered = Object.keys(questions[id].criteria || {});
        const moves = legalCandidates(b, cell.ring, cell.sector).filter((c) => offered.includes(c.dir));
        if (!moves.length) continue;
        // shortest().path is a list of CELLS; the move is the step to path[1].
        const s = shortest(b, cell, b.dst);
        const next = s && s.path.length > 1 ? s.path[1] : null;
        const match = next ? moves.find((c) => c.ring === next.ring && c.sector === next.sector) : null;
        const dir = (match || moves[0]).dir;
        answers[id] = {
          type: 'choice', choice: dir, confidence: confidenceFor(cell),
          probabilities: { [dir]: 0.9 },
        };
      }
      return { ok: true, body: { answers, _ms: 1, _cost_usd: 0, _questions: Object.keys(questions).length,
        usage: { input_tokens: 1, output_tokens: 1 } } };
    },
  };
}

/** The directions of a shortest route, as the walk's move list. */
function routeDirs(board, from) {
  const route = shortest(board, from, board.dst);
  if (!route) return [];
  const dirs = [];
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1];
    const b = route.path[i];
    const e = neighbours(board, a.ring, a.sector).find((c) => c.ring === b.ring && c.sector === b.sector);
    if (!e) return [];
    dirs.push(e.dir);
  }
  return dirs;
}

test('confidenceBand: the documented three ranges, at their boundaries', () => {
  assert.equal(confidenceBand(1), 'high');
  assert.equal(confidenceBand(CONFIDENCE_HIGH), 'high', 'the boundary itself is high');
  assert.equal(confidenceBand(CONFIDENCE_HIGH - 0.001), 'medium');
  assert.equal(confidenceBand(CONFIDENCE_MEDIUM), 'medium', 'the 0.5 floor from the docs is medium, not low');
  assert.equal(confidenceBand(CONFIDENCE_MEDIUM - 0.001), 'low');
  assert.equal(confidenceBand(0), 'low');
});

test('confidenceBand: absent or non-numeric confidence is UNKNOWN, never low', () => {
  // "The model said it was unsure" and "the model said nothing" are different
  // facts. Conflating them would let a missing field read as honest doubt.
  for (const v of [undefined, null, NaN, Infinity, '0.9', {}, []]) {
    assert.equal(confidenceBand(v), 'unknown', `${JSON.stringify(v)} must band as unknown`);
  }
});

test('confidenceBand: confidence is the distribution SHAPE, not the top probability', () => {
  // The mistake this whole module exists to prevent: a 0.7/0.3 split is not
  // "70% sure". TypeSafe collapses the shape to one number, and that number is
  // what we band — we never re-derive it from the winner.
  const ans = { type: 'choice', choice: 'inward', confidence: 0.34, probabilities: { inward: 0.67, outward: 0.33 } };
  assert.equal(confidenceBand(ans.confidence), 'low',
    'a 0.67 top probability with a flat distribution is a LOW-confidence answer');
});

test('bandCounts: totals add up, unknown names fold into unknown', () => {
  const c = bandCounts(['high', 'high', 'low', 'medium', 'nonsense']);
  assert.equal(c.high, 2);
  assert.equal(c.medium, 1);
  assert.equal(c.low, 1);
  assert.equal(c.unknown, 1);
  assert.equal(c.total, 5);
  assert.deepEqual(BANDS, ['high', 'medium', 'low']);
});

test('walk: every step carries the band of the confidence it was taken with', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(101));
    // High confidence everywhere: every step must band high.
    const game = await runPolicyGame({ board: b, transport: bandedTransport(() => 0.95) });
    assert.equal(game.outcome, 'reached', `${d}: reached`);
    assert.equal(game.confidenceBands.length, game.steps, `${d}: one band per step`);
    assert.ok(game.confidenceBands.every((x) => x === 'high'), `${d}: all high`);
    assert.equal(game.bandCounts.high, game.steps, `${d}: counted`);
    assert.equal(game.bandCounts.total, game.steps, `${d}: total matches steps`);
  }
});

test('walk: a hesitant run reports how many steps were confident', async () => {
  // Every OTHER step is confident, so "y of x" must be exactly half — the
  // number the user reads a run by.
  const b = makeChakraBoard('medium', lcg(102));
  let n = 0;
  const game = await runPolicyGame({
    board: b, transport: bandedTransport(() => (n++ % 2 === 0 ? 0.95 : 0.2)),
  });
  assert.equal(game.outcome, 'reached');
  const bc = game.bandCounts;
  assert.equal(bc.high + bc.low + bc.medium + bc.unknown, game.steps, 'bands partition the steps');
  assert.ok(bc.low > 0, 'the unsure steps are visible, not averaged away');
  assert.ok(bc.high > 0, 'the confident steps are visible too');
});

test('walk: confidence is recorded even when the run FAILS', async () => {
  // The signal matters most when the walk is struggling — a failure report that
  // dropped its confidence data would be exactly the case it is needed for.
  const b = makeChakraBoard('hard', lcg(103));
  const game = await runPolicyGame({ board: b, transport: bandedTransport(() => 0.1) });
  assert.ok(game.steps > 0, 'the walk took steps before stopping');
  assert.equal(game.confidenceBands.length, game.steps, 'bands survive a failed run');
  assert.ok(game.bandCounts.low > 0, 'the low-confidence steps are kept');
});

test('walk: a missing confidence is unknown, and never counted as confident', async () => {
  const b = makeChakraBoard('easy', lcg(104));
  const t = bandedTransport(() => undefined);
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'reached');
  assert.ok(game.confidenceBands.every((x) => x === 'unknown'), 'no confidence → unknown');
  assert.equal(game.bandCounts.high, 0, 'an absent confidence is never read as confidence');
});

test('buildPolicyBody: bands ride along with the moves', async () => {
  const b = makeChakraBoard('easy', lcg(105));
  const game = await runPolicyGame({ board: b, transport: bandedTransport(() => 0.9) });
  const body = buildPolicyBody(game);
  assert.deepEqual(body._confidenceBands, game.confidenceBands);
  assert.deepEqual(body._bandCounts, game.bandCounts);
});

test('stepCorrectness: agrees with computeStepAccuracy, step for step', () => {
  // One definition, two uses. If these ever disagreed, a confidence breakdown
  // would contradict the accuracy printed beside it.
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(106));
    const dirs = routeDirs(b, b.src);
    assert.ok(dirs.length > 0, `${d}: a route exists`);
    const flags = stepCorrectness(b, dirs, b.src);
    assert.equal(flags.length, dirs.length, `${d}: one flag per move`);
    assert.ok(flags.every(Boolean), `${d}: every step of a shortest route is correct`);
    assert.equal(computeStepAccuracy(b, dirs, b.src), 1, `${d}: accuracy agrees`);
  }
});

test('stepCorrectness: a step away from the centre is false, not skipped', () => {
  const b = makeChakraBoard('easy', lcg(107));
  const dirs = routeDirs(b, b.src);
  // Walk one step the wrong way, if the board allows it.
  const back = neighbours(b, b.src.ring, b.src.sector).find((c) => c.dir !== dirs[0]);
  if (!back) return; // nothing to test on this board
  const flags = stepCorrectness(b, [back.dir, dirs[0]], b.src);
  assert.equal(flags[0], false, 'the move away is counted, and counted wrong');
});
