// Chrome Web Store screenshots (1280×800) and promo tiles, in Chinese and
// English: loads the extension, downloads from a local server that serves
// files under realistic names, and frames the pages with a caption.
//   LANG=C.UTF-8 node test/store-shots.mjs [zh_CN|en]   → docs/store/<locale>/
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const EXT = process.env.EXT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = process.argv[2] ? [process.argv[2]] : ['zh_CN', 'en'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTIONS = {
  zh_CN: {
    manager: ['多连接分段下载，用满你的带宽', '自动选择连接数，慢连接自动换掉，支持暂停和断点续传'],
    sniff: ['网页里的视频、音频一键下载', '自动发现页面加载的视频、音频、图片和 m3u8/DASH 播放列表'],
    stream: ['m3u8 / DASH 视频合并成一个文件', '选择清晰度，加密分片自动解密，下完自动合并'],
    settings: ['限速、文件夹、校验，都能自己设', '直接写进你选的文件夹，下完自动核对 MD5 / SHA-256'],
    tile: ['下载加速器', '多连接分段下载'],
  },
  en: {
    manager: ['Multi-connection downloads that fill your bandwidth', 'Picks the connection count by itself, replaces slow connections, pauses and resumes'],
    sniff: ['Download the videos and audio on any page', 'Finds the videos, audio, images and m3u8/DASH playlists a page loads'],
    stream: ['m3u8 and DASH videos saved as one file', 'Pick a quality; encrypted pieces are decrypted and joined for you'],
    settings: ['Speed limit, save folder, checksums', 'Write straight into a folder you pick; MD5 / SHA-256 checked when done'],
    tile: ['Download Booster', 'Multi-connection downloads'],
  },
};

// Files under any name: /f/<name>?mb=<size>&kbps=<per connection>. The bytes
// are generated, so sizes cost no memory.
const MIME = { mp4: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf', iso: 'application/x-iso9660-image', zip: 'application/zip' };
function startServer(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const probe = (p) => `fetch('${p}',{headers:{Range:'bytes=0-1'}})`;
      return res.end(
        '<title>Iceland road trip</title><script>' +
          [
            probe('/f/iceland-road-trip-4k.mp4?mb=1840'),
            probe('/f/iceland-road-trip-1080p.mp4?mb=620'),
            probe('/f/drone-flyover-glacier.mp4?mb=212'),
            probe('/f/trailer-teaser.webm?mb=38'),
            probe('/f/soundtrack-northern-lights.mp3?mb=9'),
            "fetch('/hls/master.m3u8')",
          ].join(';') +
          '</script>',
      );
    }
    if (u.pathname === '/hlspage') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end("<title>Iceland road trip – full episode</title><script>fetch('/hls/master.m3u8')</script>");
    }
    if (u.pathname === '/hls/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(
        '#EXTM3U\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\n1080/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1280x720\n720/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=854x480\n480/index.m3u8\n',
      );
    }
    if (/^\/hls\/\d+\/index\.m3u8$/.test(u.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'];
      for (let i = 0; i < 472; i++) lines.push('#EXTINF:6,', `seg${i}.ts`);
      lines.push('#EXT-X-ENDLIST');
      return res.end(lines.join('\n'));
    }
    const m = /^\/f\/(.+)$/.exec(u.pathname);
    if (!m) return res.writeHead(404).end();
    const name = decodeURIComponent(m[1]);
    const size = Math.floor(Number(u.searchParams.get('mb') || 10) * 1048576);
    const rate = Number(u.searchParams.get('kbps') || 2500) * 1024;
    let start = 0;
    let end = size;
    const headers = {
      'Content-Type': MIME[name.split('.').pop()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Access-Control-Allow-Origin': '*',
    };
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      start = Number(r[1]);
      end = r[2] ? Math.min(size, Number(r[2]) + 1) : size;
      headers['Content-Range'] = `bytes ${start}-${end - 1}/${size}`;
    }
    headers['Content-Length'] = end - start;
    res.writeHead(r ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    let at = start;
    const chunk = Math.max(16384, Math.floor(rate / 10));
    const pump = () => {
      if (res.destroyed) return;
      if (at >= end) return res.end();
      const n = Math.min(chunk, end - at);
      const buf = Buffer.alloc(n, at & 255);
      at += n;
      res.write(buf);
      setTimeout(pump, 100);
    };
    pump();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// A page screenshot framed for the store: caption above, page below.
async function frame(ctx, out, png, [title, sub], { width, height, shotWidth }) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{background:linear-gradient(135deg,#2563eb 0%,#4f46e5 55%,#7c3aed 100%);font-family:Inter,"Noto Sans CJK SC","WenQuanYi Zen Hei",system-ui,sans-serif;color:#fff;display:flex;flex-direction:column;align-items:center}
    h1{font-size:44px;font-weight:700;margin:52px 0 10px;letter-spacing:.5px}
    p{font-size:21px;margin:0 0 34px;opacity:.88}
    img{width:${shotWidth}px;border-radius:14px;box-shadow:0 24px 60px rgba(15,23,42,.45)}
  </style><h1>${title}</h1><p>${sub}</p><img src="data:image/png;base64,${png.toString('base64')}">`);
  await p.waitForFunction(() => document.querySelector('img').complete);
  await p.screenshot({ path: out });
  await p.close();
}

async function tile(ctx, out, [name, sub], icon, { width, height }) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  const big = height > 400;
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{background:linear-gradient(135deg,#2563eb 0%,#4f46e5 55%,#7c3aed 100%);font-family:Inter,"Noto Sans CJK SC","WenQuanYi Zen Hei",system-ui,sans-serif;color:#fff;display:flex;align-items:center;justify-content:center;gap:${big ? 48 : 22}px}
    img{width:${big ? 190 : 96}px;height:${big ? 190 : 96}px;border-radius:22%;box-shadow:0 14px 40px rgba(15,23,42,.35)}
    h1{font-size:${big ? 72 : 36}px;margin:0 0 ${big ? 14 : 6}px;font-weight:700}
    p{font-size:${big ? 32 : 19}px;margin:0;opacity:.9}
  </style><img src="data:image/png;base64,${icon.toString('base64')}"><div><h1>${name}</h1><p>${sub}</p></div>`);
  await p.waitForFunction(() => document.querySelector('img').complete);
  await p.screenshot({ path: out });
  await p.close();
}

const server = await startServer(8790);
// The pages and files appear under a made-up site name (mapped to the local server).
const base = 'http://media.example.com';
const icon = fs.readFileSync(path.join(EXT, 'docs', 'store', 'icon-512.png')); // tools/make-icon128.py
// Pages are captured at 2× and framed at 1×, so the text stays sharp.
const framer = await chromium.launch({ channel: 'chromium' });
const fctx = await framer.newContext({ deviceScaleFactor: 1 });

for (const locale of LOCALES) {
  const outDir = path.join(EXT, 'docs', 'store', locale);
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-shots-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true,
    channel: 'chromium',
    locale: locale.replace('_', '-'),
    deviceScaleFactor: 2,
    env: { ...process.env, LANGUAGE: locale },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--lang=${locale.replace('_', '-')}`, '--host-resolver-rules=MAP media.example.com 127.0.0.1:8790'],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    const C = CAPTIONS[locale];

    // 1. The download manager with downloads running and finished.
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`chrome-extension://${extId}/src/manager.html`);
    await page.waitForSelector('body[data-synced]');
    const engine = (cmd, args = {}) => page.evaluate(([cmd, args]) => chrome.runtime.sendMessage({ type: 'engine', cmd, ...args }), [cmd, args]);
    await page.evaluate(() => chrome.storage.local.set({ settings: { autoTakeover: false, minSizeMB: 20, maxConnections: 6 } }));
    await engine('set-limit', { maxActive: 3, speedLimit: 0 });
    const add = (name, mb, kbps) => engine('add', { url: `${base}/f/${name}?mb=${mb}&kbps=${kbps}`, maxConnections: 6 });
    const waitDone = async (id) => {
      for (let i = 0; i < 240; i++) {
        const t = (await engine('list')).tasks.find((x) => x.id === id);
        if (t?.status === 'completed') return;
        await sleep(250);
      }
    };
    await waitDone((await add('podcast-episode-42.mp3', 58, 20000)).id);
    await waitDone((await add('annual-report-2026.pdf', 24, 20000)).id);
    const running = [];
    running.push((await add('Blender-4.2.3-windows-x64.msi', 342, 2600)).id);
    running.push((await add('iceland-road-trip-4k.mp4', 1840, 2200)).id);
    running.push((await add('ubuntu-24.04.1-desktop-amd64.iso', 5970, 2800)).id);
    await sleep(9000);
    const manager = await page.screenshot();
    await frame(fctx, path.join(outDir, '1-downloads.png'), manager, C.manager, { width: 1280, height: 800, shotWidth: 1000 });

    // 4. Settings, opened.
    for (const id of running) await engine('pause', { id });
    await page.click('#nav-settings');
    await sleep(500);
    const settings = await page.screenshot();
    await frame(fctx, path.join(outDir, '4-settings.png'), settings, C.settings, { width: 1280, height: 800, shotWidth: 1000 });
    for (const id of running) await engine('remove', { id });

    // 2. The popup listing what a page loaded.
    const site = await ctx.newPage();
    await site.goto(`${base}/page`);
    await sleep(2000);
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/page`);
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 400, height: 420 });
    await pop.goto(`chrome-extension://${extId}/src/popup.html?tab=${tabId}`);
    await pop.waitForSelector('#media-list li');
    await sleep(500);
    const sniff = await pop.screenshot();
    await frame(fctx, path.join(outDir, '2-sniff.png'), sniff, C.sniff, { width: 1280, height: 800, shotWidth: 430 });

    // 3. Picking the quality of an m3u8 stream.
    await pop.click('#kinds button[data-kind="stream"]');
    await pop.click('#media-list li button.act');
    await pop.setViewportSize({ width: 400, height: 560 });
    await pop.waitForSelector('.qualities label');
    await pop.waitForFunction(() => !document.querySelector('#pv-download').disabled);
    await sleep(500);
    const stream = await pop.screenshot();
    await frame(fctx, path.join(outDir, '3-m3u8.png'), stream, C.stream, { width: 1280, height: 800, shotWidth: 430 });

    await tile(fctx, path.join(outDir, 'promo-small-440x280.png'), C.tile, icon, { width: 440, height: 280 });
    await tile(fctx, path.join(outDir, 'promo-marquee-1400x560.png'), C.tile, icon, { width: 1400, height: 560 });
    console.log(`${locale}: ${fs.readdirSync(outDir).join(', ')}`);
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}
await framer.close();
server.close();
