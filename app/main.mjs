// Leyline main process: tray icon, window, start at login, and the sync runner.
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, Notification, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SyncEngine } from '../engine/sync.mjs';
import { detectFlavors, flavorName, buildItems, findWowRoot, listAddons } from '../engine/flavors.mjs';
import * as store from './settings.mjs';
import { rclonePath, obscure, remoteEnv, remoteRoot, testConnection } from './nas.mjs';
import { runningFlavors } from './wow.mjs';
import { FolderWatcher, ownWrites } from './watcher.mjs';
import { update, initUpdater, checkForUpdates, checkIfStale, installUpdate } from './updater.mjs';

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

const nasReady = () => !!(settings.nas.host && settings.nas.share && settings.nas.user && settings.passwordEnc);
const isConfigured = () => !!(settings.nas.host && settings.nas.share && settings.nas.user && settings.passwordEnc && settings.flavors.some((f) => f.enabled));

function snapshot() {
  if (process.env.LEYLINE_DEMO) return demoSnapshot(process.env.LEYLINE_DEMO);
  return {
    settings: store.publicSettings(settings),
    state: { ...state, configured: isConfigured() },
    history: history.slice(0, 50),
    platform: process.platform,
    version: app.getVersion(),
    update: { ...update },
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('leyline:update', snapshot());
  updateTray();
}

/** Restart into the downloaded update, but never in the middle of a sync. */
function restartToUpdate() {
  if (update.status !== 'ready' || state.status === 'syncing') return false;
  quitting = true;
  installUpdate();
  return true;
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
    ...(update.status === 'ready'
      ? [{ label: syncing ? `Update ${update.version} ready, installs after this sync` : `Restart to update to ${update.version}`, enabled: !syncing, click: restartToUpdate }]
      : []),
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
  checkIfStale();
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

// Addon choices changed: sync those versions once the user stops clicking switches.
let choiceTimer = null;
const choiceFlavors = new Set();
function syncAfterChoice(flavors) {
  for (const f of flavors) choiceFlavors.add(f);
  clearTimeout(choiceTimer);
  choiceTimer = setTimeout(() => {
    const only = [...choiceFlavors];
    choiceFlavors.clear();
    if (settings.autoSync) startSync('addons-changed', { onlyFlavors: only });
  }, 5000);
}

async function saveSettings(patch) {
  const { password, ...rest } = patch;
  if (rest.flavors) {
    const before = new Map(settings.flavors.map((f) => [f.id, JSON.stringify(f.skip || {})]));
    const changed = rest.flavors.filter((f) => f.enabled && before.has(f.id) && before.get(f.id) !== JSON.stringify(f.skip || {})).map((f) => f.id);
    if (changed.length) syncAfterChoice(changed);
  }
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

async function startSync(trigger = 'manual', { onlyFlavors, force = false } = {}) {
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
      force,
      onEvent: (e) => {
        if (e.type === 'item-start') {
          const items = engine.cfg.items;
          const idx = items.findIndex((i) => i.name === e.item);
          const [fl, part] = e.item.split('/');
          state.progress = { item: e.item, label: `${flavorName(fl)} ${part === 'AddOns' ? 'addons' : 'settings'}`, index: idx + 1, total: items.length, files: state.progress?.files || 0, xfer: null, resync: !!e.resync };
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
    // the folder watcher would otherwise see this sync's own writes as new changes
    const syncing = flavors.map((f) => f.id);
    watcher.hold(syncing);
    let r;
    try { r = await engine.syncAll(); } catch (err) { watcher.release(syncing, () => false); throw err; }
    releaseWatcher(syncing, r.results);
    const summary = {
      time: started.toISOString(),
      run: r.runStamp,
      trigger,
      ok: r.ok,
      cancelled: r.cancelled,
      ms: r.ms,
      transfers: r.results.reduce((a, x) => a + x.transfers, 0),
      bytes: r.results.reduce((a, x) => a + x.bytes, 0),
      items: r.results.map((x) => ({ item: x.item, ok: x.ok, inFlux: x.inFlux, transfers: x.transfers, deletes: x.deletes, ms: x.ms, error: x.errors[0], changes: x.changesKnown ? x.changeCount : null })),
    };
    // which files changed, for the History details and restoring
    await store.saveRun(r.runStamp, {
      run: r.runStamp, machine: settings.machine, time: summary.time,
      items: r.results.map((x) => ({ item: x.item, changesKnown: x.changesKnown, changeCount: x.changeCount, changes: x.changes })),
    }).catch(() => {});
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
    await housekeeping(engine);
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

// ---- NAS bookkeeping: computers, backups, restore ---------------------------

/** An engine for one-off NAS work (no sync items). */
async function nasEngine() {
  const env = remoteEnv(settings.nas, await obscure(await nasPassword()));
  return new SyncEngine({ rclone: rclonePath(), remoteRoot: remoteRoot(settings.nas), machine: settings.machine, stateDir: store.statePath(), items: [], env });
}

/** What other computers see about this one on the Computers page. */
const machineInfo = () => ({
  id: settings.machineId, name: settings.machine, platform: process.platform, version: app.getVersion(),
  lastSync: state.lastSync, seen: new Date().toISOString(), playing: state.running,
  flavors: settings.flavors.filter((f) => f.enabled).map((f) => f.id),
});

let computers = { ok: true, list: [], fetched: null, error: null };

/** After each sync: tell the NAS this computer exists, and drop old backups once a day. */
async function housekeeping(eng) {
  try { await eng.writeMachine(machineInfo()); } catch { /* the sync itself worked; try again next time */ }
  const days = settings.keepHistoryDays;
  if (!days || (settings.lastPrune && Date.now() - new Date(settings.lastPrune).getTime() < 20 * 3600_000)) return;
  try {
    await eng.pruneHistory(days);
    settings.lastPrune = new Date().toISOString();
    await store.saveSettings(settings);
  } catch { /* next sync tries again */ }
}

/** Playing state changed: update this computer's entry so others see it right away. */
async function announcePlaying() {
  if (!nasReady()) return;
  try { await (await nasEngine()).writeMachine(machineInfo()); } catch {}
}

async function loadComputers() {
  if (process.env.LEYLINE_DEMO) return demoComputers();
  if (!nasReady()) return { ok: false, error: 'Connect to your NAS first, under NAS.', list: [], me: settings.machineId };
  try {
    const list = await (await nasEngine()).listMachines();
    if (!list.some((m) => m.id === settings.machineId)) list.push(machineInfo()); // before its first sync
    computers = { ok: true, list, fetched: new Date().toISOString(), error: null };
  } catch (err) {
    computers = { ...computers, ok: false, error: err.message };
  }
  return { ...computers, me: settings.machineId };
}

/** Details of one sync, plus whether its backups are still there. */
async function runDetails(run) {
  if (process.env.LEYLINE_DEMO) return demoRun(run);
  const data = await store.loadRun(run);
  if (!data) return null;
  // A sync that compared everything in one go logged no single files: list what it put in
  // the backups instead (once, then remembered), so those files can be restored as well.
  const blind = data.items.filter((i) => !i.changesKnown && !i.fromBackups);
  if (blind.length && nasReady()) {
    try {
      const b = await (await nasEngine()).listBackups(run, data.machine, blind.map((i) => i.item));
      for (const it of blind) {
        const changes = [
          ...(b.local[it.item] || []).map((p) => ({ path: p, action: 'updated', dir: 'in', backup: 'local' })),
          ...(b.nas?.[it.item] || []).map((p) => ({ path: p, action: 'updated', dir: 'out', backup: 'nas' })),
        ];
        Object.assign(it, { changesKnown: true, fromBackups: true, nasUnknown: !b.nas, changeCount: changes.length, changes: changes.slice(0, 5000) });
      }
      // only remember it when the NAS could be read; otherwise try again next time
      if (blind.every((i) => !i.nasUnknown)) await store.saveRun(run, data);
    } catch { /* show it as before */ }
  }
  const t = new Date(data.time).getTime();
  const expired = settings.keepHistoryDays > 0 && Date.now() - t > settings.keepHistoryDays * 86_400_000;
  return { ...data, backups: { local: existsSync(path.join(store.statePath(), 'history', run)), nas: !expired } };
}

/**
 * Put files back to how they were before a sync, then sync that to the other computers:
 * replaced and deleted files come back from the backups, added files are removed.
 * paths: only these files of `item`; without item: everything the sync changed.
 */
async function restore({ run, item, paths }) {
  if (state.status === 'syncing') return { ok: false, error: 'Wait until the current sync has finished.' };
  const data = await store.loadRun(run);
  if (!data) return { ok: false, error: 'The details of this sync are no longer available.' };
  const items = data.items.filter((i) => !item || i.item === item);
  const playing = await runningFlavors();
  const busy = [...new Set(items.map((i) => i.item.split('/')[0]))].filter((f) => playing.has(f));
  if (busy.length) return { ok: false, error: `Close ${busy.map(flavorName).join(', ')} first, then restore.` };

  state.status = 'syncing';
  state.progress = { label: 'restoring files', index: 0, total: 0, files: 0 };
  broadcast();
  let restored = 0, removed = 0, gone = 0, missing = 0;
  const flavors = new Set();
  // remembered in the run's details, so History shows these as done instead of offering them again
  data.undone ||= {};
  try {
    const eng = await nasEngine();
    for (const it of items) {
      const want = paths ? new Set(paths) : null;
      const done = new Set(data.undone[it.item] || []);
      const asked = (it.changes || []).filter((c) => !want || want.has(c.path));
      gone += asked.filter((c) => done.has(c.path)).length; // undone earlier already
      const picked = asked.filter((c) => !done.has(c.path));
      const back = picked.filter((c) => c.backup);
      const added = picked.filter((c) => c.action === 'added').map((c) => c.path);
      if (!back.length && !added.length) continue;
      const fl = it.item.split('/')[0];
      const local = buildItems(settings.wowRoot, [{ id: fl, enabled: true, addons: true }]).find((x) => x.name === it.item)?.local;
      if (!local) continue;
      const target = { name: it.item, local };
      if (back.length) {
        try {
          const r = await eng.restoreFiles({ run, machine: data.machine, item: target, files: back });
          restored += r.restored; missing += r.missing.length;
          if (r.restored) flavors.add(fl);
          const lost = new Set(r.missing);
          for (const c of back) if (!lost.has(c.path)) done.add(c.path);
        } catch { missing += back.length; }
      }
      if (added.length) {
        const r = await eng.removeFiles({ item: target, paths: added });
        // an added file that is already gone needs no removing: count it as done
        removed += r.removed; gone += r.missing.length;
        if (r.removed) flavors.add(fl);
        for (const p of added) done.add(p);
      }
      data.undone[it.item] = [...done];
    }
    await store.saveRun(run, data);
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    state.status = 'idle';
    state.progress = null;
    broadcast();
  }
  if (!restored && !removed && !gone) return { ok: false, error: 'Nothing to undo: the backups of these files have been cleaned up.' };
  if (flavors.size) startSync('restore', { onlyFlavors: [...flavors], force: true });
  return { ok: true, restored, removed, gone, missing };
}

// ---- folder watcher -------------------------------------------------------

/** Hand the watcher back what it saw during a sync, minus the sync's own writes. */
function releaseWatcher(flavors, results) {
  // late file system events still arrive for a moment after the sync
  setTimeout(() => watcher.release(flavors, ownWrites(results)), 2500);
}

const watcher = new FolderWatcher({
  quietMs: 30_000,
  onSettled: (flavor) => { if (settings.autoSync) startSync('files-changed', { onlyFlavors: [flavor] }); },
  onPending: (pending) => { state.pending = pending; broadcast(); },
});

function restartWatcher() {
  if (!settings.autoSync || !isConfigured()) { watcher.stop(); return; }
  const flavors = settings.flavors.filter((f) => f.enabled);
  watcher.start(buildItems(settings.wowRoot, flavors).map((i) => ({ flavor: i.flavor, local: i.local, name: i.name })));
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
  if (changed) { state.running = [...now]; broadcast(); announcePlaying(); }
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
ipcMain.handle('leyline:addons', async (_e, flavor) => {
  if (process.env.LEYLINE_DEMO) return ['BigWigs', 'DBM-Core', 'Details', 'ElvUI', 'Plater', 'WeakAuras'].map((name) => ({ name, title: name === 'ElvUI' ? 'ElvUI (Tukui)' : name }));
  if (!/^_[a-z0-9_]+_$/i.test(String(flavor))) return []; // a game version folder, nothing else
  return listAddons(settings.wowRoot, flavor);
});
ipcMain.handle('leyline:run', (_e, run) => runDetails(run));
ipcMain.handle('leyline:restore', (_e, req) => restore(req || {}));
ipcMain.handle('leyline:computers', () => loadComputers());
ipcMain.handle('leyline:forgetComputer', async (_e, id) => {
  if (!id || id === settings.machineId || process.env.LEYLINE_DEMO) return loadComputers();
  try { await (await nasEngine()).deleteMachine(id); } catch {}
  return loadComputers();
});
ipcMain.handle('leyline:openBackups', () => shell.openPath(path.join(store.statePath(), 'history')));
ipcMain.handle('leyline:checkUpdates', () => { checkForUpdates(); return snapshot(); });
ipcMain.handle('leyline:installUpdate', () => restartToUpdate());
ipcMain.handle('leyline:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.wowRoot, title: 'Choose your World of Warcraft folder' });
  return r.canceled ? null : r.filePaths[0];
});

// ---- development: fake states for design screenshots ---------------------

function demoSnapshot(mode) {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const flavors = [
    { id: '_retail_', enabled: true, addons: true, skip: { addons: ['BigWigs'], settings: ['ElvUI', 'BigWigs'] } }, { id: '_classic_era_', enabled: true, addons: false },
    { id: '_forever_', enabled: true, addons: true }, { id: '_classic_', enabled: false, addons: true },
  ];
  const item = (f, p, t = 0) => ({ item: `${f}/${p}`, ok: true, transfers: t, deletes: 0, ms: 900 });
  const hist = [
    { time: ago(3), run: '2026-11-16T08-00-00', trigger: 'game-closed', ok: true, ms: 6400, transfers: 131, bytes: 3e6, items: [item('_forever_', 'Account', 131), item('_forever_', 'AddOns')] },
    { time: ago(14), run: '2026-11-16T07-49-00', trigger: 'auto', ok: true, ms: 41200, transfers: 0, bytes: 0, items: [item('_retail_', 'Account'), item('_classic_era_', 'Account')] },
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
    update: process.env.LEYLINE_DEMO_UPDATE ? { status: 'ready', version: '9.9.0', percent: 100, error: null } : { ...update },
  };
}

function demoComputers() {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  return {
    ok: true, fetched: ago(0), me: settings.machineId, list: [
      { id: settings.machineId, name: settings.machine, platform: process.platform, version: app.getVersion(), lastSync: ago(3), seen: ago(3), playing: [], flavors: ['_retail_', '_classic_era_', '_forever_'] },
      { id: 'demo-pc', name: 'Gaming-PC', platform: 'win32', version: app.getVersion(), lastSync: ago(52), seen: ago(1), playing: ['_retail_'], flavors: ['_retail_', '_forever_'] },
      { id: 'demo-laptop', name: 'Old-Laptop', platform: 'win32', version: '0.1.2', lastSync: ago(60 * 24 * 40), seen: ago(60 * 24 * 40), playing: [], flavors: ['_retail_'] },
    ],
  };
}

function demoRun(run) {
  const files = (dir, backup, list) => list.map(([p, action]) => ({ path: p, action, dir, backup: action === 'added' ? null : backup, conflict: p.endsWith('Details.lua') }));
  return {
    run, machine: settings.machine, time: new Date(Date.now() - 3 * 60000).toISOString(), backups: { local: true, nas: true },
    undone: { '_forever_/AddOns': ['LFGForever/LFGForever.toc', 'LFGForever/core.lua'] },
    items: [
      { item: '_forever_/Account', changesKnown: true, changeCount: 4, changes: files('out', 'nas', [
        ['ACCOUNT/SavedVariables/WeakAuras.lua', 'updated'], ['ACCOUNT/SavedVariables/Details.lua', 'updated'],
        ['ACCOUNT/Realm/Hero/SavedVariables/Plater.lua', 'updated'], ['ACCOUNT/SavedVariables/OldAddon.lua', 'deleted']]) },
      { item: '_forever_/AddOns', changesKnown: true, changeCount: 5, changes: [
        ...files('in', 'local', [['ElvUI/Core/init.lua', 'updated'], ['ElvUI/Core/API.lua', 'updated'], ['ElvUI/ElvUI.toc', 'updated']]),
        ...files('in', 'local', [['DBM-Core/DBM-Core.lua', 'updated'], ['DBM-Core/new.lua', 'added']]),
        ...files('out', 'nas', [['LFGForever/LFGForever.toc', 'added'], ['LFGForever/core.lua', 'added']])] },
    ],
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
    // History: open the newest sync's details too
    if (p === 'history') { await win.webContents.executeJavaScript(`document.querySelector('.hrow[data-run]')?.click()`); await wait(500); }
    if (p === 'versions') { await win.webContents.executeJavaScript(`document.querySelector('.v-link')?.click()`); await wait(500); }
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
  initUpdater({
    changed: broadcast,
    ready: (version) => notify('Leyline update ready', `Version ${version} installs the next time Leyline restarts.`),
  });

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
