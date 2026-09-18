// lib/jev.js — builds the { state, questions } payloads for the chakravyuha
// and drives the policy walk.
//
// PARALLEL POLICY MODE. Jev answers every question in one forward pass against a
// shared state, and adding questions barely moves the latency. The trick is to
// ask the questions that parallel answering can actually support.
//
// A route cannot be asked for in parallel questions. Move 5 is taken from
// wherever move 4 landed, so move_5 depends on move_4 — but parallel questions
// are independent by construction, and the model is given no way to chain them.
// Asking "what is move k of the route?" 64 times yields 64 copies of the same
// first move, which is exactly what happened in the field: 64 questions, 64
// answers, all 'inward', probabilities near-uniform and confidence below the
// probability the model gave its own choice.
//
// A POLICY can be asked for in parallel questions, because a policy is a
// function of the cell alone. So: one question per cell — "standing at ring R,
// sector S, which move begins the optimal route to the centre?" — with that
// cell's own doors listed as the options. Every question is self-contained, so
// answering them independently is correct rather than contradictory; and every
// option offered is a door that really opens, so any answer is playable.
//
// The walk then follows the returned policy from the start cell. A correct
// policy is a strict descent on the distance to the centre, so it never revisits
// a cell. If the model errs and the walk doubles back, the offending move is
// struck from that cell's question and the policy is re-asked — a bounded
// repair, using only the doors and the walk's own history.
//
// The game loop never knows the route. Distance computation is only reachable
// from the shell, after a run ends.

import { neighbours, MOVES } from './chakra.js';
import { chakraPolicyState, chakraPolicyQuestions, policyCells, policyQuestionId } from './chakra.js';

// The maze owns the questions (their wording is the maze's semantics); this
// module owns the payload and the walk. Re-exported so callers have one import.
export { chakraPolicyQuestions, policyCells, policyQuestionId };

const keyOf = (ring, sector) => `${ring},${sector}`;

/** How many repair calls the walk may make after doubling back. */
export const POLICY_REPAIRS = 4;

/** Step toward the centre: the candidates Jev picks between. */
export function legalCandidates(board, ring, sector) {
  return neighbours(board, ring, sector);
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
 * Read the returned policy into a Map of cell → { dir, p, confidence }. An
 * unreadable or unrecognised answer is simply absent, and the walk reports it.
 */
export function readPolicy(answers, board) {
  const out = new Map();
  for (const { ring, sector } of policyCells(board)) {
    const a = answers?.[policyQuestionId(ring, sector)];
    if (!a || typeof a.choice !== 'string' || !MOVES.includes(a.choice)) continue;
    out.set(keyOf(ring, sector), {
      dir: a.choice,
      p: choiceProbability(a),
      confidence: typeof a.confidence === 'number' ? a.confidence : null,
    });
  }
  return out;
}

/** True when Jev's confidence and the probability it gave its own choice disagree
 *  — the signature of a model that is guessing rather than deciding. */
export function confidenceMismatch(ans) {
  if (!ans || ans.confidence === null) return false;
  return ans.confidence < ans.p - 0.05;
}

/**
 * ASK FOR THE POLICY → FOLLOW IT → repair if the walk doubles back.
 *
 * One call returns a move for every cell, so the walk from the start cell costs
 * no further round trips. maxSteps = 2·R·S stays as a defensive guard only.
 */
export async function runPolicyGame({
  board, transport, model = 'jev-latest', key = '',
  onStep = null, maxRepairs = POLICY_REPAIRS, mode = 'policy',
}) {
  // Two ways to ask the SAME question. 'policy' sends every cell in one pass;
  // 'step' sends only the cell the walk is standing on, then re-asks from the
  // next one. The question text, the options and the state are identical — the
  // only variable is how many questions ride in a call, so any difference in
  // outcome is attributable to that alone.
  const stepMode = mode === 'step';
  const R = board.R, S = board.S;
  const maxSteps = 2 * R * S;
  const dst = board.dst;
  const src = board.src;

  const visited = [{ ring: src.ring, sector: src.sector }];
  const visitedSet = new Set([keyOf(src.ring, src.sector)]);
  let ring = src.ring, sector = src.sector;

  const moves = [];
  const applied = [];
  const calls = [];
  const banned = new Map();
  let outcome = null;
  let error = null;
  let reject = null;
  let rejectDir = null;
  let repairs = 0;

  const ban = (r, s, dir) => {
    const k = keyOf(r, s);
    if (!banned.has(k)) banned.set(k, new Set());
    banned.get(k).add(dir);
  };

  while (!outcome) {
    if (dst && ring === dst.ring && sector === dst.sector) { outcome = 'reached'; break; }
    if (moves.length >= maxSteps) { outcome = 'exhausted'; break; }

    const cands0 = legalCandidates(board, ring, sector);
    if (cands0.length === 0) { outcome = 'stuck'; reject = 'nowhere'; break; }
    if (cands0.every((c) => visitedSet.has(keyOf(c.ring, c.sector)))) {
      outcome = 'stuck'; reject = 'boxed_in'; break;
    }

    const questions = stepMode
      ? chakraPolicyQuestions(board, { banned, cells: [{ ring, sector }] })
      : chakraPolicyQuestions(board, { banned });
    if (stepMode && Object.keys(questions).length === 0) {
      // The cell the walk stands on has no door left to offer. Nothing to ask.
      outcome = 'stuck'; reject = 'nowhere'; break;
    }
    const state = chakraPolicyState(board);
    const res = await askJev(transport, { state, questions, model, key });
    if (!res.ok) { outcome = 'error'; error = res.error || { code: 'error', message: 'policy call failed' }; break; }
    const body = res.body || {};
    const policy = readPolicy(body.answers, board);
    const callIndex = calls.length;

    // ---- follow the policy from here ----------------------------------------
    let usedHere = 0;
    let refused = null;
    while (true) {
      if (dst && ring === dst.ring && sector === dst.sector) break;
      if (moves.length >= maxSteps) break;

      const cands = legalCandidates(board, ring, sector);
      const fresh = cands.filter((c) => !visitedSet.has(keyOf(c.ring, c.sector)));
      if (fresh.length === 0) { refused = { why: 'boxed_in', dir: null }; break; }

      const ans = policy.get(keyOf(ring, sector));
      if (!ans) { refused = { why: 'unreadable', dir: null }; break; }

      const pick = fresh.find((c) => c.dir === ans.dir);
      if (!pick) {
        // A readable answer that cannot be played from here. Either the move is
        // not a door at this cell at all, or it is a door onto a cell already
        // walked — the walk doubled back.
        const isDoor = cands.some((c) => c.dir === ans.dir);
        refused = { why: isDoor ? 'revisited' : 'illegal', dir: ans.dir };
        break;
      }

      moves.push(pick.dir);
      applied.push({
        step: moves.length,
        call: callIndex,
        cell: keyOf(ring, sector),
        dir: pick.dir,
        confidence: ans.confidence,
        probabilities: { [pick.dir]: ans.p },
        mismatch: confidenceMismatch(ans),
        _ms: usedHere === 0 ? (Number(body._ms) || 0) : 0,
        _cost_usd: usedHere === 0 ? (Number(body._cost_usd) || 0) : 0,
        _questions: usedHere === 0 ? (Number(body._questions) || 0) : 0,
      });
      usedHere++;

      const from = { ring, sector };
      ring = pick.ring; sector = pick.sector;
      visited.push({ ring, sector });
      visitedSet.add(keyOf(ring, sector));
      if (onStep) {
        const hook = onStep({ from, to: { ring, sector }, dir: pick.dir, step: moves.length });
        if (hook && typeof hook.then === 'function') await hook;
      }
      // Step mode stops here and goes back to ask about the NEW cell. Everything
      // else — legality, the no-revisit rule, repairs, the outcome vocabulary —
      // is shared, so the two modes cannot drift apart.
      if (stepMode) break;
    }

    calls.push({
      state, questions, res: body,
      asked: Object.keys(questions).length,
      answered: policy.size,
      used: usedHere,
      repairs: repairs > 0 ? [...banned.entries()].map(([k, v]) => `${k}:${[...v].join('|')}`) : undefined,
    });

    if (!refused) continue;   // reached the centre, or ran out of steps

    // ---- the walk stopped: repair once, or report honestly ------------------
    const canRepair = (refused.why === 'revisited' || refused.why === 'illegal')
      && refused.dir && repairs < maxRepairs;
    if (canRepair) {
      ban(ring, sector, refused.dir);
      repairs++;
      continue;
    }
    outcome = refused.why === 'boxed_in' ? 'stuck'
      : refused.why === 'unreadable' ? 'unparsed'
        : refused.why;   // 'revisited' (doubled back) or 'illegal' (not a door)
    reject = refused.why;
    rejectDir = refused.dir;
  }
  if (!outcome) outcome = (dst && ring === dst.ring && sector === dst.sector) ? 'reached' : 'exhausted';

  const chainAnswered = calls.reduce((s, cl) => s + cl.answered, 0);
  const chainApplied = calls.reduce((s, cl) => s + cl.used, 0);

  return {
    board, moves, applied, calls, mode: stepMode ? 'step' : 'policy',
    outcome, reached: outcome === 'reached', error,
    reject, rejectDir, repairs,
    steps: moves.length, maxSteps,
    // Parallel-policy calibration: of every answer Jev returned for a cell, how
    // many the walk actually consumed. Post-run step accuracy (the shell's job)
    // is the measure of whether those answers were the right ones.
    chainAnswered, chainApplied,
    chainAgreement: chainAnswered > 0 ? chainApplied / chainAnswered : null,
    cellsAsked: calls.length ? calls[calls.length - 1].asked : 0,
    mismatchCount: applied.filter((a) => a.mismatch).length,
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
    _mode: game.mode,
    _steps: game.steps,
    _maxSteps: game.maxSteps,
    _outcome: game.outcome,
    _reject: game.reject,
    _rejectDir: game.rejectDir,
    _repairs: game.repairs,
    _cellsAsked: game.cellsAsked,
    _chainAnswered: game.chainAnswered,
    _chainApplied: game.chainApplied,
    _chainAgreement: game.chainAgreement,
  };
}
