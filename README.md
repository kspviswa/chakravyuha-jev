# PathPuzzle — the game loop has no logic

A browser puzzle where **every move is a Jev decision**. There is no A\*, no BFS, no
heuristic in the game loop — you can prove it: the invariant test scans the source.
The board is serialised, sent to Jev in **one request**, and the direction list Jev
returns is applied verbatim. The app then *checks* the answer with a referee.

Two skins run on the same loop:

- **Grid** — a maze of `.`/`#`; every step is "which move is *k* of the shortest path?".
- **Map** — a city street grid with a congestion-weight on every road; Jev routes a car
  from pickup S to drop-off D by least *cost*, and the app animates the drive turn by turn.

```
   difficulty / city + 🎲 New
            │
            ▼
   state = { grid or weights, source, destination, rules }   ← the environment
            +
   questions = { reachable, path_length/cost_band, move_1 … move_K, … }
            │                                    ← fan-out: one typed question per step
            ▼
   ONE POST to the shim →  typed answers + probabilities, one round trip
            │
            ▼
   app walks S in the returned directions → draws/animates the path
            │
            ▼
   referee.js checks: in bounds? walls? reaches D? minimal? (cost-aware on maps)
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

Zero configuration, no dependencies (`node` > 20 only — it uses global `fetch`,
`WebSocket` is only used by the *test* harness). `npm start` with no environment
variables boots STUB mode: the shim answers from a local offline solver (the **only**
pathfinding code outside `lib/referee.js`, confined to one function in `server.mjs` —
see the invariant test). Those answers are visibly labelled STUB; they are **not** Jev.

## Bring your own key (BYOK) — the default way to play LIVE

TypeSafe blocks browser-to-API calls: the live endpoint answers OPTIONS preflights with
`400` and **no `Access-Control-Allow-Origin` header**, so a key used directly in the page
cannot reach the API. Instead the shim relays:

1. Paste your key into the **keycard** in the page headline (trailing/leading whitespace
   trimmed; it is never logged, never sent anywhere but the shim, and never committed).
2. Tick **remember** if you want it persisted in `localStorage` (`jev.key`) for next time;
   **forget** clears it.
3. A toggle chooses **proxy** (default — the shim forwards with `x-jev-key`, respects the
   CORS boundary) or **direct** (page→API, needed only when the API's CORS posture changes).

The front page badge flips to **LIVE**: real Jev, one request, meters attached. A key in
the page takes priority over a server-side env key for that request only; without any key
the shim stays in STUB. The raw live response is recorded to `fixtures/recorded/*.live.json`
(git-ignored) for later replay.

```bash
TYPESAFE_API_KEY=sk_... npm start    # server-side key, if you prefer it not in the browser
TYPESAFE_MODEL=jev-latest npm start  # optional model override
```

## The three answer sources

Every answer a client receives carries a `mode` field, and the UI badge shows one of three
distinct states:

| Mode | When | Answer source |
|---|---|---|
| `LIVE` | page `x-jev-key`, `authorization: Bearer`, or env `TYPESAFE_API_KEY` | real Jev, one request to TypeSafe |
| `REPLAY` | `TYPESAFE_REPLAY` is set | a recorded fixture, verbatim (deterministic, no key, no network) |
| `STUB` | none of the above (default) | the local offline solver, clearly labelled |

Priority (highest first): **REPLAY > LIVE > STUB**. A per-request key never beats REPLAY.

### Stable demos (REPLAY)

```bash
TYPESAFE_REPLAY=1 npm start       # deterministic, but only answers requests
                                  # whose request-hash matches a recording
TYPESAFE_REPLAY=easy npm start    # always serves the easy recording, whatever
TYPESAFE_REPLAY=hard npm start    # always serves the hard recording
```

## Under a hub path (/abhimanyu/)

The app derives its request base from `location.pathname`, so it runs unchanged under any
subpath. The hub (nginx) strips the prefix before the shim sees the request; in CI we
simulate exactly that with a prefix-stripping reverse proxy and assert `/` and
`/abhimanyu/` both serve the page, the assets, `/api/health` and a full stub round-trip —
and that secrets still 404 under the prefix. (`test/subpath.test.mjs`)

## Static, and only static

The repo root *is* the webroot. `server.mjs` serves exactly `index.html`, `app.js`,
`style.css`, `lib/` and `skins/`; anything else (`server.mjs`, `package.json`, `.git/`,
`test/`, `fixtures/`, docs) is an explicit 404. A test walks the allowlist both at `/` and
under the simulated subpath.

## Run tests

```bash
npm test
```

Zero-dependency `node --test` suite: server smoke + hardening on an ephemeral port,
static-asset sanity, ES-module parsing, offline-solver round-trips (unweighted **and**
weighted — answers verified against the referee), referee unit tests (BFS **and** Dijkstra),
BYOK header plumbing against a **mock upstream** (including a fake key → upstream `401` →
clean typed `502`), replay, the subpath proxy test, transport/board/jev unit tests, and
the invariant tests that pin the game loop to be pathfinding-free.

## The request/response contract

Exact shapes live in [`docs/API.md`](docs/API.md). In short:

- `POST /api/jev` with `{ state, questions }` — a grid state (`grid: string[]`, unweighted)
  or a navigation state (`grid` + `weights`, least-cost).
- Returns `{ answers, usage, _ms, _cost_usd, _questions, mode }` — never a raw upstream
  blob on failure; errors are `{ error: { code, message } }`.
- `GET /api/health` → `{ ok: true, mode: "proxy", hasEnvKey: bool }`.

## Why this shape

Jev's three primitives are `Choice`, `Score`, `Noul`, and its flagship pattern is
**speculative fan-out**: many questions, same state, evaluated in parallel, *"adding
questions barely changes the response time."* A path is naturally a fan-out — "what is
move number *k*?" is a well-defined property of the state, so all K questions ride in one
request. On Hard + heatmap that is **261 typed questions in a single round trip**.

The output is enumerable, so three things an LLM can't give you come for free:

1. **Reliable parsing** — no JSON repair, no regex. The type is the contract.
2. **A reward signal** — an enumerable action in an environment is a score. The map skin
   prices the *cost* of the drive Jev chose, so the reward is a number, not a vibe.
3. **A threshold** — the probability on each move lets *code* decide act / flag / retry.

## Two modes: `policy` (default) and `plan`

**`policy` — Jev as a reactive step policy.** The loop is *ask → apply → ask → apply*.
At each step the app enumerates the legal action space (the in-bounds, non-wall
neighbours) and sends **one `Noul` per candidate** — *"the agent is at (r,c); is moving
down a good next step toward the goal?"* — then applies the candidate with the highest
probability. Enumerating the action space and taking an **argmax over Jev's own numbers
is not searching**: no path is computed, no lookahead happens, and `lib/referee.js` still
only *checks* the walked route afterwards. Because it is one call per step, the meters
report **calls made**, per-step and total time, and total cost rather than a single
round trip. A run that cannot proceed stops honestly: `stuck` (no fresh neighbour, or no
answer at all) or `exhausted` (the `4 × (R + C)` step cap). There is no backtracking
search, by design.

**`plan` — the old global ask, kept for comparison.** One call asking for move *k* of the
whole route. Keep it because it is the *evidence*: on a live 16×16 Hard board Jev's
per-move answers collapse (`down` ×23, `right` ×23, `stop` ×18) and its own confidence
says so (0.21–0.44) — while the global aggregates (`reachable`, `path_length`) stay
correct. Ask a System One model for a one-second snap judgment and it does well; ask it
for multi-step global planning and it folds. The toggle lets you watch that happen.

## Debug logging

`JEV_DEBUG=1` turns on one redacted JSON line per `/api/jev` on **stderr** (so it lands in
`journalctl -u abhimanyu`). It records the request id, byte size, question count,
`hasKey`, a **key fingerprint** (first 4 chars + `sha256[0:8]`), the resolved mode, the
upstream status and duration, and — on failure — the **upstream response body**, truncated
to 1 KB. That last field is the point: without it an upstream 401 reaches the client as a
bare "502". The key itself is never logged; `test/debug-log.test.mjs` asserts that, and
`redact()` masks anything credential-shaped before it reaches a line.

```bash
journalctl -u abhimanyu -n 20 --no-pager | grep jev-debug
```

## Files

- `server.mjs` — static allowlist server + `/api/jev` BYOK shim (proxy relay + offline
  stub solver + replay + rate limit + meters + structured errors). The solver lives only
  in `stubAnswer()`, never called when any key is present.
- `app.js` — the shell: base-path derivation, skin switch, keycard/transport, mode badge,
  one `ask()` round trip, answer/meter/referee rendering, Export run. No pathfinding.
- `index.html`, `style.css` — UI (safe-area aware, tuned for 390×844 and 360×640).
- `lib/referee.js` — **verification only**; never chooses a move. `shortestPathLength`
  (BFS), `shortestCost` (Dijkstra), walkers, `boardQuality()` for generation sanity.
- `lib/board.js` — grid + city board generation.
- `lib/jev.js` — state/question/answer builders for both skins.
- `lib/transport.js` — BYOK key store (`jev.key`), proxy/direct transport, base-path.
- `skins/grid.js`, `skins/gmaps.js` — the two skins; both only *draw* returned moves.
- `fixtures/` — committed REPLAY recordings + git-ignored `recorded/*.live.json`.
- `scripts/record-fixtures.mjs` — deterministic regeneration of the committed fixtures.
- `test/` — the `node --test` suite.
- `docs/API.md` — the exact wire shape used here.

## Honest caveat

"Which move is move *k* of the shortest path?" (or "…least-cost route?") is a *global*
reasoning question, and the TypeSafe docs steer away from those toward one-second snap
judgments. **The live run proved the docs right:** on a 16×16 Hard board the per-move
answers collapsed and Jev's own confidence flagged it (0.21–0.44), while the global
aggregates stayed correct. That is why `policy` is the default — it asks the local
question the model is actually built for. `plan` is kept precisely so the failure stays
visible and reproducible. See `test/policy.test.mjs`, which pins the recorded run down as
a regression test.