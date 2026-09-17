// test/autoask.test.mjs — the "do not solve on load" regression, at source level.
//
// We already shipped this bug once on this repo: the navigation skin called
// autoAsk() from its mount, so the page silently solved the maze before the user
// had pressed anything. Opening the page, changing difficulty, or drawing a new
// maze must NEVER send a request to Jev and never draw a route. Solving is only
// ever an explicit press of "Ask Jev".
//
// The end-to-end proof (a real browser, three viewports, with a mock upstream)
// lives in scripts/verify-browser.mjs, which asserts the same thing against the
// live DOM. This file is the fast, deterministic guard that runs on every
// `npm test`: it pins the *structure* that makes auto-solving impossible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The body of a named function/method, by brace matching from its opening `{`. */
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at !== -1, `could not find ${signature}`);
  const sigEnd = at + signature.length;
  // When the signature already ends with the opening brace, start there — not
  // at the next '{', which may live inside a template literal in the body.
  const open = signature.includes('{')
    ? src.lastIndexOf('{', sigEnd - 1)
    : src.indexOf('{', sigEnd);
  assert.ok(open !== -1 && open >= at, `no body after ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/** Comments out of the way, so prose about `ask` cannot trip a code check. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---- the shell -------------------------------------------------------------
test('boot: the page never asks Jev while it is loading', () => {
  const app = read('app.js');
  // Everything from the first listener registration to the end of the file is
  // the boot sequence.
  const boot = app.slice(app.indexOf("$('ask').addEventListener('click', ask);"));
  assert.ok(boot.length > 100, 'found the boot block');
  for (const banned of ['ask(', 'askPolicy(', 'askPlan(', 'runPolicyGame(']) {
    assert.ok(!boot.includes(banned), `the boot sequence must not call ${banned}`);
  }
  // It may read health, but it must not post a maze anywhere.
  const posts = [...boot.matchAll(/fetch\([^)]*api\/jev/g)];
  assert.equal(posts.length, 0, 'boot must not POST to /api/jev');
});

test('boot: the only entry point into a run is the Ask button', () => {
  const app = read('app.js');
  // `ask` is *defined* once and *referenced* (not invoked) once, by the button
  // binding. Nothing else may start a run.
  const defs = [...app.matchAll(/(?:async\s+)?function\s+ask\s*\(/g)];
  assert.equal(defs.length, 1, `ask must be defined exactly once, found ${defs.length}`);
  const invocations = [...app.matchAll(/(?<![\w.$])ask\s*\(\s*\)/g)]
    .filter((m) => !/function\s+$/.test(app.slice(0, m.index)));
  assert.equal(invocations.length, 0, 'ask() is never invoked directly — only via the click binding');
  assert.match(app, /\$\('ask'\)\.addEventListener\('click',\s*ask\)/,
    'the Ask button is the single entry point, by function reference');
});

test('difficulty: switching level redraws the maze and asks nothing', () => {
  const skin = read('skins/chakravyuha.js');
  const handler = bodyOf(skin, "wrap.querySelector('#diff-bar').addEventListener('click'");
  const code = stripComments(handler);
  assert.ok(code.includes('setDifficulty'), 'it changes the difficulty');
  assert.ok(code.includes('newBoard'), 'and draws a fresh maze');
  for (const banned of ['ask', 'animateHop', 'animator.play', 'check(']) {
    assert.ok(!code.includes(banned), `the difficulty handler must not ${banned}`);
  }
});

test('redraw: "New maze" draws silently — no request, no route', () => {
  const skin = read('skins/chakravyuha.js');
  const handler = bodyOf(skin, "wrap.querySelector('#maze-new').addEventListener('click'");
  const code = stripComments(handler);
  assert.ok(code.includes('newBoard'), 'it draws a fresh maze');
  for (const banned of ['ask', 'animateHop', 'animator.play', 'check(']) {
    assert.ok(!code.includes(banned), `the redraw handler must not ${banned}`);
  }
  assert.ok(/does NOT ask Jev/i.test(handler), 'the intent is documented in place');
});

test('newBoard/begin: resetting the board never solves anything', () => {
  const skin = read('skins/chakravyuha.js');
  for (const sig of ['newBoard() {', 'begin() {']) {
    const body = stripComments(bodyOf(skin, sig));
    for (const banned of ['ask', 'chakraVerdict', 'animator.play', 'animateHop']) {
      assert.ok(!body.includes(banned), `${sig} must not call ${banned}`);
    }
    assert.ok(body.includes('this.verdict = null'), `${sig} clears the verdict`);
    assert.ok(body.includes('src.ring'), `${sig} puts the sprite back on the outer ring`);
  }
});

test('mount: the skin wires listeners and draws, but never calls out', () => {
  const skin = read('skins/chakravyuha.js');
  const body = stripComments(bodyOf(skin, 'mount({ container }) {'));
  for (const banned of ['fetch(', 'ask', 'chakraVerdict']) {
    assert.ok(!body.includes(banned), `mount() must not ${banned}`);
  }
  assert.ok(body.includes('newBoard()'), 'it does draw the initial maze');
});

// ---- the verdict is only produced after a run -----------------------------
test('check() is always called after a Jev response, never on boot', () => {
  const app = read('app.js');
  const checks = [...app.matchAll(/currentSkin\.check\(/g)];
  assert.ok(checks.length >= 1, 'the shell grades runs');
  for (const m of checks) {
    const before = app.slice(0, m.index);
    const lastAsk = Math.max(before.lastIndexOf('await askPolicy('), before.lastIndexOf('await askJev('));
    assert.ok(lastAsk !== -1, 'a check is always preceded by a Jev call in the same function');
  }
});

// ---- the skin cannot even reach a solver ----------------------------------
test('the skin has no solver to call on load, even by accident', () => {
  const skin = read('skins/chakravyuha.js');
  assert.ok(!skin.match(/import\s*\{[^}]*\}\s*from\s*'\.\.\/lib\/referee\.js'/), 'the skin has no referee import');
  assert.doesNotMatch(skin, /\bchakraVerdict\b/, 'the skin does not reference the verdict');
  assert.doesNotMatch(skin, /\bchakraShortest\b/, 'the skin never computes a route up front');
  assert.doesNotMatch(skin, /\breferee\b/i, 'and never mentions the referee by name');
});


