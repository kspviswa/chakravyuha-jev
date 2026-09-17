// lib/referee.js — VERIFICATION ONLY.
//
// This module is deliberately kept out of the game loop. The game loop never
// calls it to DECIDE a move. It is used for exactly two things:
//   1. board generation sanity (make sure a freshly randomised board is solvable)
//   2. the "Referee" panel, which checks Jev's answer after the fact
//
// Two verifiers live here, both read-only against the returned path:
//   - shortestPathLength  BFS, for the unweighted grid skin (fewest moves)
//   - shortestCost        Dijkstra, for the weighted navigation skin (least cost)
// If the app ever used those to pick a path, the demo would be meaningless.

export const DIRS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

export const BLOCKED = { '#': true, P: true };

export function inBounds(board, r, c) {
  return r >= 0 && r < board.R && c >= 0 && c < board.C;
}

export function isOpen(board, r, c) {
  return inBounds(board, r, c) && !BLOCKED[board.rows[r][c]];
}

/**
 * Cost of entering cell (r, c). Weighted boards carry `weights` as a 2-D
 * array of 1..5 (higher = slower). Entering a cell pays its weight; the
 * start cell is never paid. Unweighted boards cost 1 per move.
 */
export function cellCost(board, r, c) {
  if (board.weights && board.weights[r] && Number.isFinite(board.weights[r][c])) {
    return Math.max(0, board.weights[r][c]);
  }
  return 1;
}

/** Breadth-first shortest path length in moves, or null if unreachable. */
export function shortestPathLength(board) {
  const { R, C, src, dst } = board;
  const seen = Array.from({ length: R }, () => new Array(C).fill(false));
  const q = [[src.r, src.c, 0]];
  seen[src.r][src.c] = true;
  while (q.length) {
    const [r, c, d] = q.shift();
    if (r === dst.r && c === dst.c) return d;
    for (const [dr, dc] of Object.values(DIRS)) {
      const nr = r + dr, nc = c + dc;
      if (isOpen(board, nr, nc) && !seen[nr][nc]) {
        seen[nr][nc] = true;
        q.push([nr, nc, d + 1]);
      }
    }
  }
  return null;
}

/**
 * Dijkstra: least total cost from src to dst, or null if unreachable.
 * Every move costs cellCost(board, destRow, destCol); src itself costs 0.
 * Small grids (≤ 18×18) so a plain min-scan heap is plenty fast.
 */
export function shortestCost(board) {
  const { R, C, src, dst } = board;
  if (!isOpen(board, dst.r, dst.c) || !isOpen(board, src.r, src.c)) return null;
  const INF = Infinity;
  const dist = Array.from({ length: R }, () => new Array(C).fill(INF));
  dist[src.r][src.c] = 0;
  const done = Array.from({ length: R }, () => new Array(C).fill(false));
  for (;;) {
    let best = null;
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        if (!done[r][c] && dist[r][c] < INF && (best === null || dist[r][c] < dist[best[0]][best[1]])) {
          best = [r, c];
        }
    if (best === null) break;
    const [r, c] = best;
    if (r === dst.r && c === dst.c) return dist[r][c];
    done[r][c] = true;
    for (const [dr, dc] of Object.values(DIRS)) {
      const nr = r + dr, nc = c + dc;
      if (!isOpen(board, nr, nc)) continue;
      const alt = dist[r][c] + cellCost(board, nr, nc);
      if (alt < dist[nr][nc]) dist[nr][nc] = alt;
    }
  }
  return null;
}

/**
 * Board-generation sanity only: is the board solvable and how far apart are
 * S and D on the shortest (unweighted) path? Verification-only, like
 * everything else in this module.
 */
export function boardQuality(board) {
  const minimumMoves = shortestPathLength(board);
  return { solvable: minimumMoves !== null, minimumMoves };
}

/**
 * Walk the direction list Jev returned, starting at S. Returns the cells
 * visited plus a verdict. This is a *check*, not a search.
 */
export function walkPath(board, moves) {
  const cells = [{ r: board.src.r, c: board.src.c }];
  let r = board.src.r, c = board.src.c;
  let hitWall = false, outOfBounds = false, cost = 0;
  for (const m of moves) {
    if (m === 'stop') break;
    const d = DIRS[m];
    if (!d) { hitWall = true; break; }
    r += d[0]; c += d[1];
    if (!inBounds(board, r, c)) { outOfBounds = true; break; }
    if (!isOpen(board, r, c)) { hitWall = true; break; }
    cost += cellCost(board, r, c);
    cells.push({ r, c });
  }
  const reached = r === board.dst.r && c === board.dst.c;
  return { cells, reached, hitWall, outOfBounds, steps: cells.length - 1, cost };
}

function makeVerdict(board, moves, weighted) {
  const w = walkPath(board, moves);
  const optimal = weighted ? shortestCost(board) : shortestPathLength(board);
  const checks = [
    { name: 'stays in bounds', pass: !w.outOfBounds },
    { name: 'never enters a blocking cell', pass: !w.hitWall },
    { name: 'reaches the destination', pass: w.reached },
    {
      name: weighted ? 'is the least-cost route' : 'is the shortest path',
      pass: w.reached && optimal !== null && (weighted ? w.cost === optimal : w.steps === optimal),
      detail: optimal === null ? 'no route exists' : weighted
        ? `Jev ${w.cost} vs optimal ${optimal}`
        : `Jev ${w.steps} vs optimal ${optimal}`,
    },
  ];
  return { walk: w, optimal, weighted, checks, ok: checks.every((c) => c.pass) };
}

/** Unweighted check (grid skin): shortest path in moves. */
export function verdict(board, moves) {
  return makeVerdict(board, moves, false);
}

/** Weighted check (navigation skin): least-cost route. */
export function verdictWeighted(board, moves) {
  return makeVerdict(board, moves, true);
}