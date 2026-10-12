import { CATEGORY_ORDER, categorize, parsePastedUrls } from './sniff.js';
import { ICONS } from './icons.js';
import { DEFAULT_RULES } from './media.js';
import { pickFilename, applyRename } from './http.js';
import { getFolder, setFolder, folderPermission } from './folder.js';
import { parseChecksum, ALGO_NAMES } from './hash.js';
import {
  t,
  DEFAULT_SETTINGS,
  MB,
  localize,
  engine,
  addUrls as addTasks,
  bytes,
  speed,
  duration,
  statusText,
} from './client.js';

localize();

const $ = (sel) => document.querySelector(sel);
const cards = new Map(); // task id -> card element
// Open manager.html?debug to see protocol and per-level measurements.
const DEBUG = new URLSearchParams(location.search).has('debug');

// ---- rendering ----------------------------------------------------------------

function render(tasks, speedLimit = 0) {
  renderTotal(tasks, speedLimit);
  const seen = new Set();
  const list = $('#tasks');
  tasks.forEach((task, i) => {
    seen.add(task.id);
    let card = cards.get(task.id);
    if (!card) {
      card = $('#task-tpl').content.firstElementChild.cloneNode(true);
      cards.set(task.id, card);
    }
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
    updateCard(card, task);
  });
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  $('#empty').hidden = tasks.length > 0;
}

// Combined speed of all running tasks, and the limit when one is set.
function renderTotal(tasks, speedLimit) {
  const running = tasks.filter((x) => x.status === 'downloading');
  const parts = [];
  if (running.length) parts.push(t('totalSpeed', [speed(running.reduce((sum, x) => sum + (x.speed || 0), 0))]));
  if (speedLimit > 0) parts.push(t('limitedTo', [speed(speedLimit)]));
  $('#total').textContent = parts.join(' · ');
}

function updateCard(card, task) {
  const name = task.filename || task.url;
  card.querySelector('.name').textContent = name;
  card.querySelector('.name').title = task.url;
  const kind = categorize(`https://x/${encodeURIComponent(name)}`);
  const ftype = card.querySelector('.ftype');
  if (ftype.dataset.kind !== kind) {
    ftype.dataset.kind = kind;
    ftype.innerHTML = ICONS[kind] || ICONS.other;
  }

  const status = card.querySelector('.status');
  status.dataset.s = task.status;
  status.textContent = statusText(task);
  status.title = task.error?.message || '';

  drawBar(card.querySelector('.bar'), task);

  const parts = [];
  const done = task.status === 'completed' ? task.size : task.downloaded;
  parts.push(task.size ? `${bytes(done)} / ${bytes(task.size)}` : bytes(done));
  // m3u8: how many of its pieces are in, and roughly how long is left.
  const hls = task.hls?.total && task.status !== 'completed' ? task.hls : null;
  if (hls) parts.push(t('pieces', [`${hls.done}/${hls.total}`]));
  if (task.status === 'downloading') {
    parts.push(speed(task.speed));
    parts.push(task.connections === 1 ? t('oneConnection') : t('connections', [String(task.connections)]));
    if (task.size && task.speed > 0) parts.push(t('timeLeft', [duration((task.size - task.downloaded) / task.speed)]));
    else if (hls?.done && task.speed > 0) {
      const estimate = (task.downloaded / hls.done) * hls.total;
      parts.push(t('timeLeft', [duration((estimate - task.downloaded) / task.speed)]));
    }
  }
  if (task.status === 'completed' && task.savedTo) parts.push(t('savedTo', [task.savedTo]));
  if (task.verified?.ok) parts.push(t('checksumOk', [ALGO_NAMES[task.verified.algo]]));
  else if (task.checksum && task.status !== 'completed' && task.status !== 'error') parts.push(t('checksumPending', [ALGO_NAMES[task.checksum]]));
  // Mirrors: how much came from each address.
  if (task.mirrors && task.status !== 'error') {
    parts.push(task.mirrors.map((m) => (m.bad ? t('mirrorUnusable', [m.host]) : `${m.host} ${bytes(m.bytes)}`)).join(', '));
  }
  card.querySelector('.meta').textContent = parts.join(' · ');

  card.querySelector('.compare').textContent = compareLine(task);
  renderActions(card.querySelector('.actions'), task);
}

// The average speed of a finished download (and debug details while running).
function compareLine(task) {
  if (task.rangeSupported === false) return t('noRange');
  const st = task.stats;
  if (!st?.activeMs) return '';
  if (task.status === 'downloading') return levelsLine(task);
  const avg = (task.status === 'completed' ? task.size : task.downloaded) / (st.activeMs / 1000);
  return task.status === 'completed' ? t('avgSpeed', [speed(avg)]) : '';
}

// The average speed seen at each connection count (debug view only).
function levelsLine(task) {
  if (!DEBUG) return '';
  const levels = Object.entries(task.stats?.levels || {}).sort((a, b) => a[0] - b[0]);
  const parts = [];
  const proto = { h2: 'HTTP/2', h3: 'HTTP/3', 'http/1.1': 'HTTP/1.1' }[task.protocol];
  if (proto) parts.push(proto);
  if (levels.length) parts.push(t('measured', [levels.map(([n, v]) => `${n}→${speed(v)}`).join('  ')]));
  return parts.join(' · ');
}

function renderActions(box, task) {
  const wanted = [];
  if (task.status === 'downloading' || task.status === 'queued') wanted.push(['pause', 'pause', 'pause'], ['cancel', 'cancel', 'close']);
  if (task.status === 'paused') wanted.push(['resume', 'resume', 'play'], ['cancel', 'cancel', 'close']);
  if (task.status === 'error') wanted.push(['retry', 'resume', 'retry'], ['remove', 'remove', 'trash']);
  // Files saved into the picked folder are not in the browser's download list.
  if (task.status === 'completed') wanted.push(...(task.savedTo ? [] : [['showInFolder', 'show', 'folder']]), ['remove', 'remove', 'trash']);
  const key = wanted.map((w) => w[0]).join();
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    ...wanted.map(([label, action, ic]) => {
      const b = document.createElement('button');
      b.innerHTML = ICONS[ic];
      b.append(t(label));
      b.onclick = () => act(action, task);
      return b;
    }),
  );
}

async function act(action, task) {
  if (action === 'show') {
    if (task.downloadId != null) chrome.downloads.show(task.downloadId);
    return;
  }
  await engine(action, { id: task.id });
  refresh();
}

function drawBar(canvas, task) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 8;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css.getPropertyValue('--track');
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = css.getPropertyValue(task.status === 'error' ? '--err' : '--accent');

  if (task.status === 'completed') {
    ctx.fillStyle = css.getPropertyValue('--ok');
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (task.hls?.total) {
    ctx.fillRect(0, 0, (w * task.hls.done) / task.hls.total, h);
    return;
  }
  const size = task.size;
  if (!size) {
    // Unknown length: nothing meaningful to draw per segment.
    return;
  }
  // Each segment is drawn as the bytes it has filled, so parallel connections
  // show up as several growing blocks.
  for (const s of task.segments || []) {
    const x = (s.start / size) * w;
    const fw = ((s.pos - s.start) / size) * w;
    ctx.fillRect(x, 0, Math.max(fw, 0), h);
  }
  ctx.fillStyle = css.getPropertyValue('--card');
  for (const s of task.segments || []) {
    if (s.start > 0) ctx.fillRect((s.start / size) * w - 0.5, 0, 1, h);
  }
}

// ---- data flow -------------------------------------------------------------------

async function refresh() {
  const res = await engine('list');
  if (res?.tasks) render(res.tasks, res.speedLimit);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'engine-state') render(msg.tasks, msg.speedLimit);
  return false;
});

async function addUrls(urls, extra = {}) {
  await addTasks(urls, extra);
  refresh();
}

function note(text) {
  const msg = $('#add-msg');
  msg.textContent = text || '';
  msg.hidden = !text;
}

// One link per line (or separated by spaces); every http(s) URL is added.
$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urls = parsePastedUrls($('#url').value);
  if (!urls.length) return note(t('invalidUrl'));
  // More options: a checksum to verify against, and mirrors (other
  // addresses of the same file). Both are about one file.
  const sum = $('#checksum').value.trim();
  const mirrors = parsePastedUrls($('#mirrors').value);
  const extra = {};
  if (sum || mirrors.length) {
    if (urls.length > 1) return note(t('moreOneFile'));
    if (sum) {
      extra.checksum = parseChecksum(sum);
      if (!extra.checksum) return note(t('badChecksum'));
    }
    extra.mirrors = mirrors;
  }
  await addUrls(urls, extra);
  $('#url').value = '';
  $('#checksum').value = '';
  $('#mirrors').value = '';
  $('#add-more').open = false;
  fitUrlBox();
  note(urls.length > 1 ? t('addedCount', [String(urls.length)]) : '');
});

// Enter adds, Shift+Enter starts a new line; the box grows with its content.
$('#url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#add').requestSubmit();
  }
});
function fitUrlBox() {
  const box = $('#url');
  box.rows = Math.min(8, Math.max(1, box.value.split('\n').length));
}
$('#url').addEventListener('input', fitUrlBox);

// ---- links sniffed from a page ------------------------------------------------------

const CATEGORY_KEYS = {
  video: 'catVideo',
  audio: 'catAudio',
  archive: 'catArchive',
  program: 'catProgram',
  disk: 'catDisk',
  document: 'catDocument',
  image: 'catImage',
  stream: 'catStream',
  other: 'catOther',
};
// Pictures and plain web pages are on almost every page; they start hidden.
const HIDDEN_BY_DEFAULT = new Set(['image', 'other']);
const sniff = { pageUrl: null, title: '', links: [], cats: new Set(), checked: new Set() };
const PREVIEWABLE = new Set(['video', 'audio', 'image']);

async function openSniff() {
  const { sniff: data } = await chrome.storage.session.get('sniff');
  if (!data) return;
  sniff.pageUrl = data.pageUrl;
  sniff.title = data.title || '';
  sniff.links = data.links || [];
  // Thumbnails and previews need the page's Referer on hotlink-protected sites.
  const media = sniff.links.filter((l) => PREVIEWABLE.has(l.category)).map((l) => l.url);
  if (media.length && sniff.pageUrl) {
    await chrome.runtime
      .sendMessage({ type: 'request-headers', id: 'manager-sniff', urls: media, referrer: sniff.pageUrl, pages: true })
      .catch(() => {});
  }
  const present = new Set(sniff.links.map((l) => l.category));
  sniff.cats = new Set([...present].filter((c) => !HIDDEN_BY_DEFAULT.has(c)));
  if (!sniff.cats.size) sniff.cats = present;
  sniff.checked = new Set(sniff.links.filter((l) => !HIDDEN_BY_DEFAULT.has(l.category)).map((l) => l.url));
  let host = data.pageUrl;
  try {
    host = new URL(data.pageUrl).host;
  } catch {}
  $('#sniff-source').textContent = t('sniffFrom', [data.title || host, String(sniff.links.length)]);
  $('#sniff-source').title = data.pageUrl || '';
  $('#sniff-search').value = '';
  $('#sniff-rename').value = '';
  renderFilters();
  renderSniff();
  $('#sniff').hidden = false;
}

function closeSniff() {
  $('#sniff').hidden = true;
  closePreview();
  chrome.storage.session.remove('sniff');
  chrome.runtime.sendMessage({ type: 'clear-request-headers', id: 'manager-sniff' }).catch(() => {});
  history.replaceState(null, '', location.pathname + (DEBUG ? '?debug' : ''));
}

function renderFilters() {
  const counts = {};
  for (const l of sniff.links) counts[l.category] = (counts[l.category] || 0) + 1;
  $('#sniff-filters').replaceChildren(
    ...CATEGORY_ORDER.filter((c) => counts[c]).map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.cat = c;
      b.textContent = `${t(CATEGORY_KEYS[c])} ${counts[c]}`;
      b.setAttribute('aria-pressed', String(sniff.cats.has(c)));
      b.onclick = () => {
        if (sniff.cats.has(c)) sniff.cats.delete(c);
        else sniff.cats.add(c);
        b.setAttribute('aria-pressed', String(sniff.cats.has(c)));
        renderSniff();
      };
      return b;
    }),
  );
}

function visibleLinks() {
  const q = $('#sniff-search').value.trim().toLowerCase();
  return sniff.links.filter(
    (l) => sniff.cats.has(l.category) && (!q || l.url.toLowerCase().includes(q) || l.text.toLowerCase().includes(q)),
  );
}

function linkName(l) {
  try {
    const last = decodeURIComponent(new URL(l.url).pathname.split('/').pop() || '');
    if (last && l.category !== 'other') return last;
  } catch {}
  return l.text || l.url;
}

function readableUrl(u) {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
}

function renderSniff() {
  const shown = visibleLinks();
  $('#sniff-list').replaceChildren(
    ...shown.map((l) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = sniff.checked.has(l.url);
      box.onchange = () => {
        if (box.checked) sniff.checked.add(l.url);
        else sniff.checked.delete(l.url);
        updateSniffCount();
      };
      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = linkName(l);
      name.title = l.text || '';
      const url = document.createElement('span');
      url.className = 'lurl';
      url.textContent = readableUrl(l.url).replace(/^https?:\/\//, '');
      url.title = l.url;
      label.append(box);
      if (l.category === 'image') {
        const img = document.createElement('img');
        img.className = 'lthumb';
        img.loading = 'lazy';
        img.alt = '';
        img.src = l.url;
        label.append(img);
      }
      label.append(name);
      if (l.size) {
        const size = document.createElement('span');
        size.className = 'lsize';
        size.textContent = bytes(l.size);
        label.append(size);
      }
      label.append(url);
      li.append(label);
      if (PREVIEWABLE.has(l.category)) {
        const pv = document.createElement('button');
        pv.type = 'button';
        pv.className = 'icon lpreview';
        pv.title = t('preview');
        pv.innerHTML = ICONS.play;
        pv.onclick = () => openPreview(l);
        li.append(pv);
      }
      return li;
    }),
  );
  $('#sniff-empty').hidden = shown.length > 0;
  updateSniffCount();
}

function selectedLinks() {
  return visibleLinks().filter((l) => sniff.checked.has(l.url));
}

function updateSniffCount() {
  const shown = visibleLinks();
  const n = selectedLinks().length;
  $('#sniff-go').textContent = t('downloadSelected', [String(n)]);
  $('#sniff-go').disabled = n === 0;
  $('#sniff-copy').disabled = n === 0;
  renderRenamePreview();
  $('#sniff-all').checked = shown.length > 0 && n === shown.length;
  $('#sniff-all').indeterminate = n > 0 && n < shown.length;
}

$('#sniff-all').addEventListener('change', (e) => {
  for (const l of visibleLinks()) {
    if (e.target.checked) sniff.checked.add(l.url);
    else sniff.checked.delete(l.url);
  }
  renderSniff();
});
$('#sniff-search').addEventListener('input', renderSniff);
$('#sniff-close').addEventListener('click', closeSniff);
// ---- batch rename and copy ------------------------------------------------------

function renameRule(n, total) {
  const pattern = $('#sniff-rename').value.trim();
  if (!pattern) return null;
  let host = '';
  try {
    host = new URL(sniff.pageUrl).host;
  } catch {}
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return { pattern, n, total, title: sniff.title, host, date };
}

// New names for the first few picked files. The real extension comes from
// the server, so the download may differ when the address has none.
function renderRenamePreview() {
  const files = selectedLinks().filter((l) => l.category !== 'stream');
  const out = $('#sniff-rename-preview');
  if (!$('#sniff-rename').value.trim() || !files.length) return (out.textContent = '');
  const names = files.slice(0, 3).map((l, i) => applyRename(pickFilename({ url: l.url }), renameRule(i + 1, files.length)));
  out.textContent = `${t('renameExample')} ${names.join(' / ')}${files.length > 3 ? ' …' : ''}`;
}
$('#sniff-rename').addEventListener('input', renderRenamePreview);

$('#sniff-copy').innerHTML = ICONS.copy;
$('#sniff-copy').append(t('copyLinks'));
$('#sniff-copy').addEventListener('click', async () => {
  const urls = selectedLinks().map((l) => l.url);
  await navigator.clipboard.writeText(urls.join('\n'));
  note(t('copiedCount', [String(urls.length)]));
});

$('#sniff-go').addEventListener('click', async () => {
  const picked = selectedLinks();
  if (!picked.length) return;
  // Sent with the page as Referer, as a click on the page would.
  const files = picked.filter((l) => l.category !== 'stream').map((l) => l.url);
  for (const [i, url] of files.entries()) {
    await addUrls([url], { source: 'sniff', referrer: sniff.pageUrl, rename: renameRule(i + 1, files.length) });
  }
  // m3u8: download the pieces (best quality) and join them, named after the page.
  for (const l of picked.filter((x) => x.category === 'stream')) {
    await addUrls([l.url], { kind: 'hls', filename: sniff.title || undefined, source: 'sniff', referrer: sniff.pageUrl });
  }
  closeSniff();
  note(t('addedCount', [String(picked.length)]));
});

// ---- preview of a sniffed image, audio or video -----------------------------

function openPreview(l) {
  const box = $('#sniff-preview');
  const el = document.createElement(l.category === 'image' ? 'img' : l.category);
  if (l.category !== 'image') {
    el.controls = true;
    el.autoplay = true;
  }
  el.src = l.url;
  el.onerror = () => ($('#sp-info').textContent = t('previewFailed'));
  const info = () => {
    const parts = [];
    if (el.naturalWidth) parts.push(`${el.naturalWidth}×${el.naturalHeight}`);
    if (Number.isFinite(el.duration)) parts.push(duration(el.duration));
    if (el.videoWidth) parts.push(`${el.videoWidth}×${el.videoHeight}`);
    if (l.size) parts.push(bytes(l.size));
    $('#sp-info').textContent = parts.join(' · ');
  };
  el.onload = info;
  el.onloadedmetadata = info;
  $('#sp-stage').replaceChildren(el);
  $('#sp-name').textContent = linkName(l);
  $('#sp-info').textContent = l.size ? bytes(l.size) : '';
  box.hidden = false;
}

function closePreview() {
  $('#sp-stage').querySelector('video, audio')?.pause();
  $('#sp-stage').replaceChildren();
  $('#sniff-preview').hidden = true;
}
$('#sp-close').addEventListener('click', closePreview);
$('#sniff-preview').addEventListener('click', (e) => {
  if (e.target.id === 'sniff-preview') closePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sniff-preview').hidden) closePreview();
});

$('#clear').addEventListener('click', async () => {
  await engine('clear-finished');
  refresh();
});

// ---- settings ----------------------------------------------------------------------

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...settings };
  $('#autoTakeover').checked = s.autoTakeover;
  $('#minSizeMB').value = s.minSizeMB;
  $('#maxConnections').value = s.maxConnections;
  $('#maxActive').value = s.maxActive;
  $('#speedLimitMB').value = s.speedLimitMB || '';
  const rules = { ...DEFAULT_RULES, ...s.sniffRules };
  for (const k of ['video', 'audio', 'image', 'ignore']) $(`#rule-${k}`).value = rules[k];
  $('#rule-minImageKB').value = rules.minImageKB;
}

async function saveSettings() {
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const settings = {
    autoTakeover: $('#autoTakeover').checked,
    minSizeMB: clamp(Number($('#minSizeMB').value), 1, 100000, DEFAULT_SETTINGS.minSizeMB),
    maxConnections: clamp(Number($('#maxConnections').value), 1, 16, DEFAULT_SETTINGS.maxConnections),
    maxActive: clamp(Number($('#maxActive').value), 1, 10, DEFAULT_SETTINGS.maxActive),
    // Empty or 0 means no limit; tenths of a MB/s are allowed.
    speedLimitMB: Math.min(100000, Math.max(0, Math.round(Number($('#speedLimitMB').value) * 10) / 10 || 0)),
    sniffRules: {
      video: $('#rule-video').value.trim(),
      audio: $('#rule-audio').value.trim(),
      image: $('#rule-image').value.trim(),
      minImageKB: clamp(Number($('#rule-minImageKB').value), 0, 100000, DEFAULT_RULES.minImageKB),
      ignore: $('#rule-ignore').value.trim(),
    },
  };
  await chrome.storage.local.set({ settings });
  await engine('set-limit', { maxActive: settings.maxActive, speedLimit: settings.speedLimitMB * MB });
  refresh();
}
// ---- download folder ---------------------------------------------------------------

async function showFolder() {
  const dir = await getFolder().catch(() => null);
  const perm = dir ? await folderPermission(dir) : null;
  $('#folder-name').textContent = dir ? dir.name : t('folderDefault');
  $('#folder-reset').hidden = !dir;
  $('#folder-grant').hidden = !dir || perm === 'granted';
  $('#folder-hint').textContent = t(!dir ? 'folderHintDefault' : perm === 'granted' ? 'folderHintOn' : 'folderHintGrant');
  // The browser asks again after a restart: make that hard to miss.
  if (dir && perm !== 'granted') $('#settings').open = true;
}

$('#folder-choose').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) return note(t('folderUnsupported'));
  // Chrome refuses the Downloads, Desktop and Documents folders themselves
  // ("contains system files"), but not the folders inside them.
  $('#folder-hint').textContent = t('folderPickSub');
  try {
    const dir = await window.showDirectoryPicker({ id: 'downloads', mode: 'readwrite', startIn: 'downloads' });
    await setFolder(dir);
  } catch (err) {
    if (err?.name === 'AbortError') return; // keep the hint up: likely refused
    note(String(err?.message || err));
  }
  showFolder();
});
$('#folder-grant').addEventListener('click', async () => {
  const dir = await getFolder();
  await dir?.requestPermission({ mode: 'readwrite' }).catch(() => {});
  showFolder();
});
$('#folder-reset').addEventListener('click', async () => {
  await setFolder(null);
  showFolder();
});
showFolder();

for (const id of ['autoTakeover', 'minSizeMB', 'maxConnections', 'maxActive', 'speedLimitMB']) $('#' + id).addEventListener('change', saveSettings);
for (const el of document.querySelectorAll('#settings .rule, #rule-minImageKB')) el.addEventListener('change', saveSettings);

loadSettings().then(async () => {
  // Keep the engine's queue limit in step with the saved setting.
  await engine('set-limit', {
    maxActive: Number($('#maxActive').value),
    speedLimit: (Number($('#speedLimitMB').value) || 0) * MB,
  });
  refresh();
  document.body.dataset.synced = '1'; // tests wait for this before changing limits
});
if (new URLSearchParams(location.search).has('sniff')) openSniff();
