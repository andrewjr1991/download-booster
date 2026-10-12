// Pure HTTP helpers. No browser APIs, so they run under Node tests too.

// "bytes 0-1023/4096" -> {start: 0, end: 1024, total: 4096}  (end is exclusive)
export function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((value || '').trim());
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]) + 1,
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

export function filenameFromDisposition(value) {
  if (!value) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return null;
}

export function filenameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

// Make a name safe for chrome.downloads.download({filename}), which rejects
// path separators, reserved characters and names like "." or "..".
export function sanitizeFilename(name) {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!s) s = 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s.slice(0, 200);
}

export function pickFilename({ disposition, url, fallback }) {
  return sanitizeFilename(filenameFromDisposition(disposition) || fallback || filenameFromUrl(url) || 'download');
}

// Status codes that mean "too many requests from you": back off concurrency.
// 403 is not one of them: it usually means an expired or forbidden link.
export function isThrottleStatus(status) {
  return status === 429 || status === 503;
}

// Batch rename: `pattern` with {name} (original name without extension), {n}
// (number in the batch, zero-padded), {title} (page title), {host} and {date}.
// The original extension is kept unless the pattern places {ext} itself.
export function applyRename(original, rename) {
  const pattern = String(rename?.pattern || '').trim();
  if (!pattern) return original;
  const dot = original.lastIndexOf('.');
  const base = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot + 1) : '';
  const width = String(rename.total || rename.n || 1).length;
  const values = {
    name: base,
    ext,
    n: String(rename.n || 1).padStart(width, '0'),
    title: rename.title || '',
    host: rename.host || '',
    date: rename.date || '',
  };
  let out = pattern.replace(/\{(name|ext|n|title|host|date)\}/g, (_, k) => values[k]);
  if (ext && !pattern.includes('{ext}')) out += `.${ext}`;
  return sanitizeFilename(out);
}
