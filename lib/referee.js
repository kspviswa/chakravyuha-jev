// lib/referee.js — VERIFICATION ONLY.
//
// This module is deliberately kept out of the game loop. The game loop never
// calls it to DECIDE a move. It is used for exactly two things:
//   1. board-generation sanity (a freshly drawn maze is solvable and long
//      enough) — see chakraQuality.
//   2. checking Jev's answer after the fact — walkChakra / chakraVerdict.
// chakraShortest is the shortest-path search that powers those two checks.
// If the app ever used it to pick a move, the demo would be meaningless.

const POLAR_MOVES = ['inward', 'outward', 'clockwise', 'counterclockwise'];

function warriorSet(board) {
  const set = new Set();
  for (const w of board.warriors || []) set.add(`${w.ring},${w.sector}`);
  return set;
}

/**
 * The legal moves from a polar cell: walls + warriors respected.
 * Returns [{ dir, ring, sector }, …] in order inward, outward,
 * clockwise, counterclockwise. From the centre only outward via the gate.
 */
export function chakraNeighbours(board, ring, sector, blocked) {
  const { R, S, centreGate } = board;
  const warriors = blocked || warriorSet(board);
  const out = [];

  if (ring === 0) {
    if (centreGate !== undefined) out.push({ dir: 'outward', ring: 1, sector: centreGate });
    return out;
  }

  // inward: ring i → i-1; from ring 1 the only door is the centre gate
  if (ring === 1) {
    if (sector === centreGate && !warriors.has(`0,0`)) out.push({ dir: 'inward', ring: 0, sector: 0 });
  } else if (ring > 1) {
    const target = ring - 1;
    if (openRadialAt(board, ring - 1, sector) && !warriors.has(`${target},${sector}`)) {
      out.push({ dir: 'inward', ring: target, sector });
    }
  }

  // outward: ring i → i+1
  if (ring < R && openRadialAt(board, ring, sector) && !warriors.has(`${ring + 1},${sector}`)) {
    out.push({ dir: 'outward', ring: ring + 1, sector });
  }

  // clockwise / counterclockwise within the ring
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

/** openRadial[i-1][s] is the door between ring i and ring i+1 at sector s. */
function openRadialAt(board, ring, sector) {
  if (ring < 1 || ring > board.R - 1) return false;
  return board.openRadial[ring - 1][sector] === true;
}

/** openCirc[i-1][s] is the door between sector s and s+1 in ring i. */
function openCircAt(board, ring, sector) {
  if (ring < 1 || ring > board.R) return false;
  return board.openCirc[ring - 1][sector] === true;
}

function sameCell(a, b) {
  return a && b && a.ring === b.ring && a.sector === b.sector;
}

/** Can `to` be reached from `from` while a `blocked` set of cells is closed? */
export function polarReachable(board, from, to, blocked) {
  const key = (c) => `${c.ring},${c.sector}`;
  const seen = new Set([key(from)]);
  const queue = [{ ring: from.ring, sector: from.sector }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.ring === to.ring && cur.sector === to.sector) return true;
    for (const nb of chakraNeighbours(board, cur.ring, cur.sector, blocked)) {
      const k = key(nb);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ ring: nb.ring, sector: nb.sector });
    }
  }
  return seen.has(key(to));
}

/**
 * Cells (excluding the start and the centre gate) that a warrior may sit on
 * WITHOUT severing the maze — removing one never disconnects src from the
 * centre. Warriors thus always force a detour, never a dead-end corridor.
 * Generation sanity only, same bucket as chakraQuality.
 */
export function safeWarriorCells(board) {
  const { R, S } = board;
  const goal = { ring: 0, sector: 0 };
  const exclude = new Set([`${board.src.ring},${board.src.sector}`, `1,${board.centreGate}`]);
  const safe = [];
  for (let ring = 1; ring <= R; ring++) {
    for (let s = 0; s < S; s++) {
      const key = `${ring},${s}`;
      if (exclude.has(key)) continue;
      if (polarReachable(board, board.src, goal, new Set([key]))) safe.push({ ring, sector: s });
    }
  }
  return safe;
}

/**
 * Breadth-first shortest route over the polar graph. BFS only — walls and
 * warriors are respected via chakraNeighbours. Returns { length, path } (path
 * includes both endpoints) or null when unreachable.
 */
export function chakraShortest(board, from, to) {
  if (!from || !to) return null;
  if (sameCell(from, to)) return { length: 0, path: [{ ring: from.ring, sector: from.sector }] };

  const start = { ring: from.ring, sector: from.sector };
  const goal = { ring: to.ring, sector: to.sector };
  const key = (c) => `${c.ring},${c.sector}`;
  const prev = new Map();
  const seen = new Set([key(start)]);
  const queue = [start];
  let found = null;

  while (queue.length) {
    const cur = queue.shift();
    if (sameCell(cur, goal)) { found = cur; break; }
    for (const nb of chakraNeighbours(board, cur.ring, cur.sector)) {
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

/**
 * Walk a direction list from the board's start. The ONLY place a move list
 * is ever inspected for legality; returns a verdict without revealing any
 * searchable state (cost is null — a polar maze has no per-cell weights).
 */
export function walkChakra(board, moves) {
  const { R, S, centreGate } = board;
  const warriors = warriorSet(board);
  const path = [{ ring: board.src.ring, sector: board.src.sector }];
  let ring = board.src.ring, sector = board.src.sector;
  let hitWall = false, hitWarrior = false, offBoard = false;

  for (const m of moves) {
    if (m === 'stop') break;
    if (!POLAR_MOVES.includes(m)) { offBoard = true; break; }

    let nr = ring, ns = sector;
    if (m === 'inward') {
      if (ring === 1) {
        if (sector !== centreGate) { offBoard = true; break; }
        nr = 0; ns = 0;
      } else if (ring > 1) { nr = ring - 1; }
      else { offBoard = true; break; }
    } else if (m === 'outward') {
      if (ring === 0) { nr = 1; ns = centreGate; }
      else if (ring < R) { nr = ring + 1; }
      else { offBoard = true; break; }
    } else if (m === 'clockwise') {
      ns = (sector + 1) % S;
    } else { // counterclockwise
      ns = (sector - 1 + S) % S;
    }

    if (nr < 0 || nr > R) { offBoard = true; break; }
    if (nr === 0 && (ns !== 0 || m !== 'inward')) { offBoard = true; break; }
    const wk = `${nr},${ns}`;
    if (warriors.has(wk)) { hitWarrior = true; break; }
    if (nr !== 0 && nr !== ring && m === 'inward' && !openRadialAt(board, ring - 1, sector)) { hitWall = true; break; }
    // Outward from the centre leaves through the gate, which is always open —
    // there is no radial wall to test below ring 1.
    if (nr !== 0 && nr !== ring && m === 'outward' && ring >= 1 && !openRadialAt(board, ring, sector)) { hitWall = true; break; }
    if (m === 'clockwise' && !openCircAt(board, ring, sector)) { hitWall = true; break; }
    if (m === 'counterclockwise' && !openCircAt(board, ring, ns)) { hitWall = true; break; }
    if (ring === 0 && m !== 'outward') { offBoard = true; break; }

    ring = nr; sector = ns;
    path.push({ ring, sector });
    if (ring === 0 && sector === 0) break;
  }

  const reached = ring === 0 && sector === 0;
  return {
    path, reached, hitWall, hitWarrior, offBoard,
    steps: path.length - 1, cost: null,
  };
}

/**
 * Generation sanity only: is the maze solvable, how far is the shortest route,
 * and how many warriors sit on at least one shortest route?
 */
export function chakraQuality(board) {
  const s = chakraShortest(board, board.src, board.dst);
  if (!s) return { solvable: false, optimal: null, warriorsOnOptimal: 0 };

  // How many warriors actually change the answer. Because warriors are
  // impassable, a warrior can never lie ON a route — so the meaningful count is
  // the number of warriors whose removal would SHORTEN the route, i.e. the ones
  // forcing Abhimanyu to detour. This is what the `warriors_blocking` question
  // asks Jev on the first step.
  let warriorsOnOptimal = 0;
  for (let i = 0; i < (board.warriors || []).length; i++) {
    const without = { ...board, warriors: board.warriors.filter((_, j) => j !== i) };
    const s2 = chakraShortest(without, board.src, board.dst);
    if (s2 && s2.length < s.length) warriorsOnOptimal++;
  }

  return { solvable: true, optimal: s.length, warriorsOnOptimal };
}

/**
 * The shell-facing check: walk Jev's move list and grade it against the
 * referee's own shortest route. `optimalPath` (the actual optimum) is exposed
 * so the skin can DRAW the labelled comparison overlay — never to choose.
 */
export function chakraVerdict(board, moves) {
  const walk = walkChakra(board, moves);
  const shortest = chakraShortest(board, board.src, board.dst);
  const optimal = shortest ? shortest.length : null;
  const optimalPath = shortest ? shortest.path : null;

  const checks = [
    { name: 'stays within the maze', pass: !walk.offBoard },
    { name: 'never enters a warrior', pass: !walk.hitWarrior },
    { name: 'never crosses a wall', pass: !walk.hitWall },
    { name: 'reaches the centre', pass: walk.reached },
    {
      name: 'is the shortest route to the centre',
      pass: walk.reached && optimal !== null && walk.steps === optimal,
      detail: optimal === null ? 'no route exists' : `Jev ${walk.steps} vs optimal ${optimal}`,
    },
  ];

  return {
    walk, optimal, optimalPath, checks,
    ok: checks.every((c) => c.pass),
    reached: walk.reached, steps: walk.steps, cost: null,
    hitWall: walk.hitWall, hitWarrior: walk.hitWarrior, offBoard: walk.offBoard,
    path: walk.path,
  };
}