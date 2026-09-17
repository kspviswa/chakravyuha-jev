// lib/chakra.js — the Chakravyuha polar-maze model: presets, geometry,
// generation, adjacency helpers and the text serialisation sent to Jev.
//
// Generation sanity (solvable, long enough) is *verified* by the referee in
// lib/referee.js — the only allowed use of the referee from this module. No
// route is ever computed here for the game loop.

import { chakraQuality, polarReachable } from './referee.js';

// ---- difficulty presets ---------------------------------------------------
// warriors = number of dots, braid = fraction of closed walls re-opened so the
// maze keeps loops, minSteps = shortest-path floor the referee must confirm.
export const CHAKRA_PRESETS = {
  easy:   { R: 4, S: 12, warriors: 6,  braid: 0.20, minSteps: 8,  label: 'Easy · 4 rings' },
  medium: { R: 6, S: 16, warriors: 14, braid: 0.12, minSteps: 14, label: 'Medium · 6 rings' },
  hard:   { R: 8, S: 20, warriors: 26, braid: 0.06, minSteps: 22, label: 'Hard · 8 rings' },
};

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

/** Plain-English rules shared by every chakravyuha state. */
export const POLAR_RULES =
  'Rings are numbered 1..R from the inside out; ring 0 is the centre, the goal. ' +
  'Sectors are 0..S-1 around each ring; angle 0 at the top, increasing clockwise, and sectors wrap (S-1 back to 0). ' +
  'Four moves: "inward" moves one ring toward the centre (I → I-1); "outward" moves one ring away (I → I+1); ' +
  '"clockwise" advances one sector ((s+1) mod S); "counterclockwise" retreats one sector ((s-1+S) mod S). ' +
  'The maze is described by open_radial, open_circ and warriors. open_radial[i-1][s] is the door between ring i and ring i+1 ' +
  'at sector s: false blocks both inward and outward across that boundary at that sector. open_circ[i-1][s] is the door ' +
  'between sector s and sector s+1 in ring i: false blocks clockwise (from s) and counterclockwise (from s+1) between those sectors. ' +
  'Warrior cells are impassable — a move into one is forbidden. Only sector centre_gate_sector connects ring 1 to the centre; ' +
  'ring 1 may only enter the centre through it, and from the centre the only exit is outward to that same sector.';

export const POLAR_OBJECTIVE =
  'Pick the single best next move from `abhimanyu` toward the centre (ring 0), expressed as one of the move_* candidates. ' +
  'This is a local one-step judgment — decide the next move well; you are not being asked for a full route plan.';

// ---- geometry -------------------------------------------------------------
/** Radius at which a ring's cell centres sit (spec §3.1). */
export function centreRadius(ring, maxR, R) {
  return (ring - 0.5) * (maxR / R);
}

/** Angle, radians from the top, clockwise, of a sector's cell centre. */
export function centreAngle(sector, S) {
  return (sector + 0.5) * ((2 * Math.PI) / S);
}

export const MOVES = ['inward', 'outward', 'clockwise', 'counterclockwise'];

export const MOVE_WORDS = {
  inward: 'inward (one ring toward the centre)',
  outward: 'outward (one ring away from the centre)',
  clockwise: 'clockwise (sector +1)',
  counterclockwise: 'counterclockwise (sector -1)',
  stop: 'stop — the route ends here, already at the centre',
};

export function cellKey(ring, sector) {
  return `${ring},${sector}`;
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---- raw draw (one unverified maze; the redrawing loop verifies) ---------
/**
 * A single maze draw. Exported so tests can measure the acceptance rate of a
 * preset before the redraw loop the way the spec asks (§3.3).
 */
export function drawChakra(diffKey, rng = Math.random) {
  const p = CHAKRA_PRESETS[diffKey];
  const { R, S } = p;

  const openRadial = Array.from({ length: R - 1 }, () => new Array(S).fill(false));
  const openCirc = Array.from({ length: R }, () => new Array(S).fill(false));

  const centreGate = randInt(rng, 0, S - 1);

  // ---- randomised spanning tree over centre + R*S cells -------------------
  const cellId = (ring, sector) => (ring === 0 ? 0 : 1 + (ring - 1) * S + sector);
  const idCell = (id) => (id === 0 ? { ring: 0, sector: 0 } : { ring: 1 + Math.floor((id - 1) / S), sector: (id - 1) % S });

  const total = 1 + R * S;
  const visited = new Uint8Array(total);
  const seen = (id) => visited[id] === 1;
  const mark = (id) => { visited[id] = 1; };

  /** Candidate tree edges from (ring, sector). Returns { ring, sector, kind, a, b } */
  const treeNeighbours = (ring, sector) => {
    const out = [];
    if (ring === 0) {
      out.push({ ring: 1, sector: centreGate, kind: 'radial' });
      return out;
    }
    if (ring < R) out.push({ ring: ring + 1, sector, kind: 'radial' });
    if (ring > 1) out.push({ ring: ring - 1, sector, kind: 'radial' });
    out.push({ ring, sector: (sector + 1) % S, kind: 'circ' });
    out.push({ ring, sector: (sector - 1 + S) % S, kind: 'circ' });
    return out;
  };

  const openEdge = (from, to, kind) => {
    if (kind === 'radial') {
      // The centre thigh is always open (referee semantics) — the tree edge to
      // the gate only exists for connectivity in the DFS, so it writes nothing.
      const min = Math.min(from.ring, to.ring);
      if (min < 1) return;
      // door between rings min and min+1 at the shared sector
      openRadial[min - 1][from.sector] = true;
    } else {
      openCirc[from.ring - 1][from.sector] = true; // door between sector and sector+1 in that ring
    }
  };

  // randomised DFS with an explicit stack (deterministic under an injected rng)
  const stack = [];
  mark(0);
  stack.push(idCell(0));
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const nbs = treeNeighbours(cur.ring, cur.sector);
    // shuffle with the injected rng
    for (let i = nbs.length - 1; i > 0; i--) {
      const j = randInt(rng, 0, i);
      const tmp = nbs[i]; nbs[i] = nbs[j]; nbs[j] = tmp;
    }
    let next = null;
    for (const nb of nbs) {
      const id = cellId(nb.ring, nb.sector);
      if (!seen(id)) { next = nb; break; }
    }
    if (!next) { stack.pop(); continue; }
    openEdge(cur, next, next.kind);
    mark(cellId(next.ring, next.sector));
    stack.push(next);
  }

  // ---- braid: re-open a fraction of the closed walls so loops appear -------
  for (let i = 1; i < R; i++) {
    for (let s = 0; s < S; s++) {
      if (!openRadial[i - 1][s] && rng() < p.braid) openRadial[i - 1][s] = true;
    }
  }
  for (let i = 1; i <= R; i++) {
    for (let s = 0; s < S; s++) {
      if (!openCirc[i - 1][s] && rng() < p.braid) openCirc[i - 1][s] = true;
    }
  }

  // ---- start + warriors -----------------------------------------------------
  const src = { ring: R, sector: randInt(rng, 0, S - 1) };
  // Warriors are placed SEQUENTIALLY, each one only on a cell whose closure
  // still leaves the centre reachable from src given every warrior already
  // placed (polarReachable + blocked). A warrior therefore always forces a
  // detour — several of them can never jointly sever the maze. This is what
  // keeps the "≥15% of raw draws accepted" bar honest instead of lucky.
  const provisional = { R, S, openRadial, openCirc, centreGate, warriors: [], src, dst: { ring: 0, sector: 0 } };
  const goal = { ring: 0, sector: 0 };
  const excludedCells = new Set([cellKey(src.ring, src.sector), cellKey(1, centreGate)]);
  const candidates = [];
  for (let i = 1; i <= R; i++) for (let s = 0; s < S; s++) {
    const k = cellKey(i, s);
    if (!excludedCells.has(k)) candidates.push({ ring: i, sector: s });
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const t = candidates[i]; candidates[i] = candidates[j]; candidates[j] = t;
  }
  const warriors = [];
  const blocked = new Set();
  for (const cell of candidates) {
    if (warriors.length >= p.warriors) break;
    const k = cellKey(cell.ring, cell.sector);
    if (blocked.has(k)) continue;
    const test = new Set(blocked);
    test.add(k);
    if (polarReachable(provisional, src, goal, test)) {
      warriors.push(cell);
      blocked.add(k);
    }
  }

  return {
    R, S,
    openRadial, openCirc,
    centreGate,
    warriors,
    src,
    dst: { ring: 0, sector: 0 },
    difficulty: diffKey,
    label: p.label,
  };
}

/** Redraw until a fresh draw passes: solvable, deep enough, exact warrior count. */
export function makeChakraBoard(diffKey, rng = Math.random) {
  const p = CHAKRA_PRESETS[diffKey];
  for (let attempt = 0; attempt < 200; attempt++) {
    const b = drawChakra(diffKey, rng);
    const q = chakraQuality(b);
    if (q.solvable && q.optimal >= p.minSteps && b.warriors.length === p.warriors) return b;
  }
  // Astronomically unlikely to reach here (every preset accepts ≥ ~40% of raw
  // draws). Rather than hand a dead maze to the player, relax the quality bar
  // and only require the maze to be solvable.
  for (let attempt = 0; attempt < 2000; attempt++) {
    const b = drawChakra(diffKey, rng);
    if (chakraQuality(b).solvable && b.warriors.length === p.warriors) return b;
  }
  return drawChakra(diffKey, rng);
}

// ---- serialisation for Jev --------------------------------------------------
export function chakraState(board, { ring, sector, visited, step, maxSteps, reversal = null }) {
  const state = {
    task: 'chakravyuha_policy',
    maze: { rings: board.R, sectors: board.S, centre_gate_sector: board.centreGate },
    open_radial: board.openRadial,
    open_circ: board.openCirc,
    warriors: board.warriors,
    abhimanyu: { ring, sector },
    goal: 'the centre (ring 0)',
    visited: (visited || []).map((v) => ({ ring: v.ring, sector: v.sector })),
    step,
    maxSteps,
    rules: POLAR_RULES,
    objective: POLAR_OBJECTIVE,
  };
  if (reversal) state.reversal = reversal;
  return state;
}

// ---- board hash --------------------------------------------------------------
/** FNV-1a over the maze's topology + warriors so identical mazes share a hash. */
export function boardHash(b) {
  const parts = [
    b.R, b.S, b.centreGate,
    b.openRadial.map((r) => r.map((x) => (x ? 1 : 0)).join('')).join('|'),
    b.openCirc.map((r) => r.map((x) => (x ? 1 : 0)).join('')).join('|'),
    b.warriors.map((w) => `${w.ring},${w.sector}`).sort().join(';'),
  ];
  let h = 2166136261;
  const s = parts.join('/');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}