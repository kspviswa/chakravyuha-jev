// lib/chakra.js — the Chakravyuha polar-maze model: presets, geometry,
// generation, adjacency helpers, the shortest-route search, and the
// text serialisation sent to Jev.
//
// The maze knows its own doors and its own shortest route.
// shortest() is the ONLY search in the codebase. It may be called by
// the shell (after a run ends) and by maze generation. It must never
// be reachable from lib/jev.js.

// ---- difficulty presets ---------------------------------------------------
// warriors = number of dots, braid = fraction of closed walls re-opened so the
// maze keeps loops, minSteps = shortest-path floor the model must confirm.
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
  'Find a shortest route for Abhimanyu from his current cell to the centre, obeying the doors and never entering a warrior cell. ' +
  'The questions ask for that route move by move, all at once: move_1 is the first move of the route, ' +
  'move_2 is the move after it, and so on. Every answer is one of: inward, outward, clockwise, counterclockwise. ' +
  'A route never passes through the same cell twice, and the centre is entered only through sector centre_gate_sector. ' +
  'Answer every question independently, as a move of one and the same shortest route.';

/** The policy objective. Each question names ONE cell and offers only the doors
 *  that really open from it, so the questions are genuinely independent and a
 *  route never has to be reconstructed across them. */
export const POLAR_POLICY_OBJECTIVE =
  'For EVERY cell of the maze, name the FIRST move of a shortest route from that cell to the centre. ' +
  'Each question names one cell, and the options it offers are exactly the doors that open from that cell. ' +
  'The questions are independent of one another: no question depends on the answer to any other, so answer each one ' +
  'from the cell it names. Choose the offered move that is the first step of a shortest route from that cell to the centre. ' +
  'A route never passes through the same cell twice, and the centre is entered only through sector centre_gate_sector.';

/** Generic description of each move, independent of the cell it is taken from.
 *  The path questions ask about move_k at an unknown cell, so the criteria must
 *  not name a destination — only what the direction means. */
export const MOVE_CRITERIA = {
  inward: 'one ring toward the centre (I → I-1), same sector',
  outward: 'one ring away from the centre (I → I+1), same sector',
  clockwise: 'one sector clockwise ((s+1) mod S), same ring',
  counterclockwise: 'one sector counterclockwise ((s-1+S) mod S), same ring',
};

export const MOVES = ['inward', 'outward', 'clockwise', 'counterclockwise'];

export const MOVE_WORDS = {
  inward: 'inward',
  outward: 'outward',
  clockwise: 'clockwise',
  counterclockwise: 'counterclockwise',
  stop: 'stop',
};

export function cellKey(ring, sector) {
  return `${ring},${sector}`;
}

/** Radius of the centre circle for a given ring index. */
export function centreRadius(ring, totalRadius, numRings) {
  return ((ring - 0.5) / numRings) * totalRadius;
}

/** Sector angle in radians, measured clockwise from the top. */
export function centreAngle(sector, numSectors) {
  return (sector + 0.5) * 2 * Math.PI / numSectors;
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---- helpers -------------------------------------------------------------
const POLAR_MOVES = ['inward', 'outward', 'clockwise', 'counterclockwise'];

function warriorSet(board) {
  const set = new Set();
  for (const w of board.warriors || []) set.add(`${w.ring},${w.sector}`);
  return set;
}

function openRadialAt(board, ring, sector) {
  if (ring < 1 || ring > board.R - 1) return false;
  return board.openRadial[ring - 1][sector] === true;
}

function openCircAt(board, ring, sector) {
  if (ring < 1 || ring > board.R) return false;
  return board.openCirc[ring - 1][sector] === true;
}

// ---- adjacency ------------------------------------------------------------
/** The open doors from (ring, sector): [{ dir, ring, sector }]. `blocked` is
 *  an optional Set of "ring,sector" keys (used by generation to test warrior cells). */
export function neighbours(board, ring, sector, blocked) {
  const { R, S, centreGate } = board;
  const warriors = blocked || warriorSet(board);
  const out = [];

  if (ring === 0) {
    if (centreGate !== undefined) out.push({ dir: 'outward', ring: 1, sector: centreGate });
    return out;
  }

  if (ring === 1) {
    if (sector === centreGate && !warriors.has(`0,0`)) out.push({ dir: 'inward', ring: 0, sector: 0 });
  } else if (ring > 1) {
    const target = ring - 1;
    if (openRadialAt(board, ring - 1, sector) && !warriors.has(`${target},${sector}`)) {
      out.push({ dir: 'inward', ring: target, sector });
    }
  }

  if (ring < R && openRadialAt(board, ring, sector) && !warriors.has(`${ring + 1},${sector}`)) {
    out.push({ dir: 'outward', ring: ring + 1, sector });
  }

  const cw = (sector + 1) % S;
  if (openCircAt(board, ring, sector) && !warriors.has(`${ring},${cw}`)) {
    out.push({ dir: 'clockwise', ring, sector: cw });
  }
  const ccw = (sector - 1 + S) % S;
  if (openCircAt(board, ring, ccw) && !warriors.has(`${ring},${ccw}`)) {
    out.push({ dir: 'counterclockwise', ring, sector: ccw });
  }

  return out;
}

// ---- BFS shortest route ---------------------------------------------------
/** The id of the policy question about one cell. */
export const policyQuestionId = (ring, sector) => `cell_${ring}_${sector}`;

/**
 * Every cell a policy question can be asked about: rings 1..R × sectors 0..S-1.
 * Ring 0 is the centre — the goal, never a cell to ask about. A cell with no
 * door at all is skipped: nothing can be answered about it, and the walk reports
 * it as boxed in.
 */
export function policyCells(board) {
  const cells = [];
  for (let ring = 1; ring <= board.R; ring++) {
    for (let sector = 0; sector < board.S; sector++) {
      if (neighbours(board, ring, sector).length === 0) continue;
      cells.push({ ring, sector });
    }
  }
  return cells;
}

/**
 * THE POLICY, ONE PASS: one question per cell, each naming its own cell and
 * offering only the doors that really open from it. Because every question is
 * self-contained, answering them independently is correct rather than
 * contradictory — which is what parallel questions require.
 *
 * `banned` maps a cell key to a Set of directions struck out after the walk
 * doubled back there. Striking a move is a repair, never a hint: it removes an
 * option the model already chose and the doors refused.
 *
 * `cells` narrows the ask to an explicit list. Passing the single cell the walk
 * is standing on is what makes step-by-step mode possible: the question text is
 * byte-identical to the batch ask, so the two modes differ in exactly one
 * respect — how many questions ride in a call.
 */
export function chakraPolicyQuestions(board, { banned = new Map(), cells = null } = {}) {
  const questions = {};
  for (const { ring, sector } of (cells || policyCells(board))) {
    const no = banned.get(`${ring},${sector}`);
    const options = neighbours(board, ring, sector).filter((o) => !no?.has(o.dir));
    if (options.length === 0) continue;
    const criteria = {};
    for (const o of options) {
      criteria[o.dir] = o.ring === 0
        ? 'inward into the centre (ring 0, sector 0)'
        : `moves to ring ${o.ring}, sector ${o.sector}`;
    }
    questions[policyQuestionId(ring, sector)] = {
      type: 'choice',
      instructions:
        `Abhimanyu stands at ring ${ring}, sector ${sector}. The centre is ring 0, sector 0. ` +
        `Which move is the first step of a shortest route from this cell to the centre?`,
      criteria,
    };
  }
  return questions;
}

/** BFS shortest route. Returns { length, path } (path includes both endpoints)
 *  or null when unreachable. This is the ONLY search in the codebase.
 *  Optional `blocked` is a Set of "ring,sector" keys used by generation. */
export function shortest(board, from, to, blocked) {
  if (!from || !to) return null;
  if (from.ring === to.ring && from.sector === to.sector) return { length: 0, path: [{ ring: from.ring, sector: from.sector }] };

  const start = { ring: from.ring, sector: from.sector };
  const goal = { ring: to.ring, sector: to.sector };
  const key = (c) => `${c.ring},${c.sector}`;
  const prev = new Map();
  const seen = new Set([key(start)]);
  const queue = [start];
  let found = null;

  while (queue.length) {
    const cur = queue.shift();
    if (cur.ring === goal.ring && cur.sector === goal.sector) { found = cur; break; }
    for (const nb of neighbours(board, cur.ring, cur.sector, blocked)) {
      const k = key(nb);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, cur);
      queue.push({ ring: nb.ring, sector: nb.sector });
    }
  }
  if (!found) return null;

  const path = [];
  let cur = found;
  while (cur) {
    path.push({ ring: cur.ring, sector: cur.sector });
    cur = prev.get(key(cur));
  }
  path.reverse();
  return { length: path.length - 1, path };
}

// ---- raw draw (one unverified maze; the redrawing loop verifies) ---------
/**
 * A single maze draw. Exported so tests can measure the acceptance rate of a
 * preset before the redraw loop the way the spec asks (§3.3).
 */
export function drawChakra(diffKey, rng = Math.random, opts = {}) {
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
      const min = Math.min(from.ring, to.ring);
      if (min < 1) return;
      openRadial[min - 1][from.sector] = true;
    } else {
      openCirc[from.ring - 1][from.sector] = true;
    }
  };

  // randomised DFS with an explicit stack (deterministic under an injected rng)
  const stack = [];
  mark(0);
  stack.push(idCell(0));
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const nbs = treeNeighbours(cur.ring, cur.sector);
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
  // Obstacle toggle: with warriors off the board is a pure wall maze — no
  // impassable cell — so the only thing that can stop a run is a wall.
  const warriorTarget = opts.warriors === false ? 0 : p.warriors;
  for (const cell of candidates) {
    if (warriors.length >= warriorTarget) break;
    const k = cellKey(cell.ring, cell.sector);
    if (blocked.has(k)) continue;
    const test = new Set(blocked);
    test.add(k);
    if (shortest(provisional, src, goal, test) !== null) {
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

// ---- makeChakraBoard -------------------------------------------------------
/** Redraw until a fresh draw passes: solvable, deep enough, exact warrior count.
 *  The quality check is inlined: shortest() returns a route at least minSteps
 *  long AND warriors.length === preset.warriors. */
export function makeChakraBoard(diffKey, rng = Math.random, opts = {}) {
  const p = CHAKRA_PRESETS[diffKey];
  const warriorTarget = opts.warriors === false ? 0 : p.warriors;
  for (let attempt = 0; attempt < 200; attempt++) {
    const b = drawChakra(diffKey, rng, opts);
    const s = shortest(b, b.src, b.dst);
    if (s && s.length >= p.minSteps && b.warriors.length === warriorTarget) return b;
  }
  for (let attempt = 0; attempt < 2000; attempt++) {
    const b = drawChakra(diffKey, rng, opts);
    const s = shortest(b, b.src, b.dst);
    if (s && b.warriors.length === warriorTarget) return b;
  }
  return drawChakra(diffKey, rng, opts);
}

// ---- serialisation for Jev --------------------------------------------------
export function chakraState(board, { ring, sector, visited, step, maxSteps, askMoves = 0 }) {
  const state = {
    task: askMoves > 0 ? 'chakravyuha_path' : 'chakravyuha_step',
    maze: { rings: board.R, sectors: board.S, centre_gate_sector: board.centreGate },
    open_radial: board.openRadial,
    open_circ: board.openCirc,
    warriors: board.warriors,
    abhimanyu: { ring, sector },
    centre: { ring: 0, sector: 0 },
    visited: (visited || []).map((v) => ({ ring: v.ring, sector: v.sector })),
    rules: POLAR_RULES,
    objective: POLAR_OBJECTIVE,
  };
  if (askMoves > 0) {
    // Path mode: one call asks for the whole route. The step/maxSteps fields
    // belong to the retired per-step loop and would only mislead the model.
    state.ask_moves = askMoves;
    state.start = { ring, sector };
  } else {
    state.step = step;
    state.maxSteps = maxSteps;
  }
  return state;
}

/**
 * The state for a policy call. There is no single "where Abhimanyu is" here —
 * every question names its own cell — so no abhimanyu field is emitted: naming
 * one would contradict the questions. The topology is the whole state.
 */
export function chakraPolicyState(board) {
  return {
    task: 'chakravyuha_policy',
    maze: { rings: board.R, sectors: board.S, centre_gate_sector: board.centreGate },
    open_radial: board.openRadial,
    open_circ: board.openCirc,
    warriors: board.warriors,
    centre: { ring: 0, sector: 0 },
    rules: POLAR_RULES,
    objective: POLAR_POLICY_OBJECTIVE,
  };
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

/** BFS distance helper. */
function bfsDist(board, from, to) {
  const s = shortest(board, from, to);
  return s ? s.length : null;
}

/**
 * The shortest route as cells, for the post-run comparison overlay.
 * Named for its purpose so the shell reads honestly: this may be called ONLY
 * after a run has ended, to compare what Jev chose against what was optimal.
 * It is a thin alias over shortest() — the single search in the codebase — so
 * that the shell (app.js) and the skin never spell the search's own name.
 */
export function optimalRoute(board, from, to) {
  return shortest(board, from, to);
}

/** Compute stepAccuracy: fraction of steps that reduce BFS distance by exactly 1. */
/**
 * Distance to the goal in moves, or null if unreachable. A plain number, so a
 * caller can compare two cells' distances without unpacking a whole route.
 */
export function distanceToGoal(board, ring, sector) {
  if (!board.dst) return null;
  const s = shortest(board, { ring, sector }, board.dst);
  return s ? s.length : null;
}

/**
 * The move our own calculation says is correct from this cell: the first step
 * of a shortest route to the goal. null at the goal itself, or if unreachable.
 *
 * This is the walk's ground truth. It exists because the walk must be able to
 * overrule the model: when Jev is unsure, or answers with something that cannot
 * be played, the walk takes THIS move instead and marks the step red. The old
 * rule — that the game loop never knows the route — is deliberately lifted, and
 * that is precisely what makes the green/red split a measurement: a green step
 * is the model's own move, played without help.
 */
export function referenceMove(board, ring, sector) {
  if (!board.dst) return null;
  if (ring === board.dst.ring && sector === board.dst.sector) return null;
  const s = shortest(board, { ring, sector }, board.dst);
  if (!s || s.path.length < 2) return null;
  const nxt = s.path[1];
  const e = neighbours(board, ring, sector).find((c) => c.ring === nxt.ring && c.sector === nxt.sector);
  return e ? e.dir : null;
}

/** The candidate that lands closest to the goal — the best move left when the
 *  reference move itself is unavailable (its cell already walked). */
export function nearestToGoal(board, cands) {
  let best = null, bestD = null;
  for (const c of cands) {
    const d = distanceToGoal(board, c.ring, c.sector);
    if (d === null) continue;
    if (bestD === null || d < bestD) { best = c; bestD = d; }
  }
  return best || (cands.length ? cands[0] : null);
}

export function computeStepAccuracy(board, moves, src) {
  const flags = stepCorrectness(board, moves, src);
  if (!flags || flags.length === 0) return null;
  return flags.filter(Boolean).length / flags.length;
}

/**
 * Per-step correctness: true where a move strictly reduced the distance to the
 * goal, false where it did not, and it stops at the first unplayable move.
 * computeStepAccuracy is this, averaged — one definition, so a confidence
 * breakdown can never disagree with the headline accuracy beside it.
 */
export function stepCorrectness(board, moves, src) {
  if (moves.length === 0) return null;
  let dist = bfsDist(board, src, board.dst);
  if (dist === null) return null;
  const flags = [];
  let cur = { ...src };
  for (const dir of moves) {
    const cands = neighbours(board, cur.ring, cur.sector);
    const next = cands.find((c) => c.dir === dir);
    if (!next) break;
    const newDist = bfsDist(board, next, board.dst);
    flags.push(newDist !== null && dist === newDist + 1);
    dist = newDist;
    cur = { ring: next.ring, sector: next.sector };
  }
  return flags;
}
