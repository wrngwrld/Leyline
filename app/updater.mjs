// Automatic updates from GitHub Releases. New versions download in the background and
// install when Leyline restarts or quits. Only packaged builds update themselves.
import { app } from 'electron';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** status: unsupported | idle | checking | latest | downloading | ready | error */
export const update = { status: 'idle', version: null, percent: null, error: null };

let onChange = () => {};

function set(patch) {
  Object.assign(update, patch);
  onChange();
}

function friendlyError(err) {
  const t = String(err?.message || err).toLowerCase();
  if (/enotfound|eai_again|econnrefused|etimedout|network|socket|offline/.test(t)) return 'Could not reach GitHub to check for updates.';
  if (t.includes('latest') && t.includes('.yml')) return 'The newest release has no update files yet.';
  return 'Could not check for updates.';
}

export function initUpdater({ changed, ready }) {
  onChange = changed;
  if (!app.isPackaged || process.env.LEYLINE_USER_DATA || process.env.LEYLINE_DEMO) {
    update.status = 'unsupported';
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ status: 'latest', version: null, percent: null }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ percent: Math.floor(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, percent: 100 });
    ready(info.version);
  });
  autoUpdater.on('error', (err) => {
    // A failed later check must not hide an update that is already downloaded.
    if (update.status !== 'ready') set({ status: 'error', error: friendlyError(err) });
  });
  setTimeout(checkForUpdates, FIRST_CHECK_MS);
  setInterval(checkForUpdates, CHECK_EVERY_MS);
}

export function checkForUpdates() {
  if (['unsupported', 'checking', 'downloading', 'ready'].includes(update.status)) return;
  autoUpdater.checkForUpdates().catch(() => { /* reported through the 'error' event */ });
}

/** Quit and install the downloaded update right away. */
export function installUpdate() {
  if (update.status === 'ready') autoUpdater.quitAndInstall();
}
