// lib/jev.js — builds the { state, questions } payloads for the chakravyuha
// and drives the per-step policy loop (ASK → APPLY → repeat).
// The game loop never knows the route. shortest() is only reachable
// from the shell, after a run ends.

import { neighbours, shortest } from './chakra.js';
import { chakraState } from './chakra.js';

const keyOf = (ring, sector) => `${ring},${sector}`;

/** Step toward the centre: the one-choice candidates Jev picks between. */
export function legalCandidates(board, ring, sector) {
  return neighbours(board, ring, sector);
}

/** Build the state for a step. No reversal parameter. */
export function buildPolicyChakraState(board, { ring, sector, visited, step, maxSteps }) {
  return chakraState(board, { ring, sector, visited, step, maxSteps });
}

/**
 * ONE question per step: next_move, a choice over the fresh legal moves.
 * Criteria list only the moves the walker may actually take.
 * Never uses 'a good next step', 'toward the centre', or 'should not wander'.
 */
export function chakraQuestions(board, candidates, opts = {}) {
  const { ring, sector, visited = [] } = opts;
  const visitedSet = new Set(visited.map((v) => keyOf(v.ring, v.sector)));
  const fresh = candidates.filter((c) => !visitedSet.has(keyOf(c.ring, c.sector)));

  const criteria = {};
  const parts = [];
  for (const c of fresh) {
    let detail = '';
    if (c.dir === 'inward') detail = `ring ${ring} → ring ${c.ring}, same sector`;
    else if (c.dir === 'outward') detail = `ring ${ring} → ring ${c.ring}, same sector`;
    else if (c.dir === 'clockwise') detail = `sector ${sector} → sector ${c.sector}, same ring`;
    else if (c.dir === 'counterclockwise') detail = `sector ${sector} → sector ${c.sector}, same ring`;
    else detail = `${c.dir} to ring ${c.ring}, sector ${c.sector}`;
    criteria[c.dir] = detail;
    parts.push(`${c.dir} → ring ${c.ring}, sector ${c.sector}`);
  }

  const instructions =
    `Abhimanyu is on ring ${ring}, sector ${sector}. The centre is ring 0, sector 0. ` +
    `The doors that are open from here and have not been visited yet lead to: ` +
    `${parts.join('; ')}. ` +
    `Which move is the FIRST move of a shortest route from Abhimanyu to the centre?`;

  return {
    next_move: {
      type: 'choice',
      instructions,
      criteria,
    },
  };
}

/** One fan-out call, whatever the transport (proxy or direct). */
export async function askJev(transport, { state, questions, model = 'jev-latest', key = '' }) {
  return transport.ask({ state, questions, model, key });
}

/** The probability Jev assigned to one move_* answer. */
export function choiceProbability(ans) {
  if (!ans) return 0;
  if (typeof ans.noul === 'number') return Math.max(0, Math.min(1, ans.noul));
  if (ans.type === 'choice') {
    if (typeof ans.probabilities?.[ans.choice] === 'number') return Math.max(0, Math.min(1, ans.probabilities[ans.choice]));
    if (typeof ans.confidence === 'number') return Math.max(0, Math.min(1, ans.confidence));
  }
  return 0;
}

/** The candidate Jev judged most promising, or null when nothing answered. */
export function stepArgmax(candidates, answers) {
  const ans = answers?.next_move;
  if (!ans || !ans.choice) return null;
  const choice = ans.choice;
  let best = null;
  for (const cand of candidates) {
    if (cand.dir !== choice) continue;
    const p = choiceProbability(ans);
    if (best === null || p > best.p) best = { ...cand, p };
  }
  return best;
}

/**
 * ASK → APPLY → repeat. One question per step, no fan-out, no second ask.
 * maxSteps = 2·R·S stays as a defensive guard only; with fresh-only options
 * it is unreachable, and a test asserts so.
 */
export async function runPolicyGame({
  board, transport, model = 'jev-latest', key = '',
  onStep = null,
}) {
  const R = board.R, S = board.S;
  const maxSteps = 2 * R * S;
  const dst = board.dst;
  const visited = [{ ring: board.src.ring, sector: board.src.sector }];
  const visitedSet = new Set([keyOf(board.src.ring, board.src.sector)]);
  let ring = board.src.ring, sector = board.src.sector;

  const moves = [];
  const applied = [];
  const calls = [];
  let outcome = null;
  let error = null;

  for (let step = 1; step <= maxSteps && !outcome; step++) {
    if (dst && ring === dst.ring && sector === dst.sector) { outcome = 'reached'; break; }
    const candidates = legalCandidates(board, ring, sector);
    const fresh = candidates.filter((cd) => !visitedSet.has(keyOf(cd.ring, cd.sector)));
    if (fresh.length === 0) { outcome = 'stuck'; break; }

    const state = buildPolicyChakraState(board, { ring, sector, visited, step, maxSteps });
    const questions = chakraQuestions(board, fresh, { ring, sector, visited });
    const res = await askJev(transport, { state, questions, model, key });
    if (!res.ok) { outcome = 'error'; error = res.error || { code: 'error', message: 'policy call failed' }; break; }
    const body = res.body || {};
    calls.push({ step, state, questions, res: body });

    const picked = stepArgmax(fresh, body.answers);
    if (!picked) { outcome = 'unparsed'; break; }

    moves.push(picked.dir);
    const probabilities = {};
    for (const c of fresh) probabilities[c.dir] = choiceProbability(body.answers?.next_move?.probabilities?.[c.dir]);
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
  if (!outcome) outcome = (dst && ring === dst.ring && sector === dst.sector) ? 'reached' : 'exhausted';

  return {
    board, moves, applied, calls,
    outcome, reached: outcome === 'reached', error,
    steps: moves.length, maxSteps,
    totalMs: calls.reduce((s, cl) => s + (Number(cl.res?._ms) || 0), 0),
    totalCostUsd: applied.reduce((s, a) => s + a._cost_usd, 0),
    totalQuestions: calls.reduce((s, cl) => s + (Number(cl.res?._questions) || 0), 0),
    totalTokensIn: calls.reduce((s, cl) => s + (Number(cl.res?.usage?.input_tokens) || 0), 0),
    totalTokensOut: calls.reduce((s, cl) => s + (Number(cl.res?.usage?.output_tokens) || 0), 0),
    lastMs: calls.length ? (Number(calls[calls.length - 1].res?._ms) || 0) : 0,
    lastQuestions: applied.length ? applied[applied.length - 1]._questions : 0,
  };
}

/** Compute stepAccuracy: fraction of steps that reduce BFS distance by exactly 1. */
export function computeStepAccuracy(board, moves, src) {
  if (moves.length === 0) return null;
  let dist = shortestDist(board, src, board.dst);
  if (dist === null) return null;
  let correct = 0;
  let cur = { ...src };
  for (const dir of moves) {
    const cands = neighbours(board, cur.ring, cur.sector);
    const next = cands.find((c) => c.dir === dir);
    if (!next) break;
    const newDist = shortestDist(board, next, board.dst);
    if (newDist !== null && dist === newDist + 1) correct++;
    dist = newDist;
    cur = { ring: next.ring, sector: next.sector };
  }
  return correct / moves.length;
}

/** Reassemble the standard { answers, usage, _* } response shape from a policy run. */
export function buildPolicyBody(game) {
  const answers = {};
  for (const a of game.applied) {
    answers[`step_${a.step}`] = {
      type: 'choice', choice: a.dir, confidence: a.confidence, probabilities: a.probabilities,
    };
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
    _steps: game.steps,
    _maxSteps: game.maxSteps,
    _outcome: game.outcome,
  };
}

/** BFS distance helper (internal). */
function shortestDist(board, from, to) {
  const s = shortest(board, from, to);
  return s ? s.length : null;
}
