// skins/gmaps.js — the navigation ("gmaps") skin with a car (canvas).
//
// No Google Maps SDK, no tiles, no network: the city is drawn locally on a
// canvas. Everything is driven by the SAME Jev round trip as the grid skin —
// the state is the weighted city map, the objective is least-cost, and this
// skin only *draws* the route the referee verified. Road weights (congestion
// 1–5) turn the question from "fewest moves" into "least cost".

import { makeCityBoard, MAP_SIZES } from '../lib/board.js';
import { buildNavState, buildNavQuestions, answerMoves } from '../lib/jev.js';
import { verdictWeighted, walkPath } from '../lib/referee.js';

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

function drawCar(ctx, x, y, angle, u) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.lineCap = 'round';
  // wheels
  ctx.fillStyle = '#0b0c10';
  for (const s of [-1, 1]) {
    ctx.fillRect(-0.5 * u + 0.04 * u, s * 0.34 * u - 0.09 * u, 0.66 * u, 0.18 * u);
    ctx.fillRect(0.34 * u, s * 0.34 * u - 0.09 * u, 0.66 * u, 0.18 * u);
  }
  // body
  const grad = ctx.createLinearGradient(-u, 0, u, 0);
  grad.addColorStop(0, '#f87171');
  grad.addColorStop(1, '#ef4444');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(-0.5 * u, -0.24 * u, 1.9 * u, 0.48 * u, 0.16 * u);
  ctx.fill();
  // windshield + roof
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(0.62 * u, -0.2 * u, 0.3 * u, 0.4 * u);
  ctx.fillStyle = '#7f1d1d';
  ctx.fillRect(0.05 * u, -0.2 * u, 0.35 * u, 0.4 * u);
  // headlights
  ctx.fillStyle = '#fef08a';
  ctx.fillRect(1.26 * u, -0.17 * u, 0.08 * u, 0.34 * u);
  ctx.restore();
}

export const gmapsSkin = {
  id: 'gmaps',
  label: 'Navigation',
  weighted: true,

  mount({ container, autoAsk, resultEl }) {
    this.autoAsk = autoAsk;
    this.resultEl = resultEl;
    const wrap = document.createElement('div');
    wrap.className = 'skin-controls';
    wrap.innerHTML = `
      <label>Map size
        <select id="map-size">
          ${Object.entries(MAP_SIZES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
      </label>
      <button id="map-new" class="ghost" type="button">🏙️ New city</button>
      <label class="check"><input type="checkbox" id="map-traffic" /> traffic jams — randomise congestion &amp; re-ask</label>
      <label class="check"><input type="checkbox" id="map-animate" checked /> animate the car</label>
      <div class="map-hint">Each open cell costs 1–5 (its congestion weight): the question is <b>least cost</b>, not fewest moves.</div>`;
    container.appendChild(wrap);

    const sel = wrap.querySelector('#map-size');
    sel.value = 'medium';
    this.board = makeCityBoard('medium');
    this.route = [];
    this.cost = 0;
    this.animating = false;
    this.progress = 0; // 0..1 over the whole route

    wrap.querySelector('#map-new').addEventListener('click', () => {
      this.board = makeCityBoard(sel.value);
      this.route = [];
      this.draw();
      if (this.autoAsk) this.autoAsk();
    });
    sel.addEventListener('change', () => {
      this.board = makeCityBoard(sel.value);
      this.route = [];
      this.draw();
      if (this.autoAsk) this.autoAsk();
    });
    wrap.querySelector('#map-traffic').addEventListener('change', (e) => {
      this.randomizeTraffic();
      if (e.target.checked && this.autoAsk) this.autoAsk();
    });
  },

  randomizeTraffic() {
    const { rows, weights } = this.board;
    const rand = () => 1 + Math.floor(Math.random() * 5);
    for (let r = 0; r < this.board.R; r++)
      for (let c = 0; c < this.board.C; c++)
        if (['.'].includes(rows[r][c])) weights[r][c] = rand();
    this.route = [];
    this.draw();
  },

  begin() {
    this.route = [];
    this.cost = 0;
    this.progress = 0;
    this.draw();
    return { state: buildNavState(this.board), questions: buildNavQuestions(this.board) };
  },

  check(moves) {
    return verdictWeighted(this.board, moves);
  },

  caption() {
    return `
      <span class="k"><i class="sw s"></i>pickup</span>
      <span class="k"><i class="sw d"></i>drop-off</span>
      <span class="k"><i class="sw b"></i>block</span>
      <span class="k"><i class="sw pk"></i>park</span>
      <span class="k"><i class="sw p"></i>Jev's route</span>`;
  },

  geometry() {
    const canvas = document.getElementById('board');
    const { R, C } = this.board;
    const cell = Math.floor(Math.min(canvas.width / C, canvas.height / R));
    return { canvas, cell, ox: Math.floor((canvas.width - cell * C) / 2), oy: Math.floor((canvas.height - cell * R) / 2) };
  },

  draw(progress) {
    const board = this.board;
    const { canvas, cell, ox, oy } = this.geometry();
    const ctx = canvas.getContext('2d');
    const cx = (c) => ox + c * cell + cell / 2;
    const cy = (r) => oy + r * cell + cell / 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // land
    ctx.fillStyle = '#0e1118';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // cells: roads with congestion tint, blocks, park
    for (let r = 0; r < board.R; r++) {
      for (let c = 0; c < board.C; c++) {
        const ch = board.rows[r][c];
        const x = ox + c * cell, y = oy + r * cell;
        if (ch === '#') {
          ctx.fillStyle = '#333c4a';
          ctx.fillRect(x, y, cell, cell);
          ctx.fillStyle = '#262e3a';
          ctx.fillRect(x + cell * 0.08, y + cell * 0.08, cell * 0.84, cell * 0.84);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x + cell * 0.08, y + cell * 0.62, cell * 0.84, cell * 0.3);
        } else if (ch === 'P') {
          ctx.fillStyle = '#1d3a26';
          ctx.fillRect(x, y, cell, cell);
          ctx.fillStyle = '#2d5a3a';
          ctx.beginPath();
          ctx.arc(x + cell / 2, y + cell / 2, cell * 0.22, 0, 7);
          ctx.fill();
          ctx.fillStyle = '#17301f';
          ctx.fillRect(x + cell / 2 - 1, y + cell / 2 + cell * 0.06, 2, cell * 0.22);
        } else {
          const w = board.weights[r][c] || 1;
          const t = (w - 1) / 4;
          ctx.fillStyle = `rgb(${Math.round(30 + t * 30)}, ${Math.round(36 - t * 8)}, ${Math.round(45 - t * 10)})`;
          ctx.fillRect(x, y, cell, cell);
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(x, y, cell, 1);
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(x, y + cell - 1, cell, 1);
          // congestion number
          ctx.fillStyle = t > 0.5 ? '#fda4af' : 'rgba(200,210,225,0.5)';
          ctx.font = `600 ${Math.max(10, Math.round(cell * 0.34))}px ui-monospace,monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (!(ch === 'S' || ch === 'D')) ctx.fillText(String(w), cx(c), cy(r));
        }
      }
    }

    // route (casing + bright core), drawn up to `progress`
    const pts = this.route;
    if (pts.length > 1 && progress > 0) {
      const n = Math.max(1, Math.round((pts.length - 1) * Math.min(1, progress)));
      const drawn = pts.slice(0, n + 1);
      const line = (color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        drawn.forEach((p, i) => (i ? ctx.lineTo(cx(p.c), cy(p.r)) : ctx.moveTo(cx(p.c), cy(p.r))));
        ctx.stroke();
      };
      line('#0b0c10', Math.max(4, cell * 0.34));      // casing
      line('#38bdf8', Math.max(2.5, cell * 0.22));    // bright core
    }

    this.drawPins(ctx, cx, cy, cell);
    this.drawCarAt(ctx, cx, cy, cell, progress);
  },

  drawPins(ctx, cx, cy, cell) {
    const drawPin = (x, y, color) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, -cell * 0.12, cell * 0.2, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, cell * 0.22);
      ctx.lineTo(-cell * 0.18, -cell * 0.02);
      ctx.lineTo(cell * 0.18, -cell * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0b0c10';
      ctx.beginPath();
      ctx.arc(-cell * 0.06, -cell * 0.15, cell * 0.045, 0, 7);
      ctx.arc(cell * 0.06, -cell * 0.15, cell * 0.045, 0, 7);
      ctx.fill();
      ctx.restore();
    };
    const src = this.board.src, dst = this.board.dst;
    drawPin(cx(src.c), cy(src.r), '#38bdf8'); // pickup
    // flag
    const fx = cx(dst.c), fy = cy(dst.r);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = cell * 0.06;
    ctx.beginPath();
    ctx.moveTo(fx, fy - cell * 0.3);
    ctx.lineTo(fx, fy + cell * 0.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(fx, fy - cell * 0.3);
    ctx.lineTo(fx + cell * 0.3, fy - cell * 0.18);
    ctx.lineTo(fx, fy - cell * 0.06);
    ctx.closePath();
    ctx.fillStyle = '#4ade80';
    ctx.fill();
  },

  drawCarAt(ctx, cx, cy, cell, progress) {
    const pts = this.route;
    if (pts.length < 2) return;
    const t = Math.min(1, Math.max(0, progress || 0)) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(t));
    const f = t - i;
    const a = pts[i], b = pts[i + 1];
    const x = cx(a.c) + (cx(b.c) - cx(a.c)) * f;
    const y = cy(a.r) + (cy(b.r) - cy(a.r)) * f;
    const dr = b.r - a.r, dc = b.c - a.c;
    const angle = dr === -1 ? DIR_ANGLE.up : dr === 1 ? DIR_ANGLE.down : dc === -1 ? DIR_ANGLE.left : DIR_ANGLE.right;
    drawCar(ctx, x, y, angle, cell * 0.42);
  },

  render(res) {
    const moves = answerMoves(res.answers);
    const { walk, optimal } = verdictWeighted(this.board, moves);
    this.route = walk.cells;
    this.cost = walk.cost;
    this.optimal = optimal;

    // turn-by-turn + ETA band
    if (this.resultEl) {
      const turns = turnInstructions(walk.cells);
      const minutes = Math.round(walk.cost);
      const eta = walk.reached
        ? `${minutes} min`
        : walk.hitWall ? 'blocked' : walk.outOfBounds ? 'lost' : 'vague';
      const optimalLine = optimal === null
        ? 'no route exists'
        : walk.reached && walk.cost === optimal
          ? `least cost verified — 0 min over the optimum`
          : `cost ${walk.cost} vs optimum ${optimal}`;
      this.resultEl.innerHTML = `
        <div class="eta-band"><span class="eta-val">≈ ${eta}</span><span class="eta-note">${walk.steps} cells · ${walk.cost} cost · ${optimalLine}</span></div>
        <ol class="turns">
          ${turnInstructions(walk.cells).map((s) => `<li>${s}</li>`).join('') || '<li>route too short</li>'}
        </ol>`;
    }

    const animate = !!document.querySelector('#map-animate')?.checked;
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
    this.animating = false;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = null;
  },
};