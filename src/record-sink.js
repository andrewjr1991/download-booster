// Recording, part 3 of 3: an invisible extension frame that record-bridge.js
// puts in the page. It receives the pieces the player appended, joins each
// video's tracks into one file in the extension's storage (OPFS), and hands
// the file to the download list like any finished download.

import { Mp4Stream, mux, canJoin } from './fmp4.js';

const media = new Map(); // media id -> Map(track id -> track)
const trackMedia = new Map(); // track id -> media id
const done = new Set(); // media ids already saved
let port = null;
let token = null;

addEventListener('message', async (e) => {
  if (e.data?.type !== 'connect' || port || !e.ports[0]) return;
  // Only the bridge of a tab being recorded knows this token.
  const expected = await chrome.runtime.sendMessage({ type: 'record-token' }).catch(() => null);
  if (!expected || e.data.token !== expected) return;
  token = expected;
  port = e.ports[0];
  port.onmessage = (m) => handle(m.data);
});

function handle(m) {
  if (m.type === 'track') {
    if (!media.has(m.media)) media.set(m.media, new Map());
    const mp4 = /^(video|audio)\/mp4/i.test(m.mime);
    media.get(m.media).set(m.id, {
      mime: m.mime,
      stream: mp4 ? new Mp4Stream({ keep: (bytes) => new Blob([bytes]) }) : null,
      chunks: mp4 ? null : [], // other containers (WebM) are kept as they come
    });
    trackMedia.set(m.id, m.media);
  } else if (m.type === 'data') {
    const track = media.get(trackMedia.get(m.id))?.get(m.id);
    if (!track) return;
    if (track.stream) track.stream.push(new Uint8Array(m.data));
    else track.chunks.push(new Blob([m.data]));
  } else if (m.type === 'end') {
    save(m.media);
  } else if (m.type === 'finish') {
    Promise.allSettled([...media.keys()].map(save)).then(() => port.postMessage({ type: 'finished' }));
  }
}

const EXT = { 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'audio/webm': 'webm', 'video/mp2t': 'ts' };
const extOf = (mime) => EXT[mime.split(';')[0].trim().toLowerCase()] || 'bin';

// The files one video becomes: one joined .mp4 when it has a video and an
// audio track, otherwise one file per track.
function files(tracks) {
  const list = [...tracks.values()];
  const settled = list.map((x) => (x.stream ? x.stream.settle() : null));
  if (settled.every(Boolean) && canJoin(settled)) {
    return [{ parts: mux(settled), ext: 'mp4', type: 'video/mp4', switched: settled.some((s) => s.switched) }];
  }
  return list
    .map((x, i) => {
      const ext = extOf(x.mime);
      const type = x.mime.split(';')[0].trim();
      if (x.stream) return settled[i] && { parts: mux([settled[i]]), ext, type, switched: settled[i].switched };
      return x.chunks.length ? { parts: x.chunks, ext, type, switched: false } : null;
    })
    .filter(Boolean);
}

async function save(id) {
  if (done.has(id) || !media.has(id)) return;
  done.add(id);
  const out = files(media.get(id));
  media.delete(id);
  if (!out.length) return;
  port.postMessage({ type: 'saving' });
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('downloads', { create: true });
    for (const f of out) {
      const blob = new Blob(f.parts, { type: f.type });
      const opfsName = `${crypto.randomUUID()}.part`;
      const writable = await (await dir.getFileHandle(opfsName, { create: true })).createWritable();
      await writable.write(blob);
      await writable.close();
      const res = await chrome.runtime.sendMessage({ type: 'record-save', token, opfsName, ext: f.ext, size: blob.size });
      if (res?.error) throw new Error(res.error);
    }
    port.postMessage({ type: 'saved', files: out.length });
  } catch (err) {
    console.warn('recording not saved', err);
    port.postMessage({ type: 'failed', message: String(err?.message || err) });
  }
}
