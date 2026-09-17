// lib/jev.js — builds the { state, questions } payloads for the chakravyuha
// and drives the per-step policy loop (ASK → APPLY → ASK). No route is ever
// computed here: the state is pure serialisation, and Jev's chosen direction
// is applied verbatim. The referee in lib/referee.js only *checks* afterwards.
//
// The one action-space enumeration below (chakraNeighbours) is not a search:
// it merely lists the legal one-step moves so each can get a typed question.

import { chakraNeighbours } from './referee.js';
import { chakraState, POLAR_RULES, POLAR_OBJECTIVE, MOVE_WORDS } from './chakra.js';

const ROUTE_BUCKETS = { '1-5': null, '6-10': null, '11-15': null, '16-20': null, '21-30': null, '31-50': null, '51+': null };

export const keyOf = (ring, sector) => `${ring},${sector}`;

/** Step toward the centre: the one-choice candidates Jev picks between. */
export function legalCandidates(board, ring, sector) {
  return chakraNeighbours(board, ring, sector);
}

// ---- policy state ------------------------------------------------------------------
export function buildPolicyChakraState(board, { ring, sector, visited, step, maxSteps, reversal = null }) {
  return chakraState(board, { ring, sector, visited, step, maxSteps, reversal });
}

const DIR_PHRASE = {
  inward: 'inward',
  outward: 'outward',
  clockwise: 'clockwise',
  counterclockwise: 'counterclockwise',
};

/**
 * One typed noul per legal candidate. On the first step the fan-out extras
 * (reachable, route_length, maze_difficulty, warriors_blocking) ride along.
 */
export function chakraQuestions(board, candidates, opts = {}) {
  const { ring, sector, firstStep = false, reversal = null } = opts;
  const q = {};
  if (firstStep) {
    q.reachable = {
      type: 'noul',
      instructions: 'Is the centre (ring 0) reachable from `abhimanyu` without crossing a wall or entering a warrior?',
      criteria: { true: 'a route to the centre exists', false: 'no route to the centre exists' },
    };
    q.route_length = {
      type: 'choice',
      instructions: 'Roughly how many moves is the shortest route from `abhimanyu` to the centre (ring 0)?',
      criteria: ROUTE_BUCKETS,
    };
    q.maze_difficulty = {
      type: 'score',
      instructions: 'How hard is this chakravyuha to thread through by eye?',
      criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
    };
    q.warriors_blocking = {
      type: 'noul',
      instructions: 'Does at least one warrior sit on every shortest route from `abhimanyu` to the centre?',
      criteria: { true: 'every shortest route passes a warrior', false: 'some shortest route avoids all warriors' },
    };
  }
  const warning = reversal ? ` Note: stepping ${reversal} was already tried and would loop back.` : '';
  for (const cand of candidates) {
    q[`move_${cand.dir}`] = {
      type: 'noul',
      instructions:
        `Abhimanyu is on ring ${ring}, sector ${sector}. Moving ${DIR_PHRASE[cand.dir]} to ring ${cand.ring}, sector ${cand.sector} — ` +
        `is this a good next step toward the centre (ring 0)? It must not cross a wall or enter a warrior, and it should not wander into a dead end or loop back.${warning}`,
    };
  }
  return q;
}

// ---- plan mode (global, kept for comparison) ---------------------------------------
export function chakraPlanState(board) {
  return {
    task: 'chakravyuha_plan',
    maze: { rings: board.R, sectors: board.S, centre_gate_sector: board.centreGate },
    open_radial: board.openRadial,
    open_circ: board.openCirc,
    warriors: board.warriors,
    abhimanyu: { ring: board.src.ring, sector: board.src.sector },
    goal: 'the centre (ring 0)',
    rules: POLAR_RULES + ' You are asked for the whole route up front, move by move.',
    objective: 'Give the ordered list of moves of the shortest route from `abhimanyu` to the centre, one `move_k` per step.',
  };
}

export function chakraPlanQuestions(board) {
  const K = Math.min(board.R * board.S, 64);
  const questions = {};
  for (let k = 1; k <= K; k++) {
    questions[`move_${k}`] = {
      type: 'choice',
      instructions:
        `Consider the shortest route from \`abhimanyu\` to the centre (ring 0) on the chakravyuha described in the state. ` +
        `Moves are polar: inward, outward, clockwise, counterclockwise (sectors wrap). ` +
        `What is the direction of move number ${k} along that shortest route? ` +
        `Answer "stop" if the route contains fewer than ${k} moves.`,
      criteria: MOVE_WORDS,
    };
  }
  return questions;
}

// ---- move extraction (shared by shell + referee panel) ----------------------------
export function answerMoves(answers) {
  return Object.keys(answers)
    .filter((k) => k.startsWith('move_'))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((k) => (answers[k]?.type === 'choice' ? answers[k].choice : undefined))
    .filter((m) => m !== undefined);
}

/** One fan-out call, whatever the transport (proxy or direct). */
export async function askJev(transport, { state, questions, model = 'jev-latest', key = '' }) {
  return transport.ask({ state, questions, model, key });
}

// ---- policy loop ---------------------------------------------------------
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

/** The candidate Jev judged most promising, or null when nothing answered. */
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

/**
 * ASK → APPLY → ASK with argmax over Jev's own nouls and an honest
 * stuck/exhausted stop (no backtracking search). `onStep` is called after
 * each applied hop with { from, to, dir, step } and may await — the shell uses
 * it to animate the sprite, so it is awaited so the run paces the animation.
 * The meters are measured on the *decisions* (_ms from each call), never on
 * the animation, so timings stay honest.
 *
 * maxSteps: 2 * R * S — generous but finite. One full sweep of the cells would
 * bound the distance a walk can cover; doubling it lets a confused policy
 * wander without looping forever, and it is the honest cap the UI reports.
 */
export async function runPolicyGame({
  board, transport, model = 'jev-latest', key = '',
  onStep = null,
}) {
  const R = board.R, S = board.S;
  const maxSteps = 2 * R * S; // generous but finite — see above
  const dst = board.dst;
  const visited = [{ ring: board.src.ring, sector: board.src.sector }];
  const visitedSet = new Set([keyOf(board.src.ring, board.src.sector)]);
  let ring = board.src.ring, sector = board.src.sector;

  const moves = [];
  const applied = [];
  const calls = [];
  const reversedDirs = [];
  let outcome = null;
  let error = null;

  for (let step = 1; step <= maxSteps && !outcome; step++) {
    if (dst && ring === dst.ring && sector === dst.sector) { outcome = 'reached'; break; }
    const candidates = legalCandidates(board, ring, sector);
    const fresh = candidates.filter((cd) => !visitedSet.has(keyOf(cd.ring, cd.sector)));
    if (fresh.length === 0) { outcome = 'stuck'; break; }

    let reversal = null;
    let appliedThisStep = false;
    for (let ask = 1; ask <= 2 && !appliedThisStep && !outcome; ask++) {
      const firstStep = step === 1 && ask === 1;
      const state = buildPolicyChakraState(board, { ring, sector, visited, step, maxSteps, reversal });
      const questions = chakraQuestions(board, candidates, { ring, sector, step, firstStep, reversal });
      const res = await askJev(transport, { state, questions, model, key });
      if (!res.ok) { outcome = 'error'; error = res.error || { code: 'error', message: 'policy call failed' }; break; }
      const body = res.body || {};
      calls.push({ step, ask, firstStep, state, questions, res: body });
      const picked = stepArgmax(candidates, body.answers);
      if (!picked) { outcome = 'stuck'; break; }
      if (ask === 1 && visitedSet.has(keyOf(picked.ring, picked.sector))) {
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
      const from = { ring, sector };
      ring = picked.ring; sector = picked.sector;
      visited.push({ ring, sector });
      visitedSet.add(keyOf(ring, sector));
      if (onStep) {
        const hook = onStep({ from, to: { ring, sector }, dir: picked.dir, step });
        if (hook && typeof hook.then === 'function') await hook;
      }
    }
  }
  if (!outcome) outcome = (dst && ring === dst.ring && sector === dst.sector) ? 'reached' : 'exhausted';

  return {
    board, moves, applied, calls, reversedDirs,
    outcome, reached: outcome === 'reached', error,
    steps: moves.length, maxSteps, reversals: reversedDirs.length,
    totalMs: calls.reduce((s, cl) => s + (Number(cl.res?._ms) || 0), 0),
    totalCostUsd: applied.reduce((s, a) => s + a._cost_usd, 0),
    totalQuestions: calls.reduce((s, cl) => s + (Number(cl.res?._questions) || 0), 0),
    totalTokensIn: calls.reduce((s, cl) => s + (Number(cl.res?.usage?.input_tokens) || 0), 0),
    totalTokensOut: calls.reduce((s, cl) => s + (Number(cl.res?.usage?.output_tokens) || 0), 0),
    lastMs: calls.length ? (Number(calls[calls.length - 1].res?._ms) || 0) : 0,
    lastQuestions: applied.length ? applied[applied.length - 1]._questions : 0,
  };
}

/**
 * Reassemble the standard `{ answers, usage, _* }` response shape from a policy
 * run. Tokens (in AND out) are summed honestly from every call's usage — the
 * hardcoded `output_tokens: 0` is gone.
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
  const tokensIn = game.calls.reduce((s, cl) => s + (cl.res?.usage?.input_tokens || 0), 0);
  const tokensOut = game.calls.reduce((s, cl) => s + (cl.res?.usage?.output_tokens || 0), 0);
  return {
    model: game.calls[0]?.res?.model || 'policy',
    answers,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
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