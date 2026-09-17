// skins/gmaps.js — the Navigation skin: a REAL map. Real geography only.
//
// The map background is OSM raster tiles drawn by hand onto the existing
// <canvas> (no runtime CDN — the tiles themselves are image DATA from
// tile.openstreetmap.org, fetched eagerly at runtime, and the app stays
// playable when they fail). The road network comes from /api/geo, which
// rasterises real OpenStreetMap roads: a cell with NO road is a wall, and the
// cost of a road cell comes from the REAL road class (motorway cheap, service
// roads expensive). The congestion MULTIPLIER on top is SIMULATED — we have no
// live traffic feed, and the UI says so.
//
// Game-loop rule unchanged: this skin serialises the geo board, sends it to
// Jev, and draws the returned moves (lib/referee.js checks, never chooses).

import { PLACE_PAIRS, ATTRIBUTION, boardFromGeo, cellCenter } from '../lib/geo.js';
import { buildNavQuestions, answerMoves } from '../lib/jev.js';
import { verdictWeighted } from '../lib/referee.js';
import { deriveBase } from '../lib/transport.js';

const BASE = deriveBase(typeof location !== 'undefined' ? location.pathname : '/');
const TILE_URL = 'https://tile.openstreetmap.org';
const GRID_SIZES = [
  { v: 16, label: '16 × 16' },
  { v: 24, label: '24 × 24' },
  { v: 32, label: '32 × 32' },
];
const SOURCE_LABEL = {
  overpass: 'LIVE — real OSM/Overpass road data',
  cache: 'CACHED road data (this area was fetched before)',
  snapshot: 'SNAPSHOT — offline fallback, NOT live road data',
};
const DIR_ANGLE = { up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0 };
const DIR_NAME = { up: 'north', down: 'south', left: 'west', right: 'east' };

function turnDirection(prev, next) {
  const idx = ['up', 'right', 'down', 'left'];
  const diff = (((idx.indexOf(next) - idx.indexOf(prev)) % 4) + 4) % 4;
  return diff === 1 ? 'right' : diff === 3 ? 'left' : null;
}

export function turnInstructions(cells) {
  if (cells.length < 2) return [];
  const segs = [];
  for (let i = 1; i < cells.length; i++) {
    const dr = cells[i].r - cells[i - 1].r, dc = cells[i].c - cells[i - 1].c;
    segs.push(dr === -1 ? 'up' : dr === 1 ? 'down' : dc === -1 ? 'left' : 'right');
  }
  const runs = [];
  for (const d of segs) {
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.len++; else runs.push({ dir: d, len: 1 });
  }
  const lines = [`Head ${DIR_NAME[runs[0].dir]}`];
  for (let i = 1; i < runs.length; i++) {
    const t = turnDirection(runs[i - 1].dir, runs[i].dir);
    const prevLen = runs[i - 1].len;
    lines.push(t
      ? `in ${prevLen} cell${prevLen > 1 ? 's' : ''} turn ${t}`
      : `continue for ${prevLen} cell${prevLen > 1 ? 's' : ''}`);
  }
  return lines;
}

// ---- slippy-map maths (pure, tiny) -----------------------------------------
const TILE = 256;

/** Web-Mercator tile coords (floats) for a lat/lon at zoom z. */
export function projectTile(lat, lon, z) {
  const n = 1 << z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

/** Fit zoom: bbox pixel span closest to the canvas dimension. */
export function chooseZoom([s, w, n, e], canvasSize) {
  let best = 1; let bestGap = Infinity;
  for (let z = 1; z <= 18; z++) {
    const x0 = projectTile(0, w, z).x;
    const x1 = projectTile(0, e, z).x;
    const y0 = projectTile(n, 0, z).y;
    const y1 = projectTile(s, 0, z).y;
    const span = Math.max((x1 - x0), (y1 - y0)) * TILE;
    const gap = Math.abs(span - canvasSize);
    if (gap < bestGap) { bestGap = gap; best = z; }
  }
  return best;
}

export const gmapsSkin = {
  id: 'gmaps',
  label: 'Navigation',
  weighted: true,

  async mount({ container, autoAsk, resultEl }) {
    this.autoAsk = autoAsk;
    this.resultEl = resultEl;
    this.geo = null;
    this.board = null;
    this.route = [];
    this.cost = 0;
    this.animating = false;
    this.progress = 0;
    this.tiles = Object.create(null);   // "z/x/y" -> <img>
    this.view = { zoom: 1, panX: 0, panY: 0 };
    this.dead = false;

    const wrap = document.createElement('div');
    wrap.className = 'skin-controls';
    wrap.innerHTML = `
      <label>Route preset <em>(real places in Ottawa)</em>
        <select id="geo-pair">
          ${Object.entries(PLACE_PAIRS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
      </label>
      <label>Grid
        <select id="geo-grid">
          ${GRID_SIZES.map((g) => `<option value="${g.v}">${g.label}</option>`).join('')}
        </select>
      </label>
      <label>Manual endpoints <em>(lat,lon)</em>
        <input id="geo-from" placeholder="from — e.g. ${PLACE_PAIRS['byward-parliament'].from.lat},${PLACE_PAIRS['byward-parliament'].from.lon}" />
        <input id="geo-to" placeholder="to — e.g. ${PLACE_PAIRS['byward-parliament'].to.lat},${PLACE_PAIRS['byward-parliament'].to.lon}" />
      </label>
      <div class="geo-actions">
        <button id="geo-load" class="ghost" type="button">🗺️ Load this map</button>
        <button id="geo-refresh" class="ghost" type="button">↻ Refresh (skip cache)</button>
      </div>
      <div class="map-hint">Each cell: <b>real road class cost</b> (motorway ≈ 1…service ≈ 8). Intersections on the grid are drivable gaps; tiles are OSM raster. <b>The congestion multiplier is SIMULATED</b> — cost is real, traffic is not.</div>
      <label class="check"><input type="checkbox" id="geo-animate" checked /> animate the car</label>`;
    container.appendChild(wrap);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'geo-status';
    wrap.appendChild(this.statusEl);

    const pairSel = wrap.querySelector('#geo-pair');
    const gridSel = wrap.querySelector('#geo-grid');
    const fromEl = wrap.querySelector('#geo-from');
    const toEl = wrap.querySelector('#geo-to');
    pairSel.value = 'byward-parliament';

    const clearManual = () => { fromEl.value = ''; toEl.value = ''; };
    pairSel.addEventListener('change', () => { clearManual(); this.loadFromFields(); });
    gridSel.addEventListener('change', () => this.loadFromFields());
    wrap.querySelector('#geo-load').addEventListener('click', () => this.loadFromFields());
    wrap.querySelector('#geo-refresh').addEventListener('click', () => { this.refreshing = true; this.loadFromFields(); });

    this.bindCanvas();

    await this.loadFromFields();
  },

  bindCanvas() {
    const canvas = document.getElementById('board');
    if (!canvas || canvas.dataset.geoBound) return;
    canvas.dataset.geoBound = '1';
    const skin = this;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      skin.view.zoom = Math.min(8, Math.max(0.4, skin.view.zoom * factor));
      skin.draw();
    }, { passive: false });
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, panX: skin.view.panX, panY: skin.view.panY };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      skin.view.panX = down.panX + (e.clientX - down.x);
      skin.view.panY = down.panY + (e.clientY - down.y);
      skin.draw();
    });
    const up = () => { down = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', up);
    canvas.addEventListener('dblclick', () => {
      skin.view.zoom = 1; skin.view.panX = 0; skin.view.panY = 0;
      skin.draw();
    });
  },

  setStatus(text, kind = '') {
    if (this.statusEl) {
      this.statusEl.textContent = text;
      this.statusEl.className = 'geo-status' + (kind ? ` ${kind}` : '');
    }
  },

  manualFromFields() {
    const fromEl = document.querySelector('#geo-from');
    const toEl = document.querySelector('#geo-to');
    const parse = (el) => {
      const v = (el?.value || '').trim();
      if (!v) return null;
      const parts = v.split(',').map((n) => Number(n.trim()));
      if (parts.length !== 2 || !parts.every(Number.isFinite)) return { error: true };
      const [lat, lon] = parts;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { error: true };
      return { lat, lon };
    };
    const f = parse(fromEl);
    const t = parse(toEl);
    if ((fromEl?.value.trim() || toEl?.value.trim()) && (f?.error || t?.error)) {
      this.setStatus('manual endpoints must be “lat,lon” with lat in −90..90 and lon in −180..180', 'err');
      return { error: true };
    }
    if (!f && !t) return {};
    if ((fromEl?.value.trim() && !f) || (toEl?.value.trim() && !t)) return { error: true };
    return (f && t) ? { from: f, to: t, manual: true } : { error: true };
  },

  async loadFromFields() {
    const pairEl = document.querySelector('#geo-pair');
    const gridEl = document.querySelector('#geo-grid');
    const pair = PLACE_PAIRS[pairEl?.value] || PLACE_PAIRS['byward-parliament'];
    const rows = Number(gridEl?.value || 16);
    const cols = rows;
    const manual = this.manualFromFields();
    if (manual.error) return;

    this.setStatus('loading road network…');
    const params = new URLSearchParams();
    params.set('bbox', pair.bbox.join(','));
    params.set('rows', String(rows));
    params.set('cols', String(cols));
    if (manual.from && manual.to) {
      params.set('from', `${manual.from.lat},${manual.from.lon}`);
      params.set('to', `${manual.to.lat},${manual.to.lon}`);
    }
    if (this.refreshing) { params.set('refresh', '1'); this.refreshing = false; }
    try {
      const r = await fetch(`${BASE}api/geo?${params.toString()}`);
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error?.message || `map API HTTP ${r.status}`);
      }
      const geo = await r.json();
      this.applyGeo(geo);
      const src = SOURCE_LABEL[geo.source] || `source: ${geo.source}`;
      this.setStatus(`${src} — press “▶ Ask Jev for the path” when ready`,
        geo.source === 'snapshot' ? 'snap' : 'ok');
    } catch (e) {
      this.geo = null;
      this.dead = true;
      this.setStatus(`real map unavailable — ${e.message}. Showing the simulated city instead so the round-trip still works.`, 'err');
      const { makeCityBoard } = await import('../lib/board.js');
      this.board = makeCityBoard('medium');
      this.draw();
    }
  },

  applyGeo(geo) {
    this.geo = geo;
    this.tiles = Object.create(null);
    this.view = { zoom: 1, panX: 0, panY: 0 };
    this.board = boardFromGeo(geo);
    this.notes = geo.notes || [];
    this.route = [];
    this.dead = false;
    this.draw();
    // NOTE: deliberately NO auto-ask here. This used to call this.autoAsk() on
    // every applyGeo — including the initial mount — which meant loading the
    // navigation skin immediately ran ask(). With no key that silently drew the
    // LOCAL STUB solver's route, so a path appeared before the user had pasted
    // anything; with a key it spent the user's credits without them pressing
    // the button. The other two skins only auto-ask on an explicit control
    // change, never on mount. Solving is now an explicit action: press
    // "Ask Jev for the path". Changing a preset clears the old route above, so
    // a stale path is never left on a newly loaded map.
  },

  begin() {
    this.route = [];
    this.cost = 0;
    this.progress = 0;
    if (this.board) this.draw();
    const board = this.board;
    const weights = board.weights;
    return {
      state: {
        task: 'navigation_weighted',
        grid: board.rows.map((row) => row.join('')),
        weights: weights.map((row) => row.map(Number)),
        legend: {
          S: 'pickup', D: 'drop-off (flag)', '#': 'no road (impassable)',
          weights: 'cost of each open cell, from the REAL OSM road class (motorway ≈ 1 … service ≈ 8) times a SIMULATED congestion multiplier',
        },
        source: { row: board.src.r, col: board.src.c },
        destination: { row: board.dst.r, col: board.dst.c },
        rules: '4-directional moves. Entering a cell costs its weight; the start cell costs nothing. Road class is real OpenStreetMap data; the congestion multiplier is simulated.',
        objective: 'Find the least-cost route from the pickup S to the drop-off D, expressed as an ordered list of single-cell moves.',
      },
      questions: buildNavQuestions(board),
    };
  },

  check(moves) {
    return verdictWeighted(this.board, moves);
  },

  caption() {
    return `
      <span class="k"><i class="sw s"></i>pickup</span>
      <span class="k"><i class="sw d"></i>drop-off</span>
      <span class="k"><i class="sw w"></i>no road</span>
      <span class="k"><i class="sw p"></i>Jev's route</span>
      <span class="attrib">${ATTRIBUTION}</span>`;
  },

  // ---- view transform -------------------------------------------------------
  viewTransform() {
    const canvas = document.getElementById('board');
    const W = canvas.width, H = canvas.height;
    const [s, w, n, e] = this.geo.bbox;
    const z = chooseZoom(this.geo.bbox, Math.min(W, H));
    const xw = projectTile(0, w, z).x;
    const xe = projectTile(0, e, z).x;
    const yn = projectTile(n, 0, z).y;
    const ys = projectTile(s, 0, z).y;
    const spanX = (xe - xw) * TILE;
    const spanY = (ys - yn) * TILE;
    const fitScale = Math.min(W / spanX, H / spanY);
    const baseX = (W - spanX * fitScale) / 2 + this.view.panX;
    const baseY = (H - spanY * fitScale) / 2 + this.view.panY;
    const scale = fitScale * this.view.zoom;
    const sx = (lon) => (projectTile(0, lon, z).x - xw) * TILE * scale + baseX;
    const sy = (lat) => (projectTile(lat, 0, z).y - yn) * TILE * scale + baseY;
    return {
      z, xw, yn, sx, sy, baseX, baseY,
      tileSize: TILE * scale, W, H,
    };
  },

  // ---- drawing ----------------------------------------------------------------
  draw(progress) {
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0e1118';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.geo || !this.board) {
      this.drawFallbackCity(ctx, canvas);
      return;
    }

    const T = this.viewTransform();
    this.drawTiles(ctx, T);
    this.drawCells(ctx, T);
    this.drawRoute(ctx, T, progress);
    this.drawPins(ctx, T);
    this.drawBadges(ctx, T);
  },

  drawFallbackCity(ctx, canvas) {
    if (!this.board) return;
    const board = this.board;
    const cell = Math.floor(Math.min(canvas.width / board.C, canvas.height / board.R));
    const ox = Math.floor((canvas.width - cell * board.C) / 2);
    const oy = Math.floor((canvas.height - cell * board.R) / 2);
    for (let r = 0; r < board.R; r++) {
      for (let c = 0; c < board.C; c++) {
        const ch = board.rows[r][c];
        const x = ox + c * cell, y = oy + r * cell;
        if (ch === '#') {
          ctx.fillStyle = '#333c4a';
          ctx.fillRect(x, y, cell, cell);
        } else {
          const w = board.weights[r][c] || 1;
          const t = Math.min(1, w / 10);
          ctx.fillStyle = `rgb(${Math.round(40 - t * 10)}, ${Math.round(60 - t * 30)}, ${Math.round(90 - t * 30)})`;
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        }
      }
    }
    ctx.fillStyle = '#fca5a5';
    ctx.font = '600 26px ui-monospace,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('map unavailable — simulated city', canvas.width / 2, canvas.height / 2);
  },

  drawTiles(ctx, T) {
    const x0 = Math.floor(T.xw - T.baseX / T.tileSize);
    const x1 = Math.floor(T.xw + (T.W - T.baseX) / T.tileSize);
    const y0 = Math.floor(T.yn - T.baseY / T.tileSize);
    const y1 = Math.floor(T.yn + (T.H - T.baseY) / T.tileSize);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = `${T.z}/${tx}/${ty}`;
        const img = this.tileImage(key, T.z, tx, ty);
        if (img && img.complete && img.naturalWidth > 0) {
          const dx = (tx - T.xw) * T.tileSize + T.baseX;
          const dy = (ty - T.yn) * T.tileSize + T.baseY;
          ctx.drawImage(img, dx, dy, T.tileSize, T.tileSize);
        }
      }
    }
  },

  tileImage(key, z, x, y) {
    let img = this.tiles[key];
    if (img) return img;
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!this.disposed) this.draw(); };
    img.onerror = () => { this.tiles[key] = null; if (!this.disposed) this.draw(); };
    img.src = `${TILE_URL}/${z}/${x}/${y}.png`;
    this.tiles[key] = img;
    return img;
  },

  drawCells(ctx, T) {
    const [s, w, n, e] = this.geo.bbox;
    const R = this.geo.rows, C = this.geo.cols;
    const dLat = (n - s) / R, dLon = (e - w) / C;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const lat0 = n - r * dLat, lat1 = n - (r + 1) * dLat;
        const lon0 = w + c * dLon, lon1 = w + (c + 1) * dLon;
        const wall = this.geo.walls[r][c];
        const cost = this.geo.cells[r][c];
        const x = [T.sx(lon0), T.sx(lon1)];
        const y = [T.sy(lat0), T.sy(lat1)];
        ctx.beginPath();
        ctx.moveTo(x[0], y[0]); ctx.lineTo(x[1], y[0]);
        ctx.lineTo(x[1], y[1]); ctx.lineTo(x[0], y[1]);
        ctx.closePath();
        if (wall) {
          ctx.fillStyle = 'rgba(12,14,20,0.82)';
          ctx.fill();
        } else {
          const t = Math.min(1, (cost || 1) / 10);
          const g = Math.round(150 + 40 * (1 - t));
          const b = Math.round(180 + 20 * (1 - t));
          ctx.fillStyle = `rgba(56,${g},${b},${(0.20 + t * 0.22).toFixed(3)})`;
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  },

  drawRoute(ctx, T, progress) {
    const pts = this.route;
    if (pts.length < 2 || !progress || progress <= 0) return;
    const n = Math.max(1, Math.round((pts.length - 1) * Math.min(1, progress)));
    const drawn = pts.slice(0, n + 1);
    const xy = (p) => {
      const cc = cellCenter(this.geo.bbox, this.geo.rows, this.geo.cols, p.r, p.c);
      return [T.sx(cc.lon), T.sy(cc.lat)];
    };
    const line = (color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      drawn.forEach((p, i) => {
        const [X, Y] = xy(p);
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      });
      ctx.stroke();
    };
    line('rgba(0,0,0,0.75)', Math.max(4, T.tileSize * 0.32));
    line('#38bdf8', Math.max(2.5, T.tileSize * 0.18));
  },

  drawPins(ctx, T) {
    const src = cellCenter(this.geo.bbox, this.geo.rows, this.geo.cols, this.board.src.r, this.board.src.c);
    const dst = cellCenter(this.geo.bbox, this.geo.rows, this.geo.cols, this.board.dst.r, this.board.dst.c);
    const sx0 = T.sx(src.lon), sy0 = T.sy(src.lat);
    const sx1 = T.sx(dst.lon), sy1 = T.sy(dst.lat);
    const pin = (x, y, color, label) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y - 10, 9, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y + 8);
      ctx.lineTo(x - 8, y - 4);
      ctx.lineTo(x + 8, y - 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0b0c10';
      ctx.beginPath();
      ctx.arc(x, y - 10, 3, 0, 7);
      ctx.fill();
      ctx.restore();
      const name = label ? `  ${label}` : '';
      ctx.font = '600 13px system-ui,sans-serif';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(name).width;
      const tx = x + 12;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(tx - 3, y - 4 - 10, tw + 6, 20);
      ctx.fillStyle = '#e8eaf0';
      ctx.fillText(name, tx, y - 4);
      ctx.fillStyle = color;
      ctx.fillRect(x - 1, y - 20, 3, 26);
    };
    pin(sx0, sy0, '#38bdf8', this.geo.places.from.name);
    pin(sx1, sy1, '#4ade80', this.geo.places.to.name);
  },

  drawBadges(ctx, T) {
    const source = this.geo.source || '?';
    const label = source === 'overpass' ? 'LIVE' : source === 'snapshot' ? 'SNAPSHOT' : source === 'cache' ? 'CACHE' : source.toUpperCase();
    const box = (text, x, y, color, bg) => {
      ctx.font = '700 12px ui-monospace,monospace';
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, w, 21);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 6, y + 14);
      return w;
    };
    box(label, 8, 8, source === 'snapshot' ? '#fbbf24' : '#4ade80', 'rgba(8,18,26,0.85)');
    ctx.font = '11px system-ui,sans-serif';
    ctx.fillStyle = 'rgba(232,234,240,0.85)';
    ctx.fillText(`${ATTRIBUTION}`, 8, T.H - 10);
  },

  // ---- animation + result ------------------------------------------------------
  render(res) {
    const moves = answerMoves(res.answers);
    const { walk, optimal } = verdictWeighted(this.board, moves);
    this.route = walk.cells;
    this.cost = walk.cost;
    this.optimal = optimal;

    if (this.resultEl) {
      const minutes = Math.round(walk.cost);
      const eta = walk.reached
        ? `${minutes} min`
        : walk.hitWall ? 'blocked' : walk.outOfBounds ? 'lost' : 'vague';
      const optimalLine = optimal === null
        ? 'no route exists'
        : walk.reached && walk.cost === optimal
          ? `least cost verified — 0 over the optimum`
          : `cost ${walk.cost} vs optimum ${optimal}`;
      const honesty = this.dead
        ? 'Map unavailable — this round-trip ran on the simulated city.'
        : `Road network: ${SOURCE_LABEL[this.geo.source] || this.geo.source}. Cost = REAL road class; congestion multiplier = SIMULATED.`;
      this.resultEl.innerHTML = `
        <div class="eta-band"><span class="eta-val">≈ ${eta}</span><span class="eta-note">${walk.steps} cells · ${walk.cost} cost · ${optimalLine}</span></div>
        <ol class="turns">
          ${turnInstructions(walk.cells).map((s) => `<li>${s}</li>`).join('') || '<li>route too short</li>'}
        </ol>
        <div class="geo-note">${honesty}</div>`;
    }

    const animate = !!document.querySelector('#geo-animate')?.checked;
    if (!animate) { this.progress = 1; this.draw(1); return; }
    this.animating = true;
    this.progress = 0;
    const start = performance.now();
    const msPerCell = 260;
    const totalMs = Math.max(40, (this.route.length - 1) * msPerCell);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / totalMs);
      this.progress = t;
      this.draw(t);
      if (t < 1 && this.animating) requestAnimationFrame(tick);
      else { this.animating = false; }
    };
    requestAnimationFrame(tick);
  },

  dispose() {
    this.disposed = true;
    this.animating = false;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = null;
  },
};