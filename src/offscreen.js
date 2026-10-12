// The download engine host. Lives in the offscreen document, which (unlike the
// MV3 service worker) is not killed when idle. It keeps the task list, starts
// one worker per active task, persists progress to IndexedDB and hands
// finished files to the background for chrome.downloads to save.

import { db } from './db.js';

const tasks = new Map(); // id -> task record
const workers = new Map(); // id -> Worker
const pendingAdds = new Map(); // id -> resolve() for takeover probes
const blobUrls = new Map(); // id -> object URL being saved

// How many tasks download at once; the rest wait as 'queued'. Offscreen
// documents cannot read chrome.storage, so the pages pass the setting in.
let maxActive = Number(localStorage.getItem('maxActive')) || 3;
// Global speed limit in bytes/s (0 = none), split evenly between running tasks.
let speedLimit = Number(localStorage.getItem('speedLimit')) || 0;

const ready = init();

async function init() {
  navigator.storage.persist?.().catch(() => {});
  for (const t of await db.all()) {
    tasks.set(t.id, t);
    t.speed = 0;
    t.connections = 0;
  }
  for (const t of tasks.values()) {
    // Tasks that were running when the browser closed resume on their own,
    // oldest first, as queue slots allow.
    if (t.status === 'downloading') t.status = 'queued';
    else if (t.status === 'saving') save(t);
  }
  pump();
  broadcast();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'engine') return false;
  ready
    .then(() => handle(msg))
    .then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function handle(msg) {
  const t = msg.id ? tasks.get(msg.id) : null;
  switch (msg.cmd) {
    case 'ping':
      return { ok: true };
    case 'list':
      return { tasks: summaries(), speedLimit };
    case 'add':
      setLimit(msg.maxActive);
      setSpeedLimit(msg.speedLimit);
      return add(msg);
    case 'set-limit':
      setLimit(msg.maxActive);
      setSpeedLimit(msg.speedLimit);
      return { ok: true };
    case 'pause':
      if (t && workers.has(t.id)) workers.get(t.id).postMessage({ type: 'pause' });
      else if (t?.status === 'queued') setStatus(t, 'paused');
      return { ok: true };
    case 'import':
      return importFile(msg);
    case 'resume':
      // A recording is already complete: only saving it can be retried.
      if (t?.kind === 'record' && t.status === 'error') await save(t);
      else if (t && (t.status === 'paused' || t.status === 'error')) {
        if (!t.rangeSupported) t.segments = null; // no ranges: start over
        enqueue(t);
      }
      return { ok: true };
    case 'cancel':
    case 'remove':
      if (t) await removeTask(t);
      return { ok: true };
    case 'saved':
      if (t) await onSaved(t, msg.downloadId);
      return { ok: true };
    case 'save-failed':
      if (t) setStatus(t, 'error', { code: 'save', message: msg.error });
      return { ok: true };
    case 'clear-finished':
      for (const x of [...tasks.values()]) if (x.status === 'completed') await removeTask(x);
      return { ok: true };
    default:
      throw new Error(`Unknown command ${msg.cmd}`);
  }
}

async function add({ url, filename, takeover, maxConnections, source, referrer, kind, variant, rename }) {
  const id = crypto.randomUUID();
  const t = {
    id,
    url,
    filename: filename || null,
    size: null,
    rangeSupported: null,
    etag: null,
    lastModified: null,
    opfsName: `${id}.part`,
    segments: null,
    status: 'queued',
    error: null,
    downloaded: 0,
    speed: 0,
    connections: 0,
    stats: null,
    controller: null,
    maxConnections: maxConnections || 6,
    source: source || 'manual',
    referrer: referrer || null,
    // 'hls': an m3u8 stream whose pieces are joined into one file (hls-worker.js).
    kind: kind === 'hls' ? 'hls' : 'file',
    variant: variant || null,
    // Batch rename rule, applied once the server's file name is known.
    rename: rename?.pattern ? rename : null,
    hls: null,
    createdAt: Date.now(),
    finishedAt: null,
    downloadId: null,
  };
  tasks.set(id, t);

  if (!takeover) {
    await db.put(t);
    enqueue(t);
    return { accepted: true, id };
  }

  // Takeover: keep the task invisible until the probe says it qualifies.
  t.takeover = takeover;
  const result = await new Promise((resolve) => {
    pendingAdds.set(id, resolve);
    startWorker(t);
  });
  delete t.takeover;
  if (!result.accepted) {
    tasks.delete(id);
    clearRequestHeaders(t);
    await deleteOpfs(t);
  } else {
    // The probe already started downloading; if that put us over the
    // limit, park it in the queue (its progress is kept).
    if (workers.size > maxActive && workers.has(id)) {
      t.requeue = true;
      workers.get(id).postMessage({ type: 'pause' });
    }
    persist(t);
    broadcast();
  }
  return result;
}

function setLimit(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n) || n < 1 || n === maxActive) return;
  maxActive = Math.min(n, 10);
  localStorage.setItem('maxActive', String(maxActive));
  pump();
}

function setSpeedLimit(bytesPerSec) {
  if (bytesPerSec === undefined) return;
  const n = Math.max(0, Math.round(Number(bytesPerSec) || 0));
  if (n === speedLimit) return;
  speedLimit = n;
  localStorage.setItem('speedLimit', String(n));
  shareSpeedLimit();
  broadcast();
}

function rateShare() {
  return speedLimit ? speedLimit / Math.max(1, workers.size) : 0;
}

// Hand every running task its share again (a task started or finished).
function shareSpeedLimit() {
  const rate = rateShare();
  for (const w of workers.values()) w.postMessage({ type: 'rate', rate });
}

function enqueue(t) {
  if (workers.size < maxActive) return startWorker(t);
  setStatus(t, 'queued');
}

// Start queued tasks, oldest first, while there are free slots.
function pump() {
  const waiting = [...tasks.values()]
    .filter((t) => t.status === 'queued' && !workers.has(t.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const t of waiting) {
    if (workers.size >= maxActive) break;
    startWorker(t);
  }
}

async function startWorker(t) {
  workers.get(t.id)?.terminate();
  const script = t.kind === 'hls' ? './hls-worker.js' : './task-worker.js';
  const w = new Worker(new URL(script, import.meta.url), { type: 'module' });
  workers.set(t.id, w);
  t.status = 'downloading';
  t.error = null;
  w.onmessage = (e) => onWorkerMessage(t, e.data);
  w.onerror = (e) => onWorkerMessage(t, { type: 'error', code: 'engine', message: e.message });
  shareSpeedLimit();
  await setRequestHeaders(t);
  if (workers.get(t.id) !== w) return; // paused or removed meanwhile
  w.postMessage({
    type: 'start',
    task: {
      id: t.id,
      url: t.finalUrl || t.url,
      filename: t.filename,
      opfsName: t.opfsName,
      size: t.size,
      rangeSupported: t.rangeSupported,
      etag: t.etag,
      lastModified: t.lastModified,
      segments: t.segments,
      maxConnections: t.maxConnections,
      takeover: t.takeover || null,
      stats: t.stats,
      rate: rateShare(),
      hls: t.hls,
      variant: t.variant,
      rename: t.rename,
    },
  });
  if (!t.takeover) persist(t);
  broadcast();
}

function endWorker(t) {
  workers.get(t.id)?.terminate();
  workers.delete(t.id);
  t.speed = 0;
  t.connections = 0;
  shareSpeedLimit();
  // A slot freed up; start the next task once this message is handled.
  queueMicrotask(pump);
}

async function onWorkerMessage(t, m) {
  if (m.hls) t.hls = m.hls;
  switch (m.type) {
    case 'hosts':
      // An HLS stream's pieces and keys can come from other hosts.
      t.refererHosts = m.hosts;
      await setRequestHeaders(t);
      workers.get(t.id)?.postMessage({ type: 'hosts-ok' });
      return;
    case 'meta':
      Object.assign(t, {
        size: m.meta.size,
        rangeSupported: m.meta.rangeSupported,
        filename: m.meta.filename,
        etag: m.meta.etag,
        lastModified: m.meta.lastModified,
        mime: m.meta.mime,
        finalUrl: m.meta.finalUrl,
        segments: m.segments,
      });
      if (t.finalUrl !== t.url) setRequestHeaders(t);
      if (pendingAdds.has(t.id)) {
        pendingAdds.get(t.id)({ accepted: true, id: t.id, filename: t.filename });
        pendingAdds.delete(t.id);
      }
      persist(t);
      break;
    case 'rejected':
      endWorker(t);
      pendingAdds.get(t.id)?.({ accepted: false, reason: m.reason });
      pendingAdds.delete(t.id);
      return;
    case 'restarted':
      t.segments = null;
      t.etag = t.lastModified = null;
      break;
    case 'progress':
      Object.assign(t, {
        downloaded: m.downloaded,
        speed: m.speed,
        connections: m.connections,
        protocol: m.protocol || t.protocol || null,
        pools: m.pools,
        segments: m.segments,
        controller: m.controller,
        stats: m.stats,
      });
      if (m.checkpoint) persist(t);
      break;
    case 'stopped':
      endWorker(t);
      Object.assign(t, { downloaded: m.downloaded, segments: m.segments, stats: m.stats || t.stats });
      setStatus(t, t.requeue ? 'queued' : 'paused');
      delete t.requeue;
      break;
    case 'canceled':
      endWorker(t);
      break;
    case 'error':
      endWorker(t);
      if (pendingAdds.has(t.id)) {
        pendingAdds.get(t.id)({ accepted: false, reason: m.code });
        pendingAdds.delete(t.id);
        return;
      }
      if (m.segments?.length) t.segments = m.segments;
      setStatus(t, 'error', { code: m.code, message: m.message });
      break;
    case 'done':
      endWorker(t);
      Object.assign(t, { size: m.size, downloaded: m.size, segments: m.segments, stats: m.stats });
      t.finishedAt = Date.now();
      await save(t);
      break;
  }
  broadcast();
}

// A file made elsewhere in the extension (a recording) that is already in
// OPFS: list it and save it like a finished download.
async function importFile({ opfsName, size, filename, referrer }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const t = {
    id,
    url: referrer || '',
    filename,
    size,
    downloaded: size,
    rangeSupported: false,
    opfsName,
    segments: null,
    status: 'saving',
    error: null,
    speed: 0,
    connections: 0,
    stats: null,
    controller: null,
    source: 'record',
    referrer: null,
    kind: 'record',
    hls: null,
    createdAt: now,
    finishedAt: now,
    downloadId: null,
  };
  tasks.set(id, t);
  await save(t);
  broadcast();
  return { id };
}

const TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  webm: 'video/webm',
  ts: 'video/mp2t',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

// The saved file's type from its name; anything else is plain binary, which
// Chrome leaves under the name it was given.
function typeFor(filename) {
  const ext = /\.([a-z0-9]+)$/i.exec(filename || '')?.[1]?.toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

// Hand the finished OPFS file to chrome.downloads (via the background, since
// offscreen documents only get chrome.runtime).
async function save(t) {
  setStatus(t, 'saving');
  try {
    const file = await getOpfsFile(t);
    // OPFS files have no type, and Chrome then treats the blob as text/plain:
    // on Windows that renames "video.mp4" to "video.txt". Give it a real one.
    const url = URL.createObjectURL(file.slice(0, file.size, typeFor(t.filename)));
    blobUrls.set(t.id, url);
    const res = await chrome.runtime.sendMessage({
      type: 'save-file',
      id: t.id,
      url,
      filename: t.filename || 'download',
    });
    if (res?.error) throw new Error(res.error);
    t.downloadId = res.downloadId;
    persist(t);
  } catch (err) {
    setStatus(t, 'error', { code: 'save', message: String(err?.message || err) });
  }
}

// The background turns these into declarativeNetRequest rules that add the
// Referer header to this task's requests (sites that block hotlinking).
async function setRequestHeaders(t) {
  if (!t.referrer) return;
  try {
    await chrome.runtime.sendMessage({
      type: 'request-headers',
      id: t.id,
      urls: [t.url, t.finalUrl],
      domains: t.refererHosts || [],
      referrer: t.referrer,
    });
  } catch (err) {
    console.warn('could not set Referer', err);
  }
}

function clearRequestHeaders(t) {
  if (!t.referrer) return;
  chrome.runtime.sendMessage({ type: 'clear-request-headers', id: t.id }).catch(() => {});
}

async function onSaved(t, downloadId) {
  if (blobUrls.has(t.id)) URL.revokeObjectURL(blobUrls.get(t.id));
  blobUrls.delete(t.id);
  t.downloadId = downloadId ?? t.downloadId;
  await deleteOpfs(t);
  clearRequestHeaders(t);
  t.segments = null;
  setStatus(t, 'completed');
}

async function removeTask(t) {
  const w = workers.get(t.id);
  if (w) {
    w.postMessage({ type: 'cancel' });
    // Give the worker a moment to close its file handle before deleting.
    await new Promise((r) => setTimeout(r, 150));
    endWorker(t);
  }
  tasks.delete(t.id);
  clearRequestHeaders(t);
  await db.delete(t.id);
  await deleteOpfs(t);
  pump();
  broadcast();
}

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('downloads', { create: true });
}

async function getOpfsFile(t) {
  const fh = await (await opfsDir()).getFileHandle(t.opfsName);
  return fh.getFile();
}

async function deleteOpfs(t) {
  try {
    await (await opfsDir()).removeEntry(t.opfsName);
  } catch {
    /* already gone */
  }
}

function setStatus(t, status, error = null) {
  t.status = status;
  t.error = error;
  persist(t);
  broadcast();
}

function persist(t) {
  if (!tasks.has(t.id) || t.takeover) return;
  const { speed, connections, requeue, ...record } = t;
  db.put(record).catch((err) => console.warn('persist failed', err));
}

function summaries() {
  return [...tasks.values()]
    .filter((t) => !t.takeover)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      id: t.id,
      url: t.url,
      filename: t.filename,
      size: t.size,
      rangeSupported: t.rangeSupported,
      status: t.status,
      error: t.error,
      downloaded: t.downloaded,
      speed: t.speed,
      connections: t.connections,
      protocol: t.protocol,
      segments: t.segments,
      controller: t.controller,
      stats: t.stats,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
      downloadId: t.downloadId,
      kind: t.kind,
      hls: t.hls && { done: t.hls.done, total: t.hls.total, duration: t.hls.duration },
    }));
}

let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    chrome.runtime.sendMessage({ type: 'engine-state', tasks: summaries(), speedLimit }).catch(() => {});
  }, 250);
}

// Live progress even when no message changes a status.
setInterval(() => {
  if (workers.size) broadcast();
}, 500);
