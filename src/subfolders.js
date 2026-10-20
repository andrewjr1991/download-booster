// Sorting saved files into subfolders by type ("Videos/", "Archives/", ...).
// settings.subfolders = { on: true, names: { video: 'Movies', ... } }; an
// empty name means the default one in the browser's language.

import { categorize } from './sniff.js';
import { sanitizeFilename } from './http.js';

export const SUBFOLDER_KINDS = ['video', 'audio', 'image', 'archive', 'program', 'disk', 'document'];
export const DIR_KEYS = {
  video: 'dirVideo',
  audio: 'dirAudio',
  image: 'dirImage',
  archive: 'dirArchive',
  program: 'dirProgram',
  disk: 'dirDisk',
  document: 'dirDocument',
};

// "a/b", with each level made safe as a folder name; '' if nothing is left.
export function cleanPath(path) {
  return String(path || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\.+$/.test(s))
    .map(sanitizeFilename)
    .join('/');
}

// kind -> folder path, or null when sorting is off. `defaultName(kind)` gives
// the localized default.
export function resolveSubfolders(conf, defaultName) {
  if (!conf?.on) return null;
  const out = {};
  for (const k of SUBFOLDER_KINDS) out[k] = cleanPath(conf.names?.[k]) || cleanPath(defaultName(k));
  return out;
}

// The subfolder a file with this name goes into ('' for none).
export function subfolderFor(map, filename) {
  if (!map || !filename) return '';
  return map[categorize(`https://x/${encodeURIComponent(filename)}`)] || '';
}
