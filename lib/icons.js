// lib/icons.js — Lucide v1.47.0 geometry (ISC). Vendored: no CDN, no React, no build.
//
// Why vendored: this app is a zero-dependency static ES-module page, so
// `lucide-react` cannot be used. These are the exact Lucide element strings,
// drawn on the canvas through Path2D.
//
// CRITICAL: Path2D accepts SVG *path data* (the `d` attribute's contents), NOT
// an XML element. Handing it '<path d="…"/>' silently builds an EMPTY path and
// the icon draws nothing, with no error. So every element is converted first:
// each <path> contributes its `d` verbatim, and each <circle cx cy r> becomes
// two half-arcs (a full circle cannot be expressed as a single arc command).
//
// DOM-free at import time so the Node suite can assert on the geometry.

export const LUCIDE_VIEWBOX = 24;

export const ICONS = {
  target: ['<circle cx="12" cy="12" r="10"/>', '<circle cx="12" cy="12" r="6"/>', '<circle cx="12" cy="12" r="2"/>'],
  swords: ['<path d="m13 19 6-6"/>', '<path d="M14.5 17.5 3.586 6.586A2 2 0 013 5.172V3h2.172a2 2 0 011.414.586L17.5 14.5"/>', '<path d="m14.828 6.172 2.586-2.586A2 2 0 0118.828 3H21v2.172a2 2 0 01-.586 1.414l-2.586 2.586"/>', '<path d="m16 16 4 4"/>', '<path d="m19 21 2-2"/>', '<path d="m5 14 4 4"/>', '<path d="m5 21-2-2"/>', '<path d="M7.5 16.5 4 20"/>'],
  crown: ['<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/>', '<path d="M5 21h14"/>'],
  shield: ['<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'],
  sparkles: ['<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>', '<path d="M20 2v4"/>', '<path d="M22 4h-4"/>', '<circle cx="4" cy="20" r="2"/>'],
  rotateCw: ['<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>', '<path d="M21 3v5h-5"/>'],
  circleDot: ['<circle cx="12" cy="12" r="1"/>', '<circle cx="12" cy="12" r="10"/>'],
  user: ['<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>', '<circle cx="12" cy="7" r="4"/>'],
};

export const LUCIDE_VERSION = '1.47.0';
export const LUCIDE_LICENCE = 'ISC';

/** name → the raw SVG path data for the whole glyph (Path2D-ready). */
export function pathDataOf(name) {
  const elements = ICONS[name] || [];
  const parts = [];

  for (const el of elements) {
    // <path d="…"/> → its d attribute verbatim
    const d = el.match(/<path\s[^>]*\bd="([^"]+)"/);
    if (d) { parts.push(d[1]); continue; }

    // <circle cx cy r/> → two half-arcs
    const c = el.match(/<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"/);
    if (c) {
      const cx = Number(c[1]), cy = Number(c[2]), r = Number(c[3]);
      parts.push(`M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`);
    }
  }

  return parts.join(' ');
}

// Path2D caches, built lazily. Guarded so the Node environment (no DOM, no
// Path2D) can still import and inspect this module.
const _paths = new Map();

function pathFor(name) {
  let path = _paths.get(name);
  if (!path) {
    path = new Path2D(pathDataOf(name));
    _paths.set(name, path);
  }
  return path;
}

/**
 * Draw a Lucide glyph on a canvas, scaled from its 24×24 viewBox to `size` px,
 * centred on (cx, cy). Strokes with round caps/joins so it looks exactly like
 * the Lucide icon. `lineWidth` defaults to Lucide's own 2 units at this scale.
 * Returns false when Path2D is unavailable, so callers can fall back.
 */
export function drawIcon(ctx, name, cx, cy, size, { color, lineWidth } = {}) {
  if (typeof Path2D === 'undefined') return false;
  const path = pathFor(name);
  const scale = size / LUCIDE_VIEWBOX;
  ctx.save();
  if (color) ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth ?? 2 * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-LUCIDE_VIEWBOX / 2, -LUCIDE_VIEWBOX / 2);
  ctx.stroke(path);
  ctx.restore();
  return true;
}

/** A standalone SVG string for an icon (documentation, favicons, tests). */
export function iconSvg(name, { size = 24, stroke = 2 } = {}) {
  const inner = (ICONS[name] || []).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${LUCIDE_VIEWBOX} ${LUCIDE_VIEWBOX}" fill="none" stroke="currentColor" `
    + `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  );
}

/**
 * Draw the Lucide 'target' glyph with plain canvas arcs — no Path2D, no async,
 * no image. `x,y` is the centre, `r` the outer radius in canvas units. Kept as
 * an explicit arc renderer so the goal always draws, even without Path2D.
 */
export function drawTargetIcon(ctx, x, y, r, stroke = 2) {
  ctx.save();
  ctx.lineWidth = Math.max(1, stroke);
  ctx.lineCap = 'round';
  for (const rr of [r, r * 0.6, r * 0.22]) {
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, r * 0.08), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
