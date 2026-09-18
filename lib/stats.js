// lib/stats.js — the run-history statistics, pure and DOM-free so the suite
// can exercise them under Node with exact expected values.
//
// Rules the history page follows:
//   - null / missing values (an unreachable board's step accuracy, an
//     absent meter) are excluded from every statistic — never counted as 0.
//   - variance is the SAMPLE variance (n − 1 denominator). For n < 2 it is
//     null: a single run is no evidence of consistency, and reporting 0
//     would be a false claim.

/** Coerce to a list of finite numbers, dropping null/undefined/NaN/Infinity. */
export function toNumbers(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

export function mean(values) {
  const xs = toNumbers(values);
  if (!xs.length) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

export function median(values) {
  const xs = toNumbers(values).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Sample variance (n − 1 denominator); null when there are fewer than 2 runs. */
export function sampleVariance(values) {
  const xs = toNumbers(values);
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1);
}

/** Sample standard deviation; null when variance is null (n < 2). */
export function stddev(values) {
  const v = sampleVariance(values);
  return v === null ? null : Math.sqrt(v);
}

export function minValue(values) {
  const xs = toNumbers(values);
  return xs.length ? Math.min(...xs) : null;
}

export function maxValue(values) {
  const xs = toNumbers(values);
  return xs.length ? Math.max(...xs) : null;
}

/** One row of the stat cards: n · mean · median · variance · stddev · min · max. */
export function summarize(values) {
  const xs = toNumbers(values);
  return {
    n: xs.length,
    mean: mean(xs),
    median: median(xs),
    variance: sampleVariance(xs),
    stddev: stddev(xs),
    min: minValue(xs),
    max: maxValue(xs),
  };
}