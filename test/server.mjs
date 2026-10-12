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
// Add ?ttfb=1500 to delay every response by that many ms (a far-away CDN).
import http from 'node:http';
import crypto from 'node:crypto';

export function startServer({ port = 8787, sizeMB = 40, rateKBps = 2048 } = {}) {
  const size = sizeMB * 1024 * 1024;
  const data = crypto.randomBytes(size);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const etag = `"${sha256.slice(0, 16)}"`;
  const rate = rateKBps * 1024;
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
    server.listen(port, '127.0.0.1', () => resolve({ server, size, sha256, log, url: `http://127.0.0.1:${port}` }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, sizeMB, rateKBps] = process.argv.slice(2).map(Number);
  const s = await startServer({ port: port || 8787, sizeMB: sizeMB || 40, rateKBps: rateKBps || 2048 });
  console.log(`Serving ${s.url}/file.bin (${sizeMB || 40} MB, ${rateKBps || 2048} KB/s per request), sha256 ${s.sha256}`);
}
