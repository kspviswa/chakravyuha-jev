// lib/board.js — board generation and the shared types both skins render.
//
// Generation only. It uses referee.boardQuality() for *sanity* (reject dull
// random boards) — that is the allowed, verification-only use of the referee.

import { boardQuality } from './referee.js';

export const DIRS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

export const DIR_OPTIONS = {
  up: 'move one cell up',
  down: 'move one cell down',
  left: 'move one cell left',
  right: 'move one cell right',
  stop: 'the path has no more moves (you have already reached D)',
};

// ---- unweighted grid skin -------------------------------------------------
export const GRID_PRESETS = {
  easy:   { R: 8,  C: 8,  density: 0.14, label: 'Easy · 8×8' },
  medium: { R: 12, C: 12, density: 0.20, label: 'Medium · 12×12' },
  hard:   { R: 16, C: 16, density: 0.26, label: 'Hard · 16×16' },
};

export function makeGridBoard(diffKey) {
  const { R, C, density } = GRID_PRESETS[diffKey];
  let board = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = Array.from({ length: R }, () => new Array(C).fill('.'));
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        if (Math.random() < density) rows[r][c] = '#';
    rows[0][0] = 'S';
    rows[R - 1][C - 1] = 'D';
    const b = { R, C, rows, src: { r: 0, c: 0 }, dst: { r: R - 1, c: C - 1 }, weightless: true };
    const q = boardQuality(b);           // generation sanity only
    if (q.solvable && q.minimumMoves >= Math.max(4, Math.round((R + C) * 0.5))) { board = b; break; }
  }
  if (!board) {
    // essentially impossible after 200 draws; keep a copy board if any
    board = {
      R, C,
      rows: Array.from({ length: R }, (r) => new Array(C).fill(r === 0 ? 'S' : '.')),
      src: { r: 0, c: 0 }, dst: { r: R - 1, c: C - 1 }, weightless: true,
    };
    board.rows[R - 1][C - 1] = 'D';
  }
  board.difficulty = diffKey;
  return board;
}

// ---- navigation skin (city) -----------------------------------------------
export const MAP_SIZES = {
  small:  { R: 10, C: 10, blocks: 4, label: 'Small · 10×10' },
  medium: { R: 14, C: 14, blocks: 6, label: 'Medium · 14×14' },
  large:  { R: 18, C: 18, blocks: 9, label: 'Large · 18×18' },
};

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function carveBlock(rows, blocks, r0, c0, r1, c1) {
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      if (rows[r][c] === '.') rows[r][c] = blocks;
}

/**
 * A city drawn on the same grid model: '.' = road, '#' = building block,
 * 'P' = a park (blocking fakes). Every open cell carries a congestion
 * weight 1..5 (higher = more congested). S = pickup @ top-left, D = flag
 * @ bottom-right. Returns { R, C, rows, weights, src, dst, size }.
 */
export function makeCityBoard(sizeKey) {
  const { R, C, blocks } = MAP_SIZES[sizeKey];
  const rows = Array.from({ length: R }, () => new Array(C).fill('.'));
  const weights = Array.from({ length: R }, () => new Array(C).fill(0));

  // A few building blocks and one park so the grid reads as a real city.
  const placed = [];
  for (let i = 0; i < blocks; i++) {
    const w = randInt(2, 3), h = randInt(2, 3);
    const c = randInt(1, C - w - 2), r = randInt(1, R - h - 2);
    if ((r <= 1 && c <= 1) || (r + h >= R - 2 && c + w >= C - 2)) { i--; continue; }
    placed.push([r, c, r + h - 1, c + w - 1]);
  }
  for (const [r0, c0, r1, c1] of placed) carveBlock(rows, '#', r0, c0, r1, c1);
  carveBlock(rows, 'P', 1, C - 4, 3, C - 2);   // a park near the top-right

  const src = { r: 0, c: 0 };
  const dst = { r: R - 1, c: C - 1 };
  rows[src.r][src.c] = 'S';
  rows[dst.r][dst.c] = 'D';

  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++)
      if (rows[r][c] === '.') weights[r][c] = randInt(1, 5);

  const board = { R, C, rows, weights, src, dst, size: sizeKey };
  if (boardQuality(board).solvable) return board;
  // ridiculously unlikely; fall back to a fully open grid with weights
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) { rows[r][c] = '.'; weights[r][c] = randInt(1, 5); }
  rows[0][0] = 'S'; rows[R - 1][C - 1] = 'D';
  return board;
}