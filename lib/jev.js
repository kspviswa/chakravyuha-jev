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
// The walk then follows the returned policy from the start cell, and every step
// is graded green or red:
//
//   GREEN — Jev's own move, played exactly as given.
//   RED   — Jev's move was not used. Confidence was low (per the TypeSafe spec
//           a low read means no clear winner, so we do not act on it), or the
//           answer could not be played at all. The walk takes the correct move
//           from its own calculation instead and carries on.
//
// So the walk always reaches the centre, and the OUTCOME stops being the
// measurement. The colour of the path is: a run that is all green is a model
// that never once needed overruling, and a red step is a step the model did not
// earn. Each red step records WHY it was red, and whether Jev's own answer
// happened to be right anyway — an unsure answer that was nonetheless correct is
// a different fact from a confident answer that was not.
//
// This is a deliberate change: the game loop now knows the route, because it
// must be able to overrule the model. That is what makes the green/red split
// mean something — a green step is the model's move, played without help.

import { neighbours, MOVES } from './chakra.js';
import { chakraPolicyState, chakraPolicyQuestions, policyCells, policyQuestionId } from './chakra.js';
import { referenceMove, nearestToGoal, distanceToGoal } from './chakra.js';
import { confidenceBand, bandCounts } from './confidence.js';

// The maze owns the questions (their wording is the maze's semantics); this
// module owns the payload and the walk. Re-exported so callers have one import.
export { chakraPolicyQuestions, policyCells, policyQuestionId };

const keyOf = (ring, sector) => `${ring},${sector}`;

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
  onStep = null, mode = 'policy',
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
  let outcome = null;
  let error = null;
  let reject = null;
  let rejectDir = null;

  while (!outcome) {
    if (dst && ring === dst.ring && sector === dst.sector) { outcome = 'reached'; break; }
    if (moves.length >= maxSteps) { outcome = 'exhausted'; break; }

    const cands0 = legalCandidates(board, ring, sector);
    if (cands0.length === 0) { outcome = 'stuck'; reject = 'nowhere'; break; }
    if (cands0.every((c) => visitedSet.has(keyOf(c.ring, c.sector)))) {
      outcome = 'stuck'; reject = 'boxed_in'; break;
    }

    const questions = stepMode
      ? chakraPolicyQuestions(board, { cells: [{ ring, sector }] })
      : chakraPolicyQuestions(board);
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
      const band = ans ? confidenceBand(ans.confidence) : 'unknown';
      const pickJev = ans ? fresh.find((c) => c.dir === ans.dir) : null;

      // ---- green or red? --------------------------------------------------
      // GREEN: Jev's own move, played as it gave it. RED: Jev's move was not
      // used. Three things put a step in red, and all three are recorded, so the
      // path never says "corrected" without saying why:
      //   unsure      — confidence was low. Per the TypeSafe spec a low read
      //                 means no clear winner, so we do not act on it.
      //   unplayable  — the answer is not a door here, or it doubles back onto a
      //                 cell already walked. There is nothing to play.
      //   unreadable  — no usable answer for this cell at all.
      let verdict = 'green', reason = null, pick = pickJev;
      if (!ans) { verdict = 'red'; reason = 'unreadable'; }
      else if (band === 'low') { verdict = 'red'; reason = 'unsure'; }
      else if (!pickJev) { verdict = 'red'; reason = 'unplayable'; }

      // A red step takes the correct move, per our own calculation, and the
      // walk goes on. The run therefore always reaches the centre, and the
      // colour of the path — not the outcome — is what reports the model.
      if (verdict === 'red') {
        const refDir = referenceMove(board, ring, sector);
        pick = refDir ? fresh.find((c) => c.dir === refDir) : null;
        if (!pick) {
          // Even the correct move lands on a cell already walked. Take the best
          // move left; the no-revisit rule outranks the direct route here.
          pick = nearestToGoal(board, fresh);
          reason = 'detour';
        }
      }
      // fresh is non-empty, so a move always exists: the walk cannot stall here.

      const d0 = distanceToGoal(board, ring, sector);
      const jevMove = ans ? cands.find((c) => c.dir === ans.dir) : null;

      moves.push(pick.dir);
      applied.push({
        step: moves.length,
        call: callIndex,
        cell: keyOf(ring, sector),
        dir: pick.dir,
        // What Jev actually said, and whether we played it. `verdict` is the
        // path's colour; `reason` is why a red step is red.
        jevDir: ans ? ans.dir : null,
        verdict,
        reason,
        confidence: ans ? ans.confidence : null,
        // The band is captured HERE, at the moment of the decision, and travels
        // with the step. A run can then say how many of its moves were made in
        // confidence, and no later code has to re-derive it from the number.
        band,
        probabilities: ans ? { [ans.dir]: ans.p } : {},
        mismatch: ans ? confidenceMismatch(ans) : false,
        // Did the move played, and the move Jev wanted, actually head for the
        // centre? For a green step these agree. For a red one they usually do
        // not — and where a red step's `jevCorrect` is true, Jev's guess was
        // right even though we did not trust it.
        appliedCorrect: d0 !== null && distanceToGoal(board, pick.ring, pick.sector) === d0 - 1,
        // An answer that is not a door at all cannot be the correct move, so it
        // is FALSE, not null. null means only "Jev gave no answer for this cell".
        jevCorrect: !ans ? null
          : jevMove ? (d0 !== null && distanceToGoal(board, jevMove.ring, jevMove.sector) === d0 - 1)
            : false,
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
        const hook = onStep({
          from, to: { ring, sector }, dir: pick.dir, step: moves.length, verdict, reason,
        });
        if (hook && typeof hook.then === 'function') await hook;
      }
      // Step mode stops here and goes back to ask about the NEW cell. Everything
      // else — legality, the no-revisit rule, the outcome vocabulary — is
      // shared, so the two modes cannot drift apart.
      if (stepMode) break;
    }

    calls.push({
      state, questions, res: body,
      asked: Object.keys(questions).length,
      answered: policy.size,
      used: usedHere,
    });

    if (!refused) continue;   // reached the centre, or ran out of steps
    outcome = refused.why === 'boxed_in' ? 'stuck' : refused.why;
    reject = refused.why;
    rejectDir = refused.dir;
  }
  if (!outcome) outcome = (dst && ring === dst.ring && sector === dst.sector) ? 'reached' : 'exhausted';

  const chainAnswered = calls.reduce((s, cl) => s + cl.answered, 0);
  const chainApplied = calls.reduce((s, cl) => s + cl.used, 0);

  return {
    board, moves, applied, calls, mode: stepMode ? 'step' : 'policy',
    outcome, reached: outcome === 'reached', error,
    reject, rejectDir,
    steps: moves.length, maxSteps,
    // Parallel-policy calibration: of every answer Jev returned for a cell, how
    // many the walk actually consumed. Post-run step accuracy (the shell's job)
    // is the measure of whether those answers were the right ones.
    chainAnswered, chainApplied,
    chainAgreement: chainAnswered > 0 ? chainApplied / chainAnswered : null,
    // Confidence, as a signal in its own right: the bands of every step taken,
    // and how many of them were confident. `x` steps, `y` confident — the two
    // numbers the run is judged on, alongside whether it reached the centre.
    confidenceBands: applied.map((a) => a.band),
    bandCounts: bandCounts(applied.map((a) => a.band)),
    // The path's colour, step by step. `green` is the model's own move played
    // as given; `red` is a move we did not take, with the reason. This — not the
    // outcome — is what reports the model, because the walk always arrives.
    stepVerdicts: applied.map((a) => a.verdict),
    redSteps: applied.filter((a) => a.verdict === 'red').length,
    greenSteps: applied.filter((a) => a.verdict === 'green').length,
    // Of the moves JEV proposed, how many were actually right. The headline
    // measure of its judgment, independent of what we chose to play.
    jevProposed: applied.filter((a) => a.jevDir !== null).length,
    jevCorrectCount: applied.filter((a) => a.jevCorrect === true).length,
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
    _cellsAsked: game.cellsAsked,
    _chainAnswered: game.chainAnswered,
    _chainApplied: game.chainApplied,
    _chainAgreement: game.chainAgreement,
    _confidenceBands: game.confidenceBands,
    _bandCounts: game.bandCounts,
    _stepVerdicts: game.stepVerdicts,
    _redSteps: game.redSteps,
    _greenSteps: game.greenSteps,
    _jevProposed: game.jevProposed,
    _jevCorrect: game.jevCorrectCount,
  };
}
