// Runs a script in every task worker the extension's offscreen document
// starts, as soon as it runs, through the DevTools protocol (the
// offscreen document is not a Playwright page). Used to make writes into
// the download folder fail on purpose.
export async function hookWorkers(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const off = targetInfos.find((t) => t.url.endsWith('offscreen.html'));
  const { sessionId: offSession } = await cdp.send('Target.attachToTarget', { targetId: off.targetId, flatten: false });
  let id = 1000;
  let source = '';
  const replies = new Map(); // worker request id -> resolve
  const toOff = (method, params) => cdp.send('Target.sendMessageToTarget', { sessionId: offSession, message: JSON.stringify({ id: id++, method, params }) });
  const toWorker = (ws, method, params) => {
    const n = id++;
    toOff('Target.sendMessageToTarget', { sessionId: ws, message: JSON.stringify({ id: n, method, params }) });
    return new Promise((resolve) => replies.set(n, resolve));
  };
  cdp.on('Target.receivedMessageFromTarget', async (e) => {
    if (e.sessionId !== offSession) return;
    const msg = JSON.parse(e.message);
    if (msg.method === 'Target.receivedMessageFromTarget') {
      const reply = JSON.parse(msg.params.message);
      replies.get(reply.id)?.(reply);
      replies.delete(reply.id);
      return;
    }
    if (msg.method !== 'Target.attachedToTarget' || msg.params.targetInfo.type !== 'worker') return;
    const ws = msg.params.sessionId;
    const script = source;
    await toWorker(ws, 'Runtime.runIfWaitingForDebugger', {});
    // The worker's globals appear a moment after it starts; until then the
    // script fails. The worker fetches before it writes anything, so this
    // is early enough.
    for (let tries = 0; script && tries < 100; tries++) {
      const r = await toWorker(ws, 'Runtime.evaluate', { expression: script });
      if (!r.result?.exceptionDetails) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  await toOff('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  // Workers started from now on run `next` ('' for none).
  return (next) => {
    source = next;
  };
}
