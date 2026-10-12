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
} from './scheduler.js';
import { parseContentRange, pickFilename, isThrottleStatus } from './http.js';

const TICK_MS = 500;
const CHECKPOINT_MS = 2000;
const MAX_FAILURES = 8;

let task;
let handle;
let controller;
const meter = new SpeedMeter(2000);
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
  else if (m.type === 'pause') stop('stopped');
  else if (m.type === 'cancel') stop('canceled');
};

async function openFile() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('downloads', { create: true });
  const fh = await dir.getFileHandle(task.opfsName, { create: true });
  handle = await fh.createSyncAccessHandle();
}

function fetchInit(headers, signal) {
  return {
    headers,
    credentials: 'include',
    cache: 'no-store',
    signal,
  };
}

async function start(t) {
  task = t;
  controller = new AdaptiveController({ max: task.rangeSupported === false ? 1 : task.maxConnections || 6 });
  peakSpeed = task.stats?.peakSpeed || 0;
  activeMs = task.stats?.activeMs || 0;
  await openFile();

  if (task.segments && task.rangeSupported) {
    segments = task.segments.map((s) => ({ ...s }));
    beginTicking();
    schedule();
    return;
  }
  await probe();
}

// The first request doubles as the probe: "Range: bytes=0-" tells us whether
// the server supports ranges and how big the file is, and its body becomes
// connection #1, so starting a download never costs an extra round trip.
async function probe() {
  const ac = new AbortController();
  let resp;
  try {
    resp = await fetch(task.url, fetchInit({ Range: 'bytes=0-' }, ac.signal));
  } catch (err) {
    return fail('network', err);
  }
  if (!resp.ok) {
    ac.abort();
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
    filename: pickFilename({
      disposition: resp.headers.get('content-disposition'),
      url: resp.url || task.url,
      fallback: task.filename,
    }),
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
  runConn(segments[0], resp, ac);
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
  if (task.rangeSupported) controller.tick(now, speed, conns.size);
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

async function runConn(seg, resp = null, ac = new AbortController()) {
  const conn = { ac, seg, startedAt: Date.now() };
  conns.set(seg.id, conn);
  try {
    if (!resp) {
      const headers = { Range: `bytes=${seg.pos}-${seg.end - 1}` };
      const validator = task.etag && !task.etag.startsWith('W/') ? task.etag : task.lastModified;
      if (validator) headers['If-Range'] = validator;
      resp = await fetch(task.url, fetchInit(headers, ac.signal));
      if (resp.status === 200) throw new ChangedError('Server ignored the range');
      if (resp.status !== 206) throw new HttpError(resp.status);
      const cr = parseContentRange(resp.headers.get('content-range'));
      if (!cr || cr.start !== seg.pos) throw new Error('Bad Content-Range');
    }

    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopping) break;
      let chunk = value;
      const room = seg.end - seg.pos;
      if (chunk.byteLength > room) chunk = chunk.subarray(0, room);
      if (chunk.byteLength) {
        handle.write(chunk, { at: seg.pos });
        seg.pos += chunk.byteLength;
        failures = 0;
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
