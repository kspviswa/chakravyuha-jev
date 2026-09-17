// test/static.test.mjs — filesystem-level invariants:
//   1. every src/href in index.html resolves to a real file under public/
//   2. every .js under public/ parses as an ES module (node --check)
//   3. the game loop stays logic-free: no pathfinding symbols in public/app.js
//      and none in server.mjs outside the documented, confined stub BFS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---- 1. static asset sanity -------------------------------------------------
test('every src/href referenced by index.html resolves under public/', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, 'index.html references at least its css + app.js');

  const localRefs = refs.filter((r) => {
    if (r.startsWith('#') || /^(https?:|data:|mailto:|about:)/i.test(r)) return false;
    return true;
  });

  for (const ref of localRefs) {
    const resolved = path.resolve(path.join(PUBLIC, ref));
    const rel = path.relative(PUBLIC, resolved);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `ref escapes public/: ${ref}`);
    assert.ok(fs.existsSync(resolved), `missing asset referenced by index.html: ${ref}`);
  }

  // the module graph too: app.js imports ./referee.js
  const appSrc = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  for (const m of appSrc.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const file = path.join(PUBLIC, m[1]);
    assert.ok(fs.existsSync(file), `module import missing: ${m[1]}`);
  }
});

// ---- 2. syntax parse ----------------------------------------------------------
test('every .js under public/ parses as an ES module (node --check)', () => {
  const files = walk(PUBLIC).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 2, 'expected at least app.js and referee.js');
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.basename(file)} failed to parse:\n${r.stderr}`);
  }
});

// ---- 3. no pathfinding in the game loop ---------------------------------------
// Blank out string/template/comment content so the remaining code is inspectable.
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

test('invariant: app.js and server.mjs carry no pathfinding implementation', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const refr = fs.readFileSync(path.join(PUBLIC, 'referee.js'), 'utf8');

  // referee.js is the designated home of the algorithm.
  assert.match(refr, /shortestPathLength/);

  const appStrip = stripLiterals(app);
  const serverStrip = stripLiterals(server);

  for (const [file, src] of [['public/app.js', app], ['server.mjs', server]]) {
    assert.doesNotMatch(src, /shortestPath/i, `${file}: raw source must not even mention shortestPath`);
    assert.doesNotMatch(src, /astar/i, `${file}: raw source must not mention astar`);
  }

  // app.js: the game loop must be free of every pathfinding symbol, comments too.
  assert.doesNotMatch(appStrip, /shortestPath|astar|\bbfs\b/i, 'app.js: no pathfinding code may live in the game loop');
  assert.doesNotMatch(app, /localhost|\bbfs\b|\bastar\b/i, 'app.js: no bfs/astar even in comments');

  // server.mjs: in code (strings/comments stripped), no pathfinding symbols at all.
  assert.doesNotMatch(serverStrip, /shortestPath|astar|\bbfs\b/i, 'server.mjs: no pathfinding identifiers outside comments');

  // Confinement rule 1: every real mention of the stub (comments allowed) is
  // either the function definition or a call inside the `mode === 'stub'` branch.
  const comments = commentRanges(server);
  const fnIdx = server.indexOf('function stubAnswer');
  const defIdx = fnIdx === -1 ? -1 : fnIdx + 'function '.length;
  const stubCall = [...server.matchAll(/stubAnswer/g)].map((m) => m.index);
  assert.ok(stubCall.length >= 2, 'stubAnswer is defined and called at least once');
  console.log(`server.mjs: ${stubCall.length} reference(s) to stubAnswer`);

  for (const idx of stubCall) {
    if (idx === defIdx) continue; // the definition itself
    if (comments.some((c) => inRange(idx, c))) continue; // docs, not a call

    const guards = [...server.matchAll(/if\s*\(\s*mode === 'stub'\s*\)/g)];
    assert.ok(guards.length >= 1, 'a `mode === \'stub\'` branch exists');
    const insideStubBranch = guards.some((g) => {
      const bodyStartRel = server.indexOf('{', g.index + g[0].length);
      if (bodyStartRel === -1) return false;
      const close = matchingBrace(server, bodyStartRel);
      if (close === -1) return false;
      return inRange(idx, [bodyStartRel, close]);
    });
    assert.ok(insideStubBranch, `stubAnswer call site (index ${idx}) is only reachable in stub mode`);
  }

  // Confinement rule 2: any bfs mention in raw server.mjs is either inside the
  // stubAnswer function body or in a comment (i.e. never in live-branch code).
  const stubDefOpen = server.indexOf('function stubAnswer') + 'function stubAnswer'.length;
  const stubBodyIndex = server.indexOf('{', stubDefOpen);
  const stubBodyEnd = matchingBrace(server, stubBodyIndex);
  for (const m of server.matchAll(/\bbfs\b/gi)) {
    const ok = inRange(m.index, [stubBodyIndex, stubBodyEnd])
      || comments.some((c) => inRange(m.index, c));
    assert.ok(ok, `bfs token at index ${m.index} is neither in the stub function nor a comment`);
  }

  // Confinement rule 3: the live branch exists and is mutually exclusive.
  assert.match(server, /if\s*\(\s*mode === 'live'\s*\)/);
  assert.match(server, /if\s*\(\s*mode === 'replay'\s*\)/);
  const callSites = [...server.matchAll(/stubAnswer\(/g)]
    .map((m) => m.index)
    .filter((idx) => idx !== defIdx && !comments.some((c) => inRange(idx, c)));
  assert.equal(callSites.length, 1, 'exactly one stubAnswer call site');
  assert.ok(callSites[0] > server.indexOf('if (mode === '), 'stub runs after mode resolution');
});

test('docs: the README documents the stub BFS exception in server.mjs', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /BFS/i);
  assert.match(readme, /stub/i);
});