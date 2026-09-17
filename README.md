# PathPuzzle — the game loop has no logic

A browser puzzle where **every move is a Jev decision**. There is no A\*, no BFS, no
heuristic in the game loop — you can prove it: the invariant test scans the source.
The board is serialised, sent to Jev in **one request**, and the direction list Jev
returns is applied verbatim. The app then *checks* the answer with a referee.

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

## Quickstart

```bash
cd ~/ws/jev/pathpuzzle
npm start                      # STUB mode — no key needed, runs out of the box
open http://localhost:8787
```

Zero configuration. `npm start` with no environment variables boots STUB mode: the
server answers from a local offline solver (the **only** pathfinding code outside
`public/referee.js`, confined to one function — see the invariant test). Those
answers are visibly labelled STUB; they are **not** Jev.

## The three modes

Every answer a client receives carries a `mode` field, and the UI badge shows one of
three distinct states:

| Mode | When | Answer source |
|---|---|---|
| `LIVE` | `TYPESAFE_API_KEY` is set, no replay | real Jev, one request to TypeSafe |
| `REPLAY` | `TYPESAFE_REPLAY` is set | a recorded fixture, verbatim (deterministic, no key, no network) |
| `STUB` | neither is set (default) | the local offline solver, clearly labelled |

Replay is a strict priority: **REPLAY > LIVE > STUB**.

### Adding the key (LIVE)

```bash
TYPESAFE_API_KEY=sk_... npm start     # model defaults to jev-latest
TYPESAFE_MODEL=jev-latest npm start   # optional override
open http://localhost:8787
```

The key never reaches the browser: `server.mjs` is a thin proxy that attaches it,
rate-limits per IP, and returns the TypeSafe response plus the meters. The key is
never logged and never returned to the client (a test asserts this). After a live
run the raw response is automatically written to `fixtures/recorded/<hash>.live.json`
(git-ignored) so the owner's first real run is captured for later replay.

### Stable demos (REPLAY)

Two committed fixtures ship in `fixtures/` — an easy 8×8 board and a hard 16×16 board,
recorded verbatim from the offline solver:

```bash
TYPESAFE_REPLAY=1 npm start       # deterministic, but only answers requests
                                  # whose request-hash matches a recording
TYPESAFE_REPLAY=easy npm start    # always serves the easy recording, whatever
TYPESAFE_REPLAY=hard npm start    # always serves the hard recording
```

The fixture for any request is looked up by `sha256(state + questions)`, so a browser
run only ever matches by accident. Use the named form (`easy`/`hard`) for a guaranteed
deterministic demo you can drive from the UI, and `=1` when you want to replay an exact
recorded run. Recordings can be regenerated or re-recorded for any board; the commit-time
ones are regenerated with `npm run fixtures`.

## Run tests

```bash
npm test
```

Zero-dependency `node --test` suite (36 tests): server smoke on an ephemeral port,
static-asset sanity, ES-module syntax parsing, the stub round-trip contract, referee
unit tests, replay from fixtures, the live branch against a **mock upstream**, and the
invariant test that pins the game loop to be pathfinding-free.

## The request/response contract

Exact shapes live in [`docs/API.md`](docs/API.md). In short:

- `POST /api/jev` with `{ state, questions }`.
- Returns `{ answers, usage, _ms, _cost_usd, _questions, mode }` — never a raw upstream
  blob on failure; errors are `{ error: { code, message } }`.

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

- `server.mjs` — static server + `/api/jev` proxy. The three modes, rate limit, cost
  meter, request caps, structured errors, live-run recording. The stub BFS lives here,
  confined to `stubAnswer()` and never called when a key is set.
- `public/app.js` — **game loop**. Builds `state`, the typed question fan-out, the single
  fetch, the renderer, the meters, the mode badge, the error card, Export run.
  Contains no pathfinding (asserted by test).
- `public/referee.js` — **verification only**; never used to choose a move. Also exposes
  `boardQuality()` for board-generation sanity.
- `public/index.html`, `public/style.css` — UI (mobile-tuned for 390×844).
- `fixtures/` — committed REPLAY recordings (`index.json` + `<hash>.json`) and
  git-ignored `recorded/*.live.json`.
- `scripts/record-fixtures.mjs` — deterministic regeneration of the committed fixtures.
- `test/` — the `node --test` suite.
- `docs/API.md` — the exact TypeSafe request/response shape used here.

## Honest caveat

"Which move is move *k* of the shortest path?" is a *global* reasoning question, and the
TypeSafe docs steer away from those toward one-second snap judgments. That is exactly why
this is worth running: the referee tells you whether Jev's fan-out is consistent and
optimal, and the per-move probabilities tell you *where* it wasn't sure. If it wobbles,
that is a finding, not a bug.