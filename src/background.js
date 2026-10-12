// MV3 service worker: only a dispatcher. It can be killed after 30 s idle, so
// all download work lives in the offscreen document (offscreen.js).

const MB = 1024 * 1024;
const DEFAULT_SETTINGS = { autoTakeover: true, minSizeMB: 20, maxConnections: 6 };
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

async function addDownload({ url, filename, takeover, source }) {
  const s = await getSettings();
  return engine('add', { url, filename, takeover, source, maxConnections: s.maxConnections });
}

// ---- entry points ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'accelerate-link',
    title: chrome.i18n.getMessage('menuDownloadLink'),
    contexts: ['link', 'video', 'audio', 'image'],
  });
  ensureEngine();
});

chrome.runtime.onStartup.addListener(() => {
  ensureEngine(); // resumes tasks interrupted by the last browser exit
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  await addDownload({ url, source: 'menu' });
  openManager();
});

chrome.action.onClicked.addListener(() => openManager());

async function openManager() {
  const [tab] = await chrome.tabs.query({ url: MANAGER_URL });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
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

function updateBadge(tasks) {
  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'saving').length;
  chrome.action.setBadgeText({ text: active ? String(active) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}
