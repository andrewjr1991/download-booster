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
// most bytes left (or, given `score`, the one that will take longest: a big
// piece on a fast connection finishes before a small one on a slow
// connection). The running connection keeps the first half and stops at the
// new end; the returned segment is for a new connection.
export function splitLargest(segments, activeIds, minSplit = MIN_SPLIT, score = remaining) {
  let best = null;
  for (const s of segments) {
    if (!activeIds.has(s.id) || remaining(s) < 2 * minSplit) continue;
    if (!best || score(s) > score(best)) best = s;
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

// Connection count: start straight at `max` and stay there; go one lower only
// when the server pushes back (429/503, or it refuses an extra connection
// while the others are streaming). After a push-back, wait `cooldownMs`
// (doubling with each push-back, up to 4 minutes) and add one back, so the
// limit is never permanent.
//
// Measuring whether each extra connection helps (and stepping back when it
// did not) left fast servers on 2 connections: their speed swings by more
// than one connection adds, so the measurements said "no gain".
export class AdaptiveController {
  constructor({ max = 6, cooldownMs = 30000 } = {}) {
    this.max = Math.max(1, max);
    this.cooldownMs = cooldownMs;
    this.target = this.max;
    this.backoffs = 0;
    this.nextUpAt = null;
    this.levels = {}; // connections -> average bytes/s seen (debug view)
    this.last = null;
    this.spent = {}; // connections -> [ms, bytes] behind `levels`
  }

  // Called on every tick with the total bytes downloaded so far and how many
  // connections are currently receiving data. Returns the target.
  tick(now, bytes, streaming = this.target) {
    if (this.last && streaming >= this.target) {
      const acc = (this.spent[this.target] ??= [0, 0]);
      acc[0] += now - this.last[0];
      acc[1] += bytes - this.last[1];
      if (acc[0] >= 1000) this.levels[this.target] = Math.round((acc[1] * 1000) / acc[0]);
    }
    this.last = [now, bytes];
    this.target = Math.min(this.target, this.max);
    if (this.target < this.max && this.nextUpAt !== null && now >= this.nextUpAt) {
      this.target += 1;
      this.nextUpAt = this.target < this.max ? now + this.cooldownMs : null;
    }
    return this.target;
  }

  // The server pushed back: one connection fewer for a while.
  backoff(now) {
    // Several connections usually fail together; count that as one push-back.
    if (now - (this.lastBackoff ?? -Infinity) < 3000) return;
    this.lastBackoff = now;
    this.target = Math.max(1, this.target - 1);
    this.nextUpAt = now + this.cooldownMs * 2 ** Math.min(this.backoffs, 3);
    this.backoffs += 1;
  }

  // A new maximum (mirrors found, or ranges turned out unsupported): keep
  // any push-back and move by the difference.
  setMax(max) {
    max = Math.max(1, max);
    this.target = Math.max(1, Math.min(max, this.target + max - this.max));
    this.max = max;
  }

  snapshot() {
    return { target: this.target, levels: { ...this.levels } };
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

// Token bucket for the speed limit. Every connection of a task calls take()
// after receiving a chunk and waits the returned number of milliseconds
// before reading on, so the task's connections together stay at `rate`
// bytes/s (TCP flow control slows the server down while we wait).
// A rate of 0 means no limit.
export class RateLimiter {
  constructor(rate = 0) {
    this.tokens = 0;
    this.last = null;
    this.setRate(rate);
  }
  setRate(rate) {
    this.rate = rate > 0 ? rate : 0;
    // A quarter second of burst keeps reads smooth without overshooting.
    this.burst = Math.max(64 * 1024, this.rate / 4);
    this.tokens = Math.min(this.tokens, this.burst);
  }
  take(n, now) {
    if (!this.rate) return 0;
    if (this.last !== null) this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
    this.tokens -= n;
    return this.tokens < 0 ? Math.ceil((-this.tokens * 1000) / this.rate) : 0;
  }
}
