// test/icons.test.mjs — the vendored Lucide geometry.
//
// The regression this guards: `Path2D` accepts SVG *path data* (a `d` attribute),
// NOT an XML element. Lucide markup mixes <path> and <circle>, and an earlier
// version handed the raw markup straight to Path2D — so every <path>-based icon
// (crown, sparkles, swords) silently drew nothing while the arc-based target
// worked. Only the browser pixel probe caught it; this test catches it in Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ICONS, LUCIDE_VERSION, LUCIDE_LICENCE, iconSvg, pathDataOf, drawLucide,
} from '../lib/icons.js';

const NAMES = ['target', 'user', 'crown', 'sparkles', 'swords'];

test('the vendored set is credited and complete', () => {
  assert.equal(LUCIDE_VERSION, '1.47.0');
  assert.equal(LUCIDE_LICENCE, 'ISC', 'Lucide is ISC — the README must match');
  for (const n of NAMES) assert.ok(ICONS[n], `${n} is vendored`);
  assert.deepEqual(Object.keys(ICONS).sort(), [...NAMES].sort(), 'no stray icons');
});

test('pathDataOf: returns raw path commands, never XML markup', () => {
  for (const n of NAMES) {
    const d = pathDataOf(n);
    assert.ok(d.length > 0, `${n} has path data`);
    assert.doesNotMatch(d, /[<>]/, `${n}: no XML tags — Path2D cannot parse them`);
    assert.doesNotMatch(d, /d\s*=/, `${n}: no attribute syntax`);
    assert.doesNotMatch(d, /\bpath\b|\bcircle\b/i, `${n}: no element names`);
    assert.match(d, /^\s*[Mm]/, `${n}: begins with a move command`);
    // every command letter must be a real SVG path command
    const cmds = d.match(/[A-Za-z]/g).join('');
    assert.match(cmds, /^[MmLlHhVvCcSsQqTtAaZz]+$/, `${n}: only valid path commands (${cmds})`);
  }
});

test('pathDataOf: a <circle> becomes two half-arcs (a full circle is not one arc)', () => {
  const d = pathDataOf('target');
  // the target is three circles → three "M cx-r cy" moves and six arcs
  assert.equal((d.match(/M\s/g) || []).length, 3, 'one move per circle');
  assert.equal((d.match(/[Aa]/g) || []).length, 6, 'two arcs per circle');
  assert.ok(d.includes('a 10 10'), 'the r=10 outer circle survives');
});

test('pathDataOf: a <path> keeps its own commands and is not rewritten', () => {
  const crown = ICONS.crown;
  const d = pathDataOf('crown');
  const ds = [...crown.matchAll(/<path\s[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ds.length >= 1);
  for (const one of ds) assert.ok(d.includes(one), 'each d attribute appears verbatim');
});

test('pathDataOf: every icon yields distinct, non-trivial geometry', () => {
  const seen = new Set();
  for (const n of NAMES) {
    const d = pathDataOf(n);
    assert.ok(d.length > 40, `${n} is more than a dot`);
    assert.ok(!seen.has(d), `${n} is not a duplicate of another icon`);
    seen.add(d);
  }
});

test('drawLucide: returns false without a DOM, so the skin can fall back', () => {
  // Node has no Path2D — the guard must not throw.
  assert.equal(typeof Path2D, 'undefined', 'this suite runs without Path2D');
  assert.equal(drawLucide({ save() {}, restore() {} }, 'crown', 0, 0, 10), false);
});

test('iconSvg: emits a standalone, self-contained SVG', () => {
  const svg = iconSvg('crown', { size: 32, stroke: 1.5 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /width="32"/);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke-width="1.5"/);
  assert.match(svg, /<path d="M11\.562/);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), 'no remote reference — nothing is fetched at runtime');
});
