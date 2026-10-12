// Shared by the manager page and the toolbar popup: i18n, formatting and
// talking to the download engine.

export const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
export const DEFAULT_SETTINGS = { autoTakeover: true, minSizeMB: 20, maxConnections: 6, maxActive: 3, speedLimitMB: 0 };
export const MB = 1024 * 1024;

export function localize(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  document.documentElement.lang = chrome.i18n.getUILanguage();
}

export function engine(cmd, args = {}) {
  return chrome.runtime.sendMessage({ type: 'engine', cmd, ...args });
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

// Add each URL as a task with the user's settings.
export async function addUrls(urls, extra = {}) {
  const s = await getSettings();
  for (const url of urls) {
    await engine('add', {
      url,
      source: 'manual',
      maxConnections: s.maxConnections,
      maxActive: s.maxActive,
      speedLimit: s.speedLimitMB * MB,
      ...extra,
    });
  }
}

export function bytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${units[i]}`;
}
export const speed = (n) => `${bytes(n || 0)}/s`;

export function duration(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export const STATUS = {
  queued: 'statusQueued',
  downloading: 'statusDownloading',
  paused: 'statusPaused',
  saving: 'statusSaving',
  completed: 'statusCompleted',
  error: 'statusError',
};
export const ERRORS = {
  network: 'errNetwork',
  http: 'errHttp',
  'no-space': 'errNoSpace',
  save: 'errSave',
  'range-unsupported': 'errRangeUnsupported',
  engine: 'errEngine',
  live: 'errLive',
  drm: 'errDrm',
  folder: 'errFolder',
  checksum: 'errChecksum',
};

export function statusText(task) {
  if (task.status === 'downloading' && task.verifying) return t('statusVerifying', [`${Math.floor((task.verifying.done / (task.verifying.size || 1)) * 100)}%`]);
  return task.status === 'error' && task.error
    ? `${t('statusError')}: ${t(ERRORS[task.error.code] || 'errEngine')}`
    : t(STATUS[task.status] || 'statusQueued');
}
