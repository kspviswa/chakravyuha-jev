# Metrics — run history statistics, defined exactly

Every completed run (both skins, both game modes, stub/live/replay) is
recorded server-side into `runs.jsonl` (one JSON object per line, append-only,
capped at the most recent 500 runs, git-ignored). The history page groups runs
by **`(source, mode, skin)`** and computes the statistics below **per group** —
different kinds of run are never averaged together (stub runs are near-perfect
by construction, so mixing them with live runs would make every number a lie).

The client computes the verdict and the scores below from the referee's checks
and the game loop's own meters; the server only whitelists, validates and
stamps `id`/`at`. The scores are never re-derived server-side.

## The three scores

### Speed → `totalMs` and `msPerStep`

- `totalMs` — the whole-run wall time, in milliseconds.
- `msPerStep = totalMs / max(steps, 1)` — normalises time by run length so a
  20 step run and a 60 step run are comparable.

On the history page both are reported; the run table shows `totalMs`.

### Optimality → `optimalityScore`

```
            optimalSteps / steps      on the grid skin (unweighted)
score =     optimalCost / cost        on the navigation skin (weighted, least-cost)
```

- Clamped to **[0, 1]**; **1.0 is perfect** (Jev took the shortest/cheapest
  route the referee verified).
- A run that **did not reach** the goal scores **0** — arriving matters.
- A board with **no route at all** (`optimal === null`) scores **`null`**, and
  that run is **excluded from the mean** rather than counted as 0. "Unreachable
  and therefore not scored" is different from "reached the goal inefficiently".

### Accuracy → `accuracyScore`

```
accuracyScore = checksPassed / checksTotal
```

from the referee's four verification checks (stays in bounds, never enters a
blocking cell, reaches the destination, is minimal). `reached` is also kept as
its own boolean, because **"valid but never arrived"** and **"arrived"** are
different failures worth telling apart in the history.

## Statistics per metric

For `totalMs`, `msPerStep`, `optimalityScore` and `accuracyScore`, each group
shows: **n · mean · median · variance · stddev · min · max**.

- **Mean / median** only include values that are present and finite. A `null`
  score (an unreachable board) is excluded — never averaged in as 0.
- **Variance is the sample variance** (`n − 1` denominator). For `n < 2` both
  variance and stddev are `null` and the UI shows a **`—`** with the note
  *"variance needs at least two runs"*. A single run is **never** reported as
  variance 0 — that would be a false claim of consistency.
- Display rounding: times to integer ms, scores to 3 decimal places. The CSV
  export keeps full precision.