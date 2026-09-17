// scripts/record-fixtures.mjs — (re)generate the committed REPLAY fixtures.
//
// Deterministic by construction: seeded random boards, stub answers only,
// no network, no API key. The fixtures are exact recordings of what a client
// receives from `POST /api/jev` in STUB mode, wrapped in a small envelope so
// the request that produced them is archived too.
//
//   node scripts/record-fixtures.mjs
//
// Re-importability: `buildState`/`buildQuestions` below mirror the builders
// in public/app.js (minus the optional per-cell heatmap questions). If they
// drift, rerun this script — REPLAY fixtures are recordings, so any version
// stays self-consistent with the request it stored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { createServer } = await import('../server.mjs');
  const { boardQuality } = await import('../public/referee.js');

  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  // Deterministic PRNG so runs are reproducible; each difficulty has a pool
  // of seeds and we keep the first board that passes the quality filter.
  function mulberry32(a) {
    return function next() {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeBoard({ R, C, density, seed }) {
    const rand = mulberry32(seed);
    for (let attempt = 0; attempt < 500; attempt++) {
      const rows = Array.from({ length: R }, () => new Array(C).fill('.'));
      for (let r = 0; r < R; r++)
        for (let c = 0; c < C; c++)
          if (rand() < density) rows[r][c] = '#';
      const src = { r: 0, c: 0 };
      const dst = { r: R - 1, c: C - 1 };
      rows[src.r][src.c] = 'S';
      rows[dst.r][dst.c] = 'D';
      const b = { R, C, rows, src, dst };
      const quality = boardQuality(b);
      if (quality.solvable && quality.minimumMoves >= Math.max(4, Math.round((R + C) * 0.5))) {
        return { board: b, quality, seed };
      }
    }
    throw new Error('could not produce a qualifying board');
  }

  function buildState(b) {
    return {
      task: 'grid_pathfinding',
      grid: b.rows.map((row) => row.join('')),
      legend: { S: 'source', D: 'destination', '#': 'wall (impassable)', '.': 'open cell' },
      source: { row: b.src.r, col: b.src.c },
      destination: { row: b.dst.r, col: b.dst.c },
      rules: 'Grid coordinates are (row, col), 0-indexed, row 0 at the top. Moves are 4-directional. Diagonals are not allowed. Walls cannot be entered.',
      objective: 'Find the shortest path from S to D, expressed as an ordered list of single-cell moves.',
    };
  }

  const DIR_OPTIONS = {
    up: 'move one cell up',
    down: 'move one cell down',
    left: 'move one cell left',
    right: 'move one cell right',
    stop: 'the path has no more moves (you have already reached D)',
  };

  function buildQuestions(b) {
    const K = Math.min(b.R * b.C, 64);
    const q = {
      reachable: {
        type: 'noul',
        instructions: 'Is the destination D reachable from the source S without entering any wall?',
        criteria: { true: 'a path from S to D exists', false: 'no path from S to D exists' },
      },
      path_length: {
        type: 'choice',
        instructions: 'How many single-cell moves does the shortest path from S to D take?',
        criteria: { '1-5': null, '6-10': null, '11-15': null, '16-20': null, '21-30': null, '31-50': null, '51+': null },
      },
      maze_difficulty: {
        type: 'score',
        instructions: 'How hard is this maze to solve by eye?',
        criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
      },
    };
    for (let k = 1; k <= K; k++) {
      q[`move_${k}`] = {
        type: 'choice',
        instructions:
          `Consider the shortest path from S to D on the grid in state.grid. ` +
          `Movement is 4-directional (up, down, left, right), diagonals are not allowed, and walls (#) cannot be entered. ` +
          `What is the direction of move number ${k} along that shortest path? ` +
          `Answer "stop" if the shortest path contains fewer than ${k} moves.`,
        criteria: DIR_OPTIONS,
      };
    }
    return q;
  }

  const SERVER_PORT = 0;
  const server = createServer({ port: SERVER_PORT, rateLimit: 10_000 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SERVER_PORT, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const definitions = [
    { name: 'easy', R: 8, C: 8, density: 0.14, seed: 20240101, label: 'Easy · 8×8' },
    { name: 'hard', R: 16, C: 16, density: 0.26, seed: 20250101, label: 'Hard · 16×16' },
  ];

  const manifest = { _note: 'Committed REPLAY fixtures. Each entry maps a demo name to its recorded stub response; ' };

  for (const def of definitions) {
    const { board, quality } = makeBoard(def);
    const payload = { state: buildState(board), questions: buildQuestions(board) };

    const r = await fetch(`${base}/api/jev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`recording ${def.name} failed: HTTP ${r.status}`);
    const response = await r.json();
    if (response.mode !== 'stub') throw new Error(`expected stub mode, got ${response.mode}`);

    const { requestHash } = await import('../server.mjs');
    const hash = requestHash(payload);

    const envelope = {
      kind: 'stub',
      mode: 'stub',
      model: response.model,
      hash,
      request: payload,
      response,
      board: { R: def.R, C: def.C, density: def.density, seed: def.seed, minimumMoves: quality.minimumMoves },
    };

    const file = path.join(fixturesDir, `${hash}.json`);
    fs.writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n');

    manifest[def.name] = {
      hash,
      label: def.label,
      shape: [def.R, def.C],
      kind: 'stub',
      file: `fixtures/${hash}.json`,
      minimumMoves: quality.minimumMoves,
      questions: Object.keys(payload.questions).length,
    };
    console.log(`${def.name}: ${def.R}×${def.C} minMoves=${quality.minimumMoves} hash=${hash.slice(0, 12)} → ${path.basename(file)}`);
  }

  fs.writeFileSync(path.join(fixturesDir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  console.log('fixtures written.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });