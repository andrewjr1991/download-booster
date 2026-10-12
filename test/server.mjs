// Local test server that behaves like an nginx `limit_rate` host: every
// request is throttled to RATE bytes/s, so parallel Range requests add up.
//   node test/server.mjs [port] [MB] [rateKBps]
// Paths:
//   /file.bin       Range-capable, ETag, throttled per request
//   /norange.bin    same bytes, ignores Range (always 200)
//   /flaky.bin      Range-capable but every 4th request is answered 503
//   /hotlink.bin    like /file.bin but 403 unless Referer is this server's /page
//   /page           an HTML page linking to /hotlink.bin (plus a few non-files)
//   /cookie.bin     like /file.bin but 403 without the cookie session=1
//   /media          a page playing /clip.mp4 (the same bytes as video/mp4), showing
//                   /photo.jpg (50 KB) and /icon.png (2 KB), and fetching
//                   /live.m3u8 and one of its /seg1.ts pieces
//   /hlspage        a page that loads /hls/master.m3u8: two qualities; "hi" has 8
//                   AES-128 pieces served from localhost (another host), 403
//                   unless the Referer is /hlspage. Joined they equal hlsPlain.
//   /media2         a page with a playable /tone.wav (1 s) and /pic.bmp (200×150),
//                   which is 403 unless the Referer is /media2
// Add ?ttfb=1500 to delay every response by that many ms (a far-away CDN).
import http from 'node:http';
import crypto from 'node:crypto';

export function startServer({ port = 8787, sizeMB = 40, rateKBps = 2048 } = {}) {
  const size = sizeMB * 1024 * 1024;
  const data = crypto.randomBytes(size);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const etag = `"${sha256.slice(0, 16)}"`;
  const rate = rateKBps * 1024;
  const tone = wav(1, 440);
  // HLS: 8 pieces of 256 KB, AES-128-CBC with the sequence number as IV.
  const hlsKey = crypto.randomBytes(16);
  const hlsPlain = data.subarray(0, 8 * 256 * 1024);
  const hlsPieces = [...Array(8).keys()].map((i) => {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(i, 12);
    const c = crypto.createCipheriv('aes-128-cbc', hlsKey, iv);
    return Buffer.concat([c.update(hlsPlain.subarray(i * 262144, (i + 1) * 262144)), c.final()]);
  });
  const hlsSha256 = crypto.createHash('sha256').update(hlsPlain).digest('hex');
  const bmp = bitmap(200, 150);
  let requests = 0;
  const log = [];

  const server = http.createServer((req, res) => {
    const ttfb = Number(new URL(req.url, 'http://x').searchParams.get('ttfb')) || 0;
    if (ttfb) setTimeout(() => handle(req, res), ttfb);
    else handle(req, res);
  });

  function handle(req, res) {
    requests++;
    const path = new URL(req.url, 'http://x').pathname;
    const range = req.headers.range;
    log.push({ path, range, ifRange: req.headers['if-range'], referer: req.headers.referer, cookie: !!req.headers.cookie });
    if (path === '/flaky.bin' && requests % 4 === 0) {
      res.writeHead(503).end();
      return;
    }
    if (path === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<a id="a" href="/hotlink.bin">download</a> <a href="/hotlink.bin#again">again</a>' +
          '<a href="/pic.png">picture</a> <a href="/about">about</a> <video src="/clip.mp4"></video>',
      );
      return;
    }
    if (path === '/hotlink.bin' && !(req.headers.referer || '').startsWith(`http://127.0.0.1:${port}/page`)) {
      res.writeHead(403).end('hotlinking not allowed');
      return;
    }
    if (path === '/cookie.bin' && !/(^|;\s*)session=1(;|$)/.test(req.headers.cookie || '')) {
      res.writeHead(403).end('login required');
      return;
    }
    if (path === '/media') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<title>media</title><video src="/clip.mp4" preload="auto" muted autoplay></video>' +
          '<img src="/photo.jpg"><img src="/icon.png">' +
          "<script>fetch('/live.m3u8');fetch('/seg1.ts')</script>",
      );
      return;
    }
    if (path === '/hlspage') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end("<title>HLS demo</title><script>fetch('/hls/master.m3u8')</script>");
      return;
    }
    if (path.startsWith('/hls/')) {
      const name = path.slice(5);
      const seg = /^hi\/(seg(\d+)\.ts|key\.bin)$/.exec(name);
      if (seg && !(req.headers.referer || '').startsWith(`http://127.0.0.1:${port}/hlspage`)) {
        res.writeHead(403).end();
        return;
      }
      if (name === 'master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlo/index.m3u8\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhi/index.m3u8\n',
        );
      } else if (name === 'hi/index.m3u8' || name === 'lo/index.m3u8') {
        // Pieces on another host name, like a CDN.
        const cdn = `http://localhost:${port}/hls/hi/`;
        const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-KEY:METHOD=AES-128,URI="${cdn}key.bin"`];
        hlsPieces.forEach((_, i) => lines.push('#EXTINF:4,', `${cdn}seg${i}.ts`));
        lines.push('#EXT-X-ENDLIST');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(lines.join('\n'));
      } else if (name === 'hi/key.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(hlsKey);
      } else if (seg && seg[2] !== undefined && hlsPieces[Number(seg[2])]) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(hlsPieces[Number(seg[2])]);
      } else res.writeHead(404).end();
      return;
    }
    if (path === '/media2') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>media2</title><audio src="/tone.wav" preload="auto"></audio><img src="/pic.bmp">');
      return;
    }
    if (path === '/tone.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': tone.length, 'Accept-Ranges': 'bytes' });
      res.end(tone);
      return;
    }
    if (path === '/pic.bmp') {
      if (!(req.headers.referer || '').startsWith(`http://127.0.0.1:${port}/media2`)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/bmp', 'Content-Length': bmp.length });
      res.end(bmp);
      return;
    }
    const small = { '/photo.jpg': ['image/jpeg', 50 * 1024], '/icon.png': ['image/png', 2048], '/seg1.ts': ['video/mp2t', 4096] }[path];
    if (small) {
      res.writeHead(200, { 'Content-Type': small[0], 'Content-Length': small[1] });
      res.end(data.subarray(0, small[1]));
      return;
    }
    if (path === '/live.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:4,\nseg1.ts\n');
      return;
    }
    if (!['/file.bin', '/norange.bin', '/flaky.bin', '/hotlink.bin', '/cookie.bin', '/clip.mp4'].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    const headers =
      path === '/clip.mp4'
        ? { 'Content-Type': 'video/mp4' }
        : {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="test-${sizeMB}MB.bin"`,
            'Access-Control-Allow-Origin': '*',
          };
    let start = 0;
    let end = size; // exclusive
    let status = 200;
    if (path !== '/norange.bin') {
      headers['Accept-Ranges'] = 'bytes';
      headers.ETag = etag;
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const ifRange = req.headers['if-range'];
      if (m && (!ifRange || ifRange === etag)) {
        start = Number(m[1]);
        end = m[2] ? Math.min(size, Number(m[2]) + 1) : size;
        if (start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end - 1}/${size}`;
      }
    }
    headers['Content-Length'] = end - start;
    res.writeHead(status, headers);

    // Throttle: send rate/10 bytes every 100 ms.
    let pos = start;
    const step = Math.max(1, Math.floor(rate / 10));
    const timer = setInterval(() => {
      const n = Math.min(step, end - pos);
      if (n <= 0) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(data.subarray(pos, pos + n));
      pos += n;
    }, 100);
    res.on('close', () => clearInterval(timer));
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, size, sha256, hlsSha256, log, url: `http://127.0.0.1:${port}` }));
  });
}

// 16-bit mono PCM sine wave.
function wav(seconds, hz, rate = 44100) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return b;
}

// 24-bit BMP with a colour gradient.
function bitmap(w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * h);
  b.write('BM', 0);
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 54 + y * row + x * 3;
      b[o] = (x * 255) / w;
      b[o + 1] = (y * 255) / h;
      b[o + 2] = 160;
    }
  return b;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, sizeMB, rateKBps] = process.argv.slice(2).map(Number);
  const s = await startServer({ port: port || 8787, sizeMB: sizeMB || 40, rateKBps: rateKBps || 2048 });
  console.log(`Serving ${s.url}/file.bin (${sizeMB || 40} MB, ${rateKBps || 2048} KB/s per request), sha256 ${s.sha256}`);
}
