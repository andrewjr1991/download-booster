// HTTP/2 test server whose limit is per TCP connection, like a CDN whose
// single connection can't go faster (long, lossy path). All streams on one
// HTTP/2 session share `rateKBps`; a second connection gets its own share.
//   node test/h2server.mjs [port] [MB] [rateKBps]
// Needs openssl for a throwaway self-signed certificate; launch Chromium
// with --ignore-certificate-errors.
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function startH2Server({ port = 8443, sizeMB = 40, rateKBps = 2048 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const size = sizeMB * 1024 * 1024;
  const data = crypto.randomBytes(size);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const etag = `"${sha256.slice(0, 16)}"`;
  const perTick = Math.floor((rateKBps * 1024) / 10);
  const sessions = new Set();
  const log = [];

  const server = http2.createSecureServer({
    key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem')),
  });
  server.on('session', (session) => {
    session.streamsOut = [];
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  // GitHub-style signed links (the e2e maps github.com and
  // private-user-images.githubusercontent.com here): the asset page
  // redirects to a link that works until its token's "exp".
  const SIGNED_HOST = 'https://private-user-images.githubusercontent.com';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signedUrl = (id, ttlMs) => `${SIGNED_HOST}/1/2-${id}.mp4?jwt=h.${b64({ exp: Math.floor((Date.now() + ttlMs) / 1000) })}.s`;
  const tokenAlive = (jwt) => {
    try {
      return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).exp * 1000 > Date.now();
    } catch {
      return false;
    }
  };

  server.on('stream', (stream, headers) => {
    const range = headers.range;
    log.push({ path: headers[':path'], range, cookie: !!headers.cookie, session: [...sessions].indexOf(stream.session) });
    const u = new URL(headers[':path'], 'https://x');
    const asset = /^\/user-attachments\/assets\/([\w-]+)$/.exec(u.pathname);
    if (asset) {
      stream.respond({ ':status': 302, location: signedUrl(asset[1], 5 * 60000) });
      return stream.end();
    }
    if (u.pathname.startsWith('/1/2-') && !tokenAlive(u.searchParams.get('jwt') || '')) {
      stream.respond({ ':status': 404 });
      return stream.end();
    }
    const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    let start = 0;
    let end = size;
    const h = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag,
      'content-disposition': `attachment; filename="h2-${sizeMB}MB.bin"` };
    if (u.pathname.startsWith('/1/2-')) {
      h['content-type'] = 'video/mp4';
      delete h['content-disposition'];
    }
    let status = 200;
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(size, Number(m[2]) + 1) : size;
      status = 206;
      h['content-range'] = `bytes ${start}-${end - 1}/${size}`;
    }
    h['content-length'] = end - start;
    stream.respond({ ':status': status, ...h });
    const out = { stream, pos: start, end };
    stream.session.streamsOut.push(out);
    stream.on('close', () => {
      const list = stream.session?.streamsOut;
      if (list) list.splice(list.indexOf(out), 1);
    });
  });

  // Every 100 ms each session sends perTick bytes, split across its streams.
  const timer = setInterval(() => {
    for (const s of sessions) {
      const live = s.streamsOut.filter((o) => !o.stream.destroyed);
      if (!live.length) continue;
      const share = Math.max(1, Math.floor(perTick / live.length));
      for (const o of live) {
        const n = Math.min(share, o.end - o.pos);
        if (n > 0) {
          o.stream.write(data.subarray(o.pos, o.pos + n));
          o.pos += n;
        }
        if (o.pos >= o.end && !o.stream.writableEnded) o.stream.end();
      }
    }
  }, 100);
  server.on('close', () => clearInterval(timer));

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, size, sha256, log, sessions, signedUrl, url: `https://127.0.0.1:${port}` })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, sizeMB, rateKBps] = process.argv.slice(2).map(Number);
  const s = await startH2Server({ port: port || 8443, sizeMB: sizeMB || 40, rateKBps: rateKBps || 2048 });
  console.log(`Serving ${s.url}/file.bin over HTTP/2, ${rateKBps || 2048} KB/s per connection`);
}
