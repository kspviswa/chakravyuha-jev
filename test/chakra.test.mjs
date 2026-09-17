// test/chakra.test.mjs — the polar chakravyuha model: geometry, adjacency,
// generation and the state that is serialised for Jev.
//
// These tests own the geometry contract the skin both rely on:
// sector wrap, wall semantics, the single centre gate, and the guarantee that
// every generated maze is solvable and deep enough to be worth asking Jev about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAKRA_PRESETS, DIFFICULTIES, makeChakraBoard, chakraState, boardHash,
  centreRadius, centreAngle, cellKey, MOVES, POLAR_RULES, POLAR_OBJECTIVE,
  neighbours, shortest,
} from '../lib/chakra.js';

/** A seeded LCG so every draw in this file is reproducible. */
const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

/** An all-doors-open board; tests close exactly the doors they care about. */
function openBoard({ R = 3, S = 6, centreGate = 2, warriors = [], src = null } = {}) {
  return {
    R, S, centreGate, warriors,
    openRadial: Array.from({ length: R - 1 }, () => new Array(S).fill(true)),
    openCirc: Array.from({ length: R }, () => new Array(S).fill(true)),
    src: src || { ring: R, sector: 0 },
    dst: { ring: 0, sector: 0 },
    difficulty: 'easy', label: 'test',
  };
}

// ---- geometry --------------------------------------------------------------
test('geometry: ring radii and sector angles match the spec', () => {
  assert.equal(centreRadius(1, 100, 4), 12.5, 'innermost ring centre');
  assert.equal(centreRadius(4, 100, 4), 87.5, 'outermost ring centre');
  assert.ok(Math.abs(centreAngle(0, 12) - Math.PI / 12) < 1e-12);
  assert.ok(centreAngle(1, 12) > centreAngle(0, 12), 'sector number increases clockwise');
});

// ---- adjacency -------------------------------------------------------------
test('adjacency: sectors wrap — clockwise from S-1 lands on 0 and back again', () => {
  const b = openBoard({ R: 3, S: 6 });
  const cw = neighbours(b, 2, 5).find((n) => n.dir === 'clockwise');
  assert.ok(cw, 'clockwise exists from the last sector');
  assert.equal(cw.sector, 0, 'S-1 → 0');
  const ccw = neighbours(b, 2, 0).find((n) => n.dir === 'counterclockwise');
  assert.ok(ccw, 'counterclockwise exists from sector 0');
  assert.equal(ccw.sector, 5, '0 → S-1');
});

test('adjacency: a closed circular wall blocks both directions across it', () => {
  const b = openBoard({ R: 3, S: 6 });
  b.openCirc[1][2] = false; // ring 2, the door between sector 2 and sector 3
  assert.ok(!neighbours(b, 2, 2).some((n) => n.dir === 'clockwise'),
    'clockwise out of sector 2 is blocked');
  assert.ok(!neighbours(b, 2, 3).some((n) => n.dir === 'counterclockwise'),
    'counterclockwise out of sector 3 is blocked');
  // the door two sectors away is untouched
  assert.ok(neighbours(b, 2, 0).some((n) => n.dir === 'clockwise'));
});

test('adjacency: a closed radial wall blocks both inward and outward across it', () => {
  const b = openBoard({ R: 3, S: 6 });
  b.openRadial[1][4] = false; // between ring 2 and ring 3, at sector 4
  assert.ok(!neighbours(b, 2, 4).some((n) => n.dir === 'outward'));
  assert.ok(!neighbours(b, 3, 4).some((n) => n.dir === 'inward'));
  assert.ok(neighbours(b, 3, 5).some((n) => n.dir === 'inward'), 'another sector is fine');
});

test('adjacency: exactly one centre gate connects ring 1 to the centre', () => {
  const b = openBoard({ R: 3, S: 6, centreGate: 2 });
  const inward = [];
  for (let s = 0; s < 6; s++) {
    if (neighbours(b, 1, s).some((n) => n.dir === 'inward')) inward.push(s);
  }
  assert.deepEqual(inward, [2], 'only the gate sector can enter the centre');
});

test('adjacency: from the centre the only move is outward through the gate', () => {
  const b = openBoard({ R: 3, S: 6, centreGate: 2 });
  const fromCentre = neighbours(b, 0, 0);
  assert.equal(fromCentre.length, 1);
  assert.deepEqual(
    { dir: fromCentre[0].dir, ring: fromCentre[0].ring, sector: fromCentre[0].sector },
    { dir: 'outward', ring: 1, sector: 2 },
  );
});

test('adjacency: warriors are impassable from every direction', () => {
  const b = openBoard({ R: 3, S: 6, warriors: [{ ring: 2, sector: 3 }] });
  assert.ok(!neighbours(b, 2, 2).some((n) => n.dir === 'clockwise'), 'not into it sideways');
  assert.ok(!neighbours(b, 3, 3).some((n) => n.dir === 'inward'), 'not into it from outside');
  assert.ok(!neighbours(b, 1, 3).some((n) => n.dir === 'outward'), 'not into it from inside');
  assert.ok(!neighbours(b, 2, 4).some((n) => n.dir === 'counterclockwise'), 'not into it the other way');
});

test('adjacency: an open cell offers exactly the four polar moves', () => {
  const b = openBoard({ R: 4, S: 8 });
  const dirs = neighbours(b, 3, 3).map((n) => n.dir).sort();
  assert.deepEqual(dirs, [...MOVES].sort());
});

// ---- shortest route --------------------------------------------------------
test('shortest: an open maze is a straight line in — the radial distance', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  const s = shortest(b, b.src, b.dst);
  assert.equal(s.length, 3, '(3,0) → (2,0) → (1,0) → centre');
  assert.deepEqual(s.path[0], { ring: 3, sector: 0 });
  assert.deepEqual(s.path[s.path.length - 1], { ring: 0, sector: 0 });
});

test('shortest: a closed radial door forces a detour around the ring', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  assert.equal(shortest(b, b.src, b.dst).length, 3, 'baseline');
  b.openRadial[1][0] = false; // shut the door between ring 2 and ring 3 at sector 0
  const s = shortest(b, b.src, b.dst);
  assert.equal(s.length, 5, 'must go round: out sideways, in, back, in');
  assert.ok(s.length > 3);
});

test('shortest: a warrior on the only quick route lengthens the route and is never entered', () => {
  const b = openBoard({ R: 3, S: 8, centreGate: 0, src: { ring: 3, sector: 0 } });
  assert.equal(shortest(b, b.src, b.dst).length, 3, 'baseline is straight in');
  b.warriors = [{ ring: 2, sector: 0 }];
  const s = shortest(b, b.src, b.dst);
  assert.ok(s.length > 3, `the warrior forced a detour (got ${s.length})`);
  assert.ok(!s.path.some((c) => c.ring === 2 && c.sector === 0), 'the route never enters the warrior');
});

test('shortest: a sealed-off ring has no route at all', () => {
  const b = openBoard({ R: 2, S: 4, centreGate: 0, src: { ring: 2, sector: 0 } });
  b.openRadial[0] = new Array(4).fill(false);
  b.openCirc[1] = new Array(4).fill(false);
  assert.equal(shortest(b, b.src, b.dst), null);
});

test('shortest: a cell is its own route, length 0', () => {
  const b = openBoard({ R: 3, S: 6, src: { ring: 2, sector: 3 } });
  const s = shortest(b, { ring: 2, sector: 3 }, { ring: 2, sector: 3 });
  assert.equal(s.length, 0);
  assert.deepEqual(s.path, [{ ring: 2, sector: 3 }]);
});

// ---- generation ------------------------------------------------------------
test('generation: every preset is solvable and deep enough over 200 seeded draws', () => {
  for (const d of DIFFICULTIES) {
    const p = CHAKRA_PRESETS[d];
    const rng = lcg(1234);
    for (let i = 0; i < 200; i++) {
      const b = makeChakraBoard(d, rng);
      assert.equal(b.R, p.R, `${d} draw ${i}: rings`);
      assert.equal(b.S, p.S, `${d} draw ${i}: sectors`);
      assert.equal(b.warriors.length, p.warriors, `${d} draw ${i}: exact warrior count`);
      const s = shortest(b, b.src, b.dst);
      assert.ok(s, `${d} draw ${i}: solvable`);
      assert.ok(s.length >= p.minSteps,
        `${d} draw ${i}: optimal ${s.length} must be >= minSteps ${p.minSteps}`);
    }
  }
});

test('generation: the start is always on the outermost ring', () => {
  const rng = lcg(5);
  for (const d of DIFFICULTIES) {
    for (let i = 0; i < 25; i++) {
      assert.equal(makeChakraBoard(d, rng).src.ring, CHAKRA_PRESETS[d].R);
    }
  }
});

test('generation: warriors never sit on the start, the gate thigh, or the centre', () => {
  const rng = lcg(99);
  for (const d of DIFFICULTIES) {
    for (let i = 0; i < 25; i++) {
      const b = makeChakraBoard(d, rng);
      const keys = new Set();
      for (const w of b.warriors) {
        const k = cellKey(w.ring, w.sector);
        assert.notEqual(k, cellKey(b.src.ring, b.src.sector), 'never on the start cell');
        assert.notEqual(k, cellKey(1, b.centreGate), 'never blocking the gate thigh');
        assert.notEqual(w.ring, 0, 'never in the centre');
        assert.ok(!keys.has(k), 'no duplicate warriors');
        keys.add(k);
      }
    }
  }
});

test('generation: deterministic under an injected RNG', () => {
  const a = makeChakraBoard('medium', lcg(2024));
  const b = makeChakraBoard('medium', lcg(2024));
  assert.equal(boardHash(a), boardHash(b));
  assert.deepEqual(a.warriors, b.warriors);
  assert.deepEqual(a.src, b.src);
  assert.deepEqual(a.openRadial, b.openRadial);
});

test('boardHash: identical mazes hash equal; moving one warrior changes it', () => {
  const a = makeChakraBoard('easy', lcg(11));
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(boardHash(a), boardHash(b));
  b.warriors = b.warriors.slice(1);
  assert.notEqual(boardHash(a), boardHash(b));
});

// ---- the state sent to Jev ------------------------------------------------
test('state: carries the maze, the walker, the rules and the objective — and no route', () => {
  const b = makeChakraBoard('easy', lcg(7));
  const st = chakraState(b, {
    ring: b.src.ring, sector: b.src.sector, visited: [b.src], step: 1, maxSteps: 2 * b.R * b.S,
  });
  assert.equal(st.task, 'chakravyuha_step');
  assert.deepEqual(st.maze, { rings: b.R, sectors: b.S, centre_gate_sector: b.centreGate });
  assert.deepEqual(st.open_radial, b.openRadial);
  assert.deepEqual(st.open_circ, b.openCirc);
  assert.deepEqual(st.warriors, b.warriors);
  assert.deepEqual(st.abhimanyu, { ring: b.src.ring, sector: b.src.sector });
  assert.equal(st.centre.ring, 0);
  assert.equal(st.centre.sector, 0);
  assert.equal(st.step, 1);
  assert.equal(st.maxSteps, 2 * b.R * b.S);
  assert.equal(st.rules, POLAR_RULES);
  assert.ok(/inward/.test(st.rules) && /clockwise/.test(st.rules), 'the four moves are spelled out');
  assert.ok(/shortest route/.test(st.objective), 'it asks for a first move of a shortest route');
  assert.equal(st.reversal, undefined);
  assert.equal(st.optimalPath, undefined);
  assert.equal(st.solution, undefined);
  assert.ok(!/optimalPath|solution/.test(JSON.stringify(st)), 'nothing about the answer leaks');
});

test('state: a reversal note is never attached', () => {
  const b = makeChakraBoard('easy', lcg(8));
  const base = { ring: b.src.ring, sector: b.src.sector, visited: [b.src], step: 1, maxSteps: 20 };
  const st = chakraState(b, base);
  assert.equal(st.reversal, undefined);
});
