// Finding downloadable links on a page. `collectLinks` runs inside the page
// (injected with chrome.scripting); the rest is pure and unit-tested.

export const CATEGORIES = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'ape'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab'],
  program: ['exe', 'msi', 'msix', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appimage', 'jar'],
  disk: ['iso', 'img', 'bin', 'vhd', 'vhdx', 'vmdk', 'qcow2'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'mobi', 'csv', 'txt'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic'],
  stream: ['m3u8', 'mpd'],
};
export const CATEGORY_ORDER = ['video', 'audio', 'stream', 'archive', 'program', 'disk', 'document', 'image', 'other'];

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
// `extra` maps the user's own extensions to a category (sniffing rules).
export function categorize(url, extra) {
  const ext = extensionOf(url);
  return extra?.get(ext) || BY_EXT.get(ext) || 'other';
}

// Deduplicate (ignoring #fragments), keep http(s) only, attach a category.
// `rules` (media.js compileRules) adds extensions and drops ignored addresses.
export function prepareLinks(raw, rules) {
  const seen = new Set();
  const out = [];
  for (const { url, text } of raw) {
    if (!/^https?:\/\//i.test(url || '')) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const lower = key.toLowerCase();
    if (rules?.ignore.some((w) => lower.includes(w))) continue;
    out.push({ url: key, text: (text || '').trim().slice(0, 200), category: categorize(key, rules?.ext) });
  }
  return out;
}

// Put the media the page actually loaded (media.js, seen on the network: often
// with no link on the page at all) in front of the page's links. They carry
// their kind and size; a link to the same address is folded into it.
export function mergeMedia(links, media) {
  const rest = new Map(links.map((l) => [l.url, l]));
  const found = [];
  for (const m of media) {
    const link = rest.get(m.url);
    rest.delete(m.url);
    found.push({ url: m.url, text: link?.text || m.name || '', category: m.kind, size: m.size || null, media: true });
  }
  found.sort((a, b) => (b.size || 0) - (a.size || 0));
  return [...found, ...rest.values()];
}

// Split pasted text into http(s) URLs (one per line, or separated by spaces).
export function parsePastedUrls(text) {
  return prepareLinks(
    String(text || '')
      .split(/\s+/)
      .filter(Boolean)
      .flatMap(expandPattern)
      .map((url) => ({ url })),
  ).map((l) => l.url);
}

export const PATTERN_MAX = 5000;
// [1-100] [001-120] [a-z] [0-100:5]: numbers (zero-padded like the first
// one), or single letters, with an optional step. Not [::1] or a[]=1.
const RANGE = /\[(?:(\d+)-(\d+)|([a-z])-([a-z])|([A-Z])-([A-Z]))(?::(\d+))?\]/;

// A link with ranges in it becomes every link they stand for (all
// combinations when there are several), at most PATTERN_MAX.
export function expandPattern(url) {
  const m = RANGE.exec(url);
  if (!m) return [url];
  const step = Math.max(1, Number(m[7]) || 1);
  const values = [];
  if (m[1] != null) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const width = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 0;
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? step : -step) {
      values.push(String(i).padStart(width, '0'));
      if (values.length >= PATTERN_MAX) break;
    }
  } else {
    const [a, b] = [(m[3] || m[5]).charCodeAt(0), (m[4] || m[6]).charCodeAt(0)];
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? step : -step) values.push(String.fromCharCode(i));
  }
  const head = url.slice(0, m.index);
  const rest = expandPattern(url.slice(m.index + m[0].length));
  const out = [];
  for (const v of values) {
    for (const r of rest) {
      out.push(head + v + r);
      if (out.length >= PATTERN_MAX) return out;
    }
  }
  return out;
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
