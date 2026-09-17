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
    "task": "chakravyuha_policy",
    "maze": { "rings": 6, "sectors": 16, "centre_gate_sector": 7 },
    "open_radial": [[true, false, …], …],   // index i-1 = wall between ring i and ring i+1
    "open_circ":   [[true, false, …], …],   // index i-1 = ring i; index s = sector s ↔ s+1
    "warriors": [ { "ring": 3, "sector": 5 }, … ],
    "abhimanyu": { "ring": 6, "sector": 2 },
    "goal": "the centre (ring 0)",
    "visited": [ { "ring": 6, "sector": 2 }, … ],
    "step": 3,
    "maxSteps": 192,
    "rules": "…plain English: the four moves, the two wall arrays, sector wrap…",
    "objective": "…a local ONE-STEP judgment, not a full route plan…",
    "reversal": "clockwise"                  // optional, only after a rejected revisit
  },
  "questions": {
    "move_inward":           { "type": "noul", "instructions": "…" },
    "move_outward":          { "type": "noul", "instructions": "…" },
    "move_clockwise":        { "type": "noul", "instructions": "…" },
    "move_counterclockwise": { "type": "noul", "instructions": "…" },
    "reachable":             { "type": "noul", "instructions": "…" },   // first step only
    "route_length":          { "type": "choice", "criteria": { … } },   // first step only
    "maze_difficulty":       { "type": "score",  "criteria": { … } },   // first step only
    "warriors_blocking":     { "type": "noul", "instructions": "…" }    // first step only
  }
}
```

Validation is **shape-only**: `state` must be an object, `questions` a non-array object,
and the question count must not exceed the per-request cap. A bad payload is a
`400 bad_request`; too many questions is `400 too_many_questions`.

### Response (200, LIVE)

```jsonc
{
  "model": "…",
  "answers": {
    "move_inward": { "type": "noul", "noul": 0.83 },
    "route_length": { "type": "choice", "choice": "9-16", "probabilities": { "1-5": 0.1, "9-16": 0.7 }, "confidence": 0.7 }
  },
  "usage": { "input_tokens": 412, "output_tokens": 96 },
  "mode": "live",
  "_ms": 138,            // the shim's own wall-clock for the round trip
  "_cost_usd": 0.0000214, // ((in + out) / 1e6) × 0.042
  "_questions": 4,
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
  "outcome": "reached|stuck|exhausted|error",
  "rings": 4, "sectors": 12, "boardHash": "…",
  "steps": 12, "optimalSteps": 12,
  "totalMs": 812, "lastStepMs": 71, "msPerStep": 67.7,
  "calls": 12, "questions": 4,
  "tokensIn": 4944, "tokensOut": 1152,
  "costUsd": 0.000256,
  "optimalityScore": 1, "accuracyScore": 1,
  "model": "…", "id": "…", "at": "2026-09-17T21:04:11.512Z"
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