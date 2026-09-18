# API — the exact TypeSafe request/response shape used by Chakravyuha

Two endpoints are exposed by the shim (`server.mjs`). It is a **same-origin relay**,
nothing more: it never computes an answer, never caches one, and never fabricates one.

## Why a shim at all

The browser **cannot** reach the TypeSafe API directly: it answers OPTIONS preflights with
`400` and **no `Access-Control-Allow-Origin`** header. So the page posts to its own origin
and the shim relays to the upstream with the user's key.

Key resolution, in order:

1. `x-jev-key: <key>` header — the browser's BYOK key (the shim also accepts
   `authorization: Bearer <key>`).
2. env `TYPESAFE_API_KEY` — a server-side key.

**No key → `401 no_key`.** There is no third state: no stub, no replay, no offline solver.

---

## `POST /api/jev`

### Request

```http
POST /api/jev HTTP/1.1
Content-Type: application/json
x-jev-key: sk_…            (optional; the server-side env key is used when absent)
```

```jsonc
{
  "state": {
    "task": "chakravyuha_path",
    "maze": { "rings": 6, "sectors": 16, "centre_gate_sector": 7 },
    "open_radial": [[true, false, …], …],   // index i-1 = wall between ring i and ring i+1
    "open_circ":   [[true, false, …], …],   // index i-1 = ring i; index s = sector s ↔ s+1
    "warriors": [ { "ring": 3, "sector": 5 }, … ],   // empty when the obstacles toggle is off
    "abhimanyu": { "ring": 6, "sector": 2 },
    "centre": { "ring": 0, "sector": 0 },
    "visited": [ { "ring": 6, "sector": 2 }, … ],
    "ask_moves": 64,
    "start": { "ring": 6, "sector": 2 },
    "rules": "…plain English: the four moves, the two wall arrays, sector wrap…",
    "objective": "…the quickest route from Abhimanyu to the centre, asked move by move…"
  },
  "questions": {
    "move_1": {
      "type": "choice",
      "instructions": "Abhimanyu is on ring 3, sector 5. The centre is ring 0, sector 0. What is move 1 of the quickest route from Abhimanyu to the centre?",
      "criteria": {
        "inward": "one ring toward the centre (I → I-1), same sector",
        "outward": "one ring away from the centre (I → I+1), same sector",
        "clockwise": "one sector clockwise ((s+1) mod S), same ring",
        "counterclockwise": "one sector counterclockwise ((s-1+S) mod S), same ring"
      }
    },
    "move_2": { "type": "choice", "instructions": "… What is move 2 of the quickest route …", "criteria": { … } }
  }
}
```

Every question is answered against the same state in **one forward pass**, so
`move_2` is independently computable. The answers are therefore not guaranteed
consistent, and the shell checks the chain against the doors, applying only the
moves that are legal and land on an unvisited cell.

Validation is **shape-only**: `state` must be an object, `questions` a non-array object,
and the question count must not exceed the per-request cap. A bad payload is a
`400 bad_request`; too many questions is `400 too_many_questions`.

### Response (200, LIVE)

```jsonc
{
  "model": "…",
  "answers": {
    "step_1": { "type": "choice", choice: "inward", probabilities: { inward: 0.83 }, confidence: 0.83 }
  },
  "usage": { "input_tokens": 412, "output_tokens": 96 },
  "mode": "live",
  "_ms": 138,            // the shim's own wall-clock for the round trip
  "_cost_usd": 0.0000214, // ((in + out) / 1e6) × 0.042
  "_questions": 1,
  "_output_tokens": 96
}
```

The upstream's `answers` are passed through **verbatim** — the shim adds only the
`_`-prefixed meters. The key never appears in the response.

### Errors

Always `{ "error": { "code": "…", "message": "…" } }` — never a raw upstream blob.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | body is not JSON, or `state`/`questions` are the wrong shape |
| 400 | `too_many_questions` | more than the per-request question cap |
| 401 | `no_key` | no browser key and no env key — BYOK, never answered locally |
| 429 | `rate_limited` | per-IP rate limit exceeded |
| 502 | `upstream_error` | the upstream failed or returned a non-JSON body |
| 504 | `upstream_timeout` | the upstream did not answer in time |

---

## `GET /api/health`

```json
{ "ok": true, "mode": "proxy", "hasEnvKey": false }
```

`hasEnvKey` reports only whether the *server* holds a key — never the key itself.

---

## `GET | POST | DELETE /api/runs`

The accumulating run history (`runs.jsonl`, append-only, capped at the most recent 500).

- `POST` — one normalised run record. The server **whitelists** the fields, **clamps**
  numbers to sane ranges, drops credential-shaped keys, and **rejects any record whose
  `mode` is not `live`** (`400 bad_request`). It stamps `id` and `at`. Returns `201`.
- `GET` — `{ runs: [ … ], count: n }`, newest first.
- `DELETE` — clears the file. Returns `{ ok: true, cleared: n }`.

Record shape (all fields validated):

```jsonc
{
  "difficulty": "easy|medium|hard",
  "mode": "live",
  "outcome": "reached|stuck|unparsed|exhausted|error",
  "rings": 4, "sectors": 12, "boardHash": "…",
  "steps": 12, "optimalSteps": 12,
  "totalMs": 812, "lastStepMs": 71, "msPerStep": 67.7,
  "calls": 12, "questions": 1,
  "tokensIn": 4944, "tokensOut": 1152,
  "costUsd": 0.000256,
  "stepAccuracy": 0.92, "correctSteps": 11, "moves": ["inward", "clockwise", …],
  "elapsedMs": 4200,
  "model": "…", "id": "…", "at": "2<|fim_hole|>
}
```

`runs.jsonl` is git-ignored and never contains the API key.

---

## Debug logging

`JEV_DEBUG=1` writes one redacted JSON line per request to **stderr** (so it lands in
`journalctl -u abhimanyu`): request id, byte size, question count, `hasKey`, a **key
fingerprint** (first 4 chars + `sha256[0:8]`), the resolved mode, upstream status and
duration, and on failure the truncated upstream body. The key itself is never logged;
`redact()` masks anything credential-shaped first.
