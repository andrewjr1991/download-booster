// One worker per HLS (m3u8) task. Downloads the playlist's pieces several at
// a time, decrypts AES-128 ones, and appends them in order to an OPFS file, so
// the result is one .ts file (or .mp4 for fragmented-MP4 streams).
// Streams whose audio is a separate playlist get two tracks: the video and
// the audio are downloaded one after the other, then joined into one .mp4
// (fragmented MP4), or, when they can't be joined (MPEG-TS), the audio is
// saved as a second file next to the video.
// Talks to offscreen.js with the same messages as task-worker.js.

import { SpeedMeter, RateLimiter } from './scheduler.js';
import { parsePlaylist, ivFor, audioFor } from './hls.js';
import { sanitizeFilename } from './http.js';
import { scanFile, mux, canJoin } from './fmp4.js';

const TICK_MS = 500;
const CHECKPOINT_MS = 2000;
const ATTEMPTS = 6;
const COPY_CHUNK = 4 * 1024 * 1024;

let task;
let dir; // OPFS 'downloads' directory
// Persisted as task.hls: totals for the progress bar, plus per track
// { kind, media, file, done, total, offset, map, fmp4, ext }.
let state;
let tracks = []; // state.tracks plus their segments (not persisted)
let current = null; // the track downloading now
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

async function mediaPlaylist(url) {
  const res = await getText(url);
  const list = parsePlaylist(res.text, res.url);
  if (list.type !== 'media') throw coded('http', 'Expected a media playlist');
  if (list.drm) throw coded('drm', 'Encrypted with DRM (SAMPLE-AES)');
  if (!list.endList) throw coded('live', 'Live stream');
  if (!list.segments.length) throw coded('http', 'Empty playlist');
  return { list, url: res.url };
}

// Extension for a track saved on its own.
function extOf(list) {
  if (list.fmp4) return 'mp4';
  const last = list.segments[0].url.split(/[?#]/)[0].toLowerCase();
  return /\.(aac|mp3|ac3|ec3)$/.exec(last)?.[1] || 'ts';
}

async function start(t) {
  task = t;
  limiter.setRate(task.rate || 0);
  activeMs = task.stats?.activeMs || 0;
  peakSpeed = task.stats?.peakSpeed || 0;
  const prev = task.hls;

  // Master playlist -> the chosen (or best) quality -> its media playlist,
  // plus the separate audio it plays with, if any.
  let video;
  let audio = null;
  const first = await getText(prev?.media || task.url);
  const top = parsePlaylist(first.text, first.url);
  if (top.type === 'master') {
    const v = top.variants.find((x) => x.url === task.variant) || top.variants[0];
    if (!v) throw coded('http', 'Empty master playlist');
    video = await mediaPlaylist(v.url);
    const a = audioFor(top, v);
    if (a) audio = await mediaPlaylist(a.url);
  } else {
    video = await mediaPlaylist(first.url);
    // Resuming a two-track task: the audio playlist was saved.
    const pa = prev?.tracks?.find((x) => x.kind === 'audio');
    if (pa) audio = await mediaPlaylist(pa.media);
  }

  const join = !!audio && video.list.fmp4 && audio.list.fmp4;
  const same = (kind, url) => prev?.tracks?.find((x) => x.kind === kind && x.media === url);
  const track = (kind, { list, url }, file) => {
    // Older tasks saved one track's progress at the top level.
    const was = same(kind, url) || (kind === 'video' && !prev?.tracks && prev?.media === url ? { ...prev, file: task.opfsName } : null);
    return {
      kind,
      media: url,
      file: was?.file || file,
      done: was?.done || 0,
      offset: was?.offset || 0,
      total: list.segments.length,
      map: was?.map || null,
      fmp4: list.fmp4,
      ext: extOf(list),
      duration: list.duration,
      segments: list.segments,
    };
  };
  // Joined: both tracks go to their own files first. Otherwise the video
  // goes straight to the task's file.
  tracks = [track('video', video, join ? `${crypto.randomUUID()}.part` : task.opfsName)];
  if (audio) tracks.push(track('audio', audio, `${crypto.randomUUID()}.part`));
  state = {
    media: video.url,
    duration: video.list.duration,
    fmp4: join || video.list.fmp4,
    tracks: null,
    done: 0,
    total: 0,
    offset: 0,
  };
  sync();

  const root = await navigator.storage.getDirectory();
  dir = await root.getDirectoryHandle('downloads', { create: true });

  const base = (task.filename || '').replace(/\.(m3u8|ts|mp4)$/i, '') || 'video';
  const ext = join ? 'mp4' : tracks[0].ext;
  const filename = sanitizeFilename(`${base}.${ext}`);
  const mime = ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
  post({ type: 'meta', meta: { size: null, rangeSupported: null, filename, mime, finalUrl: task.url }, segments: null, hls: snapshot() });

  // Pieces often live on other hosts (CDNs); let the engine add the page's
  // Referer for those too before asking for them.
  const urls = tracks.flatMap((tr) => tr.segments.flatMap((s) => [s.url, s.key?.uri, s.map?.url]));
  const hosts = [...new Set(urls.filter(Boolean).map(hostOf).filter(Boolean))];
  await new Promise((resolve) => {
    hostsAck = resolve;
    post({ type: 'hosts', hosts });
    setTimeout(resolve, 3000);
  });

  lastTick = Date.now();
  ticker = setInterval(tick, TICK_MS);
  for (const tr of tracks) {
    if (tr.done < tr.total) await runTrack(tr);
    if (stopping) return;
  }
  if (join) await joinTracks();
  else if (audio) {
    // Can't be joined here: the audio becomes its own download.
    const a = tracks[1];
    post({ type: 'extra', opfsName: a.file, size: a.offset, filename: sanitizeFilename(`${base}-audio.${a.ext}`) });
    a.file = null;
    sync();
  }
  finish(join ? state.size : tracks[0].offset);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Progress across tracks, for the engine's task record.
function sync() {
  state.tracks = tracks.map(({ kind, media, file, done, total, offset, map, fmp4, ext }) => ({ kind, media, file, done, total, offset, map, fmp4, ext }));
  state.done = tracks.reduce((s, x) => s + x.done, 0);
  state.total = tracks.reduce((s, x) => s + x.total, 0);
  state.offset = tracks.reduce((s, x) => s + x.offset, 0);
}

const snapshot = () => {
  sync();
  return structuredClone(state);
};

// ---- one track: its pieces in order into its file -------------------------------

function runTrack(tr) {
  return new Promise((resolve, reject) => {
    tr.inflight = new Map(); // index -> AbortController
    tr.ready = new Map(); // index -> Uint8Array, waiting for earlier pieces
    tr.next = tr.done;
    tr.resolve = resolve;
    tr.reject = reject;
    current = tr;
    dir
      .getFileHandle(tr.file, { create: true })
      .then((fh) => fh.createSyncAccessHandle())
      .then((h) => {
        tr.handle = h;
        h.truncate(tr.offset);
        pump(tr);
      }, reject);
  });
}

function pump(tr) {
  if (stopping || tr.complete) return;
  if (tr.done >= tr.total) return completeTrack(tr);
  const conc = Math.max(1, Math.min(task.maxConnections || 6, 16));
  tr.next = Math.max(tr.next, tr.done);
  // Don't run too far ahead of the writer: finished pieces wait in memory.
  while (tr.inflight.size < conc && tr.next < tr.total && tr.next < tr.done + conc * 3) {
    const i = tr.next++;
    if (tr.ready.has(i) || tr.inflight.has(i)) continue;
    getSegment(tr, i);
  }
}

function completeTrack(tr) {
  if (tr.complete) return;
  tr.complete = true;
  tr.handle.truncate(tr.offset);
  tr.handle.flush();
  tr.handle.close();
  tr.handle = null;
  sync();
  tr.resolve();
}

async function getSegment(tr, i) {
  const ac = new AbortController();
  tr.inflight.set(i, ac);
  const seg = tr.segments[i];
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
    tr.ready.set(i, data);
    flush(tr);
  } catch (err) {
    if (!stopping) fail(err instanceof HttpError ? 'http' : err.code || 'network', err);
  } finally {
    tr.inflight.delete(i);
    pump(tr);
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
function flush(tr) {
  while (!stopping && tr.handle && tr.ready.has(tr.done)) {
    const seg = tr.segments[tr.done];
    if (seg.map && seg.map.url !== tr.map) {
      // fMP4: the init section goes in front of the first piece that uses it.
      return writeMap(tr, seg.map).then(
        () => flush(tr),
        (err) => fail('network', err),
      );
    }
    const data = tr.ready.get(tr.done);
    tr.ready.delete(tr.done);
    tr.handle.write(data, { at: tr.offset });
    tr.offset += data.byteLength;
    tr.done += 1;
  }
  if (tr.done >= tr.total && tr.handle) completeTrack(tr);
}

function writeMap(tr, map) {
  tr.mapWriting ??= fetchBytes(map.url, map.range).then((data) => {
    tr.handle.write(data, { at: tr.offset });
    tr.offset += data.byteLength;
    tr.map = map.url;
    tr.mapWriting = null;
  });
  return tr.mapWriting;
}

// ---- joining video and audio -------------------------------------------------------

async function joinTracks() {
  const open = async (name) => (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  const [v, a] = tracks;
  const src = { video: await open(v.file), audio: await open(a.file) };
  let out;
  try {
    const scan = (kind) => {
      const h = src[kind];
      const read = (at, length) => {
        const b = new Uint8Array(length);
        h.read(b, { at });
        return b;
      };
      const settled = scanFile(read, h.getSize()).settle();
      for (const f of settled?.fragments || []) f.mdat.src = kind;
      return settled;
    };
    const streams = [scan('video'), scan('audio')];
    if (!streams[0] || !streams[1] || !canJoin(streams)) throw coded('join', 'Video and audio could not be joined');
    out = await open(task.opfsName);
    out.truncate(0);
    let at = 0;
    const buf = new Uint8Array(COPY_CHUNK);
    for (const part of mux(streams)) {
      if (part instanceof Uint8Array) {
        out.write(part, { at });
        at += part.length;
        continue;
      }
      // Media data: copied from the track's file in chunks.
      for (let done = 0; done < part.length; ) {
        const n = Math.min(COPY_CHUNK, part.length - done);
        const chunk = n === COPY_CHUNK ? buf : buf.subarray(0, n);
        src[part.src].read(chunk, { at: part.at + done });
        out.write(chunk, { at });
        at += n;
        done += n;
      }
    }
    out.truncate(at);
    out.flush();
    state.size = at;
  } finally {
    out?.close();
    src.video.close();
    src.audio.close();
  }
  for (const tr of tracks) await dir.removeEntry(tr.file).catch(() => {});
}

// ---- progress and the end ------------------------------------------------------------

function tick() {
  if (stopping || finished) return;
  const now = Date.now();
  if (current?.inflight?.size) activeMs += now - lastTick;
  lastTick = now;
  meter.add(now, received);
  const speed = meter.speed();
  peakSpeed = Math.max(peakSpeed, speed);
  let checkpoint = false;
  if (now - lastCheckpoint >= CHECKPOINT_MS) {
    current?.handle?.flush();
    lastCheckpoint = now;
    checkpoint = true;
  }
  const hls = snapshot();
  post({
    type: 'progress',
    checkpoint,
    downloaded: hls.offset,
    speed,
    connections: current?.inflight?.size || 0,
    segments: null,
    controller: null,
    stats: stats(),
    hls,
  });
}

function stats() {
  return { peakSpeed, activeMs, singleSpeed: null, levels: {} };
}

function finish(size) {
  if (finished || stopping) return;
  finished = true;
  clearInterval(ticker);
  post({ type: 'done', size, segments: null, stats: stats(), hls: snapshot() });
}

function halt() {
  stopping = true;
  clearInterval(ticker);
  for (const tr of tracks) {
    for (const ac of tr.inflight?.values() || []) ac.abort();
    tr.inflight?.clear();
    try {
      tr.handle?.flush();
      tr.handle?.close();
    } catch {
      /* already closed */
    }
    tr.handle = null;
  }
}

function stop(type) {
  if (stopping || finished) return;
  halt();
  post({ type, downloaded: state?.offset || 0, segments: null, stats: stats(), hls: state && snapshot() });
}

function fail(code, err) {
  if (stopping || finished) return;
  halt();
  post({ type: 'error', code, message: String(err?.message || err), segments: null, hls: state && snapshot() });
}
