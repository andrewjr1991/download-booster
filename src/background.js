import { collectLinks, prepareLinks, mergeMedia } from './sniff.js';
import { addMedia, sizeFrom, header, compileRules } from './media.js';
import { sanitizeFilename } from './http.js';
import { statusText } from './client.js';

// MV3 service worker: only a dispatcher. It can be killed after 30 s idle, so
// all download work lives in the offscreen document (offscreen.js).

const MB = 1024 * 1024;
const DEFAULT_SETTINGS = { autoTakeover: true, minSizeMB: 20, maxConnections: 6, maxActive: 3, speedLimitMB: 0, notify: false };
const MANAGER_URL = chrome.runtime.getURL('src/manager.html');

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

// ---- offscreen engine ------------------------------------------------------

let creating = null;
async function ensureEngine() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Runs multi-connection downloads in workers and writes them to OPFS.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function engine(cmd, args = {}) {
  await ensureEngine();
  // The engine's listener may not be attached the instant the document opens.
  for (let i = 0; i < 20; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'engine', cmd, ...args });
      if (res !== undefined) return res;
    } catch (err) {
      if (!/Receiving end does not exist|message port closed/.test(String(err))) throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Download engine did not respond');
}

async function addDownload({ url, filename, takeover, source, referrer }) {
  const s = await getSettings();
  return engine('add', {
    url,
    filename,
    takeover,
    source,
    referrer,
    maxConnections: s.maxConnections,
    maxActive: s.maxActive,
    speedLimit: s.speedLimitMB * MB,
  });
}

// ---- entry points ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'accelerate-link',
    title: chrome.i18n.getMessage('menuDownloadLink'),
    contexts: ['link', 'video', 'audio', 'image'],
  });
  chrome.contextMenus.create({
    id: 'sniff-page',
    title: chrome.i18n.getMessage('menuSniffPage'),
    contexts: ['page'],
  });
  ensureEngine();
});

chrome.runtime.onStartup.addListener(() => {
  ensureEngine(); // resumes tasks interrupted by the last browser exit
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'sniff-page') return sniffPage(tab);
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  await addDownload({ url, source: 'menu', referrer: info.frameUrl || info.pageUrl });
  openManager();
});


// Collect every link and media source on the page (all frames) and hand
// the list to the manager page for picking.
async function sniffPage(tab) {
  if (!tab?.id) return;
  let raw = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: collectLinks,
    });
    raw = results.flatMap((r) => r.result || []);
  } catch (err) {
    console.warn('sniff failed', err); // e.g. chrome:// pages
  }
  const links = mergeMedia(prepareLinks(raw, await sniffRules()), await mediaList(tab.id));
  await chrome.storage.session.set({
    sniff: { pageUrl: tab.url, title: tab.title, links, at: Date.now() },
  });
  await openManager('?sniff=1');
}

// Context menus can't be clicked in a headless browser; the e2e test calls this.
globalThis.sniffPage = sniffPage;

// Focus the open manager tab (navigating it to `query` if given), or open one.
// Without the "tabs" permission chrome.tabs.query can't match our own page by
// URL, so look it up among the extension's contexts.
async function openManager(query = '') {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const open = contexts.find((c) => c.documentUrl?.startsWith(MANAGER_URL) && c.tabId >= 0);
  if (!open) return chrome.tabs.create({ url: MANAGER_URL + query });
  await chrome.tabs.update(open.tabId, query ? { url: MANAGER_URL + query, active: true } : { active: true });
  await chrome.windows.update(open.windowId, { focused: true });
}

// ---- notifications ----------------------------------------------------------
// "notifications" is an optional permission: chrome.notifications exists only
// once the user has turned notifications on in the settings.

async function notifyFinished(task) {
  if (!chrome.notifications || !(await getSettings()).notify) return;
  const ok = task.status === 'completed';
  let name = task.filename;
  if (!name) {
    try {
      name = decodeURIComponent(new URL(task.url).pathname.split('/').pop()) || task.url;
    } catch {
      name = task.url || '';
    }
  }
  const canOpen = ok && task.downloadId != null;
  // The id carries what a click needs: the SW may have restarted since.
  chrome.notifications.create(`task:${canOpen ? task.downloadId : ''}:${task.id}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: chrome.i18n.getMessage(ok ? 'notifyDone' : 'notifyFailed'),
    message: name,
    // The title already says it failed: just the reason.
    contextMessage: ok ? chrome.i18n.getMessage(canOpen ? 'notifyClickOpen' : 'notifyClickManager') : statusText(task).replace(`${chrome.i18n.getMessage('statusError')}: `, ''),
  });
}

async function onNotificationClicked(notificationId) {
  const [, dl] = notificationId.split(':');
  chrome.notifications.clear(notificationId);
  if (!dl) return openManager();
  const downloadId = Number(dl);
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item?.exists) return openManager();
  // Opening needs its own optional permission; without it, show the file.
  if (await chrome.permissions.contains({ permissions: ['downloads.open'] })) {
    try {
      return await chrome.downloads.open(downloadId);
    } catch {}
  }
  chrome.downloads.show(downloadId);
}

let notificationsHooked = false;
function hookNotifications() {
  if (notificationsHooked || !chrome.notifications) return;
  notificationsHooked = true;
  chrome.notifications.onClicked.addListener(onNotificationClicked);
}
hookNotifications();
chrome.permissions.onAdded.addListener(hookNotifications);

// Automatic takeover of browser downloads. The native download is paused
// while the engine probes the URL; if the server supports ranges and the file
// is big enough we cancel the native one, otherwise it resumes untouched.
chrome.downloads.onCreated.addListener(async (item) => {
  const s = await getSettings();
  if (!s.autoTakeover) return;
  if (item.byExtensionId === chrome.runtime.id) return;
  if (item.incognito || item.state !== 'in_progress') return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return;
  const minSize = s.minSizeMB * MB;
  if (item.totalBytes > 0 && item.totalBytes < minSize) return;
  if (item.fileSize > 0 && item.fileSize < minSize) return;

  await chrome.downloads.pause(item.id).catch(() => {});
  let res;
  try {
    res = await addDownload({
      url,
      filename: item.filename ? item.filename.split(/[\\/]/).pop() : null,
      takeover: { minSize },
      source: 'takeover',
      referrer: item.referrer,
    });
  } catch (err) {
    res = { accepted: false, reason: String(err) };
  }
  if (res?.accepted) {
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    openManager();
  } else {
    await chrome.downloads.resume(item.id).catch(() => {});
  }
});

// ---- media the page loaded ------------------------------------------------
// Every video, audio file, image and stream playlist a tab receives is noted
// here, so the popup can offer them even when the page has no link to them
// (players fetch their video in the background). Kept in storage.session
// because this service worker can be stopped at any time.

const mediaByTab = new Map(); // tabId -> Promise<list>
const saveTimers = new Map();

function mediaList(tabId) {
  if (!mediaByTab.has(tabId)) {
    mediaByTab.set(
      tabId,
      chrome.storage.session.get(`media:${tabId}`).then((r) => r[`media:${tabId}`] || []),
    );
  }
  return mediaByTab.get(tabId);
}

function storeMedia(tabId, list) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(
    tabId,
    setTimeout(() => {
      saveTimers.delete(tabId);
      chrome.storage.session.set({ [`media:${tabId}`]: list }).catch(() => {});
      mediaBadge(tabId, list);
    }, 300),
  );
}

function clearMedia(tabId) {
  clearTimeout(saveTimers.get(tabId));
  mediaByTab.set(tabId, Promise.resolve([]));
  chrome.storage.session.remove(`media:${tabId}`).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

// The tab's own badge shows how much media it has; it overrides the global
// badge (running downloads) on that tab only.
function mediaBadge(tabId, list) {
  const n = list.filter((m) => m.kind !== 'image').length || list.length;
  chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' }).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0 && d.frameId === 0) clearMedia(d.tabId); // a new page in this tab
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

// The user's sniffing rules (manager settings), compiled once per change.
let rulesCache = null;
function sniffRules() {
  rulesCache ??= getSettings().then((s) => compileRules(s.sniffRules));
  return rulesCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) rulesCache = null;
});

chrome.webRequest.onResponseStarted.addListener(
  async (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const [list, rules] = await Promise.all([mediaList(d.tabId), sniffRules()]);
    const changed = addMedia(
      list,
      {
        url: d.url,
        type: d.type,
        mime: header(d.responseHeaders, 'content-type'),
        size: sizeFrom(d.responseHeaders),
      },
      rules,
    );
    if (changed) storeMedia(d.tabId, list);
  },
  { urls: ['<all_urls>'], types: ['media', 'image', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  chrome.storage.session.remove(`media:${tabId}`).catch(() => {});
  endRecording(tabId);
});

// ---- recording blob: videos ---------------------------------------------------
// While a tab is being recorded, record-hook.js and record-bridge.js run in
// every page (they stay idle in other tabs); they are unregistered as soon as
// no tab is being recorded.

const RECORD_SCRIPTS = [
  { id: 'rec-hook', js: ['src/record-hook.js'], world: 'MAIN' },
  { id: 'rec-bridge', js: ['src/record-bridge.js'], world: 'ISOLATED' },
];

async function recording(tabId) {
  const key = `rec:${tabId}`;
  return tabId == null ? null : (await chrome.storage.session.get(key))[key] || null;
}

async function startRecording(tabId, fast) {
  const tab = await chrome.tabs.get(tabId);
  if (/^https?:\/\/([^/]*\.)?(youtube\.com|youtube-nocookie\.com)(:|\/|$)/i.test(tab.url || '')) throw new Error('Not supported on this site');
  await chrome.storage.session.set({ [`rec:${tabId}`]: { token: crypto.randomUUID(), fast: !!fast, startedAt: Date.now() } });
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: RECORD_SCRIPTS.map((x) => x.id) });
  const missing = RECORD_SCRIPTS.filter((x) => !have.some((h) => h.id === x.id));
  if (missing.length) {
    await chrome.scripting.registerContentScripts(
      missing.map((x) => ({
        ...x,
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: false,
      })),
    );
  }
  // Reload so the player starts over with the hook in place.
  await chrome.tabs.reload(tabId);
}

async function endRecording(tabId) {
  await chrome.storage.session.remove(`rec:${tabId}`);
  const all = await chrome.storage.session.get(null);
  if (!Object.keys(all).some((k) => k.startsWith('rec:'))) {
    await chrome.scripting.unregisterContentScripts({ ids: RECORD_SCRIPTS.map((x) => x.id) }).catch(() => {});
  }
}

async function saveRecording(msg, tab) {
  const rec = await recording(tab?.id);
  if (!rec || msg.token !== rec.token || !/^[\w-]+\.part$/.test(msg.opfsName)) throw new Error('Not recording');
  const title = (tab.title || '').trim() || 'video';
  return engine('import', {
    opfsName: msg.opfsName,
    size: msg.size,
    filename: sanitizeFilename(`${title}.${msg.ext}`),
    referrer: tab.url,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => {
    p.then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  };
  if (msg?.type === 'record-start') return reply(startRecording(msg.tabId, msg.fast).then(() => ({ ok: true })));
  if (msg?.type === 'record-end') return reply(endRecording(msg.tabId).then(() => ({ ok: true })));
  if (msg?.type === 'record-state') return reply(recording(msg.tabId).then((rec) => ({ active: !!rec, fast: rec?.fast })));
  // From the bridge and the sink inside the recorded tab.
  if (msg?.type === 'record-active') {
    return reply(recording(sender.tab?.id).then((rec) => (rec ? { active: true, fast: rec.fast, token: rec.token } : { active: false })));
  }
  if (msg?.type === 'record-done') return reply(endRecording(sender.tab?.id).then(() => ({ ok: true })));
  if (msg?.type === 'record-token') return reply(recording(sender.tab?.id).then((rec) => rec?.token || null));
  if (msg?.type === 'record-save') return reply(saveRecording(msg, sender.tab));
  return false;
});

// ---- saving finished files ---------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save-file') {
    saveFile(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'engine') {
    // Manager page -> engine, routed here so the offscreen document exists.
    const { type, cmd, ...args } = msg;
    engine(cmd, args).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'request-headers') {
    setRequestHeaders(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'clear-request-headers') {
    clearRequestHeaders(msg.id).then(sendResponse, () => sendResponse({}));
    return true;
  }
  if (msg?.type === 'media-list') {
    mediaList(msg.tabId).then((list) => sendResponse({ media: list }));
    return true;
  }
  if (msg?.type === 'sniff-tab') {
    chrome.tabs.get(msg.tabId).then(sniffPage).then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  if (msg?.type === 'open-manager') {
    openManager().then(() => sendResponse({}));
    return true;
  }
  if (msg?.type === 'engine-state') updateBadge(msg.tasks);
  if (msg?.type === 'task-finished') notifyFinished(msg.task);
  return false;
});

const SAVE_RESUMES = 3; // times one save is continued after Chrome interrupts it

async function saveFile({ id, url, filename }) {
  const download = (name) => chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify', saveAs: false });
  let downloadId;
  try {
    downloadId = await download(filename);
  } catch (err) {
    // Chrome on Linux without a UTF-8 locale refuses non-ASCII names.
    const ascii = String(filename || '').replace(/[^\x20-\x7e]+/g, '_');
    if (!/invalid filename/i.test(String(err?.message)) || ascii === filename) throw err;
    downloadId = await download(ascii);
  }
  await chrome.storage.session.set({ [`save:${downloadId}`]: id });
  return { downloadId };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const key = `save:${delta.id}`;
  const triesKey = `saveTries:${delta.id}`;
  const { [key]: taskId, [triesKey]: tries = 0 } = await chrome.storage.session.get([key, triesKey]);
  if (!taskId) return;
  if (state === 'interrupted') {
    // Writing to disk failed part-way (on Windows often an antivirus or a
    // sync tool holding the file: FILE_TRANSIENT_ERROR). Continue the same
    // download where it stopped, a few times, before giving up on it.
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (item?.canResume && item.error !== 'USER_CANCELED' && tries < SAVE_RESUMES) {
      await chrome.storage.session.set({ [triesKey]: tries + 1 });
      await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
      try {
        await chrome.downloads.resume(delta.id);
        return;
      } catch (err) {
        console.warn('could not resume saving', err);
      }
    }
    await chrome.storage.session.remove([key, triesKey]);
    // The engine starts a fresh copy or reports the error; this entry would
    // only add a "failed" line to Chrome's download list.
    if (item?.error !== 'USER_CANCELED') chrome.downloads.erase({ id: delta.id }).catch(() => {});
    await engine('save-failed', { id: taskId, error: item?.error || 'interrupted' });
    return;
  }
  await chrome.storage.session.remove([key, triesKey]);
  await engine('saved', { id: taskId, downloadId: delta.id });
});

// ---- Referer for anti-hotlinking -------------------------------------------------
// fetch() cannot set Referer, so each task gets session rules that add the
// page's address to this extension's own requests for the task's URLs.

const RULE_IDS_KEY = 'refererRuleIds'; // task id -> [rule ids]

function urlFilterFor(url) {
  // urlFilter treats * ^ | as wildcards/anchors; skip URLs that contain them.
  const clean = url.split('#')[0];
  return /[*^|]/.test(clean) ? null : `|${clean}|`;
}

// Rule changes read and rewrite one shared id map: run them one at a time, or
// two at once (a panel closing while a download starts) lose each other's rules.
let rulesQueue = Promise.resolve();
function serially(fn) {
  return (...args) => {
    const run = rulesQueue.then(() => fn(...args));
    rulesQueue = run.catch(() => {});
    return run;
  };
}
const setRequestHeaders = serially(setRequestHeadersNow);
const clearRequestHeaders = serially(clearRequestHeadersNow);

async function setRequestHeadersNow({ id, urls, domains = [], referrer, pages = false }) {
  if (!referrer || !/^https?:/i.test(referrer)) return { ok: true };
  const { [RULE_IDS_KEY]: map = {} } = await chrome.storage.session.get(RULE_IDS_KEY);
  const used = new Set(Object.values(map).flat());
  const old = map[id] || [];
  const addRules = [];
  let next = 1;
  // One rule per URL, plus one for whole hosts (an HLS stream's pieces).
  const filters = [...new Set(urls.filter(Boolean))].map((url) => ({ urlFilter: urlFilterFor(url) })).filter((f) => f.urlFilter);
  const hosts = [...new Set(domains.filter(Boolean))];
  if (hosts.length) filters.push({ requestDomains: hosts });
  for (const filter of filters) {
    while (used.has(next)) next++;
    used.add(next);
    addRules.push({
      id: next,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }],
      },
      condition: {
        ...filter,
        initiatorDomains: [chrome.runtime.id],
        // Engine requests come from no tab; previews come from our own
        // pages, which can be in a tab (the manager) or not (the popup).
        ...(pages ? {} : { tabIds: [chrome.tabs.TAB_ID_NONE] }),
        // media/image: previews in the popup are played by the extension too.
        resourceTypes: ['xmlhttprequest', 'other', 'media', 'image'],
      },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old, addRules });
  map[id] = addRules.map((r) => r.id);
  await chrome.storage.session.set({ [RULE_IDS_KEY]: map });
  return { ok: true };
}

async function clearRequestHeadersNow(id) {
  const { [RULE_IDS_KEY]: map = {} } = await chrome.storage.session.get(RULE_IDS_KEY);
  if (!map[id]) return {};
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: map[id] });
  delete map[id];
  await chrome.storage.session.set({ [RULE_IDS_KEY]: map });
  return {};
}

function updateBadge(tasks) {
  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'saving').length;
  chrome.action.setBadgeText({ text: active ? String(active) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}
