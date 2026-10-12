// One worker per HLS (m3u8) task. Downloads the playlist's pieces several at
// a time, decrypts AES-128 ones, and appends them in order to the task's OPFS
// file, so the result is one .ts file (or .mp4 for fragmented-MP4 streams).
// Talks to offscreen.js with the same messages as task-worker.js.

import { SpeedMeter, RateLimiter } from './scheduler.js';
import { parsePlaylist, ivFor } from './hls.js';
import { sanitizeFilename } from './http.js';

const TICK_MS = 500;
const CHECKPOINT_MS = 2000;
const ATTEMPTS = 6;

let task;
let handle;
let segments = [];
let state; // { media, done, offset, total, duration, fmp4, map } - persisted as task.hls
let stopping = false;
let finished = false;
let received = 0; // bytes fetched so far, for the speed meter
let lastCheckpoint = 0;
let ticker;
let activeMs = 0;
let lastTick = 0;
let peakSpeed = 0;
const meter = new SpeedMeter(2000);
const limiter = new RateLimiter(0);
const inflight = new Map(); // index -> AbortController
const ready = new Map(); // index -> Uint8Array, waiting for earlier pieces
const keys = new Map(); // key URI -> Promise<CryptoKey>
let hostsAck = null;

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const post = (msg) => self.postMessage(msg);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m.task).catch((err) => fail(err.code || 'network', err));
  else if (m.type === 'rate') limiter.setRate(m.rate);
  else if (m.type === 'hosts-ok') hostsAck?.();
  else if (m.type === 'pause') stop('stopped');
  else if (m.type === 'cancel') stop('canceled');
};

function fetchInit(headers = {}, signal) {
  return { headers, credentials: 'include', cache: 'no-store', signal };
}

async function getText(url) {
  const resp = await fetch(url, fetchInit());
  if (!resp.ok) throw new HttpError(resp.status);
  return { text: await resp.text(), url: resp.url || url };
}

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function start(t) {
  task = t;
  limiter.setRate(task.rate || 0);
  activeMs = task.stats?.activeMs || 0;
  peakSpeed = task.stats?.peakSpeed || 0;

  // Master playlist -> the chosen (or best) quality -> its media playlist.
  let { text, url } = await getText(task.hls?.media || task.url);
  let list = parsePlaylist(text, url);
  if (list.type === 'master') {
    const v = list.variants.find((x) => x.url === task.variant) || list.variants[0];
    if (!v) throw coded('http', 'Empty master playlist');
    ({ text, url } = await getText(v.url));
    list = parsePlaylist(text, url);
  }
  if (list.drm) throw coded('drm', 'Encrypted with DRM (SAMPLE-AES)');
  if (!list.endList) throw coded('live', 'Live stream');
  if (!list.segments.length) throw coded('http', 'Empty playlist');
  segments = list.segments;

  const prev = task.hls?.media === url ? task.hls : null;
  state = {
    media: url,
    done: prev?.done || 0,
    offset: prev?.offset || 0,
    total: segments.length,
    duration: list.duration,
    fmp4: list.fmp4,
    map: prev?.map || null,
  };

  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('downloads', { create: true });
  handle = await (await dir.getFileHandle(task.opfsName, { create: true })).createSyncAccessHandle();
  handle.truncate(state.offset);

  const base = (task.filename || '').replace(/\.(m3u8|ts|mp4)$/i, '') || 'video';
  const filename = sanitizeFilename(`${base}.${list.fmp4 ? 'mp4' : 'ts'}`);
  post({
    type: 'meta',
    meta: { size: null, rangeSupported: null, filename, mime: list.fmp4 ? 'video/mp4' : 'video/mp2t', finalUrl: task.url },
    segments: null,
    hls: state,
  });

  // Pieces often live on other hosts (CDNs); let the engine add the page's
  // Referer for those too before asking for them.
  const hosts = [...new Set(segments.flatMap((s) => [s.url, s.key?.uri, s.map?.url]).filter(Boolean).map(hostOf))];
  await new Promise((resolve) => {
    hostsAck = resolve;
    post({ type: 'hosts', hosts });
    setTimeout(resolve, 3000);
  });

  lastTick = Date.now();
  ticker = setInterval(tick, TICK_MS);
  pump();
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

let next = 0;
function pump() {
  if (stopping || finished) return;
  if (state.done >= state.total) return finish();
  const conc = Math.max(1, Math.min(task.maxConnections || 6, 16));
  next = Math.max(next, state.done);
  // Don't run too far ahead of the writer: finished pieces wait in memory.
  while (inflight.size < conc && next < state.total && next < state.done + conc * 3) {
    const i = next++;
    if (ready.has(i) || inflight.has(i)) continue;
    getSegment(i);
  }
}

async function getSegment(i) {
  const ac = new AbortController();
  inflight.set(i, ac);
  const seg = segments[i];
  try {
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        data = await fetchBytes(seg.url, seg.range, ac.signal);
        break;
      } catch (err) {
        if (stopping || ac.signal.aborted) return;
        if (attempt >= ATTEMPTS || (err instanceof HttpError && err.status < 500 && err.status !== 429 && err.status !== 408)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
    if (seg.key) data = await decrypt(seg, data);
    ready.set(i, data);
    flush();
  } catch (err) {
    if (!stopping) fail(err instanceof HttpError ? 'http' : err.code || 'network', err);
  } finally {
    inflight.delete(i);
    pump();
  }
}

async function fetchBytes(url, range, signal) {
  const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
  const resp = await fetch(url, fetchInit(headers, signal));
  if (!resp.ok) throw new HttpError(resp.status);
  const reader = resp.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    received += value.byteLength;
    const wait = limiter.take(value.byteLength, Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  // A server that ignores Range sends the whole file: cut our piece out.
  if (range && resp.status === 200 && out.byteLength > range.length) return out.subarray(range.offset, range.offset + range.length);
  return out;
}

async function decrypt(seg, data) {
  if (!keys.has(seg.key.uri)) {
    keys.set(
      seg.key.uri,
      fetchBytes(seg.key.uri, null).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])),
    );
  }
  const key = await keys.get(seg.key.uri);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, key, data));
}

// Append every piece that is next in line.
function flush() {
  while (!stopping && ready.has(state.done)) {
    const seg = segments[state.done];
    if (seg.map && seg.map.url !== state.map) {
      // fMP4: the init section goes in front of the first piece that uses it.
      return writeMap(seg.map).then(flush, (err) => fail('network', err));
    }
    const data = ready.get(state.done);
    ready.delete(state.done);
    handle.write(data, { at: state.offset });
    state.offset += data.byteLength;
    state.done += 1;
  }
  if (state.done >= state.total) finish();
}

let mapWriting = null;
function writeMap(map) {
  mapWriting ??= fetchBytes(map.url, map.range).then((data) => {
    handle.write(data, { at: state.offset });
    state.offset += data.byteLength;
    state.map = map.url;
    mapWriting = null;
  });
  return mapWriting;
}

function tick() {
  if (stopping || finished) return;
  const now = Date.now();
  if (inflight.size) activeMs += now - lastTick;
  lastTick = now;
  meter.add(now, received);
  const speed = meter.speed();
  peakSpeed = Math.max(peakSpeed, speed);
  let checkpoint = false;
  if (now - lastCheckpoint >= CHECKPOINT_MS) {
    handle.flush();
    lastCheckpoint = now;
    checkpoint = true;
  }
  post({
    type: 'progress',
    checkpoint,
    downloaded: state.offset,
    speed,
    connections: inflight.size,
    segments: null,
    controller: null,
    stats: stats(),
    hls: { ...state },
  });
}

function stats() {
  return { peakSpeed, activeMs, singleSpeed: null, levels: {} };
}

function finish() {
  if (finished || stopping) return;
  finished = true;
  clearInterval(ticker);
  handle.truncate(state.offset);
  handle.flush();
  closeHandle();
  post({ type: 'done', size: state.offset, segments: null, stats: stats(), hls: { ...state } });
}

function halt() {
  stopping = true;
  clearInterval(ticker);
  for (const ac of inflight.values()) ac.abort();
  inflight.clear();
  try {
    handle?.flush();
  } catch {
    /* already closed */
  }
  closeHandle();
}

function stop(type) {
  if (stopping || finished) return;
  halt();
  post({ type, downloaded: state?.offset || 0, segments: null, stats: stats(), hls: state && { ...state } });
}

function fail(code, err) {
  if (stopping || finished) return;
  halt();
  post({ type: 'error', code, message: String(err?.message || err), segments: null, hls: state && { ...state } });
}

function closeHandle() {
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = null;
}
