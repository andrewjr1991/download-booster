// Toolbar popup: media this tab loaded (videos, audio, images, playlists),
// recent downloads, and shortcuts to the manager and the link sniffer.

import { ICONS } from './icons.js';
import { t, localize, engine, addUrls, bytes, speed, statusText } from './client.js';

localize();
const $ = (sel) => document.querySelector(sel);

const KIND_ORDER = ['video', 'audio', 'stream', 'image'];
const KIND_LABEL = { video: 'catVideo', audio: 'catAudio', stream: 'catStream', image: 'catImage' };

const state = {
  tab: null,
  media: [],
  kind: null,
  selected: new Set(), // media keys
  tasks: [],
};

$('#open-manager').innerHTML = ICONS.open;
$('#sniff-links').innerHTML = ICONS.link;
$('#sniff-links').append(t('sniffLinks'));

// ---- tabs ----------------------------------------------------------------------

function showView(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
  $('#view-media').hidden = name !== 'media';
  $('#view-tasks').hidden = name !== 'tasks';
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showView(b.dataset.view);

let toastTimer;
function toast(text) {
  $('#toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').textContent = ''), 3000);
}

// ---- media ---------------------------------------------------------------------

function sortMedia(list) {
  // Biggest first: the main video is rarely the smallest file.
  return [...list].sort((a, b) => (b.size || 0) - (a.size || 0) || b.at - a.at);
}

function renderKinds() {
  const counts = {};
  for (const m of state.media) counts[m.kind] = (counts[m.kind] || 0) + 1;
  const present = KIND_ORDER.filter((k) => counts[k]);
  if (!present.includes(state.kind)) state.kind = present[0] || null;
  $('#kinds').replaceChildren(
    ...present.map((k) => {
      const b = document.createElement('button');
      b.dataset.kind = k;
      b.textContent = `${t(KIND_LABEL[k])} ${counts[k]}`;
      b.setAttribute('aria-pressed', String(k === state.kind));
      b.onclick = () => {
        state.kind = k;
        renderMedia();
      };
      return b;
    }),
  );
}

function shown() {
  return sortMedia(state.media.filter((m) => m.kind === state.kind));
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function mediaRow(m) {
  const li = document.createElement('li');
  li.dataset.key = m.key;
  const stream = m.kind === 'stream';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.selected.has(m.key);
  box.disabled = stream;
  box.onchange = () => {
    if (box.checked) state.selected.add(m.key);
    else state.selected.delete(m.key);
    updateBulk();
  };

  let thumb;
  if (m.kind === 'image') {
    thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    thumb.src = m.url;
    thumb.alt = '';
  } else {
    thumb = document.createElement('span');
    thumb.className = 'ftype';
    thumb.dataset.kind = m.kind;
    thumb.innerHTML = ICONS[m.kind];
  }

  const info = document.createElement('span');
  info.className = 'info';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = m.name;
  name.title = m.url;
  const sub = document.createElement('span');
  sub.className = 'sub';
  const ext = (m.mime.split('/')[1] || '').replace(/^x-/, '').toUpperCase();
  sub.textContent = stream ? t('streamHint') : [m.size ? bytes(m.size) : null, ext || null, host(m.url)].filter(Boolean).join(' · ');
  info.append(name, sub);

  const act = document.createElement('button');
  act.className = 'icon';
  if (stream) {
    act.innerHTML = ICONS.copy;
    act.title = t('copyLink');
    act.onclick = async () => {
      await navigator.clipboard.writeText(m.url);
      toast(t('copied'));
    };
  } else {
    act.innerHTML = ICONS.download;
    act.title = t('addButton');
    act.onclick = () => download([m]);
  }
  li.append(box, thumb, info, act);
  return li;
}

// Images are easier to pick by sight: a grid of thumbnails.
function imageTile(m) {
  const li = document.createElement('li');
  li.className = 'tile';
  li.dataset.key = m.key;
  li.title = `${m.name}\n${m.url}`;
  li.setAttribute('aria-selected', String(state.selected.has(m.key)));
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = m.url;
  img.alt = m.name;
  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.innerHTML = ICONS.check;
  const cap = document.createElement('span');
  cap.className = 'cap';
  cap.textContent = m.size ? bytes(m.size) : m.name;
  img.onload = () => {
    if (img.naturalWidth) cap.textContent = `${img.naturalWidth}×${img.naturalHeight}${m.size ? ` · ${bytes(m.size)}` : ''}`;
  };
  li.append(img, tick, cap);
  li.onclick = () => {
    if (state.selected.has(m.key)) state.selected.delete(m.key);
    else state.selected.add(m.key);
    li.setAttribute('aria-selected', String(state.selected.has(m.key)));
    updateBulk();
  };
  return li;
}

function renderMedia() {
  renderKinds();
  const list = shown();
  const grid = state.kind === 'image';
  $('#media-list').classList.toggle('grid', grid);
  $('#media-list').replaceChildren(...list.map(grid ? imageTile : mediaRow));
  $('#media-empty').hidden = state.media.length > 0;
  $('#media-count').textContent = state.media.length || '';
  $('#media-bulk').hidden = !list.length || state.kind === 'stream';
  updateBulk();
}

function selectedMedia() {
  return shown().filter((m) => state.selected.has(m.key) && m.kind !== 'stream');
}

function updateBulk() {
  const list = shown().filter((m) => m.kind !== 'stream');
  const n = selectedMedia().length;
  $('#media-go').textContent = t('downloadSelected', [String(n)]);
  $('#media-go').disabled = n === 0;
  $('#media-all').checked = list.length > 0 && n === list.length;
  $('#media-all').indeterminate = n > 0 && n < list.length;
}

$('#media-all').onchange = (e) => {
  for (const m of shown()) {
    if (m.kind === 'stream') continue;
    if (e.target.checked) state.selected.add(m.key);
    else state.selected.delete(m.key);
  }
  renderMedia();
};
$('#media-go').onclick = () => download(selectedMedia());

async function download(items) {
  if (!items.length) return;
  // Sent with the page as Referer, as the page's own request was.
  await addUrls(
    items.map((m) => m.url),
    { source: 'media', referrer: state.tab?.url || null },
  );
  for (const m of items) state.selected.delete(m.key);
  toast(t('addedCount', [String(items.length)]));
  renderMedia();
  await refreshTasks();
  showView('tasks');
}

// ---- tasks -----------------------------------------------------------------------

const ORDER = { downloading: 0, saving: 1, queued: 2, paused: 3, error: 4, completed: 5 };

function taskRow(task) {
  const li = document.createElement('li');
  li.dataset.s = task.status;
  const kind = /\.(mp4|mkv|webm|mov|avi|flv|m4v)$/i.test(task.filename || '')
    ? 'video'
    : /\.(mp3|m4a|flac|wav|ogg|opus|aac)$/i.test(task.filename || '')
      ? 'audio'
      : /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(task.filename || '')
        ? 'image'
        : 'other';
  const ft = document.createElement('span');
  ft.className = 'ftype';
  ft.dataset.kind = kind;
  ft.innerHTML = ICONS[kind];

  const info = document.createElement('span');
  info.className = 'info';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = task.filename || task.url;
  name.title = task.url;
  const bar = document.createElement('div');
  bar.className = 'mini-bar';
  const fill = document.createElement('i');
  const done = task.status === 'completed' ? 1 : task.size ? task.downloaded / task.size : 0;
  fill.style.width = `${Math.round(done * 100)}%`;
  bar.append(fill);
  const sub = document.createElement('span');
  sub.className = 'sub';
  const parts = [statusText(task)];
  if (task.size) parts.push(`${bytes(task.status === 'completed' ? task.size : task.downloaded)} / ${bytes(task.size)}`);
  if (task.status === 'downloading') parts.push(speed(task.speed));
  sub.textContent = parts.join(' · ');
  info.append(name, bar, sub);

  const act = document.createElement('button');
  act.className = 'icon';
  if (task.status === 'downloading' || task.status === 'queued') {
    act.innerHTML = ICONS.pause;
    act.title = t('pause');
    act.onclick = () => engine('pause', { id: task.id }).then(refreshTasks);
  } else if (task.status === 'paused' || task.status === 'error') {
    act.innerHTML = task.status === 'error' ? ICONS.retry : ICONS.play;
    act.title = t(task.status === 'error' ? 'retry' : 'resume');
    act.onclick = () => engine('resume', { id: task.id }).then(refreshTasks);
  } else if (task.status === 'completed' && task.downloadId != null) {
    act.innerHTML = ICONS.folder;
    act.title = t('showInFolder');
    act.onclick = () => chrome.downloads.show(task.downloadId);
  } else {
    act.disabled = true;
  }
  li.append(ft, info, act);
  return li;
}

function renderTasks(tasks) {
  state.tasks = tasks;
  const list = [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt - a.createdAt).slice(0, 30);
  $('#task-list').replaceChildren(...list.map(taskRow));
  $('#tasks-empty').hidden = tasks.length > 0;
  const running = tasks.filter((x) => x.status === 'downloading');
  $('#tasks-count').textContent = running.length || '';
  $('#total').textContent = running.length ? speed(running.reduce((s, x) => s + (x.speed || 0), 0)) : '';
}

async function refreshTasks() {
  const res = await engine('list');
  if (res?.tasks) renderTasks(res.tasks);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'engine-state') renderTasks(msg.tasks);
  return false;
});

// ---- footer ----------------------------------------------------------------------

$('#open-manager').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'open-manager' });
  window.close();
};
$('#sniff-links').onclick = async () => {
  if (!state.tab) return;
  await chrome.runtime.sendMessage({ type: 'sniff-tab', tabId: state.tab.id });
  window.close();
};

// ---- start -------------------------------------------------------------------------

async function init() {
  // ?tab=<id> lets tests open the popup as a page for a given tab.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  [state.tab] = forced
    ? [await chrome.tabs.get(forced)]
    : await chrome.tabs.query({ active: true, currentWindow: true });
  const res = state.tab ? await chrome.runtime.sendMessage({ type: 'media-list', tabId: state.tab.id }) : null;
  state.media = res?.media || [];
  renderMedia();
  await refreshTasks();
  // Nothing found on this page but downloads are running: show those.
  if (!state.media.length && state.tasks.some((x) => x.status !== 'completed')) showView('tasks');
  $('#sniff-links').disabled = !/^https?:/i.test(state.tab?.url || '');
}
init();

// New media keeps arriving while a video plays.
chrome.storage.session.onChanged.addListener((changes) => {
  const change = state.tab && changes[`media:${state.tab.id}`];
  if (!change) return;
  state.media = change.newValue || [];
  renderMedia();
});
