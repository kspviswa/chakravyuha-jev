// test/icons.test.mjs — the vendored Lucide geometry (spec §7).
//
// The regression this guards: `Path2D` accepts SVG *path data* (a `d` attribute),
// NOT an XML element. Lucide markup mixes <path> and <circle>, and an earlier
// version handed the raw markup straight to Path2D — so every <path>-based icon
// (crown, sparkles, swords) silently drew nothing while the arc-based target
// worked. Only the browser pixel probe caught it; this test catches it in Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ICONS, LUCIDE_VIEWBOX, LUCIDE_VERSION, LUCIDE_LICENCE,
  iconSvg, pathDataOf, drawIcon, drawTargetIcon,
} from '../lib/icons.js';

const NAMES = Object.keys(ICONS);

test('the vendored set is credited and complete', () => {
  assert.equal(LUCIDE_VERSION, '1.47.0');
  assert.equal(LUCIDE_LICENCE, 'ISC', 'Lucide is ISC — the README must match');
  assert.equal(LUCIDE_VIEWBOX, 24, 'the Lucide viewBox is 24');
  for (const n of ['target', 'swords', 'crown', 'shield', 'sparkles', 'rotateCw', 'circleDot']) {
    assert.ok(ICONS[n], `${n} is vendored (spec §7 lists it)`);
  }
});

test('ICONS: every glyph is a list of SVG element strings', () => {
  for (const n of NAMES) {
    const els = ICONS[n];
    assert.ok(Array.isArray(els) && els.length > 0, `${n} is a non-empty array`);
    for (const el of els) {
      assert.match(el, /^<(path|circle)\s/, `${n}: element is <path> or <circle>, got ${el.slice(0, 30)}`);
      assert.match(el, /\/>$/, `${n}: element is self-closing`);
    }
  }
});

test('pathDataOf: returns raw path commands, never XML markup', () => {
  for (const n of NAMES) {
    const d = pathDataOf(n);
    assert.ok(d.length > 0, `${n} has path data`);
    assert.doesNotMatch(d, /[<>]/, `${n}: no XML tags — Path2D cannot parse them`);
    assert.doesNotMatch(d, /d\s*=/, `${n}: no attribute syntax`);
    assert.doesNotMatch(d, /\bpath\b|\bcircle\b/i, `${n}: no element names`);
    assert.match(d, /^\s*[Mm]/, `${n}: begins with a move command`);
    const cmds = d.match(/[A-Za-z]/g).join('');
    assert.match(cmds, /^[MmLlHhVvCcSsQqTtAaZz]+$/, `${n}: only valid path commands (${cmds})`);
  }
});

test('pathDataOf: a <circle> becomes two half-arcs (a full circle is not one arc)', () => {
  const d = pathDataOf('target');
  assert.equal((d.match(/M\s/g) || []).length, 3, 'one move per circle');
  assert.equal((d.match(/[Aa]/g) || []).length, 6, 'two arcs per circle');
  assert.ok(d.includes('a 10 10'), 'the r=10 outer circle survives');
  const cd = pathDataOf('circleDot');
  assert.equal((cd.match(/[Aa]/g) || []).length, 4, 'two circles → four arcs');
});

test('pathDataOf: a <path> keeps its own commands verbatim', () => {
  const d = pathDataOf('crown');
  const ds = ICONS.crown.map((el) => el.match(/\bd="([^"]+)"/)[1]);
  for (const one of ds) assert.ok(d.includes(one), 'each d attribute appears verbatim');
});

test('pathDataOf: every icon yields distinct, non-trivial geometry', () => {
  const seen = new Map();
  for (const n of NAMES) {
    const d = pathDataOf(n);
    assert.ok(d.length > 20, `${n} is more than a dot`);
    assert.ok(!seen.has(d), `${n} duplicates ${seen.get(d)}`);
    seen.set(d, n);
  }
});

test('drawIcon: returns false without a DOM, so the skin can fall back', () => {
  assert.equal(typeof Path2D, 'undefined', 'this suite runs without Path2D');
  assert.equal(drawIcon({ save() {}, restore() {} }, 'crown', 0, 0, 10), false);
  assert.equal(drawIcon({ save() {}, restore() {} }, 'nonexistent', 0, 0, 10), false);
});

test('drawTargetIcon: draws with plain arcs, so the goal needs no Path2D', () => {
  const arcs = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    arc(x, y, r) { arcs.push({ x, y, r }); },
    set lineWidth(v) {}, set lineCap(v) {}, set fillStyle(v) {},
  };
  drawTargetIcon(ctx, 100, 100, 50, 2);
  const radii = arcs.map((a) => a.r);
  assert.ok(radii.includes(50), 'the outer ring');
  assert.ok(radii.includes(30), 'the middle ring at 0.6r');
  assert.ok(radii.includes(11), 'the inner ring at 0.22r');
  assert.ok(radii.some((r) => r <= 4), 'a centre dot');
  for (const a of arcs) assert.deepEqual({ x: a.x, y: a.y }, { x: 100, y: 100 }, 'all centred');
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
