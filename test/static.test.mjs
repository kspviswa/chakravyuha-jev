// test/static.test.mjs — filesystem-level invariants:
//   1. every src/href in index.html resolves to a real, served asset
//   2. every asset under the client tree parses as an ES module (node --check)
//   3. the game loop stays logic-free: app.js, lib/* (save referee.js) and
//      skins/* carry NO pathfinding implementation; server.mjs keeps its
//      offline stub solver confined to stubAnswer().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// The files the server actually allowlists as static (mirrors server.mjs).
const CLIENT_FILES = ['index.html', 'app.js', 'history.html', 'history.js', 'style.css'];
const CLIENT_DIRS = ['lib', 'skins'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const clientTree = () => [
  ...CLIENT_FILES.map((f) => path.join(ROOT, f)),
  ...CLIENT_DIRS.flatMap((d) => walk(path.join(ROOT, d))),
];

// ---- 1. static asset sanity -------------------------------------------------
test('every src/href referenced by index.html resolves to a served asset', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, 'index.html references at least its css + app.js');

  const localRefs = refs.filter((r) => !(r.startsWith('#') || /^(https?:|data:|mailto:|about:)/i.test(r)));
  for (const ref of localRefs) {
    const resolved = path.resolve(path.join(ROOT, ref));
    const rel = path.relative(ROOT, resolved);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `ref escapes the client tree: ${ref}`);
    assert.ok(fs.existsSync(resolved), `missing asset referenced by index.html: ${ref}`);
  }

  // the module graph: app.js imports lib/* and skins/*; skins import lib/*;
  // history.js imports lib/* (stats, transport)
  const modules = [
    path.join(ROOT, 'app.js'),
    path.join(ROOT, 'history.js'),
    ...CLIENT_DIRS.flatMap((d) => walk(path.join(ROOT, d)).filter((f) => f.endsWith('.js'))),
  ];
  for (const file of modules) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      assert.ok(fs.existsSync(target), `module import missing in ${path.relative(ROOT, file)}: ${m[1]}`);
    }
  }
});

// ---- 2. syntax parse ----------------------------------------------------------
test('every client .js parses as an ES module (node --check)', () => {
  const files = clientTree().filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 7, `expected app.js + lib/* + skins/* + history.js (got ${files.length})`);
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(ROOT, file)} failed to parse:\n${r.stderr}`);
  }
  const server = spawnSync(process.execPath, ['--check', path.join(ROOT, 'server.mjs')], { encoding: 'utf8' });
  assert.equal(server.status, 0, `server.mjs failed to parse:\n${server.stderr}`);
});

test('history.html references only served assets and links back to the play page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');
  assert.match(html, /<title>PathPuzzle/);
  assert.match(html, /src=["']\.\/history\.js["']/, 'history.html loads history.js');
  assert.match(html, /href=["']\.\/style\.css["']/, 'history.html shares style.css');
  assert.match(html, /href=["']\.\/index\.html["']/, 'history.html links back to the play page');
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const localRefs = refs.filter((r) => !(r.startsWith('#') || /^(https?:|data:|mailto:|about:)/i.test(r)));
  for (const ref of localRefs) {
    const resolved = path.resolve(path.join(ROOT, ref));
    const rel = path.relative(ROOT, resolved);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `ref escapes the client tree: ${ref}`);
    assert.ok(fs.existsSync(resolved), `missing asset referenced by history.html: ${ref}`);
  }
});

test('index.html links to the history page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /history\.html/, 'the play page links to history.html');
});

// ---- 3. no pathfinding in the game loop ---------------------------------------
function stripLiterals(src) {
  let out = '';
  const n = src.length;
  const blank = (len) => { out += ' '.repeat(len); };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { blank(1); i++; }
      if (i < n) { out += '\n'; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      blank(2); i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) { blank(1); i++; }
      blank(2); i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; blank(1); i++;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { blank(2); i += 2; continue; }
        if (ch === q) { blank(1); i++; break; }
        blank(1); i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function commentRanges(src) {
  const ranges = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      ranges.push([start, i]);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      ranges.push([start, i]);
      continue;
    }
    i++;
  }
  return ranges;
}

function matchingBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const inRange = (idx, [a, b]) => idx >= a && idx <= b;

test('invariant: the browser game loop carries no pathfinding implementation', () => {
  // referee.js is the designated home of the algorithms.
  const referee = fs.readFileSync(path.join(ROOT, 'lib', 'referee.js'), 'utf8');
  assert.match(referee, /shortestPathLength/);
  assert.match(referee, /shortestCost/);

  // app.js, lib/* (except referee.js) and skins/*: no pathfinding, not even
  // the identifiers in a comment.
  const loopFiles = [
    path.join(ROOT, 'app.js'),
    path.join(ROOT, 'lib', 'transport.js'),
    path.join(ROOT, 'lib', 'jev.js'),
    path.join(ROOT, 'lib', 'board.js'),
    path.join(ROOT, 'skins', 'grid.js'),
    path.join(ROOT, 'skins', 'gmaps.js'),
  ];
  for (const file of loopFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.doesNotMatch(src, /shortestPath/i, `${rel}: raw source must not mention shortestPath`);
    assert.doesNotMatch(src, /astar/i, `${rel}: raw source must not mention astar`);
    assert.doesNotMatch(src, /\bbfs\b/i, `${rel}: no bfs, even in comments`);
    assert.doesNotMatch(src, /dijkstra/i, `${rel}: no dijkstra, even in comments`);
  }

  // skins may use the referee's verification helpers to DRAW the returned
  // route (never to choose it) — assert that is the only referee import.
  for (const file of [path.join(ROOT, 'skins', 'grid.js'), path.join(ROOT, 'skins', 'gmaps.js')]) {
    const src = fs.readFileSync(file, 'utf8');
    const importLine = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/referee\.js'/);
    assert.ok(importLine, `${file}: only imports recognised from the referee`);
    const names = importLine[1];
    for (const bad of ['shortestPath', 'shortestCost', 'boardQuality']) {
      assert.ok(!names.includes(bad), `${file}: must not import the solver itself (${bad})`);
    }
  }
});

test('invariant: server.mjs keeps the stub solver confined to stubAnswer()', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  // In code (strings/comments stripped), no pathfinding symbols anywhere.
  assert.doesNotMatch(stripLiterals(server), /shortestPath|astar|\bbfs\b|dijkstra/i,
    'server.mjs: no pathfinding identifiers outside strings/comments');

  const comments = commentRanges(server);
  const defIdx = server.indexOf('function stubAnswer');

  // exactly one non-comment call site, and it lives inside a stub branch
  const callSites = [...server.matchAll(/stubAnswer\(/g)]
    .map((m) => m.index)
    .filter((idx) => !inRange(idx, [defIdx, defIdx + 40]) && !comments.some((c) => inRange(idx, c)));
  assert.equal(callSites.length, 1, 'exactly one stubAnswer call site (outside its definition)');

  const guards = [...server.matchAll(/mode === 'stub'/g)];
  assert.ok(guards.length >= 1, 'a stub-mode branch exists');
  const openBrace = server.indexOf('{', guards[0].index + guards[0][0].length);
  const closeBrace = matchingBrace(server, openBrace);
  assert.ok(openBrace !== -1 && closeBrace !== -1, 'stub branch is brace-matched');
  assert.ok(inRange(callSites[0], [openBrace, closeBrace]), 'stubAnswer is only reachable in stub mode');

  // every bfs/dijkstra token is either inside stubAnswer's body or a comment
  const bodyOpen = server.indexOf('{', defIdx + 'function stubAnswer'.length);
  const bodyClose = matchingBrace(server, bodyOpen);
  for (const re of [/\bbfs\b/gi, /dijkstra/gi]) {
    for (const m of server.matchAll(re)) {
      const ok = inRange(m.index, [bodyOpen, bodyClose]) || comments.some((c) => inRange(m.index, c));
      assert.ok(ok, `pathfinding token at index ${m.index} must live in stubAnswer() or a comment`);
    }
  }

  // the live branch exists and never calls the stub
  assert.match(server, /Bearer \$\{key\}/, 'live forwards with the resolved key');
});

test('docs: the README documents the stub, the CORS finding, and the shim', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /BFS|stub/i);
  assert.match(readme, /CORS|Access-Control-Allow-Origin/i);
  assert.match(readme, /proxy|shim/i);
});
test('client: every run record carries a mode (regression — policy runs were silently rejected)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  // buildRunRecord must default the mode to the UI's current mode, because the
  // policy-mode call sites pass { game, v, body } and no mode. Without the
  // fallback the server rejected every policy run with "field 'mode' must be a
  // string" and, because recording is fire-and-forget, nothing was recorded and
  // nothing complained.
  assert.match(app, /const runMode = mode \|\| currentMode\(\)/,
    'buildRunRecord defaults mode to currentMode()');
  assert.match(app, /^\s*mode: runMode,/m,
    'the record uses the defaulted mode, not the raw argument');
  assert.ok(!/^\s*mode,\s*$/m.test(app.split('function buildRunRecord')[1].split('function recordRun')[0]),
    'the record must not emit the raw (possibly undefined) mode');

  // the policy call sites really do omit mode — if that changes, revisit the guard
  const policyCalls = [...app.matchAll(/recordRun\(\{\s*game,[^}]*\}\)/g)];
  assert.ok(policyCalls.length >= 1, 'policy-mode recordRun call sites exist');
  for (const c of policyCalls) {
    assert.ok(!/mode:/.test(c[0]), 'policy call sites omit mode (hence the fallback)');
  }

  // and the server must still require it, or the guard above proves nothing
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(server, /needEnum\(src, 'mode', RUN_MODES\)/, "the server requires 'mode'");
});
