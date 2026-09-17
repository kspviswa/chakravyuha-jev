// lib/jev.js — builds the { state, questions } payload for a board and issues
// the ONE round trip. No pathfinding lives here: the payload is pure
// serialisation of a board, and the returned direction list is parsed but
// never second-guessed. Verification happens later, in lib/referee.js.

import { DIRS, DIR_OPTIONS } from './board.js';

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

// ---- policy mode: Jev as a reactive, one-step policy ------------------------
//
// The loop is ASK → APPLY → ASK → APPLY until D or a cap. At each step we
// enumerate the legal action space (up to four in-bounds, non-wall
// neighbours), fan out ONE `move_<dir>` Noul per candidate, and apply the
// candidate with the highest probability (argmax over Jev's own numbers).
// Enumerating the action space and taking an argmax is not searching: no
// path is computed here, no lookahead happens, and lib/referee.js only
// *checks* the walked route afterwards.

/** In-bounds, non-wall orthogonal neighbours of (r, c) in DIRS order. */
export function legalNeighbours(board, r, c) {
  const out = [];
  for (const [name, [dr, dc]] of Object.entries(DIRS)) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= board.R || nc < 0 || nc >= board.C) continue;
    const ch = board.rows[nr]?.[nc];
    if (ch === '#' || ch === 'P') continue;
    out.push({ dir: name, row: nr, col: nc });
  }
  return out;
}

export function keyOf(row, col) {
  return `${row},${col}`;
}

/** The probability Jev assigned to one move_* answer (noul or choice). */
export function choiceProbability(ans) {
  if (!ans) return 0;
  if (typeof ans.noul === 'number') return Math.max(0, Math.min(1, ans.noul));
  if (ans.type === 'choice' && typeof ans.probabilities?.[ans.choice] === 'number') {
    return Math.max(0, Math.min(1, ans.probabilities[ans.choice]));
  }
  if (typeof ans.confidence === 'number') return Math.max(0, Math.min(1, ans.confidence));
  return 0;
}

/**
 * The candidate Jev judged most promising, or null when nothing answered.
 * A candidate with no answer at all is skipped; if no candidate was answered,
 * there is no signal and we return null (the loop then stops honestly as
 * 'stuck' rather than inventing a move from a default of 0).
 */
export function stepArgmax(candidates, answers) {
  let best = null;
  for (const cand of candidates) {
    const ans = answers?.[`move_${cand.dir}`];
    if (ans === undefined || ans === null) continue;
    const p = choiceProbability(ans);
    if (best === null || p > best.p) best = { ...cand, p };
  }
  return best;
}

function rowsToStrings(board) {
  return board.rows.map((row) => (typeof row === 'string' ? row : row.join('')));
}

function serializeTrail(visited) {
  return (visited || []).map((v) => ({ row: v.row, col: v.col }));
}

export function buildPolicyGridState(board, { r, c, visited, step, maxSteps, reversal = null }) {
  const state = {
    task: 'grid_policy',
    grid: rowsToStrings(board),
    legend: { S: 'source', D: 'destination', '#': 'wall (impassable)', '.': 'open cell' },
    source: { row: board.src.r, col: board.src.c },
    destination: { row: board.dst.r, col: board.dst.c },
    position: { row: r, col: c },
    visited: serializeTrail(visited),
    step,
    maxSteps,
    rules: COMMON_RULES +
      ' The agent is at `position` and must reach `destination`. `visited` lists the cells it has already stepped on in this run so far. Entering a wall fails the run.',
    objective:
      'Pick the single best next move from `position` toward the destination, expressed as one of the `move_*` candidates. This is a local one-step judgment, not a full route plan.',
  };
  if (reversal) state.reversal = reversal;
  return state;
}

export function buildPolicyNavState(board, { r, c, visited, step, maxSteps, reversal = null }) {
  const state = {
    task: 'navigation_policy',
    grid: rowsToStrings(board),
    weights: board.weights.map((row) => row.map(Number)),
    legend: {
      S: 'pickup', D: 'drop-off (flag)', '#': 'building block (impassable)',
      P: 'park (impassable)', '.': 'road cell',
      weights: '1–5 per open cell: higher number = more congested, costlier to drive through',
    },
    source: { row: board.src.r, col: board.src.c },
    destination: { row: board.dst.r, col: board.dst.c },
    position: { row: r, col: c },
    visited: serializeTrail(visited),
    step,
    maxSteps,
    rules: COMMON_RULES +
      ' Each open cell carries a congestion weight from `weights` (1–5); entering a cell costs its weight, the start cell costs nothing. Entering a building or the park fails the run.',
    objective:
      'Pick the single best next move from `position` toward the drop-off, expressed as one of the `move_*` candidates, steering toward the least-congested route. A local one-step judgment, not a full route plan.',
  };
  if (reversal) state.reversal = reversal;
  return state;
}

export function buildPolicyGridQuestions(board, candidates, opts = {}) {
  const { r, c, firstStep = false, reversal = null } = opts;
  const q = {};
  if (firstStep) {
    q.reachable = {
      type: 'noul',
      instructions: 'Is the destination D reachable from the source S without entering any wall?',
      criteria: { true: 'a way from S to D exists', false: 'no way from S to D exists' },
    };
    q.path_length = {
      type: 'choice',
      instructions: 'Roughly how many single-cell moves is the distance from S to D?',
      criteria: LENGTH_BUCKETS,
    };
    q.maze_difficulty = {
      type: 'score',
      instructions: 'How hard is this maze to solve by eye?',
      criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
    };
  }
  const warning = reversal ? ` Note: stepping ${reversal} was already tried and would loop back.` : '';
  for (const cand of candidates) {
    q[`move_${cand.dir}`] = {
      type: 'noul',
      instructions:
        `The agent is at row ${r}, col ${c} and the goal D is at row ${board.dst.r}, col ${board.dst.c}. ` +
        `Moving ${cand.dir} to row ${cand.row}, col ${cand.col} — is this a good next step toward the goal? ` +
        `It must not enter a wall, should keep the walk short, and should not wander into a dead end.${warning}`,
    };
  }
  return q;
}

export function buildPolicyNavQuestions(board, candidates, opts = {}) {
  const { r, c, firstStep = false, reversal = null } = opts;
  const q = {};
  if (firstStep) {
    q.reachable = {
      type: 'noul',
      instructions: 'Is the drop-off D reachable from the pickup S without entering a building or the park?',
      criteria: { true: 'a route exists', false: 'no route exists' },
    };
    q.cost_band = {
      type: 'choice',
      instructions: 'Roughly what is the total congestion cost of the least-congested route from S to D (sum of the weights entered, start cell free)?',
      criteria: COST_BUCKETS,
    };
    q.eta_band = {
      type: 'choice',
      instructions: 'Roughly how long does that least-congested route take if each congestion unit is about 1 minute of driving?',
      criteria: { 'under 10 min': null, '10–20 min': null, '20–30 min': null, '30–45 min': null, '45+ min': null },
    };
    q.route_difficulty = {
      type: 'score',
      instructions: 'How tricky is the least-congestion routing decision on this city map?',
      criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
    };
  }
  const warning = reversal ? ` Note: stepping ${reversal} was already tried and would loop back.` : '';
  for (const cand of candidates) {
    const weight = board.weights?.[cand.row]?.[cand.col] ?? 1;
    q[`move_${cand.dir}`] = {
      type: 'noul',
      instructions:
        `The pickup is at row ${r}, col ${c} and the drop-off flag D is at row ${board.dst.r}, col ${board.dst.c}. ` +
        `Moving ${cand.dir} to row ${cand.row}, col ${cand.col} enters a road cell with congestion weight ${weight}. ` +
        `Is this a good next step toward the least-congested route to the flag? It must not enter a building or the park and should avoid dead ends and heavy congestion.${warning}`,
    };
  }
  return q;
}

/**
 * Drive the policy loop: ASK → APPLY → ASK, argmax over Jev's nouls, with an
 * honest stuck/exhausted stop (no backtracking search). Returns everything the
 * shell needs to draw the run and fill the meters.
 */
export async function runPolicyGame({
  board, transport, model = 'jev-latest', key = '',
  weighted = false,
}) {
  const R = board.R, C = board.C;
  const maxSteps = 4 * (R + C);
  const dst = board.dst;
  const nav = !!weighted;
  const stateFor = nav ? buildPolicyNavState : buildPolicyGridState;
  const questionsFor = nav ? buildPolicyNavQuestions : buildPolicyGridQuestions;

  const visited = [{ row: board.src.r, col: board.src.c }];
  const visitedSet = new Set([keyOf(board.src.r, board.src.c)]);
  let r = board.src.r, c = board.src.c;

  const moves = [];
  const applied = [];
  const calls = [];
  const reversedDirs = [];
  let outcome = null;
  let error = null;

  for (let step = 1; step <= maxSteps && !outcome; step++) {
    if (r === dst.r && c === dst.c) { outcome = 'reached'; break; }
    const candidates = legalNeighbours(board, r, c);
    const fresh = candidates.filter((cd) => !visitedSet.has(keyOf(cd.row, cd.col)));
    if (fresh.length === 0) { outcome = 'stuck'; break; }

    let reversal = null;
    let appliedThisStep = false;
    for (let ask = 1; ask <= 2 && !appliedThisStep && !outcome; ask++) {
      const firstStep = step === 1 && ask === 1;
      const state = stateFor(board, { r, c, visited, step, maxSteps, reversal });
      const questions = questionsFor(board, candidates, { r, c, step, firstStep, reversal });
      const res = await askJev(transport, { state, questions, model, key });
      if (!res.ok) { outcome = 'error'; error = res.error || { code: 'error', message: 'policy call failed' }; break; }
      const body = res.body || {};
      calls.push({ step, ask, firstStep, state, questions, res: body });
      const picked = stepArgmax(candidates, body.answers);
      if (!picked) { outcome = 'stuck'; break; }
      if (ask === 1 && visitedSet.has(keyOf(picked.row, picked.col))) {
        reversal = picked.dir;
        reversedDirs.push(`${step}:${picked.dir}`);
        continue;
      }
      appliedThisStep = true;
      moves.push(picked.dir);
      const probabilities = {};
      for (const cand of candidates) probabilities[cand.dir] = choiceProbability(body.answers[`move_${cand.dir}`]);
      applied.push({
        step, dir: picked.dir, confidence: picked.p,
        probabilities,
        _ms: Number(body._ms) || 0,
        _cost_usd: Number(body._cost_usd) || 0,
        _questions: Object.keys(questions).length,
      });
      r = picked.row; c = picked.col;
      visited.push({ row: r, col: c });
      visitedSet.add(keyOf(r, c));
    }
  }
  if (!outcome) outcome = r === dst.r && c === dst.c ? 'reached' : 'exhausted';

  return {
    board, weighted: nav, moves, applied, calls, reversedDirs,
    outcome, reached: outcome === 'reached', error,
    steps: moves.length, maxSteps, reversals: reversedDirs.length,
    totalMs: calls.reduce((s, cl) => s + (Number(cl.res?._ms) || 0), 0),
    totalCostUsd: applied.reduce((s, a) => s + a._cost_usd, 0),
    totalQuestions: calls.reduce((s, cl) => s + (Number(cl.res?._questions) || 0), 0),
    lastMs: calls.length ? (Number(calls[calls.length - 1].res?._ms) || 0) : 0,
    lastQuestions: applied.length ? applied[applied.length - 1]._questions : 0,
  };
}

/**
 * Reassemble the standard `{ answers, usage, _ms, _cost_usd, _questions, mode }`
 * response shape from a policy run, so the skins, the referee, the meters and
 * the exporter keep their one-contract pipeline. Extras from the first step
 * are copied through; each applied step becomes a typed `move_<n>` answer.
 */
export function buildPolicyBody(game) {
  const answers = {};
  for (const a of game.applied) {
    answers[`move_${a.step}`] = {
      type: 'choice', choice: a.dir, confidence: a.confidence, probabilities: a.probabilities,
    };
  }
  const first = game.calls.find((cl) => cl.firstStep);
  if (first?.res?.answers) {
    for (const [id, val] of Object.entries(first.res.answers)) {
      if (!id.startsWith('move_') && !id.startsWith('step_') && !id.startsWith('cell_')) answers[id] = val;
    }
  }
  const input_tokens = game.calls.reduce((s, cl) => s + (cl.res?.usage?.input_tokens || 0), 0);
  return {
    model: game.calls[0]?.res?.model || 'policy',
    answers,
    usage: { input_tokens, output_tokens: 0 },
    _ms: game.totalMs,
    _last_ms: game.lastMs,
    _cost_usd: game.totalCostUsd,
    _questions: game.totalQuestions,
    _calls: game.calls.length,
    _reversals: game.reversals,
    _steps: game.steps,
    _maxSteps: game.maxSteps,
    _outcome: game.outcome,
  };
}