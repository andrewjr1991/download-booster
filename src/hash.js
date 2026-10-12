// Checksums for verifying a finished download: MD5, SHA-1 and SHA-256,
// computed a chunk at a time (crypto.subtle only hashes a whole buffer at
// once, which a file of several GB does not fit in). Pure, unit-tested under
// Node against node:crypto.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

// The algorithm a checksum is for, from an optional "sha256:" prefix or its
// length. Returns { algo, hex } or null if it isn't a checksum.
export function parseChecksum(text) {
  const m = /^\s*(?:(md5|sha-?1|sha-?256)\s*[:=]?\s*)?([0-9a-f]+)\s*$/i.exec(String(text || ''));
  if (!m) return null;
  const hex = m[2].toLowerCase();
  const byLength = { 32: 'md5', 40: 'sha1', 64: 'sha256' }[hex.length];
  const named = m[1] ? m[1].toLowerCase().replace('-', '') : null;
  if (!byLength || (named && named !== byLength)) return null;
  return { algo: byLength, hex };
}

export const ALGO_NAMES = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256' };

// Shared block buffering: `block(words)` gets each 64-byte block as 16
// 32-bit words in the algorithm's byte order.
class Blocks {
  constructor(littleEndian) {
    this.le = littleEndian;
    this.buf = new Uint8Array(64);
    this.view = new DataView(this.buf.buffer);
    this.fill = 0;
    this.length = 0; // bytes hashed so far
    this.w = new Int32Array(16);
  }
  update(data) {
    let i = 0;
    const n = data.length;
    this.length += n;
    if (this.fill) {
      const take = Math.min(64 - this.fill, n);
      this.buf.set(data.subarray(0, take), this.fill);
      this.fill += take;
      i = take;
      if (this.fill < 64) return this;
      this.words(this.view, 0);
      this.fill = 0;
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (; i + 64 <= n; i += 64) this.words(dv, i);
    if (i < n) {
      this.buf.set(data.subarray(i), 0);
      this.fill = n - i;
    }
    return this;
  }
  words(dv, at) {
    const w = this.w;
    for (let j = 0; j < 16; j++) w[j] = dv.getInt32(at + j * 4, this.le);
    this.block(w);
  }
  // Padding: 0x80, zeros, then the length in bits (64-bit).
  pad() {
    const bits = this.length * 8;
    const tail = new Uint8Array((this.fill < 56 ? 64 : 128) - this.fill);
    tail[0] = 0x80;
    const dv = new DataView(tail.buffer);
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    if (this.le) {
      dv.setUint32(tail.length - 8, lo, true);
      dv.setUint32(tail.length - 4, hi, true);
    } else {
      dv.setUint32(tail.length - 8, hi);
      dv.setUint32(tail.length - 4, lo);
    }
    const length = this.length;
    this.update(tail);
    this.length = length;
  }
}

// ---- MD5 -------------------------------------------------------------------------------

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0);

class Md5 extends Blocks {
  constructor() {
    super(true);
    this.h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  }
  block(w) {
    const h = this.h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i] + w[g]) | 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = tmp;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
  }
  digest() {
    this.pad();
    const out = new Uint8Array(16);
    const dv = new DataView(out.buffer);
    this.h.forEach((v, i) => dv.setInt32(i * 4, v, true));
    return toHex(out);
  }
}

// ---- SHA-1 -------------------------------------------------------------------------------

class Sha1 extends Blocks {
  constructor() {
    super(false);
    this.h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0);
    this.x = new Int32Array(80);
  }
  block(w) {
    const x = this.x;
    x.set(w);
    for (let i = 16; i < 80; i++) {
      const v = x[i - 3] ^ x[i - 8] ^ x[i - 14] ^ x[i - 16];
      x[i] = (v << 1) | (v >>> 31);
    }
    const h = this.h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    const round = (i, f, k) => {
      const t = (((a << 5) | (a >>> 27)) + f + e + k + x[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    };
    for (let i = 0; i < 20; i++) round(i, (b & c) | (~b & d), 0x5a827999);
    for (let i = 20; i < 40; i++) round(i, b ^ c ^ d, 0x6ed9eba1);
    for (let i = 40; i < 60; i++) round(i, (b & c) | (b & d) | (c & d), 0x8f1bbcdc | 0);
    for (let i = 60; i < 80; i++) round(i, b ^ c ^ d, 0xca62c1d6 | 0);
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
  }
  digest() {
    this.pad();
    return wordsHex(this.h);
  }
}

// ---- SHA-256 -----------------------------------------------------------------------------

const SHA256_K = Int32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

class Sha256 extends Blocks {
  constructor() {
    super(false);
    this.h = Int32Array.of(0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0, 0x1f83d9ab, 0x5be0cd19);
    this.x = new Int32Array(64);
  }
  block(w) {
    const x = this.x;
    x.set(w);
    for (let i = 16; i < 64; i++) {
      const a = x[i - 15];
      const b = x[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      x[i] = (x[i - 16] + s0 + x[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + SHA256_K[i] + x[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + k) | 0;
  }
  digest() {
    this.pad();
    return wordsHex(this.h);
  }
}

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += HEX[b];
  return s;
}

function wordsHex(words) {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((v, i) => dv.setInt32(i * 4, v));
  return toHex(out);
}

export function createHash(algo) {
  if (algo === 'md5') return new Md5();
  if (algo === 'sha1') return new Sha1();
  if (algo === 'sha256') return new Sha256();
  throw new Error(`Unknown checksum ${algo}`);
}
