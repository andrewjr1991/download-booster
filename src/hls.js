// HLS (m3u8) playlists: parsing and the small helpers the HLS worker needs.
// Pure, unit-tested under Node.

function attrs(text) {
  // KEY=VALUE,KEY="quoted, value",...
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

// "1000@2000" -> { length: 1000, offset: 2000 }; offset defaults to the end
// of the previous range of the same file.
function byterange(text, prevEnd) {
  const [len, off] = text.split('@');
  const length = Number(len);
  const offset = off !== undefined ? Number(off) : prevEnd;
  return { offset, length };
}

export function isPlaylist(text) {
  return /^﻿?#EXTM3U/.test(String(text || '').trimStart());
}

// Returns { type: 'master', variants, audio } or { type: 'media', segments,
// endList, duration, encrypted }. URLs are made absolute against baseUrl.
export function parsePlaylist(text, baseUrl) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!isPlaylist(lines[0])) throw new Error('Not an m3u8 playlist');

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audio = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(l.slice(18));
        const uri = lines.slice(i + 1).find((x) => !x.startsWith('#'));
        if (!uri) continue;
        const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
        variants.push({
          url: resolve(uri, baseUrl),
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          width: w || null,
          height: h || null,
          codecs: a.CODECS || null,
          audio: a.AUDIO || null,
        });
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) {
          audio.push({ group: a['GROUP-ID'], name: a.NAME, default: a.DEFAULT === 'YES', url: resolve(a.URI, baseUrl) });
        }
      }
    }
    // Best first.
    variants.sort((x, y) => (y.height || 0) - (x.height || 0) || y.bandwidth - x.bandwidth);
    return { type: 'master', variants, audio };
  }

  const segments = [];
  let seq = 0;
  let duration = null;
  let key = null;
  let map = null;
  let range = null;
  let endList = false;
  const lastEnd = new Map(); // url -> end of its previous byte range
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXTINF:')) duration = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) range = l.slice(17);
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? resolve(a.URI, baseUrl) : null, iv: a.IV || null };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      const url = resolve(a.URI, baseUrl);
      map = { url, range: a.BYTERANGE ? byterange(a.BYTERANGE, 0) : null };
    } else if (l === '#EXT-X-ENDLIST') endList = true;
    else if (!l.startsWith('#')) {
      const url = resolve(l, baseUrl);
      let r = null;
      if (range) {
        r = byterange(range, lastEnd.get(url) || 0);
        lastEnd.set(url, r.offset + r.length);
      }
      segments.push({ url, duration: duration || 0, seq: seq++, key, map, range: r });
      duration = null;
      range = null;
    }
  }
  return {
    type: 'media',
    segments,
    endList,
    duration: segments.reduce((s, x) => s + x.duration, 0),
    encrypted: segments.some((s) => s.key),
    // Only AES-128 can be decrypted; SAMPLE-AES and friends are DRM.
    drm: segments.some((s) => s.key && s.key.method !== 'AES-128'),
    fmp4: segments.some((s) => s.map),
  };
}

// The separate audio a variant plays with (its AUDIO group): the default
// rendition, else the first. null when the audio is inside the video pieces.
export function audioFor(master, variant) {
  const group = master.audio.filter((a) => a.group === variant?.audio);
  return group.find((a) => a.default) || group[0] || null;
}

// AES-128 IV: the IV attribute, else the segment's media sequence number.
export function ivFor(seg) {
  const iv = new Uint8Array(16);
  if (seg.key?.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    let n = seg.seq;
    for (let i = 15; i >= 12 && n > 0; i--) {
      iv[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
  }
  return iv;
}

// "1080p · 5.2 Mbps" style label for a variant.
export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(v.bandwidth >= 1e7 ? 0 : 1)} Mbps`);
  return parts.join(' · ') || 'auto';
}
