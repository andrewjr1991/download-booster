// Signed addresses that stop working after a while, and where a new one
// comes from. GitHub's README attachments are the common case: the page
// plays https://private-user-images.githubusercontent.com/…?jwt=…, a link
// good for five minutes, while https://github.com/user-attachments/assets/<id>
// answers with a redirect to a fresh one for as long as the file exists.

const SIGNED = [
  {
    host: 'private-user-images.githubusercontent.com',
    // /<user>/<n>-<uuid>.mp4 (videos) or /<user>/<uuid>.png
    path: /^\/\d+\/(?:\d+-)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.[a-z0-9]+$/i,
    source: (m) => `https://github.com/user-attachments/assets/${m[1]}`,
  },
];

// The address a fresh link is fetched from, or null for an ordinary address.
export function sourceOf(url) {
  try {
    const u = new URL(url);
    for (const r of SIGNED) {
      if (u.host !== r.host) continue;
      const m = r.path.exec(u.pathname);
      if (m) return r.source(m);
    }
  } catch {}
  return null;
}

// When the link stops working (ms), read from its "jwt" token; null if unknown.
export function expiresAt(url) {
  try {
    const jwt = new URL(url).searchParams.get('jwt');
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp > 0 ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Expired, or about to: a request started now would not finish in time.
export function isStale(url, margin = 20000) {
  const exp = expiresAt(url);
  return exp != null && exp - margin < Date.now();
}

// Response codes a dead link gets.
export const GONE = new Set([401, 403, 404, 410]);

// The same file at a fresh address, or null when there is no source for it
// or the source did not give one. One byte is asked for: the answer only
// matters for where it comes from.
export async function freshUrl(url) {
  const source = sourceOf(url);
  if (!source) return null;
  const ac = new AbortController();
  try {
    const resp = await fetch(source, { headers: { Range: 'bytes=0-0' }, credentials: 'include', cache: 'no-store', signal: ac.signal });
    const fresh = resp.ok && resp.url && resp.url !== url && resp.url !== source ? resp.url : null;
    ac.abort();
    return fresh;
  } catch {
    return null;
  }
}
