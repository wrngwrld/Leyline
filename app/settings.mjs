// Settings and history, stored as JSON in the app's user-data folder.
// The NAS password is encrypted with Electron safeStorage (backed by the macOS Keychain /
// Windows DPAPI), so the settings file never holds it in readable form.
import { app, safeStorage } from 'electron';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import os from 'node:os';
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
  };
}

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(file(name), 'utf8')); } catch { return fallback; }
}

async function writeJson(name, data) {
  await mkdir(dir(), { recursive: true });
  const tmp = file(`${name}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file(name)); // atomic replace: a crash never leaves half a file
}

export async function loadSettings() {
  const d = defaults();
  const s = await readJson('settings.json', {});
  return { ...d, ...s, nas: { ...d.nas, ...(s.nas || {}) } };
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

const HISTORY_MAX = 200;
export async function loadHistory() { return readJson('history.json', []); }
export async function addHistory(entry) {
  const h = await loadHistory();
  h.unshift(entry);
  await writeJson('history.json', h.slice(0, HISTORY_MAX));
  return h.slice(0, HISTORY_MAX);
}
