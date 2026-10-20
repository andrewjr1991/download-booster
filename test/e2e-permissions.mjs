// The features behind optional permissions (notifications, opening files).
// Automation can't answer Chrome's permission prompt, so this loads a copy of
// the extension with those permissions already granted.
//   node test/e2e-permissions.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ext-'));
for (const d of ['manifest.json', '_locales', 'icons', 'src']) fs.cpSync(path.join(SRC, d), path.join(EXT, d), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.permissions.push(...manifest.optional_permissions);
delete manifest.optional_permissions;
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest));

const srv = await startServer({ port: 8788, sizeMB: 4, rateKBps: 4096 });
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-e2e-'));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-profile-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium',
  executablePath: process.env.CHROMIUM || undefined,
  acceptDownloads: true,
  downloadsPath: downloadDir,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/src/manager.html`);
await page.waitForSelector('body[data-synced]');
const engine = (cmd, args = {}) => page.evaluate(([cmd, args]) => chrome.runtime.sendMessage({ type: 'engine', cmd, ...args }), [cmd, args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Record what the service worker shows and opens.
await sw.evaluate(() => {
  self.shown = [];
  const create = chrome.notifications.create.bind(chrome.notifications);
  chrome.notifications.create = (id, opts) => (self.shown.push({ id, ...opts }), create(id, opts));
});

let failed = 0;
async function check(name, fn) {
  try {
    console.log(`PASS ${name} ${(await fn()) || ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.stack || err}`);
  }
}
async function waitFor(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(250);
  }
}

await check('notifications: off by default, shown once turned on', async () => {
  const { id } = await engine('add', { url: `${srv.url}/file.bin?quiet`, maxConnections: 6 });
  await waitFor(async () => (await engine('list')).tasks.find((t) => t.id === id && t.status === 'completed'));
  await sleep(500);
  if ((await sw.evaluate(() => self.shown.length)) !== 0) throw new Error('notified while turned off');
  await page.click('#nav-settings');
  await page.check('#notify');
  await waitFor(() => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.notify));
  await page.click('#task-groups button[data-value="all"]');
  const { id: id2 } = await engine('add', { url: `${srv.url}/file.bin?loud`, maxConnections: 6 });
  const shown = await waitFor(() => sw.evaluate(() => self.shown[0]));
  const task = (await engine('list')).tasks.find((t) => t.id === id2);
  if (!shown.id.startsWith(`task:${task.downloadId}:`)) throw new Error(`id ${shown.id}`);
  const { id: id3 } = await engine('add', { url: `${srv.url}/missing.bin`, maxConnections: 6 });
  const failedNote = await waitFor(() => sw.evaluate(() => self.shown[1]));
  await engine('remove', { id: id3 });
  return `"${shown.title}: ${shown.message} (${shown.contextMessage})", "${failedNote.title}: ${failedNote.contextMessage}"`;
});

await check('Open button opens the saved file', async () => {
  const [task] = (await engine('list')).tasks.filter((t) => t.status === 'completed');
  await page.evaluate(() => {
    window.openedId = null;
    chrome.downloads.open = async (id) => void (window.openedId = id);
  });
  const card = page.locator('#tasks .task', { has: page.locator(`.name[title="${task.url}"]`) });
  await card.locator('button[data-action="open"]').click();
  const id = await waitFor(() => page.evaluate(() => window.openedId), 5000);
  if (id !== task.downloadId) throw new Error(`opened ${id}`);
  // Deleted from disk: Chrome refuses to open it, and its folder is shown.
  const [item] = await page.evaluate((id) => chrome.downloads.search({ id }), task.downloadId);
  fs.rmSync(item.filename);
  await page.evaluate(() => {
    chrome.downloads.open = async () => {
      throw new Error('Download file does not exist');
    };
    chrome.downloads.show = (id) => void (window.shownId = id);
  });
  await card.locator('button[data-action="open"]').click();
  const shownId = await waitFor(() => page.evaluate(() => window.shownId), 5000);
  const msg = await page.textContent('#add-msg');
  return `opened download ${id}; after deleting it showed ${shownId}: "${msg}"`;
});

await ctx.close();
for (const d of [EXT, downloadDir, userDir]) fs.rmSync(d, { recursive: true, force: true });
srv.server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
