// Recording, part 1 of 3: runs in the page's own world while a recording is
// on (registered by background.js only then). Players build blob: videos by
// feeding MediaSource; this keeps a copy of every piece they append and
// passes it to record-bridge.js. Nothing is kept until the bridge confirms
// this tab is being recorded.

(() => {
  if (window.__downloadBoosterHook) return;
  window.__downloadBoosterHook = true;
  const TAG = '__downloadBoosterRec';
  const MS = window.MediaSource;
  if (!MS || !window.SourceBuffer) return;

  let state = 'wait'; // 'wait' | 'on' | 'off'
  const queue = [];
  const send = (msg, transfer = []) => {
    if (state === 'off') return;
    if (state === 'wait') queue.push([msg, transfer]);
    else window.postMessage({ [TAG]: 'hook', ...msg }, '*', transfer);
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'bridge') return;
    state = e.data.state === 'on' ? 'on' : 'off';
    const held = queue.splice(0);
    if (state === 'on') for (const [m, t] of held) send(m, t);
  });
  // No bridge (scripts blocked in this frame): stop holding data.
  setTimeout(() => {
    if (state === 'wait') {
      state = 'off';
      queue.length = 0;
    }
  }, 10000);

  let nextId = 1;
  const ids = new WeakMap(); // MediaSource or SourceBuffer -> id
  const idOf = (x) => {
    if (!ids.has(x)) ids.set(x, nextId++);
    return ids.get(x);
  };

  const addSourceBuffer = MS.prototype.addSourceBuffer;
  MS.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.call(this, mime);
    send({ type: 'track', id: idOf(sb), media: idOf(this), mime: String(mime) });
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    if (state !== 'off' && ids.has(this)) {
      try {
        const view = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        const copy = view.slice().buffer;
        send({ type: 'data', id: ids.get(this), data: copy }, [copy]);
      } catch {
        /* never get in the player's way */
      }
    }
    return appendBuffer.call(this, data);
  };

  // The player has appended everything: this video is complete.
  const endOfStream = MS.prototype.endOfStream;
  MS.prototype.endOfStream = function (error) {
    if (!error) send({ type: 'end', media: idOf(this) });
    return endOfStream.apply(this, arguments);
  };
})();
