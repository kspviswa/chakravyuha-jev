// lib/geo.js — real-geography helpers shared by the server (/api/geo) and the
// navigation skin. Pure functions only: no network, no pathfinding, no DOM.
//
// The pipeline is:
//   Overpass ways --parse--> {class, name, points} --rasterize--> a cost grid
//   (walls = cells with NO road) --snap--> reachable start/goal cells.
//
// Honesty note (mirrored in the UI): the CELL COST is derived from the real
// OpenStreetMap road class (see ROAD_COSTS). The congestion MULTIPLIER applied
// on top by applyCongestion() is simulated — we have no live traffic feed.

// ---- road class -> cost ----------------------------------------------------
// The single exported table the spec asks for. Lower = higher priority. A cell
// holding several classes takes the cheapest (highest-priority) one present.
export const ROAD_COSTS = Object.freeze({
  motorway: 1, motorway_link: 1, trunk: 1, trunk_link: 1,
  primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4,
  residential: 6, unclassified: 6, living_street: 6,
  service: 8, track: 8, footway: 8, path: 8, cycleway: 8,
});

/** Cost of a road class, or null when the class is not in the table. */
export function roadCost(cls) {
  return Object.prototype.hasOwnProperty.call(ROAD_COSTS, cls) ? ROAD_COSTS[cls] : null;
}

// ---- real Ottawa place pairs ----------------------------------------------
// Real coordinates, real names. `bbox` is the map window the endpoint rasterises
// into the grid (chosen around the two endpoints with a small margin).
export const PLACE_PAIRS = Object.freeze({
  'byward-parliament': {
    label: 'ByWard Market → Parliament Hill, Ottawa',
    from: { lat: 45.42723, lon: -75.69249, name: 'ByWard Market, Ottawa' },
    to: { lat: 45.42371, lon: -75.69997, name: 'Parliament Hill, Ottawa' },
    bbox: [45.4197, -75.7045, 45.4312, -75.6875],
  },
  'tunneys-lansdowne': {
    label: "Tunney's Pasture → Lansdowne Park, Ottawa",
    from: { lat: 45.4043, lon: -75.7382, name: "Tunney's Pasture, Ottawa" },
    to: { lat: 45.3981, lon: -75.6831, name: 'Lansdowne Park, Ottawa' },
    bbox: [45.3925, -75.7445, 45.41, -75.676],
  },
  'kanata-bayshore': {
    label: 'Kanata Centrum → Bayshore Shopping Centre, Ottawa',
    from: { lat: 45.3058, lon: -75.9125, name: 'Kanata Centrum, Ottawa' },
    to: { lat: 45.3463, lon: -75.7995, name: 'Bayshore Shopping Centre, Ottawa' },
    bbox: [45.299, -75.9195, 45.353, -75.7925],
  },
});

export const ATTRIBUTION = '© OpenStreetMap contributors';

// ---- bbox / cell maths -----------------------------------------------------
// bbox is [south, west, north, east]. Row 0 is the NORTH edge, col 0 the WEST.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function parseBbox(value) {
  const parts = String(value).split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return validateBbox(parts);
}

export function validateBbox([s, w, n, e]) {
  if (![s, w, n, e].every((v) => Number.isFinite(v))) return null;
  if (s >= n || w >= e) return null;
  if (s < -90 || n > 90 || w < -180 || e > 180) return null;
  return [s, w, n, e];
}

/** Grow a bbox by `frac` of each span (at least 0.002° so tiny boxes still grow). */
export function expandBbox([s, w, n, e], frac = 0.15) {
  const dLat = Math.max((n - s) * frac, 0.002);
  const dLon = Math.max((e - w) * frac, 0.002);
  return validateBbox([s - dLat, w - dLon, n + dLat, e + dLon]);
}

export function bboxSpan(bbox) {
  const [s, w, n, e] = bbox;
  return { lat: n - s, lon: e - w };
}

/** Stable, order-insensitive-ish key for a bbox + grid shape. */
export function bboxKey([s, w, n, e], rows, cols) {
  const f = (v) => v.toFixed(6);
  return `${f(s)},${f(w)},${f(n)},${f(e)}|${rows}|${cols}`;
}

export function latLonToCell(bbox, rows, cols, lat, lon) {
  const [s, w, n, e] = bbox;
  if (!(n > s) || !(e > w)) return null;
  const r = Math.floor(((n - lat) / (n - s)) * rows);
  const c = Math.floor(((lon - w) / (e - w)) * cols);
  return { r: clamp(r, 0, rows - 1), c: clamp(c, 0, cols - 1) };
}

export function cellCenter(bbox, rows, cols, r, c) {
  const [s, w, n, e] = bbox;
  return {
    lat: n - ((r + 0.5) * (n - s)) / rows,
    lon: w + ((c + 0.5) * (e - w)) / cols,
  };
}

// ---- Overpass parsing ------------------------------------------------------
const MAX_NAME = 80;

/**
 * Turn a raw Overpass `out geom` response into compact roads. Only classes in
 * ROAD_COSTS survive; pedestrian/steps/construction/… are dropped (we do not
 * price them). Coordinates are rounded to ~0.1 m so snapshots stay small.
 */
export function parseOverpass(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const roads = [];
  for (const el of elements) {
    if (el?.type !== 'way') continue;
    const cls = el?.tags?.highway;
    const cost = roadCost(cls);
    if (cost === null) continue;
    const geometry = Array.isArray(el.geometry) ? el.geometry : [];
    const points = [];
    for (const p of geometry) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      points.push([round6(p.lat), round6(p.lon)]);
    }
    if (points.length < 2) continue;
    const road = { class: cls, points };
    const name = el?.tags?.name;
    if (typeof name === 'string' && name.trim()) road.name = name.trim().slice(0, MAX_NAME);
    roads.push(road);
  }
  return roads;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---- rasterisation ---------------------------------------------------------
/**
 * Paint each road segment onto the rows×cols grid of the bbox.
 *
 * Returns { base, walls, klass } where base[r][c] is the cheapest (highest
 * priority) road-class cost present in the cell (0 when none) and walls[r][c]
 * is 1 exactly when the cell holds NO road of any priced class — the maze is
 * real: you cannot drive where there is no road.
 */
export function rasterize(roads, bbox, rows, cols) {
  const base = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const klass = Array.from({ length: rows }, () => new Array(cols).fill(null));

  const mark = (lat, lon, cost, cls) => {
    const cell = latLonToCell(bbox, rows, cols, lat, lon);
    if (!cell) return;
    const { r, c } = cell;
    if (base[r][c] === 0 || cost < base[r][c]) {
      base[r][c] = cost;
      klass[r][c] = cls;
    }
  };

  for (const road of roads || []) {
    const cost = roadCost(road?.class);
    if (cost === null) continue;
    const pts = road.points || [];
    for (let i = 1; i < pts.length; i++) {
      paintSegment(pts[i - 1], pts[i], bbox, rows, cols, cost, road.class, mark);
    }
    if (pts.length === 1) mark(pts[0][0], pts[0][1], cost, road.class);
  }

  const walls = base.map((row) => row.map((v) => (v === 0 ? 1 : 0)));
  return { base, walls, klass };
}

/**
 * Sample a segment densely enough that no cell it crosses is missed: about four
 * samples per cell along the dominant axis.
 */
function paintSegment([lat0, lon0], [lat1, lon1], bbox, rows, cols, cost, cls, mark) {
  const [s, w, n, e] = bbox;
  const dr = ((lat0 - lat1) / (n - s)) * rows;
  const dc = ((lon1 - lon0) / (e - w)) * cols;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dr), Math.abs(dc)) * 4));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    mark(lat0 + (lat1 - lat0) * t, lon0 + (lon1 - lon0) * t, cost, cls);
  }
}

// ---- endpoint snapping -----------------------------------------------------
/**
 * Nearest cell with a road, searched in square rings out to `maxRadius`.
 * Returns null when there is no road within the radius.
 */
export function snapCell(walls, r, c, maxRadius = 4) {
  const R = walls.length;
  const C = walls[0]?.length || 0;
  if (!(r >= 0 && r < R && c >= 0 && c < C)) return null;
  if (walls[r][c] === 0) return { r, c };
  for (let radius = 1; radius <= maxRadius; radius++) {
    let best = null;
    let bestD = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= R || nc < 0 || nc >= C) continue;
        if (walls[nr][nc] !== 0) continue;
        const d = dr * dr + dc * dc;
        if (d < bestD) { bestD = d; best = { r: nr, c: nc }; }
      }
    }
    if (best) return best;
  }
  return null;
}

// ---- simulated congestion --------------------------------------------------
// Deterministic so a given map looks the same on every run; explicitly labelled
// as simulated everywhere it surfaces. Real: the road class underneath.
export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A simulated 1.0–2.0 multiplier for a cell, from a seed string. */
export function congestionFactor(r, c, seed) {
  const h = hash32(`${seed}|${r}|${c}`);
  return 1 + (h % 11) / 10;
}

/** Apply the simulated multiplier to the real road-class costs. Walls stay 0. */
export function applyCongestion(base, walls, seed) {
  return base.map((row, r) => row.map((cost, c) => {
    if (walls[r][c]) return 0;
    return Math.round(cost * congestionFactor(r, c, seed) * 100) / 100;
  }));
}

// ---- board adapter ---------------------------------------------------------
/**
 * Build the weighted board the skins and the referee both use, from a /api/geo
 * response. `cells` already includes the simulated congestion; the start and
 * goal cells are free (weights 0), matching lib/board.js city boards.
 */
export function boardFromGeo(geo) {
  const R = geo.rows;
  const C = geo.cols;
  const rows = geo.walls.map((row) => row.map((wall) => (wall ? '#' : '.')));
  const weights = geo.cells.map((row) => row.slice());
  const src = geo.places.from.cell;
  const dst = geo.places.to.cell;
  rows[src.r][src.c] = 'S';
  rows[dst.r][dst.c] = 'D';
  weights[src.r][src.c] = 0;
  weights[dst.r][dst.c] = 0;
  return { R, C, rows, weights, src, dst, weighted: true };
}

// ---- synthetic helper used by tests and by the offline "demo" grid ---------
/** Chebyshev distance between two {r,c} cells. */
export function cellDistance(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
}
