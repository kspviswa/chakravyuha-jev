// test/geometry.test.mjs — what the board actually DRAWS.
//
// The skin's drawing geometry was untested, and that is how a real bug reached
// the screen: ring 0 (the centre) sat at a negative radius, so the centre cell
// was plotted on the OPPOSITE side of the board from the gate. The final hop was
// then drawn as a chord sweeping half the innermost ring and cutting straight
// through its walls — the path visibly crossing a wall on the outermost of the
// inner rings.
//
// These tests use the skin's OWN exported geometry helpers, so they check what
// the canvas is told to draw rather than a copy of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeChakraBoard, neighbours, centreRadius, centreAngle,
} from '../lib/chakra.js';
import { cellPoint, wallGeometry, radialHop } from '../skins/chakravyuha.js';
import { polarLerp } from '../lib/animator.js';

const SIZE = 720;
const PAD = 0.08 * SIZE;
const MAXR = SIZE / 2 - PAD;

const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

const polar = (r, a) => ({ x: SIZE / 2 + r * Math.sin(a), y: SIZE / 2 - r * Math.cos(a) });

/** Proper segment crossing, ignoring shared endpoints. */
function crosses(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** The walls as a flat list of segments, arcs sampled into short chords. */
function wallSegments(board) {
  const { arcs, lines } = wallGeometry(board, SIZE);
  const segs = [];
  for (const w of arcs) {
    const N = 32;
    let prev = null;
    for (let k = 0; k <= N; k++) {
      const p = polar(w.r, w.a0 + (w.a1 - w.a0) * (k / N));
      if (prev) segs.push([prev, p, `arc r=${w.r.toFixed(1)}`]);
      prev = p;
    }
  }
  for (const w of lines) {
    segs.push([polar(w.r0, w.a), polar(w.r1, w.a), `radial a=${w.a.toFixed(3)}`]);
  }
  return segs;
}

// ---- the root cause --------------------------------------------------------
test('centreRadius: ring 0 is the centre POINT, so its radius is 0', () => {
  assert.equal(centreRadius(0, 100, 4), 0);
  // and the formula is untouched for the rings that have a band
  assert.equal(centreRadius(1, 100, 4), 12.5);
  assert.equal(centreRadius(4, 100, 4), 87.5);
});

test('centreRadius: never negative for a fractional ring, so a hop into the centre cannot overshoot', () => {
  // The animator feeds in fractional rings mid-hop. A negative radius would put
  // the sprite at the same distance on the OPPOSITE side of the board.
  for (const ring of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    assert.ok(centreRadius(ring, 100, 4) >= 0, `ring ${ring} must not be negative`);
  }
  assert.equal(centreRadius(0.5, 100, 4), 0, 'the centre is reached at half a band');
});

// ---- the centre is drawn where the target icon is -------------------------
test('geometry: the centre cell is drawn exactly at the canvas centre, for every sector', () => {
  const mid = SIZE / 2;
  for (const S of [12, 16, 20]) {
    for (let sector = 0; sector < S; sector++) {
      const p = cellPoint(0, sector, { R: 4, S, size: SIZE });
      assert.ok(Math.abs(p.x - mid) < 1e-9 && Math.abs(p.y - mid) < 1e-9,
        `ring 0 must plot at the centre, got (${p.x}, ${p.y}) for sector ${sector}`);
    }
  }
});

test('geometry: every ring-0 position coincides, since the centre has no sector', () => {
  const a = cellPoint(0, 0, { R: 6, S: 16, size: SIZE });
  const b = cellPoint(0, 9, { R: 6, S: 16, size: SIZE });
  assert.deepEqual(a, b);
});

// ---- the invariant the bug broke -------------------------------------------
test('geometry: a legal move never draws a line across a wall', () => {
  // The whole point: the path is drawn as straight segments between cell
  // centres, so if any legal move's segment crosses a drawn wall the picture
  // contradicts the maze. Exhaustive over every legal move on many boards.
  const rng = lcg(20260918);
  let checked = 0;
  const bad = [];
  for (const diff of ['easy', 'medium', 'hard']) {
    for (let trial = 0; trial < 6; trial++) {
      const board = makeChakraBoard(diff, rng, { warriors: true });
      const segs = wallSegments(board);
      for (let ring = 0; ring <= board.R; ring++) {
        for (let sector = 0; sector < board.S; sector++) {
          if (ring === 0 && sector !== 0) continue;
          for (const nb of neighbours(board, ring, sector)) {
            const p1 = cellPoint(ring, sector, { R: board.R, S: board.S, size: SIZE });
            const p2 = cellPoint(nb.ring, nb.sector, { R: board.R, S: board.S, size: SIZE });
            for (const [w1, w2, label] of segs) {
              checked++;
              if (crosses(p1, p2, w1, w2)) {
                if (bad.length < 8) bad.push(`${diff}: (${ring},${sector}) -${nb.dir}-> (${nb.ring},${nb.sector}) crosses ${label}`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, 'the sweep must actually test something');
  assert.deepEqual(bad, [], `a drawn move crosses a wall:\n${bad.join('\n')}`);
});

test('radialHop: a hop in or out of the centre does not sweep its sector', () => {
  // The centre's sector is a convention. If it swept, the sprite would travel
  // sideways while still at a positive radius and cross the innermost walls.
  assert.deepEqual(radialHop({ ring: 1, sector: 5 }, { ring: 0, sector: 0 }),
    { from: { ring: 1, sector: 5 }, to: { ring: 0, sector: 5 } }, 'inbound borrows the gate sector');
  assert.deepEqual(radialHop({ ring: 0, sector: 0 }, { ring: 1, sector: 5 }),
    { from: { ring: 0, sector: 5 }, to: { ring: 1, sector: 5 } }, 'outbound borrows the gate sector');
  // and a hop that does not touch the centre is left exactly alone
  assert.deepEqual(radialHop({ ring: 2, sector: 3 }, { ring: 3, sector: 9 }),
    { from: { ring: 2, sector: 3 }, to: { ring: 3, sector: 9 } });
});

test('geometry: the hop into the centre is purely radial, and so is the hop out', () => {
  // The sprite interpolates through fractional rings, so it can cut a corner the
  // static trail does not. With the hop normalised, every sampled frame of the
  // journey in or out of the centre must stay on the gate's radial line.
  const rng = lcg(7);
  let checked = 0;
  const bad = [];
  for (const diff of ['easy', 'medium', 'hard']) {
    for (let trial = 0; trial < 4; trial++) {
      const board = makeChakraBoard(diff, rng, { warriors: true });
      const segs = wallSegments(board);
      for (let sector = 0; sector < board.S; sector++) {
        if (!neighbours(board, 1, sector).some((n) => n.ring === 0)) continue;
        const centre = { ring: 0, sector: 0 };
        const gate = { ring: 1, sector };

        // inbound: ring 1 -> centre
        const inHop = radialHop(gate, centre);
        for (let k = 1; k <= 20; k++) {
          const f = polarLerp(board.S, inHop.from, inHop.to, k / 20);
          assert.equal(f.sector, sector, 'the inbound hop must not sweep its sector');
          const p = cellPoint(f.ring, f.sector, { R: board.R, S: board.S, size: SIZE });
          const p0 = cellPoint(1, sector, { R: board.R, S: board.S, size: SIZE });
          for (const [w1, w2, label] of segs) {
            checked++;
            if (crosses(p0, p, w1, w2)) bad.push(`${diff}: inbound (1,${sector}) t=${k / 20} crosses ${label}`);
          }
        }

        // outbound: centre -> ring 1
        const outHop = radialHop(centre, gate);
        for (let k = 1; k <= 20; k++) {
          const f = polarLerp(board.S, outHop.from, outHop.to, k / 20);
          assert.equal(f.sector, sector, 'the outbound hop must not sweep its sector');
          const p = cellPoint(f.ring, f.sector, { R: board.R, S: board.S, size: SIZE });
          const p0 = cellPoint(0, 0, { R: board.R, S: board.S, size: SIZE });
          for (const [w1, w2, label] of segs) {
            checked++;
            if (crosses(p0, p, w1, w2)) bad.push(`${diff}: outbound (1,${sector}) t=${k / 20} crosses ${label}`);
          }
        }
      }
    }
  }
  assert.ok(checked > 100, 'the sweep must actually test something');
  assert.deepEqual(bad.slice(0, 8), [], `the sprite crosses a wall entering or leaving the centre:\n${bad.slice(0, 8).join('\n')}`);
});

// ---- walls match the model -------------------------------------------------
test('geometry: a wall is drawn for exactly the doors the model reports closed', () => {
  const rng = lcg(99);
  const board = makeChakraBoard('medium', rng, { warriors: false });
  const { arcs, lines } = wallGeometry(board, SIZE);

  const closedRadial = board.openRadial.flat().filter((x) => !x).length;
  const closedCirc = board.openCirc.flat().filter((x) => !x).length;
  assert.equal(arcs.length, closedRadial, 'one arc per closed door between rings');
  assert.equal(lines.length, closedCirc, 'one line per closed door between sectors');

  // and each arc spans exactly one sector, at an integer radius
  const unit = MAXR / board.R;
  const ang = (2 * Math.PI) / board.S;
  for (const w of arcs) {
    assert.ok(Math.abs(w.a1 - w.a0 - ang) < 1e-9, 'an arc spans exactly one sector');
    assert.ok(Math.abs(w.r / unit - Math.round(w.r / unit)) < 1e-9, 'an arc sits at an integer radius');
  }
  for (const w of lines) {
    assert.ok(Math.abs(w.r1 - w.r0 - unit) < 1e-9, 'a radial wall spans exactly one ring');
  }
});

test('geometry: the innermost ring has no arc drawn at its inner edge', () => {
  // Ring 0 is the centre point, so there is no boundary band to wall off at
  // radius 0.5*unit; walls start at the ring 1 / ring 2 boundary.
  const rng = lcg(3);
  const board = makeChakraBoard('easy', rng, { warriors: false });
  const unit = MAXR / board.R;
  const { arcs } = wallGeometry(board, SIZE);
  for (const w of arcs) {
    assert.ok(w.r >= unit - 1e-9, `an arc was drawn inside the centre (r=${w.r}, unit=${unit})`);
  }
});
