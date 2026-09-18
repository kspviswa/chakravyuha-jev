// lib/confidence.js — TypeSafe confidence, banded.
//
// Every Choice and Score answer carries `confidence`: one 0..1 number computed
// from the SHAPE of the probability distribution, not from its winner. A
// concentrated distribution reads high, a flat one reads low — so a 0.7/0.3
// split is not "70% sure", it is a low-confidence answer with no clear winner.
// That distinction is the whole point: it is the model's honest uncertainty
// signal, and it is a first-class output, not a byproduct.
//
//   https://docs.typesafe.ai/confidence
//
// The documented pattern is three ranges with three behaviours:
//   high   — act automatically
//   medium — proceed with caution
//   low    — do not act; escalate or gather more
//
// The walk here APPLIES the move whatever the band. A gate that refused to move
// would turn "Jev decided badly" into "the maze boxed us in", which is exactly
// the misattribution the measurement exists to avoid. Instead every step is
// banded and recorded, so a run can report how many of its steps were taken in
// confidence and a guess can never be read as a considered move.
//
// The docs give one boundary — 0.5, the floor that "catches anything the model
// reports as genuinely uncertain". The upper boundary is ours to choose; 0.8 is
// where a two-option answer has a clear winner over its rival. Both live here,
// alone, so they can be tuned in one place and no other file hardcodes a number.

export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_MEDIUM = 0.5;

/** The three bands, most certain first. */
export const BANDS = ['high', 'medium', 'low'];

/**
 * Band a confidence value. A missing or non-numeric confidence is 'unknown' —
 * never silently 'low', because "the model said it was unsure" and "the model
 * said nothing" are different facts and must not be conflated.
 */
export function confidenceBand(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  if (value >= CONFIDENCE_HIGH) return 'high';
  if (value >= CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}

/** Count the bands across a run's steps. */
export function bandCounts(bands) {
  const out = { high: 0, medium: 0, low: 0, unknown: 0, total: bands.length };
  for (const b of bands) out[b in out ? b : 'unknown']++;
  return out;
}
