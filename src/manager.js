import { CATEGORY_ORDER, parsePastedUrls, PATTERN_MAX } from './sniff.js';
import { DIR_KEYS } from './subfolders.js';
import { ICONS } from './icons.js';
import { DEFAULT_RULES } from './media.js';
import { pickFilename, applyRename } from './http.js';
import { getFolder, setFolder, folderPermission } from './folder.js';
import { parseChecksum, ALGO_NAMES } from './hash.js';
import { TASK_GROUPS, taskGroup, taskKind, matchTask } from './tasks-filter.js';
import {
  t,
  DEFAULT_SETTINGS,
  MB,
  localize,
  engine,
  addUrls as addTasks,
  getSettings,
  subfoldersOf,
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

let lastTasks = [];
let lastLimit = 0;
// What the list shows: a state or a file type from the sidebar, a search,
// and the order. `page` is the list or the settings.
const view = { group: 'all', kind: null, q: '', sort: 'date', dir: 'desc', page: 'list' };
const picked = new Set(); // ids of ticked rows

const GROUP_KEYS = { all: 'navAll', active: 'navActive', completed: 'navCompleted', error: 'navFailed' };
const GROUP_ICONS = { all: 'list', active: 'download', completed: 'check', error: 'alert' };

function render(tasks = lastTasks, speedLimit = lastLimit) {
  lastTasks = tasks;
  lastLimit = speedLimit;
  for (const id of picked) if (!tasks.some((x) => x.id === id)) picked.delete(id);
  renderNav(tasks);
  renderStatus(tasks, speedLimit);
  const shown = sortTasks(tasks.filter((task) => matchTask(task, view)));
  const seen = new Set();
  const list = $('#tasks');
  shown.forEach((task, i) => {
    seen.add(task.id);
    let card = cards.get(task.id);
    if (!card) {
      card = makeCard();
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
  $('#no-match').hidden = !tasks.length || shown.length > 0;
  renderBulk(shown);
}

function sortTasks(tasks) {
  const key = {
    name: (x) => (x.filename || x.url || '').toLowerCase(),
    size: (x) => x.size || x.downloaded || 0,
    date: (x) => x.createdAt || 0,
  }[view.sort];
  const sign = view.dir === 'asc' ? 1 : -1;
  return tasks.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return sign * (typeof ka === 'string' ? ka.localeCompare(kb) : ka - kb);
  });
}

// The sidebar: states with counts, then the file types present.
function renderNav(tasks) {
  const counts = { all: tasks.length, active: 0, completed: 0, error: 0 };
  const kinds = {};
  for (const task of tasks) {
    counts[taskGroup(task)]++;
    const k = taskKind(task);
    kinds[k] = (kinds[k] || 0) + 1;
  }
  // Nothing left of the picked type: show everything again.
  if (view.kind && !kinds[view.kind]) view.kind = null;
  const onList = view.page === 'list';
  navRow(
    $('#task-groups'),
    TASK_GROUPS.map((g) => [g, GROUP_ICONS[g], t(GROUP_KEYS[g]), counts[g], onList && !view.kind && view.group === g]),
    (g) => setView({ group: g, kind: null }),
  );
  const present = CATEGORY_ORDER.filter((c) => kinds[c]);
  navRow(
    $('#task-kinds'),
    present.map((k) => [k, k, t(CATEGORY_KEYS[k]), kinds[k], onList && view.kind === k]),
    (k) => setView({ group: 'all', kind: k }),
  );
  $('#kinds-title').hidden = !present.length;
  $('#nav-settings').setAttribute('aria-pressed', String(!onList));
  $('#view-title').textContent = !onList ? t('settings') : view.kind ? t(CATEGORY_KEYS[view.kind]) : t(GROUP_KEYS[view.group]);
}

// Rebuilt only when a label, count or the pressed entry changes, so a click
// is not lost to a re-render in between.
function navRow(box, items, pick) {
  const key = JSON.stringify(items);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(
    ...items.map(([value, ic, label, count, pressed]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = value;
      b.setAttribute('aria-pressed', String(pressed));
      b.innerHTML = ICONS[ic] || ICONS.other;
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = label;
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = count;
      b.append(l, c);
      b.onclick = () => pick(value);
      return b;
    }),
  );
}

function setView(changes) {
  Object.assign(view, changes, { page: 'list' });
  showPage();
  render();
}

function showPage() {
  const list = view.page === 'list';
  $('#list-view').hidden = !list;
  $('#settings').hidden = list;
  $('#list-tools').hidden = !list;
  $('.search').hidden = !list;
  $('.content').scrollTop = 0;
}

// Combined speed of all running tasks, the limit when one is set, and counts.
function renderStatus(tasks, speedLimit) {
  const running = tasks.filter((x) => x.status === 'downloading');
  const parts = [];
  if (running.length) parts.push(t('totalSpeed', [speed(running.reduce((sum, x) => sum + (x.speed || 0), 0))]));
  if (speedLimit > 0) parts.push(t('limitedTo', [speed(speedLimit)]));
  $('#total').textContent = parts.join(' · ');
  const active = tasks.filter((x) => taskGroup(x) === 'active').length;
  const done = tasks.filter((x) => x.status === 'completed').length;
  $('#counts').textContent = tasks.length ? t('statusCounts', [String(active), String(done), String(tasks.length)]) : '';
}

function makeCard() {
  const card = $('#task-tpl').content.firstElementChild.cloneNode(true);
  card.querySelector('.pick').onchange = (e) => {
    if (e.target.checked) picked.add(card.dataset.id);
    else picked.delete(card.dataset.id);
    render();
  };
  card.ondblclick = (e) => {
    if (e.target.closest('button, input')) return;
    const task = lastTasks.find((x) => x.id === card.dataset.id);
    if (task?.status === 'completed' && task.downloadId != null && !task.savedTo) openFile(task);
  };
  card.oncontextmenu = (e) => {
    const task = lastTasks.find((x) => x.id === card.dataset.id);
    if (!task) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, task);
  };
  return card;
}

function updateCard(card, task) {
  card.dataset.id = task.id;
  card.classList.toggle('picked', picked.has(task.id));
  card.querySelector('.pick').checked = picked.has(task.id);
  const name = task.filename || task.url;
  card.querySelector('.name').textContent = name;
  card.querySelector('.name').title = task.url;
  const kind = taskKind(task);
  const ftype = card.querySelector('.ftype');
  if (ftype.dataset.kind !== kind) {
    ftype.dataset.kind = kind;
    ftype.innerHTML = ICONS[kind] || ICONS.other;
  }

  const done = task.status === 'completed' ? task.size : task.downloaded;
  card.querySelector('.size').textContent = task.size ? bytes(task.size) : done ? bytes(done) : '—';

  const status = card.querySelector('.status');
  status.dataset.s = task.status;
  const pct = task.status === 'downloading' && !task.verifying ? percent(task) : null;
  status.textContent = pct == null ? statusText(task) : `${statusText(task)} ${pct}%`;
  status.title = task.error?.message || statusText(task);
  drawBar(card.querySelector('.bar'), task);

  // Speed, and below it the time left.
  const sp = card.querySelector('.speed');
  if (task.status === 'downloading') {
    const left = timeLeft(task);
    const small = document.createElement('small');
    small.textContent = left ? t('timeLeft', [left]) : '';
    sp.replaceChildren(speed(task.speed), small);
  } else sp.textContent = task.status === 'completed' ? '' : '—';

  card.querySelector('.date').textContent = when(task.createdAt);
  card.querySelector('.date').title = task.createdAt ? new Date(task.createdAt).toLocaleString() : '';
  card.querySelector('.meta').textContent = metaLine(task);
  card.querySelector('.compare').textContent = compareLine(task);
  renderActions(card.querySelector('.actions'), task);
}

function percent(task) {
  if (task.size) return Math.min(99, Math.floor((task.downloaded / task.size) * 100));
  if (task.hls?.total) return Math.min(99, Math.floor((task.hls.done / task.hls.total) * 100));
  return null;
}

function timeLeft(task) {
  if (!(task.speed > 0)) return '';
  if (task.size) return duration((task.size - task.downloaded) / task.speed);
  // m3u8: estimated from the pieces done so far.
  if (task.hls?.done) return duration(((task.downloaded / task.hls.done) * task.hls.total - task.downloaded) / task.speed);
  return '';
}

// "14:05" today, otherwise the date.
function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

// Where it is from, and what is going on with it.
function metaLine(task) {
  const parts = [];
  try {
    parts.push(new URL(task.url).host);
  } catch {}
  if (task.status === 'downloading' || task.status === 'paused') parts.push(task.size ? `${bytes(task.downloaded)} / ${bytes(task.size)}` : bytes(task.downloaded));
  // m3u8: how many of its pieces are in.
  if (task.hls?.total && task.status !== 'completed') parts.push(t('pieces', [`${task.hls.done}/${task.hls.total}`]));
  if (task.status === 'downloading') parts.push(task.connections === 1 ? t('oneConnection') : t('connections', [String(task.connections)]));
  if (task.status === 'completed' && task.savedTo) parts.push(t('savedTo', [task.savedTo]));
  if (task.verified?.ok) parts.push(t('checksumOk', [ALGO_NAMES[task.verified.algo]]));
  else if (task.checksum && task.status !== 'completed' && task.status !== 'error') parts.push(t('checksumPending', [ALGO_NAMES[task.checksum]]));
  // Mirrors: how much came from each address.
  if (task.mirrors && task.status !== 'error') {
    parts.push(task.mirrors.map((m) => (m.bad ? t('mirrorUnusable', [m.host]) : `${m.host} ${bytes(m.bytes)}`)).join(', '));
  }
  return parts.join(' · ');
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

// What can be done with a task: [label key, action, icon], the main one first.
function actionsFor(task) {
  const out = [];
  const s = task.status;
  if (s === 'downloading' || s === 'queued') out.push(['pause', 'pause', 'pause']);
  if (s === 'paused') out.push(['resume', 'resume', 'play']);
  if (s === 'error') out.push(['retry', 'resume', 'retry']);
  // Files saved into the picked folder are not in the browser's download
  // list, so the browser cannot open or show them.
  const inBrowser = s === 'completed' && !task.savedTo && task.downloadId != null;
  if (inBrowser) out.push(['openFile', 'open', 'open'], ['showInFolder', 'show', 'folder']);
  // A recording's address is the page, not a file.
  if (task.kind !== 'record' && /^https?:/i.test(task.url || '')) out.push(['copyLink', 'copy', 'link']);
  if (s === 'completed' && task.kind !== 'record') out.push(['redownload', 'redownload', 'retry']);
  if (s === 'completed' || s === 'error') out.push(['remove', 'remove', 'trash']);
  else out.push(['cancel', 'cancel', 'close']);
  return out;
}

// Icon buttons; the first one always shows, the rest when pointed at.
function renderActions(box, task) {
  const wanted = actionsFor(task);
  const key = wanted.map((w) => w[1]).join();
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  // The main one last, so it stays in the same place on every row.
  box.replaceChildren(
    ...wanted.map(([label, action, ic], i) => [label, action, ic, i]).slice(1).concat([[...wanted[0], 0]]).map(([label, action, ic, i]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = action;
      b.className = i === 0 ? 'main-action' : 'more';
      b.innerHTML = ICONS[ic];
      b.title = t(label);
      b.setAttribute('aria-label', t(label));
      b.onclick = () => act(action, lastTasks.find((x) => x.id === task.id) || task);
      return b;
    }),
  );
}

// ---- right-click menu -------------------------------------------------------------

function openMenu(x, y, task) {
  const menu = $('#menu');
  const many = picked.has(task.id) && picked.size > 1;
  const items = many
    ? BULK.filter(([action]) => action !== 'none').map(([action, label, ic]) => [t(label), ic, () => bulk(action)])
    : actionsFor(task).map(([label, action, ic]) => [t(label), ic, () => act(action, task)]);
  if (!many) items.push(null, [t(picked.has(task.id) ? 'unpick' : 'pick'), 'check', () => togglePick(task.id)]);
  menu.replaceChildren(
    ...items.map((it) => {
      if (!it) return document.createElement('hr');
      const [label, ic, run] = it;
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = ICONS[ic] || '';
      b.append(label);
      b.onclick = () => {
        closeMenu();
        run();
      };
      return b;
    }),
  );
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector('button')?.focus();
}
function closeMenu() {
  $('#menu').hidden = true;
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);
$('.content').addEventListener('scroll', closeMenu);

function togglePick(id) {
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  render();
}

// ---- several at once ------------------------------------------------------------

// [action, label key, icon]
const BULK = [
  ['pause', 'bulkPause', 'pause'],
  ['resume', 'bulkResume', 'play'],
  ['copy', 'bulkCopy', 'link'],
  ['remove', 'bulkRemove', 'trash'],
  ['none', 'bulkNone', 'close'],
];

function renderBulk(shown) {
  $('#bulk').hidden = !picked.size;
  $('#bulk-count').textContent = t('pickedCount', [String(picked.size)]);
  const all = $('#select-all');
  const n = shown.filter((x) => picked.has(x.id)).length;
  all.checked = shown.length > 0 && n === shown.length;
  all.indeterminate = n > 0 && n < shown.length;
}
for (const b of document.querySelectorAll('#bulk [data-bulk]')) {
  const [, label, ic] = BULK.find((x) => x[0] === b.dataset.bulk);
  b.innerHTML = ICONS[ic];
  b.append(t(label));
  b.onclick = () => bulk(b.dataset.bulk);
}
$('#select-all').addEventListener('change', (e) => {
  const shown = lastTasks.filter((task) => matchTask(task, view));
  for (const x of shown) {
    if (e.target.checked) picked.add(x.id);
    else picked.delete(x.id);
  }
  render();
});

async function bulk(action, tasks = lastTasks.filter((x) => picked.has(x.id))) {
  if (action === 'none') {
    picked.clear();
    return render();
  }
  if (action === 'copy') {
    const urls = tasks.filter((x) => x.kind !== 'record' && /^https?:/i.test(x.url)).map((x) => x.url);
    await navigator.clipboard.writeText(urls.join('\n'));
    return note(t('copiedCount', [String(urls.length)]));
  }
  if (action === 'remove') {
    // Unfinished downloads lose what they have: check first.
    const unfinished = tasks.filter((x) => x.status !== 'completed').length;
    if (unfinished && !confirm(t('confirmRemove', [String(unfinished)]))) return;
    for (const x of tasks) await engine('remove', { id: x.id });
    picked.clear();
    return refresh();
  }
  for (const x of tasks) {
    if (action === 'pause' && (x.status === 'downloading' || x.status === 'queued')) await engine('pause', { id: x.id });
    if (action === 'resume' && (x.status === 'paused' || x.status === 'error')) await engine('resume', { id: x.id });
  }
  refresh();
}

$('#pause-all').innerHTML = ICONS.pause;
$('#pause-all').addEventListener('click', () => bulk('pause', lastTasks));
$('#resume-all').innerHTML = ICONS.play;
$('#resume-all').addEventListener('click', () => bulk('resume', lastTasks));

// Column headers sort; a second click turns the order around.
for (const b of document.querySelectorAll('#thead [data-sort]')) {
  b.addEventListener('click', () => {
    const k = b.dataset.sort;
    view.dir = view.sort === k ? (view.dir === 'asc' ? 'desc' : 'asc') : k === 'name' ? 'asc' : 'desc';
    view.sort = k;
    showSort();
    render();
  });
}
function showSort() {
  for (const b of document.querySelectorAll('#thead [data-sort]')) {
    if (b.dataset.sort === view.sort) b.dataset.dir = view.dir;
    else delete b.dataset.dir;
  }
}
showSort();

$('#task-search').addEventListener('input', (e) => {
  view.q = e.target.value;
  render();
});

$('#new-download').innerHTML = ICONS.plus;
$('#new-download').append(t('newDownload'));
$('#new-download').addEventListener('click', () => {
  setView({});
  $('#url').focus();
});
$('#nav-settings').innerHTML = ICONS.gear;
$('#nav-settings').append(Object.assign(document.createElement('span'), { className: 'label', textContent: t('settings') }));
$('#nav-settings').addEventListener('click', () => {
  view.page = 'settings';
  showPage();
  render();
});

async function act(action, task) {
  if (action === 'show') {
    if (task.downloadId != null) chrome.downloads.show(task.downloadId);
    return;
  }
  if (action === 'open') return openFile(task);
  if (action === 'copy') {
    await navigator.clipboard.writeText(task.url);
    return note(t('copied'));
  }
  if (action === 'redownload') {
    const s = await getSettings();
    await engine('redownload', {
      id: task.id,
      maxConnections: s.maxConnections,
      maxActive: s.maxActive,
      speedLimit: s.speedLimitMB * MB,
      subfolders: subfoldersOf(s),
    });
    view.group = 'all';
    view.kind = null;
    return refresh();
  }
  await engine(action, { id: task.id });
  refresh();
}

// Opening a file needs the optional "downloads.open" permission, asked for
// on the first click. Chrome only opens a file in answer to a click; if the
// permission prompt took too long for that, the user clicks again.
async function openFile(task) {
  const had = await chrome.permissions.contains({ permissions: ['downloads.open'] });
  if (!had && !(await chrome.permissions.request({ permissions: ['downloads.open'] }).catch(() => false))) return;
  const [item] = await chrome.downloads.search({ id: task.downloadId });
  try {
    if (!item || item.exists === false) throw new Error('gone');
    await chrome.downloads.open(task.downloadId);
    note('');
  } catch (err) {
    if (!had && /gesture/i.test(String(err?.message))) return note(t('openFileAllowed'));
    // Moved or deleted since: show where it was instead.
    note(t('openFileFailed'));
    chrome.downloads.show(task.downloadId);
  }
}

function drawBar(canvas, task) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 160;
  const h = 6;
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
  // A thin line marks where a piece still being downloaded begins. Finished
  // pieces join into one bar: lines between them read as holes in the file.
  ctx.fillStyle = css.getPropertyValue('--card');
  for (const s of task.segments || []) {
    if (s.start > 0 && s.pos < s.end) ctx.fillRect((s.start / size) * w - 0.5, 0, 1, h);
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
// A link with [1-100] in it: say how many links it makes before adding.
function previewPattern() {
  const text = $('#url').value;
  if (!/\[[^\]]+-[^\]]+\]/.test(text)) return note('');
  const urls = parsePastedUrls(text);
  if (urls.length < 2) return note('');
  const msg = t('patternPreview', [String(urls.length), urls[0], urls[urls.length - 1]]);
  note(urls.length >= PATTERN_MAX ? `${msg} ${t('patternLimit', [String(PATTERN_MAX)])}` : msg);
}
$('#url').addEventListener('input', () => {
  fitUrlBox();
  previewPattern();
});

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
  $('#notify').checked = s.notify && (await chrome.permissions.contains({ permissions: ['notifications'] }));
  $('#subdirs-on').checked = !!s.subfolders?.on;
  $('#subdir-rows').hidden = !s.subfolders?.on;
  for (const el of document.querySelectorAll('.subdir')) {
    el.placeholder = t(DIR_KEYS[el.dataset.kind]);
    el.value = s.subfolders?.names?.[el.dataset.kind] || '';
  }
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
    notify: $('#notify').checked,
    subfolders: {
      on: $('#subdirs-on').checked,
      names: Object.fromEntries([...document.querySelectorAll('.subdir')].map((el) => [el.dataset.kind, el.value.trim()]).filter(([, v]) => v)),
    },
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
  if (dir && perm !== 'granted') {
    view.page = 'settings';
    showPage();
    render();
  }
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

// Notifications are an optional permission, asked for when turned on, so the
// update that added them did not need new permissions from every user.
$('#notify').addEventListener('change', async (e) => {
  if (e.target.checked && !(await chrome.permissions.request({ permissions: ['notifications'] }).catch(() => false))) {
    e.target.checked = false;
    note(t('notifyDenied'));
  }
  saveSettings();
});
for (const id of ['autoTakeover', 'minSizeMB', 'maxConnections', 'maxActive', 'speedLimitMB']) $('#' + id).addEventListener('change', saveSettings);
for (const el of document.querySelectorAll('#settings .rule, #rule-minImageKB, .subdir')) el.addEventListener('change', saveSettings);
$('#subdirs-on').addEventListener('change', (e) => {
  $('#subdir-rows').hidden = !e.target.checked;
  saveSettings();
});

// The shortcut is set on Chrome's own page; show what it is now.
async function showShortcut() {
  const [cmd] = (await chrome.commands.getAll()).filter((c) => c.name === 'open-manager');
  $('#shortcut-now').textContent = cmd?.shortcut ? t('shortcutNow', [cmd.shortcut]) : t('shortcutNone');
}
$('#shortcut-change').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
showShortcut();
window.addEventListener('focus', showShortcut);

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
