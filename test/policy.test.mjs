// test/policy.test.mjs — the polar policy loop, end to end, with no network.
//
// policy mode is the real loop: ASK → APPLY → ASK. At each step Jev judges the
// legal next moves; the loop applies its argmax and stops honestly when it is
// stuck or out of budget. A mock upstream stands in for TypeSafe, so the whole
// LIVE path is exercised without a key and without the internet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChakraBoard, CHAKRA_PRESETS } from '../lib/chakra.js';
import {
  legalCandidates, chakraQuestions, chakraPlanState, chakraPlanQuestions,
  answerMoves, stepArgmax, choiceProbability, runPolicyGame, buildPolicyBody,
} from '../lib/jev.js';
import { chakraNeighbours, chakraShortest, chakraVerdict } from '../lib/referee.js';

const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

function boardFromState(state) {
  return {
    R: state.maze.rings,
    S: state.maze.sectors,
    centreGate: state.maze.centre_gate_sector,
    openRadial: state.open_radial,
    openCirc: state.open_circ,
    warriors: state.warriors,
    src: state.abhimanyu,
    dst: { ring: 0, sector: 0 },
  };
}

/** A transport that answers every move question with a scripted probability. */
function scriptedTransport(pick, { ms = 7, cost = 0.0002, tokensIn = 120, tokensOut = 30 } = {}) {
  return {
    calls: 0,
    async ask({ state, questions }) {
      this.calls++;
      const b = boardFromState(state);
      const here = state.abhimanyu;
      const answers = {};
      for (const nb of chakraNeighbours(b, here.ring, here.sector)) {
        answers[`move_${nb.dir}`] = { type: 'noul', noul: pick(nb, state) };
      }
      return {
        ok: true,
        body: {
          answers,
          _ms: ms,
          _cost_usd: cost,
          _questions: Object.keys(questions).length,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut },
          model: 'jev-latest',
        },
      };
    },
  };
}

/** Follows the referee — a "perfect" Jev, used to prove the loop can win. */
function perfectPick(b) {
  return (nb, state) => {
    const bb = boardFromState(state);
    const s = chakraShortest(bb, state.abhimanyu, bb.dst);
    const next = s ? s.path[1] : null;
    const good = next && nb.ring === next.ring && nb.sector === next.sector;
    return good ? 0.95 : 0.02;
  };
}

// ---- unit level ------------------------------------------------------------
test('legalCandidates: offers only moves that respect walls and warriors', () => {
  const b = makeChakraBoard('medium', lcg(2));
  for (let ring = 1; ring <= b.R; ring++) {
    for (let s = 0; s < b.S; s++) {
      for (const c of legalCandidates(b, ring, s)) {
        assert.ok(!b.warriors.some((w) => w.ring === c.ring && w.sector === c.sector),
          'never offers a warrior cell');
        assert.ok(['inward', 'outward', 'clockwise', 'counterclockwise'].includes(c.dir));
      }
    }
  }
});

test('chakraQuestions: one noul per legal move, and the fan-out only on step 1', () => {
  const b = makeChakraBoard('easy', lcg(4));
  const cands = legalCandidates(b, b.src.ring, b.src.sector);

  const later = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, step: 3 });
  const laterIds = Object.keys(later);
  assert.deepEqual(laterIds.sort(), cands.map((c) => `move_${c.dir}`).sort(),
    'a later step asks only about the moves');
  for (const id of laterIds) assert.equal(later[id].type, 'noul');

  const first = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, step: 1, firstStep: true });
  const firstIds = Object.keys(first);
  for (const extra of ['reachable', 'route_length', 'maze_difficulty', 'warriors_blocking']) {
    assert.ok(firstIds.includes(extra), `the first step also asks ${extra}`);
  }
  assert.equal(first.route_length.type, 'choice');
  assert.equal(first.maze_difficulty.type, 'score');
  assert.equal(first.reachable.type, 'noul');
});

test('chakraQuestions: the instructions name the move and the destination cell', () => {
  const b = makeChakraBoard('easy', lcg(5));
  const cands = legalCandidates(b, b.src.ring, b.src.sector);
  const q = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, step: 2 });
  for (const c of cands) {
    const text = q[`move_${c.dir}`].instructions;
    assert.ok(text.includes(`ring ${b.src.ring}`), `${c.dir} names the current ring`);
    assert.ok(text.includes('centre'), `${c.dir} mentions the goal`);
  }
});

test('chakraQuestions: a reversal note is carried into the question text', () => {
  const b = makeChakraBoard('easy', lcg(6));
  const cands = legalCandidates(b, b.src.ring, b.src.sector);
  const q = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, step: 2, reversal: 'clockwise' });
  const joined = Object.values(q).map((x) => x.instructions).join(' ');
  assert.ok(/already tried|revers/i.test(joined), 'the reversal is flagged in the ask');
});

test('stepArgmax: picks the highest-probability move, and copes with ties', () => {
  const cands = [{ dir: 'inward' }, { dir: 'clockwise' }];
  assert.equal(stepArgmax(cands, { move_inward: { type: 'noul', noul: 0.2 }, move_clockwise: { type: 'noul', noul: 0.8 } }).dir, 'clockwise');
  assert.equal(stepArgmax(cands, { move_inward: { type: 'noul', noul: 0.5 }, move_clockwise: { type: 'noul', noul: 0.5 } }).dir, 'inward', 'ties keep the first candidate');
  assert.equal(stepArgmax(cands, {}), null, 'no answers means no move');
});

test('choiceProbability: reads noul, choice probabilities and confidence alike', () => {
  assert.equal(choiceProbability({ type: 'noul', noul: 0.7 }), 0.7);
  assert.equal(choiceProbability({ type: 'choice', choice: 'b', probabilities: { a: 0.2, b: 0.6 } }), 0.6);
  assert.equal(choiceProbability({ confidence: 0.4 }), 0.4);
  assert.equal(choiceProbability(undefined), 0);
  assert.equal(choiceProbability({ type: 'noul', noul: 5 }), 1, 'clamped');
});

test('answerMoves: returns the moves in step order and drops non-choices', () => {
  const moves = answerMoves({
    move_1: { type: 'choice', choice: 'inward' },
    move_2: { type: 'noul', noul: 1 },
    move_10: { type: 'choice', choice: 'clockwise' },
  });
  assert.deepEqual(moves, ['inward', 'clockwise'], 'sorted by step, non-choices dropped');
});

// ---- the loop --------------------------------------------------------------
test('policy: a competent Jev threads the chakravyuha on every difficulty', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(17));
    const t = scriptedTransport(perfectPick(b));
    const game = await runPolicyGame({ board: b, transport: t });
    assert.equal(game.outcome, 'reached', `${d}: reached the centre`);
    const v = chakraVerdict(b, game.moves);
    assert.equal(v.steps, v.optimal, `${d}: the route is optimal (${v.steps}/${v.optimal})`);
    assert.equal(v.ok, true, `${d}: the referee passes it`);
    assert.ok(t.calls >= game.steps, `${d}: at least one call per step`);
  }
});

test('policy: the meters sum honestly across every call', async () => {
  const b = makeChakraBoard('easy', lcg(23));
  const t = scriptedTransport(perfectPick(b), { ms: 11, cost: 0.0003, tokensIn: 100, tokensOut: 25 });
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'reached');
  const n = game.calls.length;
  assert.equal(game.totalMs, 11 * n, 'total time is the sum of the calls');
  assert.equal(game.lastMs, 11);
  assert.equal(game.totalTokensIn, 100 * n, 'input tokens summed');
  assert.equal(game.totalTokensOut, 25 * n, 'output tokens summed — not hardcoded to 0');
  assert.ok(Math.abs(game.totalCostUsd - 0.0003 * game.applied.length) < 1e-12, 'cost summed per applied step');
  assert.equal(game.totalQuestions, game.calls.reduce((s, c) => s + c.res._questions, 0));
});

test('policy: buildPolicyBody reports the summed tokens, in and out', async () => {
  const b = makeChakraBoard('easy', lcg(29));
  const t = scriptedTransport(perfectPick(b), { tokensIn: 80, tokensOut: 20 });
  const game = await runPolicyGame({ board: b, transport: t });
  const body = buildPolicyBody(game);
  assert.equal(body.usage.input_tokens, 80 * game.calls.length);
  assert.equal(body.usage.output_tokens, 20 * game.calls.length,
    'regression: output_tokens used to be hardcoded to 0');
  assert.ok(body.usage.output_tokens > 0);
});

test('policy: a Jev that will not move is STUCK, not solved', async () => {
  const b = makeChakraBoard('easy', lcg(37));
  // every candidate scores 0 — the argmax still picks one, so make it wander
  // outward/counterclockwise and never inward.
  const t = scriptedTransport((nb) => (nb.dir === 'inward' ? 0.0 : 0.9));
  const game = await runPolicyGame({ board: b, transport: t });
  assert.ok(['stuck', 'exhausted'].includes(game.outcome), `honest stop, got ${game.outcome}`);
  assert.equal(game.reached, false);
  assert.ok(game.steps < 2 * b.R * b.S, 'it stopped before the cap, by getting stuck');
});

test('policy: exhausting the step budget stops the run honestly', async () => {
  const b = makeChakraBoard('easy', lcg(41));
  // a policy that oscillates: always go clockwise, forever
  const t = scriptedTransport((nb) => (nb.dir === 'clockwise' ? 0.9 : 0.01));
  const game = await runPolicyGame({ board: b, transport: t });
  assert.ok(['stuck', 'exhausted'].includes(game.outcome));
  assert.ok(game.moves.length <= game.maxSteps, 'never exceeds the cap');
  assert.equal(game.maxSteps, 2 * b.R * b.S, 'the cap is 2·R·S');
});

test('policy: a transport error ends the run as an error, with the code intact', async () => {
  const b = makeChakraBoard('easy', lcg(43));
  const t = { async ask() { return { ok: false, error: { code: 'no_key', message: 'BYOK' } }; } };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'error');
  assert.equal(game.error.code, 'no_key');
  assert.equal(game.moves.length, 0);
});

test('policy: a move that would revisit a cell is retried once with a reversal note', async () => {
  const b = makeChakraBoard('easy', lcg(47));
  let sawReversal = false;
  const t = {
    async ask({ state, questions }) {
      if (state.reversal) sawReversal = true;
      const bb = boardFromState(state);
      const answers = {};
      // Always insist on the first legal direction — that guarantees a revisit
      // on a maze with any depth at all.
      const first = chakraNeighbours(bb, state.abhimanyu.ring, state.abhimanyu.sector)[0];
      for (const nb of chakraNeighbours(bb, state.abhimanyu.ring, state.abhimanyu.sector)) {
        answers[`move_${nb.dir}`] = { type: 'noul', noul: nb.dir === first.dir ? 0.9 : 0.01 };
      }
      return { ok: true, body: { answers, _ms: 1, _cost_usd: 0, _questions: Object.keys(questions).length, usage: {} } };
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.ok(['stuck', 'exhausted', 'reached'].includes(game.outcome));
  assert.ok(game.reversals >= 1, 'the loop asked again rather than walking backwards');
  assert.ok(sawReversal, 'and it flagged the reversal in the state it sent');
});

// ---- plan mode -------------------------------------------------------------
test('plan: the global ask still produces a walkable route list', () => {
  const b = makeChakraBoard('easy', lcg(53));
  const state = chakraPlanState(b);
  const questions = chakraPlanQuestions(b);
  assert.equal(state.task, 'chakravyuha_plan');
  assert.ok(Object.keys(questions).length > 0, 'plan mode asks for the whole route');
  for (const id of Object.keys(questions)) {
    assert.ok(/^move_\d+$/.test(id), `plan question ids are move_k, got ${id}`);
  }
  const q1 = questions.move_1;
  assert.equal(q1.type, 'choice');
  assert.ok(q1.criteria.stop, 'the route may end at the centre');
  for (const dir of ['inward', 'outward', 'clockwise', 'counterclockwise']) {
    assert.ok(q1.criteria[dir], `plan criteria offer ${dir}`);
  }
});

test('plan: the plan state carries the maze but no answer', () => {
  const b = makeChakraBoard('easy', lcg(59));
  const state = chakraPlanState(b);
  assert.equal(state.maze.rings, b.R);
  assert.equal(state.abhimanyu.ring, b.src.ring);
  assert.equal(state.optimalPath, undefined);
  assert.equal(state.solution, undefined);
  assert.equal(state.answer, undefined);
  // The ask may mention the shortest route — that is what it is asking FOR.
  // What must never happen is a route being attached to it.
  assert.ok(!/"path"\s*:/.test(JSON.stringify(state)), 'no route list is attached to the ask');
});

test('presets: the three difficulties are distinct and labelled', () => {
  const ds = Object.keys(CHAKRA_PRESETS);
  assert.deepEqual(ds, ['easy', 'medium', 'hard']);
  assert.ok(CHAKRA_PRESETS.easy.R < CHAKRA_PRESETS.medium.R);
  assert.ok(CHAKRA_PRESETS.medium.R < CHAKRA_PRESETS.hard.R);
  assert.ok(CHAKRA_PRESETS.easy.warriors < CHAKRA_PRESETS.hard.warriors);
  for (const d of ds) assert.ok(/ring/.test(CHAKRA_PRESETS[d].label), `${d} has a label`);
});
