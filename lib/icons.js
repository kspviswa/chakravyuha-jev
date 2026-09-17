// lib/icons.js — lucide-style geometry, DOM-free at import time so the suite
// can assert on the shapes. The skin rasterises the 'target' icon onto the
// canvas with plain canvas primitives (three concentric circles + centre dot,
// the exact lucide 'target' glyph) so the goal reads as an icon, not a blob.

/** Lucide 'target' inner markup against a 24×24 viewBox. */
const LUCIDE_TARGET =
  '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>';
/** Lucide 'user' inner markup (head + shoulders) against a 24×24 viewBox. */
const LUCIDE_USER =
  '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>';

export const ICONS = { target: LUCIDE_TARGET, user: LUCIDE_USER };

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

/**
 * Draw the lucide 'target' glyph directly with canvas strokes (no async, no
 * image). `x,y` is the centre, `r` the outer radius in canvas units.
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