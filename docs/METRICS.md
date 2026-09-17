# Metrics — the exact definitions

Every number the app shows is defined here, so a reading can be argued about rather than
guessed at. All timings are wall-clock, measured on the **decision**, never on the
animation: an animation that runs long must not inflate a Jev timing.

## Per run (the play page)

| Meter | Definition |
|---|---|
| **decision time · last step** | `_last_ms` — the wall time of the most recent `/api/jev` round trip. |
| **total time** | Σ `_ms` over every call in the run. |
| **calls made** | the number of `/api/jev` round trips. In `policy` mode this is ≥ the number of steps, because a rejected revisit costs an extra call. |
| **total cost** | Σ `_cost_usd`, 6 dp. |
| **questions per call** | the number of questions in the most recent request. |
| **steps vs optimal** | `steps / optimal`, where `optimal` is the referee's BFS length. `unreachable` when the referee finds no route (never `0/0`). |

### Efficiency (per step)

Every figure divided by the steps **actually taken**. The step count is the honest
denominator: a run that gives up after three hops must not look cheap.

| Meter | Definition |
|---|---|
| **ms / step** | `totalMs / max(steps, 1)` |
| **questions / step** | `totalQuestions / max(steps, 1)` |
| **calls / step** | `calls / max(steps, 1)` |
| **tokens / step · in / out** | `tokensIn / steps` and `tokensOut / steps` |
| **cost / step** | `costUsd / steps` |

### Scores

- **optimality** = `optimalSteps / steps`, clamped to `[0, 1]`. **1.0 is perfect.**
  - A run that did not reach the centre scores **0** (it did not do the job).
  - A board with no route at all scores **`null`**, and is **excluded** from the mean
    rather than counted as 0 — otherwise an impossible maze would drag the average down.
- **accuracy** = `checksPassed / checksTotal` from the referee's verification checks.
  `reached` is tracked separately, because "valid but never arrived" and "arrived" are
  different failures and should not be conflated.

## Costs

```js
_cost_usd = ((input_tokens + output_tokens) / 1e6) * 0.042
```

A single **blended** rate of **$0.042 per 1M tokens**, documented here rather than
pretending to know the upstream's split pricing. Both token counts are summed from every
call in the run — `output_tokens` is not assumed to be zero.

## Honest stops

A run ends in exactly one of four ways, and the label is never flattering:

| `outcome` | Meaning |
|---|---|
| `reached` | Abhimanyu arrived at the centre. |
| `stuck` | every legal neighbour has already been visited — Jev has nowhere to go. |
| `exhausted` | the step budget `2 · R · S` ran out. Generous but finite. |
| `error` | the transport failed (e.g. `no_key`). The typed code is preserved. |

## Statistics (the history page)

Grouped by **`difficulty · mode`** — different kinds of run are never averaged together.

| Statistic | Definition |
|---|---|
| **mean** | arithmetic mean of the finite values. |
| **median** | middle value (mean of the two middles for even n). |
| **variance** | **sample** variance, `n − 1` denominator. |
| **stddev** | `√variance`, sample. |
| **min / max** | extremes of the finite values. |

Non-finite values (`null`, `NaN`, `undefined`) are **excluded**, not coerced to 0. When
`n < 2` the variance and stddev show **`—`**, never a false `0` — a single run has no
spread to report.

### The cumulative footer

Totals over the runs currently shown: runs recorded, how many reached the centre (and the
percentage), total steps, total questions, total calls, total tokens (in / out), **total $
spent**, and total time.

Then the three per-step rates as **mean ± sample stddev**, because a 40-step run and a
4-step run are not comparable on raw milliseconds but are on milliseconds per step:
`ms / step`, `questions / step`, `cost / step`, and `optimality`. Each shows `(n = k)`, or
`(n<2)` when there is no spread to report.

## Units and rounding

- Times: integer **milliseconds**.
- Costs: **USD**, 6 decimal places (a single run costs fractions of a cent).
- Scores: 3 decimal places.
- Token counts: integers, summed.