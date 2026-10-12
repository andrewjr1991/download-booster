// Finding downloadable links on a page. `collectLinks` runs inside the page
// (injected with chrome.scripting); the rest is pure and unit-tested.

export const CATEGORIES = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'ape'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab'],
  program: ['exe', 'msi', 'msix', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appimage', 'jar'],
  disk: ['iso', 'img', 'bin', 'vhd', 'vhdx', 'vmdk', 'qcow2'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'mobi', 'csv', 'txt'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic'],
};
export const CATEGORY_ORDER = ['video', 'audio', 'archive', 'program', 'disk', 'document', 'image', 'other'];

const BY_EXT = new Map(Object.entries(CATEGORIES).flatMap(([cat, exts]) => exts.map((e) => [e, cat])));

export function extensionOf(url) {
  try {
    const last = new URL(url).pathname.split('/').pop() || '';
    const m = /\.([a-z0-9]{1,9})$/i.exec(decodeURIComponent(last));
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

// 'other' means no recognised file extension (often an ordinary web page).
export function categorize(url) {
  return BY_EXT.get(extensionOf(url)) || 'other';
}

// Deduplicate (ignoring #fragments), keep http(s) only, attach a category.
export function prepareLinks(raw) {
  const seen = new Set();
  const out = [];
  for (const { url, text } of raw) {
    if (!/^https?:\/\//i.test(url || '')) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, text: (text || '').trim().slice(0, 200), category: categorize(key) });
  }
  return out;
}

// Split pasted text into http(s) URLs (one per line, or separated by spaces).
export function parsePastedUrls(text) {
  return prepareLinks(
    String(text || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((url) => ({ url })),
  ).map((l) => l.url);
}

// Injected into the page: must stay self-contained (no closure variables).
export function collectLinks() {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) out.push({ url: a.href, text: a.textContent || a.title || '' });
  for (const el of document.querySelectorAll('video[src], audio[src], source[src], embed[src], object[data]')) {
    out.push({ url: el.src || el.data, text: el.title || '' });
  }
  return out;
}
