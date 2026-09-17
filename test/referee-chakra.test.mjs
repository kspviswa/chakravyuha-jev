// test/referee-chakra.test.mjs — the polar referee: BFS shortest route, the
// walker's legality verdicts, and the agreement between the two.
//
// The referee is verification-only: it never chooses a move for the game loop.
// These tests pin down exactly what it is allowed to answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChakraBoard, DIFFICULTIES } from '../lib/chakra.js';
import {
  chakraNeighbours, chakraShortest, chakraQuality, chakraVerdict, polarReachable, walkChakra,
} from '../lib/referee.js';

const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

function openBoard({ R = 3, S = 6, centreGate = 0, warriors = [], src = null } = {}) {
  return {
    R, S, centreGate, warriors,
    openRadial: Array.from({ length: R - 1 }, () => new Array(S).fill(true)),
    openCirc: Array.from({ length: R }, () => new Array(S).fill(true)),
    src: src || { ring: R, sector: 0 },
    dst: { ring: 0, sector: 0 },
    difficulty: 'easy', label: 'test',
  };
}

/** Turn a cell path into the direction list a player would have had to send. */
function pathToMoves(board, path) {
  const { S } = board;
  const moves = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (b.ring === a.ring - 1) moves.push('inward');
    else if (b.ring === a.ring + 1) moves.push('outward');
    else if (b.sector === (a.sector + 1) % S) moves.push('clockwise');
    else moves.push('counterclockwise');
  }
  return moves;
}

// ---- shortest route --------------------------------------------------------
test('shortest: an open maze is a straight line in — the radial distance', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  const s = chakraShortest(b, b.src, b.dst);
  assert.equal(s.length, 3, '(3,0) → (2,0) → (1,0) → centre');
  assert.deepEqual(s.path[0], { ring: 3, sector: 0 });
  assert.deepEqual(s.path[s.path.length - 1], { ring: 0, sector: 0 });
});

test('shortest: a closed radial door forces a detour around the ring', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  assert.equal(chakraShortest(b, b.src, b.dst).length, 3, 'baseline');
  b.openRadial[1][0] = false; // shut the door between ring 2 and ring 3 at sector 0
  const s = chakraShortest(b, b.src, b.dst);
  assert.equal(s.length, 5, 'must go round: out sideways, in, back, in');
  assert.ok(s.length > 3);
});

test('shortest: a warrior on the only quick route lengthens the route and is never entered', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  assert.equal(chakraShortest(b, b.src, b.dst).length, 3, 'baseline is straight in');
  b.warriors = [{ ring: 2, sector: 0 }];
  const s = chakraShortest(b, b.src, b.dst);
  assert.ok(s.length > 3, `the warrior forced a detour (got ${s.length})`);
  assert.ok(!s.path.some((c) => c.ring === 2 && c.sector === 0), 'the route never enters the warrior');
});

test('shortest: a sealed-off ring has no route at all', () => {
  const b = openBoard({ R: 2, S: 4, centreGate: 0, src: { ring: 2, sector: 0 } });
  b.openRadial[0] = new Array(4).fill(false);
  b.openCirc[1] = new Array(4).fill(false);
  assert.equal(chakraShortest(b, b.src, b.dst), null);
  assert.deepEqual(chakraQuality(b), { solvable: false, optimal: null, warriorsOnOptimal: 0 });
  assert.equal(polarReachable(b, b.src, b.dst), false);
});

test('shortest: a cell is its own route, length 0', () => {
  const b = openBoard({ R: 3, S: 6, src: { ring: 2, sector: 3 } });
  const s = chakraShortest(b, { ring: 2, sector: 3 }, { ring: 2, sector: 3 });
  assert.equal(s.length, 0);
  assert.deepEqual(s.path, [{ ring: 2, sector: 3 }]);
});

// ---- the walker ------------------------------------------------------------
test('walk: a legal run reaches the centre through the gate', () => {
  const b = openBoard({ R: 3, S: 6, centreGate: 2, src: { ring: 3, sector: 0 } });
  const w = walkChakra(b, ['inward', 'inward', 'clockwise', 'clockwise', 'inward']);
  assert.equal(w.reached, true);
  assert.equal(w.steps, 5);
  assert.equal(w.hitWall, false);
  assert.equal(w.hitWarrior, false);
  assert.equal(w.offBoard, false);
  assert.equal(w.cost, null, 'a polar maze has no per-cell cost');
});

test('walk: crossing a closed radial door is a wall hit and stops the walk', () => {
  const b = openBoard({ R: 3, S: 6, centreGate: 2, src: { ring: 3, sector: 0 } });
  b.openRadial[1][0] = false;
  const w = walkChakra(b, ['inward', 'inward']);
  assert.equal(w.hitWall, true);
  assert.equal(w.steps, 0, 'the walk dies on the first illegal move');
  assert.equal(w.reached, false);
});

test('walk: stepping into a warrior is a warrior hit', () => {
  const b = openBoard({ R: 3, S: 6, centreGate: 2, src: { ring: 3, sector: 0 }, warriors: [{ ring: 2, sector: 0 }] });
  const w = walkChakra(b, ['inward']);
  assert.equal(w.hitWarrior, true);
  assert.equal(w.steps, 0);
});

test('walk: walking off the outside of the maze is an off-board move', () => {
  const b = openBoard({ R: 3, S: 6, src: { ring: 3, sector: 0 } });
  assert.equal(walkChakra(b, ['outward']).offBoard, true);
});

test('walk: an unrecognised move is off-board, not silently ignored', () => {
  const b = openBoard({ R: 3, S: 6, src: { ring: 3, sector: 0 } });
  assert.equal(walkChakra(b, ['sideways']).offBoard, true);
});

test('walk: "stop" ends the list early', () => {
  const b = openBoard({ R: 3, S: 6, src: { ring: 3, sector: 0 } });
  const w = walkChakra(b, ['inward', 'stop', 'inward']);
  assert.equal(w.steps, 1, 'the move after stop is not applied');
});

// ---- the referee's agreement ----------------------------------------------
test('agreement: the referee BFS path, replayed as moves, walks exactly as far', () => {
  const rng = lcg(4242);
  for (const d of DIFFICULTIES) {
    for (let i = 0; i < 30; i++) {
      const b = makeChakraBoard(d, rng);
      const s = chakraShortest(b, b.src, b.dst);
      assert.ok(s, `${d} draw ${i}: solvable`);
      const w = walkChakra(b, pathToMoves(b, s.path));
      assert.equal(w.reached, true, `${d} draw ${i}: the BFS path is walkable`);
      assert.equal(w.steps, s.length, `${d} draw ${i}: same length`);
      assert.equal(w.hitWall, false);
      assert.equal(w.hitWarrior, false);
    }
  }
});

test('agreement: every neighbour the BFS offers is a legal single-step walk', () => {
  const rng = lcg(777);
  for (const d of DIFFICULTIES) {
    for (let i = 0; i < 15; i++) {
      const b = makeChakraBoard(d, rng);
      // probe every cell of the maze
      for (let ring = 0; ring <= b.R; ring++) {
        const sectors = ring === 0 ? [0] : [...Array(b.S).keys()];
        for (const sector of sectors) {
          for (const nb of chakraNeighbours(b, ring, sector)) {
            const w = walkChakra({ ...b, src: { ring, sector } }, [nb.dir]);
            assert.equal(w.steps, 1, `${d} ${ring},${sector} ${nb.dir} should be legal`);
            assert.deepEqual(w.path[1], { ring: nb.ring, sector: nb.sector });
          }
        }
      }
    }
  }
});

// ---- the verdict -----------------------------------------------------------
test('verdict: an optimal run passes every check', () => {
  const b = makeChakraBoard('easy', lcg(31));
  const s = chakraShortest(b, b.src, b.dst);
  const v = chakraVerdict(b, pathToMoves(b, s.path));
  assert.equal(v.ok, true);
  assert.equal(v.reached, true);
  assert.equal(v.steps, v.optimal);
  assert.ok(v.checks.every((c) => c.pass));
});

test('verdict: a wall crash fails the right checks and reports the optimal anyway', () => {
  const b = openBoard({ R: 3, S: 6, centreGate: 2, src: { ring: 3, sector: 0 } });
  b.openRadial[1][0] = false;
  const v = chakraVerdict(b, ['inward']);
  assert.equal(v.ok, false);
  assert.equal(v.reached, false);
  assert.equal(v.hitWall, true);
  const failed = v.checks.filter((c) => !c.pass).map((c) => c.name);
  assert.ok(failed.includes('never crosses a wall'));
  assert.ok(failed.includes('reaches the centre'));
  assert.equal(typeof v.optimal, 'number', 'the referee still knows the true optimum');
});

test('verdict: the optimal path is exposed for the post-run overlay, and only there', () => {
  const b = makeChakraBoard('medium', lcg(64));
  const v = chakraVerdict(b, []);
  assert.ok(Array.isArray(v.optimalPath));
  assert.deepEqual(v.optimalPath[0], { ring: b.src.ring, sector: b.src.sector });
  assert.deepEqual(v.optimalPath[v.optimalPath.length - 1], { ring: 0, sector: 0 });
  assert.equal(v.optimalPath.length - 1, v.optimal);
});

test('quality: warriorsOnOptimal counts only warriors that sit on some shortest route', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  assert.equal(chakraQuality(b).warriorsOnOptimal, 0);
  b.warriors = [{ ring: 2, sector: 0 }]; // sits exactly on the straight-in route
  assert.equal(chakraQuality(b).warriorsOnOptimal, 1);
});
