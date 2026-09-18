// skins/chakravyuha.js — the Chakravyuha skin: a polar ring maze on <canvas>,
// Abhimanyu moving ring by ring, warriors as dots, the centre as a Lucide
// 'target' and Abhimanyu's portrait resting on one side. Movement is animated
// through lib/animator.js; the shortest route is drawn ONLY after a run
// finishes and is labelled "shortest route" — never before, never to hint.
//
// Same skin contract the shell expects: mount / begin / newBoard /
// setDifficulty / board / check / render / caption / dispose. Plus
// this.animateHop(h) → Promise<...>, which the shell awaits inside the policy
// loop so the maze visibly paces the run.

import {
  makeChakraBoard, CHAKRA_PRESETS, DIFFICULTIES,
  centreRadius, centreAngle, cellKey,
} from '../lib/chakra.js';
import { Animator } from '../lib/animator.js';
import { drawTargetIcon, drawIcon } from '../lib/icons.js';

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
  // Ask mode: false = the whole policy in one call, true = one cell per call.
  stepByStep: false,

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
        <label class="check"><input type="checkbox" id="maze-step" /> step by step</label>
        <label class="check"><input type="checkbox" id="maze-warriors" /> obstacles (warriors)</label>
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

    // Step-by-step toggle: ask only about the cell Abhimanyu stands on, move one
    // step, then ask again from there. Persisted like the others, and read at ask
    // time — flipping it mid-run is deliberately ignored, since a run must be one
    // mode from start to finish or its numbers mean nothing.
    const stepBox = wrap.querySelector('#maze-step');
    stepBox.checked = this.stepByStep;
    stepBox.addEventListener('change', () => this.setStepByStep(stepBox.checked));

    // Obstacle toggle: warriors on (the real game) or off (a pure wall maze, so
    // the only thing that can stop a run is a wall). Redraws immediately.
    const warriorBox = wrap.querySelector('#maze-warriors');
    warriorBox.checked = this.obstacles;
    warriorBox.addEventListener('change', () => {
      this.setObstacles(warriorBox.checked);
      this.newBoard();
    });

    this.animator = new Animator({
      duration: STEPS_PER_HOP,
      onFrame: (f) => {
        this.pos = f.pos;
        this.dir = f.dir ?? null;
        this.progress = f.progress ?? 1;
        this._draw();
      },
    });
    this.animator._S = 0;
    this.dir = null;
    this.progress = 1;
    this._burstAt = 0;

    // Determinism: reduced-motion users and the headless harness (?anim=0) snap
    // between cells instead of tweening.
    const reduced = typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const noAnim = typeof location !== 'undefined' && /[?&]anim=0(?:&|$)/.test(location.search);
    if (reduced || noAnim) this.setAnimationDuration(0);

    this.portrait = new Image();
    this.portrait.src = './assets/abhimanyu.jpg';
    this.portrait.onload = () => this._draw();

    this.newBoard();
    this._refreshActive();
  },

  setInstant(v) {
    this.instant = !!v;
    if (this.animator) this.animator.instant = this.instant;
    // Persisted, like the obstacles toggle — otherwise the checkbox silently
    // resets on every reload while loadInstant() reads a key nothing wrote.
    try { localStorage.setItem('jev.instant', this.instant ? '1' : '0'); } catch { /* ignore */ }
  },

  /** Step-by-step on/off. Persisted so a reload keeps the user's choice. */
  setStepByStep(on) {
    this.stepByStep = !!on;
    try { localStorage.setItem('jev.step', this.stepByStep ? '1' : '0'); } catch { /* ignore */ }
  },

  /** Obstacles on/off. Persisted so a reload keeps the user's choice. */
  setObstacles(on) {
    this.obstacles = !!on;
    try { localStorage.setItem('jev.obstacles', this.obstacles ? 'on' : 'off'); } catch { /* ignore */ }
  },

  /**
   * 0 → snap between cells (no tween, no burst). Used by prefers-reduced-motion
   * and the ?anim=0 test hook so the harness is deterministic.
   */
  setAnimationDuration(ms) {
    const d = Math.max(0, Number(ms) || 0);
    this.animDuration = d;
    if (!this.animator) return;
    this.animator.duration = d;
    if (d === 0) {
      this.animator.instant = true;
      this._burstAt = 0;
    }
  },

  setDifficulty(diffKey) {
    if (!CHAKRA_PRESETS[diffKey]) return;
    this.difficulty = diffKey;
    try { localStorage.setItem('jev.difficulty', diffKey); } catch { /* ignore */ }
  },

  newBoard() {
    this.board = makeChakraBoard(this.difficulty || 'easy', Math.random, { warriors: this.obstacles !== false });
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

  /**
   * Post-run grading. The shell has already finished the run and — only now —
   * looked up the shortest route, which it passes in. The skin never searches.
   * The verdict is CACHED on `this` so the overlay draws and _publishHook
   * exposes it; without that the comparison route would never appear.
   */
  check(moves, opts = {}) {
    const reached = this.pos.ring === 0 && this.pos.sector === 0;
    this.verdict = {
      reached,
      steps: moves.length,
      optimal: opts.optimal ?? null,
      optimalPath: opts.optimalPath ?? null,
      optimalFromHere: opts.optimalFromHere ?? null,
    };
    return this.verdict;
  },

  /** Post-run overlay: the shortest route, drawn only now. */
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

    // warriors: impassable dots (a swords glyph inside, when the dot is big)
    const wR = Math.max(3, 0.16 * unit);
    for (const w of b.warriors) {
      const p = this._cellPos(w.ring, w.sector);
      ctx.fillStyle = COL.warrior;
      ctx.beginPath();
      ctx.arc(p.x, p.y, wR, 0, Math.PI * 2);
      ctx.fill();
      if (wR >= 11) {
        ctx.strokeStyle = 'rgba(24,10,10,0.85)';
        drawIcon(ctx, 'swords', p.x, p.y, wR * 1.5, { color: 'rgba(24,10,10,0.85)', lineWidth: Math.max(1, wR * 0.16) });
      }
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

    // the goal: a Lucide 'target' at the centre
    ctx.strokeStyle = COL.target;
    ctx.fillStyle = COL.target;
    drawTargetIcon(ctx, mid, mid, Math.max(8, 0.32 * unit), Math.max(2, 2.5 * this.dpr));

    // Abhimanyu himself — the moving sprite, drawn at his interpolated polar
    // position so a hop visibly travels ring by ring.
    this._drawAbhimanyu(ctx, this.pos, unit);

    // arrival burst: a one-shot sparkles flare on the target, only when the
    // run has genuinely finished at the centre.
    this._drawBurst(ctx, mid, unit);

    // comparison overlay — only after the run finished (verdict cached by check())
    this._drawOverlay(ctx, width, unit);
    this._publishHook();
  },

  /**
   * The sprite: Abhimanyu's artwork, circular-clipped, at his interpolated
   * position. A lead-in scale pulse makes the hop read as movement, a subtle
   * tilt faces the direction of travel, and a soft shadow follows him.
   */
  _drawAbhimanyu(ctx, pos, unit) {
    const p = this._cellPos(pos.ring, pos.sector);
    const r = Math.max(9, 0.42 * unit);
    const moving = !!(this.animator && this.animator.running);
    const pr = moving ? Math.min(1, Math.max(0, this.progress ?? 1)) : 1;
    const pulse = 1 + 0.06 * Math.sin(Math.PI * pr); // 1.00 → 1.06 → 1.00
    const size = r * 2 * pulse;
    const half = size / 2;
    const tilt = this.dir === 'clockwise' ? 0.30
      : this.dir === 'counterclockwise' ? -0.30
        : 0;

    // soft drop shadow that travels with him
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + half * 0.62, half * 0.62, half * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(tilt);

    // halo ring
    ctx.beginPath();
    ctx.arc(0, 0, half + Math.max(1.5, 0.035 * unit), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14,17,24,0.92)';
    ctx.fill();
    ctx.strokeStyle = COL.token;
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.stroke();

    if (this.portrait.complete && this.portrait.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, half, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(this.portrait, -half, -half, size, size);
      ctx.restore();
    } else {
      // fallback when the artwork has not loaded: a crown token
      ctx.fillStyle = COL.token;
      ctx.beginPath();
      ctx.arc(0, 0, half * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // the crown badge
    ctx.strokeStyle = '#fbbf24';
    ctx.fillStyle = '#fbbf24';
    drawIcon(ctx, 'crown', 0, -half - Math.max(4, 0.11 * unit), Math.max(6, 0.22 * unit), { color: '#fbbf24', lineWidth: Math.max(1, 1.7 * this.dpr) });
    ctx.restore();
  },

  /** One-shot arrival flare on the target, driven by wall-clock time. */
  _drawBurst(ctx, mid, unit) {
    if (!this._burstAt) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const t = (now - this._burstAt) / 900;
    if (t >= 1) { this._burstAt = 0; return; }
    const grow = 0.6 + 1.5 * t;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = COL.target;
    ctx.fillStyle = COL.target;
    drawIcon(ctx, 'sparkles', mid, mid, Math.max(10, unit * grow * 2.4), { lineWidth: Math.max(1.5, 2 * this.dpr) });
    ctx.restore();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => this._draw());
    } else {
      this._burstAt = 0;
    }
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
      const label = `shortest route · ${v.optimal} moves`;
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
    const snap = {
      rings: b.R,
      sectors: b.S,
      warriors: b.warriors,
      trailCells: this.trail.map((c) => ({ ring: c.ring, sector: c.sector })),
      pos: { ring: this.pos.ring, sector: this.pos.sector },
      atCentre: this.pos.ring === 0 && this.pos.sector === 0,
      difficulty: this.difficulty || 'easy',
      verdict: this.verdict ? { reached: this.verdict.reached, steps: this.verdict.steps, optimal: this.verdict.optimal } : null,
    };
    window.__chakraLastRender = snap;

    // live status line beside the maze (the Abhimanyu panel)
    const el = typeof document !== 'undefined' && document.getElementById('abhi-status');
    if (el) {
      const steps = Math.max(0, this.trail.length - 1);
      const where = this.pos.ring === 0 ? 'at the centre' : `ring ${this.pos.ring}, sector ${this.pos.sector}`;
      const v = this.verdict;
      const outcome = v
        ? (v.reached ? 'reached the centre ✓' : 'did not reach the centre')
        : null;
      el.innerHTML =
        `<span class="k">${escapeText(where)}</span>` +
        `<span class="k">${steps} step${steps === 1 ? '' : 's'}</span>` +
        (b.warriors.length > 0 ? `<span class="k">${b.warriors.length} warriors avoided</span>` : '<span class="k">no obstacles</span>') +
        (outcome ? `<span class="k ${v.reached ? 'good' : 'bad'}">${outcome}</span>` : '');
    }
  }
};

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}