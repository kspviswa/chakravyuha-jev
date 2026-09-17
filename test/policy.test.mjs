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
  legalCandidates, chakraQuestions, runPolicyGame, buildPolicyBody,
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

/** A transport that answers every next_move question with a scripted choice. */
function scriptedTransport(choiceFn, { ms = 7, cost = 0.0002, tokensIn = 120, tokensOut = 30 } = {}) {
  return {
    calls: 0,
    async ask({ state, questions }) {
      this.calls++;
      const b = boardFromState(state);
      const here = state.abhimanyu;
      const visited = state.visited || [];
      const visitedSet = new Set(visited.map((v) => `${v.ring},${v.sector}`));
      const candidates = legalCandidates(b, here.ring, here.sector);
      const fresh = candidates.filter((c) => !visitedSet.has(`${c.ring},${c.sector}`));
      const choice = choiceFn(b, here, fresh, state);
      const answers = {
        next_move: {
          type: 'choice',
          choice,
          probabilities: { [choice]: 0.95 },
          confidence: 0.95,
        },
      };
      return {
        ok: true,
        body: {
          answers,
          _ms: ms,
          _cost_usd: cost,
          _questions: 1,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut },
          model: 'jev-latest',
        },
      };
    },
  };
}

// ---- shortest-following policy -------------------------------------------
function shortestPick(b, here, fresh) {
  const bb = boardFromState({ abhimanyu: here, maze: { rings: b.R, sectors: b.S, centre_gate_sector: b.centreGate }, open_radial: b.openRadial, open_circ: b.openCirc, warriors: b.warriors, src: b.src, dst: { ring: 0, sector: 0 } });
  const s = shortest(b, here, bb.dst);
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

test('chakraQuestions: one next_move choice question per step', () => {
  const b = makeChakraBoard('easy', lcg(4));
  const cands = legalCandidates(b, b.src.ring, b.src.sector);
  const q = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, visited: [] });
  assert.ok(q.next_move, 'has a next_move question');
  assert.equal(q.next_move.type, 'choice');
  assert.ok(q.next_move.instructions.includes('quickest route'), 'asks for the first move of a shortest route');
  assert.ok(!q.reachable, 'no reachable question');
  assert.ok(!q.route_length, 'no route_length question');
});

test('chakraQuestions: criteria list only fresh legal moves', () => {
  const b = makeChakraBoard('easy', lcg(5));
  const cands = legalCandidates(b, b.src.ring, b.src.sector);
  const q = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, visited: [] });
  const criteriaKeys = Object.keys(q.next_move.criteria);
  for (const c of cands) {
    assert.ok(criteriaKeys.includes(c.dir), `${c.dir} is in criteria`);
  }
});

test('chakraQuestions: never uses forbidden words', () => {
  const b = makeChakraBoard('easy', lcg(6));
  const cands = legalCandidates(b, b.src.ring, b.src.sector);
  const q = chakraQuestions(b, cands, { ring: b.src.ring, sector: b.src.sector, visited: [] });
  const allText = Object.values(q).map((x) => x.instructions).join(' ');
  assert.ok(!/a good next step/i.test(allText), 'no "a good next step"');
  assert.ok(!/should not wander/i.test(allText), 'no "should not wander"');
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
    async ask({ state, questions }) {
      return {
        ok: true,
        body: {
          answers: { next_move: { type: 'choice', choice: 'sideways' } },
          _ms: 1, _cost_usd: 0, _questions: 1,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      };
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'unparsed', 'unparseable answer → unparsed');
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
test('presets: the three difficulties are distinct and labelled', () => {
  const ds = Object.keys(CHAKRA_PRESETS);
  assert.deepEqual(ds, ['easy', 'medium', 'hard']);
  assert.ok(CHAKRA_PRESETS.easy.R < CHAKRA_PRESETS.medium.R);
  assert.ok(CHAKRA_PRESETS.medium.R < CHAKRA_PRESETS.hard.R);
  assert.ok(CHAKRA_PRESETS.easy.warriors < CHAKRA_PRESETS.hard.warriors);
  for (const d of ds) assert.ok(/ring/.test(CHAKRA_PRESETS[d].label), `${d} has a label`);
});
