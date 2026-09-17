# API — the exact TypeSafe request/response shape used by PathPuzzle

This document records the wire contract so you can reproduce a run without reading the
code. The game speaks to Jev through the local shim `POST /api/jev`, which forwards to:

```
POST https://api.typesafe.ai/v1/systemone
Content-Type: application/json
```

## 0. Key resolution — BYOK first, env fallback

The browser **cannot** reach the TypeSafe API directly: it answers OPTIONS preflights with
`400` and no `Access-Control-Allow-Origin` header, so a page key alone dies to CORS. The
shim is the proxy across that boundary. On each `/api/jev` request the shim resolves the
key, highest priority first:

1. `x-jev-key: <key>` header (the browser sends the pasted BYOK key; see 1b)
2. `authorization: Bearer <key>` header
3. `TYPESAFE_API_KEY` env var

and forwards as `Authorization: Bearer <key>`. Keys are never logged, never returned in
any body, never recorded into fixtures, and never committed. A request key flips that
request to LIVE only; REPLAY mode still wins. No key at all → STUB (offline solver).

## 1. Request — what the client sends

```
POST /api/jev
Content-Type: application/json          (browser also sends x-jev-key when BYOK)

{
  "state": { ... one of the two shapes below ... },
  "questions": { "<qid>": { "type": "choice"|"score"|"noul", ... } }
}
```

The shim appends `model: payload.model || TYPESAFE_MODEL` (`jev-latest`) before forwarding.

### 1a. Grid state (skin: grid, unweighted)

```
"state": {
  "task": "grid_pathfinding",
  "grid": ["S..", ".#.", ".D."],          // rows as strings, same width
  "legend": { "S": "source", "D": "destination", "#": "wall (impassable)", ".": "open cell" },
  "source": { "row": 0, "col": 0 },
  "destination": { "row": 2, "col": 1 },
  "rules": "Grid coordinates are (row, col), 0-indexed, row 0 at the top. Moves are 4-directional. Diagonals are not allowed. Walls cannot be entered.",
  "objective": "Find the shortest path from S to D, expressed as an ordered list of single-cell moves."
}
```

Questions: `reachable` (noul), `path_length` (choice, buckets
`1-5 6-10 11-15 16-20 21-30 31-50 51+`), `maze_difficulty` (score), one `move_k` per move
up to 64 (choice: `up down left right stop`), and — when the heatmap is on —
`cell_r_c` (noul) for every open cell, "is this cell on the shortest path?".

### 1b. Navigation state (skin: map, weighted)

```
"state": {
  "task": "navigation_weighted",
  "grid": ["S.D", "..."],                 // streets; '#' building, 'P' park (both impassable)
  "weights": [[0, 9, 0], [1, 1, 1]],     // entry cost per cell; S/D pay 0, roads 1..5
  "legend": { "S": "pickup", "D": "drop-off", "#": "building", "P": "park", ".": "road",
              "numbers": "congestion weight (1..5; 5 = jammed)" },
  "source": { "row": 0, "col": 0 },
  "destination": { "row": 0, "col": 2 },
  "rules": "Movement is 4-directional. Entering a cell costs its congestion weight from state.weights; 5 is jammed, 1 is clear. Buildings '#' and the park 'P' cannot be entered. The start cell is free.",
  "objective": "Find the least-cost route (minimum total congestion) from S to D."
}
```

Questions: `reachable` (noul), `cost_band` (choice: the *minimal* total congestion, buckets
`1-20 21-40 41-60 61-100 101+`), `route_difficulty` (score, `trivial … brutal`),
`eta_band` (choice: `under 10 min 10–20 min 20–30 min 30–45 min 45+ min`, a coarse
minutes-per-cost mapping), and one `move_k` per step (choice, same directions + `stop`).

Rules enforced by the shim:

- body capped at **2 MB** (`413 payload_too_large` beyond);
- at most **512 questions** per request (`400 too_many_questions`);
- `state.grid` non-empty, `questions` a plain object (else `400 bad_request`).

## 2. Response — what the client receives (success)

The shim passes the TypeSafe answer through and adds five contract fields:

```
200 OK

{
  "model": "jev-latest",
  "answers": {
    "reachable": { "type": "noul", "noul": 0.99 },
    "path_length": { "type": "choice", "choice": "6-10", "probabilities": { "6-10": 0.9 }, "confidence": 0.9 },
    "maze_difficulty": { "type": "score", "score": 2.0, "legend": {...}, "probabilities": { "2": 0.7 }, "confidence": 0.7 },
    "move_1": { "type": "choice", "choice": "down", "probabilities": { "down": 0.93 }, "confidence": 0.93 },
    "move_2": { "type": "choice", "choice": "stop", "probabilities": { "stop": 0.93 }, "confidence": 0.93 },
    "cell_3_7": { "type": "noul", "noul": 0.5 }
  },
  "usage": { "input_tokens": 17612, "output_tokens": 261 },
  "_ms": 1432,
  "_cost_usd": 0.000739704,
  "_questions": 261,
  "mode": "live"                    // "live" | "replay" | "stub"
}
```

| Field | Meaning |
|---|---|
| `_ms` | wall-clock round trip through the shim, ms |
| `_cost_usd` | estimated input-token cost at $0.042 / 1M input tokens |
| `_questions` | how many questions the request contained |
| `mode` | `live` real Jev · `replay` recorded fixture · `stub` local offline solver |

Answer `type` always matches the question `type`.

## 3. Errors — structured, never a raw upstream blob

All failures return JSON `{ "error": { "code", "message" } }`:

| HTTP | code | When |
|---|---|---|
| 400 | `bad_request` | body is not valid JSON or missing `state`/`questions` |
| 400 | `too_many_questions` | request exceeds the 512-question cap |
| 403 | `forbidden` | path traversal attempt |
| 404 | `no_fixture` | REPLAY mode, no recorded fixture matches the request hash |
| 404 | `not_found` | unknown path (static allowlist miss or unknown `/api/*`) |
| 413 | `payload_too_large` | body exceeds the 2 MB cap |
| 429 | `rate_limited` | per-IP burst exceeds `RATE_LIMIT` (default 40/min) |
| 500 | `internal_error` | unexpected shim failure |
| 502 | `upstream_error` | TypeSafe unreachable or returned non-2xx. **A bad/fake key is exactly this**: TypeSafe answers a bad-key POST with `401`, the shim reads it (never echoes the body and never leaks the key) and returns `502 upstream_error` with a message like "TypeSafe rejected the key" / "TypeSafe is unreachable". |

## 4. Health

```
GET /api/health → 200 { "ok": true, "mode": "proxy", "hasEnvKey": false }
```

`mode` is `"proxy"` (this shim always proxies when a key is available); `hasEnvKey` tells a
front page whether `TYPESAFE_API_KEY` is set server-side. A response *mode* (`live`/...)
belongs to `/api/jev` bodies, not to health.

## 5. Static surface — the shim is also a minimal web server

The repo root is the webroot. Exactly these paths are served:

```
/            /index.html   /app.js   /style.css
/lib/*.js    /skins/*.js
```

Everything else — `server.mjs`, `package.json`, `.git/*`, `test/*`, `fixtures/*`,
`docs/*`, any traversal — is `404 not_found`.

## 6. Environment

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `TYPESAFE_API_KEY` | *(unset)* | server-side live key; without it (and without a request key) the answer is the stub |
| `TYPESAFE_MODEL` | `jev-latest` | upstream model for live calls |
| `TYPESAFE_REPLAY` | *(unset)* | `1`/`true` = replay by request hash; `easy`/`hard` = always serve that recorded fixture |
| `RATE_LIMIT` | `40` | max `/api/jev` requests per IP per minute |
| `TYPESAFE_UPSTREAM` | `https://api.typesafe.ai/v1/systemone` | **test-only** override; the suite points it at a mock |

No API key is wired, used, or committed in this repository; the default path is the stub,
and BYOK keys never leave the browser except in the `x-jev-key` header to this shim.