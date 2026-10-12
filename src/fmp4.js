// Fragmented MP4 (what players feed to MediaSource): split a SourceBuffer's
// byte stream into its init section and fragments as it arrives, then join
// one video and one audio stream into a single playable .mp4.
// Pure, unit-tested under Node.

const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const type = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

function setU32(b, at, v) {
  b[at] = v >>> 24;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

function u64(b, at) {
  return u32(b, at) * 2 ** 32 + u32(b, at + 4);
}

function setU64(b, at, v) {
  setU32(b, at, Math.floor(v / 2 ** 32));
  setU32(b, at + 4, v % 2 ** 32);
}

// Size of the box starting at `at`, or null if its header is incomplete.
function boxSize(b, at, end) {
  if (end - at < 8) return null;
  const size = u32(b, at);
  if (size === 1) return end - at < 16 ? null : { size: u64(b, at + 8), header: 16 };
  if (size === 0) return { size: end - at, header: 8 }; // runs to the end
  return { size, header: 8 };
}

// Child boxes of b[start, end): [{ type, start, end, body }].
export function children(b, start = 0, end = b.length) {
  const out = [];
  let at = start;
  while (at < end) {
    const h = boxSize(b, at, end);
    if (!h || h.size < h.header || at + h.size > end) break;
    out.push({ type: type(b, at + 4), start: at, end: at + h.size, body: at + h.header });
    at += h.size;
  }
  return out;
}

function find(b, box, ...path) {
  let cur = box;
  for (const t of path) {
    cur = children(b, cur.body, cur.end).find((c) => c.type === t);
    if (!cur) return null;
  }
  return cur;
}

const fullBoxVersion = (b, box) => b[box.body];

// Track facts from an init section's moov box (its own bytes).
export function parseMoov(moov) {
  const root = children(moov)[0];
  const mvhd = find(moov, root, 'mvhd');
  const movieTimescale = mvhd ? u32(moov, mvhd.body + (fullBoxVersion(moov, mvhd) === 1 ? 20 : 12)) : 1000;
  const tracks = children(moov, root.body, root.end)
    .filter((c) => c.type === 'trak')
    .map((trak) => {
      const tkhd = find(moov, trak, 'tkhd');
      const mdhd = find(moov, trak, 'mdia', 'mdhd');
      const hdlr = find(moov, trak, 'mdia', 'hdlr');
      return {
        id: u32(moov, tkhd.body + (fullBoxVersion(moov, tkhd) === 1 ? 20 : 12)),
        timescale: u32(moov, mdhd.body + (fullBoxVersion(moov, mdhd) === 1 ? 20 : 12)),
        handler: hdlr ? type(moov, hdlr.body + 8) : null, // 'vide' | 'soun' | ...
      };
    });
  return { movieTimescale, tracks };
}

// Decode time (seconds) of a fragment from its moof box.
export function fragmentTime(moof, timescales) {
  const traf = find(moof, children(moof)[0], 'traf');
  if (!traf) return 0;
  const tfhd = find(moof, traf, 'tfhd');
  const tfdt = find(moof, traf, 'tfdt');
  if (!tfhd || !tfdt) return 0;
  const id = u32(moof, tfhd.body + 4);
  const t = fullBoxVersion(moof, tfdt) === 1 ? u64(moof, tfdt.body + 4) : u32(moof, tfdt.body + 4);
  return t / (timescales.get(id) || 1);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// One SourceBuffer's byte stream. push() whatever the player appended; boxes
// are cut out as they complete. `keep` stores the big media data (the
// recorder turns it into a Blob so it can live on disk).
export class Mp4Stream {
  constructor({ keep = (bytes) => bytes } = {}) {
    this.keep = keep;
    this.pending = null;
    this.ftyp = null;
    this.inits = []; // [{ ftyp, moov, info, timescales }]
    this.init = -1; // index of the init section in use
    this.moof = null;
    this.fragments = []; // [{ init, moof, mdat, size, time }]
    this.bytes = 0;
  }

  push(chunk) {
    let b = chunk;
    if (this.pending) {
      b = new Uint8Array(this.pending.length + chunk.length);
      b.set(this.pending);
      b.set(chunk, this.pending.length);
      this.pending = null;
    }
    let at = 0;
    for (;;) {
      const h = boxSize(b, at, b.length);
      if (!h || at + h.size > b.length) break;
      if (h.size < h.header) {
        at = b.length; // garbage: drop it
        break;
      }
      this.box(type(b, at + 4), b.subarray(at, at + h.size));
      at += h.size;
    }
    if (at < b.length) this.pending = b.slice(at);
  }

  box(kind, bytes) {
    if (kind === 'ftyp') this.ftyp = bytes.slice();
    else if (kind === 'moov') {
      // Players append the same init section again after seeks.
      let i = this.inits.findIndex((x) => equal(x.moov, bytes));
      if (i < 0) {
        const moov = bytes.slice();
        const info = parseMoov(moov);
        const timescales = new Map(info.tracks.map((t) => [t.id, t.timescale]));
        i = this.inits.push({ ftyp: this.ftyp, moov, info, timescales }) - 1;
      }
      this.init = i;
    } else if (kind === 'moof') this.moof = bytes.slice();
    else if (kind === 'mdat' && this.moof && this.init >= 0) {
      const moof = this.moof;
      this.moof = null;
      this.fragments.push({
        init: this.init,
        moof,
        mdat: this.keep(bytes.slice()),
        size: moof.length + bytes.length,
        time: fragmentTime(moof, this.inits[this.init].timescales),
      });
      this.bytes += moof.length + bytes.length;
    }
  }

  // The init section with the most media (the quality the player settled on,
  // if it switched), and its fragments in time order without repeats.
  settle() {
    if (!this.fragments.length) return null;
    const bytes = new Map();
    for (const f of this.fragments) bytes.set(f.init, (bytes.get(f.init) || 0) + f.size);
    const best = [...bytes].sort((x, y) => y[1] - x[1])[0][0];
    const seen = new Set();
    const fragments = this.fragments
      .filter((f) => f.init === best)
      .sort((x, y) => x.time - y.time)
      .filter((f) => !seen.has(f.time) && seen.add(f.time));
    return { ...this.inits[best], fragments, switched: bytes.size > 1 };
  }
}

function box(kind, parts) {
  const size = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  setU32(out, 0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = kind.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Copy of a moof with every traf given track `id` and sequence number `seq`.
function patchMoof(moof, seq, id) {
  const b = moof.slice();
  const root = children(b)[0];
  for (const c of children(b, root.body, root.end)) {
    if (c.type === 'mfhd') setU32(b, c.body + 4, seq);
    if (c.type === 'traf' && id != null) {
      const tfhd = find(b, c, 'tfhd');
      if (tfhd) setU32(b, tfhd.body + 4, id);
    }
  }
  return b;
}

// Audio trak re-numbered and moved to the video's movie timescale.
function moveTrak(moov, trak, id, scale) {
  const b = moov.slice(trak.start, trak.end);
  const t = children(b)[0];
  const tkhd = find(b, t, 'tkhd');
  const v1 = fullBoxVersion(b, tkhd) === 1;
  setU32(b, tkhd.body + (v1 ? 20 : 12), id);
  const durAt = tkhd.body + (v1 ? 28 : 20);
  if (v1) setU64(b, durAt, Math.round(u64(b, durAt) * scale));
  else setU32(b, durAt, Math.min(0xffffffff, Math.round(u32(b, durAt) * scale)));
  const elst = find(b, t, 'edts', 'elst');
  if (elst) {
    const ev1 = fullBoxVersion(b, elst) === 1;
    const n = u32(b, elst.body + 4);
    for (let i = 0, at = elst.body + 8; i < n; i++, at += ev1 ? 20 : 12) {
      if (ev1) setU64(b, at, Math.round(u64(b, at) * scale));
      else setU32(b, at, Math.min(0xffffffff, Math.round(u32(b, at) * scale)));
    }
  }
  return b;
}

// The joined file as a list of parts (Uint8Array, or whatever `keep` made of
// the media data) to concatenate. `streams` are settled Mp4Streams; with one
// video and one audio, they become one file with two tracks.
export function mux(streams) {
  const parts = [];
  let seq = 1;
  if (streams.length === 1) {
    const s = streams[0];
    if (s.ftyp) parts.push(s.ftyp);
    parts.push(s.moov);
    for (const f of s.fragments) parts.push(patchMoof(f.moof, seq++, null), f.mdat);
    return parts;
  }

  const [v, a] = streams[0].info.tracks[0].handler === 'vide' ? streams : [streams[1], streams[0]];
  const vMoov = v.moov;
  const vRoot = children(vMoov)[0];
  const aRoot = children(a.moov)[0];
  const vId = v.info.tracks[0].id;
  const aId = vId + 1;
  const scale = v.info.movieTimescale / a.info.movieTimescale;
  const aTrak = moveTrak(
    a.moov,
    children(a.moov, aRoot.body, aRoot.end).find((c) => c.type === 'trak'),
    aId,
    scale,
  );
  const aTrex = find(a.moov, aRoot, 'mvex', 'trex');

  const kids = [];
  let traksDone = false;
  const vKids = children(vMoov, vRoot.body, vRoot.end);
  for (const c of vKids) {
    let bytes = vMoov.slice(c.start, c.end);
    // next_track_ID is the last field of mvhd.
    if (c.type === 'mvhd') setU32(bytes, bytes.length - 4, aId + 1);
    if (c.type === 'mvex' && aTrex) {
      const trex = a.moov.slice(aTrex.start, aTrex.end);
      setU32(trex, 12, aId);
      const mv = children(bytes, 8, bytes.length).map((x) => bytes.slice(x.start, x.end));
      bytes = box('mvex', [...mv, trex]);
    }
    kids.push(bytes);
    const lastTrak = c.type === 'trak' && !vKids.slice(vKids.indexOf(c) + 1).some((x) => x.type === 'trak');
    if (lastTrak && !traksDone) {
      kids.push(aTrak);
      traksDone = true;
    }
  }
  if (v.ftyp) parts.push(v.ftyp);
  parts.push(box('moov', kids));

  const all = [
    ...v.fragments.map((f) => ({ f, id: null })),
    ...a.fragments.map((f) => ({ f, id: aId })),
  ].sort((x, y) => x.f.time - y.f.time);
  for (const { f, id } of all) parts.push(patchMoof(f.moof, seq++, id), f.mdat);
  return parts;
}

// Which settled streams can be joined: exactly one video and one audio, each
// with a single track. Otherwise each stream is saved as its own file.
export function canJoin(streams) {
  if (streams.length !== 2) return false;
  const kinds = streams.map((s) => (s.info.tracks.length === 1 ? s.info.tracks[0].handler : 'many'));
  return kinds.includes('vide') && kinds.includes('soun');
}
