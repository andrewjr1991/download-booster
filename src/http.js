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
export function isThrottleStatus(status) {
  return status === 429 || status === 503 || status === 403;
}
