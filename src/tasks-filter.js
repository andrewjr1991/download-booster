// Which tasks the download manager shows: by state, file type and a search.

import { categorize } from './sniff.js';

export const TASK_GROUPS = ['all', 'active', 'completed', 'error'];

export function taskGroup(task) {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'error') return 'error';
  return 'active'; // queued, downloading, paused, saving
}

// The file type a task's name points to (the same kinds as sniffed links).
export function taskKind(task) {
  if (task.kind === 'hls' || task.kind === 'record') return 'video';
  if (task.filename) return categorize(`https://x/${encodeURIComponent(task.filename)}`);
  return /^https?:/i.test(task.url || '') ? categorize(task.url) : 'other';
}

// filter: { group: 'all' | 'active' | 'completed' | 'error', kind: null | kind, q: '' }
export function matchTask(task, { group = 'all', kind = null, q = '' } = {}) {
  if (group !== 'all' && taskGroup(task) !== group) return false;
  if (kind && taskKind(task) !== kind) return false;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${task.filename || ''} ${safeDecode(task.url || '')}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

function safeDecode(u) {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
}
