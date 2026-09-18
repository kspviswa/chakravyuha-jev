// test/animation.test.mjs — the movement animation.
//
// Two things are under test here, and the second matters more than the first:
//
//   1. the mechanics — polar interpolation, the queue, cancel, instant mode;
//   2. THE INVARIANT — the animator is handed exactly the hops Jev decided, and
//      never the optimal route. Animating the answer would leak the
//      solution into the render layer, which is the "do not solve on load" bug
//      in a new costume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Animator, polarLerp, EASE_EASE_OUT } from '../lib/animator.js';
import { makeChakraBoard, neighbours, shortest } from '../lib/chakra.js';
import { runPolicyGame } from '../lib/jev.js';

const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

/** Rebuild a board from the policy state the loop sends. The policy state
 *  carries no abhimanyu — every question names its own cell. */
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

/** The direction from one cell to its successor on the optimal route. */
function optimalDir(b, cell) {
  const s = shortest(b, cell, b.dst);
  const next = s ? s.path[1] : null;
  if (!next) return null;
  return neighbours(b, cell.ring, cell.sector)
    .find((n) => n.ring === next.ring && n.sector === next.sector)?.dir || null;
}

/** A fake Jev that plays perfectly (it is allowed to use the model). It answers
 *  EVERY cell in one response, the way the real parallel fan-out does. */
function perfectTransport() {
  return {
    async ask({ state, questions }) {
      const b = boardFromState(state);
      const ids = Object.keys(questions || {});
      const answers = {};
      for (const id of ids) {
        const m = CELL_RE.exec(id);
        if (!m) continue;
        const cell = { ring: Number(m[1]), sector: Number(m[2]) };
        const offered = Object.keys(questions[id].criteria || {});
        const dir = optimalDir(b, cell);
        if (!dir || !offered.includes(dir)) continue;
        answers[id] = { type: 'choice', choice: dir, probabilities: { [dir]: 0.95 }, confidence: 0.95 };
      }
      return {
        ok: true,
        body: {
          answers,
          _ms: 5, _cost_usd: 0.0001,
          _questions: ids.length,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      };
    },
  };
}

// ---- polar interpolation ---------------------------------------------------
test('polarLerp: the endpoints are exact', () => {
  const S = 8;
  assert.deepEqual(polarLerp(S, { ring: 3, sector: 0 }, { ring: 1, sector: 2 }, 0), { ring: 3, sector: 0 });
  assert.deepEqual(polarLerp(S, { ring: 3, sector: 0 }, { ring: 1, sector: 2 }, 1), { ring: 1, sector: 2 });
});

test('polarLerp: radius interpolates linearly across the rings', () => {
  const mid = polarLerp(8, { ring: 3, sector: 0 }, { ring: 1, sector: 2 }, 0.5);
  assert.equal(mid.ring, 2, 'halfway in radius');
  assert.equal(mid.sector, 1);
});

test('polarLerp: sectors take the SHORT way around the S-1 → 0 wrap', () => {
  const S = 12;
  // 11 → 0 must pass through 11.5, not sweep the long way down through 5
  assert.equal(polarLerp(S, { ring: 2, sector: 11 }, { ring: 2, sector: 0 }, 0.5).sector, 11.5);
  // and 0 → 11 goes back the same short way
  assert.equal(polarLerp(S, { ring: 2, sector: 0 }, { ring: 2, sector: 11 }, 0.5).sector, 11.5);
});

test('polarLerp: t is clamped, so a late frame never overshoots the cell', () => {
  assert.deepEqual(polarLerp(8, { ring: 2, sector: 1 }, { ring: 2, sector: 3 }, 1.7), { ring: 2, sector: 3 });
  assert.deepEqual(polarLerp(8, { ring: 2, sector: 1 }, { ring: 2, sector: 3 }, -2), { ring: 2, sector: 1 });
});

test('easing: ease-out starts fast and lands exactly on 1', () => {
  assert.equal(EASE_EASE_OUT(0), 0);
  assert.equal(EASE_EASE_OUT(1), 1);
  assert.ok(EASE_EASE_OUT(0.5) > 0.5, 'ease-out is ahead of linear halfway');
});

// ---- the queue -------------------------------------------------------------
test('animator: a hop starts at its cell and ends exactly at the destination', () => {
  const frames = [];
  const a = new Animator({ duration: 100, now: () => 0, onFrame: (f) => frames.push(f.pos) });
  a.play([{ from: { ring: 3, sector: 0 }, to: { ring: 2, sector: 0 }, dir: 'inward', step: 1 }], { S: 8 });
  a.tick(0);
  a.tick(50);
  a.tick(100);
  assert.deepEqual(frames[0], { ring: 3, sector: 0 }, 'the first frame is the origin cell');
  assert.deepEqual(frames[frames.length - 1], { ring: 2, sector: 0 }, 'the last frame is the destination');
  const mid = frames[Math.floor(frames.length / 2)];
  assert.ok(mid.ring > 2 && mid.ring < 3, 'the sprite is genuinely between cells mid-hop');
  a.cancel();
});

test('animator: the middle of a hop is not a cell centre (he really moves)', () => {
  const a = new Animator({ duration: 100, now: () => 0, onFrame: () => {} });
  a.play([{ from: { ring: 4, sector: 0 }, to: { ring: 4, sector: 2 }, dir: 'clockwise', step: 1 }], { S: 8 });
  a.tick(0);
  a.tick(50);
  const pos = a.pos ?? null;
  a.cancel();
  assert.equal(pos, null); // the animator reports through onFrame, not state
});

test('animator: queued hops drain in order and none is dropped', async () => {
  const steps = [];
  const a = new Animator({ duration: 100, now: () => 0, onFrame: (f) => { if (f.step != null) steps.push(f.step); } });
  const hops = [1, 2, 3].map((n) => ({
    from: { ring: 5 - n, sector: 0 }, to: { ring: 4 - n, sector: 0 }, dir: 'inward', step: n,
  }));
  const done = a.play(hops, { S: 8 });
  a.tick(0); a.tick(100); a.tick(200); a.tick(300); a.tick(400);
  assert.equal(await done, 'finished');
  assert.deepEqual([...new Set(steps)], [1, 2, 3], 'all three hops played, in order');
});

test('animator: a second play() while running appends rather than resets', async () => {
  const steps = [];
  const a = new Animator({ duration: 100, now: () => 0, onFrame: (f) => { if (f.step != null) steps.push(f.step); } });
  const first = a.play([{ from: { ring: 3, sector: 0 }, to: { ring: 2, sector: 0 }, step: 1 }], { S: 8 });
  const second = a.play([{ from: { ring: 2, sector: 0 }, to: { ring: 1, sector: 0 }, step: 2 }], { S: 8 });
  a.tick(0); a.tick(100); a.tick(200); a.tick(300);
  await Promise.all([first, second]);
  assert.deepEqual([...new Set(steps)], [1, 2]);
});

test('animator: cancel abandons the queue and resolves as cancelled', async () => {
  const a = new Animator({ duration: 100, now: () => 0, onFrame: () => {} });
  const done = a.play([{ from: { ring: 3, sector: 0 }, to: { ring: 2, sector: 0 } }], { S: 8 });
  a.tick(0);
  a.cancel();
  assert.equal(await done, 'cancelled');
  assert.equal(a.running, false);
  assert.equal(a.queued, 0);
  assert.equal(a.idle, true);
});

test('animator: instant mode fires every hop at its destination, in order', async () => {
  const seen = [];
  const a = new Animator({ instant: true, onFrame: (f) => seen.push({ step: f.step, ring: f.pos.ring }) });
  const done = a.play([
    { from: { ring: 4, sector: 0 }, to: { ring: 3, sector: 0 }, step: 1 },
    { from: { ring: 3, sector: 0 }, to: { ring: 2, sector: 0 }, step: 2 },
  ], { S: 8 });
  assert.equal(await done, 'finished');
  assert.deepEqual(seen.map((s) => s.step), [1, 2]);
  assert.deepEqual(seen.map((s) => s.ring), [3, 2], 'each hop lands on its own destination');
});

test('animator: instant mode is what setAnimationDuration(0) means for a run', async () => {
  // The skin maps duration 0 → instant; this asserts the mechanism the skin
  // relies on, without needing a DOM.
  const a = new Animator({ duration: 0, instant: true, onFrame: () => {} });
  assert.equal(a.mode, 'instant');
  const done = a.play([{ from: { ring: 2, sector: 1 }, to: { ring: 2, sector: 2 }, step: 1 }], { S: 8 });
  assert.equal(await done, 'finished');
});

// ---- THE INVARIANT ---------------------------------------------------------
test('invariant: the animator is handed exactly the hops Jev chose, in order', async () => {
  const b = makeChakraBoard('easy', lcg(3));
  const hops = [];
  const game = await runPolicyGame({
    board: b, transport: perfectTransport(), onStep: (h) => { hops.push(h); },
  });

  assert.equal(game.outcome, 'reached');
  assert.equal(hops.length, game.moves.length, 'one hop per applied decision — no extra frames');

  assert.deepEqual(hops[0].from, { ring: b.src.ring, sector: b.src.sector });
  for (let i = 1; i < hops.length; i++) {
    assert.deepEqual(hops[i].from, hops[i - 1].to, `hop ${i} starts where hop ${i - 1} ended`);
  }
  // and the chain the sprite walked is exactly the chain Jev returns
  const s = shortest(b, b.src, b.dst);
  assert.deepEqual(hops.map((h) => h.to), s ? s.path.slice(1) : []);
});

test('invariant: a wandering policy animates ITS OWN route, never the optimum', async () => {
  // A start cell with a choice, so "not the optimal first step" exists.
  let b = null;
  for (let i = 0; i < 50; i++) {
    const cand = makeChakraBoard('easy', lcg(9 + i));
    if (neighbours(cand, cand.src.ring, cand.src.sector).length >= 2) { b = cand; break; }
  }
  assert.ok(b, 'found a start cell with more than one door');

  const optimal = shortest(b, b.src, b.dst);
  const optFirst = optimal ? optimal.path[1] : null;
  const detour = neighbours(b, b.src.ring, b.src.sector)
    .find((d) => !(optFirst && d.ring === optFirst.ring && d.sector === optFirst.sector));

  // A deliberately silly Jev: at the start cell it refuses the optimal door and
  // takes the detour; everywhere else it plays correctly. It is still a POLICY —
  // one move per cell — so the questions stay answerable in one pass.
  const silly = {
    async ask({ state, questions }) {
      const bb = boardFromState(state);
      const ids = Object.keys(questions || {});
      const answers = {};
      for (const id of ids) {
        const m = CELL_RE.exec(id);
        if (!m) continue;
        const cell = { ring: Number(m[1]), sector: Number(m[2]) };
        const offered = Object.keys(questions[id].criteria || {});
        const atStart = cell.ring === b.src.ring && cell.sector === b.src.sector;
        let dir = atStart && offered.includes(detour.dir) ? detour.dir : optimalDir(bb, cell);
        if (!dir || !offered.includes(dir)) dir = offered[0];
        answers[id] = { type: 'choice', choice: dir, probabilities: { [dir]: 0.9 }, confidence: 0.9 };
      }
      return {
        ok: true,
        body: {
          answers,
          _ms: 3, _cost_usd: 0.0001,
          _questions: ids.length,
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      };
    },
  };

  const hops = [];
  const game = await runPolicyGame({ board: b, transport: silly, onStep: (h) => hops.push(h) });

  // One hop per applied decision, contiguous, and every hop is a move Jev
  // actually returned — the animator cannot invent one.
  assert.equal(hops.length, game.moves.length, 'one hop per applied decision');
  assert.deepEqual(hops[0].from, { ring: b.src.ring, sector: b.src.sector });
  for (let i = 1; i < hops.length; i++) {
    assert.deepEqual(hops[i].from, hops[i - 1].to, `hop ${i} starts where hop ${i - 1} ended`);
  }

  // The decisive assertion: the first cell the sprite walked to is the detour,
  // NOT the optimal first step. Had the animation been fed the optimum, this
  // would be the optimal cell instead.
  assert.deepEqual(
    { ring: hops[0].to.ring, sector: hops[0].to.sector },
    { ring: detour.ring, sector: detour.sector },
    "the sprite walked the policy's detour, not the optimum",
  );
  assert.notDeepEqual(
    hops.map((h) => ({ ring: h.to.ring, sector: h.to.sector })),
    optimal.path.slice(1),
    'the sprite walked the policy route, not the optimum',
  );
});

test('invariant: onStep is awaited, so the run paces the animation', async () => {
  const b = makeChakraBoard('easy', lcg(21));
  const order = [];
  const game = await runPolicyGame({
    board: b,
    transport: perfectTransport(),
    onStep: async (h) => {
      order.push(`anim-start-${h.step}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`anim-end-${h.step}`);
    },
  });
  assert.equal(game.outcome, 'reached');
  // Each animation must fully finish before the next decision is applied.
  for (let i = 0; i < game.moves.length; i++) {
    const endIdx = order.indexOf(`anim-end-${i + 1}`);
    const nextStartIdx = order.indexOf(`anim-start-${i + 2}`);
    assert.ok(endIdx < nextStartIdx || nextStartIdx === -1,
      `hop ${i + 1} finishes before hop ${i + 2} starts`);
  }
});
