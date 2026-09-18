// test/runs.test.mjs — the /api/runs endpoints over a SCRATCH runs file (the
// server accepts RUNS_FILE / runsFile so the suite never touches the real
// runs.jsonl — the same isolation lesson as the recorded-fixtures race).
// POST/GET/DELETE round trip, whitelist validation, secret-key dropping,
// the 500-cap dropping the oldest, corrupt lines skipped, restart survival,
// and the guarantee that recording never alters the play flow's response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, postJev, CH_PAYLOAD, startMockUpstream } from './helpers.mjs';
import { RUNS_CAP, normaliseRunRecord, createServer } from '../server.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(__dirname, '..');

const scratchFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-runs-')), 'runs.jsonl');

const VALID_RUN = {
  difficulty: 'medium',
  mode: 'live',
  model: 'jev-latest',
  rings: 6,
  sectors: 16,
  boardHash: '1a2b3c',
  outcome: 'reached',
  steps: 22,
  optimalSteps: 22,
  totalMs: 810,
  lastStepMs: 41,
  msPerStep: 36.8,
  calls: 22,
  questions: 1,
  tokensIn: 2400,
  tokensOut: 480,
  costUsd: 0.000478,
  stepAccuracy: 1.0,
  correctSteps: 22,
  moves: ['inward', 'clockwise'],
  elapsedMs: 4200,
};

async function postRun(base, record) {
  const r = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: json };
}

async function getRuns(base, query = '') {
  const r = await fetch(`${base}/api/runs${query}`);
  const body = await r.json();
  return { status: r.status, body };
}

// ---- round trip ------------------------------------------------------------
test('POST → GET → DELETE round trip over a scratch runs file', async () => {
  const file = scratchFile();
  const ctx = await startServer({ runsFile: file });
  try {
    const a = await postRun(ctx.base, VALID_RUN);
    assert.equal(a.status, 201);
    assert.ok(a.body.id, 'server stamps an id');
    assert.match(a.body.at, /^\d{4}-\d{2}-\d{2}T/, 'server stamps an ISO at');
    assert.equal(a.body.difficulty, 'medium');
    assert.equal(a.body.steps, 22);
    assert.equal(a.body.id, JSON.parse(fs.readFileSync(file, 'utf8').trim()).id, 'the stored line carries the same record');

    const b = await postRun(ctx.base, { ...VALID_RUN, difficulty: 'hard', steps: 7 });
    assert.equal(b.status, 201);

    const g = await getRuns(ctx.base);
    assert.equal(g.status, 200);
    assert.equal(g.body.count, 2);
    assert.equal(g.body.runs.length, 2);
    assert.equal(g.body.runs[0].id, b.body.id, 'newest first');
    assert.equal(g.body.runs[1].id, a.body.id);

    const del = await fetch(`${ctx.base}/api/runs`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { cleared: 2 });
    assert.equal((await getRuns(ctx.base)).body.count, 0);
    assert.equal(fs.existsSync(file), false, 'history file removed');
  } finally {
    await stopServer(ctx);
  }
});

test('GET supports ?limit=N and keeps the newest N, newest first', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await postRun(ctx.base, { ...VALID_RUN, steps: i + 1 });
      assert.equal(r.status, 201);
    }
    const g = await getRuns(ctx.base, '?limit=2');
    assert.equal(g.body.count, 5);
    assert.equal(g.body.runs.length, 2);
    assert.equal(g.body.runs[0].steps, 5);
    assert.equal(g.body.runs[1].steps, 4);
  } finally {
    await stopServer(ctx);
  }
});

// ---- validation ------------------------------------------------------------
test('validation rejects junk with the typed error shape', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const notObject = await postRun(ctx.base, [1, 2, 3]);
    assert.equal(notObject.status, 400);
    assert.equal(notObject.body.error.code, 'bad_request');

    const badJson = await postRun(ctx.base, '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_request');

    const badDifficulty = await postRun(ctx.base, { ...VALID_RUN, difficulty: 'impossible' });
    assert.equal(badDifficulty.status, 400);
    assert.equal(badDifficulty.body.error.code, 'bad_request');

    const nanSteps = await postRun(ctx.base, { ...VALID_RUN, steps: '22' });
    assert.equal(nanSteps.status, 400);

    const infMs = await postRun(ctx.base, { ...VALID_RUN, totalMs: Infinity });
    assert.equal(infMs.status, 400);
    assert.equal(infMs.body.error.code, 'bad_request');

    const tooLong = await postRun(ctx.base, { ...VALID_RUN, model: 'x'.repeat(201) });
    assert.equal(tooLong.status, 400);

    const after = await getRuns(ctx.base);
    assert.equal(after.body.count, 0, 'nothing junk was stored');
  } finally {
    await stopServer(ctx);
  }
});

test('unknown keys are dropped, never stored', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { status, body } = await postRun(ctx.base, {
      ...VALID_RUN,
      evil: true,
      command: 'rm -rf /',
      nested: { a: 1 },
    });
    assert.equal(status, 201);
    assert.equal(body.evil, undefined);
    assert.equal(body.command, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(JSON.stringify(body).includes('rm -rf /'), false);
  } finally {
    await stopServer(ctx);
  }
});

test('a record containing apiKey / x-jev-key is stored WITHOUT them', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { status, body } = await postRun(ctx.base, {
      ...VALID_RUN,
      apiKey: 'sk-super-secret-abc',
      'x-jev-key': 'sk-xjev-999',
      authToken: 't0k3n',
      token: 'abc',
    });
    assert.equal(status, 201);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('sk-super-secret-abc'), 'apiKey dropped');
    assert.ok(!serialized.includes('sk-xjev-999'), 'x-jev-key dropped');
    assert.ok(!serialized.includes('t0k3n'), 'authToken dropped');
    assert.ok(!serialized.includes('"token"'), 'token dropped');
    assert.equal(body.difficulty, 'medium', 'the legitimate fields survived');
    // token COUNTS look credential-shaped but are validated metrics — they must
    // survive the scrubber, or the history page loses its token column.
    assert.equal(body.tokensIn, VALID_RUN.tokensIn, 'tokensIn is a metric, not a secret');
    assert.equal(body.tokensOut, VALID_RUN.tokensOut, 'tokensOut is a metric, not a secret');
    // and the same holds for bytes on disk
    const onDisk = fs.readFileSync(ctx.runsFile, 'utf8');
    assert.ok(!onDisk.includes('sk-super-secret-abc'));
    assert.ok(!onDisk.includes('sk-xjev-999'));
  } finally {
    await stopServer(ctx);
  }
});

test('normaliseRunRecord drops secret-ish fields and clamps numbers', () => {
  const { ok, record, dropped } = normaliseRunRecord({
    ...VALID_RUN,
    stepAccuracy: 5, // out of range → clamp to 1
    apiKey: 'sk-x',
  });
  assert.equal(ok, true);
  assert.equal(record.stepAccuracy, 1);
  assert.ok(dropped.includes('apiKey'));
  assert.equal(record.apiKey, undefined);
  const bad = normaliseRunRecord('not-an-object');
  assert.equal(bad.ok, false);
});

test('normaliseRunRecord rejects retired fields', () => {
  const { ok, record } = normaliseRunRecord({
    ...VALID_RUN,
    optimalityScore: 1,
    accuracyScore: 1,
    checksPassed: 5,
    checksTotal: 5,
  });
  assert.equal(ok, true);
  assert.equal(record.optimalityScore, undefined);
  assert.equal(record.accuracyScore, undefined);
  assert.equal(record.checksPassed, undefined);
  assert.equal(record.checksTotal, undefined);
});

// ---- cap + corrupt lines + restart ----------------------------------------
test('past RUNS_CAP the oldest runs are dropped, the newest 500 kept', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const ids = [];
    for (let i = 0; i < RUNS_CAP + 7; i++) {
      const { status, body } = await postRun(ctx.base, { ...VALID_RUN, steps: i });
      assert.equal(status, 201);
      ids.push(body.id);
    }
    const g = await getRuns(ctx.base);
    assert.equal(g.body.count, RUNS_CAP, 'capped at 500');
    assert.equal(g.body.runs.length, RUNS_CAP);
    assert.equal(g.body.runs[0].id, ids[ids.length - 1], 'newest kept');
    const kept = new Set(g.body.runs.map((r) => r.id));
    assert.equal(kept.has(ids[0]), false, 'oldest dropped');
    assert.equal(kept.has(ids[RUNS_CAP + 6]), true, 'newest present');
    const lines = fs.readFileSync(ctx.runsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, RUNS_CAP);
  } finally {
    await stopServer(ctx);
  }
});

test('a corrupt line is skipped and never breaks the read', async () => {
  const file = scratchFile();
  const ctx = await startServer({ runsFile: file });
  try {
    await postRun(ctx.base, VALID_RUN);
    const good = { ...VALID_RUN, steps: 2 };
    await postRun(ctx.base, good);
    fs.appendFileSync(file, 'this is { not json\n{"also": broken\n');
  } finally {
    await stopServer(ctx);
  }
  const ctx2 = await startServer({ runsFile: file });
  try {
    const g = await getRuns(ctx2.base);
    assert.equal(g.body.count, 2, 'corrupt lines skipped');
    assert.equal(g.body.runs[0].steps, 2);
  } finally {
    await stopServer(ctx2);
  }
});

test('the history survives a server restart (same runs file)', async () => {
  const file = scratchFile();
  const ctx1 = await startServer({ runsFile: file });
  try {
    await postRun(ctx1.base, VALID_RUN);
    await postRun(ctx1.base, { ...VALID_RUN, difficulty: 'hard' });
  } finally {
    await stopServer(ctx1);
  }
  const ctx2 = await startServer({ runsFile: file });
  try {
    const g = await getRuns(ctx2.base);
    assert.equal(g.body.count, 2);
    assert.deepEqual(g.body.runs.map((r) => r.difficulty).sort(), ['hard', 'medium']);
  } finally {
    await stopServer(ctx2);
  }
});

// ---- hardening + play-flow isolation ---------------------------------------
test('/api/runs respects the per-IP rate limit', async () => {
  const ctx = await startServer({ runsFile: scratchFile(), rateLimit: 1 });
  try {
    const first = await postRun(ctx.base, VALID_RUN);
    assert.equal(first.status, 201);
    const second = await getRuns(ctx.base);
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'rate_limited');
  } finally {
    await stopServer(ctx);
  }
});

test('/api/runs respects the body-size cap (typed 413)', async () => {
  const ctx = await startServer({ runsFile: scratchFile(), maxBodyBytes: 700 });
  try {
    const r = await postRun(ctx.base, { ...VALID_RUN, pad: 'x'.repeat(2000) });
    assert.equal(r.status, 413);
    assert.equal(r.body.error.code, 'payload_too_large');
  } finally {
    await stopServer(ctx);
  }
});

test('recording runs does NOT alter the play flow response', async () => {
  const upstream = await startMockUpstream({ status: 200, body: { answers: { move_inward: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } } });
  const ctx = await startServer({ runsFile: scratchFile(), apiKey: 'sk-env-key', upstream: `${upstream.base}/v1/systemone` });
  try {
    const before = await postJev(ctx.base, CH_PAYLOAD);
    assert.equal(before.status, 200);

    for (let i = 0; i < 3; i++) await postRun(ctx.base, { ...VALID_RUN, steps: i + 1 });
    const records = await getRuns(ctx.base);
    assert.equal(records.body.count, 3);

    const after = await postJev(ctx.base, CH_PAYLOAD);
    assert.equal(after.status, 200);
    // _ms is wall-clock noise; everything else in the play response is
    // deterministic and must be byte-identical whether or not runs were recorded.
    const stable = (b) => ({ ...b, _ms: undefined });
    assert.deepEqual(stable(after.body), stable(before.body), 'the jev response is unchanged');
  } finally {
    await stopServer(ctx);
    await upstream.close();
  }
});
test('createServer({}) still serves /api/runs (regression: a partial config left runsFile undefined)', async () => {
  // createServer used to use the caller's object verbatim, so a partial config
  // — createServer({}) or a helper overriding one field — produced a config
  // with no runsFile, and every /api/runs request 500'd. The browser suite and
  // the history page hit exactly this.
  //
  // The scratch file is passed EXPLICITLY: a truly empty {} would fall back to
  // DEFAULTS.runsFile (the repo's real runs.jsonl), which the live server also
  // writes to — that made this test order-dependent and flaky. The "no runsFile
  // -> DEFAULTS fills it in" half is asserted statically below instead.
  const server = createServer({ runsFile: scratchFile() });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await fetch(`${base}/api/health`);
    assert.equal(h.status, 200, 'health still works');

    const g = await fetch(`${base}/api/runs`);
    assert.equal(g.status, 200, 'GET /api/runs must not 500 on a partial config');
    assert.deepEqual(await g.json(), { runs: [], count: 0 });

    const p = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        difficulty: 'easy', mode: 'live', outcome: 'reached',
        steps: 22, rings: 4, sectors: 12, totalMs: 20,
      }),
    });
    assert.equal(p.status, 201, 'POST /api/runs must not 500 on a partial config');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DEFAULTS supplies a runsFile (so createServer({}) cannot leave it undefined)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /runsFile:\s*path\.join\(__dirname,\s*'runs\.jsonl'\)/,
    'DEFAULTS defines runsFile');
  assert.match(src, /const cfg = \{ \.\.\.DEFAULTS, \.\.\.config \}/,
    'createServer merges DEFAULTS into a partial config');
});

test('the build tag is stored, and live-step is an accepted mode', async () => {
  // Both exist for the same reason: the history must be able to say which ask
  // mode ran on which revision. If either were dropped, comparing them would
  // silently compare revisions instead.
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { status, body } = await postRun(ctx.base, {
      ...VALID_RUN, mode: 'live-step', build: '0.4.0',
    });
    assert.equal(status, 201);
    assert.equal(body.build, '0.4.0', 'the build tag survives validation');
    assert.equal(body.mode, 'live-step', 'live-step is a valid mode');
    const bad = await postRun(ctx.base, { ...VALID_RUN, mode: 'live-telepathy' });
    assert.equal(bad.status, 400, 'an invented mode is still rejected');
  } finally {
    await stopServer(ctx);
  }
});

test('confidence: the bands and per-step flags are stored, sanitised', async () => {
  // The signal the run is judged on beside its accuracy. Both arrays are
  // whitelisted by value, so a hand-made POST cannot push arbitrary strings or
  // non-booleans into the history.
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { status, body } = await postRun(ctx.base, {
      ...VALID_RUN,
      confidentSteps: 6, unsureSteps: 2, mediumSteps: 1,
      confidenceBands: ['high', 'low', 'high', 'bogus', 'medium'],
      stepFlags: [true, false, true, 'yes', 1, null, false],
    });
    assert.equal(status, 201);
    assert.equal(body.confidentSteps, 6);
    assert.equal(body.unsureSteps, 2);
    assert.deepEqual(body.confidenceBands, ['high', 'low', 'high', 'medium'],
      'unknown band names are dropped, the rest keep their order');
    assert.deepEqual(body.stepFlags, [true, false, true, false],
      'only booleans survive');
  } finally {
    await stopServer(ctx);
  }
});

test('confidence: counts are clamped, and absent fields stay absent', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { body } = await postRun(ctx.base, { ...VALID_RUN, confidentSteps: -5 });
    assert.equal(body.confidentSteps, 0, 'a negative count clamps to 0');
    const { body: b2 } = await postRun(ctx.base, { ...VALID_RUN });
    assert.equal(b2.confidentSteps, undefined, 'an absent count is not invented');
    assert.equal(b2.confidenceBands, undefined);
  } finally {
    await stopServer(ctx);
  }
});

test('path: the green/red verdicts and counts are stored, sanitised', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { status, body } = await postRun(ctx.base, {
      ...VALID_RUN,
      greenSteps: 7, redSteps: 3, jevProposed: 10, jevCorrect: 8, jevAccuracy: 0.8,
      stepVerdicts: ['green', 'red', 'green', 'bogus', 'green', 'RED', 'red', 'green', 'green', 'green'],
    });
    assert.equal(status, 201);
    assert.equal(body.greenSteps, 7);
    assert.equal(body.redSteps, 3);
    assert.equal(body.jevAccuracy, 0.8);
    assert.deepEqual(body.stepVerdicts, ['green', 'red', 'green', 'green', 'red', 'green', 'green', 'green'],
      'only the two real colours survive, in order');
  } finally {
    await stopServer(ctx);
  }
});

test('path: a verdict count cannot be invented or go negative', async () => {
  const ctx = await startServer({ runsFile: scratchFile() });
  try {
    const { body } = await postRun(ctx.base, { ...VALID_RUN, redSteps: -3 });
    assert.equal(body.redSteps, 0, 'a negative count clamps to 0');
    const { body: b2 } = await postRun(ctx.base, { ...VALID_RUN });
    assert.equal(b2.greenSteps, undefined, 'an absent count is not invented');
    assert.equal(b2.stepVerdicts, undefined);
  } finally {
    await stopServer(ctx);
  }
});
