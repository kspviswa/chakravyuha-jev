// test/policy.test.mjs — the polar policy loop, end to end, with no network.
//
// policy mode is the real loop: ASK → APPLY → repeat. At each step Jev judges
// the legal next moves; the loop applies its argmax and stops honestly when it
// is stuck or out of budget. A mock upstream stands in for TypeSafe, so the
// whole LIVE path is exercised without a key and without the internet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChakraBoard, CHAKRA_PRESETS, computeStepAccuracy, shortest } from '../lib/chakra.js';
import {
  legalCandidates, chakraPathQuestions, readChain, runPolicyGame, buildPolicyBody,
} from '../lib/jev.js';

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

/** A transport that answers the WHOLE chain — move_1 … move_K — in one pass,
 *  the way the real parallel fan-out does. It walks the policy's own route to
 *  produce each answer. */
function scriptedTransport(choiceFn, { ms = 7, cost = 0.0002, tokensIn = 120, tokensOut = 30, chainLimit = null } = {}) {
  return {
    calls: 0,
    async ask({ state, questions }) {
      this.calls++;
      const b = boardFromState(state);
      const K = Object.keys(questions || {}).length || 1;
      const answers = {};
      let here = { ...state.abhimanyu };
      const visitedSet = new Set((state.visited || []).map((v) => `${v.ring},${v.sector}`));
      const limit = chainLimit === null ? K : Math.min(K, chainLimit);
      for (let k = 1; k <= limit; k++) {
        const fresh = legalCandidates(b, here.ring, here.sector)
          .filter((c) => !visitedSet.has(`${c.ring},${c.sector}`));
        if (fresh.length === 0) break;
        const choice = choiceFn(b, here, fresh, state);
        if (!choice) break;
        answers[`move_${k}`] = {
          type: 'choice',
          choice,
          probabilities: { [choice]: 0.95 },
          confidence: 0.95,
        };
        const nxt = fresh.find((c) => c.dir === choice);
        if (!nxt) break;
        here = { ring: nxt.ring, sector: nxt.sector };
        visitedSet.add(`${here.ring},${here.sector}`);
      }
      return {
        ok: true,
        body: {
          answers,
          _ms: ms,
          _cost_usd: cost,
          _questions: K,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut },
          model: 'jev-latest',
        },
      };
    },
  };
}

// ---- shortest-following policy -------------------------------------------
function shortestPick(b, here, fresh) {
  const s = shortest(b, here, b.dst);
  const next = s ? s.path[1] : null;
  if (!next) return fresh[0]?.dir || null;
  const match = fresh.find((c) => c.ring === next.ring && c.sector === next.sector);
  return match ? match.dir : fresh[0]?.dir || null;
}

// ---- inward-greedy policy -------------------------------------------------
function inwardGreedyPick(b, here, fresh) {
  const inward = fresh.find((c) => c.dir === 'inward');
  return inward ? inward.dir : fresh[0]?.dir || null;
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

test('chakraPathQuestions: ONE call asks for the whole route, move_1 … move_K', () => {
  const b = makeChakraBoard('easy', lcg(4));
  const q = chakraPathQuestions(b, { ring: b.src.ring, sector: b.src.sector, askMoves: 12 });
  const keys = Object.keys(q);
  assert.equal(keys.length, 12, 'one question per move asked for');
  assert.deepEqual(keys.slice(0, 3), ['move_1', 'move_2', 'move_3'], 'named move_k, in order');
  for (const k of keys) {
    assert.equal(q[k].type, 'choice', `${k} is a choice`);
    assert.ok(q[k].instructions.includes('quickest route'), `${k} asks for the quickest route`);
  }
  assert.ok(q.move_1.instructions.includes('move 1'), 'move_1 asks for the 1st move');
  assert.ok(q.move_12.instructions.includes('move 12'), 'move_12 asks for the 12th move');
  assert.ok(!q.next_move, 'the retired per-step question is gone');
  assert.ok(!q.reachable, 'no reachable question');
  assert.ok(!q.route_length, 'no route_length question');
});

test('chakraPathQuestions: the answer space is the four moves, generically described', () => {
  const b = makeChakraBoard('easy', lcg(5));
  const q = chakraPathQuestions(b, { ring: b.src.ring, sector: b.src.sector, askMoves: 4 });
  for (const k of Object.keys(q)) {
    assert.deepEqual(
      Object.keys(q[k].criteria).sort(),
      ['clockwise', 'counterclockwise', 'inward', 'outward'],
      `${k} offers exactly the four moves`,
    );
  }
  // move_k is taken at a cell the question does not name, so a criterion must
  // never claim a specific destination.
  assert.ok(/one ring toward the centre/.test(q.move_2.criteria.inward), 'inward is described by meaning');
  assert.ok(!/ring \d/.test(q.move_2.criteria.inward), 'no destination is baked into the criteria');
});

test('chakraPathQuestions: never uses forbidden words', () => {
  const b = makeChakraBoard('easy', lcg(6));
  const q = chakraPathQuestions(b, { ring: b.src.ring, sector: b.src.sector, askMoves: 6 });
  const allText = Object.values(q).map((x) => x.instructions).join(' ');
  assert.ok(!/a good next step/i.test(allText), 'no "a good next step"');
  assert.ok(!/should not wander/i.test(allText), 'no "should not wander"');
  assert.ok(!/toward the centre/i.test(allText), 'no radial-greedy bait');
});

test('readChain: a contiguous chain of moves, and it stops at the first gap', () => {
  const answers = {
    move_1: { type: 'choice', choice: 'inward' },
    move_2: { type: 'choice', choice: 'clockwise' },
    move_4: { type: 'choice', choice: 'outward' },
  };
  const chain = readChain(answers, 4);
  assert.deepEqual(chain.map((c) => c.dir), ['inward', 'clockwise'], 'stops at the missing move_3');
  assert.deepEqual(readChain({ move_1: { type: 'choice', choice: 'sideways' } }, 3), [], 'an unknown move ends the chain');
  assert.deepEqual(readChain({}, 3), [], 'no answers, no chain');
});

test('computeStepAccuracy: 1.0 for a perfect run', () => {
  const b = makeChakraBoard('easy', lcg(3));
  const s = shortest(b, b.src, b.dst);
  const moves = [];
  for (let i = 1; i < s.path.length; i++) {
    const prev = s.path[i - 1];
    const curr = s.path[i];
    if (curr.ring === prev.ring - 1) moves.push('inward');
    else if (curr.ring === prev.ring + 1) moves.push('outward');
    else if (curr.sector === (prev.sector + 1) % b.S) moves.push('clockwise');
    else moves.push('counterclockwise');
  }
  const acc = computeStepAccuracy(b, moves, b.src);
  assert.equal(acc, 1.0, 'perfect route has stepAccuracy 1.0');
});

// ---- the loop --------------------------------------------------------------
test('policy: shortest-following policy reaches the centre on every difficulty', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let reached = 0;
    let totalAcc = 0;
    for (let i = 0; i < 20; i++) {
      const b = makeChakraBoard(d, lcg(17 + i));
      const t = scriptedTransport(shortestPick);
      const game = await runPolicyGame({ board: b, transport: t });
      if (game.outcome === 'reached') {
        reached++;
        const acc = computeStepAccuracy(b, game.moves, game.board.src);
        if (acc !== null) totalAcc += acc;
      }
    }
    assert.ok(reached >= 18, `${d}: at least 18/20 reached with shortest policy (got ${reached})`);
  }
});

test('policy: shortest-following policy achieves stepAccuracy 1.0 on 200 boards per difficulty', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let allAcc1 = true;
    let reachedCount = 0;
    for (let i = 0; i < 200; i++) {
      const b = makeChakraBoard(d, lcg(42 + i));
      const t = scriptedTransport(shortestPick);
      const game = await runPolicyGame({ board: b, transport: t });
      if (game.outcome !== 'reached') { allAcc1 = false; continue; }
      reachedCount++;
      const acc = computeStepAccuracy(b, game.moves, game.board.src);
      if (acc !== 1.0) allAcc1 = false;
    }
    assert.ok(allAcc1, `${d}: all reached runs have stepAccuracy 1.0 (${reachedCount} reached)`);
  }
});

test('policy: inward-greedy policy fails honestly with stepAccuracy < 1', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let hasFailure = false;
    for (let i = 0; i < 20; i++) {
      const b = makeChakraBoard(d, lcg(99 + i));
      const t = scriptedTransport(inwardGreedyPick);
      const game = await runPolicyGame({ board: b, transport: t });
      if (game.outcome !== 'reached') {
        hasFailure = true;
        const acc = computeStepAccuracy(b, game.moves, game.board.src);
        if (acc !== null) assert.ok(acc < 1, `${d}: inward-greedy stepAccuracy < 1 (${acc})`);
      }
    }
    assert.ok(hasFailure, `${d}: inward-greedy produces failures`);
  }
});

test('policy: unparsed answer yields outcome unparsed, not stuck', async () => {
  const b = makeChakraBoard('easy', lcg(7));
  const t = {
    async ask({ questions }) {
      return {
        ok: true,
        body: {
          answers: { move_1: { type: 'choice', choice: 'sideways' } },
          _ms: 1, _cost_usd: 0, _questions: Object.keys(questions || {}).length,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      };
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'unparsed', 'unparseable answer → unparsed');
});

test('policy: ONE call carries the whole route (the parallel fan-out)', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(61));
    const t = scriptedTransport(shortestPick);
    const game = await runPolicyGame({ board: b, transport: t });
    assert.equal(game.outcome, 'reached');
    assert.equal(t.calls, 1, `${d}: a whole route costs exactly one call (got ${t.calls})`);
    assert.equal(game.calls.length, 1);
    assert.equal(game.chainAnswered, game.steps, `${d}: every move came back in one chain`);
    assert.equal(game.chainAgreement, 1, `${d}: a consistent chain replays completely`);
  }
});

test('policy: a chain that breaks mid-way is re-asked and the run still finishes', async () => {
  const b = makeChakraBoard('easy', lcg(63));
  const REV = { inward: 'outward', outward: 'inward', clockwise: 'counterclockwise', counterclockwise: 'clockwise' };
  const base = scriptedTransport(shortestPick);
  // Sabotage move_4 with the reverse of move_3: that always lands back on the
  // cell just left, which the fresh-only rule forbids — so the chain must break
  // there, and the loop must ask again from where it stopped.
  const t = {
    calls: 0,
    async ask(args) {
      const res = await base.ask.call(this, args);
      const m3 = res.body.answers.move_3;
      if (m3) {
        res.body.answers.move_4 = {
          type: 'choice', choice: REV[m3.choice], probabilities: {}, confidence: 0.5,
        };
      }
      return res;
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'reached', 'a broken chain does not end the run');
  assert.ok(t.calls > 1, `the loop asked again (${t.calls} calls)`);
  assert.ok(game.chainAgreement < 1, 'the agreement ratio records the break');
  assert.equal(game.chainApplied, game.steps, 'every applied move came from a chain');
});

test('policy: an illegal move in the chain is refused, not applied', async () => {
  const b = makeChakraBoard('easy', lcg(67));
  // Answer move_1 with a move that is legal somewhere but never from the start
  // on a wall: 'outward' from the outermost ring is blocked.
  const t = {
    async ask({ questions }) {
      return {
        ok: true,
        body: {
          answers: {
            move_1: { type: 'choice', choice: 'outward' },
            move_2: { type: 'choice', choice: 'outward' },
          },
          _ms: 1, _cost_usd: 0, _questions: Object.keys(questions || {}).length,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      };
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.ok(game.moves.every((m) => m !== 'outward'), 'an outward move off the outer ring is never applied');
  assert.equal(game.chainAgreement, 0, 'nothing survived the replay');
});

test('policy: a transport error ends the run as an error', async () => {
  const b = makeChakraBoard('easy', lcg(43));
  const t = { async ask() { return { ok: false, error: { code: 'no_key', message: 'BYOK' } }; } };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'error');
  assert.equal(game.error.code, 'no_key');
  assert.equal(game.moves.length, 0);
});

test('policy: exhausting the step budget never fires under fresh-only options', async () => {
  for (let i = 0; i < 10; i++) {
    const b = makeChakraBoard('easy', lcg(100 + i));
    const t = scriptedTransport(shortestPick);
    const game = await runPolicyGame({ board: b, transport: t });
    assert.ok(game.outcome === 'reached' || game.outcome === 'stuck',
      `got ${game.outcome}, not exhausted`);
  }
});

test('policy: buildPolicyBody reports summed tokens', async () => {
  const b = makeChakraBoard('easy', lcg(29));
  const t = scriptedTransport(shortestPick, { tokensIn: 80, tokensOut: 20 });
  const game = await runPolicyGame({ board: b, transport: t });
  const body = buildPolicyBody(game);
  assert.equal(body.usage.input_tokens, 80 * game.calls.length);
  assert.equal(body.usage.output_tokens, 20 * game.calls.length);
  assert.ok(body.usage.output_tokens > 0);
});

// ---- 200-board regression runs -------------------------------------------
test('regression: shortest-following mock reaches 100% of 200 boards per difficulty with stepAccuracy 1.0', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let reached = 0;
    let allAcc1 = true;
    for (let i = 0; i < 200; i++) {
      const b = makeChakraBoard(d, lcg(200 + i));
      const t = scriptedTransport(shortestPick);
      const game = await runPolicyGame({ board: b, transport: t });
      if (game.outcome !== 'reached') continue;
      reached++;
      const acc = computeStepAccuracy(b, game.moves, game.board.src);
      if (acc !== 1.0) allAcc1 = false;
    }
    assert.equal(reached, 200, `${d}: 200/200 reached with shortest-following policy`);
    assert.ok(allAcc1, `${d}: all stepAccuracy === 1.0`);
  }
});

test('regression: inward-greedy mock fails honestly with stepAccuracy < 1', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let foundStuckOrUnparsed = false;
    for (let i = 0; i < 50; i++) {
      const b = makeChakraBoard(d, lcg(500 + i));
      const t = scriptedTransport(inwardGreedyPick);
      const game = await runPolicyGame({ board: b, transport: t });
      if (game.outcome === 'stuck' || game.outcome === 'unparsed') {
        foundStuckOrUnparsed = true;
        const acc = computeStepAccuracy(b, game.moves, game.board.src);
        if (acc !== null) assert.ok(acc < 1, `${d}: stepAccuracy ${acc} < 1`);
      }
    }
    assert.ok(foundStuckOrUnparsed, `${d}: inward-greedy produces honest failures`);
  }
});

// ---- presets ---------------------------------------------------------------
test('obstacles off: a pure wall maze has no warrior cells, and still generates', () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(11), { warriors: false });
    assert.equal(b.warriors.length, 0, `${d}: no warrior cells with obstacles off`);
    assert.ok(shortest(b, b.src, b.dst), `${d}: the centre is still reachable`);
    assert.ok(b.openRadial.length > 0 && b.openCirc.length > 0, `${d}: the walls are still there`);
  }
});

test('obstacles off: the loop reaches the centre with the shortest policy', async () => {
  const b = makeChakraBoard('easy', lcg(13), { warriors: false });
  const t = scriptedTransport(shortestPick);
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'reached', 'a warrior-free maze is still winnable');
  assert.equal(game.chainAgreement, 1, 'and consistent in one pass');
});

test('presets: the three difficulties are distinct and labelled', () => {
  const ds = Object.keys(CHAKRA_PRESETS);
  assert.deepEqual(ds, ['easy', 'medium', 'hard']);
  assert.ok(CHAKRA_PRESETS.easy.R < CHAKRA_PRESETS.medium.R);
  assert.ok(CHAKRA_PRESETS.medium.R < CHAKRA_PRESETS.hard.R);
  assert.ok(CHAKRA_PRESETS.easy.warriors < CHAKRA_PRESETS.hard.warriors);
  for (const d of ds) assert.ok(/ring/.test(CHAKRA_PRESETS[d].label), `${d} has a label`);
});
