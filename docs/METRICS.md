# Metrics — the exact definitions

Every number the app shows is defined here, so a reading can be argued about rather than
guessed at. All timings are wall-clock, measured on the **decision**, never on the
animation: an animation that runs long must not inflate a Jev timing.

## Per run (the play page)

| Meter | Definition |
|---|---|
| **decision time · last step** | `_last_ms` — the wall time of the most recent `/api/jev` round trip. |
| **total time** | Σ `_ms` over every call in the run. |
| **calls made** | the number of `/api/jev` round trips. **One call usually carries the whole route** — the loop only asks again when the chain broke. |
| **total cost** | Σ `_cost_usd`, 6 dp. |
| **questions per call** | `_questions` — the size of the fan-out. The loop asks for `move_1 … move_64` at once, so this is ~64, not 1. |
| **steps vs shortest** | `steps / optimal`, where `optimal` is `shortest()`'s length. `unreachable` when there is none. |
| **step accuracy** | **the fraction of steps that reduce the BFS distance to the centre by exactly 1.** A step is correct when `dist(before) === dist(after) + 1`. `null` when no steps were taken. |
| **chain agreement** | `chainApplied / chainAnswered` — of every move Jev returned inside a chain, how many survived the check against the doors. **1.00 means the whole route came back consistent in one pass.** Below 1.00 measures how often parallel answers disagree with each other. |
| **elapsed** | wall-clock time for the whole run, measured in the shell around the loop. |

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

## Scores

- **step accuracy** = the fraction of steps on a shortest route. **1.0 is perfect.**
  Computed post-run by the shell: `correctSteps / steps`.
- `correctSteps` = the numerator of step accuracy (auditable).

## Costs

```js
_cost_usd = ((input_tokens + output_tokens) / 1e6) * 0.042
```

A single **blended** rate of **$0.042 per 1M tokens**, documented here rather than
pretending to know the upstream's split pricing. Both token counts are summed from every
call in the run — `output_tokens` is not assumed to be zero.

## The path: green and red

Every step is graded, and the grading — not the outcome — is what reports the
model:

| colour | Meaning |
|---|---|
| **green** | Jev's own move, played exactly as it gave it. |
| **red** | Jev's move was **not** played. The walk took the correct move from its own calculation instead, and went on. |

A red step records *why*: `unsure` (confidence below 0.5 — per the TypeSafe spec
a low read means no clear winner, so it is not acted on), `unplayable` (the answer
is not a door here, or it doubles back onto a cell already walked), `unreadable`
(no usable answer for that cell), or `detour` (even the correct move's cell was
already walked). It also records whether Jev's own answer would have been right
anyway — an unsure guess that was correct is a different fact from a confident
answer that was not.

**`jevAccuracy`** is the headline measure: of the moves Jev *proposed*, how many
shortened the distance to the centre. Since a red step always plays the correct
move, `stepAccuracy` (the walk's own record) sits at 1.0 unless a **green** step
went astray — the interesting case, where the model was confident and wrong.

## Outcomes

Because the walk can always overrule a bad answer, an unreadable or unplayable
answer is now a red **step**, not an ending. Three ways remain:

| `outcome` | Meaning |
|---|---|
| `reached` | Abhimanyu arrived at the centre. |
| `stuck` | every legal neighbour has already been visited — the walk has nowhere to go. |
| `exhausted` | the step budget `2 · R · S` ran out. A defensive guard: the no-revisit rule means it should never fire. |
| `error` | the transport failed (e.g. `no_key`). The typed code is preserved. |

## Statistics (the history page)

Grouped by **`difficulty`** — different kinds of run are never averaged together.

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
`ms / step`, `questions / step`, `cost / step`, and `stepAccuracy`. Each shows `(n = k)`, or
`(n<2)` when there is no spread to report.

## Units and rounding

- Times: integer **milliseconds**.
- Costs: **USD**, 6 decimal places (a single run costs fractions of a cent).
- Scores: 3 decimal places.
- Token counts: integers, summed.
