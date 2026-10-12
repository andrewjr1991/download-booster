import { CATEGORY_ORDER, categorize, parsePastedUrls } from './sniff.js';
import { ICONS } from './icons.js';
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
  card.querySelector('.meta').textContent = parts.join(' · ');

  card.querySelector('.compare').textContent = compareLine(task);
  renderActions(card.querySelector('.actions'), task);
}

// The built-in speed comparison: what one connection achieved during the
// first measurement window versus the average over the whole download.
function compareLine(task) {
  if (task.rangeSupported === false) return t('noRange');
  const st = task.stats;
  if (!st?.activeMs) return '';
  if (task.status === 'downloading') return levelsLine(task);
  const avg = (task.status === 'completed' ? task.size : task.downloaded) / (st.activeMs / 1000);
  if (st.singleSpeed > 0 && task.status !== 'downloading') {
    const levels = levelsLine(task);
    const cmp = t('speedCompare', [speed(st.singleSpeed), speed(avg), (avg / st.singleSpeed).toFixed(1)]);
    return levels ? `${cmp} · ${levels}` : cmp;
  }
  return task.status === 'completed' ? t('avgSpeed', [speed(avg)]) : '';
}

// What the adaptive controller measured at each connection count (debug
// view only), to see why it settled where it did.
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
  if (task.status === 'completed') wanted.push(['showInFolder', 'show', 'folder'], ['remove', 'remove', 'trash']);
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
  await addUrls(urls);
  $('#url').value = '';
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
  other: 'catOther',
};
// Pictures and plain web pages are on almost every page; they start hidden.
const HIDDEN_BY_DEFAULT = new Set(['image', 'other']);
const sniff = { pageUrl: null, links: [], cats: new Set(), checked: new Set() };

async function openSniff() {
  const { sniff: data } = await chrome.storage.session.get('sniff');
  if (!data) return;
  sniff.pageUrl = data.pageUrl;
  sniff.links = data.links || [];
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
  renderFilters();
  renderSniff();
  $('#sniff').hidden = false;
}

function closeSniff() {
  $('#sniff').hidden = true;
  chrome.storage.session.remove('sniff');
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
      label.append(box, name, url);
      li.append(label);
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
$('#sniff-go').addEventListener('click', async () => {
  const urls = selectedLinks().map((l) => l.url);
  if (!urls.length) return;
  // Sent with the page as Referer, as a click on the page would.
  await addUrls(urls, { source: 'sniff', referrer: sniff.pageUrl });
  closeSniff();
  note(t('addedCount', [String(urls.length)]));
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
  };
  await chrome.storage.local.set({ settings });
  await engine('set-limit', { maxActive: settings.maxActive, speedLimit: settings.speedLimitMB * MB });
  refresh();
}
for (const id of ['autoTakeover', 'minSizeMB', 'maxConnections', 'maxActive', 'speedLimitMB']) $('#' + id).addEventListener('change', saveSettings);

loadSettings().then(async () => {
  // Keep the engine's queue limit in step with the saved setting.
  await engine('set-limit', {
    maxActive: Number($('#maxActive').value),
    speedLimit: (Number($('#speedLimitMB').value) || 0) * MB,
  });
  refresh();
});
if (new URLSearchParams(location.search).has('sniff')) openSniff();
