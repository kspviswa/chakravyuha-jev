// lib/jev.js — builds the { state, questions } payload for a board and issues
// the ONE round trip. No pathfinding lives here: the payload is pure
// serialisation of a board, and the returned direction list is parsed but
// never second-guessed. Verification happens later, in lib/referee.js.

import { DIR_OPTIONS } from './board.js';

export const COMMON_RULES =
  'Grid coordinates are (row, col), 0-indexed, row 0 at the top. ' +
  'Moves are 4-directional (up, down, left, right). Diagonals are not allowed. Blocking cells cannot be entered.';

const COST_BUCKETS = { '1-20': null, '21-40': null, '41-60': null, '61-80': null, '81-100': null, '100+': null };

// ---- grid skin ------------------------------------------------------------
export function buildGridState(b) {
  return {
    task: 'grid_pathfinding',
    grid: b.rows.map((row) => row.join('')),
    legend: { S: 'source', D: 'destination', '#': 'wall (impassable)', '.': 'open cell' },
    source: { row: b.src.r, col: b.src.c },
    destination: { row: b.dst.r, col: b.dst.c },
    rules: COMMON_RULES + ' Walls (#) cannot be entered.',
    objective: 'Find the shortest path from S to D, expressed as an ordered list of single-cell moves.',
  };
}

const LENGTH_BUCKETS = { '1-5': null, '6-10': null, '11-15': null, '16-20': null, '21-30': null, '31-50': null, '51+': null };

export function buildGridQuestions(b, withCells = false) {
  const K = Math.min(b.R * b.C, 64);
  const q = {
    reachable: {
      type: 'noul',
      instructions: 'Is the destination D reachable from the source S without entering any wall?',
      criteria: { true: 'a path from S to D exists', false: 'no path from S to D exists' },
    },
    path_length: {
      type: 'choice',
      instructions: 'How many single-cell moves does the shortest path from S to D take?',
      criteria: LENGTH_BUCKETS,
    },
    maze_difficulty: {
      type: 'score',
      instructions: 'How hard is this maze to solve by eye?',
      criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
    },
  };
  for (let k = 1; k <= K; k++) {
    q[`move_${k}`] = {
      type: 'choice',
      instructions:
        `Consider the shortest path from S to D on the grid in state.grid. ` +
        `Movement is 4-directional (up, down, left, right), diagonals are not allowed, and walls (#) cannot be entered. ` +
        `What is the direction of move number ${k} along that shortest path? ` +
        `Answer "stop" if the shortest path contains fewer than ${k} moves.`,
      criteria: DIR_OPTIONS,
    };
  }
  if (withCells) {
    for (let r = 0; r < b.R; r++)
      for (let c = 0; c < b.C; c++)
        if (!['#', 'P'].includes(b.rows[r][c]))
          q[`cell_${r}_${c}`] = {
            type: 'noul',
            instructions: `Is the cell at row ${r}, column ${c} (0-indexed, top-left is row 0 column 0) on the shortest path from S to D?`,
          };
  }
  return q;
}

// ---- navigation skin ------------------------------------------------------
export function buildNavState(b) {
  return {
    task: 'navigation_weighted',
    grid: b.rows.map((row) => row.join('')),
    weights: b.weights.map((row) => row.map(Number)),
    legend: {
      S: 'pickup', D: 'drop-off (flag)', '#': 'building block (impassable)',
      P: 'park (impassable)', '.': 'road cell',
      weights: '1–5 per open cell: higher number = more congested, costlier to drive through',
    },
    source: { row: b.src.r, col: b.src.c },
    destination: { row: b.dst.r, col: b.dst.c },
    rules: COMMON_RULES + ' Each open cell carries a congestion weight from `weights` (1–5). Entering a cell costs its weight; the start cell costs nothing. The cost of a route is the sum of the weights of the cells entered.',
    objective: 'Find the least-cost route from the pickup S to the drop-off D, expressed as an ordered list of single-cell moves.',
  };
}

export function buildNavQuestions(b) {
  const K = Math.min(b.R * b.C, 64);
  const moveQuestions = Object.fromEntries(Array.from({ length: K }, (_, i) => [
    `move_${i + 1}`,
    {
      type: 'choice',
      instructions:
        `Consider the least-cost route from the pickup S to the drop-off D on the map in state.grid (movement 4-directional; ` +
        `entering a cell costs its congestion weight from state.weights). What is the direction of move number ${i + 1} along that least-cost route? ` +
        `Answer "stop" if the route contains fewer than ${i + 1} moves.`,
      criteria: DIR_OPTIONS,
    },
  ]));
  return {
    reachable: {
      type: 'noul',
      instructions: 'Is the drop-off D reachable from the pickup S without entering a building or the park?',
      criteria: { true: 'a route exists', false: 'no route exists' },
    },
    cost_band: {
      type: 'choice',
      instructions: 'What is the total congestion cost of the least-cost route from S to D (sum of the weights of the cells entered, start cell free)?',
      criteria: COST_BUCKETS,
    },
    route_difficulty: {
      type: 'score',
      instructions: 'How tricky is the least-cost routing decision on this city map?',
      criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
    },
    eta_band: {
      type: 'choice',
      instructions: 'Roughly how long does the least-cost route take if each congestion unit is about 1 minute of driving?',
      criteria: { 'under 10 min': null, '10–20 min': null, '20–30 min': null, '30–45 min': null, '45+ min': null },
    },
    ...moveQuestions,
  };
}

// ---- move extraction (shared by shell + referee panel) --------------------
export function answerMoves(answers) {
  return Object.keys(answers)
    .filter((k) => k.startsWith('move_'))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((k) => (answers[k]?.type === 'choice' ? answers[k].choice : undefined))
    .filter((m) => m !== undefined);
}

export function answerCells(answers) {
  const out = new Map(); // "r,c" -> noul
  for (const [id, a] of Object.entries(answers)) {
    if (id.startsWith('cell_') && a?.type === 'noul') out.set(id.slice(5).replace('_', ','), a.noul);
  }
  return out;
}

/** One fan-out call, whatever the transport (proxy or direct). */
export async function askJev(transport, { state, questions, model = 'jev-latest', key = '' }) {
  return transport.ask({ state, questions, model, key });
}