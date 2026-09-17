// skins/grid.js — the generic grid puzzle skin (canvas).
//
// The game loop rule stands: this skin only serialises the current board
// (state/questions are built by lib/jev.js), and after Jev answers it uses
// lib/referee.js walkPath() to DRAW the returned moves. It never searches.

import { makeGridBoard, GRID_PRESETS } from '../lib/board.js';
import { buildGridState, buildGridQuestions, answerMoves, answerCells } from '../lib/jev.js';
import { verdict, walkPath } from '../lib/referee.js';

export const gridSkin = {
  id: 'grid',
  label: 'Grid',

  mount({ container }) {
    const wrap = document.createElement('div');
    wrap.className = 'skin-controls';
    wrap.innerHTML = `
      <label>Difficulty
        <select id="grid-difficulty">
          ${Object.entries(GRID_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
      </label>
      <button id="grid-randomize" class="ghost" type="button">🎲 Randomize obstacles</button>
      <label class="check"><input type="checkbox" id="grid-heatmap" /> also ask per-cell “is this cell on the path?”</label>
      <label class="check"><input type="checkbox" id="grid-animate" checked /> animate the path</label>`;
    container.appendChild(wrap);

    const sel = wrap.querySelector('#grid-difficulty');
    sel.value = 'medium';
    this.board = makeGridBoard('medium');
    this.heat = new Map();
    this.pathCells = [];
    this.animating = false;

    wrap.querySelector('#grid-randomize').addEventListener('click', () => this.reset());
    sel.addEventListener('change', () => this.reset());
    wrap.querySelector('#grid-heatmap').addEventListener('change', () => this.draw());
    wrap.querySelector('#grid-animate').addEventListener('change', () => {});
  },

  reset() {
    const key = document.querySelector('#grid-difficulty')?.value || 'medium';
    this.board = makeGridBoard(key);
    this.heat = new Map();
    this.pathCells = [];
    this.animating = false;
    this.draw();
    return this.begin();
  },

  begin() {
    const board = this.board || makeGridBoard('medium');
    this.heat = new Map();
    this.pathCells = [];
    this.animating = false;
    this.draw();
    const withCells = !!document.querySelector('#grid-heatmap')?.checked;
    return { state: buildGridState(board), questions: buildGridQuestions(board, withCells) };
  },

  check(moves) {
    return verdict(this.board, moves);
  },

  caption() {
    return `
      <span class="k"><i class="sw s"></i>S start</span>
      <span class="k"><i class="sw d"></i>D goal</span>
      <span class="k"><i class="sw w"></i># wall</span>
      <span class="k"><i class="sw p"></i>Jev's path</span>`;
  },

  draw() {
    const board = this.board;
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    const { R, C } = board;
    const W = canvas.width, H = canvas.height;
    const cell = Math.floor(Math.min(W / C, H / R));
    const ox = Math.floor((W - cell * C) / 2);
    const oy = Math.floor((H - cell * R) / 2);

    ctx.clearRect(0, 0, W, H);
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const x = ox + c * cell, y = oy + r * cell;
        const ch = board.rows[r][c];
        if (ch === '#') {
          ctx.fillStyle = '#2b3140';
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        } else {
          ctx.fillStyle = '#12151c';
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          const p = this.heat.get(`${r},${c}`);
          if (p !== undefined) {
            ctx.fillStyle = `rgba(244,114,182,${(p * 0.55).toFixed(3)})`;
            ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          }
        }
        if (ch === 'S' || ch === 'D') {
          ctx.fillStyle = ch === 'S' ? '#60a5fa' : '#4ade80';
          ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
          ctx.fillStyle = '#0b0c10';
          ctx.font = `700 ${Math.floor(cell * 0.5)}px ui-monospace,monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(ch, x + cell / 2, y + cell / 2 + 1);
        }
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= C; c++) { ctx.beginPath(); ctx.moveTo(ox + c * cell, oy); ctx.lineTo(ox + c * cell, oy + R * cell); ctx.stroke(); }
    for (let r = 0; r <= R; r++) { ctx.beginPath(); ctx.moveTo(ox, oy + r * cell); ctx.lineTo(ox + C * cell, oy + r * cell); ctx.stroke(); }

    if (this.pathCells.length > 1) {
      ctx.strokeStyle = '#f472b6';
      ctx.lineWidth = Math.max(3, cell * 0.16);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      this.pathCells.forEach((p, i) => {
        const x = ox + p.c * cell + cell / 2, y = oy + p.r * cell + cell / 2;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      this.pathCells.forEach((p, i) => {
        if (i === 0 || i === this.pathCells.length - 1) return;
        ctx.fillStyle = '#fbcfe8';
        ctx.beginPath();
        ctx.arc(ox + p.c * cell + cell / 2, oy + p.r * cell + cell / 2, Math.max(1.5, cell * 0.07), 0, 7);
        ctx.fill();
      });
    }
  },

  render(res) {
    const moves = answerMoves(res.answers);
    const { walk } = verdict(this.board, moves);
    this.pathCells = walk.cells;
    this.heat = answerCells(res.answers);

    if (!document.querySelector('#grid-animate')?.checked) { this.draw(); return; }
    this.animating = true;
    const cells = this.pathCells;
    let i = 1;
    const step = () => {
      if (i > cells.length) { this.animating = false; this.draw(); return; }
      this.pathCells = cells.slice(0, i);
      this.draw();
      i++;
      if (i <= cells.length) this.animTimer = setTimeout(step, 55);
    };
    this.animTimer = setTimeout(step, 55);
  },

  dispose() {
    if (this.animTimer) clearTimeout(this.animTimer);
    this.animTimer = null;
  },
};