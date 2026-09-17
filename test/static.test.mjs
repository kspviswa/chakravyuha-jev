// test/static.test.mjs — filesystem-level invariants:
//   1. every src/href in index.html resolves to a real, served asset
//   2. every asset under the client tree parses as an ES module (node --check)
//   3. the game loop stays logic-free: app.js, lib/* (save referee.js) and
//      skins/* carry NO pathfinding implementation, and server.mjs carries
//      no solver at all — there is nothing left to hide behind a stub.
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
  assert.match(html, /<title>Chakravyuha/);
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
  assert.match(referee, /chakraShortest/, 'the polar BFS lives in the referee');
  assert.match(referee, /walkChakra/, 'and so does the walker');

  // app.js, the non-referee libs, the skin and the shim: no pathfinding, not
  // even the identifiers in a comment.
  const loopFiles = [
    path.join(ROOT, 'app.js'),
    path.join(ROOT, 'history.js'),
    path.join(ROOT, 'server.mjs'),
    path.join(ROOT, 'lib', 'transport.js'),
    path.join(ROOT, 'lib', 'jev.js'),
    path.join(ROOT, 'lib', 'chakra.js'),
    path.join(ROOT, 'lib', 'animator.js'),
    path.join(ROOT, 'lib', 'icons.js'),
    path.join(ROOT, 'lib', 'stats.js'),
    path.join(ROOT, 'skins', 'chakravyuha.js'),
  ];
  for (const file of loopFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.doesNotMatch(src, /astar/i, `${rel}: raw source must not mention astar`);
    assert.doesNotMatch(src, /\bbfs\b/i, `${rel}: no bfs, even in comments`);
    assert.doesNotMatch(src, /dijkstra/i, `${rel}: no dijkstra, even in comments`);
    assert.doesNotMatch(src, /priorityqueue|minheap/i, `${rel}: no search data structures`);
  }

  // The loop must never ask the referee for a route: only the skin may import
  // the referee, and only for the post-run verdict.
  for (const file of [path.join(ROOT, 'app.js'), path.join(ROOT, 'history.js')]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /chakraShortest|chakraQuality/, `${path.basename(file)}: no route queries`);
  }
  const skin = fs.readFileSync(path.join(ROOT, 'skins', 'chakravyuha.js'), 'utf8');
  const importLine = skin.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/referee\.js'/);
  assert.ok(importLine, 'the skin imports the referee');
  const names = importLine[1];
  for (const bad of ['chakraShortest', 'chakraQuality', 'polarReachable']) {
    assert.ok(!names.includes(bad), `the skin must not import the solver (${bad})`);
  }
  assert.ok(names.includes('chakraVerdict'), 'it imports only the verdict — verification');
});

test('invariant: server.mjs carries no solver at all — there is no stub to hide one in', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

  // No pathfinding symbols anywhere, in code or comments.
  assert.doesNotMatch(server, /shortestPath|astar|\bbfs\b|dijkstra/i,
    'server.mjs: no pathfinding identifiers at all');
  assert.doesNotMatch(server, /stubAnswer/i, 'the stub solver is gone');
  assert.doesNotMatch(server, /mode === 'stub'/i, 'and so is its branch');

  // A keyless request is refused outright rather than answered locally.
  assert.match(server, /NO_KEY/, 'the shim has a typed no-key error');
  assert.match(server, /Bearer \$\{key\}/, 'live forwards with the resolved key');

  // The only place a maze is interpreted is the payload validator, which checks
  // SHAPE — never a route.
  assert.doesNotMatch(server, /optimalPath|chakraVerdict/, 'the shim never grades a run either');
});

test('docs: no stale PathPuzzle / grid / stub / replay language survives', () => {
  const files = ['README.md', 'docs/API.md', 'docs/METRICS.md', 'package.json', 'index.html', 'history.html'];
  // Prose may legitimately SAY there is no stub ("there is no stub mode") — what
  // must be gone is every stale identifier and every claim that such a mode
  // exists. So match identifiers, not the bare words.
  const stale = [
    /pathpuzzle/i,
    /stubAnswer/,
    /TYPESAFE_REPLAY/,
    /mode:\s*['"](stub|replay)['"]/,
    /['"]stub['"]\s*mode/i,
    /replay\s+mode/i,
    /grid_pathfinding/,
    /skins\/(grid|gmaps|sim)/,
    /lib\/geo/,
    /record-(fixtures|geo-snapshots)/,
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of stale) {
      assert.doesNotMatch(text, re, `${f}: stale pattern ${re}`);
    }
  }
  // and the polar model is actually described
  const api = fs.readFileSync(path.join(ROOT, 'docs', 'API.md'), 'utf8');
  assert.match(api, /chakravyuha_policy/, 'the policy task id is documented');
  assert.match(api, /no_key/, 'the keyless refusal is documented');
  assert.match(api, /open_radial/, 'the polar state is documented');
  assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'METRICS.md'), 'utf8'), /sample/i,
    'the metric definitions state the sample (n-1) convention');
});

test('package.json: renamed to chakravyuha and the deleted scripts are gone', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'chakravyuha', 'the package is renamed');
  assert.match(pkg.description, /chakravyuha/i);
  assert.match(pkg.description, /no pathfinding|Jev/i);
  assert.ok(!pkg.dependencies && !pkg.devDependencies, 'zero runtime dependencies (spec §0)');
  for (const gone of ['fixtures', 'geo-fixtures']) {
    assert.equal(pkg.scripts[gone], undefined, `the ${gone} script is deleted`);
  }
  assert.ok(pkg.scripts.test && pkg.scripts.start, 'test and start remain');
  assert.equal(pkg.engines.node, '>=20', 'Node ≥ 20');
});

test('LICENSES: the vendored Lucide set is credited with its ISC text', () => {
  const lic = fs.readFileSync(path.join(ROOT, 'LICENSES.md'), 'utf8');
  assert.match(lic, /Lucide/i);
  assert.match(lic, /ISC/);
  assert.match(lic, /1\.47\.0/);
  assert.match(lic, /Permission to use, copy, modify/, 'the full licence text is present');
});

test('deleted: the old skins, geo code and fixture machinery are gone', () => {
  for (const gone of [
    'skins/grid.js', 'skins/gmaps.js', 'skins/sim.js', 'lib/geo.js', 'lib/board.js',
    'fixtures/index.json', 'scripts/record-fixtures.mjs', 'scripts/record-geo-snapshots.mjs',
    'test/geo.test.mjs', 'test/board.test.mjs', 'test/referee.test.mjs', 'test/jev.test.mjs',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} must be deleted (spec §2)`);
  }
  // exactly one skin, and it is the chakravyuha
  const skins = fs.readdirSync(path.join(ROOT, 'skins')).filter((f) => f.endsWith('.js'));
  assert.deepEqual(skins, ['chakravyuha.js'], 'one skin remains');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'abhimanyu.jpg')), 'the artwork is kept');
});

test('server: the geo route and the whole geo/Overpass surface are gone', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  for (const gone of ['/api/geo', 'overpass', 'Overpass', 'geoJson', 'geojson', 'osm']) {
    assert.ok(!server.includes(gone), `server.mjs must not mention ${gone}`);
  }
});

test('docs: the README documents BYOK, the CORS finding, the shim and the chakravyuha', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /BYOK/i);
  assert.match(readme, /CORS|Access-Control-Allow-Origin/i);
  assert.match(readme, /proxy|shim/i);
  assert.match(readme, /chakravyuha/i);
  assert.match(readme, /Lucide/i, 'the vendored icon set is credited');
  assert.match(readme, /referee/i, 'and the verification-only referee is explained');
});

test('client: every run record carries mode:live (regression — policy runs were silently rejected)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const body = app.split('function buildRunRecord')[1].split('function recordRun')[0];

  // The app is LIVE-only now, so the record hardcodes the live mode. It must
  // still emit it: without a mode the server rejects the whole record, and
  // because recording is fire-and-forget, nothing is stored and nothing
  // complains — exactly the silent loss this test was written for.
  assert.match(app, /const runMode = 'live'/, 'buildRunRecord pins the mode to live');
  assert.match(body, /^\s*mode: runMode,/m, 'the record emits the mode');
  assert.ok(!/^\s*mode,\s*$/m.test(body), 'the record never emits a bare, possibly-undefined mode');
  assert.ok(!/currentMode\(\)/.test(body), 'the mode no longer depends on a UI toggle');

  // and the server must still require it, or the guard above proves nothing
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(server, /needEnum\(src, 'mode', RUN_MODES\)/, "the server requires 'mode'");
  assert.match(server, /RUN_MODES = \['live'\]/, 'and the only accepted mode is live');
});
