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
//   /hlsav/master.m3u8  HLS (CMAF) with the audio as a separate rendition: the
//                   fixtures' init sections and fragments as byte ranges of
//                   /mse/video.mp4 and /mse/audio.mp4. Joined they equal mseSha256.
//   /hlsts/master.m3u8  MPEG-TS video (hlsPlain in 8 plain pieces) with separate
//                   .aac audio pieces (hlsAudio, sha256 hlsAudioSha256).
//   /msepage        a blob: video: the page feeds MediaSource the fragmented MP4s in
//                   test/fixtures (separate video and audio) in small pieces.
//                   Joined they equal mseSha256. ?end=0 feeds only the first half
//                   and never ends the stream.
//   /dash/list.mpd  DASH, SegmentList: byte ranges of /mse/video.mp4 and /mse/audio.mp4,
//                   plus a lower quality and a second language that must not be
//                   fetched (/dash/never/...). Joined they equal mseSha256.
//   /dash/base.mpd  DASH, SegmentBase: one file per track (/dash/v-sidx.mp4,
//                   /dash/a-sidx.mp4: the fixtures with a sidx index added).
//   /dash/tpl.mpd   DASH, SegmentTemplate: video by $Number%03d$, audio by
//                   SegmentTimeline $Time$, pieces under /dash/seg/.
//   /dashpage       a page that loads /dash/tpl.mpd.
// Add ?ttfb=1500 to delay every response by that many ms (a far-away CDN).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Mp4Stream, mux } from '../src/fmp4.js';

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
  const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const mseFiles = { '/mse/video.mp4': fixture('video.mp4'), '/mse/audio.mp4': fixture('audio.mp4') };
  const mseSha256 = crypto
    .createHash('sha256')
    .update(
      Buffer.concat(
        mux(
          Object.values(mseFiles).map((b) => {
            const st = new Mp4Stream();
            st.push(new Uint8Array(b));
            return st.settle();
          }),
        ),
      ),
    )
    .digest('hex');
  // CMAF HLS: one playlist per fixture, its boxes as byte ranges.
  const cmafPlaylist = (file) => {
    const b = mseFiles[file];
    const top = [];
    for (let at = 0; at + 8 <= b.length; ) {
      const size = b.readUInt32BE(at);
      top.push({ type: b.toString('latin1', at + 4, at + 8), at, size });
      at += size;
    }
    const moov = top.find((x) => x.type === 'moov');
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', `#EXT-X-MAP:URI="${file}",BYTERANGE="${moov.at + moov.size}@0"`];
    for (const [i, x] of top.entries()) {
      if (x.type !== 'moof') continue;
      const mdat = top[i + 1];
      lines.push('#EXTINF:1,', `#EXT-X-BYTERANGE:${x.size + mdat.size}@${x.at}`, file);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
  };
  // DASH: the same fixtures as pieces, as single files with a sidx, and as
  // ranges.
  const dash = {};
  for (const [kind, file] of [['v', '/mse/video.mp4'], ['a', '/mse/audio.mp4']]) {
    const b = mseFiles[file];
    const boxes = [];
    for (let at = 0; at + 8 <= b.length; ) {
      const size = b.readUInt32BE(at);
      boxes.push({ type: b.toString('latin1', at + 4, at + 8), at, size });
      at += size;
    }
    const moov = boxes.find((x) => x.type === 'moov');
    const initEnd = moov.at + moov.size;
    const frags = boxes.filter((x) => x.type === 'moof').map((x, i, all) => ({ at: x.at, end: all[i + 1]?.at ?? b.length }));
    const sidx = Buffer.alloc(32 + 12 * frags.length);
    sidx.writeUInt32BE(sidx.length, 0);
    sidx.write('sidx', 4, 'latin1');
    sidx.writeUInt32BE(1, 12); // reference_ID
    sidx.writeUInt32BE(1000, 16); // timescale
    sidx.writeUInt32BE(frags[0].at - initEnd, 24); // first_offset
    sidx.writeUInt16BE(frags.length, 30);
    frags.forEach((f, i) => {
      sidx.writeUInt32BE(f.end - f.at, 32 + 12 * i);
      sidx.writeUInt32BE(1000, 36 + 12 * i);
      sidx.writeUInt32BE(0x90000000, 40 + 12 * i);
    });
    dash[kind] = {
      file,
      initEnd,
      frags,
      init: b.subarray(0, initEnd),
      pieces: frags.map((f) => b.subarray(f.at, f.end)),
      sidxFile: Buffer.concat([b.subarray(0, initEnd), sidx, b.subarray(initEnd)]),
      sidxSize: sidx.length,
    };
  }
  const mpd = (sets, seconds) =>
    `<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${seconds}S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">\n<Period>\n${sets.join('\n')}\n</Period>\n</MPD>`;
  const set = (type, attrs, reps) => `<AdaptationSet contentType="${type}" mimeType="${type}/mp4" ${attrs}>${reps}</AdaptationSet>`;
  const dashSeconds = Math.max(dash.v.pieces.length, dash.a.pieces.length);
  const lowVideo = '<Representation id="low" bandwidth="10000" width="80" height="45" codecs="vp09.00.10.08"><BaseURL>never/low.mp4</BaseURL></Representation>';
  const french = set('audio', 'lang="fr"', '<Representation id="fr" bandwidth="64000" codecs="opus"><BaseURL>never/fr.mp4</BaseURL></Representation>');
  const dashManifests = {
    '/dash/list.mpd': mpd(
      [
        set(
          'video',
          '',
          `${lowVideo}<Representation id="v" bandwidth="300000" width="160" height="90" codecs="vp09.00.10.08"><SegmentList timescale="1" duration="1"><Initialization sourceURL="/mse/video.mp4" range="0-${dash.v.initEnd - 1}"/>${dash.v.frags.map((f) => `<SegmentURL media="/mse/video.mp4" mediaRange="${f.at}-${f.end - 1}"/>`).join('')}</SegmentList></Representation>`,
        ),
        set('audio', 'lang="en"', `<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="a" bandwidth="64000" codecs="opus"><SegmentList timescale="1" duration="1"><Initialization sourceURL="/mse/audio.mp4" range="0-${dash.a.initEnd - 1}"/>${dash.a.frags.map((f) => `<SegmentURL media="/mse/audio.mp4" mediaRange="${f.at}-${f.end - 1}"/>`).join('')}</SegmentList></Representation>`),
        french,
      ],
      dashSeconds,
    ),
    '/dash/base.mpd': mpd(
      [
        set('video', '', `<Representation id="v" bandwidth="300000" width="160" height="90" codecs="vp09.00.10.08"><BaseURL>v-sidx.mp4</BaseURL><SegmentBase indexRange="${dash.v.initEnd}-${dash.v.initEnd + dash.v.sidxSize - 1}"><Initialization range="0-${dash.v.initEnd - 1}"/></SegmentBase></Representation>`),
        set('audio', 'lang="en"', `<Representation id="a" bandwidth="64000" codecs="opus"><BaseURL>a-sidx.mp4</BaseURL><SegmentBase indexRange="${dash.a.initEnd}-${dash.a.initEnd + dash.a.sidxSize - 1}"><Initialization range="0-${dash.a.initEnd - 1}"/></SegmentBase></Representation>`),
      ],
      dashSeconds,
    ),
    '/dash/tpl.mpd': mpd(
      [
        set('video', '', `<SegmentTemplate timescale="1" duration="1" startNumber="1" initialization="seg/$RepresentationID$/init.mp4" media="seg/$RepresentationID$/$Number%03d$.m4s"/>${lowVideo}<Representation id="v" bandwidth="300000" width="160" height="90" codecs="vp09.00.10.08"/>`),
        set('audio', 'lang="en"', `<Representation id="a" bandwidth="64000" codecs="opus"><SegmentTemplate timescale="48000" initialization="seg/a/init.mp4" media="seg/a/t$Time$.m4s"><SegmentTimeline><S t="0" d="48000" r="${dash.a.pieces.length - 1}"/></SegmentTimeline></SegmentTemplate></Representation>`),
        french,
      ],
      dash.v.pieces.length,
    ),
  };
  const hlsAudio = crypto.randomBytes(4 * 65536);
  const hlsAudioSha256 = crypto.createHash('sha256').update(hlsAudio).digest('hex');
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
    if (path === '/hlsav/master.m3u8' || path === '/hlsts/master.m3u8') {
      const ts = path.startsWith('/hlsts');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"\n' +
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Other",LANGUAGE="fr",URI="other.m3u8"\n' +
          `#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,AUDIO="aud"${ts ? '' : ',CODECS="vp09.00.10.08,opus"'}\nvideo.m3u8\n`,
      );
      return;
    }
    if (path === '/hlsav/video.m3u8' || path === '/hlsav/audio.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(cmafPlaylist(path.endsWith('video.m3u8') ? '/mse/video.mp4' : '/mse/audio.mp4'));
      return;
    }
    if (path === '/hlsts/video.m3u8' || path === '/hlsts/audio.m3u8') {
      const audio = path.endsWith('audio.m3u8');
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4'];
      for (let i = 0; i < (audio ? 4 : 8); i++) lines.push('#EXTINF:4,', audio ? `a${i}.aac` : `v${i}.ts`);
      lines.push('#EXT-X-ENDLIST');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(lines.join('\n'));
      return;
    }
    if (dashManifests[path]) {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      res.end(dashManifests[path]);
      return;
    }
    if (path === '/dash/v-sidx.mp4' || path === '/dash/a-sidx.mp4') {
      const body = dash[path[6]].sidxFile;
      const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!r) {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
        res.end(body);
        return;
      }
      const start = Number(r[1]);
      const end = r[2] ? Math.min(Number(r[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
      return;
    }
    const dashSeg = /^\/dash\/seg\/(v|a)\/(init\.mp4|(\d+)\.m4s|t(\d+)\.m4s)$/.exec(path);
    if (dashSeg) {
      const d = dash[dashSeg[1]];
      const piece = dashSeg[2] === 'init.mp4' ? d.init : d.pieces[dashSeg[3] !== undefined ? Number(dashSeg[3]) - 1 : Number(dashSeg[4]) / 48000];
      if (!piece) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'video/iso.segment' });
      res.end(piece);
      return;
    }
    if (path === '/dashpage') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>DASH demo</title><p>DASH</p><script>fetch("/dash/tpl.mpd")</script>');
      return;
    }
    const tsPiece = /^\/hlsts\/(v|a)(\d+)\.(ts|aac)$/.exec(path);
    if (tsPiece) {
      const i = Number(tsPiece[2]);
      const size = tsPiece[1] === 'v' ? 262144 : 65536;
      const src = tsPiece[1] === 'v' ? hlsPlain : hlsAudio;
      res.writeHead(200, { 'Content-Type': tsPiece[1] === 'v' ? 'video/mp2t' : 'audio/aac' });
      res.end(src.subarray(i * size, (i + 1) * size));
      return;
    }
    if (path === '/msepage') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<title>MSE demo</title><video controls muted></video><script>
const v = document.querySelector('video');
const ms = new MediaSource();
v.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', async () => {
  const full = new URLSearchParams(location.search).get('end') !== '0';
  const feed = async (mime, url) => {
    const sb = ms.addSourceBuffer(mime);
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const end = full ? b.length : b.length >> 1;
    for (let at = 0; at < end; at += 16384) {
      sb.appendBuffer(b.subarray(at, Math.min(end, at + 16384)));
      await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  await Promise.all([feed('video/mp4; codecs="vp09.00.10.08"', '/mse/video.mp4'), feed('audio/mp4; codecs="opus"', '/mse/audio.mp4')]);
  if (full) ms.endOfStream();
});
</script>`);
      return;
    }
    if (mseFiles[path]) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(mseFiles[path]);
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
    server.listen(port, '127.0.0.1', () => resolve({ server, size, sha256, hlsSha256, hlsAudioSha256, mseSha256, log, url: `http://127.0.0.1:${port}` }));
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
