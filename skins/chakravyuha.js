// skins/chakravyuha.js — the Chakravyuha skin: a polar ring maze on <canvas>,
// Abhimanyu moving ring by ring, warriors as dots, the centre as a Lucide
// 'target' and Abhimanyu's portrait resting on one side. Movement is animated
// through lib/animator.js; the referee's comparison route is drawn ONLY after
// a run finishes and is labelled "referee's" — never before, never to hint.
//
// Same skin contract the shell expects: mount / begin / newBoard /
// setDifficulty / board / check / render / caption / dispose. Plus
// this.animateHop(h) → Promise<...>, which the shell awaits inside the policy
// loop so the maze visibly paces the run.

import {
  makeChakraBoard, CHAKRA_PRESETS, DIFFICULTIES,
  centreRadius, centreAngle, cellKey,
} from '../lib/chakra.js';
import { chakraVerdict } from '../lib/referee.js';
import { Animator } from '../lib/animator.js';
import { drawTargetIcon } from '../lib/icons.js';

const MAX_LOGICAL = 720;
const STEPS_PER_HOP = 180; // ms of tween per hop
const HOP_BEAT = 90;       // ms held on the destination before the next hop

const COL = {
  bg: '#0e1118',
  line: '#2a3140',
  wall: '#4b5563',
  wallSoft: 'rgba(120,130,150,0.35)',
  ring: 'rgba(90,100,120,0.14)',
  warrior: '#f87171',
  trail: '#38bdf8',
  token: '#a78bfa',
  target: '#4ade80',
  text: '#e8eaf0',
  dim: '#8b93a7',
};

export const chakraSkin = {
  id: 'chakravyuha',
  label: 'Chakravyuha',
  weighted: false,

  _currentRuntime: null,

  mount({ container }) {
    const wrap = document.createElement('div');
    wrap.className = 'skin-controls';
    wrap.innerHTML = `
      <div class="diffbar" id="diff-bar" role="group" aria-label="difficulty">
        ${DIFFICULTIES.map((d) =>
          `<button class="diff-btn" data-diff="${d}" type="button">${CHAKRA_PRESETS[d].label}</button>`).join('')}
      </div>
      <div class="cta-row">
        <button id="maze-new" class="ghost" type="button">⟳ New maze</button>
        <label class="check"><input type="checkbox" id="maze-instant" /> instant moves</label>
      </div>`;
    container.appendChild(wrap);

    this.canvas = document.getElementById('board');
    this.canvas.setAttribute('aria-label', 'chakravyuha ring maze');
    this.container = container;

    wrap.querySelector('#diff-bar').addEventListener('click', (e) => {
      const btn = e.target.closest('.diff-btn');
      if (!btn) return;
      this.setDifficulty(btn.dataset.diff);
      this.newBoard();
      this._refreshActive();
    });

    wrap.querySelector('#maze-new').addEventListener('click', () => {
      // Deliberately does NOT ask Jev: a fresh maze is drawn silently.
      this.newBoard();
      this._refreshActive();
    });

    const instantBox = wrap.querySelector('#maze-instant');
    instantBox.checked = this.instant;
    instantBox.addEventListener('change', () => this.setInstant(instantBox.checked));

    this.animator = new Animator({
      duration: STEPS_PER_HOP,
      onFrame: (f) => {
        this.pos = f.pos;
        this._draw();
      },
    });
    this.animator._S = 0;

    this.portrait = new Image();
    this.portrait.src = './assets/abhimanyu.jpg';
    this.portrait.onload = () => this._draw();

    this.newBoard();
    this._refreshActive();
  },

  setInstant(v) {
    this.instant = !!v;
    if (this.animator) this.animator.instant = this.instant;
  },

  setDifficulty(diffKey) {
    if (!CHAKRA_PRESETS[diffKey]) return;
    this.difficulty = diffKey;
    try { localStorage.setItem('jev.difficulty', diffKey); } catch { /* ignore */ }
  },

  newBoard() {
    this.board = makeChakraBoard(this.difficulty || 'easy');
    this.pos = { ring: this.board.src.ring, sector: this.board.src.sector };
    this.trail = [this.board.src];
    this.verdict = null;
    this._draw();
    this._publishHook();
  },

  begin() {
    this.pos = { ring: this.board.src.ring, sector: this.board.src.sector };
    this.trail = [this.board.src];
    this.verdict = null;
    this._draw();
    this._publishHook();
  },

  /** Play a single hop and resolve when it lands. Shell awaits this per step. */
  animateHop(h) {
    const from = h.from || this.pos;
    const to = h.to;
    return this.animator.play([{ from, to, dir: h.dir, step: h.step, pauseAfter: HOP_BEAT }], { S: this.board.S }).then(() => {
      this.pos = to;
      this.trail.push(to);
      this._publishHook();
    });
  },

  check(moves) {
    this.verdict = chakraVerdict(this.board, moves);
    return this.verdict;
  },

  /** Post-run overlay: the referee's comparison route + verdict, drawn only now. */
  render() {
    this._draw();
  },

  caption() {
    const b = this.board;
    const p = CHAKRA_PRESETS[this.difficulty || 'easy'];
    return [
      `<strong>${p.label}</strong>`,
      `${b.R} rings · ${b.S} sectors`,
      `${b.warriors.length} warriors in the maze`,
      `gate sector ${b.centreGate}`,
    ].map((s) => `<span class="k">${s}</span>`).join('');
  },

  dispose() {
    if (this.animator) this.animator.cancel();
    if (this.container) this.container.textContent = '';
  },

  _refreshActive() {
    const bar = this.container && this.container.querySelector('#diff-bar');
    if (!bar) return;
    bar.querySelectorAll('.diff-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.diff === (this.difficulty || 'easy')));
  },

  // ---- drawing ------------------------------------------------------------
  _fit() {
    const cvs = this.canvas;
    const avail = Math.min(cvs.clientWidth || MAX_LOGICAL, MAX_LOGICAL);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const px = Math.max(64, Math.round(avail * dpr));
    if (cvs.width !== px || cvs.height !== px) {
      cvs.width = px;
      cvs.height = px;
    }
    this.dpr = dpr;
    this._cellPx = cvs.width / MAX_LOGICAL; // scale factor
    return cvs.width;
  },

  _cellPos(ring, sector) {
    const width = this.canvas.width;
    const pad = 0.08 * width;
    const maxR = width / 2 - pad;
    const R = this.board.R;
    const r = centreRadius(ring, maxR, R);
    const a = centreAngle(sector, this.board.S);
    return { x: width / 2 + r * Math.sin(a), y: width / 2 - r * Math.cos(a) };
  },

  _draw() {
    const cvs = this.canvas;
    if (!cvs) return;
    const width = this._fit();
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const b = this.board;
    const R = b.R, S = b.S;
    const pad = 0.08 * width;
    const maxR = width / 2 - pad;
    const unit = maxR / R;
    const ang = (2 * Math.PI) / S;
    const mid = width / 2;

    ctx.clearRect(0, 0, width, width);
    ctx.lineCap = 'round';

    // soft concentric rings
    ctx.strokeStyle = COL.ring;
    ctx.lineWidth = Math.max(1, 0.5 * this.dpr);
    for (let i = 1; i <= R; i++) {
      ctx.beginPath();
      ctx.arc(mid, mid, i * unit, 0, Math.PI * 2);
      ctx.stroke();
    }

    // radial walls: closed doors between ring i and i+1, drawn as arcs
    ctx.strokeStyle = COL.wallSoft;
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    for (let i = 1; i < R; i++) {
      for (let s = 0; s < S; s++) {
        if (b.openRadial[i - 1][s]) continue;
        ctx.beginPath();
        ctx.arc(mid, mid, i * unit, s * ang, (s + 1) * ang);
        ctx.stroke();
      }
    }

    // circular walls: closed doors between sector s and s+1 in ring i
    ctx.strokeStyle = COL.wall;
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    for (let i = 1; i <= R; i++) {
      const r0 = (i - 1) * unit, r1 = i * unit;
      for (let s = 0; s < S; s++) {
        if (b.openCirc[i - 1][s]) continue;
        const a = (s + 1) * ang;
        ctx.beginPath();
        ctx.moveTo(mid + r0 * Math.sin(a), mid - r0 * Math.cos(a));
        ctx.lineTo(mid + r1 * Math.sin(a), mid - r1 * Math.cos(a));
        ctx.stroke();
      }
    }

    // warriors: impassable dots
    ctx.fillStyle = COL.warrior;
    for (const w of b.warriors) {
      const p = this._cellPos(w.ring, w.sector);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, 0.16 * unit), 0, Math.PI * 2);
      ctx.fill();
    }

    // trail of visited cells (drawn faintly behind the moving token)
    if (this.trail.length > 1) {
      ctx.strokeStyle = COL.trail;
      ctx.lineWidth = Math.max(2, 3 * this.dpr);
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([]);
      ctx.beginPath();
      this.trail.forEach((c, idx) => {
        const p = this._cellPos(c.ring, c.sector);
        if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      const pos = this.pos;
      const pNow = this._cellPos(pos.ring, pos.sector);
      ctx.lineTo(pNow.x, pNow.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // the goal: a Lucide 'target'
    drawTargetIcon(ctx, mid, mid, Math.max(8, 0.32 * unit), Math.max(2, 2.5 * this.dpr));

    // Abhimanyu's portrait, resting on one side of the maze
    if (this.portrait.complete && this.portrait.naturalWidth > 0) {
      const size = Math.max(44, 0.16 * width);
      const x = width - size - 0.05 * width;
      const y = 0.05 * width;
      ctx.strokeStyle = COL.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.save();
      ctx.clip();
      ctx.drawImage(this.portrait, x, y, size, size);
      ctx.restore();
      ctx.stroke();
      ctx.fillStyle = COL.dim;
      ctx.font = `${Math.max(9, 0.014 * width)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Abhimanyu', x + size / 2, y + size + 10);
      ctx.textAlign = 'left';
    }

    // the moving token (interpolated polar position during a hop)
    const pos = this.pos;
    const p = this._cellPos(pos.ring, pos.sector);
    ctx.fillStyle = COL.token;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(3, 0.12 * unit), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COL.token;
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(6, 0.2 * unit), 0, Math.PI * 2);
    ctx.stroke();

    // referee overlay — only after the run finished (verdict cached by check())
    this._drawOverlay(ctx, width, unit);
    this._publishHook();
  },

  _drawOverlay(ctx, width, unit) {
    if (!this.verdict) return;
    const b = this.board;
    const v = this.verdict;

    if (v.optimalPath && v.optimalPath.length > 1) {
      ctx.strokeStyle = COL.target;
      ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
      ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
      ctx.beginPath();
      v.optimalPath.forEach((c, idx) => {
        const p = this._cellPos(c.ring, c.sector);
        if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `referee's shortest route · ${v.optimal} moves`;
      ctx.font = `600 ${Math.max(10, 0.014 * width)}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const lx = Math.max(8, width - tw - 8);
      ctx.fillStyle = 'rgba(14,17,24,0.82)';
      ctx.fillRect(lx - 6, 6, tw + 12, 20);
      ctx.fillStyle = COL.target;
      ctx.fillText(label, lx, 20);
    }
  },

  _publishHook() {
    if (typeof window === 'undefined') return;
    const b = this.board;
    window.__chakraLastRender = {
      rings: b.R,
      sectors: b.S,
      warriors: b.warriors,
      trailCells: this.trail.map((c) => ({ ring: c.ring, sector: c.sector })),
      pos: { ring: this.pos.ring, sector: this.pos.sector },
      atCentre: this.pos.ring === 0 && this.pos.sector === 0,
      difficulty: this.difficulty || 'easy',
      verdict: this.verdict ? { reached: this.verdict.reached, steps: this.verdict.steps, optimal: this.verdict.optimal } : null,
    };
  }
};