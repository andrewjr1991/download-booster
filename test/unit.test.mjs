import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveController, splitLargest, remaining, MIN_SPLIT } from '../src/scheduler.js';
import { parseContentRange, filenameFromDisposition, sanitizeFilename, pickFilename } from '../src/http.js';

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

// Simulate a server that caps each request at `perConn` bytes/s and the line at `cap`.
function simulate(perConn, cap, max = 6) {
  const c = new AdaptiveController({ max, warmupMs: 2000, probeMs: 3000 });
  let now = 0;
  for (; now < 30000; now += 500) {
    const speed = Math.min(c.target * perConn, cap);
    c.tick(now, speed, c.target);
  }
  return c;
}

test('adds connections while speed rises, stops at the plateau', () => {
  // Per-request limit 1 MB/s, line 4 MB/s: best is 4 connections.
  const c = simulate(1, 4);
  assert.equal(c.target, 4);
  assert.equal(c.singleSpeed, 1);
  assert.equal(c.phase, 'stable');
});

test('stays on one connection when more do not help', () => {
  const c = simulate(10, 10);
  assert.equal(c.target, 1);
});

test('never exceeds max', () => {
  const c = simulate(1, 100, 6);
  assert.equal(c.target, 6);
});

test('backoff drops a connection and caps the max', () => {
  const c = simulate(1, 4);
  c.backoff(100000);
  assert.equal(c.target, 3);
  assert.equal(c.max, 3);
});
