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

await check('scheduled download waits for its time; "start now" skips the wait', async () => {
  await setSettings({ autoTakeover: false, minSizeMB: 20, maxConnections: 6 });
  const mark = srv.log.length;
  const at = Date.now() + 5000;
  const { id } = await engine('add', { url: `${srv.url}/file.bin?at=1`, maxConnections: 6, startAt: at });
  await sleep(2000);
  const early = (await engine('list')).tasks.find((t) => t.id === id);
  if (early.status !== 'scheduled') throw new Error(`status ${early.status} before its time`);
  if (srv.log.slice(mark).some((l) => l.path === '/file.bin')) throw new Error('requested before its time');
  await waitTask(id, (t) => t.status === 'downloading' || t.status === 'completed', 15000);
  const lateBy = Date.now() - at;
  await waitTask(id, (t) => t.status === 'completed');

  // Through the page: tick "start later", add, then press "start now".
  await page.check('#later');
  const value = await page.inputValue('#startAt');
  if (!/T02:00$/.test(value)) throw new Error(`default time ${value}`);
  const before = (await engine('list')).tasks.map((t) => t.id);
  await page.fill('#url', `${srv.url}/file.bin?at=2`);
  await page.press('#url', 'Enter');
  let task;
  for (let i = 0; i < 20 && !task; i++) {
    await sleep(250);
    task = (await engine('list')).tasks.find((t) => !before.includes(t.id));
  }
  if (task?.status !== 'scheduled') throw new Error(`added as ${task?.status}`);
  const label = await page.locator('.task .status[data-s="scheduled"]').first().textContent();
  await page.locator('.task .actions button').first().click(); // start now
  await waitTask(task.id, (t) => t.status === 'completed');
  if (await page.isChecked('#later')) throw new Error('"start later" stayed on');
  return `started ${lateBy} ms after its time; page showed "${label}", start now worked`;
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
