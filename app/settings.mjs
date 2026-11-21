// Settings and history, stored as JSON in the app's user-data folder.
// The NAS password is encrypted with Electron safeStorage (backed by the macOS Keychain /
// Windows DPAPI), so the settings file never holds it in readable form.
import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { SETTINGS_VERSION, migrateSettings, readJsonSafe, writeJsonSafe } from './settings-format.mjs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultWowRoot } from '../engine/flavors.mjs';

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name);

export function defaults() {
  return {
    machine: os.hostname().split('.')[0] || 'computer',
    wowRoot: defaultWowRoot(),
    flavors: [],
    nas: { host: '', share: '', folder: 'Leyline', user: '' },
    passwordEnc: '',
    startAtLogin: true,
    autoSync: true,
    syncIntervalMin: 10,
    keepHistoryDays: 30,   // 0 = keep backups forever
    machineId: '',         // stable id for this computer on the NAS (machines/<id>.json)
    lastPrune: null,
  };
}

/** What happened to files that could not be read at startup, for the app to tell the user. */
export const recoveries = [];

async function readJson(name, fallback) {
  const r = await readJsonSafe(file(name), fallback);
  if (r.recovered) recoveries.push({ name, how: r.recovered, brokenFile: r.brokenFile });
  return r.data;
}

const writeJson = (name, data) => writeJsonSafe(file(name), data);

export async function loadSettings() {
  const { settings: out, migrated } = migrateSettings(await readJson('settings.json', {}), { ...defaults(), settingsVersion: SETTINGS_VERSION });
  let save = migrated;
  if (!out.machineId) { out.machineId = randomUUID(); save = true; }
  if (save) await saveSettings(out);
  return out;
}

export async function saveSettings(s) { await writeJson('settings.json', s); }

export async function encryptPassword(plain) {
  if (!plain) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system');
  return (await safeStorage.encryptStringAsync(plain)).toString('base64');
}

/** @returns {Promise<{password: string, reEncrypt: boolean}>} reEncrypt: the OS rotated its key */
export async function decryptPassword(enc) {
  if (!enc) return { password: '', reEncrypt: false };
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'));
  return { password: result, reEncrypt: !!shouldReEncrypt };
}

/** Settings as the window may see them: no password, just whether one is stored. */
export function publicSettings(s) {
  const { passwordEnc, ...rest } = s;
  return { ...rest, hasPassword: !!passwordEnc };
}

export const statePath = () => file('state');

// Per-sync file lists live next to the local backups and are cleaned up with them.
const runFile = (run) => path.join(statePath(), 'runs', `${run}.json`);
export async function saveRun(run, data) {
  await mkdir(path.dirname(runFile(run)), { recursive: true });
  await writeFile(runFile(run), JSON.stringify(data));
}
export async function loadRun(run) {
  if (!/^[0-9T-]+$/.test(run || '')) return null;
  try { return JSON.parse(await readFile(runFile(run), 'utf8')); } catch { return null; }
}

const HISTORY_MAX = 200;
export async function loadHistory() { const h = await readJson('history.json', []); return Array.isArray(h) ? h : []; }
export async function addHistory(entry) {
  const h = await loadHistory();
  h.unshift(entry);
  await writeJson('history.json', h.slice(0, HISTORY_MAX));
  return h.slice(0, HISTORY_MAX);
}
