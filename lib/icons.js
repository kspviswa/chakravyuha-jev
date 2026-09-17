// lib/icons.js — vendored Lucide geometry (lucide-static v1.47.0, ISC licence).
//
// Why vendored: this app is a zero-dependency static ES-module page — there is
// no React and no build step, so `lucide-react` cannot be used. These are the
// exact Lucide path strings, drawn on canvas through Path2D, which accepts an
// SVG path-data string directly. No CDN is contacted at runtime.
//
// DOM-free at import time so the Node suite can assert on the shapes.

/** Lucide 'target' — three concentric circles. The goal at the centre. */
const LUCIDE_TARGET =
  '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>';

/** Lucide 'user' — head + shoulders. */
const LUCIDE_USER =
  '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>';

/** Lucide 'crown' — the badge Abhimanyu wears. */
const LUCIDE_CROWN =
  '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>';

/** Lucide 'sparkles' — the arrival burst. */
const LUCIDE_SPARKLES =
  '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>';

/** Lucide 'swords' — used on warrior dots when there is room. */
const LUCIDE_SWORDS =
  '<path d="m13 19 6-6"/><path d="M14.5 17.5 3.586 6.586A2 2 0 0 1 3 5.172V3h2.172a2 2 0 0 1 1.414.586L17.5 14.5"/><path d="m14.828 6.172 2.586-2.586A2 2 0 0 1 18.828 3H21v2.172a2 2 0 0 1-.586 1.414l-2.586 2.586"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="m5 14 4 4"/><path d="m5 21-2-2"/><path d="M7.5 16.5 4 20"/>';

export const LUCIDE_VERSION = '1.47.0';
export const LUCIDE_LICENCE = 'ISC';

/** name → Lucide inner SVG markup (24×24 viewBox). */
export const ICONS = {
  target: LUCIDE_TARGET,
  user: LUCIDE_USER,
  crown: LUCIDE_CROWN,
  sparkles: LUCIDE_SPARKLES,
  swords: LUCIDE_SWORDS,
};

/** A complete standalone SVG string for an icon (data-URL-ready). */
export function iconSvg(name, { size = 24, stroke = 2 } = {}) {
  const inner = ICONS[name] || '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  );
}

/** Rasterise an SVG string into a canvas-friendly HTMLImageElement. */
export async function svgToImage(svg) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('icon render failed'));
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- canvas drawing -------------------------------------------------------
// Path2D caches, built lazily: `new Path2D(pathData)` parses SVG path data.
// Guarded so the Node test environment (no DOM) can still import this module.
const _paths = new Map();

function pathDataOf(name) {
  const markup = ICONS[name] || '';
  return markup.replace(/<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s*\/>/g,
    (_, cx, cy, r) => `M ${Number(cx) - Number(r)} ${cy} a ${r} ${r} 0 1 0 ${2 * Number(r)} 0 a ${r} ${r} 0 1 0 ${-2 * Number(r)} 0`);
}

/**
 * Draw a Lucide glyph with canvas strokes, scaled from its 24×24 viewBox to
 * `size` px, centred on (x, y). `stroke` is the on-screen stroke width.
 * Returns false when Path2D is unavailable (Node), so callers can fall back.
 */
export function drawLucide(ctx, name, x, y, size, stroke = 2) {
  if (typeof Path2D === 'undefined') return false;
  let path = _paths.get(name);
  if (!path) {
    path = new Path2D(pathDataOf(name));
    _paths.set(name, path);
  }
  const s = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.translate(-12, -12);
  ctx.lineWidth = Math.max(0.4, stroke / s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();
  return true;
}

export const drawCrownIcon = (ctx, x, y, size, stroke = 2) => drawLucide(ctx, 'crown', x, y, size, stroke);
export const drawSparklesIcon = (ctx, x, y, size, stroke = 2) => drawLucide(ctx, 'sparkles', x, y, size, stroke);
export const drawSwordsIcon = (ctx, x, y, size, stroke = 2) => drawLucide(ctx, 'swords', x, y, size, stroke);

/**
 * Draw the Lucide 'target' glyph directly with canvas arcs — no Path2D, no
 * async, no image. `x,y` is the centre, `r` the outer radius in canvas units.
 * Kept as an explicit arc-based renderer so the goal draws even in environments
 * without Path2D.
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
