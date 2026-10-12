// Pure scheduling logic: byte segments plus the adaptive concurrency controller.
// No browser APIs here, so the whole thing is unit-tested under Node.

export const MIN_SPLIT = 1 << 20; // never create a segment smaller than 1 MiB

// A segment covers bytes [start, end) of the file; pos is the next byte to write.
export function remaining(seg) {
  return Math.max(0, seg.end - seg.pos);
}

export function totalRemaining(segments) {
  return segments.reduce((sum, s) => sum + remaining(s), 0);
}

export function downloadedBytes(segments) {
  return segments.reduce((sum, s) => sum + (s.pos - s.start), 0);
}

function nextId(segments) {
  return segments.reduce((max, s) => Math.max(max, s.id), -1) + 1;
}

// Dynamic segmentation: carve the second half off the active segment with the
// most bytes left. The running connection keeps the first half and stops at
// the new end; the returned segment is for a new connection.
export function splitLargest(segments, activeIds, minSplit = MIN_SPLIT) {
  let best = null;
  for (const s of segments) {
    if (!activeIds.has(s.id) || remaining(s) < 2 * minSplit) continue;
    if (!best || remaining(s) > remaining(best)) best = s;
  }
  if (!best) return null;
  const mid = best.pos + Math.floor(remaining(best) / 2);
  const seg = { id: nextId(segments), start: mid, end: best.end, pos: mid };
  best.end = mid;
  segments.push(seg);
  return seg;
}

export function sortedSegments(segments) {
  return [...segments].sort((a, b) => a.start - b.start);
}

// Adaptive concurrency: start with 1 connection and add more while the
// measured speed keeps rising by at least `gain` (doubling while the gain is
// near-linear, then one at a time), step back to the best level when it
// plateaus, and occasionally re-probe one level higher.
export class AdaptiveController {
  constructor({
    max = 6,
    warmupMs = 2000,
    probeMs = 2500,
    gain = 1.15,
    reprobeMs = 20000,
  } = {}) {
    this.max = Math.max(1, max);
    this.warmupMs = warmupMs;
    this.probeMs = probeMs;
    this.gain = gain;
    this.reprobeMs = reprobeMs;
    this.target = 1;
    this.best = 1;
    this.phase = 'measure';
    this.phaseStart = null;
    this.baseline = null; // speed at the best level so far
    this.singleSpeed = null; // speed measured with one connection
    this.levels = {}; // connections -> measured bytes/s
    this.slowStart = true;
  }

  // Called on every tick with the current smoothed speed (bytes/s) and how
  // many connections are actually running. Returns the new target.
  tick(now, speed, active) {
    if (this.phaseStart === null) this.phaseStart = now;
    const elapsed = now - this.phaseStart;

    if (this.phase === 'measure') {
      const wait = this.target === 1 && this.singleSpeed === null ? this.warmupMs : this.probeMs;
      if (active < this.target) {
        // Not enough work left to run the level we wanted to test.
        if (elapsed > wait * 2) this.#settle(now, Math.min(this.best, active || 1));
        return this.target;
      }
      if (elapsed < wait) return this.target;

      this.levels[this.target] = Math.round(speed);
      if (this.target === 1 && this.singleSpeed === null) this.singleSpeed = speed;

      if (this.baseline === null) {
        this.#accept(now, speed);
      } else if (speed >= this.baseline * this.gain) {
        // Slow start: while each added connection brings close to a full
        // connection's worth of speed, double instead of adding one.
        const added = this.target - this.best;
        const perConn = this.baseline / this.best;
        if ((speed - this.baseline) / added < 0.7 * perConn) this.slowStart = false;
        this.#accept(now, speed);
      } else if (this.target - this.best > 1) {
        // Overshot while doubling: try one above the best level instead.
        this.slowStart = false;
        this.target = this.best + 1;
        this.phaseStart = now;
      } else {
        this.#settle(now, this.best);
      }
      return this.target;
    }

    // stable
    if (elapsed >= this.reprobeMs && this.target < this.max && active >= this.target) {
      this.slowStart = false;
      this.baseline = speed;
      this.best = this.target;
      this.target += 1;
      this.phase = 'measure';
      this.phaseStart = now;
    }
    return this.target;
  }

  // Server pushed back (429/503): drop a connection and stop probing upward.
  backoff(now) {
    this.max = Math.max(1, this.target - 1);
    this.#settle(now, this.max);
  }

  #accept(now, speed) {
    this.best = this.target;
    this.baseline = speed;
    if (this.target >= this.max) return this.#settle(now, this.target);
    this.target = this.slowStart ? Math.min(this.max, this.target * 2) : this.target + 1;
    this.phaseStart = now;
  }

  #settle(now, level) {
    this.target = Math.max(1, Math.min(level, this.max));
    this.best = this.target;
    this.phase = 'stable';
    this.phaseStart = now;
  }

  snapshot() {
    return {
      target: this.target,
      phase: this.phase,
      singleSpeed: this.singleSpeed,
      levels: { ...this.levels },
    };
  }
}

// Moving-window speed meter.
export class SpeedMeter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = [];
  }
  add(now, totalBytes) {
    this.samples.push([now, totalBytes]);
    while (this.samples.length > 2 && now - this.samples[1][0] >= this.windowMs) this.samples.shift();
  }
  speed() {
    if (this.samples.length < 2) return 0;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }
}
