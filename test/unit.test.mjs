import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveController, RateLimiter, splitLargest, remaining, MIN_SPLIT } from '../src/scheduler.js';
import { parseContentRange, filenameFromDisposition, sanitizeFilename, pickFilename } from '../src/http.js';
import { categorize, extensionOf, prepareLinks, parsePastedUrls } from '../src/sniff.js';
import { classify, sizeFrom, mediaKey, addMedia } from '../src/media.js';

test('parseContentRange', () => {
  assert.deepEqual(parseContentRange('bytes 0-99/1000'), { start: 0, end: 100, total: 1000 });
  assert.deepEqual(parseContentRange('bytes 5-9/*'), { start: 5, end: 10, total: null });
  assert.equal(parseContentRange('garbage'), null);
});

test('filenames', () => {
  assert.equal(filenameFromDisposition(`attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip`), '中文.zip');
  assert.equal(filenameFromDisposition('attachment; filename="a b.iso"'), 'a b.iso');
  assert.equal(sanitizeFilename('../x:y?.exe'), '_x_y_.exe');
  assert.equal(pickFilename({ url: 'https://h/dir/file%20name.tar.gz' }), 'file name.tar.gz');
  assert.equal(pickFilename({ url: 'https://h/' }), 'download');
});

test('splitLargest halves the active segment with most bytes left', () => {
  const segs = [{ id: 0, start: 0, end: 100 * MIN_SPLIT, pos: 10 * MIN_SPLIT }];
  const s = splitLargest(segs, new Set([0]));
  assert.equal(segs[0].end, 55 * MIN_SPLIT);
  assert.deepEqual(s, { id: 1, start: 55 * MIN_SPLIT, end: 100 * MIN_SPLIT, pos: 55 * MIN_SPLIT });
  // Too small to split.
  const tiny = [{ id: 0, start: 0, end: MIN_SPLIT, pos: 0 }];
  assert.equal(splitLargest(tiny, new Set([0])), null);
  // Only active segments are split.
  assert.equal(splitLargest(segs, new Set()), null);
  assert.equal(remaining(segs[0]) + remaining(s), 90 * MIN_SPLIT);
});

// Simulated network: each connection gets `perConn` MB/s after a time to
// first byte and a linear ramp-up; the line caps the total at `cap` MB/s.
function simulate({ perConn, cap, capAt, max = 6, ttfb = 0, rampMs = 0, noise = 0, until = 60000, events = {} }) {
  const c = new AdaptiveController({ max });
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const conns = [-60000]; // connection 1 is already streaming when ticking starts
  const trace = [];
  let bytes = 0;
  for (let t = 0; t <= until; t += 500) {
    let sum = 0;
    for (const s of conns) {
      const a = t - s - ttfb;
      if (a > 0) sum += perConn * (rampMs ? Math.min(1, a / rampMs) : 1);
    }
    bytes += Math.min(sum, capAt ? capAt(t) : cap) * 0.5 * (1 - noise + 2 * noise * rand());
    events[t]?.(c, t);
    const streaming = conns.filter((s) => t - s >= ttfb).length;
    c.tick(t, bytes, streaming);
    while (conns.length < c.target) conns.push(t);
    while (conns.length > c.target) conns.pop();
    trace.push([t, c.target]);
  }
  return { c, trace };
}
const minAfter = (trace, t0) => Math.min(...trace.filter(([t]) => t >= t0).map(([, n]) => n));

test('adds connections while speed rises, stops at the plateau', () => {
  // Per-request limit 1 MB/s, line 4 MB/s: best is 4 connections.
  const { c, trace } = simulate({ perConn: 1, cap: 4 });
  assert.equal(c.best, 4);
  assert.equal(c.singleSpeed, 1);
  assert.equal(minAfter(trace, 20000), 4);
});

test('a slow-starting extra connection is not judged useless (real CDN case)', () => {
  // 7 MB/s per connection, 14 MB/s line, new connections need 1.5 s to the
  // first byte and 2.5 s to ramp up, ±10% noise. Must hold 2 connections.
  const { c, trace } = simulate({ perConn: 7, cap: 14, ttfb: 1500, rampMs: 2500, noise: 0.1, until: 180000 });
  assert.equal(c.best, 2);
  // Brief dips are the periodic one-fewer re-checks.
  const later = trace.filter(([t]) => t >= 20000);
  const share = later.filter(([, n]) => n >= 2).length / later.length;
  assert.ok(share > 0.9, `only ${share} of the time on 2+ connections`);
});

test('comes back down when extra connections stop helping', () => {
  // 4 MB/s per connection up to 12 MB/s: 3 connections. From 60 s on the
  // server caps the whole download at 4 MB/s, so 1 connection is enough.
  const capAt = (t) => (t < 60000 ? 12 : 4);
  const { trace } = simulate({ perConn: 4, cap: 12, capAt, until: 240000 });
  const at = (ms) => trace.find(([t]) => t === ms)[1];
  assert.ok(at(55000) >= 3);
  assert.ok(trace.filter(([t]) => t >= 180000).every(([, n]) => n <= 2), 'still above 2 connections after 3 minutes');
});

test('stays on one connection when more do not help', () => {
  const { c, trace } = simulate({ perConn: 10, cap: 10, noise: 0.05, until: 120000 });
  assert.equal(c.best, 1);
  const atOne = trace.filter(([, n]) => n === 1).length / trace.length;
  assert.ok(atOne > 0.6, `only ${atOne} of the time on 1 connection`);
});

test('never exceeds max', () => {
  const { c, trace } = simulate({ perConn: 1, cap: 100, max: 6 });
  assert.equal(c.target, 6);
  assert.ok(trace.every(([, n]) => n <= 6));
});

test('backoff drops one connection, then probes again after the cooldown', () => {
  const events = {
    30000: (c, t) => {
      c.backoff(t);
      c.backoff(t + 500); // a burst of errors counts once
    },
  };
  const { trace } = simulate({ perConn: 1, cap: 4, until: 150000, events });
  const at = (ms) => trace.find(([t]) => t === ms)[1];
  assert.equal(at(30000), 3);
  assert.ok(at(55000) >= 3);
  const later = trace.filter(([t]) => t >= 65000);
  assert.ok(later.filter(([, n]) => n >= 4).length / later.length > 0.7, 'did not return to 4 connections');
});

test('sniffed links: categories, dedupe, pasted lists', () => {
  assert.equal(categorize('https://x.com/a/Movie.MKV?sig=1'), 'video');
  assert.equal(categorize('https://x.com/win11.iso'), 'disk');
  assert.equal(categorize('https://x.com/archive.tar.gz'), 'archive');
  assert.equal(categorize('https://x.com/a%20b.pdf'), 'document');
  assert.equal(categorize('https://x.com/about'), 'other');
  assert.equal(categorize('https://x.com/'), 'other');
  assert.equal(extensionOf('not a url'), '');

  const links = prepareLinks([
    { url: 'https://x.com/a.zip', text: '  A  ' },
    { url: 'https://x.com/a.zip#top', text: 'dup' },
    { url: 'javascript:void(0)', text: 'js' },
    { url: 'mailto:a@x.com' },
    { url: 'https://x.com/b.mp3' },
  ]);
  assert.deepEqual(links, [
    { url: 'https://x.com/a.zip', text: 'A', category: 'archive' },
    { url: 'https://x.com/b.mp3', text: '', category: 'audio' },
  ]);

  assert.deepEqual(parsePastedUrls(' https://x.com/1.zip\nhttps://x.com/2.zip  ftp://no\r\n\nhttps://x.com/1.zip\nhello '), [
    'https://x.com/1.zip',
    'https://x.com/2.zip',
  ]);
  assert.deepEqual(parsePastedUrls(''), []);
});

test('speed limit: connections together stay at the rate', () => {
  // Three connections that could each pull 64 KB every 10 ms (6.4 MB/s),
  // limited to 1 MB/s in total.
  const rate = 1 << 20;
  const lim = new RateLimiter(rate);
  const next = [0, 3, 7];
  let bytes = 0;
  let now = 0;
  while (now < 20000) {
    const i = next.indexOf(Math.min(...next));
    now = next[i];
    bytes += 65536;
    next[i] = now + 10 + lim.take(65536, now);
  }
  const speed = bytes / 20;
  assert.ok(Math.abs(speed - rate) / rate < 0.05, `${speed} vs ${rate}`);

  assert.equal(new RateLimiter(0).take(1e9, 0), 0, 'no limit never waits');
  lim.setRate(0);
  assert.equal(lim.take(1e9, now), 0);
});

test('rethink climbs again quickly once a limit is lifted', () => {
  const c = new AdaptiveController({ max: 6 });
  const run = (from, to, perConnCap) => {
    let bytes = run.bytes || 0;
    for (let now = from; now < to; now += 100) {
      bytes += (Math.min(c.target * 2, perConnCap) * 1048576) / 10;
      c.tick(now, bytes, c.target);
    }
    run.bytes = bytes;
  };
  run(0, 30000, 1.5); // limited to 1.5 MB/s: one connection is plenty
  assert.ok(c.target <= 2, `target ${c.target}`); // 2 only while re-probing
  c.rethink(30000);
  run(30000, 50000, 100); // 2 MB/s per connection, no limit
  assert.ok(c.target >= 4, `target ${c.target}`);
});

test('media seen on the network: kinds, sizes, duplicates', () => {
  assert.equal(classify({ url: 'https://v.cdn/a/clip', mime: 'video/mp4' }), 'video');
  assert.equal(classify({ url: 'https://v.cdn/a/song.mp3', mime: 'application/octet-stream' }), 'audio');
  assert.equal(classify({ url: 'https://v.cdn/a/x', type: 'media', mime: '' }), 'video');
  assert.equal(classify({ url: 'https://v.cdn/live.m3u8', mime: 'text/plain' }), 'stream');
  assert.equal(classify({ url: 'https://v.cdn/x', mime: 'application/vnd.apple.mpegurl; charset=utf-8' }), 'stream');
  assert.equal(classify({ url: 'https://v.cdn/seg1.ts', mime: 'video/mp2t' }), null, 'stream pieces are skipped');
  assert.equal(classify({ url: 'https://v.cdn/icon.png', mime: 'image/png', size: 900 }), null, 'icons are skipped');
  assert.equal(classify({ url: 'https://v.cdn/p.jpg', mime: 'image/jpeg', size: 50000 }), 'image');
  assert.equal(classify({ url: 'https://v.cdn/click.mp3', mime: 'audio/mpeg', size: 6500 }), null, 'UI sounds are skipped');
  assert.equal(classify({ url: 'https://v.cdn/app.js', mime: 'text/javascript' }), null);
  assert.equal(classify({ url: 'blob:https://v.cdn/1', mime: 'video/mp4' }), null);

  assert.equal(sizeFrom([{ name: 'Content-Range', value: 'bytes 0-99/5000' }]), 5000);
  assert.equal(sizeFrom([{ name: 'content-length', value: '123' }]), 123);
  assert.equal(sizeFrom([]), null);

  assert.equal(mediaKey('https://v.cdn/v.mp4?sig=a+b&range=0-1000#t=3'), 'https://v.cdn/v.mp4?sig=a+b');
  assert.equal(mediaKey('https://v.cdn/v.mp4?sig=a%20b'), 'https://v.cdn/v.mp4?sig=a%20b', 'query untouched');

  const list = [];
  assert.ok(addMedia(list, { url: 'https://v.cdn/v.mp4?range=0-99', mime: 'video/mp4', size: 60000 }));
  assert.ok(addMedia(list, { url: 'https://v.cdn/v.mp4?range=100-999', mime: 'video/mp4', size: 900000 }), 'bigger size updates');
  assert.ok(!addMedia(list, { url: 'https://v.cdn/v.mp4', mime: 'video/mp4', size: 900000 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://v.cdn/v.mp4');
  assert.equal(list[0].name, 'v.mp4');
  assert.equal(list[0].size, 900000);
});
