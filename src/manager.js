const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const DEFAULT_SETTINGS = { autoTakeover: true, minSizeMB: 20, maxConnections: 6, maxActive: 3 };

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
document.documentElement.lang = chrome.i18n.getUILanguage();

const $ = (sel) => document.querySelector(sel);
const cards = new Map(); // task id -> card element
// Open manager.html?debug to see protocol and per-level measurements.
const DEBUG = new URLSearchParams(location.search).has('debug');

function engine(cmd, args = {}) {
  return chrome.runtime.sendMessage({ type: 'engine', cmd, ...args });
}

// ---- formatting --------------------------------------------------------------

function bytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${units[i]}`;
}
const speed = (n) => `${bytes(n || 0)}/s`;

function duration(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const STATUS = {
  queued: 'statusQueued',
  downloading: 'statusDownloading',
  paused: 'statusPaused',
  saving: 'statusSaving',
  completed: 'statusCompleted',
  error: 'statusError',
};
const ERRORS = {
  network: 'errNetwork',
  http: 'errHttp',
  'no-space': 'errNoSpace',
  save: 'errSave',
  'range-unsupported': 'errRangeUnsupported',
  engine: 'errEngine',
};

// ---- rendering ----------------------------------------------------------------

function render(tasks) {
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

function updateCard(card, task) {
  const name = task.filename || task.url;
  card.querySelector('.name').textContent = name;
  card.querySelector('.name').title = task.url;

  const status = card.querySelector('.status');
  status.dataset.s = task.status;
  status.textContent =
    task.status === 'error' && task.error
      ? `${t('statusError')}: ${t(ERRORS[task.error.code] || 'errEngine')}`
      : t(STATUS[task.status] || 'statusQueued');
  status.title = task.error?.message || '';

  drawBar(card.querySelector('.bar'), task);

  const parts = [];
  const done = task.status === 'completed' ? task.size : task.downloaded;
  parts.push(task.size ? `${bytes(done)} / ${bytes(task.size)}` : bytes(done));
  if (task.status === 'downloading') {
    parts.push(speed(task.speed));
    parts.push(task.connections === 1 ? t('oneConnection') : t('connections', [String(task.connections)]));
    if (task.size && task.speed > 0) parts.push(t('timeLeft', [duration((task.size - task.downloaded) / task.speed)]));
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
  if (task.status === 'downloading' || task.status === 'queued') wanted.push(['pause', 'pause'], ['cancel', 'cancel']);
  if (task.status === 'paused') wanted.push(['resume', 'resume'], ['cancel', 'cancel']);
  if (task.status === 'error') wanted.push(['retry', 'resume'], ['remove', 'remove']);
  if (task.status === 'completed') wanted.push(['showInFolder', 'show'], ['remove', 'remove']);
  const key = wanted.map((w) => w[0]).join();
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    ...wanted.map(([label, action]) => {
      const b = document.createElement('button');
      b.textContent = t(label);
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
  const h = 10;
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
    ctx.fillRect(0, 0, w, h);
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
  if (res?.tasks) render(res.tasks);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'engine-state') render(msg.tasks);
  return false;
});

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url').value.trim();
  const msg = $('#add-msg');
  if (!/^https?:\/\//i.test(url)) {
    msg.textContent = t('invalidUrl');
    msg.hidden = false;
    return;
  }
  msg.hidden = true;
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...settings };
  await engine('add', { url, source: 'manual', maxConnections: s.maxConnections, maxActive: s.maxActive });
  $('#url').value = '';
  refresh();
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
}

async function saveSettings() {
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const settings = {
    autoTakeover: $('#autoTakeover').checked,
    minSizeMB: clamp(Number($('#minSizeMB').value), 1, 100000, DEFAULT_SETTINGS.minSizeMB),
    maxConnections: clamp(Number($('#maxConnections').value), 1, 16, DEFAULT_SETTINGS.maxConnections),
    maxActive: clamp(Number($('#maxActive').value), 1, 10, DEFAULT_SETTINGS.maxActive),
  };
  await chrome.storage.local.set({ settings });
  await engine('set-limit', { maxActive: settings.maxActive });
}
for (const id of ['autoTakeover', 'minSizeMB', 'maxConnections', 'maxActive']) $('#' + id).addEventListener('change', saveSettings);

loadSettings().then(async () => {
  // Keep the engine's queue limit in step with the saved setting.
  await engine('set-limit', { maxActive: Number($('#maxActive').value) });
  refresh();
});
