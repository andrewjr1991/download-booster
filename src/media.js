// Media the page actually loaded (seen through webRequest): videos, audio,
// images and streaming playlists. Pure helpers, unit-tested under Node.

import { extensionOf } from './sniff.js';

export const MEDIA_KINDS = ['video', 'audio', 'image', 'stream'];
export const MIN_IMAGE_BYTES = 10 * 1024; // smaller images are icons and UI chrome
export const MIN_AV_BYTES = 50 * 1024; // smaller audio/video is UI sounds and clips
export const MAX_PER_TAB = 300;

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', '3gp', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'weba', 'wma']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'heic']);
const STREAM_EXT = new Set(['m3u8', 'mpd']);
// Pieces of a stream: useless one by one, and there are hundreds of them.
const SEGMENT_EXT = new Set(['ts', 'm4s', 'aac_seg']);
const SEGMENT_MIME = /^(video\/(mp2t|iso\.segment)|audio\/(mp2t|iso\.segment))$/;
const STREAM_MIME = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/(x-)?mpegurl)$/;

export function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

// Total file size from Content-Range (range requests) or Content-Length.
export function sizeFrom(headers) {
  const range = /\/(\d+)\s*$/.exec(header(headers, 'content-range') || '');
  if (range) return Number(range[1]);
  const len = Number(header(headers, 'content-length'));
  return len > 0 ? len : null;
}

// Players fetch the same file many times with the byte range in the query
// string; drop those parameters (and the #fragment) so it shows up once.
const RANGE_PARAMS = ['range', 'bytestart', 'byteend'];
export function mediaKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Rewriting the query re-encodes it, which can break signed URLs, so
    // only touch it when there is something to drop.
    if (RANGE_PARAMS.some((p) => u.searchParams.has(p))) for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    return u.href;
  } catch {
    return url;
  }
}

// What kind of media a response is, or null if it is not worth listing.
export function classify({ url, type, mime, size }) {
  if (!/^https?:/i.test(url || '')) return null;
  mime = (mime || '').split(';')[0].trim().toLowerCase();
  const ext = extensionOf(url);
  if (SEGMENT_MIME.test(mime) || SEGMENT_EXT.has(ext)) return null;
  if (STREAM_MIME.test(mime) || STREAM_EXT.has(ext)) return 'stream';
  let kind = null;
  if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';
  else if (mime.startsWith('image/')) kind = 'image';
  else if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    if (VIDEO_EXT.has(ext)) kind = 'video';
    else if (AUDIO_EXT.has(ext)) kind = 'audio';
    else if (IMAGE_EXT.has(ext)) kind = 'image';
    else if (type === 'media') kind = 'video';
  }
  if (kind === 'image' && size != null && size < MIN_IMAGE_BYTES) return null;
  if ((kind === 'audio' || kind === 'video') && size != null && size < MIN_AV_BYTES) return null;
  return kind;
}

export function mediaName(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last) || new URL(url).host;
  } catch {
    return url;
  }
}

// Add one response to a tab's list (newest last). Returns true if the list changed.
export function addMedia(list, { url, type, mime, size, at = Date.now() }) {
  const kind = classify({ url, type, mime, size });
  if (!kind) return false;
  const key = mediaKey(url);
  const found = list.find((m) => m.key === key);
  if (found) {
    if (size && size > (found.size || 0)) {
      found.size = size;
      return true;
    }
    return false;
  }
  // The key doubles as the download URL: with the range parameters left in,
  // the server would only send that slice.
  list.push({ key, url: key, kind, mime: (mime || '').split(';')[0].trim(), size: size || null, name: mediaName(url), at });
  if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
  return true;
}
