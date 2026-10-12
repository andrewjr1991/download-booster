// One dedicated worker per download task. It owns the task's OPFS file through
// a sync access handle (only available in workers), runs every connection's
// fetch, and writes each chunk at its byte offset.

import {
  AdaptiveController,
  SpeedMeter,
  MIN_SPLIT,
  remaining,
  totalRemaining,
  downloadedBytes,
  splitLargest,
  RateLimiter,
} from './scheduler.js';
import { parseContentRange, pickFilename, isThrottleStatus, applyRename } from './http.js';

const TICK_MS = 500;
const CHECKPOINT_MS = 2000;
const MAX_FAILURES = 8;
const STALL_MS = 15000; // a connection silent this long is restarted
const FRESH_MS = 3000; // a connection counts as streaming if data came this recently

// Chrome keeps separate connection pools for requests with and without
// cookies. On HTTP/2 every request to a host shares one TCP connection, so
// alternating the two pools is the only way an extension gets a second TCP
// connection. Cookie-less requests are dropped for the task if the server
// answers them differently (login-protected files).
const POOLS = ['include', 'omit'];
let omitPool = 'untested'; // 'untested' | 'ok' | 'bad'
let protocol = null;

let task;
let handle;
let controller;
const meter = new SpeedMeter(2000);
const limiter = new RateLimiter(0); // this task's share of the global speed limit
const conns = new Map(); // segment id -> {ac, seg}
const retryAt = new Map(); // segment id -> timestamp before which it waits
let segments = [];
let stopping = false;
let finished = false;
let failures = 0;
let restarted = false;
let ticker;
let lastCheckpoint = 0;
let peakSpeed = 0;
let activeMs = 0;
let lastTick = 0;

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
  const was = limiter.rate;
  limiter.setRate(rate);
  // More room than before: look for a better connection count again.
  if (was && (!limiter.rate || limiter.rate > was * 1.2)) controller?.rethink(Date.now());
}

async function openFile() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('downloads', { create: true });
  const fh = await dir.getFileHandle(task.opfsName, { create: true });
  handle = await fh.createSyncAccessHandle();
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
  limiter.setRate(task.rate || 0);
  controller = new AdaptiveController({ max: task.rangeSupported === false ? 1 : task.maxConnections || 6 });
  peakSpeed = task.stats?.peakSpeed || 0;
  activeMs = task.stats?.activeMs || 0;
  await openFile();

  if (task.segments && task.rangeSupported) {
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

  if (size) {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - est.usage < size) {
      ac.abort();
      return fail('no-space', new Error('Not enough browser storage'));
    }
    handle.truncate(size);
  } else {
    handle.truncate(0);
  }

  Object.assign(task, meta);
  if (!rangeSupported) controller.max = 1;
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
    controller.tick(now, done, streaming);
  }
  schedule();

  let checkpoint = false;
  if (now - lastCheckpoint >= CHECKPOINT_MS) {
    handle.flush();
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
  });
}

function stats() {
  return { peakSpeed, activeMs, singleSpeed: controller.singleSpeed, levels: controller.levels };
}

function schedule() {
  if (stopping || finished) return;
  if (segments.length && totalRemaining(segments) === 0 && conns.size === 0) return finish();
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
    const seg = splitLargest(segments, new Set(conns.keys()), MIN_SPLIT);
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

async function runConn(seg, resp = null, ac = new AbortController(), pool = choosePool()) {
  const conn = { ac, seg, pool, startedAt: Date.now(), lastDataAt: 0 };
  conns.set(seg.id, conn);
  try {
    if (!resp) {
      const headers = { Range: `bytes=${seg.pos}-${seg.end - 1}` };
      const validator = task.etag && !task.etag.startsWith('W/') ? task.etag : task.lastModified;
      if (validator) headers['If-Range'] = validator;
      try {
        resp = await fetch(task.url, fetchInit(headers, ac.signal, pool));
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
      if (chunk.byteLength) {
        handle.write(chunk, { at: seg.pos });
        seg.pos += chunk.byteLength;
        failures = 0;
        const wait = limiter.take(chunk.byteLength, Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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
    if (stopping || ac.signal.reason === 'shrink' || ac.signal.reason === 'done') return;
    if (err instanceof PoolError) {
      omitPool = 'bad'; // retried right away from the cookie pool
      return;
    }
    onConnError(seg, err);
  } finally {
    if (conns.get(seg.id) === conn) conns.delete(seg.id);
    if (!stopping) schedule();
  }
}

function onConnError(seg, err) {
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
  if (err instanceof HttpError && isThrottleStatus(err.status) && conns.size > 0) {
    controller.backoff(Date.now());
  }
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

function finish() {
  if (finished) return;
  finished = true;
  clearInterval(ticker);
  if (task.size != null) handle.truncate(task.size);
  handle.flush();
  closeHandle();
  post({
    type: 'done',
    size: task.size,
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
    stats: stats(),
  });
}

function stop(type) {
  if (stopping || finished) return;
  stopping = true;
  clearInterval(ticker);
  for (const c of conns.values()) c.ac.abort('stop');
  conns.clear();
  try {
    handle?.flush();
  } catch {
    /* handle may already be closed */
  }
  closeHandle();
  post({
    type,
    downloaded: downloadedBytes(segments),
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
    stats: controller ? stats() : null,
  });
}

function fail(code, err) {
  if (stopping || finished) return;
  stopping = true;
  clearInterval(ticker);
  for (const c of conns.values()) c.ac.abort('stop');
  conns.clear();
  try {
    handle?.flush();
  } catch {
    /* ignore */
  }
  closeHandle();
  post({
    type: 'error',
    code,
    message: String(err?.message || err),
    segments: segments.map(({ id, start, end, pos }) => ({ id, start, end, pos })),
  });
}

function closeHandle() {
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = null;
}
