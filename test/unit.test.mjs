import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveController, RateLimiter, splitLargest, remaining, missingRanges, MIN_SPLIT } from '../src/scheduler.js';
import { parseContentRange, filenameFromDisposition, sanitizeFilename, pickFilename, applyRename } from '../src/http.js';
import { categorize, extensionOf, prepareLinks, parsePastedUrls, mergeMedia } from '../src/sniff.js';
import { classify, sizeFrom, mediaKey, addMedia, compileRules } from '../src/media.js';
import { parsePlaylist, ivFor, variantLabel } from '../src/hls.js';
import { Mp4Stream, mux, canJoin, children, parseMoov } from '../src/fmp4.js';
import { parseMpd, parseManifest, parseSidx, isoDuration, fillTemplate } from '../src/dash.js';
import { readFileSync } from 'node:fs';
import { createHash as nodeHash, randomBytes } from 'node:crypto';
import { createHash, parseChecksum } from '../src/hash.js';

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

test('missing ranges: a file is only saved when its pieces cover every byte', () => {
  const seg = (start, end, pos = end) => ({ start, end, pos });
  assert.deepEqual(missingRanges([seg(0, 50), seg(50, 100)], 100), []);
  // Pieces in any order, one overlapping another.
  assert.deepEqual(missingRanges([seg(60, 100), seg(0, 70)], 100), []);
  assert.deepEqual(missingRanges([seg(0, 40), seg(60, 100)], 100), [[40, 60]]);
  assert.deepEqual(missingRanges([seg(0, 50, 30), seg(50, 100)], 100), [[30, 50]]);
  assert.deepEqual(missingRanges([seg(10, 90)], 100), [[0, 10], [90, 100]]);
  assert.deepEqual(missingRanges([], 5), [[0, 5]]);
});

test('starts at the maximum and stays there', () => {
  const c = new AdaptiveController({ max: 6 });
  assert.equal(c.target, 6);
  let bytes = 0;
  for (let t = 0; t <= 120000; t += 250) {
    // Speed swinging between 5 and 60 MB/s must not take connections away.
    bytes += ((t / 1000) % 10 < 5 ? 60e6 : 5e6) / 4;
    assert.equal(c.tick(t, bytes, 6), 6);
  }
  assert.ok(c.levels[6] > 0);
});

test('backoff drops one connection, then adds it back after the cooldown', () => {
  const c = new AdaptiveController({ max: 6, cooldownMs: 30000 });
  c.backoff(1000);
  c.backoff(1500); // a burst of errors counts once
  assert.equal(c.tick(2000, 0), 5);
  assert.equal(c.tick(30000, 0), 5);
  assert.equal(c.tick(31000, 0), 6);
  // A second push-back waits twice as long.
  c.backoff(40000);
  assert.equal(c.tick(99999, 0), 5);
  assert.equal(c.tick(100000, 0), 6);
  // Never below one connection.
  const one = new AdaptiveController({ max: 1 });
  one.backoff(0);
  assert.equal(one.tick(1, 0), 1);
});

test('a new maximum keeps the push-back', () => {
  const c = new AdaptiveController({ max: 6 });
  c.backoff(0);
  c.setMax(12); // a mirror doubles the room
  assert.equal(c.tick(1, 0), 11);
  c.setMax(1); // ranges unsupported after all
  assert.equal(c.tick(2, 0), 1);
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

test('media seen on the network: kinds, sizes, duplicates', () => {
  assert.equal(classify({ url: 'https://v.cdn/a/clip', mime: 'video/mp4' }), 'video');
  assert.equal(classify({ url: 'https://v.cdn/a/song.mp3', mime: 'application/octet-stream' }), 'audio');
  assert.equal(classify({ url: 'https://v.cdn/a/x', type: 'media', mime: '' }), 'video');
  assert.equal(classify({ url: 'https://v.cdn/live.m3u8', mime: 'text/plain' }), 'stream');
  assert.equal(classify({ url: 'https://v.cdn/x', mime: 'application/vnd.apple.mpegurl; charset=utf-8' }), 'stream');
  assert.equal(classify({ url: 'https://v.cdn/seg1.ts', mime: 'video/mp2t' }), null, 'stream pieces are skipped');
  assert.equal(classify({ url: 'https://v.cdn/icon.png', mime: 'image/png', size: 900 }), null, 'icons are skipped');
  assert.equal(classify({ url: 'https://v.cdn/p.jpg', mime: 'image/jpeg', size: 50000 }), 'image');
  assert.equal(classify({ url: 'https://v.cdn/click.mp3', mime: 'audio/mpeg', size: 6500 }), 'audio', 'sound effects are kept');
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

test('HLS playlists: variants, segments, keys, byte ranges', () => {
  const master = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="aud"',
      'https://cdn.example/hi/index.m3u8?token=1',
    ].join('\n'),
    'https://site.example/v/master.m3u8',
  );
  assert.equal(master.type, 'master');
  assert.deepEqual(
    master.variants.map((v) => [v.url, v.height, v.bandwidth, v.audio]),
    [
      ['https://cdn.example/hi/index.m3u8?token=1', 1080, 4500000, 'aud'],
      ['https://site.example/v/low/index.m3u8', 360, 800000, null],
    ],
  );
  assert.equal(master.audio[0].url, 'https://site.example/v/audio/en.m3u8');
  assert.equal(variantLabel(master.variants[0]), '1080p · 4.5 Mbps');

  const media = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:9.5,',
      'seg7.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x000102030405060708090a0b0c0d0e0f',
      '#EXTINF:10,',
      'seg8.ts',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:3.25,',
      '#EXT-X-BYTERANGE:1000@0',
      'all.ts',
      '#EXTINF:3,',
      '#EXT-X-BYTERANGE:500',
      'all.ts',
      '#EXT-X-ENDLIST',
    ].join('\r\n'),
    'https://site.example/v/hi/index.m3u8',
  );
  assert.equal(media.type, 'media');
  assert.ok(media.endList && media.encrypted && !media.drm && !media.fmp4);
  assert.equal(media.duration, 25.75);
  assert.deepEqual(
    media.segments.map((s) => [s.url.split('/').pop(), s.seq, s.key?.uri?.split('/').pop() ?? null, s.range]),
    [
      ['seg7.ts', 7, 'key.bin', null],
      ['seg8.ts', 8, 'key2.bin', null],
      ['all.ts', 9, null, { offset: 0, length: 1000 }],
      ['all.ts', 10, null, { offset: 1000, length: 500 }],
    ],
  );
  assert.deepEqual([...ivFor(media.segments[0])], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]);
  assert.deepEqual([...ivFor(media.segments[1])], [...Array(16).keys()]);

  const fmp4 = parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n', 'https://x/');
  assert.ok(fmp4.fmp4 && !fmp4.endList);
  assert.equal(fmp4.segments[0].map.url, 'https://x/init.mp4');
  const drm = parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', 'https://x/');
  assert.ok(drm.drm);
  assert.throws(() => parsePlaylist('<html>', 'https://x/'));
});

test('recorded fMP4: chunks, repeats and two tracks become one file', () => {
  const feed = (file) => {
    const s = new Mp4Stream();
    const b = new Uint8Array(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));
    // Odd-sized pieces, as a player might append them.
    for (let at = 0; at < b.length; at += 7001) s.push(b.subarray(at, at + 7001));
    // A seek back: the init section and the first fragment arrive again.
    const top = children(b);
    s.push(b.subarray(0, top[3].end));
    return s;
  };
  const video = feed('video.mp4').settle();
  const audio = feed('audio.mp4').settle();
  assert.equal(video.switched, false);
  const times = video.fragments.map((f) => f.time);
  assert.deepEqual(times, [...new Set(times)].sort((x, y) => x - y), 'in order, no repeats');
  assert.equal(times.length, 4);
  assert.ok(canJoin([audio, video]));

  const parts = mux([audio, video]);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  const top = children(out);
  const moov = top.find((b) => b.type === 'moov');
  const info = parseMoov(out.slice(moov.start, moov.end));
  assert.deepEqual(info.tracks.map((t) => [t.id, t.handler]), [[1, 'vide'], [2, 'soun']]);
  const moofs = top.filter((b) => b.type === 'moof');
  assert.equal(moofs.length, video.fragments.length + audio.fragments.length);
  // Sequence numbers run 1, 2, 3...
  assert.deepEqual(
    moofs.map((m) => new DataView(out.buffer, m.start + 20, 4).getUint32(0)),
    moofs.map((_, i) => i + 1),
  );
});

test('sniffed links: media the page loaded comes first, with its kind and size', () => {
  const links = prepareLinks([
    { url: 'https://x.com/about', text: 'About' },
    { url: 'https://cdn.x.com/a.mp4', text: 'Trailer' },
    { url: 'https://x.com/list.m3u8' },
  ]);
  assert.equal(links[2].category, 'stream');
  const merged = mergeMedia(links, [
    { url: 'https://cdn.x.com/a.mp4', kind: 'video', size: 5e6, name: 'a.mp4' },
    { url: 'https://cdn.x.com/s.mp3', kind: 'audio', size: 3000, name: 's.mp3' },
    { url: 'https://cdn.x.com/v.mpd', kind: 'stream', size: 900, name: 'v.mpd' },
  ]);
  assert.deepEqual(
    merged.map((l) => [l.url.replace(/^https:\/\/[^/]+/, ''), l.category, l.size ?? null, !!l.media]),
    [
      ['/a.mp4', 'video', 5e6, true],
      ['/s.mp3', 'audio', 3000, true],
      ['/v.mpd', 'stream', 900, true],
      ['/about', 'other', null, false],
      ['/list.m3u8', 'stream', null, false],
    ],
  );
  assert.equal(merged[0].text, 'Trailer', 'the link text is kept');
});

test('sniffing rules: own extensions, image size, ignored addresses', () => {
  const rules = compileRules({ video: 'm4s, .dat', audio: '*.amr', minImageKB: 0, ignore: 'ADS.example.com /track/' });
  assert.equal(classify({ url: 'https://x.com/a.m4s', mime: 'video/iso.segment' }, rules), 'video', 'own extension beats the piece filter');
  assert.equal(classify({ url: 'https://x.com/a.dat', mime: 'text/plain' }, rules), 'video');
  assert.equal(classify({ url: 'https://x.com/a.amr' }, rules), 'audio');
  assert.equal(classify({ url: 'https://x.com/i.png', mime: 'image/png', size: 300 }, rules), 'image', 'no minimum');
  assert.equal(classify({ url: 'https://x.com/i.png', mime: 'image/png', size: 300 }), null, 'default minimum');
  assert.equal(classify({ url: 'https://ads.example.com/v.mp4', mime: 'video/mp4' }, rules), null);
  assert.equal(classify({ url: 'https://x.com/track/p.gif', mime: 'image/gif', size: 5e4 }, rules), null);
  const links = prepareLinks(
    [{ url: 'https://x.com/a.dat' }, { url: 'https://ads.example.com/b.zip' }, { url: 'https://x.com/c.zip' }],
    rules,
  );
  assert.deepEqual(links.map((l) => [l.url.slice(14), l.category]), [['a.dat', 'video'], ['c.zip', 'archive']]);
  assert.equal(compileRules({ minImageKB: 'x' }).minImage, 10 * 1024, 'bad input falls back');
});

test('batch rename', () => {
  const r = (n, pattern = '{title}_{n}') => ({ pattern, n, total: 12, title: 'My Trip', host: 'x.com', date: '20261012' });
  assert.equal(applyRename('IMG_001.JPG', r(3)), 'My Trip_03.JPG', 'keeps the extension');
  assert.equal(applyRename('clip.mp4', r(1, '{date}-{host}-{name}')), '20261012-x.com-clip.mp4');
  assert.equal(applyRename('clip.mp4', r(1, '{name}.{ext}.bak')), 'clip.mp4.bak');
  assert.equal(applyRename('download', r(2, 'file {n}')), 'file 02');
  assert.equal(applyRename('a/b.mp4', r(1, 'x:{n}')), 'x_01.mp4', 'unsafe characters replaced');
  assert.equal(applyRename('clip.mp4', null), 'clip.mp4');
  assert.equal(applyRename('clip.mp4', { pattern: '  ' }), 'clip.mp4');
});

test('DASH manifests: qualities, audio languages and their pieces', () => {
  assert.equal(isoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(isoDuration('PT8S'), 8);
  assert.equal(fillTemplate('$RepresentationID$/seg-$Number%05d$-$Time$.m4s$$', { RepresentationID: 'v1', Number: 7, Time: 1200 }), 'v1/seg-00007-1200.m4s$');

  const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">
  <!-- a comment -->
  <BaseURL>https://cdn.example/v/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="2000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number%03d$.m4s?a=1&amp;b=2"/>
      <Representation id="360" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e"/>
      <Representation id="1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="fr">
      <Representation id="fr" bandwidth="96000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="48000" initialization="fr-init.mp4" media="fr-$Time$.m4s">
          <SegmentTimeline><S t="0" d="96000" r="2"/><S d="96000"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <Representation id="en-lo" bandwidth="64000" codecs="mp4a.40.2">
        <BaseURL>en-lo.mp4</BaseURL>
        <SegmentBase indexRange="800-899"><Initialization range="0-799"/></SegmentBase>
      </Representation>
      <Representation id="en" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentList timescale="1" duration="4">
          <Initialization sourceURL="en.mp4" range="0-499"/>
          <SegmentURL media="en.mp4" mediaRange="500-999"/>
          <SegmentURL media="en.mp4" mediaRange="1000-1499"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt"><Representation id="sub" bandwidth="1"/></AdaptationSet>
  </Period>
</MPD>`;
  const m = parseManifest(mpd, 'https://site.example/watch/manifest.mpd');
  assert.equal(m.type, 'master');
  assert.equal(m.dash, true);
  assert.equal(m.live, false);
  assert.deepEqual(m.variants.map((v) => v.height), [1080, 360]);
  const v = m.variants[0];
  assert.equal(v.url, 'https://site.example/watch/manifest.mpd#video=1080');
  assert.equal(v.list.segments.length, 4);
  assert.equal(v.list.segments[0].url, 'https://cdn.example/v/1080/001.m4s?a=1&b=2');
  assert.equal(v.list.segments[3].url, 'https://cdn.example/v/1080/004.m4s?a=1&b=2');
  assert.equal(v.list.segments[0].map.url, 'https://cdn.example/v/1080/init.mp4');
  assert.equal(v.list.duration, 8);
  assert.equal(v.list.fmp4, true);
  // One entry per language, its best quality; the "main" one is the default.
  assert.deepEqual(m.audio.map((a) => [a.name, a.default]), [['fr', false], ['en', true]]);
  const fr = m.audio[0].list;
  assert.deepEqual(fr.segments.map((s) => s.url.split('/').pop()), ['fr-0.m4s', 'fr-96000.m4s', 'fr-192000.m4s', 'fr-288000.m4s']);
  assert.equal(fr.ext, 'm4a');
  const en = m.audio[1].list;
  assert.deepEqual(en.segments.map((s) => s.range), [{ offset: 500, length: 500 }, { offset: 1000, length: 500 }]);
  assert.deepEqual(en.segments[0].map, { url: 'https://cdn.example/v/en.mp4', range: { offset: 0, length: 500 } });

  // Single-file representation: pieces come from its sidx.
  const lo = parseMpd(mpd.replace(/<Representation id="en" [\s\S]*?<\/Representation>/, ''), 'https://site.example/m.mpd').audio[1].list;
  assert.deepEqual(lo.segmentBase, { url: 'https://cdn.example/v/en-lo.mp4', init: { offset: 0, length: 800 }, index: { offset: 800, length: 100 } });

  // Live and DRM.
  assert.equal(parseMpd(mpd.replace('type="static"', 'type="dynamic"'), 'https://x/').variants[0].list.endList, false);
  const drm = parseMpd(mpd.replace('<Representation id="360"', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation id="360"'), 'https://x/');
  assert.equal(drm.variants[0].list.drm, true);
  // m3u8 still goes to the HLS parser.
  assert.equal(parseManifest('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', 'https://x/a.m3u8').type, 'media');
});

test('DASH sidx: piece byte ranges', () => {
  // styp, then a version 0 sidx with two references, first_offset 10.
  const styp = [0, 0, 0, 12, ...Buffer.from('styp'), 0, 0, 0, 0];
  const body = [0, 0, 0, 1, 0, 0, 0x03, 0xe8, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 2];
  const refs = [0, 0, 1, 0, 0, 0, 0x07, 0xd0, 0x90, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x07, 0xd0, 0x90, 0, 0, 0];
  const sidxSize = 8 + 4 + body.length + refs.length;
  const sidx = [0, 0, 0, sidxSize, ...Buffer.from('sidx'), 0, 0, 0, 0, ...body, ...refs];
  const bytes = new Uint8Array([...new Array(100).fill(0), ...styp, ...sidx]);
  const at = 900; // bytes[0] is file offset 900; the index starts at 1000
  const out = parseSidx(bytes, at, { offset: 1000, length: styp.length + sidx.length });
  const start = 1000 + 12 + sidxSize + 10;
  assert.deepEqual(out, [
    { offset: start, length: 256, duration: 2 },
    { offset: start + 256, length: 512, duration: 2 },
  ]);
});

test('checksums: MD5, SHA-1 and SHA-256 fed in pieces match node:crypto', () => {
  for (const algo of ['md5', 'sha1', 'sha256']) {
    for (const n of [0, 3, 55, 56, 64, 65, 1000, 70001]) {
      const data = randomBytes(n);
      const h = createHash(algo);
      for (let i = 0; i < n; i += 37) h.update(new Uint8Array(data.subarray(i, i + 37)));
      assert.equal(h.digest(), nodeHash(algo).update(data).digest('hex'), `${algo} of ${n} bytes`);
    }
  }
  const sha = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';
  assert.deepEqual(parseChecksum(sha), { algo: 'sha256', hex: sha.toLowerCase() });
  assert.deepEqual(parseChecksum(' sha256: ' + sha), { algo: 'sha256', hex: sha.toLowerCase() });
  assert.equal(parseChecksum('md5:' + sha), null);
  assert.equal(parseChecksum('d41d8cd98f00b204e9800998ecf8427e').algo, 'md5');
  assert.equal(parseChecksum('da39a3ee5e6b4b0d3255bfef95601890afd80709').algo, 'sha1');
  assert.equal(parseChecksum('not a hash'), null);
  assert.equal(parseChecksum('abc'), null);
});


test('task list filters', async () => {
  const { matchTask, taskGroup, taskKind } = await import('../src/tasks-filter.js');
  const iso = { status: 'completed', filename: 'ubuntu-24.04.iso', url: 'https://releases.example.com/24.04/ubuntu-24.04.iso' };
  const zip = { status: 'paused', filename: null, url: 'https://h/files/%E6%95%B0%E6%8D%AE.zip?token=1' };
  const bad = { status: 'error', filename: 'movie.mp4', url: 'https://h/v' };
  const hls = { status: 'downloading', kind: 'hls', filename: 'Some show', url: 'https://h/master.m3u8' };
  assert.deepEqual([iso, zip, bad, hls].map(taskGroup), ['completed', 'active', 'error', 'active']);
  assert.deepEqual([iso, zip, bad, hls].map(taskKind), ['disk', 'archive', 'video', 'video']);
  assert.ok(matchTask(iso));
  assert.ok(matchTask(zip, { group: 'active', kind: 'archive' }));
  assert.ok(!matchTask(zip, { group: 'completed' }));
  assert.ok(!matchTask(iso, { kind: 'video' }));
  assert.ok(matchTask(iso, { q: '  UBUNTU  releases ' }), 'every word, any case, name or address');
  assert.ok(!matchTask(iso, { q: 'ubuntu debian' }));
  assert.ok(matchTask(zip, { q: '数据' }), 'searches the readable address');
});

test('link patterns', async () => {
  const { expandPattern, PATTERN_MAX } = await import('../src/sniff.js');
  assert.deepEqual(expandPattern('https://h/img[1-3].jpg'), ['https://h/img1.jpg', 'https://h/img2.jpg', 'https://h/img3.jpg']);
  assert.deepEqual(expandPattern('https://h/p[008-011].png'), ['https://h/p008.png', 'https://h/p009.png', 'https://h/p010.png', 'https://h/p011.png']);
  assert.deepEqual(expandPattern('https://h/[a-c]/[1-2].zip').length, 6);
  assert.deepEqual(expandPattern('https://h/[a-c]/[1-2].zip')[1], 'https://h/a/2.zip');
  assert.deepEqual(expandPattern('https://h/x[0-10:5]'), ['https://h/x0', 'https://h/x5', 'https://h/x10']);
  assert.deepEqual(expandPattern('https://h/x[3-1]'), ['https://h/x3', 'https://h/x2', 'https://h/x1']);
  assert.deepEqual(expandPattern('http://[::1]:8080/a?b[]=1'), ['http://[::1]:8080/a?b[]=1']);
  assert.equal(expandPattern('https://h/[1-100000]').length, PATTERN_MAX);
  assert.equal(parsePastedUrls('https://h/a[1-3].bin https://h/a2.bin').length, 3);
});

test('subfolders by file type', async () => {
  const { resolveSubfolders, subfolderFor, cleanPath } = await import('../src/subfolders.js');
  assert.equal(resolveSubfolders({ on: false }, (k) => k), null);
  const map = resolveSubfolders({ on: true, names: { video: ' Videos / Movies ', image: '../..' } }, (k) => `Default ${k}`);
  assert.equal(map.video, 'Videos/Movies');
  assert.equal(map.image, 'Default image', 'nothing usable left: the default');
  assert.equal(subfolderFor(map, 'clip.MP4'), 'Videos/Movies');
  assert.equal(subfolderFor(map, 'setup.exe'), 'Default program');
  assert.equal(subfolderFor(map, 'page.html'), '', 'other files stay at the top');
  assert.equal(subfolderFor(null, 'clip.mp4'), '');
  assert.equal(cleanPath('a:b\\\\c/./d'), 'a_b/c/d');
});

test('signed links: GitHub attachments and their expiry', async () => {
  const { sourceOf, expiresAt, isStale } = await import('../src/media-signed.js');
  const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const video = `https://private-user-images.githubusercontent.com/659597426/123-354b522a-ef6b-4547-bb07-c80c6268a5e8.mp4?jwt=${jwt(1)}`;
  const image = `https://private-user-images.githubusercontent.com/12/354b522a-ef6b-4547-bb07-c80c6268a5e8.png?jwt=${jwt(4102444800)}`;
  assert.equal(sourceOf(video), 'https://github.com/user-attachments/assets/354b522a-ef6b-4547-bb07-c80c6268a5e8');
  assert.equal(sourceOf(image), 'https://github.com/user-attachments/assets/354b522a-ef6b-4547-bb07-c80c6268a5e8');
  assert.equal(sourceOf('https://private-user-images.githubusercontent.com/x/y.mp4'), null);
  assert.equal(sourceOf('https://example.com/659597426/123-354b522a-ef6b-4547-bb07-c80c6268a5e8.mp4'), null);
  assert.equal(expiresAt(video), 1000);
  assert.equal(expiresAt('https://example.com/a.mp4?jwt=garbage'), null);
  assert.ok(isStale(video));
  assert.ok(!isStale(image));
  assert.ok(!isStale('https://example.com/a.mp4'), 'no token: nothing known');
  // The media list: one entry per file, whose link is the newest one seen.
  const list = [];
  addMedia(list, { url: video, mime: 'video/mp4', size: 10 });
  addMedia(list, { url: image, mime: 'image/png', size: 40000 });
  assert.equal(list.length, 2);
  const newer = video.replace(/jwt=.*/, `jwt=${jwt(4102444800)}`);
  assert.ok(addMedia(list, { url: newer, mime: 'video/mp4', size: 10 }), 'a newer link counts as a change');
  assert.equal(list.length, 2);
  assert.equal(list[0].url, newer);
  assert.ok(!addMedia(list, { url: video, mime: 'video/mp4', size: 10 }), 'an older link does not replace it');
  assert.equal(list[0].url, newer);
});
