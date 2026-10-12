// Recording, part 2 of 3: content script (isolated world) in every frame of a
// tab being recorded. Asks the background whether this tab is being recorded,
// then relays what record-hook.js copies to record-sink.html, an extension
// frame that can write to the extension's storage. Optionally plays blob:
// videos muted at 16x so the player loads them faster. The popup reads
// status and stops the recording through globalThis.__downloadBoosterRec.

(async () => {
  if (globalThis.__downloadBoosterRec) return;
  const TAG = '__downloadBoosterRec';
  const tell = (state) => window.postMessage({ [TAG]: 'bridge', state }, '*');

  let rec = null;
  try {
    rec = await chrome.runtime.sendMessage({ type: 'record-active' });
  } catch {
    /* extension reloaded */
  }
  if (!rec?.active) return tell('off');

  const tracks = new Map(); // id -> { media, mime, bytes }
  const ended = new Set(); // media ids the player finished
  let saved = 0;
  let saving = 0;
  let sink = null; // MessagePort to the sink frame
  const outbox = [];
  let finishing = null;

  function toSink(msg, transfer = []) {
    if (sink) sink.postMessage(msg, transfer);
    else {
      outbox.push([msg, transfer]);
      openSink();
    }
  }

  let opening = false;
  function openSink() {
    if (opening) return;
    opening = true;
    const url = chrome.runtime.getURL('src/record-sink.html');
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'display:none!important';
    frame.addEventListener('load', () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = fromSink;
      frame.contentWindow.postMessage({ type: 'connect', token: rec.token }, new URL(url).origin, [channel.port2]);
      sink = channel.port1;
      for (const [m, t] of outbox.splice(0)) sink.postMessage(m, t);
    });
    (document.body || document.documentElement).append(frame);
  }

  const waiters = [];
  function fromSink(e) {
    const m = e.data;
    if (m.type === 'saving') saving += 1;
    if (m.type === 'saved' || m.type === 'failed') {
      saving = Math.max(0, saving - 1);
      if (m.type === 'saved') saved += m.files;
      // Every video in this frame was loaded to the end and saved: done.
      const all = new Set([...tracks.values()].map((x) => x.media));
      if (!finishing && !saving && [...all].every((id) => ended.has(id))) {
        finishing = Promise.resolve();
        restore();
        chrome.runtime.sendMessage({ type: 'record-done' }).catch(() => {});
      }
    }
    if (m.type === 'finished') waiters.splice(0).forEach((w) => w(m));
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'hook' || finishing) return;
    const m = e.data;
    if (m.type === 'track') tracks.set(m.id, { media: m.media, mime: m.mime, bytes: 0 });
    else if (m.type === 'data') {
      const track = tracks.get(m.id);
      if (!track) return;
      track.bytes += m.data.byteLength;
      return toSink({ type: 'data', id: m.id, data: m.data }, [m.data]);
    } else if (m.type === 'end') ended.add(m.media);
    toSink({ type: m.type, id: m.id, media: m.media, mime: m.mime });
  });
  tell('on');

  // ---- faster loading ----------------------------------------------------------

  const touched = new Set();
  const blobMedia = () => [...document.querySelectorAll('video, audio')].filter((v) => v.currentSrc.startsWith('blob:'));
  const speedTimer = rec.fast
    ? setInterval(() => {
        for (const v of blobMedia()) {
          if (v.ended) continue;
          if (!touched.has(v)) touched.add(v);
          v.muted = true;
          if (v.playbackRate < 16) {
            try {
              v.playbackRate = 16;
            } catch {
              /* some players clamp the rate */
            }
          }
          if (v.paused) v.play().catch(() => {});
        }
      }, 1000)
    : null;

  function restore() {
    clearInterval(speedTimer);
    for (const v of touched) {
      v.playbackRate = 1;
      v.muted = false;
    }
  }

  // ---- for the popup -------------------------------------------------------------

  globalThis.__downloadBoosterRec = {
    status() {
      const v = blobMedia().find((x) => x.tagName === 'VIDEO') || blobMedia()[0];
      let loaded = 0;
      if (v?.buffered.length) loaded = v.buffered.end(v.buffered.length - 1);
      return {
        bytes: [...tracks.values()].reduce((s, x) => s + x.bytes, 0),
        tracks: tracks.size,
        loaded,
        duration: v && Number.isFinite(v.duration) ? v.duration : null,
        ended: ended.size,
        saving,
        saved,
        finished: !!finishing,
      };
    },
    // Save everything recorded so far; resolves when the files are handed
    // to the download list.
    stop() {
      if (!finishing) {
        restore();
        finishing = tracks.size
          ? new Promise((resolve) => {
              waiters.push(resolve);
              toSink({ type: 'finish' });
            })
          : Promise.resolve();
      }
      return finishing.then(() => this.status());
    },
  };
})();
