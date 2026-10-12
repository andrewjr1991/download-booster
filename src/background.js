import { collectLinks, prepareLinks } from './sniff.js';
import { addMedia, sizeFrom, header } from './media.js';

// MV3 service worker: only a dispatcher. It can be killed after 30 s idle, so
// all download work lives in the offscreen document (offscreen.js).

const MB = 1024 * 1024;
const DEFAULT_SETTINGS = { autoTakeover: true, minSizeMB: 20, maxConnections: 6, maxActive: 3, speedLimitMB: 0 };
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
  await chrome.storage.session.set({
    sniff: { pageUrl: tab.url, title: tab.title, links: prepareLinks(raw), at: Date.now() },
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

chrome.webRequest.onResponseStarted.addListener(
  async (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const list = await mediaList(d.tabId);
    const changed = addMedia(list, {
      url: d.url,
      type: d.type,
      mime: header(d.responseHeaders, 'content-type'),
      size: sizeFrom(d.responseHeaders),
    });
    if (changed) storeMedia(d.tabId, list);
  },
  { urls: ['<all_urls>'], types: ['media', 'image', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  chrome.storage.session.remove(`media:${tabId}`).catch(() => {});
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
  return false;
});

async function saveFile({ id, url, filename }) {
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  await chrome.storage.session.set({ [`save:${downloadId}`]: id });
  return { downloadId };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const key = `save:${delta.id}`;
  const { [key]: taskId } = await chrome.storage.session.get(key);
  if (!taskId) return;
  await chrome.storage.session.remove(key);
  if (state === 'complete') {
    await engine('saved', { id: taskId, downloadId: delta.id });
  } else {
    const [item] = await chrome.downloads.search({ id: delta.id });
    await engine('save-failed', { id: taskId, error: item?.error || 'interrupted' });
  }
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

async function setRequestHeaders({ id, urls, referrer }) {
  if (!referrer || !/^https?:/i.test(referrer)) return { ok: true };
  const { [RULE_IDS_KEY]: map = {} } = await chrome.storage.session.get(RULE_IDS_KEY);
  const used = new Set(Object.values(map).flat());
  const old = map[id] || [];
  const addRules = [];
  let next = 1;
  for (const url of [...new Set(urls.filter(Boolean))]) {
    const urlFilter = urlFilterFor(url);
    if (!urlFilter) continue;
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
        urlFilter,
        initiatorDomains: [chrome.runtime.id],
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old, addRules });
  map[id] = addRules.map((r) => r.id);
  await chrome.storage.session.set({ [RULE_IDS_KEY]: map });
  return { ok: true };
}

async function clearRequestHeaders(id) {
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
