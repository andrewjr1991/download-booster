// End-to-end test: loads the unpacked extension into Chromium (Playwright),
// downloads from the local throttled server and checks the saved bytes.
//   node test/e2e.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { startH2Server } from './h2server.mjs';

const EXT = process.env.EXT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_MB = Number(process.env.SIZE_MB || 40);
const RATE = Number(process.env.RATE_KBPS || 2048);

const srv = await startServer({ port: 8787, sizeMB: SIZE_MB, rateKBps: RATE });
const h2 = await startH2Server({ port: 8443, sizeMB: SIZE_MB, rateKBps: RATE });
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-e2e-'));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-profile-'));

const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium', // new headless mode, which can load extensions
  executablePath: process.env.CHROMIUM || undefined,
  acceptDownloads: true,
  downloadsPath: downloadDir,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--ignore-certificate-errors'],
});

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
page.on('console', (m) => process.env.VERBOSE && console.log('[manager]', m.text()));
await page.goto(`chrome-extension://${extId}/src/manager.html`);
// The manager sends the saved limits on load; let that land before tests set their own.
await page.waitForSelector('body[data-synced]');

const engine = (cmd, args = {}) => page.evaluate(([cmd, args]) => chrome.runtime.sendMessage({ type: 'engine', cmd, ...args }), [cmd, args]);
const setSettings = (s) => page.evaluate((s) => chrome.storage.local.set({ settings: s }), s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTask(id, pred, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const { tasks } = await engine('list');
    const task = tasks.find((x) => x.id === id);
    if (task && pred(task)) return task;
    if (task?.status === 'error') throw new Error(`task failed: ${JSON.stringify(task.error)}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout; last: ${JSON.stringify(task && { ...task, segments: undefined })}`);
    await sleep(250);
  }
}

async function savedFileHash(downloadId) {
  for (let i = 0; i < 40; i++) {
    const [item] = await page.evaluate((id) => chrome.downloads.search({ id }), downloadId);
    if (item?.state === 'complete' && item.filename && fs.existsSync(item.filename)) {
      return { hash: crypto.createHash('sha256').update(fs.readFileSync(item.filename)).digest('hex'), item };
    }
    await sleep(250);
  }
  // Playwright may store downloads under GUID names; fall back to newest file.
  const files = fs.readdirSync(downloadDir).map((f) => path.join(downloadDir, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return { hash: crypto.createHash('sha256').update(fs.readFileSync(files[0])).digest('hex'), item: { filename: files[0] } };
}

const results = [];
async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, info, s: ((Date.now() - t0) / 1000).toFixed(1) });
    console.log(`PASS ${name} ${info || ''}`);
  } catch (err) {
    results.push({ name, ok: false, info: String(err), s: ((Date.now() - t0) / 1000).toFixed(1) });
    console.log(`FAIL ${name}: ${err.stack || err}`);
  }
}

const mbps = (b, ms) => `${(b / 1048576 / (ms / 1000)).toFixed(1)} MB/s`;

async function download(url, settings) {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6, ...settings });
  const { id } = await engine('add', { url, maxConnections: settings?.maxConnections ?? 6 });
  const t0 = Date.now();
  let maxConns = 0;
  const done = await waitTask(id, (t) => {
    maxConns = Math.max(maxConns, t.connections || 0);
    return t.status === 'completed';
  });
  const ms = Date.now() - t0;
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  return { done, ms, maxConns };
}

let single;
await check('single connection baseline (max 1)', async () => {
  single = await download(`${srv.url}/file.bin`, { maxConnections: 1 });
  return `${mbps(srv.size, single.ms)}, ${single.maxConns} conn`;
});

await check('adaptive multi-connection, bytes identical', async () => {
  const r = await download(`${srv.url}/file.bin`, { maxConnections: 6 });
  const st = r.done.stats;
  const levels = Object.entries(st.levels || {}).map(([k, v]) => `${k}:${(v / 1048576).toFixed(1)}`).join(' ');
  if (single && r.ms > single.ms * 0.6) throw new Error(`not faster: ${r.ms}ms vs ${single.ms}ms`);
  return `${mbps(srv.size, r.ms)} (×${(single.ms / r.ms).toFixed(1)}), peak ${r.maxConns} conns, levels MB/s {${levels}}`;
});

await check('slow first byte (1.5 s per request) still scales past 1 connection', async () => {
  const r = await download(`${srv.url}/file.bin?ttfb=1500`, { maxConnections: 6 });
  if (r.maxConns < 4) throw new Error(`peaked at ${r.maxConns} connections`);
  return `${mbps(srv.size, r.ms)}, peak ${r.maxConns} conns`;
});

await check('HTTP/2 with a per-connection limit: second connection pool doubles speed', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const { id } = await engine('add', { url: `${h2.url}/file.bin`, maxConnections: 6 });
  const t0 = Date.now();
  let proto = null;
  let maxConns = 0;
  const done = await waitTask(id, (t) => {
    proto ||= t.protocol;
    maxConns = Math.max(maxConns, t.connections || 0);
    return t.status === 'completed';
  });
  const ms = Date.now() - t0;
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== h2.sha256) throw new Error('hash mismatch');
  const sessions = new Set(h2.log.map((l) => l.session)).size;
  const single = (RATE * 1024) / 1048576;
  const avg = h2.size / 1048576 / (ms / 1000);
  if (avg < single * 1.4) throw new Error(`avg ${avg.toFixed(1)} MB/s vs ${single} MB/s per connection (protocol ${proto}, ${sessions} sessions)`);
  return `${avg.toFixed(1)} MB/s (one connection: ${single} MB/s), protocol ${proto}, peak ${maxConns} requests, levels ${JSON.stringify(done.stats.levels)}`;
});

await check('login-protected file: cookie-less pool is dropped, download still completes', async () => {
  await ctx.addCookies([{ name: 'session', value: '1', domain: '127.0.0.1', path: '/' }]);
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const mark = srv.log.length;
  const { id } = await engine('add', { url: `${srv.url}/cookie.bin`, maxConnections: 6 });
  let maxConns = 0;
  const done = await waitTask(id, (t) => {
    maxConns = Math.max(maxConns, t.connections || 0);
    return t.status === 'completed';
  });
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  const reqs = srv.log.slice(mark).filter((l) => l.path === '/cookie.bin');
  return `peak ${maxConns} conns, ${reqs.filter((l) => !l.cookie).length} cookie-less request(s) refused then dropped`;
});

await check('server without Range support falls back to one stream', async () => {
  const r = await download(`${srv.url}/norange.bin`, { maxConnections: 6 });
  if (r.done.rangeSupported !== false || r.maxConns > 1) throw new Error('expected single stream');
  return mbps(srv.size, r.ms);
});

await check('flaky server (every 4th request 503) still completes', async () => {
  const r = await download(`${srv.url}/flaky.bin`, { maxConnections: 6 });
  return `${mbps(srv.size, r.ms)}, peak ${r.maxConns} conns`;
});

await check('pause and resume uses If-Range and keeps bytes intact', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const { id } = await engine('add', { url: `${srv.url}/file.bin`, maxConnections: 6 });
  await waitTask(id, (t) => t.downloaded > srv.size * 0.25);
  await engine('pause', { id });
  const paused = await waitTask(id, (t) => t.status === 'paused');
  const before = srv.log.length;
  await sleep(500);
  await engine('resume', { id });
  const done = await waitTask(id, (t) => t.status === 'completed');
  const ifRange = srv.log.slice(before).filter((l) => l.ifRange).length;
  if (!ifRange) throw new Error('resume requests did not send If-Range');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  return `paused at ${((paused.downloaded / srv.size) * 100).toFixed(0)}%, ${ifRange} If-Range requests after resume`;
});

await check('queue: only N tasks download at once, the rest wait and then run', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 1, maxActive: 2 });
  await engine('set-limit', { maxActive: 2 });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await engine('add', { url: `${srv.url}/file.bin?q=${i}`, maxConnections: 1 })).id);
  let maxRunning = 0;
  let sawQueued = false;
  for (;;) {
    const mine = (await engine('list')).tasks.filter((t) => ids.includes(t.id));
    maxRunning = Math.max(maxRunning, mine.filter((t) => t.status === 'downloading').length);
    sawQueued ||= mine.some((t) => t.status === 'queued');
    if (mine.some((t) => t.status === 'error')) throw new Error('a task failed');
    if (mine.every((t) => t.status === 'completed')) break;
    await sleep(250);
  }
  await engine('set-limit', { maxActive: 3 });
  if (maxRunning > 2) throw new Error(`${maxRunning} tasks ran at once`);
  if (!sawQueued) throw new Error('third task never waited in the queue');
  return `max ${maxRunning} running, third task queued then completed`;
});

await check('auto takeover of a normal browser download', async () => {
  await setSettings({ autoTakeover: true, minSizeMB: 20, maxConnections: 6 });
  const before = (await engine('list')).tasks.map((t) => t.id);
  const p = await ctx.newPage();
  await p.setContent(`<a id="a" href="${srv.url}/file.bin">get</a>`);
  await p.click('#a').catch(() => {});
  let task;
  for (let i = 0; i < 40 && !task; i++) {
    await sleep(250);
    task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  }
  if (!task) throw new Error('download was not taken over');
  const done = await waitTask(task.id, (t) => t.status === 'completed');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  const natives = await page.evaluate(() => chrome.downloads.search({}));
  const leftovers = natives.filter((d) => d.url.endsWith('/file.bin') && d.state === 'in_progress');
  if (leftovers.length) throw new Error('native download still running');
  await p.close();
  return `taken over as ${done.filename}`;
});

await check('hotlink-protected file: Referer from the page is sent on every request', async () => {
  await setSettings({ autoTakeover: true, minSizeMB: 20, maxConnections: 6 });
  const before = (await engine('list')).tasks.map((t) => t.id);
  const mark = srv.log.length;
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/page`);
  await p.click('#a').catch(() => {});
  let task;
  for (let i = 0; i < 40 && !task; i++) {
    await sleep(250);
    task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  }
  if (!task) throw new Error('download was not taken over');
  const done = await waitTask(task.id, (t) => t.status === 'completed');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  const ours = srv.log.slice(mark).filter((l) => l.path === '/hotlink.bin' && l.range);
  const missing = ours.filter((l) => !l.referer).length;
  if (missing) throw new Error(`${missing} of ${ours.length} range requests had no Referer`);
  await p.close();
  return `${ours.length} range requests, all with Referer`;
});

await check('Referer passed when adding by hand', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const { id } = await engine('add', { url: `${srv.url}/hotlink.bin`, referrer: `${srv.url}/page`, maxConnections: 6 });
  const done = await waitTask(id, (t) => t.status === 'completed');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  return 'ok';
});

await check('pasting several links adds one task per link', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 1 });
  const before = (await engine('list')).tasks.map((t) => t.id);
  const urls = [`${srv.url}/file.bin?paste=1`, `${srv.url}/file.bin?paste=2`];
  await page.fill('#url', `${urls[0]}\n  not-a-link\n${urls[1]}\n${urls[0]}`);
  await page.press('#url', 'Enter');
  let added = [];
  for (let i = 0; i < 20 && added.length < 2; i++) {
    await sleep(250);
    added = (await engine('list')).tasks.filter((t) => !before.includes(t.id));
  }
  const got = added.map((t) => t.url).sort();
  if (JSON.stringify(got) !== JSON.stringify(urls)) throw new Error(`added ${JSON.stringify(got)}`);
  const note = await page.textContent('#add-msg');
  for (const t of added) await engine('remove', { id: t.id });
  return `2 tasks, note "${note}"`;
});

await check('sniffing a page lists its files and downloads the picked ones with its Referer', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const before = (await engine('list')).tasks.map((t) => t.id);
  const mark = srv.log.length;
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/page`);
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await sniffPage(tab);
  }, `${srv.url}/page`);
  await page.waitForURL(/sniff=1/);
  await page.waitForSelector('#sniff:not([hidden]) #sniff-list li');
  const chips = await page.$$eval('#sniff-filters button', (bs) => bs.map((b) => `${b.dataset.cat}:${b.getAttribute('aria-pressed')}`));
  const want = ['video:true', 'disk:true', 'image:false', 'other:false'];
  if (JSON.stringify(chips) !== JSON.stringify(want)) throw new Error(`chips ${JSON.stringify(chips)}`);
  await page.click('#sniff-filters button[data-cat="video"]'); // hide the video
  const rows = await page.$$eval('#sniff-list li', (lis) => lis.map((li) => li.textContent));
  if (rows.length !== 1 || !rows[0].includes('hotlink.bin')) throw new Error(`rows ${JSON.stringify(rows)}`);
  await page.click('#sniff-go');
  let task;
  for (let i = 0; i < 20 && !task; i++) {
    await sleep(250);
    task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  }
  if (!task) throw new Error('nothing was added');
  const done = await waitTask(task.id, (t) => t.status === 'completed');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  const added = (await engine('list')).tasks.filter((t) => !before.includes(t.id)).length;
  if (added !== 1) throw new Error(`${added} tasks added`);
  const ours = srv.log.slice(mark).filter((l) => l.path === '/hotlink.bin' && l.range);
  if (ours.some((l) => !l.referer)) throw new Error('a request had no Referer');
  if (!(await page.isHidden('#sniff'))) throw new Error('panel still open');
  await p.close();
  return `chips ${chips.join(' ')}, 1 file picked, ${ours.length} requests with Referer`;
});

async function sniffInManager(url) {
  const p = await ctx.newPage();
  await p.goto(url);
  await sleep(1500); // let the page load its media
  await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await sniffPage(tab);
  }, url);
  await page.waitForURL(/sniff=1/);
  await page.waitForSelector('#sniff:not([hidden]) #sniff-list li');
  const chips = await page.$$eval('#sniff-filters button', (bs) => bs.map((b) => `${b.dataset.cat}:${b.getAttribute('aria-pressed')}`));
  return { p, chips };
}

await check('manager sniff list includes the audio and images the page loaded, with previews', async () => {
  const { p, chips } = await sniffInManager(`${srv.url}/media2`);
  if (!chips.includes('audio:true') || !chips.includes('image:false')) throw new Error(`chips ${JSON.stringify(chips)}`);
  const audioRow = await page.textContent('#sniff-list li');
  if (!audioRow.includes('tone.wav') || !/KB/.test(audioRow)) throw new Error(`audio row "${audioRow}"`);
  await page.click('#sniff-filters button[data-cat="image"]');
  // The thumbnail of the hotlink-protected picture loads with the page's Referer.
  await page.waitForFunction(() => document.querySelector('#sniff-list .lthumb')?.naturalWidth === 200, null, { timeout: 10000 });
  const imgRow = await page.$('#sniff-list li:has(.lthumb)');
  await (await imgRow.$('.lpreview')).click();
  await page.waitForFunction(() => document.querySelector('#sp-info').textContent.includes('200×150'), null, { timeout: 10000 });
  const info = await page.textContent('#sp-info');
  await page.click('#sp-close');
  await page.click('#sniff-close');
  await p.close();
  return `chips ${chips.join(' ')}, audio row "${audioRow.trim()}", image preview "${info}"`;
});

await check('manager sniff list downloads a page’s m3u8 as one joined video', async () => {
  const before = (await engine('list')).tasks.map((t) => t.id);
  const { p, chips } = await sniffInManager(`${srv.url}/hlspage`);
  if (!chips.includes('stream:true')) throw new Error(`chips ${JSON.stringify(chips)}`);
  await page.click('#sniff-go');
  let task;
  for (let i = 0; i < 20 && !task; i++) {
    await sleep(250);
    task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  }
  if (!task || task.kind !== 'hls') throw new Error(`added ${JSON.stringify(task && task.kind)}`);
  const done = await waitTask(task.id, (t) => t.status === 'completed', 60000);
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.hlsSha256) throw new Error('joined file differs from the original');
  await p.close();
  return `chips ${chips.join(' ')}, saved ${done.filename}`;
});

await check('batch: sniffing rules, copying links and a rename rule', async () => {
  // Rules typed into the manager's settings: show small images, ignore "photo".
  await page.evaluate(() => (document.querySelector('#settings').open = true));
  await page.fill('#rule-minImageKB', '1');
  await page.dispatchEvent('#rule-minImageKB', 'change');
  await page.fill('#rule-ignore', 'photo');
  await page.dispatchEvent('#rule-ignore', 'change');
  await sleep(300);
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/media`);
  await sleep(1500);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${srv.url}/media`);
  const media = await sw.evaluate(async (id) => (await chrome.storage.session.get(`media:${id}`))[`media:${id}`].map((m) => m.name), tabId);
  if (!media.includes('icon.png') || media.includes('photo.jpg')) throw new Error(`media ${JSON.stringify(media)}`);
  await p.close();
  await page.fill('#rule-minImageKB', '10');
  await page.fill('#rule-ignore', '');
  await page.dispatchEvent('#rule-ignore', 'change');

  // Rename and copy in the page link list.
  const before = (await engine('list')).tasks.map((t) => t.id);
  const q = await ctx.newPage();
  await q.goto(`${srv.url}/page`);
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await sniffPage(tab);
  }, `${srv.url}/page`);
  await page.waitForURL(/sniff=1/);
  await page.waitForSelector('#sniff:not([hidden]) #sniff-list li');
  await page.fill('#sniff-rename', 'batch-{n}');
  const preview = await page.textContent('#sniff-rename-preview');
  if (!preview.includes('batch-1.mp4') || !preview.includes('batch-2.bin')) throw new Error(`preview "${preview}"`);
  // Tests can't read the clipboard here: note what the page writes to it.
  await page.evaluate(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => ((window.copiedText = text), write(text).catch(() => {}));
  });
  await page.click('#sniff-copy');
  const copied = await page.evaluate(() => window.copiedText);
  if (copied !== `${srv.url}/clip.mp4\n${srv.url}/hotlink.bin`) throw new Error(`copied ${JSON.stringify(copied)}`);
  await page.click('#sniff-go');
  let added = [];
  for (let i = 0; i < 20 && added.length < 2; i++) {
    await sleep(250);
    added = (await engine('list')).tasks.filter((t) => !before.includes(t.id));
  }
  const names = [];
  for (const task of added) names.push((await waitTask(task.id, (t) => t.status === 'completed')).filename);
  if (names.sort().join() !== 'batch-1.mp4,batch-2.bin') throw new Error(`saved ${JSON.stringify(names)}`);
  await q.close();
  return `rules: icon.png shown, photo.jpg ignored; preview "${preview}"; 2 links copied; saved ${names.join(', ')}`;
});

await check('speed limit: all tasks together stay under it, and lifting it speeds up', async () => {
  const LIMIT = 1.5 * 1048576;
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6, speedLimitMB: 1.5 });
  await engine('set-limit', { maxActive: 3, speedLimit: LIMIT });
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await engine('add', { url: `${srv.url}/file.bin?limit=${i}`, maxConnections: 6 })).id);
  const total = async () => (await engine('list')).tasks.filter((t) => ids.includes(t.id)).reduce((s, t) => s + t.downloaded, 0);
  await sleep(3000);
  let b0 = await total();
  let t0 = Date.now();
  await sleep(8000);
  const limited = ((await total()) - b0) / ((Date.now() - t0) / 1000);
  if (limited > LIMIT * 1.15 || limited < LIMIT * 0.75) throw new Error(`limited speed ${mbps(limited, 1000)}`);
  await engine('set-limit', { maxActive: 3, speedLimit: 0 });
  await sleep(4000);
  b0 = await total();
  t0 = Date.now();
  await sleep(4000);
  const free = ((await total()) - b0) / ((Date.now() - t0) / 1000);
  if (free < LIMIT * 2) throw new Error(`after lifting the limit only ${mbps(free, 1000)}`);
  const done = await waitTask(ids[0], (t) => t.status === 'completed');
  await waitTask(ids[1], (t) => t.status === 'completed');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  return `2 tasks limited to 1.5 MB/s: ${mbps(limited, 1000)}; unlimited: ${mbps(free, 1000)}`;
});

await check('popup lists the video, images and playlist a page loaded, and downloads the video', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/media`);
  await sleep(2500);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${srv.url}/media`);
  const badge = await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 560 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html?tab=${tabId}`);
  await pop.waitForSelector('#media-list li');
  const chips = await pop.$$eval('#kinds button', (bs) => bs.map((b) => `${b.dataset.kind}:${b.getAttribute('aria-pressed')}`));
  if (JSON.stringify(chips) !== JSON.stringify(['video:true', 'stream:false', 'image:false'])) throw new Error(`chips ${JSON.stringify(chips)}`);
  const videos = await pop.$$eval('#media-list .name', (els) => els.map((e) => e.textContent));
  if (JSON.stringify(videos) !== '["clip.mp4"]') throw new Error(`videos ${JSON.stringify(videos)}`);
  await pop.click('#kinds button[data-kind="image"]');
  const images = await pop.$$eval('#media-list li.tile img', (els) => els.map((e) => e.alt));
  if (JSON.stringify(images) !== '["photo.jpg"]') throw new Error(`images ${JSON.stringify(images)}`);
  await pop.screenshot({ path: path.join(EXT, 'test', 'popup-screenshot.png') });
  await pop.click('#kinds button[data-kind="video"]');
  const before = (await engine('list')).tasks.map((t) => t.id);
  await pop.click('#media-list li button.act');
  await pop.waitForSelector('#view-tasks:not([hidden]) #task-list li');
  await p.close();
  const task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  if (!task?.url.endsWith('/clip.mp4')) throw new Error(`added ${task?.url}`);
  const done = await waitTask(task.id, (t) => t.status === 'completed');
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.sha256) throw new Error('hash mismatch');
  await pop.close();
  return `badge "${badge}", chips ${chips.join(' ')}, icon and .ts piece hidden, video saved as ${done.filename}`;
});

await check('popup previews: hotlink-protected image full size, audio plays', async () => {
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/media2`);
  await sleep(1500);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${srv.url}/media2`);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 520 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html?tab=${tabId}`);
  await pop.waitForSelector('#kinds button[data-kind="audio"]');
  // Audio: plays in the popup and reports its length.
  await pop.click('#kinds button[data-kind="audio"]');
  await pop.click('#media-list li .info');
  await pop.waitForFunction(() => document.querySelector('#pv-stage audio')?.readyState >= 1, null, { timeout: 10000 });
  const audioInfo = await pop.textContent('#pv-info');
  if (!audioInfo.startsWith('0:01')) throw new Error(`audio info "${audioInfo}"`);
  await pop.click('#pv-close');
  // Image: the thumbnail and the preview load despite hotlink protection.
  await pop.click('#kinds button[data-kind="image"]');
  await pop.waitForFunction(() => document.querySelector('#media-list li.tile img')?.naturalWidth > 0, null, { timeout: 10000 });
  await pop.click('#media-list li.tile');
  await pop.waitForFunction(() => document.querySelector('#pv-stage img')?.naturalWidth === 200, null, { timeout: 10000 });
  await pop.waitForFunction(() => document.querySelector('#pv-info').textContent.includes('200×150'), null, { timeout: 5000 });
  const imageInfo = await pop.textContent('#pv-info');
  await pop.screenshot({ path: path.join(EXT, 'test', 'preview-screenshot.png') });
  // Select from the preview, then the bulk button counts it.
  await pop.click('#pv-select');
  await pop.click('#pv-close');
  const go = await pop.textContent('#media-go');
  if (!go.includes('1')) throw new Error(`bulk button "${go}"`);
  await pop.close();
  await p.close();
  return `audio "${audioInfo}", image "${imageInfo}", selected from preview`;
});

await check('m3u8: pick a quality, encrypted pieces from another host are joined into one file', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 4 });
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/hlspage`);
  await sleep(1500);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${srv.url}/hlspage`);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 520 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html?tab=${tabId}`);
  await pop.waitForSelector('#kinds button[data-kind="stream"][aria-pressed="true"]');
  await pop.click('#media-list li button.act');
  await pop.waitForSelector('.qualities label');
  const qualities = await pop.$$eval('.qualities label', (ls) => ls.map((l) => l.textContent));
  await pop.waitForFunction(() => !document.querySelector('#pv-download').disabled);
  const info = await pop.textContent('#pv-info');
  await pop.screenshot({ path: path.join(EXT, 'test', 'hls-screenshot.png') });
  const before = (await engine('list')).tasks.map((t) => t.id);
  await pop.click('#pv-download');
  await pop.waitForSelector('#view-tasks:not([hidden]) #task-list li');
  const task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  if (!task) throw new Error('nothing added');
  const done = await waitTask(task.id, (t) => t.status === 'completed', 60000);
  const { hash, item } = await savedFileHash(done.downloadId);
  if (hash !== srv.hlsSha256) throw new Error('joined file differs from the original');
  if (item.mime !== 'video/mp2t') throw new Error(`saved as type ${item.mime}`);
  if (done.filename !== 'HLS demo.ts') throw new Error(`saved as ${done.filename}`);
  const pieces = srv.log.filter((l) => /\/hls\/hi\/seg\d+\.ts$/.test(l.path));
  if (pieces.some((l) => !l.referer)) throw new Error('a piece was requested without Referer');
  await pop.close();
  await p.close();
  return `qualities ${JSON.stringify(qualities)}, "${info}", saved ${done.filename} (${done.size} bytes), ${pieces.length} piece requests`;
});

await check('m3u8: pause and resume continues from the pieces already joined', async () => {
  await engine('set-limit', { maxActive: 3, speedLimit: 256 * 1024 });
  const { id } = await engine('add', {
    url: `${srv.url}/hls/master.m3u8`,
    kind: 'hls',
    filename: 'resume test',
    referrer: `${srv.url}/hlspage`,
    maxConnections: 2,
  });
  const mid = await waitTask(id, (t) => t.hls?.done >= 2, 30000);
  await engine('pause', { id });
  const paused = await waitTask(id, (t) => t.status === 'paused');
  const mark = srv.log.length;
  await engine('set-limit', { maxActive: 3, speedLimit: 0 });
  await engine('resume', { id });
  const done = await waitTask(id, (t) => t.status === 'completed', 60000);
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.hlsSha256) throw new Error('joined file differs after resume');
  const again = srv.log.slice(mark).filter((l) => /seg\d+\.ts$/.test(l.path)).length;
  if (again >= 8) throw new Error(`fetched all ${again} pieces again`);
  return `paused at ${paused.hls.done}/8 pieces, ${again} fetched after resume`;
});

async function recordFrom(url, stop) {
  const p = await ctx.newPage();
  await p.goto(url);
  await sleep(1000);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 520 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html?tab=${tabId}`);
  await pop.waitForSelector('#record:not([hidden])');
  const before = (await engine('list')).tasks.map((t) => t.id);
  await pop.click('#rec-go'); // reloads the page with the recorder in place
  await pop.waitForSelector('#record[data-state="on"]');
  if (stop) {
    await pop.waitForFunction(() => /\d/.test(document.querySelector('#rec-sub').textContent) && !/ 0 B/.test(document.querySelector('#rec-sub').textContent));
    await sleep(2500); // the page appends half the video, then stalls
    await pop.screenshot({ path: path.join(EXT, 'test', 'record-screenshot.png') });
    await pop.click('#rec-go');
  }
  const t0 = Date.now();
  let task;
  while (!(task = (await engine('list')).tasks.find((t) => !before.includes(t.id) && t.kind === 'record'))) {
    if (Date.now() - t0 > 30000) throw new Error('no recording was saved');
    await sleep(250);
  }
  const done = await waitTask(task.id, (t) => t.status === 'completed', 30000);
  const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  if (scripts.length) throw new Error('recorder still registered after the recording');
  await pop.close();
  await p.close();
  return done;
}

await check('recording a blob: video joins the player’s separate video and audio into one mp4', async () => {
  const done = await recordFrom(`${srv.url}/msepage`, false);
  const { hash, item } = await savedFileHash(done.downloadId);
  if (hash !== srv.mseSha256) throw new Error('recorded file differs from the joined original');
  // Without a type Chrome calls it text/plain and Windows renames it .txt.
  if (item.mime !== 'video/mp4') throw new Error(`saved as type ${item.mime}`);
  if (done.filename !== 'MSE demo.mp4') throw new Error(`saved as ${done.filename}`);
  return `finished on its own when the player ended the stream, saved ${done.filename} (${done.size} bytes), identical to the expected join`;
});

await check('recording: stopping by hand saves what was loaded so far', async () => {
  const done = await recordFrom(`${srv.url}/msepage?end=0`, true);
  const { item } = await savedFileHash(done.downloadId);
  const { children, parseMoov } = await import(path.join(EXT, 'src', 'fmp4.js'));
  const b = new Uint8Array(fs.readFileSync(item.filename));
  const top = children(b);
  const moov = top.find((x) => x.type === 'moov');
  const tracks = parseMoov(b.slice(moov.start, moov.end)).tracks.map((x) => x.handler);
  const frags = top.filter((x) => x.type === 'moof').length;
  if (tracks.join() !== 'vide,soun' || frags < 2) throw new Error(`tracks ${tracks}, ${frags} fragments`);
  return `saved ${done.size} bytes: tracks ${tracks.join('+')}, ${frags} fragments`;
});

await check('m3u8 with separate audio (CMAF): video and audio are joined into one mp4', async () => {
  await engine('set-limit', { maxActive: 3, speedLimit: 0 });
  const { id } = await engine('add', { url: `${srv.url}/hlsav/master.m3u8`, kind: 'hls', filename: 'AV test', maxConnections: 4 });
  const done = await waitTask(id, (t) => t.status === 'completed', 60000);
  const { hash, item } = await savedFileHash(done.downloadId);
  if (hash !== srv.mseSha256) throw new Error('joined file differs from the expected join');
  if (done.filename !== 'AV test.mp4' || item.mime !== 'video/mp4') throw new Error(`saved as ${done.filename} (${item.mime})`);
  if (srv.log.some((l) => l.path.endsWith('other.m3u8'))) throw new Error('fetched the non-default audio');
  return `saved ${done.filename} (${done.size} bytes), ${done.hls.total} pieces, identical to the expected join`;
});

await check('m3u8 with separate audio: pausing during the audio resumes without refetching the video', async () => {
  await engine('set-limit', { maxActive: 3, speedLimit: 6 * 1024 });
  const mark = srv.log.length;
  const { id } = await engine('add', { url: `${srv.url}/hlsav/master.m3u8`, kind: 'hls', filename: 'AV resume', maxConnections: 1 });
  const video = (await waitTask(id, (t) => t.hls?.total > 0)).hls.total;
  // The video track has 4 pieces: wait until the audio has started.
  await waitTask(id, (t) => t.hls?.done >= 5, 60000);
  await engine('pause', { id });
  await waitTask(id, (t) => t.status === 'paused');
  const before = srv.log.slice(mark).filter((l) => l.path === '/mse/video.mp4').length;
  await engine('set-limit', { maxActive: 3, speedLimit: 0 });
  await engine('resume', { id });
  const done = await waitTask(id, (t) => t.status === 'completed', 60000);
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.mseSha256) throw new Error('joined file differs after resume');
  const after = srv.log.slice(mark).filter((l) => l.path === '/mse/video.mp4').length;
  if (after !== before) throw new Error(`video fetched again after resume (${before} -> ${after})`);
  return `${video} pieces in all, paused in the audio track, video not fetched again`;
});

await check('m3u8 with separate audio (MPEG-TS): the audio is saved next to the video', async () => {
  const before = (await engine('list')).tasks.map((t) => t.id);
  const { id } = await engine('add', { url: `${srv.url}/hlsts/master.m3u8`, kind: 'hls', filename: 'TS test', maxConnections: 4 });
  const done = await waitTask(id, (t) => t.status === 'completed', 60000);
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.hlsSha256 || done.filename !== 'TS test.ts') throw new Error(`video ${done.filename} differs`);
  let extra;
  for (let i = 0; i < 40 && !extra; i++) {
    extra = (await engine('list')).tasks.find((t) => !before.includes(t.id) && t.id !== id && t.status === 'completed');
    if (!extra) await sleep(250);
  }
  if (!extra || extra.filename !== 'TS test-audio.aac') throw new Error(`audio ${JSON.stringify(extra && extra.filename)}`);
  const audio = await savedFileHash(extra.downloadId);
  if (audio.hash !== srv.hlsAudioSha256) throw new Error('audio file differs');
  return `saved ${done.filename} and ${extra.filename}`;
});

await check('DASH: the popup lists the qualities of a page’s .mpd and joins video and audio into one mp4', async () => {
  await engine('set-limit', { maxActive: 3, speedLimit: 0 });
  const p = await ctx.newPage();
  await p.goto(`${srv.url}/dashpage`);
  await sleep(1500);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${srv.url}/dashpage`);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 400, height: 520 });
  await pop.goto(`chrome-extension://${extId}/src/popup.html?tab=${tabId}`);
  await pop.waitForSelector('#kinds button[data-kind="stream"][aria-pressed="true"]');
  await pop.click('#media-list li button.act');
  await pop.waitForSelector('.qualities label');
  const qualities = await pop.$$eval('.qualities label', (ls) => ls.map((l) => l.textContent));
  await pop.waitForFunction(() => !document.querySelector('#pv-download').disabled);
  const info = await pop.textContent('#pv-info');
  await pop.screenshot({ path: path.join(EXT, 'test', 'dash-screenshot.png') });
  if (!/^90p/.test(qualities[0]) || qualities.length !== 2) throw new Error(`qualities ${JSON.stringify(qualities)}`);
  const before = (await engine('list')).tasks.map((t) => t.id);
  await pop.click('#pv-download');
  await pop.waitForSelector('#view-tasks:not([hidden]) #task-list li');
  const task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  if (!task) throw new Error('nothing added');
  const done = await waitTask(task.id, (t) => t.status === 'completed', 60000);
  const { hash, item } = await savedFileHash(done.downloadId);
  if (hash !== srv.mseSha256) throw new Error('joined file differs from the expected join');
  if (done.filename !== 'DASH demo.mp4' || item.mime !== 'video/mp4') throw new Error(`saved as ${done.filename} (${item.mime})`);
  if (srv.log.some((l) => l.path.startsWith('/dash/never/'))) throw new Error('fetched another quality or language');
  await pop.close();
  await p.close();
  return `qualities ${JSON.stringify(qualities)}, "${info}", saved ${done.filename} (${done.size} bytes), ${done.hls.total} pieces`;
});

await check('DASH with a segment list (byte ranges) and a second language', async () => {
  const { id } = await engine('add', { url: `${srv.url}/dash/list.mpd`, kind: 'hls', filename: 'DASH list', maxConnections: 4 });
  const done = await waitTask(id, (t) => t.status === 'completed', 60000);
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.mseSha256) throw new Error('joined file differs from the expected join');
  if (srv.log.some((l) => l.path.startsWith('/dash/never/'))) throw new Error('fetched another quality or language');
  return `saved ${done.filename}, ${done.hls.total} pieces, identical to the expected join`;
});

await check('DASH with one file per track: pieces read from its sidx index', async () => {
  const mark = srv.log.length;
  const { id } = await engine('add', { url: `${srv.url}/dash/base.mpd`, kind: 'hls', filename: 'DASH base', maxConnections: 4 });
  const done = await waitTask(id, (t) => t.status === 'completed', 60000);
  const { hash } = await savedFileHash(done.downloadId);
  if (hash !== srv.mseSha256) throw new Error('joined file differs from the expected join');
  const ranged = srv.log.slice(mark).filter((l) => /sidx\.mp4$/.test(l.path)).length;
  if (done.hls.total < 4) throw new Error(`only ${done.hls.total} pieces`);
  return `saved ${done.filename}, ${done.hls.total} pieces from the index, ${ranged} range requests`;
});

await check('small files are left to the browser', async () => {
  await setSettings({ autoTakeover: true, minSizeMB: SIZE_MB + 1, maxConnections: 6 });
  const before = (await engine('list')).tasks.map((t) => t.id);
  const p = await ctx.newPage();
  await p.setContent(`<a id="a" href="${srv.url}/file.bin?small">get</a>`);
  await p.click('#a').catch(() => {});
  await sleep(3000);
  const added = (await engine('list')).tasks.filter((t) => !before.includes(t.id));
  if (added.length) throw new Error('took over a file below the threshold');
  const natives = await page.evaluate(() => chrome.downloads.search({}));
  const n = natives.find((d) => d.url.includes('?small'));
  if (!n || (n.state !== 'in_progress' && n.state !== 'complete')) throw new Error(`native download state: ${n?.state} ${n?.error}`);
  if (n.paused) throw new Error('native download left paused');
  await page.evaluate((id) => chrome.downloads.cancel(id), n.id);
  await p.close();
  return `native download ${n.state}`;
});

await page.screenshot({ path: path.join(EXT, 'test', 'manager-screenshot.png'), fullPage: true });
await ctx.close();
srv.server.close();
h2.server.close();
fs.writeFileSync(path.join(EXT, 'test', 'last-e2e.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
