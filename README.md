# PathPuzzle — the game loop has no logic

A browser puzzle where **every move is a Jev decision**. There is no A\*, no BFS, no
heuristic in the game loop. The board is serialised, sent to Jev in **one request**, and
the direction list Jev returns is applied verbatim. The app then *checks* the answer.

```
   difficulty + 🎲 Randomize
            │
            ▼
   state = { grid, source, destination, rules }      ← the environment
            +
   questions = { reachable, path_length, maze_difficulty,
                 move_1 … move_K,      ← fan-out: one typed question per step
                 cell_r_c … }          ← optional: "is this cell on the path?"
            │
            ▼
   ONE POST to Jev  →  typed answers + probabilities, one round trip
            │
            ▼
   app walks S in the returned directions → draws the path
            │
            ▼
   referee.js checks: in bounds? walls? reaches D? minimal?
            │
            ▼
   meters:  decision time · $ cost · questions in one call · round trips = 1
```

## Run it

```bash
cd ~/ws/jev/pathpuzzle
npm start                      # STUB mode — no key needed, answers are local BFS
TYPESAFE_API_KEY=sk_... npm start   # LIVE mode — real Jev
open http://localhost:8787
```

The API key never reaches the browser: `server.mjs` is a thin proxy that attaches it,
rate-limits per IP, and returns the raw TypeSafe response plus `_ms`, `_cost_usd`,
`_questions`.

**STUB mode is labelled loudly in the UI.** It exists so the demo runs without a key —
those answers come from a local BFS, not from Jev.

## Why this shape

Jev's three primitives are `Choice`, `Score`, `Noul`, and its flagship pattern is
**speculative fan-out**: many questions, same state, evaluated in parallel, *"adding
questions barely changes the response time."* A path is naturally a fan-out — "what is
move number *k*?" is a well-defined property of the state, so all K questions ride in one
request. On Hard + heatmap that is **261 typed questions in a single round trip**.

The output is enumerable, so three things an LLM can't give you come for free:

1. **Reliable parsing** — no JSON repair, no regex. The type is the contract.
2. **A reward signal** — an enumerable action in an environment is a score. That is why
   path-mapping is an RL match.
3. **A threshold** — the probability on each move lets *code* decide act / flag / retry.

## The extrapolation

The moment the board becomes a weighted graph, the same loop is a different product —
nothing in the request shape changes, only the state:

| Domain | state | typed output |
|---|---|---|
| Maps / routing | road graph, live speeds, turn restrictions | `{next_edge: Choice[N], eta_band: Choice, reroute: Noul}` |
| Uber Eats dispatch | courier positions, prep times, SLA clocks | `{assign_courier: Choice[N], batch: Noul, priority: Score}` |
| Ride pickup | supply heatmap, surge, driver state | `{accept: Noul, pickup_zone: Choice[N], cancel_risk: Score}` |
| Congestion control | queue depths, link utilisation, policy | `{rate_change: Choice, drop: Noul, severity: Score}` |
| Warehouse AMRs | fleet positions, battery, order book | `{robot: Choice[N], task: Choice, priority: Score}` |

Same harness. Same one round trip. Same verifiable referee.

## Files

- `server.mjs` — static server + `/api/jev` proxy (+ stub mode, rate limit, cost meter)
- `public/app.js` — board generation, question fan-out, the call, the renderer
- `public/referee.js` — **verification only**; never used to choose a move
- `public/index.html`, `public/style.css` — UI

## Honest caveat

"Which move is move *k* of the shortest path?" is a *global* reasoning question, and the
TypeSafe docs steer away from those toward one-second snap judgments. That is exactly why
this is worth running: the referee tells you whether Jev's fan-out is consistent and
optimal, and the per-move probabilities tell you *where* it wasn't sure. If it wobbles,
that is a finding, not a bug.
