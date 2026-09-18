// lib/jev.js — builds the { state, questions } payloads for the chakravyuha
// and drives the policy loop.
//
// PARALLEL PATH MODE: Jev answers every question in one forward pass against a
// shared state, and adding questions barely moves the latency. So instead of
// asking one move per round trip (one call per step, each dependent on the
// last), the loop asks for the WHOLE route at once — move_1 … move_K — and
// applies the chain. A 17-move run costs ONE call instead of seventeen.
//
// The answers are independent, so the chain is not guaranteed consistent: it is
// checked against the real doors and cut at the first move that is illegal,
// blocked or already visited. What survived the check is applied, and
// if the centre is still not reached the loop asks again from where it stopped.
// How much of each chain survived is recorded — that ratio is the calibration
// signal, and it is the whole point of the experiment.
//
// The game loop never knows the route. distance computation is only reachable
// from the shell, after a run ends.

import { neighbours, MOVES } from './chakra.js';
import { chakraState, MOVE_CRITERIA } from './chakra.js';

const keyOf = (ring, sector) => `${ring},${sector}`;

/** How many moves to ask for in one call. Keeps the payload well inside Jev's
 *  ~150k-char envelope while covering a whole route in a single pass. */
export const PATH_ASK_MOVES = 64;

/** Step toward the centre: the candidates Jev picks between. */
export function legalCandidates(board, ring, sector) {
  return neighbours(board, ring, sector);
}

/** Build the state for a call. Path mode passes askMoves; the retired per-step
 *  loop passed step/maxSteps. No reversal parameter either way. */
export function buildPolicyChakraState(board, { ring, sector, visited, step, maxSteps, askMoves = 0 }) {
  return chakraState(board, { ring, sector, visited, step, maxSteps, askMoves });
}

/**
 * THE WHOLE ROUTE, ONE PASS: move_1 … move_K, each a choice over the four
 * moves. Every question is answered against the same state, so the k-th move
 * of the quickest route is independently computable — no round trips.
 *
 * The criteria are generic (what each direction means) because move_k is taken
 * at a cell the question does not name.
 *
 * Never uses 'a good next step', 'toward the centre', or 'should not wander'.
 */
export function chakraPathQuestions(board, { ring, sector, askMoves }) {
  const criteria = { ...MOVE_CRITERIA };
  const questions = {};
  const total = Math.max(1, Math.min(Number(askMoves) || PATH_ASK_MOVES, PATH_ASK_MOVES));
  for (let k = 1; k <= total; k++) {
    questions[`move_${k}`] = {
      type: 'choice',
      instructions:
        `Abhimanyu is on ring ${ring}, sector ${sector}. The centre is ring 0, sector 0. ` +
        `What is move ${k} of the quickest route from Abhimanyu to the centre?`,
      criteria,
    };
  }
  return questions;
}

/** One fan-out call, whatever the transport (proxy or direct). */
export async function askJev(transport, { state, questions, model = 'jev-latest', key = '' }) {
  return transport.ask({ state, questions, model, key });
}

/** The probability Jev assigned to one answer. */
export function choiceProbability(ans) {
  if (!ans) return 0;
  if (typeof ans.noul === 'number') return Math.max(0, Math.min(1, ans.noul));
  if (ans.type === 'choice') {
    if (typeof ans.probabilities?.[ans.choice] === 'number') return Math.max(0, Math.min(1, ans.probabilities[ans.choice]));
    if (typeof ans.confidence === 'number') return Math.max(0, Math.min(1, ans.confidence));
  }
  return 0;
}

/**
 * Read move_1 … move_K out of one response. The chain is contiguous: a missing
 * or unreadable move ends it, because every later answer is positioned relative
 * to the moves before it.
 */
export function readChain(answers, askMoves) {
  const out = [];
  for (let k = 1; k <= askMoves; k++) {
    const a = answers?.[`move_${k}`];
    if (!a || typeof a.choice !== 'string' || !MOVES.includes(a.choice)) break;
    out.push({ k, dir: a.choice, p: choiceProbability(a) });
  }
  return out;
}

/**
 * ASK FOR THE WHOLE PATH → CHECK IT → ask again if it broke.
 *
 * One call per attempt. The chain is applied only as far as it stays legal and
 * fresh; then, if the centre is not reached, the loop asks again from the cell
 * where it stopped. maxSteps = 2·R·S stays as a defensive guard only.
 */
export async function runPolicyGame({
  board, transport, model = 'jev-latest', key = '',
  onStep = null, askMoves = PATH_ASK_MOVES,
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

  const K = Math.max(1, Math.min(Number(askMoves) || PATH_ASK_MOVES, PATH_ASK_MOVES, maxSteps));

  while (!outcome) {
    if (dst && ring === dst.ring && sector === dst.sector) { outcome = 'reached'; break; }
    if (moves.length >= maxSteps) { outcome = 'exhausted'; break; }
    const fresh = legalCandidates(board, ring, sector)
      .filter((c) => !visitedSet.has(keyOf(c.ring, c.sector)));
    if (fresh.length === 0) { outcome = 'stuck'; break; }

    const state = buildPolicyChakraState(board, { ring, sector, visited, askMoves: K });
    const questions = chakraPathQuestions(board, { ring, sector, askMoves: K });
    const res = await askJev(transport, { state, questions, model, key });
    if (!res.ok) { outcome = 'error'; error = res.error || { code: 'error', message: 'policy call failed' }; break; }
    const body = res.body || {};
    const chain = readChain(body.answers, K);
    const callIndex = calls.length;

    // Check the chain: apply every move that is legal AND lands on a fresh
    // cell; stop at the first that is not. This is the only validation, and it
    // uses the doors alone — no route is ever computed here.
    let appliedHere = 0;
    for (const item of chain) {
      if (moves.length >= maxSteps) break;
      if (dst && ring === dst.ring && sector === dst.sector) break;
      const freshNow = legalCandidates(board, ring, sector)
        .filter((c) => !visitedSet.has(keyOf(c.ring, c.sector)));
      if (freshNow.length === 0) break;
      const pick = freshNow.find((c) => c.dir === item.dir);
      if (!pick) break;

      moves.push(pick.dir);
      const first = appliedHere === 0;
      applied.push({
        step: moves.length,
        call: callIndex,
        dir: pick.dir,
        confidence: item.p,
        probabilities: { [pick.dir]: item.p },
        _ms: first ? (Number(body._ms) || 0) : 0,
        _cost_usd: first ? (Number(body._cost_usd) || 0) : 0,
        _questions: first ? (Number(body._questions) || 0) : 0,
      });
      appliedHere++;

      const from = { ring, sector };
      ring = pick.ring; sector = pick.sector;
      visited.push({ ring, sector });
      visitedSet.add(keyOf(ring, sector));
      if (onStep) {
        const hook = onStep({ from, to: { ring, sector }, dir: pick.dir, step: moves.length });
        if (hook && typeof hook.then === 'function') await hook;
      }
    }

    calls.push({
      state, questions, res: body,
      answered: chain.length,
      applied: appliedHere,
      asked: K,
    });

    // Nothing in the chain could be applied: the very first move was
    // unreadable, illegal or already visited. That is unparsed, never stuck.
    if (appliedHere === 0) { outcome = 'unparsed'; break; }
  }
  if (!outcome) outcome = (dst && ring === dst.ring && sector === dst.sector) ? 'reached' : 'exhausted';

  const chainAnswered = calls.reduce((s, cl) => s + cl.answered, 0);
  const chainApplied = calls.reduce((s, cl) => s + cl.applied, 0);

  return {
    board, moves, applied, calls,
    outcome, reached: outcome === 'reached', error,
    steps: moves.length, maxSteps,
    // Parallel-path calibration: of every move Jev returned in a chain, how
    // many survived the check against the real doors.
    chainAnswered, chainApplied,
    chainAgreement: chainAnswered > 0 ? chainApplied / chainAnswered : null,
    totalMs: calls.reduce((s, cl) => s + (Number(cl.res?._ms) || 0), 0),
    totalCostUsd: applied.reduce((s, a) => s + a._cost_usd, 0),
    totalQuestions: calls.reduce((s, cl) => s + (Number(cl.res?._questions) || 0), 0),
    totalTokensIn: calls.reduce((s, cl) => s + (Number(cl.res?.usage?.input_tokens) || 0), 0),
    totalTokensOut: calls.reduce((s, cl) => s + (Number(cl.res?.usage?.output_tokens) || 0), 0),
    lastMs: calls.length ? (Number(calls[calls.length - 1].res?._ms) || 0) : 0,
    lastQuestions: calls.length ? (Number(calls[calls.length - 1].res?._questions) || 0) : 0,
  };
}

/** Reassemble the standard { answers, usage, _* } response shape from a run. */
export function buildPolicyBody(game) {
  const answers = {};
  for (const a of game.applied) {
    answers[`move_${a.step}`] = {
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
    _chainAnswered: game.chainAnswered,
    _chainApplied: game.chainApplied,
    _chainAgreement: game.chainAgreement,
  };
}
