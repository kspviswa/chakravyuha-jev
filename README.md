# Chakravyuha — Jev guides Abhimanyu

A browser labyrinth where **every move is a Jev decision**. Abhimanyu starts on the
outermost ring of a *chakravyuha* — the concentric battle formation of the Mahabharata —
and has to reach the **target at the centre** past the warriors standing in the rings.

There is no pathfinding in the game loop, and you can prove it: an invariant
test scans the source. The maze is serialised to text, sent to Jev, and the move Jev picks
is applied **verbatim**. The app then draws the shortest route only after the run ends,
and Abhimanyu **walks** that route one animated hop at a time.

```
    difficulty (easy / medium / hard) + 🎲 New maze + obstacles toggle
             │
             ▼
    state = { maze, open_radial, open_circ, warriors, abhimanyu, centre,
              visited, ask_moves, start, rules, objective }
             +
    questions = { move_1: {…}, move_2: {…}, … move_64: {…} }
             │        ← the WHOLE route, one typed choice per move
             ▼
    POST → /api/jev → TypeSafe → every answer in ONE forward pass
             │
             ▼
    app CHECKS the chain against the doors → applies the moves that survive
             │   → Abhimanyu ANIMATES them → ask again from where it stopped
             ▼
    shortest route drawn only after the run ends, to compare
             │
             ▼
    meters: outcome · steps vs shortest · step accuracy · chain agreement · cost
             │
             ▼
    the run is recorded server-side, so history accumulates across sessions
```

**Why the whole route in one call.** Jev answers every question in one forward pass
against a shared state, and adding questions barely moves the latency. Asking one move
per round trip made a 17-move run cost 17 calls, each dependent on the last. Asking
`move_1 … move_K` makes it cost **one** call. The answers are independent, so the chain
is checked against the real doors and cut at the first move that is illegal, blocked or
already visited; if the centre is still not reached the loop asks again from where it
stopped. The ratio of moves that survived is recorded as **chain agreement** — that is
the calibration signal, and it is the point of the experiment.

**The obstacles toggle** turns the warriors off, leaving a pure wall maze. The only
thing that can stop a run is then a wall, which separates "can Jev compute a route"
from "can Jev avoid a dead end".

## The three difficulties

| Level | Rings × sectors | Warriors | Braid |
|---|---|---|---|
| **Easy** | 4 × 12 | 6 | 0.20 |
| **Medium** | 6 × 16 | 14 | 0.12 |
| **Hard** | 8 × 20 | 26 | 0.06 |

*Braid* is the fraction of still-closed walls re-opened after the maze is carved, so the
maze keeps loops and several routes exist. Every maze is guaranteed solvable and deep enough
to be worth asking about: generation carves a **randomised DFS spanning tree** over centre
+R×S cells on a polar grid, then braids it, then places warriors one at a time, rejecting
any placement that would sever the route to the centre. A fresh maze is redrawn until the
shortest route is at least `minSteps` long and the warrior count is exact.
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
  it the shortest route would leak the answer into the render layer — the same bug as
  solving on load, in a new costume. `test/animation.test.mjs` drives a deliberately
  wandering policy and asserts the sprite walked *that* route, not the shortest.
- **The shortest route appears only after the run ends**, as a dashed line labelled
  *"shortest route · N moves"*, so the step-accuracy meter has a picture to compare against.

Movement is queue-based and cancellable, and `prefers-reduced-motion` (or `?anim=0`, or
`setAnimationDuration(0)`) snaps between cells for accessibility and deterministic tests.

## Icons

`lucide-react` needs React and a build step; this is a zero-dependency static ES-module
page. So the **exact Lucide geometry** (`lucide-static` v1.47.0, **ISC licence**) is
vendored in `lib/icons.js` as path data and drawn on canvas via `Path2D`. No CDN is
contacted at runtime. The `target` glyph marks the goal at the centre, `crown` badges
Abhimanyu, `swords` marks warrior dots when they are large enough, and `sparkles` fires on
arrival.

## The shortest route (drawn only after a run)

`lib/chakra.js` contains `shortest()`, the only BFS search in the codebase. It is called
by the shell **after a run ends** to compute the optimal route for the comparison overlay,
and by maze generation to verify solvability. The game loop (`lib/jev.js`) never calls
`shortest()` — an invariant test enforces this. The shortest route is drawn only once a
run finishes, labelled **"shortest route · N moves"**.

## Metrics — how long, and how correct

Every completed run is recorded **server-side** into `runs.jsonl` (one JSON object per
line, append-only, capped at the most recent **500**, git-ignored) — so history survives a
browser change and is visible from any device. The client computes the meters; the server
only whitelists fields, clamps numbers, drops credential-shaped keys,
**rejects any record whose mode is not `live`**, and stamps `id`/`at`. Recording is
fire-and-forget and never alters the play flow's response.

On the play page:

| Meter | Definition |
|---|---|
| decision time · last step | the last call's wall time |
| total time | the sum over every call |
| calls made | round trips to Jev |
| total cost | `$`, summed from every call |
| questions per call | the number of questions in the most recent request (always 1) |
| steps vs shortest | `steps / optimal`, where `optimal` is `shortest()`'s length |
| **step accuracy** | **the fraction of steps that reduce the BFS distance to the centre by exactly 1** |
| elapsed | wall-clock time for the whole run |

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
- `policy.test.mjs` — the full polar policy loop against a mock upstream: optimal runs on
  every level, honest meter summation, stuck/exhausted/unparsed stops, the two mock-policy
  regression runs (shortest-following and inward-greedy), and the `maxSteps` guard.
- `animation.test.mjs` — polar interpolation and the short-way wrap, the queue, cancel,
  instant mode, **and the invariant that the sprite only ever follows Jev's own route**.
- `no-stub.test.mjs` — no stub, no replay, no fixtures; no search outside lib/chakra.js;
  and a keyless request is a `401 no_key` that never contacts the upstream.
- `static.test.mjs` — invariant that `lib/jev.js` must not reference `shortest`, and no
   `judge` token anywhere in the repo.
- `runs.test.mjs` — run-history validation, secret-key dropping, the 500-cap, corrupt
  lines, restart survival, and the guarantee that recording never alters the play flow.
- `server` / `static` / `subpath` / `transport` / `debug-log` / `stats` / `icons` — the
  HTTP layer, the asset allowlist, the subpath proxy, the BYOK store, the redacted debug
  log, and the vendored Lucide geometry.

## The request/response contract

- `POST /api/jev` with `{ state, questions }` — a polar chakravyuha state.
  `questions` contains `move_1 … move_K`, one choice question per move of the route.
- Returns `{ answers, usage, _ms, _cost_usd, _questions, mode }`; errors are always
  `{ error: { code, message } }` — never a raw upstream blob.
- `GET /api/health` → `{ ok: true, mode: "proxy", hasEnvKey: bool }`.
- `POST|GET|DELETE /api/runs` — the run history.

## Debug logging

`JEV_DEBUG=1` writes one redacted JSON line per `/api/jev` request to **stderr** (so it lands
in `journalctl -u abhimanyu`): request id, byte size, question count, `hasKey`, a **key
fingerprint** (first 4 chars + `sha256[0:8]`), the resolved mode, upstream status and
duration, and on failure the truncated upstream body. The key itself is never logged, and
`redact()` masks anything credential-shaped first.

```bash
journalctl -u abhimanyu -n 20 --no-pager | grep jev-debug
```

## Files

- `server.mjs` — static allowlist server + the `/api/jev` BYOK shim (proxy relay, rate
  limit, meters, structured errors) + `/api/runs`. **No solver, no stub, no replay.**
- `app.js` — the shell: base path, keycard, meters, the policy loop, step accuracy, and
  fire-and-forget recording. No pathfinding.
- `skins/chakravyuha.js` — the ring maze: walls, warrior dots, the Lucide target at the
  centre, Abhimanyu as the animated sprite, the trail, and the post-run shortest route overlay.
- `lib/chakra.js` — the polar model: presets, geometry, generation, adjacency, shortest BFS,
  and the serialisation sent to Jev.
- `lib/jev.js` — the polar state/question/answer builders and the policy loop.
- `lib/animator.js` — the DOM-free movement queue (polar tween, short-way wrap, cancel).
- `lib/icons.js` — vendored Lucide geometry (ISC) and canvas drawing.
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
