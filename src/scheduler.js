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
// plateaus, and re-probe one level higher every `reprobeMs`.
//
// Each level is judged on its average throughput over `measureMs`, and the
// clock only starts once every connection of that level is streaming and has
// had `settleMs` to ramp up. Judging a level while its newest connection is
// still connecting makes the extra connection look useless.
export class AdaptiveController {
  constructor({
    max = 6,
    settleMs = 1000,
    measureMs = 3000,
    rampTimeoutMs = 10000,
    gain = 1.12,
    reprobeMs = 20000,
    cooldownMs = 30000,
  } = {}) {
    this.max = Math.max(1, max);
    this.settleMs = settleMs;
    this.measureMs = measureMs;
    this.rampTimeoutMs = rampTimeoutMs;
    this.gain = gain;
    this.reprobeMs = reprobeMs;
    this.cooldownMs = cooldownMs;
    this.target = 1;
    this.best = 1;
    this.baseline = null; // average speed at the best level so far
    this.singleSpeed = null; // average speed measured with one connection
    this.levels = {}; // connections -> measured bytes/s
    this.slowStart = true;
    this.backoffs = 0;
    this.samples = []; // [time, bytes] for the rolling baseline
    this.#raise(null, 1);
  }

  // Called on every tick with the total bytes downloaded so far and how many
  // connections are currently receiving data. Returns the new target.
  tick(now, bytes, streaming) {
    this.samples.push([now, bytes]);
    while (this.samples.length > 2 && now - this.samples[1][0] >= this.measureMs) this.samples.shift();
    if (this.phaseStart === null) this.phaseStart = now;

    if (this.phase === 'ramp') {
      if (streaming >= this.target) {
        this.readySince ??= now;
        if (now - this.readySince >= this.settleMs) {
          this.phase = 'measure';
          this.measureStart = now;
          this.measureBytes = bytes;
        }
      } else {
        this.readySince = null;
        // The level could not be filled (no work left to split, or a
        // connection never got going): keep what we had.
        if (now - this.phaseStart > this.rampTimeoutMs) this.#settle(now, this.best, this.reprobeMs);
      }
    } else if (this.phase === 'measure') {
      if (streaming < this.target) {
        // A connection dropped out mid-measurement; wait for it again.
        this.phase = 'ramp';
        this.phaseStart = now;
        this.readySince = null;
      } else if (now - this.measureStart >= this.measureMs) {
        this.#judge(now, ((bytes - this.measureBytes) * 1000) / (now - this.measureStart));
      }
    } else if (now >= this.nextProbeAt && this.target < this.max && streaming >= this.target) {
      // stable: try one more connection against the recent average.
      this.baseline = this.#rollingSpeed();
      this.best = this.target;
      this.slowStart = false;
      this.#raise(now, this.target + 1);
    }
    return this.target;
  }

  #judge(now, speed) {
    this.levels[this.target] = Math.round(speed);
    if (this.baseline === null) {
      if (this.target === 1) this.singleSpeed = speed;
      return this.#accept(now, speed);
    }
    if (speed >= this.baseline * this.gain) {
      // Keep doubling only while each added connection brings close to a
      // full connection's worth of speed.
      const added = this.target - this.best;
      const perConn = this.baseline / this.best;
      if ((speed - this.baseline) / added < 0.7 * perConn) this.slowStart = false;
      return this.#accept(now, speed);
    }
    if (this.target - this.best > 1) {
      // Overshot while doubling: try one above the best level instead.
      this.slowStart = false;
      return this.#raise(now, this.best + 1);
    }
    this.#settle(now, this.best, this.reprobeMs);
  }

  #accept(now, speed) {
    this.best = this.target;
    this.baseline = speed;
    if (this.target >= this.max) return this.#settle(now, this.target, this.reprobeMs);
    this.#raise(now, this.slowStart ? Math.min(this.max, this.target * 2) : this.target + 1);
  }

  #raise(now, level) {
    this.target = Math.min(level, this.max);
    this.phase = 'ramp';
    this.phaseStart = now;
    this.readySince = null;
  }

  #settle(now, level, wait) {
    this.target = Math.max(1, Math.min(level, this.max));
    this.best = this.target;
    this.phase = 'stable';
    this.nextProbeAt = now + wait;
  }

  #rollingSpeed() {
    if (this.samples.length < 2) return 0;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }

  // Server pushed back (429/503): drop one connection and wait before probing
  // upward again. The wait doubles with each push-back, up to 4 minutes, but
  // the limit is never permanent.
  backoff(now) {
    // Several connections usually fail together; count that as one push-back.
    if (now - (this.lastBackoff ?? -Infinity) < 3000) return;
    this.lastBackoff = now;
    const wait = this.cooldownMs * 2 ** Math.min(this.backoffs, 3);
    this.backoffs += 1;
    this.slowStart = false;
    this.#settle(now, this.target - 1, wait);
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
