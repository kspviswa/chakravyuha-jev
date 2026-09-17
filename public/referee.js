// referee.js — VERIFICATION ONLY.
//
// This module is deliberately kept out of the game loop. The game loop never
// calls it to decide a move. It is used for exactly two things:
//   1. board generation sanity (make sure a freshly randomised board is solvable)
//   2. the "Referee" panel, which checks Jev's answer after the fact
//
// If the app ever used this to pick a path, the demo would be meaningless.

export const DIRS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

export function inBounds(board, r, c) {
  return r >= 0 && r < board.R && c >= 0 && c < board.C;
}

export function isOpen(board, r, c) {
  return inBounds(board, r, c) && board.rows[r][c] !== '#';
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
 * Board-generation sanity only: is the board solvable and how far apart are
 * S and D on the shortest path? Used by app.js to reject dull random boards.
 * Verification-only, like everything else in this module.
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
  let hitWall = false, outOfBounds = false;
  for (const m of moves) {
    if (m === 'stop') break;
    const d = DIRS[m];
    if (!d) { hitWall = true; break; }
    r += d[0]; c += d[1];
    if (!inBounds(board, r, c)) { outOfBounds = true; break; }
    if (board.rows[r][c] === '#') { hitWall = true; break; }
    cells.push({ r, c });
  }
  const reached = r === board.dst.r && c === board.dst.c;
  return { cells, reached, hitWall, outOfBounds, steps: cells.length - 1 };
}

export function verdict(board, moves) {
  const w = walkPath(board, moves);
  const optimal = shortestPathLength(board);
  const checks = [
    { name: 'stays in bounds', pass: !w.outOfBounds },
    { name: 'never enters a wall', pass: !w.hitWall },
    { name: 'reaches D', pass: w.reached },
    {
      name: 'is the shortest path',
      pass: w.reached && optimal !== null && w.steps === optimal,
      detail: optimal === null ? 'no path exists' : `Jev ${w.steps} vs optimal ${optimal}`,
    },
  ];
  return { walk: w, optimal, checks, ok: checks.every((c) => c.pass) };
}
