// Leyline main process: tray icon, window, start at login, and the sync runner.
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, Notification, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine } from '../engine/sync.mjs';
import { detectFlavors, flavorName, buildItems, findWowRoot } from '../engine/flavors.mjs';
import * as store from './settings.mjs';
import { rclonePath, obscure, remoteEnv, remoteRoot, testConnection } from './nas.mjs';
import { runningFlavors } from './wow.mjs';
import { FolderWatcher } from './watcher.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const asset = (f) => path.join(HERE, 'assets', f);
const isMac = process.platform === 'darwin';

app.setName('Leyline');
if (process.platform === 'win32') app.setAppUserModelId('app.leyline.desktop'); // needed for notifications
// Development: a separate settings folder for test runs.
if (process.env.LEYLINE_USER_DATA) app.setPath('userData', process.env.LEYLINE_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let quitting = false;
let settings = null;
let history = [];
let engine = null;
let trayFrame = 0;
let trayTimer = null;
let autoTimer = null;

/** Live state shown in the window and tray. */
const state = {
  status: 'idle',          // idle | syncing | error
  progress: null,          // { item, index, total, files }
  lastSync: null,          // ISO time of last successful sync
  lastError: null,
  running: [],             // flavor ids of WoW versions currently running
  pending: [],             // flavors with file changes waiting to settle before they sync
  detected: [],            // flavors found in the WoW folder
};

// ---- helpers ------------------------------------------------------------

const isConfigured = () => !!(settings.nas.host && settings.nas.share && settings.nas.user && settings.passwordEnc && settings.flavors.some((f) => f.enabled));

function snapshot() {
  if (process.env.LEYLINE_DEMO) return demoSnapshot(process.env.LEYLINE_DEMO);
  return {
    settings: store.publicSettings(settings),
    state: { ...state, configured: isConfigured() },
    history: history.slice(0, 50),
    platform: process.platform,
    version: app.getVersion(),
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('leyline:update', snapshot());
  updateTray();
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

function relTime(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---- tray ---------------------------------------------------------------

function trayImage(frame = 0) {
  if (!isMac) return nativeImage.createFromPath(asset('tray-win.png'));
  const img = nativeImage.createFromPath(asset(frame === 0 ? 'trayTemplate.png' : `traySync${frame}Template.png`));
  img.setTemplateImage(true);
  return img;
}

function statusLine() {
  if (!isConfigured()) return 'Not set up yet';
  if (state.status === 'syncing') {
    const p = state.progress;
    if (!p) return 'Syncing…';
    const x = p.xfer;
    const pct = x?.totalBytes ? ` · ${Math.floor((x.bytes / x.totalBytes) * 100)}%` : '';
    return `Syncing ${p.label}${pct}`;
  }
  if (state.status === 'error') return 'Last sync failed';
  if (state.running.length) return `Playing ${state.running.map(flavorName).join(', ')}`;
  if (state.pending.length) return `Changes in ${state.pending.map(flavorName).join(', ')}, syncing when they settle`;
  return `In sync · ${relTime(state.lastSync)}`;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Leyline — ${statusLine()}`);
  const syncing = state.status === 'syncing';
  if (syncing && !trayTimer) {
    trayTimer = setInterval(() => { trayFrame = (trayFrame % 4) + 1; tray.setImage(trayImage(trayFrame)); }, 220);
  } else if (!syncing && trayTimer) {
    clearInterval(trayTimer); trayTimer = null; tray.setImage(trayImage(0));
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    syncing
      ? { label: 'Stop sync', click: () => engine?.cancel() }
      : { label: 'Sync now', enabled: isConfigured(), click: () => startSync('manual') },
    { label: 'Open Leyline', click: showWindow },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: settings.startAtLogin, click: (m) => saveSettings({ startAtLogin: m.checked }) },
    { type: 'separator' },
    { label: 'Quit Leyline', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(trayImage(0));
  if (!isMac) tray.on('click', showWindow);
  updateTray();
}

// ---- window -------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Leyline',
    icon: isMac ? undefined : asset('icon.png'),
    backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#0c0d18' : '#f4f3fb'),
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', transparent: false }
      : { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() }),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(HERE, 'renderer', 'index.html'));
  win.on('close', (e) => {
    // Closing the window keeps Leyline running in the tray.
    if (!quitting) { e.preventDefault(); win.hide(); if (isMac) app.dock?.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// Windows: the minimise/maximise/close buttons sit on the page; match the page background.
function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#0c0d18' : '#f6f5fb', symbolColor: dark ? '#e8e6f3' : '#2a2840', height: 48 };
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (isMac) app.dock?.show();
  const reveal = () => { win.show(); win.focus(); };
  if (win.webContents.isLoading()) win.once('ready-to-show', reveal); else reveal();
}

// ---- settings -----------------------------------------------------------

function applyLoginItem() {
  // Only a packaged build registers itself; running from source must not add Electron to login items.
  if (!app.isPackaged || process.env.LEYLINE_USER_DATA) return; // test runs never register
  app.setLoginItemSettings({ openAtLogin: !!settings.startAtLogin, openAsHidden: true, args: ['--hidden'] });
}

async function saveSettings(patch) {
  const { password, ...rest } = patch;
  settings = { ...settings, ...rest, nas: { ...settings.nas, ...(rest.nas || {}) } };
  if (password !== undefined) settings.passwordEnc = await store.encryptPassword(password);
  await store.saveSettings(settings);
  if ('startAtLogin' in patch) applyLoginItem();
  if ('autoSync' in patch || 'syncIntervalMin' in patch) scheduleAuto();
  if ('flavors' in patch || 'autoSync' in patch || 'wowRoot' in patch || 'nas' in patch || password !== undefined) restartWatcher();
  broadcast();
  return snapshot();
}

/** Merge newly detected versions into settings; new ones start disabled. */
async function refreshDetected() {
  state.detected = await detectFlavors(settings.wowRoot);
  const known = new Set(settings.flavors.map((f) => f.id));
  const added = state.detected.filter((d) => !known.has(d.id)).map((d) => ({ id: d.id, enabled: false, addons: true }));
  if (added.length) { settings.flavors = [...settings.flavors, ...added]; await store.saveSettings(settings); }
}

/** The stored NAS password; re-encrypts it when the OS asks (key rotation). */
async function nasPassword() {
  const { password, reEncrypt } = await store.decryptPassword(settings.passwordEnc);
  if (reEncrypt && password) { settings.passwordEnc = await store.encryptPassword(password); await store.saveSettings(settings); }
  return password;
}

// ---- sync ---------------------------------------------------------------

// Versions that asked for a sync while another one was running; they run right after it.
const queued = new Set();
let queuedTrigger = null;

async function startSync(trigger = 'manual', { onlyFlavors } = {}) {
  if (!isConfigured()) return;
  if (state.status === 'syncing') {
    for (const f of onlyFlavors || settings.flavors.filter((x) => x.enabled).map((x) => x.id)) queued.add(f);
    queuedTrigger = trigger;
    return;
  }
  // Never sync a game version while it is running: WoW rewrites its files on logout.
  const playing = await runningFlavors();
  state.running = [...playing];
  const flavors = settings.flavors.filter((f) => f.enabled && !playing.has(f.id) && (!onlyFlavors || onlyFlavors.includes(f.id)));
  if (!flavors.length) { broadcast(); return; }

  state.status = 'syncing';
  state.lastError = null;
  state.progress = { label: 'starting', index: 0, total: 0, files: 0 };
  broadcast();

  const started = new Date();
  try {
    const env = remoteEnv(settings.nas, await obscure(await nasPassword()));
    engine = new SyncEngine({
      rclone: rclonePath(),
      remoteRoot: remoteRoot(settings.nas),
      machine: settings.machine,
      stateDir: store.statePath(),
      wowRoot: settings.wowRoot,
      flavors,
      env,
      onEvent: (e) => {
        if (e.type === 'item-start') {
          const items = engine.cfg.items;
          const idx = items.findIndex((i) => i.name === e.item);
          const [fl, part] = e.item.split('/');
          state.progress = { item: e.item, label: `${flavorName(fl)} ${part === 'AddOns' ? 'addons' : 'settings'}`, index: idx + 1, total: items.length, files: state.progress?.files || 0, xfer: null };
          broadcast();
        } else if (e.type === 'file') {
          state.progress.files++;
        } else if (e.type === 'stats' && state.progress) {
          // live numbers for the current step: files/bytes done of queued, speed, seconds left
          const { bytes, totalBytes, transfers, totalTransfers, speed, eta } = e;
          state.progress.xfer = { bytes, totalBytes, transfers, totalTransfers, speed, eta };
          broadcast();
        }
      },
    });
    const r = await engine.syncAll();
    const summary = {
      time: started.toISOString(),
      trigger,
      ok: r.ok,
      cancelled: r.cancelled,
      ms: r.ms,
      transfers: r.results.reduce((a, x) => a + x.transfers, 0),
      bytes: r.results.reduce((a, x) => a + x.bytes, 0),
      items: r.results.map((x) => ({ item: x.item, ok: x.ok, inFlux: x.inFlux, transfers: x.transfers, deletes: x.deletes, ms: x.ms, error: x.errors[0] })),
    };
    const failed = r.results.filter((x) => !x.ok);
    // Files changed while we copied them (an addon manager at work): not an error, just try
    // again once the folder has been quiet for a while.
    summary.inFlux = !r.ok && !r.cancelled && failed.length > 0 && failed.every((x) => x.inFlux);
    history = await store.addHistory(summary);
    if (r.ok) { state.status = 'idle'; state.lastSync = summary.time; }
    else if (r.cancelled) state.status = 'idle';
    else if (summary.inFlux) {
      state.status = 'idle';
      for (const f of new Set(failed.map((x) => x.item.split('/')[0]))) watcher.touch(f);
    } else {
      state.status = 'error';
      state.lastError = r.results.find((x) => !x.ok)?.errors[0] || 'Sync failed';
      notify('Leyline could not sync', state.lastError);
    }
  } catch (err) {
    state.status = 'error';
    state.lastError = err.message;
    notify('Leyline could not sync', err.message);
  } finally {
    engine = null;
    state.progress = null;
    broadcast();
    if (queued.size) {
      const next = [...queued], why = queuedTrigger;
      queued.clear(); queuedTrigger = null;
      setTimeout(() => startSync(why || 'files-changed', { onlyFlavors: next }), 1500);
    }
  }
}

// ---- folder watcher -------------------------------------------------------

const watcher = new FolderWatcher({
  quietMs: 30_000,
  onSettled: (flavor) => { if (settings.autoSync) startSync('files-changed', { onlyFlavors: [flavor] }); },
  onPending: (pending) => { state.pending = pending; broadcast(); },
});

function restartWatcher() {
  if (!settings.autoSync || !isConfigured()) { watcher.stop(); return; }
  const flavors = settings.flavors.filter((f) => f.enabled);
  watcher.start(buildItems(settings.wowRoot, flavors).map((i) => ({ flavor: i.flavor, local: i.local })));
}

// Background sync on a timer, plus right after a game version closes.
function scheduleAuto() {
  clearInterval(autoTimer);
  if (!settings.autoSync) return;
  autoTimer = setInterval(() => startSync('auto'), Math.max(1, settings.syncIntervalMin) * 60_000);
}

let lastRunning = new Set();
async function watchGame() {
  const now = await runningFlavors();
  const closed = [...lastRunning].filter((f) => !now.has(f));
  const changed = closed.length || [...now].some((f) => !lastRunning.has(f));
  lastRunning = now;
  if (changed) { state.running = [...now]; broadcast(); }
  if (closed.length && settings.autoSync) {
    // give WoW a moment to finish writing SavedVariables
    setTimeout(() => startSync('game-closed', { onlyFlavors: closed }), 4000);
  }
}

// ---- IPC ----------------------------------------------------------------

ipcMain.handle('leyline:get', () => snapshot());
ipcMain.handle('leyline:save', (_e, patch) => saveSettings(patch));
ipcMain.handle('leyline:detect', async (_e, wowRoot) => {
  if (wowRoot) settings.wowRoot = wowRoot;
  await refreshDetected();
  await store.saveSettings(settings);
  restartWatcher();
  broadcast();
  return snapshot();
});
ipcMain.handle('leyline:test', async (_e, { nas, password }) => {
  try {
    return await testConnection({ ...settings.nas, ...nas }, password || (await nasPassword()));
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('leyline:sync', () => { startSync('manual'); return true; });
ipcMain.handle('leyline:cancel', () => { engine?.cancel(); return true; });
ipcMain.handle('leyline:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.wowRoot, title: 'Choose your World of Warcraft folder' });
  return r.canceled ? null : r.filePaths[0];
});

// ---- development: fake states for design screenshots ---------------------

function demoSnapshot(mode) {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const flavors = [
    { id: '_retail_', enabled: true, addons: true }, { id: '_classic_era_', enabled: true, addons: false },
    { id: '_forever_', enabled: true, addons: true }, { id: '_classic_', enabled: false, addons: true },
  ];
  const item = (f, p, t = 0) => ({ item: `${f}/${p}`, ok: true, transfers: t, deletes: 0, ms: 900 });
  const hist = [
    { time: ago(3), trigger: 'game-closed', ok: true, ms: 6400, transfers: 131, bytes: 3e6, items: [item('_forever_', 'Account', 131), item('_forever_', 'AddOns')] },
    { time: ago(14), trigger: 'auto', ok: true, ms: 41200, transfers: 0, bytes: 0, items: [item('_retail_', 'Account'), item('_classic_era_', 'Account')] },
    { time: ago(70), trigger: 'auto', ok: false, ms: 20100, transfers: 0, bytes: 0, items: [{ item: '_retail_/AddOns', ok: false, error: 'Could not reach the NAS. Check the address and that you are on the same network.' }] },
    { time: ago(190), trigger: 'manual', ok: true, ms: 312000, transfers: 4218, bytes: 9e8, items: [item('_forever_', 'AddOns', 4218)] },
    { time: ago(1500), trigger: 'startup', ok: true, cancelled: true, ms: 8000, transfers: 12, bytes: 0, items: [item('_retail_', 'Account', 12)] },
  ];
  const st = { ...state, configured: true, status: 'idle', lastSync: ago(3), running: [], progress: null, lastError: null };
  if (mode === 'syncing') Object.assign(st, { status: 'syncing', progress: { item: '_forever_/AddOns', label: 'Forever addons', index: 6, total: 6, files: 5812,
    xfer: { bytes: 967713097, totalBytes: 3630000000, transfers: 5812, totalTransfers: 26476, speed: 10400000, eta: 512 } } });
  if (mode === 'error') Object.assign(st, { status: 'error', lastError: 'The NAS rejected the user name or password.' });
  if (mode === 'playing') st.running = ['_forever_'];
  if (mode === 'idle') st.pending = ['_retail_'];
  return {
    settings: { ...store.publicSettings(settings), flavors, hasPassword: true, nas: { host: '192.168.1.10', share: 'leyline', user: 'player', folder: 'Leyline' } },
    state: st, history: hist, platform: process.platform, version: app.getVersion(),
  };
}

// ---- development: capture each page to PNG -------------------------------

async function captureScreens(dir) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => (win.isVisible() ? r() : win.once('show', r)));
  await wait(1200);
  const pages = (process.env.LEYLINE_SCREENSHOT_PAGES || 'overview,versions,nas,history,settings').split(',');
  for (const p of pages) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-page="${p}"]').click()`);
    await wait(700);
    const img = await win.webContents.capturePage();
    await writeFile(path.join(dir, `${process.env.LEYLINE_SCREENSHOT_PREFIX || ''}${p}.png`), img.toPNG());
  }
  if (process.env.LEYLINE_SCREENSHOTS_QUIT) { quitting = true; app.quit(); }
}

// ---- lifecycle ----------------------------------------------------------

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; watcher.stop(); engine?.cancel(); });
app.on('window-all-closed', (e) => e.preventDefault?.());

app.whenReady().then(async () => {
  if (process.env.LEYLINE_THEME) nativeTheme.themeSource = process.env.LEYLINE_THEME;
  settings = await store.loadSettings();
  if (!settings.flavors.length) { settings.wowRoot = await findWowRoot(); await store.saveSettings(settings); }
  history = await store.loadHistory();
  state.lastSync = history.find((h) => h.ok)?.time || null;
  await refreshDetected();
  applyLoginItem();
  if (isMac) app.dock?.setIcon(asset('icon-512.png'));
  createTray();
  createWindow();

  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (hidden || process.env.LEYLINE_HIDDEN) { if (isMac) app.dock?.hide(); }
  else win.once('ready-to-show', () => win.show());

  if (process.env.LEYLINE_SCREENSHOTS) captureScreens(process.env.LEYLINE_SCREENSHOTS);

  nativeTheme.on('updated', () => {
    if (!isMac && win && !win.isDestroyed()) win.setTitleBarOverlay(overlayColors());
    broadcast();
  });
  setInterval(watchGame, 8000);
  setInterval(updateTray, 60_000); // keep "x min ago" fresh
  scheduleAuto();
  restartWatcher();
  if (settings.autoSync && isConfigured()) setTimeout(() => startSync('startup'), 3000);
});
