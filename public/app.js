// app.js — the whole game.
//
// THE RULE: there is no pathfinding in this file.
// The board is serialised into a `state`, a fan-out of typed questions is sent
// to Jev in ONE request, and the direction list Jev returns is applied
// verbatim. referee.js is used only to *check* the answer afterwards.

import { verdict, shortestPathLength } from './referee.js';

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

const DIFFICULTY = {
  easy:   { R: 8,  C: 8,  density: 0.14 },
  medium: { R: 12, C: 12, density: 0.20 },
  hard:   { R: 16, C: 16, density: 0.26 },
};

const DIR_OPTIONS = {
  up: 'move one cell up',
  down: 'move one cell down',
  left: 'move one cell left',
  right: 'move one cell right',
  stop: 'the path has no more moves (you have already reached D)',
};

let board = null;
let pathCells = [];
let heat = new Map();      // "r,c" -> probability
let animating = false;

// ---------------------------------------------------------------- board gen
function makeBoard(diffKey) {
  const { R, C, density } = DIFFICULTY[diffKey];
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = Array.from({ length: R }, () => new Array(C).fill('.'));
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        if (Math.random() < density) rows[r][c] = '#';

    const src = { r: 0, c: 0 };
    const dst = { r: R - 1, c: C - 1 };
    rows[src.r][src.c] = 'S';
    rows[dst.r][dst.c] = 'D';

    const b = { R, C, rows, src, dst, difficulty: diffKey };
    const len = shortestPathLength(b);           // generation sanity only
    if (len !== null && len >= Math.max(4, Math.round((R + C) * 0.5))) return b;
  }
  // fall back to whatever we last produced
  return { R, C, rows: board?.rows, src: { r: 0, c: 0 }, dst: { r: R - 1, c: C - 1 }, difficulty: diffKey };
}

// ------------------------------------------------------------------ render
function draw() {
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

        const p = heat.get(`${r},${c}`);
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

  // grid lines
  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.lineWidth = 1;
  for (let c = 0; c <= C; c++) { ctx.beginPath(); ctx.moveTo(ox + c * cell, oy); ctx.lineTo(ox + c * cell, oy + R * cell); ctx.stroke(); }
  for (let r = 0; r <= R; r++) { ctx.beginPath(); ctx.moveTo(ox, oy + r * cell); ctx.lineTo(ox + C * cell, oy + r * cell); ctx.stroke(); }

  if (pathCells.length > 1) {
    ctx.strokeStyle = '#f472b6';
    ctx.lineWidth = Math.max(3, cell * 0.16);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    pathCells.forEach((p, i) => {
      const x = ox + p.c * cell + cell / 2, y = oy + p.r * cell + cell / 2;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    pathCells.forEach((p, i) => {
      if (i === 0 || i === pathCells.length - 1) return;
      ctx.fillStyle = '#fbcfe8';
      ctx.beginPath();
      ctx.arc(ox + p.c * cell + cell / 2, oy + p.r * cell + cell / 2, Math.max(1.5, cell * 0.07), 0, 7);
      ctx.fill();
    });
  }
}

// --------------------------------------------------------------- questions
function buildQuestions(b) {
  const K = Math.min(b.R * b.C, 64);
  const q = {
    reachable: {
      type: 'noul',
      instructions: 'Is the destination D reachable from the source S without entering any wall?',
      criteria: { true: 'a path from S to D exists', false: 'no path from S to D exists' },
    },
    path_length: {
      type: 'choice',
      instructions: 'How many single-cell moves does the shortest path from S to D take?',
      criteria: { '1-5': null, '6-10': null, '11-15': null, '16-20': null, '21-30': null, '31-50': null, '51+': null },
    },
    maze_difficulty: {
      type: 'score',
      instructions: 'How hard is this maze to solve by eye?',
      criteria: ['trivial', 'easy', 'moderate', 'hard', 'brutal'],
    },
  };
  for (let k = 1; k <= K; k++) {
    q[`move_${k}`] = {
      type: 'choice',
      instructions:
        `Consider the shortest path from S to D on the grid in state.grid. ` +
        `Movement is 4-directional (up, down, left, right), diagonals are not allowed, and walls (#) cannot be entered. ` +
        `What is the direction of move number ${k} along that shortest path? ` +
        `Answer "stop" if the shortest path contains fewer than ${k} moves.`,
      criteria: DIR_OPTIONS,
    };
  }
  if (document.getElementById('heatmap').checked) {
    for (let r = 0; r < b.R; r++)
      for (let c = 0; c < b.C; c++)
        if (b.rows[r][c] !== '#')
          q[`cell_${r}_${c}`] = {
            type: 'noul',
            instructions: `Is the cell at row ${r}, column ${c} (0-indexed, top-left is row 0 column 0) on the shortest path from S to D?`,
          };
  }
  return q;
}

function buildState(b) {
  return {
    task: 'grid_pathfinding',
    grid: b.rows.map((row) => row.join('')),
    legend: { S: 'source', D: 'destination', '#': 'wall (impassable)', '.': 'open cell' },
    source: { row: b.src.r, col: b.src.c },
    destination: { row: b.dst.r, col: b.dst.c },
    rules: 'Grid coordinates are (row, col), 0-indexed, row 0 at the top. Moves are 4-directional. Diagonals are not allowed. Walls cannot be entered.',
    objective: 'Find the shortest path from S to D, expressed as an ordered list of single-cell moves.',
  };
}

// ---------------------------------------------------------------- the call
async function askJev() {
  if (animating) return;
  const btn = document.getElementById('ask');
  btn.disabled = true;
  pathCells = [];
  heat = new Map();
  draw();

  const state = buildState(board);
  const questions = buildQuestions(board);
  document.getElementById('state-pre').textContent =
    JSON.stringify({ state, questions: Object.fromEntries(Object.entries(questions).slice(0, 3)) }, null, 2) +
    `\n… plus ${Object.keys(questions).length - 3} more questions in the same request.`;

  let res, err = null;
  try {
    const r = await fetch('/api/jev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions }),
    });
    res = await r.json();
    if (!r.ok) err = res.error || `HTTP ${r.status}`;
  } catch (e) { err = e.message; }

  btn.disabled = false;
  if (err) {
    document.getElementById('answers').innerHTML = `<div class="ans"><span class="val" style="color:var(--bad)">error: ${escapeHtml(String(err))}</span></div>`;
    return;
  }

  renderAnswers(res);
  applyPath(res);
  renderReferee(res);
}

function applyPath(res) {
  const moves = [];
  for (const key of Object.keys(res.answers).filter((k) => k.startsWith('move_')).sort((a, b) => num(a) - num(b))) {
    const a = res.answers[key];
    if (a?.type === 'choice') moves.push(a.choice);
  }
  const { walk } = verdict(board, moves);
  pathCells = walk.cells;

  if (!document.getElementById('animate').checked) { draw(); return; }
  animating = true;
  let i = 1;
  const step = () => {
    if (i > pathCells.length) { animating = false; return; }
    const partial = pathCells.slice(0, i);
    const full = pathCells; pathCells = partial; draw(); pathCells = full;
    i++;
    setTimeout(step, 55);
  };
  step();
}

function renderAnswers(res) {
  const box = document.getElementById('answers');
  const entries = Object.entries(res.answers);
  const moves = entries.filter(([k]) => k.startsWith('move_')).sort((a, b) => num(a[0]) - num(b[0]));
  const cells = entries.filter(([k]) => k.startsWith('cell_'));
  const meta = entries.filter(([k]) => !k.startsWith('move_') && !k.startsWith('cell_'));

  const row = (id, val, conf, low) => `
    <div class="ans ${low ? 'low' : ''}">
      <span class="id">${escapeHtml(id)}</span>
      <span class="val">${escapeHtml(val)}</span>
      <span class="conf">${conf}</span>
      <div class="bar"><i style="width:${confPct(conf)}%"></i></div>
    </div>`;

  let html = '';
  for (const [id, a] of meta) {
    html += row(id, String(a.choice ?? a.noul ?? a.score ?? '?'), a.confidence !== undefined ? a.confidence.toFixed(2) : 'prob', (a.confidence ?? 1) < 0.6);
  }
  const shown = moves.slice(0, 14);
  for (const [id, a] of shown) {
    const p = a.probabilities?.[a.choice];
    html += row(id, a.choice, p !== undefined ? p.toFixed(2) : '', (a.confidence ?? 1) < 0.6);
  }
  if (moves.length > shown.length) html += `<div class="ans"><span class="id">…</span><span class="val">${moves.length - shown.length} more move questions</span><span class="conf"></span></div>`;
  if (cells.length) html += `<div class="ans"><span class="id">cell_*</span><span class="val">${cells.length} per-cell probabilities → heat overlay</span><span class="conf"></span></div>`;

  box.classList.remove('empty');
  box.innerHTML = html;

  // heat overlay
  heat = new Map();
  for (const [id, a] of cells) {
    const [, r, c] = id.split('_');
    heat.set(`${r},${c}`, a.noul);
  }
}

function renderReferee(res) {
  const moves = Object.keys(res.answers).filter((k) => k.startsWith('move_')).sort((a, b) => num(a) - num(b))
    .map((k) => res.answers[k].choice);
  const v = verdict(board, moves);
  const box = document.getElementById('referee');
  box.classList.remove('empty');
  box.innerHTML =
    v.checks.map((c) => `<div class="chk ${c.pass ? 'pass' : 'fail'}">
        <span class="mark">${c.pass ? '✓' : '✗'}</span>
        <span>${escapeHtml(c.name)}${c.detail ? ` <span class="why">(${escapeHtml(c.detail)})</span>` : ''}</span>
      </div>`).join('') +
    `<div class="verdict ${v.ok ? 'ok' : 'no'}">${v.ok ? 'Jev solved it optimally.' : 'Jev did not solve it optimally.'}</div>`;

  document.getElementById('m-ms').textContent = `${res._ms ?? '?'} ms`;
  document.getElementById('m-cost').textContent = res._cost_usd !== undefined ? `$${res._cost_usd.toFixed(6)}` : '—';
  document.getElementById('m-q').textContent = String(res._questions ?? '—');
  document.getElementById('m-rt').textContent = '1';
}

const num = (s) => Number(s.slice(5));
const confPct = (c) => { const n = Number(c); return Number.isFinite(n) ? Math.round(n * 100) : 100; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// -------------------------------------------------------------------- wiring
function reset() {
  board = makeBoard(document.getElementById('difficulty').value);
  pathCells = []; heat = new Map();
  document.getElementById('answers').classList.add('empty');
  document.getElementById('answers').textContent = 'Nothing yet. Press “Ask Jev”.';
  document.getElementById('referee').classList.add('empty');
  document.getElementById('referee').textContent = '—';
  ['m-ms', 'm-cost', 'm-q', 'm-rt'].forEach((id) => (document.getElementById(id).textContent = '—'));
  draw();
}

document.getElementById('randomize').addEventListener('click', reset);
document.getElementById('difficulty').addEventListener('change', reset);
document.getElementById('ask').addEventListener('click', askJev);
document.getElementById('heatmap').addEventListener('change', () => draw());

fetch('/api/health').then((r) => r.json()).then((h) => {
  const el = document.getElementById('mode');
  el.textContent = h.stub ? 'STUB — no API key, answers are local BFS' : `LIVE — ${h.model}`;
  el.classList.add(h.stub ? 'stub' : 'live');
}).catch(() => { document.getElementById('mode').textContent = 'offline'; });

reset();
