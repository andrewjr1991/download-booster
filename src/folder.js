// The folder the user picked for downloads (File System Access). Files are
// written straight into it while they download, instead of into the
// browser's own storage and then copied to the Downloads folder, so a big
// file only takes its own size on disk once. Directory handles can't go in
// chrome.storage, so a small IndexedDB keeps it.

const DB_NAME = 'download-folder';
const STORE = 'kv';

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const getFolder = () => run('readonly', (s) => s.get('dir')).then((h) => h || null);
export const setFolder = (handle) => run('readwrite', (s) => (handle ? s.put(handle, 'dir') : s.delete('dir')));

// 'granted', 'prompt' (needs a click in the manager) or 'denied'.
export async function folderPermission(handle) {
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// "name.ext", or "name (1).ext" and so on if that is taken, like the
// browser's own downloads.
// `suffix` names a companion that must be free too ("name.ext.part").
export async function uniqueName(dir, name, suffix = '') {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 0; i < 10000; i++) {
    const next = i ? `${stem} (${i})${ext}` : name;
    if (!(await exists(dir, next)) && !(suffix && (await exists(dir, next + suffix)))) return next;
  }
  return `${stem} (${Date.now()})${ext}`;
}

// Give a finished file its final name in the folder (it was "<name>.part"
// while downloading). Returns the name it got.
export async function finalize(dir, part, name) {
  const fh = await dir.getFileHandle(part);
  const target = await uniqueName(dir, name);
  if (typeof fh.move === 'function') {
    try {
      await fh.move(target);
      return target;
    } catch {
      /* fall back to copying */
    }
  }
  await copyInto(dir, target, await fh.getFile());
  await dir.removeEntry(part).catch(() => {});
  return target;
}

// Write a Blob (a finished file in the browser's storage) into the folder.
export async function copyInto(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const ws = await fh.createWritable();
  await blob.stream().pipeTo(ws);
  return name;
}
