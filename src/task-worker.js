// One dedicated worker per download task. It owns the task's OPFS file through
// a sync access handle (only available in workers), runs every connection's
// fetch, and writes each chunk at its byte offset. When the user picked a
// download folder, the file is written straight into it instead (as
// "<name>.part", renamed when done); the browser commits those writes when
// the file is closed, so pausing is what makes the progress stick.

import {
  AdaptiveController,
  SpeedMeter,
  MIN_SPLIT,
  remaining,
  totalRemaining,
  downloadedBytes,
  splitLargest,
  missingRanges,
  RateLimiter,
} from './scheduler.js';
import { parseContentRange, pickFilename, isThrottleStatus, applyRename } from './http.js';
import { uniqueName, finalize } from './folder.js';
import { createHash, ALGO_NAMES } from './hash.js';

const TICK_MS = 500;
const CHECKPOINT_MS = 2000;
const MAX_FAILURES = 8;
const STALL_MS = 15000; // a connection silent this long is restarted
const FRESH_MS = 3000; // a connection counts as streaming if data came this recently
// One connection can be many times slower than another to the same server
// (a different server behind the address, a congested route). A connection
// far slower than the fastest one seen lately is dropped and its piece
// requested again on a new connection.
const CONN_WINDOW_MS = 2500; // per-connection speed is measured over this
const SLOW_GRACE_MS = 3000; // a new connection gets this long to get going
const SLOW_RATIO = 0.2; // slower than this share of the fastest one is "slow"
const FAST_MEMORY_MS = 30000; // how long the fastest connection speed counts
const MIN_FAST = 512 * 1024; // below this nothing is fast enough to compare with
const TAIL_BYTES = 32 * 1024 * 1024; // near the end, split pieces finer
const TAIL_SPLIT = 256 * 1024;

// Chrome keeps separate connection pools for requests with and without
// cookies. On HTTP/2 every request to a host shares one TCP connection, so
// alternating the two pools is the only way an extension gets a second TCP
// connection. Cookie-less requests are dropped for the task if the server
// answers them differently (login-protected files).
const POOLS = ['include', 'omit'];
let omitPool = 'untested'; // 'untested' | 'ok' | 'bad'
let protocol = null;

let task;
let handle; // where the bytes go: OpfsFile or FolderFile
// Where the bytes come from: the file's own address, plus mirrors (other
// addresses of the same file) once they have shown the same size. Each
// connection picks the one with the fewest connections, so a mirror on
// another server adds its bandwidth and its own connection limit.
let sources = [];
const primary = () => sources[0];
let controller;
const meter = new SpeedMeter(2000);
const limiter = new RateLimiter(0); // this task's share of the global speed limit
const conns = new Map(); // segment id -> {ac, seg}
const retryAt = new Map(); // segment id -> timestamp before which it waits
let segments = [];
let stopping = false;
let finished = false;
let failures = 0;
let rateGen = 0; // bumped when the speed limit changes
let restarted = false;
let ticker;
let lastCheckpoint = 0;
let peakSpeed = 0;
let activeMs = 0;
let lastTick = 0;
let fastest = { speed: 0, at: 0 }; // fastest single connection lately
let replaced = 0; // slow connections dropped

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}
class ChangedError extends Error {}

const post = (msg) => self.postMessage(msg);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m.task).catch((err) => fail('engine', err));
  else if (m.type === 'rate') setRate(m.rate);
  else if (m.type === 'pause') stop('stopped');
  else if (m.type === 'cancel') stop('canceled');
};

function setRate(rate) {
  rateGen += 1;
  limiter.setRate(rate);
}

// The browser's own storage (OPFS): synchronous, flushed at checkpoints.
class OpfsFile {
  constructor(h) {
    this.h = h;
  }
  write(data, at) {
    this.h.write(data, { at });
  }
  truncate(size) {
    this.h.truncate(size);
  }
  flush() {
    this.h.flush();
  }
  async close() {
    this.h.flush();
    this.h.close();
  }
}

// A file in the user's folder: asynchronous writes, kept in order, and
// committed by close().
class FolderFile {
  constructor(ws) {
    this.ws = ws;
    this.queue = Promise.resolve();
  }
  write(data, at) {
    this.queue = this.queue.then(() => this.ws.write({ type: 'write', position: at, data }));
    return this.queue;
  }
  truncate(size) {
    this.queue = this.queue.then(() => this.ws.truncate(size));
    return this.queue;
  }
  flush() {}
  async close() {
    await this.queue;
    await this.ws.close();
  }
  async discard() {
    await this.ws.abort().catch(() => {});
  }
}

async function openFile() {
  if (task.folder) {
    // Resuming: carry on in the .part file (its committed bytes are kept).
    if (task.folder.part && task.segments) await openPart(task.folder.part, true);
    return; // a new download opens its .part once the name is known
  }
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('downloads', { create: true });
  const fh = await dir.getFileHandle(task.opfsName, { create: true });
  handle = new OpfsFile(await fh.createSyncAccessHandle());
}

async function openPart(name, keep) {
  const fh = await task.folder.dir.getFileHandle(name, { create: true });
  handle = new FolderFile(await fh.createWritable({ keepExistingData: keep }));
  task.folder.part = name;
}

function fetchInit(headers, signal, credentials = 'include') {
  return {
    headers,
    credentials,
    cache: 'no-store',
    signal,
  };
}

// Pick the pool with the fewest running connections.
function choosePool() {
  if (omitPool === 'bad') return 'include';
  const count = { include: 0, omit: 0 };
  for (const c of conns.values()) count[c.pool] += 1;
  return count.omit < count.include ? 'omit' : 'include';
}

// Resource Timing tells which protocol a finished request used; a 1-byte
// request finishes at once, unlike the streaming download itself.
async function detectProtocol() {
  try {
    const url = task.url;
    await (await fetch(url, fetchInit({ Range: 'bytes=0-0' }))).arrayBuffer();
    const entries = performance.getEntriesByName(url).filter((e) => e.nextHopProtocol);
    protocol = entries.length ? entries[entries.length - 1].nextHopProtocol : null;
    performance.clearResourceTimings();
  } catch {
    /* unknown protocol is fine */
  }
}

async function start(t) {
  task = t;
  sources = [{ url: t.url, primary: true, conns: 0, bytes: 0, failures: 0, bad: false }];
  limiter.setRate(task.rate || 0);
  controller = new AdaptiveController({ max: task.rangeSupported === false ? 1 : task.maxConnections || 6 });
  peakSpeed = task.stats?.peakSpeed || 0;
  activeMs = task.stats?.activeMs || 0;
  await openFile();

  if (task.segments && task.rangeSupported) {
    checkMirrors();
    segments = task.segments.map((s) => ({ ...s }));
    beginTicking();
    schedule();
    detectProtocol();
    return;
  }
  await probe();
}

// The first request doubles as the probe: "Range: bytes=0-" tells us whether
// the server supports ranges and how big the file is, and its body becomes
// connection #1, so starting a download never costs an extra round trip.
async function probe() {
  let ac;
  let resp;
  // A takeover must decide quickly (the browser's own download is waiting),
  // so only a hand-added task retries a failed first request.
  const attempts = task.takeover ? 1 : 4;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    if (stopping) return;
    ac = new AbortController();
    try {
      resp = await fetch(task.url, fetchInit({ Range: 'bytes=0-' }, ac.signal));
    } catch (err) {
      if (i < attempts - 1) continue;
      if (task.takeover) return reject('network');
      return fail('network', err);
    }
    if (resp.ok) break;
    ac.abort();
    const transient = resp.status === 429 || resp.status >= 500;
    if (transient && i < attempts - 1) continue;
    if (task.takeover) return reject(`http-${resp.status}`);
    return fail('http', new HttpError(resp.status));
  }

  const cr = resp.status === 206 ? parseContentRange(resp.headers.get('content-range')) : null;
  const rangeSupported = !!(cr && cr.start === 0 && cr.total);
  const lengthHeader = Number(resp.headers.get('content-length'));
  const size = rangeSupported ? cr.total : lengthHeader > 0 ? lengthHeader : null;
  const meta = {
    size,
    rangeSupported,
    filename: applyRename(
      pickFilename({
        disposition: resp.headers.get('content-disposition'),
        url: resp.url || task.url,
        fallback: task.filename,
      }),
      task.rename,
    ),
    etag: resp.headers.get('etag'),
    lastModified: resp.headers.get('last-modified'),
    mime: resp.headers.get('content-type'),
    finalUrl: resp.url || task.url,
  };

  if (task.takeover) {
    // Only take over downloads that we can actually speed up.
    if (!rangeSupported) return reject('no-range', ac);
    if (size < task.takeover.minSize) return reject('too-small', ac);
  }

  if (task.folder) {
    try {
      if (!handle) await openPart(task.folder.part || `${await uniqueName(task.folder.dir, meta.filename, '.part')}.part`, false);
    } catch (err) {
      ac.abort();
      return fail('folder', err);
    }
    meta.part = task.folder.part;
  } else if (size) {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - est.usage < size) {
      ac.abort();
      return fail('no-space', new Error('Not enough browser storage'));
    }
  }
  handle.truncate(size || 0);

  Object.assign(task, meta);
  primary().url = meta.finalUrl;
  if (!rangeSupported) controller.setMax(1);
  else checkMirrors();
  segments = [{ id: 0, start: 0, end: size ?? Infinity, pos: 0 }];
  post({ type: 'meta', meta, segments });
  beginTicking();
  runConn(segments[0], resp, ac, 'include');
  if (rangeSupported) detectProtocol();
}

function reject(reason, ac) {
  ac?.abort();
  closeHandle();
  post({ type: 'rejected', reason });
}

function beginTicking() {
  lastTick = Date.now();
  meter.add(lastTick, downloadedBytes(segments));
  ticker = setInterval(tick, TICK_MS);
}

function tick() {
  if (stopping || finished) return;
  const now = Date.now();
  if (conns.size > 0) activeMs += now - lastTick;
  lastTick = now;
  const done = downloadedBytes(segments);
  meter.add(now, done);
  const speed = meter.speed();
  peakSpeed = Math.max(peakSpeed, speed);
  if (task.rangeSupported) {
    let streaming = 0;
    for (const c of conns.values()) {
      if (c.lastDataAt && now - c.lastDataAt <= FRESH_MS) streaming += 1;
      // Stalled: connected but silent (or never answered). Restart it.
      if (now - (c.lastDataAt || c.startedAt) > STALL_MS) c.ac.abort('stall');
    }
    replaceSlow(now);
    controller.tick(now, done, streaming);
  }
  schedule();

  let checkpoint = false;
  if (now - lastCheckpoint >= CHECKPOINT_MS) {
    handle?.flush();
    lastCheckpoint = now;
    checkpoint = true;
  }
  post({
    type: 'progress',
    checkpoint,
    downloaded: done,
    speed,
    connections: conns.size,
    protocol,
    pools: omitPool === 'ok' ? 2 : 1,
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
    controller: controller.snapshot(),
    stats: stats(),
    mirrors: mirrorStats(),
  });
}

// A mirror is used only if it answers ranges and has the same size.
async function checkMirrors() {
  for (const url of task.mirrors || []) {
    if (stopping || sources.some((x) => x.url === url)) continue;
    const src = { url, primary: false, conns: 0, bytes: 0, failures: 0, bad: true };
    sources.push(src);
    try {
      const ac = new AbortController();
      const resp = await fetch(url, fetchInit({ Range: 'bytes=0-0' }, ac.signal));
      const cr = resp.status === 206 ? parseContentRange(resp.headers.get('content-range')) : null;
      ac.abort();
      if (cr?.total && cr.total === task.size) {
        Object.assign(src, { bad: false, url: resp.url || url, etag: resp.headers.get('etag'), lastModified: resp.headers.get('last-modified') });
      } else src.why = cr ? 'size' : `HTTP ${resp.status}`;
    } catch (err) {
      src.why = 'network';
    }
  }
  const good = sources.filter((x) => !x.bad).length;
  if (good > 1 && controller) {
    // Each server has its own connection limit.
    controller.setMax(Math.min(16, (task.maxConnections || 6) * good));
  }
}

function pickSource() {
  const good = sources.filter((x) => !x.bad);
  return good.reduce((a, b) => (b.conns < a.conns ? b : a), good[0] || primary());
}

const mirrorStats = () =>
  sources.length > 1
    ? sources.map((x) => ({ host: hostOf(x.url), bytes: x.bytes, bad: x.bad, why: x.why || null, primary: x.primary }))
    : null;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function stats() {
  return { peakSpeed, activeMs, levels: controller.levels, replaced };
}

// This connection's speed over the last CONN_WINDOW_MS (bytes/s), or null
// while it is too new to tell.
function connSpeed(c, now) {
  const w = c.window;
  if (!w || w.length < 2 || now - c.startedAt < SLOW_GRACE_MS) return null;
  const [t0, b0] = w[0];
  const [t1, b1] = w[w.length - 1];
  const v = t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : null;
  return Number.isFinite(v) ? v : null;
}

function replaceSlow(now) {
  for (const c of conns.values()) {
    (c.window ??= []).push([now, c.bytes || 0]);
    while (c.window.length > 2 && now - c.window[1][0] >= CONN_WINDOW_MS) c.window.shift();
    const v = connSpeed(c, now);
    if (v != null && (v > fastest.speed || now - fastest.at > FAST_MEMORY_MS)) fastest = { speed: v, at: now };
  }
  // A speed limit slows every connection on purpose: nothing to compare.
  if (limiter.rate || fastest.speed < MIN_FAST) return;
  let worst = null;
  for (const c of conns.values()) {
    const v = connSpeed(c, now);
    if (v == null || v >= fastest.speed * SLOW_RATIO) continue;
    // Worth it only if the piece would take a while at this speed.
    const left = remaining(c.seg);
    if (left / Math.max(v, 1) < 3) continue;
    if (!worst || v < worst.v) worst = { c, v };
  }
  // One at a time, so a server that is slow for everyone isn't hammered.
  if (worst) {
    replaced += 1;
    worst.c.ac.abort('slow');
  }
}

function schedule() {
  if (stopping || finished) return;
  if (segments.length && totalRemaining(segments) === 0 && conns.size === 0) {
    // Never save a file with a hole in it: if the pieces don't cover every
    // byte, download what is missing first.
    const gaps = task.rangeSupported && Number.isFinite(task.size) ? missingRanges(segments, task.size) : [];
    if (!gaps.length) return finish();
    console.warn('missing ranges before saving', gaps);
    let id = segments.reduce((max, s) => Math.max(max, s.id), -1);
    for (const [start, end] of gaps) segments.push({ id: ++id, start, end, pos: start });
  }
  if (!task.rangeSupported) return;

  const now = Date.now();
  const target = controller.target;
  while (conns.size < target) {
    const pending = segments.find(
      (s) => remaining(s) > 0 && !conns.has(s.id) && (retryAt.get(s.id) || 0) <= now,
    );
    if (pending) {
      runConn(pending);
      continue;
    }
    // Take over half of the piece that will take longest to finish; near the
    // end of the file, pieces down to TAIL_SPLIT so no slow piece is left.
    const now2 = Date.now();
    const eta = (s) => remaining(s) / Math.max(conns.get(s.id) ? connSpeed(conns.get(s.id), now2) ?? fastest.speed : fastest.speed, 1);
    const minSplit = totalRemaining(segments) < TAIL_BYTES ? TAIL_SPLIT : MIN_SPLIT;
    const seg = splitLargest(segments, new Set(conns.keys()), minSplit, eta);
    if (!seg) break;
    runConn(seg);
  }
  // Above target (controller stepped back): park the newest connections.
  // Their segments stay pending and are resumed when a slot frees up.
  if (conns.size > target) {
    const extra = [...conns.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, conns.size - target);
    for (const c of extra) c.ac.abort('shrink');
  }
}

class PoolError extends Error {}

async function runConn(seg, resp = null, ac = new AbortController(), pool = null) {
  const src = resp ? primary() : pickSource();
  // The cookie-less pool is only tried on the file's own address.
  pool ??= src.primary ? choosePool() : 'include';
  const conn = { ac, seg, pool, src, startedAt: Date.now(), lastDataAt: 0 };
  conns.set(seg.id, conn);
  src.conns += 1;
  try {
    if (!resp) {
      const headers = { Range: `bytes=${seg.pos}-${seg.end - 1}` };
      const tag = src.primary ? task.etag : src.etag;
      const validator = tag && !tag.startsWith('W/') ? tag : src.primary ? task.lastModified : src.lastModified;
      if (validator) headers['If-Range'] = validator;
      try {
        resp = await fetch(src.url, fetchInit(headers, ac.signal, pool));
      } catch (err) {
        if (pool === 'omit' && omitPool === 'untested' && !ac.signal.aborted) throw new PoolError(err.message);
        throw err;
      }
      const cr = resp.status === 206 ? parseContentRange(resp.headers.get('content-range')) : null;
      if (pool === 'omit') {
        // Without cookies the server must hand out the very same file.
        const etag = resp.headers.get('etag');
        const same = cr && cr.start === seg.pos && cr.total === task.size && (!task.etag || !etag || etag === task.etag);
        if (!same) {
          ac.abort('pool');
          throw new PoolError(`cookie-less request got ${resp.status}`);
        }
        omitPool = 'ok';
      }
      if (resp.status === 200) throw new ChangedError('Server ignored the range');
      if (resp.status !== 206) throw new HttpError(resp.status);
      if (!cr || cr.start !== seg.pos) throw new Error('Bad Content-Range');
    }

    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopping) break;
      let chunk = value;
      const room = seg.end - seg.pos;
      if (chunk.byteLength > room) chunk = chunk.subarray(0, room);
      conn.lastDataAt = Date.now();
      conn.bytes = (conn.bytes || 0) + chunk.byteLength;
      if (chunk.byteLength) {
        const writing = handle.write(chunk, seg.pos);
        if (writing) await writing.catch((err) => fail('folder', err));
        if (stopping) break;
        seg.pos += chunk.byteLength;
        src.bytes += chunk.byteLength;
        failures = 0;
        // Wait out the speed limit in short steps, so lifting or raising it
        // takes effect at once (with 6 connections a wait can run to seconds).
        const until = Date.now() + limiter.take(chunk.byteLength, Date.now());
        const gen = rateGen;
        while (Date.now() < until && gen === rateGen && !stopping) {
          await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
        }
      }
      if (seg.pos >= seg.end) {
        // The segment was shortened by a split; drop the rest of the stream.
        reader.cancel().catch(() => {});
        ac.abort('done');
        break;
      }
    }
    if (stopping) return;
    if (seg.end === Infinity) {
      seg.end = seg.pos; // unknown length: the stream ending is the end of file
      task.size = seg.pos;
    }
    if (seg.pos < seg.end) throw new Error('Connection closed early');
  } catch (err) {
    // 'slow': dropped on purpose; its piece is picked up again right away.
    if (stopping || ac.signal.reason === 'shrink' || ac.signal.reason === 'done' || ac.signal.reason === 'slow') return;
    if (err instanceof PoolError) {
      omitPool = 'bad'; // retried right away from the cookie pool
      return;
    }
    if (!src.primary) {
      // A failing mirror is dropped; its piece goes back to the others.
      src.failures += 1;
      const permanent = err instanceof HttpError && err.status < 500 && err.status !== 429 && err.status !== 408;
      if (err instanceof ChangedError || permanent || src.failures >= 3) {
        src.bad = true;
        src.why = String(err?.message || err);
      }
      retryAt.set(seg.id, Date.now() + 500);
      setTimeout(schedule, 510);
      return;
    }
    onConnError(seg, err, conn);
  } finally {
    src.conns -= 1;
    if (conns.get(seg.id) === conn) conns.delete(seg.id);
    if (!stopping) schedule();
  }
}

function onConnError(seg, err, conn) {
  if (err instanceof ChangedError) {
    // If-Range failed: the file on the server changed since we started.
    if (restarted) return fail('range-unsupported', err);
    return restartFresh();
  }
  if (!task.rangeSupported) {
    // A single stream without ranges cannot resume mid-way.
    return fail(err instanceof HttpError ? 'http' : 'network', err);
  }
  failures += 1;
  // Push-back: "too many requests", or a new connection refused while the
  // others are streaming (the server limits connections per client).
  const now = Date.now();
  const othersStreaming = [...conns.values()].some((c) => c !== conn && c.lastDataAt && now - c.lastDataAt <= FRESH_MS);
  const throttled = err instanceof HttpError && isThrottleStatus(err.status) && conns.size > 1;
  if (throttled || (!conn?.lastDataAt && othersStreaming)) controller.backoff(now);
  if (failures >= MAX_FAILURES) return fail(err instanceof HttpError ? 'http' : 'network', err);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
  retryAt.set(seg.id, Date.now() + delay);
  setTimeout(schedule, delay + 10);
}

function restartFresh() {
  restarted = true;
  for (const c of conns.values()) c.ac.abort('shrink');
  conns.clear();
  clearInterval(ticker);
  segments = [];
  task.segments = null;
  task.etag = task.lastModified = null;
  controller = new AdaptiveController({ max: task.maxConnections || 6 });
  post({ type: 'restarted' });
  probe();
}

async function finish() {
  if (finished) return;
  finished = true;
  clearInterval(ticker);
  let savedAs = null;
  let verified = null;
  try {
    if (task.size != null) handle.truncate(task.size);
    await handle.close();
    handle = null;
    if (task.checksum) {
      verified = await verify();
      if (!verified.ok) return badChecksum(verified);
    }
    if (task.folder) savedAs = await finalize(task.folder.dir, task.folder.part, task.filename || 'download');
  } catch (err) {
    finished = false;
    return fail(task.folder ? 'folder' : 'engine', err);
  }
  post({
    type: 'done',
    size: task.size,
    savedAs,
    verified,
    mirrors: mirrorStats(),
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
    stats: stats(),
  });
}

// ---- checksum ---------------------------------------------------------------

// Read the finished file back and compare it with the checksum the user gave.
async function verify() {
  const { algo, hex } = task.checksum;
  const dir = task.folder ? task.folder.dir : await (await navigator.storage.getDirectory()).getDirectoryHandle('downloads');
  const file = await (await dir.getFileHandle(task.folder ? task.folder.part : task.opfsName)).getFile();
  const hash = createHash(algo);
  const reader = file.stream().getReader();
  let read = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    read += value.byteLength;
    const now = Date.now();
    if (now - last > 300) {
      last = now;
      post({ type: 'verifying', verified: read, size: file.size, segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })) });
    }
  }
  const actual = hash.digest();
  return { algo, ok: actual === hex, expected: hex, actual };
}

// The file is not what the checksum says: nothing of it can be trusted, so
// a retry downloads it again from the start.
function badChecksum(v) {
  stopping = true;
  post({
    type: 'error',
    code: 'checksum',
    message: `${ALGO_NAMES[v.algo]} ${v.actual} ≠ ${v.expected}`,
    reset: true,
    verified: v,
    segments: null,
  });
}

async function stop(type) {
  if (stopping || finished) return;
  stopping = true;
  clearInterval(ticker);
  for (const c of conns.values()) c.ac.abort('stop');
  conns.clear();
  // Canceled: nothing to keep. Paused: commit what is written.
  if (type === 'canceled' && handle instanceof FolderFile) {
    await handle.discard();
    handle = null;
  }
  await closeHandle();
  post({
    type,
    downloaded: downloadedBytes(segments),
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
    stats: controller ? stats() : null,
  });
}

async function fail(code, err) {
  if (stopping || finished) return;
  stopping = true;
  clearInterval(ticker);
  for (const c of conns.values()) c.ac.abort('stop');
  conns.clear();
  await closeHandle();
  post({
    type: 'error',
    code,
    message: String(err?.message || err),
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
  });
}

async function closeHandle() {
  const h = handle;
  handle = null;
  try {
    await h?.close();
  } catch {
    /* already closed, or the folder went away */
  }
}
