// DASH (.mpd) manifests: parsed into the same shapes as hls.js uses, so the
// popup and the HLS worker handle both. A manifest becomes a "master" whose
// variants are the video qualities and whose audio entries are the audio
// languages; each carries its pieces as a ready "media" list. Pure,
// unit-tested under Node (no DOMParser in workers, so a small XML reader).

import { parsePlaylist } from './hls.js';

// ---- a small XML reader ----------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
const local = (name) => name.slice(name.indexOf(':') + 1); // drop namespace prefixes

export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4]))) attrs[local(a[1])] = decode(a[2] ?? a[3]);
      const el = { name: local(m[3]), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root;
}

const kids = (el, name) => (el?.children || []).filter((c) => c.name === name);
const kid = (el, name) => kids(el, name)[0] || null;

// ---- helpers ------------------------------------------------------------------------

export function isMpd(text) {
  return /<MPD[\s>]/.test(String(text || '').slice(0, 4096));
}

// "PT1H2M3.5S" -> seconds
export function isoDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if (!m) return null;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

// The BaseURL an element adds to its parent's.
function baseOf(el, parent) {
  const b = kid(el, 'BaseURL');
  return b ? resolve(b.text.trim(), parent) : parent;
}

// "100-199" -> { offset: 100, length: 100 }
function range(text) {
  const m = /^(\d+)-(\d+)$/.exec(String(text || '').trim());
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

// $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$
export function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (m, name, width) => {
    if (!name) return '$';
    const v = String(vars[name] ?? '');
    return width ? v.padStart(Number(width), '0') : v;
  });
}

// Segment settings are inherited Period -> AdaptationSet -> Representation;
// the closest element's attributes win.
function inherited(chain, name) {
  const els = chain.map((x) => kid(x, name)).filter(Boolean);
  if (!els.length) return null;
  const attrs = Object.assign({}, ...els.map((e) => e.attrs));
  const pick = (child) => els.map((e) => kid(e, child)).filter(Boolean).pop() || null;
  return { attrs, els, pick };
}

const VIDEO_CODEC = /^(avc|hvc|hev|vp0?[89]|av01|dvh|mp4v)/i;
const AUDIO_CODEC = /^(mp4a|opus|vorbis|ac-3|ec-3|flac|mp3|dtsc)/i;

function kindOf(set, rep) {
  const type = set.attrs.contentType || '';
  const mime = rep.attrs.mimeType || set.attrs.mimeType || '';
  const codecs = rep.attrs.codecs || set.attrs.codecs || '';
  if (type === 'video' || mime.startsWith('video/')) return VIDEO_CODEC.test(codecs) || !AUDIO_CODEC.test(codecs) ? 'video' : 'audio';
  if (type === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (VIDEO_CODEC.test(codecs)) return 'video';
  if (AUDIO_CODEC.test(codecs)) return 'audio';
  return null; // subtitles, thumbnails
}

// ---- the pieces of one representation in one period ---------------------------------

function pieces(period, set, rep, ctx) {
  const chain = [period, set, rep];
  const base = baseOf(rep, baseOf(set, ctx.base));
  const vars = { RepresentationID: rep.attrs.id, Bandwidth: rep.attrs.bandwidth };
  const out = { segments: [], segmentBase: null };

  const tpl = inherited(chain, 'SegmentTemplate');
  if (tpl) {
    const a = tpl.attrs;
    const scale = Number(a.timescale) || 1;
    const map = a.initialization ? { url: resolve(fillTemplate(a.initialization, vars), base), range: null } : null;
    let number = a.startNumber !== undefined ? Number(a.startNumber) : 1;
    const push = (time, d) =>
      out.segments.push({
        url: resolve(fillTemplate(a.media, { ...vars, Number: number++, Time: time }), base),
        duration: d / scale,
        map,
        range: null,
      });
    const timeline = tpl.pick('SegmentTimeline');
    if (timeline) {
      const end = ctx.periodDuration != null ? Number(a.presentationTimeOffset || 0) + ctx.periodDuration * scale : Infinity;
      let t = 0;
      const ss = kids(timeline, 'S');
      ss.forEach((s, i) => {
        if (s.attrs.t !== undefined) t = Number(s.attrs.t);
        const d = Number(s.attrs.d);
        let r = Number(s.attrs.r || 0);
        if (r < 0) {
          // Repeat until the next S, or the end of the period.
          const next = ss[i + 1]?.attrs.t;
          const until = next !== undefined ? Number(next) : end;
          r = Number.isFinite(until) ? Math.ceil((until - t) / d) - 1 : 0;
        }
        for (let k = 0; k <= r; k++) {
          push(t, d);
          t += d;
        }
      });
    } else if (a.duration) {
      const d = Number(a.duration);
      const count = ctx.periodDuration != null ? Math.ceil((ctx.periodDuration * scale) / d - 1e-9) : 0;
      for (let k = 0; k < count; k++) push((number - (Number(a.startNumber ?? 1) || 0)) * d, d);
    }
    return out;
  }

  const list = inherited(chain, 'SegmentList');
  if (list) {
    const scale = Number(list.attrs.timescale) || 1;
    const d = Number(list.attrs.duration) || 0;
    const init = list.pick('Initialization');
    const map = init ? { url: resolve(init.attrs.sourceURL || '', base), range: range(init.attrs.range) } : null;
    const urls = list.els[list.els.length - 1];
    for (const s of kids(urls, 'SegmentURL')) {
      out.segments.push({ url: resolve(s.attrs.media || '', base), duration: d / scale, map, range: range(s.attrs.mediaRange) });
    }
    return out;
  }

  const sb = inherited(chain, 'SegmentBase');
  const init = sb?.pick('Initialization');
  if (sb?.attrs.indexRange) {
    // One file per representation; its pieces are listed in the file's own
    // index (sidx box), read by the worker (see parseSidx).
    out.segmentBase = { url: base, init: range(init?.attrs.range), index: range(sb.attrs.indexRange) };
    return out;
  }
  // A plain file: one piece.
  out.segments.push({ url: base, duration: ctx.periodDuration || 0, map: null, range: null });
  return out;
}

// ---- the manifest ---------------------------------------------------------------------

// Returns { type: 'master', dash: true, live, drm, duration, variants, audio }
// shaped like hls.js's master playlist; each variant and audio entry has a
// `list` shaped like its media playlist ({ segments, duration, fmp4, ... }),
// with `segmentBase` set instead of segments when the pieces are in a sidx.
export function parseMpd(text, baseUrl) {
  const mpd = kid(parseXml(text), 'MPD');
  if (!mpd) throw new Error('Not a DASH manifest');
  const live = mpd.attrs.type === 'dynamic';
  const total = isoDuration(mpd.attrs.mediaPresentationDuration);
  const base = baseOf(mpd, baseUrl);
  const periods = kids(mpd, 'Period');

  // Representations by kind across periods: key -> entry; later periods add
  // their pieces to the entry with the same id (or the same place in order).
  const entries = { video: [], audio: [] };
  let start = 0;
  periods.forEach((period, pi) => {
    const pStart = isoDuration(period.attrs.start) ?? start;
    const nextStart = isoDuration(periods[pi + 1]?.attrs.start);
    const periodDuration = isoDuration(period.attrs.duration) ?? (nextStart != null ? nextStart - pStart : total != null ? total - pStart : null);
    start = pStart + (periodDuration || 0);
    const ctx = { base: baseOf(period, base), periodDuration };
    const seen = { video: 0, audio: 0 };
    for (const set of kids(period, 'AdaptationSet')) {
      for (const rep of kids(set, 'Representation')) {
        const kind = kindOf(set, rep);
        if (!kind) continue;
        const mime = rep.attrs.mimeType || set.attrs.mimeType || '';
        const drm = kids(set, 'ContentProtection').length + kids(rep, 'ContentProtection').length > 0;
        const p = pieces(period, set, rep, ctx);
        const lang = set.attrs.lang || rep.attrs.lang || '';
        const role = kid(set, 'Role')?.attrs.value || '';
        const label = (kid(set, 'Label') || kid(rep, 'Label'))?.text.trim() || set.attrs.label || '';
        const order = seen[kind]++;
        const list = entries[kind];
        let entry = pi > 0 && (list.find((e) => e.id === rep.attrs.id && e.lastPeriod < pi) || list.find((e) => e.order === order && e.lastPeriod < pi));
        if (!entry) {
          if (pi > 0) continue;
          entry = {
            id: rep.attrs.id,
            order,
            set: kids(period, 'AdaptationSet').indexOf(set),
            kind,
            bandwidth: Number(rep.attrs.bandwidth) || 0,
            width: Number(rep.attrs.width || set.attrs.width) || null,
            height: Number(rep.attrs.height || set.attrs.height) || null,
            codecs: rep.attrs.codecs || set.attrs.codecs || null,
            webm: /webm/i.test(mime),
            lang,
            label,
            main: role === 'main',
            drm: false,
            segments: [],
            segmentBase: null,
            duration: 0,
          };
          list.push(entry);
        }
        entry.lastPeriod = pi;
        entry.drm ||= drm;
        entry.segments.push(...p.segments);
        // A sidx file can only be read for a single-period manifest.
        if (p.segmentBase && pi === 0) entry.segmentBase = p.segmentBase;
        entry.duration += periodDuration || p.segments.reduce((s, x) => s + x.duration, 0);
      }
    }
  });

  const asList = (e) => ({
    type: 'media',
    segments: e.segments,
    segmentBase: e.segments.length ? null : e.segmentBase,
    endList: !live,
    duration: total ?? e.duration,
    encrypted: e.drm,
    drm: e.drm,
    fmp4: !e.webm,
    ext: e.webm ? 'webm' : e.kind === 'audio' ? 'm4a' : 'mp4',
  });
  const key = (e) => `${baseUrl}#${e.kind}=${e.id ?? e.order}`;

  // One audio entry per language (adaptation set): its best quality.
  const bySet = new Map();
  for (const e of entries.audio) {
    const best = bySet.get(e.set);
    if (!best || e.bandwidth > best.bandwidth) bySet.set(e.set, e);
  }
  let audioEntries = [...bySet.values()];
  let videoEntries = entries.video;
  // Audio-only manifest: the audio qualities are what's picked.
  if (!videoEntries.length) {
    videoEntries = entries.audio;
    audioEntries = [];
  }
  const defaultAudio = audioEntries.find((e) => e.main) || audioEntries[0];
  const audio = audioEntries.map((e) => ({
    group: 'dash',
    name: e.label || e.lang || '', // ids are often just numbers
    default: e === defaultAudio,
    url: key(e),
    list: asList(e),
  }));
  const variants = videoEntries.map((e) => ({
    url: key(e),
    bandwidth: e.bandwidth,
    width: e.width,
    height: e.height,
    codecs: e.codecs,
    audio: audio.length ? 'dash' : null,
    list: asList(e),
  }));
  variants.sort((x, y) => (y.height || 0) - (x.height || 0) || y.bandwidth - x.bandwidth);
  return {
    type: 'master',
    dash: true,
    live,
    drm: [...entries.video, ...entries.audio].some((e) => e.drm),
    duration: total,
    variants,
    audio,
  };
}

// An m3u8 or an mpd, whichever the text is.
export function parseManifest(text, url) {
  return isMpd(text) ? parseMpd(text, url) : parsePlaylist(text, url);
}

// ---- sidx: the piece index inside a single-file representation -----------------------

// `bytes` holds the file from `at`; `index` is the indexRange. Returns the
// pieces as byte ranges, or null if there is no sidx box there.
export function parseSidx(bytes, at, index) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = index.offset - at;
  // The index range may hold other boxes (styp) before the sidx.
  while (p + 8 <= bytes.length) {
    const size = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (type === 'sidx') break;
    if (size < 8) return null;
    p += size;
  }
  if (p + 12 > bytes.length) return null;
  const size = dv.getUint32(p);
  const end = at + p + size; // the first piece starts after the sidx
  const version = bytes[p + 8];
  let q = p + 12 + 4; // reference_ID
  const scale = dv.getUint32(q);
  q += 4;
  let first;
  if (version === 0) {
    first = dv.getUint32(q + 4);
    q += 8;
  } else {
    first = Number(dv.getBigUint64(q + 8));
    q += 16;
  }
  q += 2; // reserved
  const count = dv.getUint16(q);
  q += 2;
  const out = [];
  let offset = end + first;
  for (let i = 0; i < count && q + 12 <= bytes.length; i++, q += 12) {
    const length = dv.getUint32(q) & 0x7fffffff;
    const duration = dv.getUint32(q + 4);
    out.push({ offset, length, duration: duration / (scale || 1) });
    offset += length;
  }
  return out;
}
