// test/static.test.mjs — filesystem-level invariants:
//   1. every src/href in index.html resolves to a real, served asset
//   2. every asset under the client tree parses as an ES module (node --check)
//   3. the game loop stays logic-free: app.js, lib/* and skins/* carry NO
//      search implementation, and server.mjs carries no solver at all.
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
const CLIENT_DIRS = ['lib', 'skins', 'assets'];

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

// ---- 2. syntax parse ---------------------------------------------------------
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

// ---- 3. no search in the game loop ---------------------------------------
test('invariant: lib/jev.js must not reference shortest', () => {
  const jev = fs.readFileSync(path.join(ROOT, 'lib', 'jev.js'), 'utf8');
  assert.doesNotMatch(jev, /\bshortest\b/, 'lib/jev.js must not reference shortest');
});

test('invariant: no referee token anywhere in the repo', () => {
  const files = ['README.md', 'package.json', 'docs/API.md', 'docs/METRICS.md', 'index.html', 'app.js', 'history.js', 'style.css', 'server.mjs', 'lib/chakra.js', 'lib/jev.js', 'lib/animator.js', 'lib/icons.js', 'lib/stats.js', 'lib/transport.js', 'skins/chakravyuha.js', 'history.html'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\breferee\b/i, `${f}: no "referee" token`);
  }
  // Also check lib/ directory (excluding any README)
  for (const f of walk(path.join(ROOT, 'lib'))) {
    if (f.endsWith('.js')) {
      const src = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(src, /\breferee\b/i, `${path.relative(ROOT, f)}: no "referee" token`);
    }
  }
});

test('invariant: no plan mode strings in the client', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(app, /MODE_STORAGE|currentMode|chakraPlanState|chakraPlanQuestions|askPlan/, 'no plan mode in app.js');
  assert.doesNotMatch(index, /mode-btn|mode: plan|mode: policy/, 'no mode buttons in index.html');
});

test('invariant: no old referee function names anywhere', () => {
  const names = ['chakraNeighbours', 'chakraShortest', 'chakraVerdict', 'chakraQuality', 'polarReachable', 'walkChakra'];
  const files = [...clientTree(), path.join(ROOT, 'server.mjs')];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const n of names) {
      assert.doesNotMatch(src, new RegExp(n, 'i'), `${path.relative(ROOT, file)}: no ${n}`);
    }
  }
});

// ---- 4. server.mjs has no solver ----------------------------------------
test('invariant: server.mjs carries no solver at all', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.doesNotMatch(server, /shortestPath|astar|\bbfs\b|dijkstra/i,
    'server.mjs: no pathfinding identifiers at all');
  assert.doesNotMatch(server, /stubAnswer/i, 'the stub solver is gone');
  assert.doesNotMatch(server, /mode === 'stub'/i, 'and so is its branch');
  assert.match(server, /NO_KEY/, 'the shim has a typed no-key error');
  assert.doesNotMatch(server, /optimalPath|chakraVerdict/, 'the shim never grades a run either');
});

// ---- 5. package.json -------------------------------------------------------
test('package.json: version 0.3.0 and no referee in description', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.3.0', 'version is 0.3.0');
  assert.ok(!pkg.description.includes('referee'), 'no referee in description');
  assert.ok(!pkg.dependencies && !pkg.devDependencies, 'zero runtime dependencies (spec §0)');
  for (const gone of ['fixtures', 'geo-fixtures']) {
    assert.equal(pkg.scripts[gone], undefined, `the ${gone} script is deleted`);
  }
  assert.ok(pkg.scripts.test && pkg.scripts.start, 'test and start remain');
  assert.equal(pkg.engines.node, '>=20', 'Node ≥ 20');
});

// ---- 6. deleted files ------------------------------------------------------
test('deleted: the old test files are gone', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'test/referee-chakra.test.mjs')), 'referee-chakra.test.mjs is gone');
});

test('deleted: no old skins, geo code or fixture machinery', () => {
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
});

test('server: the geo route and the whole geo/Overpass surface are gone', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  for (const gone of ['/api/geo', 'overpass', 'Overpass', 'geoJson', 'geojson', 'osm']) {
    assert.ok(!server.includes(gone), `server.mjs must not mention ${gone}`);
  }
});

test('invariant: every persisted control is written AND read by the same key', () => {
  // A loader that reads a key nothing writes is dead code that silently resets
  // the control on every reload. Both halves must exist.
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const skin = fs.readFileSync(path.join(ROOT, 'skins', 'chakravyuha.js'), 'utf8');
  for (const [key, constName] of [['jev.instant', 'INSTANT_STORAGE'], ['jev.obstacles', 'OBSTACLE_STORAGE']]) {
    assert.ok(app.includes(`storage.getItem(${constName})`), `app.js must read ${key} via ${constName}`);
    assert.ok(skin.includes(`localStorage.setItem('${key}'`), `the skin must WRITE ${key} — otherwise the loader is dead`);
  }
});
