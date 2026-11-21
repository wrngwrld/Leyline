// How settings and history are stored on disk, kept free of Electron so tests can load it.
//
// Compatibility rules (Leyline 1.0 promises that updates never lose anything):
// - A newer Leyline must read every settings file an older one wrote: add a step to
//   MIGRATIONS and bump SETTINGS_VERSION; never rename or reuse a field without one.
// - An older Leyline may open a newer file (after a downgrade): it keeps fields it does not
//   know and never lowers settingsVersion, so the newer one finds its data again.
// - A file that cannot be read is never overwritten: the previous copy (.bak) is used, or
//   the broken file is set aside.
import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const SETTINGS_VERSION = 1;

/** MIGRATIONS[n] turns a version n-1 settings object into version n. */
const MIGRATIONS = {
  // 0 → 1: files from Leyline 0.1.25 and earlier had no version; the fields are unchanged.
  1: (s) => s,
};

/**
 * Bring a settings object read from disk up to date and fill in defaults.
 * @returns {{settings: object, migrated: boolean, newer: boolean}}
 */
export function migrateSettings(raw, defaults) {
  const from = Number.isInteger(raw?.settingsVersion) ? raw.settingsVersion : 0;
  let s = { ...(raw || {}) };
  for (let v = from + 1; v <= SETTINGS_VERSION; v++) s = MIGRATIONS[v](s);
  s.settingsVersion = Math.max(from, SETTINGS_VERSION);
  const settings = { ...defaults, ...s, nas: { ...defaults.nas, ...(s.nas || {}) } };
  return { settings, migrated: from < SETTINGS_VERSION, newer: from > SETTINGS_VERSION };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Read a JSON file. Missing: the fallback. Unreadable: the previous copy (.bak) if that one
 * is fine, otherwise the fallback, with the broken file moved aside so it is not overwritten.
 * @returns {Promise<{data: any, recovered?: 'backup'|'reset', brokenFile?: string}>}
 */
export async function readJsonSafe(file, fallback) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { data: fallback };
    throw e;
  }
  try { return { data: JSON.parse(text) }; } catch {}
  const brokenFile = `${file}.broken-${stamp()}`;
  await rename(file, brokenFile).catch(() => {});
  try {
    const data = JSON.parse(await readFile(`${file}.bak`, 'utf8'));
    await copyFile(`${file}.bak`, file).catch(() => {});
    return { data, recovered: 'backup', brokenFile };
  } catch {
    return { data: fallback, recovered: 'reset', brokenFile };
  }
}

/** Write JSON atomically, keeping the previous version as .bak. */
export async function writeJsonSafe(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  if (existsSync(file)) {
    // only a file that still parses becomes the backup
    try { JSON.parse(await readFile(file, 'utf8')); await copyFile(file, `${file}.bak`); } catch {}
  }
  await rename(tmp, file); // atomic replace: a crash never leaves half a file
}
