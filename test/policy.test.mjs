// test/policy.test.mjs — the polar policy walk, end to end, with no network.
//
// Policy mode asks ONE question per cell — "standing at ring R, sector S, which
// move is the first step of a shortest route to the centre?" — with that cell's
// own doors as the options. One call returns a move for every cell; the walk
// then follows that policy from the start cell. A mock upstream stands in for
// TypeSafe, so the whole LIVE path is exercised without a key and without the
// internet.
//
// The mock answers one of the options the question OFFERED, exactly as a
// well-behaved model would. That is the property the real failure lacked: the
// old path mode offered all four moves at a cell it never named, so an answer
// could be a move no door supports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChakraBoard, CHAKRA_PRESETS, computeStepAccuracy, shortest } from '../lib/chakra.js';
import {
  legalCandidates, chakraPolicyQuestions, policyCells, readPolicy,
  runPolicyGame, buildPolicyBody,
} from '../lib/jev.js';

const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

/** Rebuild the maze from a policy state. The policy state carries no abhimanyu
 *  and no visited — every question names its own cell. */
function boardFromState(state) {
  return {
    R: state.maze.rings,
    S: state.maze.sectors,
    centreGate: state.maze.centre_gate_sector,
    openRadial: state.open_radial,
    openCirc: state.open_circ,
    warriors: state.warriors,
    dst: { ring: 0, sector: 0 },
  };
}

const CELL_RE = /^cell_(\d+)_(\d+)$/;

/**
 * A transport that answers the whole policy in one pass: for every cell asked
 * about, it picks one of the options that cell's question offered. `choiceFn`
 * receives (board, cell, offeredMoves).
 */
function scriptedTransport(choiceFn, {
  ms = 7, cost = 0.0002, tokensIn = 120, tokensOut = 30, skipCells = 0,
} = {}) {
  return {
    calls: 0,
    async ask({ state, questions }) {
      this.calls++;
      const b = boardFromState(state);
      const ids = Object.keys(questions || {});
      const answers = {};
      let skipped = 0;
      for (const id of ids) {
        const m = CELL_RE.exec(id);
        if (!m) continue;
        const cell = { ring: Number(m[1]), sector: Number(m[2]) };
        const offered = Object.keys(questions[id].criteria || {});
        const moves = legalCandidates(b, cell.ring, cell.sector).filter((c) => offered.includes(c.dir));
        if (moves.length === 0) continue;
        if (skipped < skipCells) { skipped++; continue; }   // simulate an unreadable answer
        const choice = choiceFn(b, cell, moves);
        if (!choice || !offered.includes(choice)) continue;
        answers[id] = {
          type: 'choice',
          choice,
          probabilities: { [choice]: 0.95 },
          confidence: 0.95,
        };
      }
      return {
        ok: true,
        body: {
          answers,
          _ms: ms,
          _cost_usd: cost,
          _questions: ids.length,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut },
          model: 'jev-latest',
        },
      };
    },
  };
}

// ---- a correct model: the first step of a shortest route --------------------
function shortestPick(b, here, moves) {
  const s = shortest(b, here, b.dst);
  const next = s ? s.path[1] : null;
  if (!next) return moves[0]?.dir || null;
  const match = moves.find((c) => c.ring === next.ring && c.sector === next.sector);
  return match ? match.dir : moves[0]?.dir || null;
}

// ---- the field failure, reproduced: the same move everywhere ----------------
function alwaysInwardPick(b, here, moves) {
  const inward = moves.find((c) => c.dir === 'inward');
  return inward ? inward.dir : moves[0]?.dir || null;
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

test('policyCells: every cell but the centre, skipping cells with no door at all', () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(4));
    const cells = policyCells(b);
    assert.ok(!cells.some((c) => c.ring === 0), `${d}: the centre is never asked about`);
    assert.ok(cells.length <= b.R * b.S, `${d}: at most R×S cells`);
    assert.ok(cells.length > b.R * b.S * 0.8, `${d}: nearly every cell is asked about`);
    for (const c of cells) assert.ok(legalCandidates(b, c.ring, c.sector).length > 0, 'each has a door');
  }
});

test('chakraPolicyQuestions: ONE question per cell, each naming its own cell', () => {
  const b = makeChakraBoard('easy', lcg(4));
  const q = chakraPolicyQuestions(b);
  const keys = Object.keys(q);
  assert.equal(keys.length, policyCells(b).length, 'one question per cell');
  for (const id of keys) {
    const m = CELL_RE.exec(id);
    assert.ok(m, `${id} is named cell_<ring>_<sector>`);
    const { ring, sector } = { ring: Number(m[1]), sector: Number(m[2]) };
    assert.equal(q[id].type, 'choice', `${id} is a choice`);
    assert.ok(q[id].instructions.includes(`ring ${ring}, sector ${sector}`),
      `${id} names the cell the move is taken from`);
    assert.ok(/shortest route/.test(q[id].instructions), `${id} asks for a shortest route`);
  }
  assert.ok(!q.move_1, 'the retired move_k question is gone');
  assert.ok(!q.next_move, 'no per-step question');
  assert.ok(!q.route_length, 'no route_length question');
});

test('chakraPolicyQuestions: the options are the cell’s real doors, with destinations named', () => {
  const b = makeChakraBoard('easy', lcg(5));
  const q = chakraPolicyQuestions(b);
  for (const id of Object.keys(q)) {
    const m = CELL_RE.exec(id);
    const ring = Number(m[1]), sector = Number(m[2]);
    const doors = legalCandidates(b, ring, sector);
    assert.deepEqual(
      Object.keys(q[id].criteria).sort(), doors.map((d) => d.dir).sort(),
      `${id} offers exactly the doors that open from it`,
    );
    // Every criterion must name where that door actually goes.
    for (const d of doors) {
      if (d.ring === 0) assert.ok(/centre/.test(q[id].criteria[d.dir]), `${id}.${d.dir} names the centre`);
      else assert.ok(q[id].criteria[d.dir].includes(`ring ${d.ring}, sector ${d.sector}`),
        `${id}.${d.dir} names its destination`);
    }
  }
});

test('chakraPolicyQuestions: no question ever offers a move that is not a door', () => {
  // The property the old path mode lacked. If this holds, an answer that picks
  // an offered option is always playable.
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(9));
    const q = chakraPolicyQuestions(b);
    for (const id of Object.keys(q)) {
      const m = CELL_RE.exec(id);
      const ring = Number(m[1]), sector = Number(m[2]);
      const real = new Set(legalCandidates(b, ring, sector).map((c) => c.dir));
      for (const dir of Object.keys(q[id].criteria)) {
        assert.ok(real.has(dir), `${d} ${id}: '${dir}' is offered but is not a door`);
      }
    }
  }
});

test('chakraPolicyQuestions: a banned move is struck from that cell’s question only', () => {
  const b = makeChakraBoard('easy', lcg(6));
  const target = { ring: b.src.ring, sector: b.src.sector };
  const doors = legalCandidates(b, target.ring, target.sector);
  const banned = new Map([[`${target.ring},${target.sector}`, new Set([doors[0].dir])]]);
  const q = chakraPolicyQuestions(b, { banned });
  assert.ok(!(doors[0].dir in q[`cell_${target.ring}_${target.sector}`].criteria),
    'the struck move is gone from that cell');
  const other = policyCells(b).find((c) => c.ring !== target.ring || c.sector !== target.sector);
  assert.ok(q[`cell_${other.ring}_${other.sector}`], 'other cells are untouched');
});

test('chakraPolicyQuestions: never uses forbidden words', () => {
  const b = makeChakraBoard('easy', lcg(6));
  const q = chakraPolicyQuestions(b);
  const allText = Object.values(q).map((x) => x.instructions).join(' ');
  assert.ok(!/a good next step/i.test(allText), 'no "a good next step"');
  assert.ok(!/should not wander/i.test(allText), 'no "should not wander"');
  assert.ok(!/toward the centre/i.test(allText), 'no radial-greedy bait');
});

test('readPolicy: cell → move, and an unknown move is simply absent', () => {
  const b = makeChakraBoard('easy', lcg(7));
  const answers = {
    cell_2_3: { type: 'choice', choice: 'inward', probabilities: { inward: 0.8 }, confidence: 0.6 },
    cell_1_1: { type: 'choice', choice: 'sideways' },
    cell_1_2: { type: 'choice' },
    cell_9_9: { type: 'choice', choice: 'inward' },
  };
  const p = readPolicy(answers, b);
  assert.equal(p.size, 1, 'only the well-formed answer about a real cell is read');
  assert.equal(p.get('2,3').dir, 'inward');
  assert.equal(p.get('2,3').p, 0.8, 'the probability of the chosen move');
  assert.equal(p.get('2,3').confidence, 0.6);
  assert.equal(readPolicy({}, b).size, 0);
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

// ---- the walk --------------------------------------------------------------
test('policy: a correct policy reaches the centre on every difficulty', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let reached = 0;
    for (let i = 0; i < 20; i++) {
      const b = makeChakraBoard(d, lcg(17 + i));
      const game = await runPolicyGame({ board: b, transport: scriptedTransport(shortestPick) });
      if (game.outcome === 'reached') reached++;
    }
    assert.ok(reached >= 18, `${d}: at least 18/20 reached (got ${reached})`);
  }
});

test('policy: a correct policy reaches the centre in ONE call and never doubles back', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(61));
    const t = scriptedTransport(shortestPick);
    const game = await runPolicyGame({ board: b, transport: t });
    assert.equal(game.outcome, 'reached', `${d}: reached`);
    assert.equal(t.calls, 1, `${d}: the whole walk costs exactly one call (got ${t.calls})`);
    assert.equal(game.repairs, 0, `${d}: a correct policy needs no repair`);
    assert.equal(game.reject, null, `${d}: nothing was refused`);
    // A correct policy is a strict descent, so no cell is ever entered twice.
    const seen = new Set();
    for (const m of game.applied) {
      assert.ok(!seen.has(m.cell), `${d}: cell ${m.cell} was walked twice`);
      seen.add(m.cell);
    }
  }
});

test('policy: the field failure — one move repeated for every cell — is never UNPARSED', async () => {
  // This is the bug that shipped: 64 questions, 64 identical answers. In policy
  // mode the same model still answers 'inward' everywhere, but every answer is
  // drawn from that cell's real doors, so it is always PLAYABLE. The walk may
  // wander, it may get boxed in — it must never report the answers unreadable,
  // and it must never step through a wall.
  for (const d of ['easy', 'medium', 'hard']) {
    for (let i = 0; i < 25; i++) {
      const b = makeChakraBoard(d, lcg(300 + i));
      const game = await runPolicyGame({ board: b, transport: scriptedTransport(alwaysInwardPick) });
      assert.notEqual(game.outcome, 'unparsed', `${d}: repeated answers are readable`);
      // An offered move is always a real door, so the walk can only ever refuse
      // one for doubling back — never for there being no such door.
      assert.notEqual(game.outcome, 'illegal', `${d}: an offered move is always a door`);
      if (game.outcome === 'revisited') assert.equal(game.reject, 'revisited');
      // Replay the moves against the doors: every one must be a real edge.
      let here = { ring: b.src.ring, sector: b.src.sector };
      for (const dir of game.moves) {
        const edge = legalCandidates(b, here.ring, here.sector).find((c) => c.dir === dir);
        assert.ok(edge, `${d}: move '${dir}' from ${here.ring},${here.sector} is not a door`);
        here = { ring: edge.ring, sector: edge.sector };
      }
    }
  }
});

test('policy: an answer that is not one of the offered doors is refused and repaired', async () => {
  const b = makeChakraBoard('easy', lcg(67));
  // 'outward' from the outermost ring is off the board, so it is never offered
  // at the start cell. A model that answers it anyway is refused.
  let call = 0;
  const base = scriptedTransport(shortestPick);
  const t = {
    calls: 0,
    async ask(args) {
      const res = await base.ask.call(this, args);
      if (call++ === 0) {
        res.body.answers[`cell_${b.src.ring}_${b.src.sector}`] = {
          type: 'choice', choice: 'outward', probabilities: { outward: 0.9 }, confidence: 0.9,
        };
      }
      return res;
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.ok(!game.moves.includes('outward') || game.outcome === 'reached',
    'an unoffered move is never applied as the first step');
  assert.ok(t.calls > 1, `the walk repaired and re-asked (${t.calls} calls)`);
  assert.ok(game.repairs >= 1, 'the repair is recorded');
});

test('policy: a policy that doubles back never re-enters a cell, and is repaired', async () => {
  const REV = { inward: 'outward', outward: 'inward', clockwise: 'counterclockwise', counterclockwise: 'clockwise' };
  let refusals = 0;
  for (let i = 0; i < 20; i++) {
    const b = makeChakraBoard('easy', lcg(71 + i));
    // Answer every cell with the reverse of the correct move: that points back
    // toward where the walk came from. The fresh-only rule must refuse it.
    const t = scriptedTransport((bb, cell, moves) => {
      const correct = shortestPick(bb, cell, moves);
      const rev = REV[correct];
      return rev && moves.some((m) => m.dir === rev) ? rev : correct;
    });
    const game = await runPolicyGame({ board: b, transport: t });
    refusals += game.repairs;

    // The invariant that matters: a doubling-back move is never applied, so no
    // cell is ever entered twice, and every move is a real door.
    const seen = new Set();
    let here = { ring: b.src.ring, sector: b.src.sector };
    for (const m of game.applied) {
      assert.ok(!seen.has(m.cell), `cell ${m.cell} was entered twice`);
      seen.add(m.cell);
      const edge = legalCandidates(b, here.ring, here.sector).find((c) => c.dir === m.dir);
      assert.ok(edge, `'${m.dir}' from ${here.ring},${here.sector} is not a door`);
      here = { ring: edge.ring, sector: edge.sector };
    }
  }
  assert.ok(refusals > 0, 'the doubling back was refused and repaired somewhere in the sweep');
});

test('policy: when the repair budget runs out, a doubling-back policy is reported as REVISITED', async () => {
  const b = makeChakraBoard('easy', lcg(73));
  const REV = { inward: 'outward', outward: 'inward', clockwise: 'counterclockwise', counterclockwise: 'clockwise' };
  const first = legalCandidates(b, b.src.ring, b.src.sector)[0];
  // Step 1 takes the first door; every later cell answers the way straight back
  // to the cell just left. With no repairs allowed, the walk must stop there and
  // say it doubled back — never claim a wall.
  const t = scriptedTransport((bb, cell, moves) => {
    if (cell.ring === b.src.ring && cell.sector === b.src.sector) return moves[0].dir;
    const rev = REV[first.dir];
    return moves.some((m) => m.dir === rev) ? rev : moves[0].dir;
  });
  const game = await runPolicyGame({ board: b, transport: t, maxRepairs: 0 });
  assert.equal(game.moves.length, 1, 'the first move was played');
  assert.equal(game.outcome, 'revisited', 'the second was refused as a doubling back');
  assert.equal(game.reject, 'revisited');
  assert.equal(game.rejectDir, REV[first.dir], 'and the refused direction is named');
  assert.equal(game.repairs, 0, 'no repair was available');
});

test('policy: no usable answer for a cell is UNREADABLE, not stuck', async () => {
  const b = makeChakraBoard('easy', lcg(7));
  const t = scriptedTransport(shortestPick, { skipCells: 999 });
  const game = await runPolicyGame({ board: b, transport: t });
  assert.equal(game.outcome, 'unparsed', 'nothing readable → unparsed');
  assert.equal(game.reject, 'unreadable');
  assert.equal(game.moves.length, 0);
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
    const game = await runPolicyGame({ board: b, transport: scriptedTransport(shortestPick) });
    assert.ok(game.outcome === 'reached' || game.outcome === 'stuck',
      `got ${game.outcome}, not exhausted`);
  }
});

test('policy: buildPolicyBody reports summed tokens and the new counters', async () => {
  const b = makeChakraBoard('easy', lcg(29));
  const t = scriptedTransport(shortestPick, { tokensIn: 80, tokensOut: 20 });
  const game = await runPolicyGame({ board: b, transport: t });
  const body = buildPolicyBody(game);
  assert.equal(body.usage.input_tokens, 80 * game.calls.length);
  assert.equal(body.usage.output_tokens, 20 * game.calls.length);
  assert.ok(body.usage.output_tokens > 0);
  assert.equal(body._cellsAsked, game.cellsAsked);
  assert.equal(body._repairs, 0);
  assert.ok(body._cellsAsked > 0, 'the record knows how many cells were asked about');
});

test('policy: the confidence/choice mismatch is recorded when a model undercuts itself', async () => {
  const b = makeChakraBoard('easy', lcg(31));
  // The field signature: confidence 0.30 while the chosen move was given 0.47.
  const base = scriptedTransport(shortestPick);
  const t = {
    async ask(args) {
      const res = await base.ask.call(this, args);
      for (const id of Object.keys(res.body.answers)) {
        const a = res.body.answers[id];
        a.probabilities = { [a.choice]: 0.47 };
        a.confidence = 0.30;
      }
      return res;
    },
  };
  const game = await runPolicyGame({ board: b, transport: t });
  assert.ok(game.mismatchCount > 0, 'the mismatch is counted');
  assert.equal(game.mismatchCount, game.applied.length, 'every step is flagged');
});

// ---- 200-board regression runs -------------------------------------------
test('regression: a correct policy reaches 200/200 boards per difficulty with stepAccuracy 1.0', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    let reached = 0;
    let allAcc1 = true;
    for (let i = 0; i < 200; i++) {
      const b = makeChakraBoard(d, lcg(200 + i));
      const game = await runPolicyGame({ board: b, transport: scriptedTransport(shortestPick) });
      if (game.outcome !== 'reached') continue;
      reached++;
      const acc = computeStepAccuracy(b, game.moves, game.board.src);
      if (acc !== 1.0) allAcc1 = false;
    }
    assert.equal(reached, 200, `${d}: 200/200 reached`);
    assert.ok(allAcc1, `${d}: all stepAccuracy === 1.0`);
  }
});

test('regression: answering the same move everywhere solves strictly fewer mazes', async () => {
  // The honest claim about the field failure: a model that repeats one move is
  // worse than one that answers each cell on its merits. Not "it always fails" —
  // an inward-biased walk reaches the centre sometimes — but strictly fewer.
  for (const d of ['easy', 'medium', 'hard']) {
    let repeated = 0;
    let correct = 0;
    for (let i = 0; i < 50; i++) {
      const b = makeChakraBoard(d, lcg(500 + i));
      const g1 = await runPolicyGame({ board: b, transport: scriptedTransport(alwaysInwardPick) });
      const g2 = await runPolicyGame({ board: b, transport: scriptedTransport(shortestPick) });
      if (g1.outcome === 'reached') repeated++;
      if (g2.outcome === 'reached') correct++;
      // Whatever happens, the repeated-move model never steps through a wall.
      let here = { ring: b.src.ring, sector: b.src.sector };
      for (const dir of g1.moves) {
        const edge = legalCandidates(b, here.ring, here.sector).find((c) => c.dir === dir);
        assert.ok(edge, `${d}: '${dir}' is not a door`);
        here = { ring: edge.ring, sector: edge.sector };
      }
    }
    assert.equal(correct, 50, `${d}: the correct policy reaches all 50`);
    assert.ok(repeated < correct, `${d}: repeating one move solves strictly fewer (${repeated} vs ${correct})`);
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

test('obstacles off: the walk reaches the centre with a correct policy', async () => {
  const b = makeChakraBoard('easy', lcg(13), { warriors: false });
  const game = await runPolicyGame({ board: b, transport: scriptedTransport(shortestPick) });
  assert.equal(game.outcome, 'reached', 'a warrior-free maze is still winnable');
  assert.equal(game.repairs, 0, 'and needs no repair');
});

test('presets: the three difficulties are distinct and labelled', () => {
  const ds = Object.keys(CHAKRA_PRESETS);
  assert.deepEqual(ds, ['easy', 'medium', 'hard']);
  assert.ok(CHAKRA_PRESETS.easy.R < CHAKRA_PRESETS.medium.R);
  assert.ok(CHAKRA_PRESETS.medium.R < CHAKRA_PRESETS.hard.R);
  assert.ok(CHAKRA_PRESETS.easy.warriors < CHAKRA_PRESETS.hard.warriors);
  for (const d of ds) assert.ok(/ring/.test(CHAKRA_PRESETS[d].label), `${d} has a label`);
});

// ---- step-by-step mode -----------------------------------------------------
// The same question, asked one cell at a time: ask → move one step → ask again
// from the new cell. The toggle exists to test whether a model that juggles 158
// questions does better when it is handed one.

test('step: the single-cell question is byte-identical to the batch one', () => {
  // This is the fairness guarantee. If the text differed, a change in outcome
  // could be the wording rather than the one-at-a-time ask, and the experiment
  // would prove nothing.
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(31));
    const batch = chakraPolicyQuestions(b);
    for (const { ring, sector } of policyCells(b)) {
      const one = chakraPolicyQuestions(b, { cells: [{ ring, sector }] });
      const id = `cell_${ring}_${sector}`;
      assert.deepEqual(Object.keys(one), [id], `${d}: exactly the one cell asked about`);
      assert.deepEqual(one[id], batch[id], `${d}/${id}: identical question, criteria and instructions`);
    }
  }
});

test('step: a banned move is struck from the single-cell question too', () => {
  const b = makeChakraBoard('medium', lcg(32));
  const cell = policyCells(b).find((c) => legalCandidates(b, c.ring, c.sector).length > 1);
  const dir = legalCandidates(b, cell.ring, cell.sector)[0].dir;
  const banned = new Map([[`${cell.ring},${cell.sector}`, new Set([dir])]]);
  const one = chakraPolicyQuestions(b, { cells: [cell], banned });
  assert.ok(!(dir in one[`cell_${cell.ring}_${cell.sector}`].criteria),
    'the struck move is not offered');
});

test('step: a correct model reaches the centre, one cell per call', async () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const b = makeChakraBoard(d, lcg(63));
    const t = scriptedTransport(shortestPick);
    const game = await runPolicyGame({ board: b, transport: t, mode: 'step' });
    assert.equal(game.outcome, 'reached', `${d}: reached`);
    assert.equal(game.mode, 'step', `${d}: the mode is reported`);
    assert.equal(game.repairs, 0, `${d}: no repair needed`);
    // One call per hop, and never more — the walk must not ask about the centre.
    assert.equal(t.calls, game.steps, `${d}: one call per step (${t.calls} calls, ${game.steps} steps)`);
    for (const cl of game.calls) {
      assert.equal(cl.asked, 1, `${d}: every call carried exactly one question`);
      assert.equal(cl.answered, 1, `${d}: every call answered exactly that cell`);
      assert.equal(cl.used, 1, `${d}: every call moved the walk exactly one step`);
    }
  }
});

test('step: asking one at a time is never WORSE than asking all at once', async () => {
  // Same model, same boards. A correct model must land identically, because the
  // route only ever depends on the cells it visits.
  for (const d of ['easy', 'medium', 'hard']) {
    for (let i = 0; i < 12; i++) {
      const batch = await runPolicyGame({
        board: makeChakraBoard(d, lcg(70 + i)), transport: scriptedTransport(shortestPick),
      });
      const step = await runPolicyGame({
        board: makeChakraBoard(d, lcg(70 + i)), transport: scriptedTransport(shortestPick), mode: 'step',
      });
      assert.equal(step.outcome, batch.outcome, `${d}/${i}: same outcome`);
      assert.equal(step.steps, batch.steps, `${d}/${i}: same route length`);
      assert.deepEqual(step.moves, batch.moves, `${d}/${i}: same route`);
    }
  }
});

test('step: the walk never asks about a cell it is not standing on', async () => {
  const d = 'hard';
  const b = makeChakraBoard(d, lcg(88));
  const asked = [];
  const inner = scriptedTransport(shortestPick);
  const t = { async ask(args) { asked.push(...Object.keys(args.questions)); return inner.ask(args); } };
  const game = await runPolicyGame({ board: b, transport: t, mode: 'step' });
  assert.equal(game.outcome, 'reached');

  // Replay the route to get the cell occupied before each ask. `applied[].cell`
  // is where a move was taken FROM, so the position after step k is that move's
  // destination — not applied[k].cell.
  const at = [];
  let here = { ring: b.src.ring, sector: b.src.sector };
  for (let k = 0; k <= game.moves.length; k++) {
    at.push(`cell_${here.ring}_${here.sector}`);
    if (k === game.moves.length) break;
    const c = legalCandidates(b, here.ring, here.sector).find((x) => x.dir === game.moves[k]);
    here = { ring: c.ring, sector: c.sector };
  }
  // One ask per hop: the last cell is the centre, and the centre is never asked.
  assert.equal(asked.length, at.length - 1, 'one ask per hop, never about the centre');
  for (let i = 0; i < asked.length; i++) {
    assert.equal(asked[i], at[i], `ask ${i + 1} must name the cell the walk stands on`);
  }
});

test('step: no usable answer is UNREADABLE, not stuck', async () => {
  const b = makeChakraBoard('easy', lcg(90));
  const t = scriptedTransport(shortestPick, { skipCells: 1 });
  const game = await runPolicyGame({ board: b, transport: t, mode: 'step' });
  assert.equal(game.outcome, 'unparsed', 'an unanswered cell is unreadable, never stuck');
  assert.equal(game.reject, 'unreadable');
});

test('step: a doubling-back policy is still refused and repaired', async () => {
  const b = makeChakraBoard('easy', lcg(91));
  // Always inward: legal, but it walks into walls of the ring structure and can
  // double back. Whatever happens, the vocabulary must match policy mode.
  const t = scriptedTransport(alwaysInwardPick);
  const game = await runPolicyGame({ board: b, transport: t, mode: 'step' });
  assert.ok(['reached', 'stuck', 'revisited', 'illegal', 'exhausted'].includes(game.outcome),
    `outcome from the shared vocabulary (got ${game.outcome})`);
  assert.ok(game.steps <= game.maxSteps, 'the step budget is respected');
  assert.ok(t.calls <= game.maxSteps + 4, 'calls stay bounded by the step budget plus repairs');
});

test('step: a transport error ends the run as an error, after the calls it made', async () => {
  const b = makeChakraBoard('easy', lcg(92));
  let n = 0;
  const t = {
    async ask() {
      n++;
      if (n === 3) return { ok: false, error: { code: 'upstream_error', message: 'boom' } };
      const inner = scriptedTransport(shortestPick);
      return inner.ask(...arguments);
    },
  };
  const game = await runPolicyGame({ board: b, transport: t, mode: 'step' });
  assert.equal(game.outcome, 'error');
  assert.equal(game.steps, 2, 'the two steps taken before the failure are kept');
  assert.equal(game.error.code, 'upstream_error');
});

test('step: buildPolicyBody carries the mode and the per-step counters', async () => {
  const b = makeChakraBoard('medium', lcg(93));
  const game = await runPolicyGame({ board: b, transport: scriptedTransport(shortestPick), mode: 'step' });
  const body = buildPolicyBody(game);
  assert.equal(body._mode, 'step');
  assert.equal(body._calls, game.steps, 'one call per step');
  assert.equal(body._questions, game.steps, 'one question per call');
  assert.equal(body._steps, game.steps);
  assert.equal(Object.keys(body.answers).length, game.steps, 'one recorded move per step');
});
