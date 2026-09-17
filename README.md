# Chakravyuha — Jev guides Abhimanyu

A browser labyrinth where **every move is a Jev decision**. Abhimanyu starts on the
outermost ring of a *chakravyuha* — the concentric battle formation of the Mahabharata —
and has to reach the **target at the centre** past the warriors standing in the rings.

There is no A\*, no BFS, no heuristic in the game loop, and you can prove it: an invariant
test scans the source. The maze is serialised to text, sent to Jev, and the move Jev picks
is applied **verbatim**. The app then *checks* the answer with a referee, and Abhimanyu
**walks** the route one animated hop at a time.

```
   difficulty (easy / medium / hard) + 🎲 New maze
            │
            ▼
   state = { maze, open_radial, open_circ, warriors, abhimanyu, goal, rules }
            +
   questions = { move_inward, move_outward, move_clockwise, move_counterclockwise, … }
            │                       ← one typed Noul per legal move
            ▼
   POST → /api/jev → TypeSafe → typed answers + probabilities
            │
            ▼
   app applies Jev's argmax → Abhimanyu ANIMATES that one hop → ask again
            │
            ▼
   referee.js checks: in bounds? walls? warriors? reached the centre? shortest?
            │
            ▼
   meters + efficiency: ms/step · questions/step · tokens/step · $/step
            │
            ▼
   the run is recorded server-side, so history accumulates across sessions
```

## The three difficulties

| Level | Rings × sectors | Warriors | Braid |
|---|---|---|---|
| **Easy** | 4 × 12 | 6 | 0.20 |
| **Medium** | 6 × 16 | 14 | 0.12 |
| **Hard** | 8 × 20 | 26 | 0.06 |

*Braid* is the fraction of still-closed walls re-opened after the maze is carved, so the
maze keeps loops and several routes exist — which is what makes "did Jev find the shortest
one?" a real question rather than a foregone one.

Every maze is guaranteed solvable and deep enough to be worth asking about: generation
carves a randomised spanning tree, braids it, then **places warriors one at a time,
rejecting any placement that would sever the route to the centre**. A fresh maze is
redrawn until the referee confirms it is solvable and at least `minSteps` from the goal.
`test/chakra.test.mjs` proves this over 200 seeded draws per level.

## Quickstart

```bash
cd ~/ws/jev/chakravyuha
npm start                 # http://localhost:8787
```

Zero dependencies — Node ≥ 20 only (it uses global `fetch`). There is **no stub mode**:
without a key the shim answers `401 no_key` and the page tells you to paste one. The app
is LIVE-only, by design.

## Bring your own key (BYOK)

TypeSafe blocks browser-to-API calls: the live endpoint answers OPTIONS preflights with
`400` and **no `Access-Control-Allow-Origin` header**, so a key used directly in the page
cannot reach the API. The same-origin **shim** relays instead:

1. Paste your key into the **keycard** (whitespace trimmed; never logged, never sent
   anywhere but the shim, never committed, never returned in a response).
2. Tick **remember** to keep it in `localStorage` (`jev.key`); **Forget key** clears it.
3. The badge reads **LIVE** once a request succeeds, **NO KEY** otherwise.

A key in the page takes priority over a server-side env key for that request only.

```bash
TYPESAFE_API_KEY=sk_... npm start    # a server-side key, if you prefer it out of the browser
TYPESAFE_MODEL=jev-latest npm start  # optional model override
```

## The animation

Abhimanyu **travels** the maze; he does not teleport. Each applied move tweens him between
cell centres in **polar** space, so he sweeps along a ring rather than cutting a chord, and
a `S-1 → 0` wrap takes the short way round instead of spinning the long way. He faces the
direction of travel, leaves a fading trail, and lands on the target with a sparkles flare.

Two rules keep it honest:

- **The animation never reveals a route Jev has not chosen.** During a run the sprite
  animates exactly the hop that was decided; the route is discovered step by step. Feeding
  it the referee's optimum would leak the answer into the render layer — the same bug as
  solving on load, in a new costume. `test/animation.test.mjs` drives a deliberately
  wandering policy and asserts the sprite walked *that* route, not the referee's.
- **The referee's route appears only after the run ends**, as a dashed line labelled
  *"referee's shortest route"*, so the efficiency meter has a picture to compare against.

Movement is queue-based and cancellable, and `prefers-reduced-motion` (or `?anim=0`, or
`setAnimationDuration(0)`) snaps between cells for accessibility and deterministic tests.

## Icons

`lucide-react` needs React and a build step; this is a zero-dependency static ES-module
page. So the **exact Lucide geometry** (`lucide-static` v1.47.0, **ISC licence**) is
vendored in `lib/icons.js` as path data and drawn on canvas via `Path2D`. No CDN is
contacted at runtime. The `target` glyph marks the goal at the centre, `crown` badges
Abhimanyu, `swords` marks warrior dots when they are large enough, and `sparkles` fires on
arrival.

## The referee (verification only)

`lib/referee.js` is the **only** place a route is ever computed, and it is never allowed to
choose a move. It provides:

- `chakraNeighbours` — the legal moves from a cell (walls and warriors respected);
- `chakraShortest` — BFS over the polar graph, for the post-run comparison;
- `walkChakra` — replays a direction list and reports `hitWall` / `hitWarrior` / `offBoard`
  / `reached` — the only place a move list is inspected for legality;
- `chakraVerdict` — the graded verdict the UI shows;
- `chakraQuality` — generation sanity: solvable, how far, and how many warriors actually
  force a detour.

An invariant test asserts no search algorithm exists anywhere else, and that the game loop
never even asks the referee for a route.

## Two modes: `policy` (default) and `plan`

**`policy` — Jev as a reactive step policy.** *ask → apply → ask*. At each step the app
enumerates the legal moves and sends **one `Noul` per candidate** — *"Abhimanyu is on ring
3, sector 5; is moving inward to ring 2, sector 5 a good next step toward the centre?"* —
then applies the highest-probability candidate and animates the hop. Enumerating the action
space and taking an **argmax over Jev's own numbers is not searching**: no path is
computed, no lookahead happens. A run that cannot proceed stops honestly — `stuck` (every
neighbour already visited) or `exhausted` (the `2·R·S` step cap). There is no backtracking,
by design.

**`plan` — the old global ask, kept for comparison.** One call asking for move *k* of the
whole route. Kept because it is the *evidence*: ask a System One model for a one-second
snap judgment and it does well; ask it for multi-step global planning and its per-move
confidence collapses while the global aggregates stay correct.

## Metrics, efficiency and history

Every completed run is recorded **server-side** into `runs.jsonl` (one JSON object per
line, append-only, capped at the most recent **500**, git-ignored) — so history survives a
browser change and is visible from any device. The client computes the verdict and the
meters; the server only whitelists fields, clamps numbers, drops credential-shaped keys,
**rejects any record whose mode is not `live`**, and stamps `id`/`at`. Recording is
fire-and-forget and never alters the play flow's response.

On the play page:

| Meter | Meaning |
|---|---|
| decision time · last step | the last call's wall time |
| total time | the sum over every call |
| calls made | round trips to Jev |
| total cost | `$`, summed from every call |
| questions per call | the fan-out in the last request |
| steps vs optimal | the walk against the referee's BFS, `unreachable` when there is none |

And an **efficiency** block, every figure divided by the steps actually taken:
`ms/step`, `questions/step`, `calls/step`, `tokens/step` (in / out), `cost/step`. The step
count is the honest denominator — a run that gives up early must not look cheap per step.

`history.html` groups stat cards by **difficulty**, with a sortable table, filters, CSV
export of the view, a clear button, an offline localStorage cache, and a **cumulative
footer**: total runs, steps, questions, tokens and **$ spent**, plus mean ± sample stddev
(`n − 1`; `—` for `n < 2`). Runs accumulate across sessions — that is the point of the page.

## Under a hub path (/abhimanyu/)

The app derives its request base from `location.pathname`, so it runs unchanged under any
subpath. The hub (nginx) strips the prefix before the shim sees the request; `test/subpath.test.mjs`
simulates exactly that with a prefix-stripping reverse proxy and asserts the page, the
assets, `/api/health` and the `401 no_key` refusal all behave under the prefix — and that
secrets still 404.

## Static, and only static

The repo root *is* the webroot. `server.mjs` serves exactly `index.html`, `app.js`,
`history.html`, `history.js`, `style.css`, and the `lib/`, `skins/` and `assets/`
directories. Anything else (`server.mjs`, `package.json`, `.git/`, `test/`, `docs`,
`runs.jsonl`) is an explicit 404. A test walks the allowlist at `/` and under the subpath.

## Run tests

```bash
npm test
```

Zero-dependency `node --test` suite — no network, no key. The whole LIVE path is exercised
against a **mock upstream HTTP server**, so there is no stub standing in for anything:

- `chakra.test.mjs` — polar geometry, adjacency, sector wrap, the single centre gate,
  warrior impassability, generation over 200 seeded draws per level, determinism, and the
  state sent to Jev (asserting no route leaks into it).
- `referee-chakra.test.mjs` — BFS shortest route, detours forced by walls and warriors,
  unreachable mazes, every walker verdict, and BFS/walker agreement over real mazes.
- `policy.test.mjs` — the full polar policy loop against a mock upstream: optimal runs on
  every level, honest meter summation (including the `output_tokens` regression),
  stuck/exhausted stops, the reversal retry, and the `plan` builders.
- `animation.test.mjs` — polar interpolation and the short-way wrap, the queue, cancel,
  instant mode, **and the invariant that the sprite only ever follows Jev's own route**.
- `no-stub.test.mjs` — no stub, no replay, no fixtures; no solver outside the referee; and
  a keyless request is a `401 no_key` that never contacts the upstream.
- `server` / `static` / `subpath` / `runs` / `stats` / `transport` / `debug-log` — the HTTP
  layer, the asset allowlist, run-history validation, statistics and the redacted debug log.

## The request/response contract

- `POST /api/jev` with `{ state, questions }` — a polar chakravyuha state.
- Returns `{ answers, usage, _ms, _cost_usd, _questions, mode }`; errors are always
  `{ error: { code, message } }` — never a raw upstream blob.
- `GET /api/health` → `{ ok: true, mode: "proxy", hasEnvKey: bool }`.
- `POST|GET|DELETE /api/runs` — the run history.

## Debug logging

`JEV_DEBUG=1` writes one redacted JSON line per `/api/jev` to **stderr** (so it lands in
`journalctl -u abhimanyu`): request id, byte size, question count, `hasKey`, a **key
fingerprint** (first 4 chars + `sha256[0:8]`), the resolved mode, upstream status and
duration, and on failure the truncated upstream body. The key itself is never logged, and
`redact()` masks anything credential-shaped first.

```bash
journalctl -u abhimanyu -n 20 --no-pager | grep jev-debug
```

## Files

- `server.mjs` — static allowlist server + the `/api/jev` BYOK shim (proxy relay, rate
  limit, meters, structured errors) + `/api/runs`. **No solver, no stub, no replay.**
- `app.js` — the shell: base path, keycard, mode badge, the policy/plan loops, meters and
  efficiency, referee panel, Export run, fire-and-forget recording. No pathfinding.
- `skins/chakravyuha.js` — the ring maze: walls, warrior dots, the Lucide target at the
  centre, Abhimanyu as the animated sprite, the trail, and the post-run referee overlay.
- `lib/chakra.js` — the polar model: presets, geometry, generation, serialisation.
- `lib/referee.js` — **verification only**; the single home of the search.
- `lib/animator.js` — the DOM-free movement queue (polar tween, short-way wrap, cancel).
- `lib/icons.js` — vendored Lucide geometry (ISC) and canvas drawing.
- `lib/jev.js` — the polar state/question/answer builders and the policy loop.
- `lib/transport.js` — BYOK key store, proxy transport, base-path derivation.
- `lib/stats.js` — pure statistics helpers (mean/median/sample variance/stddev/min/max).
- `index.html`, `style.css` — the play page (Abhimanyu's portrait panel beside the maze,
  safe-area aware, tuned for 390×844 and 360×640).
- `history.html`, `history.js` — the accumulating run history.
- `assets/abhimanyu.jpg` — the artwork.
- `docs/API.md`, `docs/METRICS.md` — the wire shape and the exact metric definitions.
- `runs.jsonl` — the git-ignored, append-only run history (capped at 500).

## Licence and credits

MIT (see `LICENSE`). Icons are vendored from [Lucide](https://lucide.dev)
(`lucide-static` v1.47.0), **ISC licence** — see `LICENSES.md` for the full text and the
list of glyphs. No runtime dependencies: Node's standard library only.
