// lib/animator.js — the movement animation queue for the chakravyuha.
//
// DOM-free on purpose: the whole loop (queue, polar interpolation, cancel) is
// pure JavaScript driven by an injectable clock, so the suite can run
// deterministic tick-by-tick tests under Node without a browser.
//
// Design:
//   - The app pushes one hop per frame: play() queues a segment and returns a
//     promise the caller awaits; play() may be called again while a previous
//     queue is still running and the new segments are appended in order.
//   - Each segment = optional duration (defaults to the animator's) plus an
//     optional dwell after it (the "beat" before the next hop).
//   - onFrame gets the interpolated polar position every frame; the very last
//     frame is always the exact destination cell (t === 1).
//   - cancel() destroys the queue and resolves every pending promise with
//     'cancelled'; instant mode fires every queue entry at its destination
//     immediately, in order, so the run still finishes.
//   - progress is measured against an injected now(), and tick(now) is the
//     manual drive so tests need no timers at all.

/** Polar linear interpolation; sectors take the SHORT way around (wrap S-1→0). */
export function polarLerp(S, from, to, t) {
  const c = Math.min(1, Math.max(0, t));
  const ring = from.ring + (to.ring - from.ring) * c;
  let d = to.sector - from.sector;
  d = ((d + S / 2) % S + S) % S - S / 2; // shortest signed arc
  const sector = (from.sector + d * c + S) % S;
  return { ring, sector };
}

export const EASE_LINEAR = (t) => t;
export const EASE_EASE_OUT = (t) => 1 - (1 - t) * (1 - t);

const DEFAULT_FPS = 60;

/** One queue entry: an interpolated hop plus the beat before the next one. */
function normSegment(raw, duration) {
  return {
    from: raw.from,
    to: raw.to,
    dir: raw.dir ?? null,
    step: raw.step ?? null,
    duration: raw.duration ?? duration,
    dwell: raw.pauseAfter ?? raw.dwell ?? 0,
  };
}

export class Animator {
  constructor({ duration = 360, ease = EASE_EASE_OUT, onFrame = () => {}, now = null, instant = false } = {}) {
    this.duration = duration;
    this.ease = ease;
    this.onFrame = onFrame;
    this.now = now || (() => Date.now());
    this.instant = !!instant;
    this._segments = [];
    this._waiters = [];
    this._running = false;
    this._t0 = 0; // wall-time the current queue started (see _start())
    this._reported = null; // last position emitted, to avoid repeat frames
    this._frameTimer = null;
    this._lastAppend = 0;
    this._S = 0;
  }

  get running() { return this._running; }
  get queued() { return this._segments.length; }
  get mode() { return this.instant ? 'instant' : 'animated'; }

  /**
   * Queue a hop list. Each hop: { from, to, dir?, step?, duration?, pauseAfter? }.
   * Returns a promise resolved with 'finished' when the WHOLE queue has drained,
   * or 'cancelled' if cancel() fired first.
   */
  play(segments, { S } = {}) {
    if (S) this._S = S;
    const list = segments.map((s) => normSegment(s, this.duration));
    this._segments.push(...list);
    const done = new Promise((resolve) => this._waiters.push(resolve));
    if (!this._running) this._start(this._S);
    return done;
  }

  /** Immediately stop and abandon the queue, resolving penders with 'cancelled'. */
  cancel() {
    this._stopLoop();
    this._segments = [];
    this._running = false;
    const waiters = this._waiters;
    this._waiters = [];
    for (const r of waiters) r('cancelled');
  }

  get idle() { return !this._running && this._segments.length === 0; }

  /** Manual clock drive (tests): advance to wall-time `now`. */
  tick(now) {
    if (!this._running) return;
    this._advance(now - this._t0);
  }

  // ---- internals ----------------------------------------------------------
  _start(S) {
    this._running = true;
    this._t0 = this.now();
    if (this.instant) {
      this._runInstant();
      return;
    }
    this._reported = null;
    this._frame();
  }

  _stopLoop() {
    if (this._frameTimer !== null) {
      clearTimeout(this._frameTimer);
      this._frameTimer = null;
    }
  }

  _frame() {
    if (!this._running) return;
    this._advance(this.now() - this._t0);
    if (this._running) {
      // start the next frame from this point in time, clamping so a slow tab
      // never lets an idle visitor accumulate drift
      this._frameTimer = setTimeout(() => {
        this._frameTimer = null;
        this._frame();
      }, Math.max(4, Math.round(1000 / DEFAULT_FPS)));
    }
  }

  _advance(elapsed) {
    if (!this._segments.length) {
      this._running = false;
      this._finish();
      return;
    }
    let t = Math.max(0, elapsed);
    let segIdx = 0;
    const S = this._S;
    for (let i = 0; i < this._segments.length; i++) {
      const run = this._segments[i].duration + this._segments[i].dwell;
      if (t < run) { segIdx = i; break; }
      t -= run;
      if (i === this._segments.length - 1) { segIdx = this._segments.length; }
    }
    if (segIdx >= this._segments.length) {
      const last = this._segments[this._segments.length - 1];
      this._emit(last.to, 1, last);
      this._segments = [];
      this._running = false;
      this._finish();
      return;
    }
    const seg = this._segments[segIdx];
    const p = Math.min(t, seg.duration) / seg.duration;
    // stay at the destination during the dwell beat
    const pos = seg.duration > 0 ? polarLerp(S, seg.from, seg.to, seg.dwell > 0 ? Math.min(1, p) : p) : seg.to;
    this._emit(pos, Math.min(1, p), seg);
    if (this._segments.length === 0) this._running = false;
  }

  _emit(pos, progress, seg) {
    this.onFrame({ pos, progress, dir: seg.dir, step: seg.step });
  }

  _runInstant() {
    // Order-preserving, no timing: fire each hop at its destination.
    let i = 0;
    const step = () => {
      if (!this._running) return;
      const seg = this._segments[0];
      if (!seg) {
        this._running = false;
        this._finish();
        return;
      }
      this._emit(seg.to, 1, seg);
      this._segments.shift();
      if (this._segments.length) {
        // yield once so the browser can paint before the next hop
        setTimeout(step, 0);
      } else {
        this._running = false;
        this._finish();
      }
    };
    step();
  }

  _finish() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const r of waiters) r('finished');
  }
}