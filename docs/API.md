# API — the exact TypeSafe request/response shape used by PathPuzzle

This document records the wire contract so you can reproduce a run without reading the
code. The game speaks to Jev through the local proxy `POST /api/jev`, which forwards to:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>   (attached by the proxy, never the browser)
Content-Type: application/json
```

`server.mjs` appends `model: payload.model || TYPESAFE_MODEL` (`jev-latest`) to the body
it forwards.

## 1. Request — what the client sends

```
POST /api/jev
Content-Type: application/json

{
  "state": {
    "task": "grid_pathfinding",
    "grid": ["S........", ".........", "...###...", ...],   // rows as strings
    "legend": { "S": "source", "D": "destination", "#": "wall (impassable)", ".": "open cell" },
    "source": { "row": 0, "col": 0 },
    "destination": { "row": 15, "col": 15 },
    "rules": "Grid coordinates are (row, col), 0-indexed, row 0 at the top. Moves are 4-directional. Diagonals are not allowed. Walls cannot be entered.",
    "objective": "Find the shortest path from S to D, expressed as an ordered list of single-cell moves."
  },
  "questions": {
    "reachable": {
      "type": "noul",
      "instructions": "Is the destination D reachable from the source S without entering any wall?",
      "criteria": { "true": "a path from S to D exists", "false": "no path from S to D exists" }
    },
    "path_length": {
      "type": "choice",
      "instructions": "How many single-cell moves does the shortest path from S to D take?",
      "criteria": { "1-5": null, "6-10": null, "11-15": null, "16-20": null, "21-30": null, "31-50": null, "51+": null }
    },
    "maze_difficulty": {
      "type": "score",
      "instructions": "How hard is this maze to solve by eye?",
      "criteria": ["trivial", "easy", "moderate", "hard", "brutal"]
    },
    "move_1": {
      "type": "choice",
      "instructions": "Consider the shortest path from S to D on the grid in state.grid. Movement is 4-directional (up, down, left, right), diagonals are not allowed, and walls (#) cannot be entered. What is the direction of move number 1 along that shortest path? Answer \"stop\" if the shortest path contains fewer than 1 moves.",
      "criteria": { "up": ..., "down": ..., "left": ..., "right": ..., "stop": ... }
    },
    "move_2":  { "type": "choice", ... },        // one per move, up to 64
    "cell_3_7": { "type": "noul", ... }          // optional: "is this cell on the path?" (heatmap)
  }
}
```

Rules enforced by the proxy:

- the body is capped at **2 MB** (`413 payload_too_large` beyond it);
- at most **512 questions** per request (`400 too_many_questions`);
- `state.grid` must be a non-empty `string[]`, `questions` a plain object.

## 2. Response — what the client receives (success)

The proxy passes the TypeSafe answer through and adds five contract fields. The exact
object the client sees:

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

The added fields:

| Field | Meaning |
|---|---|
| `_ms` | wall-clock round trip through the proxy, ms |
| `_cost_usd` | estimated input-token cost at $0.042 / 1M input tokens |
| `_questions` | how many questions the request contained |
| `mode` | `live` real Jev · `replay` served from a recorded fixture · `stub` local offline solver |

Answer `type` always matches the question `type`: `noul` answers carry a `noul`
probability, `choice` answers a `choice` key + `probabilities`, `score` answers a `score`
+ `legend`. The UI renders them with that contract in mind.

## 3. Errors — structured, never a raw upstream blob

All failures return JSON (not an upstream dump), shape `{ "error": { "code", "message" } }`:

| HTTP | code | When |
|---|---|---|
| 400 | `bad_request` | body is not valid JSON or missing `state`/`questions` |
| 400 | `too_many_questions` | request exceeds the 512-question cap |
| 404 | `no_fixture` | REPLAY mode, no recorded fixture matches the request hash |
| 404 | `not_found` | unknown path (static or unknown `/api/*`) |
| 413 | `payload_too_large` | body exceeds the 2 MB cap |
| 429 | `rate_limited` | per-IP burst exceeds `RATE_LIMIT` (default 40/min) |
| 500 | `internal_error` | unexpected proxy failure |
| 502 | `upstream_error` | TypeSafe unreachable or returned a non-2xx; the raw upstream body is never echoed |
| 403 | `forbidden` | path traversal attempt |

## 4. Health

```
GET /api/health → 200 { ok: true, stub: boolean, mode: "live"|"replay"|"stub", model: "jev-latest" }
```

## 5. Environment

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `TYPESAFE_API_KEY` | *(unset)* | live Jev; without it the answer is the stub |
| `TYPESAFE_MODEL` | `jev-latest` | upstream model for live calls |
| `TYPESAFE_REPLAY` | *(unset)* | `1`/`true` = replay by request hash; `easy`/`hard` = always serve that recorded fixture |
| `RATE_LIMIT` | `40` | max `/api/jev` requests per IP per minute |
| `TYPESAFE_UPSTREAM` | `https://api.typesafe.ai/v1/systemone` | **test-only** override; the suite points it at a mock |

No API key is wired, used, or committed in this repository; the default path is the stub.