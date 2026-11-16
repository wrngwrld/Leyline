// Leyline sync engine: two-way sync of WoW folders against a NAS using rclone bisync.
// Used by the CLI now and by the Electron main process later.
//
// An item is one synced folder, named "<flavor>/<part>", e.g. "_retail_/Account".
//
// Remote layout (root = NAS folder or rclone remote path):
//   <root>/current/<flavor>/<part>                    live copy every machine syncs against
//   <root>/history/<stamp>_<machine>/<flavor>/<part>  files replaced or deleted by a sync
//   <root>/locks/<flavor>.json                        who is playing that game version now
//   <root>/machines/<id>.json                         one line per computer: name, version, last sync
//
// Local state per machine (stateDir):
//   bisync/<flavor>/<part>/      rclone bisync listings (which files each side had)
//   history/<stamp>/<flavor>/<part>  local files replaced by a sync
//   filters.txt                  exclude rules
//
// Backups: when a sync replaces or deletes a file, rclone first moves the old version into
// history/ on the side that changes: files arriving from the NAS leave their old local copy
// in the local history, files sent to the NAS leave the old NAS copy in the NAS history.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm, utimes, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildItems } from './flavors.mjs';

export const DEFAULT_EXCLUDES = [
  '*.bak',
  '*.old',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '._*',
  '*(conflicted copy*',
  '.dropbox*',
];

// rclone's wording when a file changes or disappears while it is being copied.
const IN_FLUX = /being updated|sizes differ|size changed|modtime changed|mod time changed|vanished|no such file or directory|file not found|object not found/i;
// bisync's summary lines that accompany any failure; they say nothing about the cause.
const SUMMARY = /^(\x1b\[[0-9;]*m)?bisync (critical error|aborted)|^\x1b|errors? (occurred|during)|failed to bisync|out of sync/i;

/** True when every real error is "a file changed while copying", i.e. someone else is writing. */
export function isInFlux(errors) {
  const real = errors.filter((e) => e && !SUMMARY.test(e));
  return real.length > 0 && real.every((e) => IN_FLUX.test(e));
}

/** 'settings' (WTF folders) or 'addons'; explicit test items are classified by their name. */
const itemKind = (item) => item.kind || (/(^|\/)AddOns$/i.test(item.name) ? 'addons' : 'settings');

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const joinRemote = (root, ...parts) => [root.replace(/\/+$/, ''), ...parts].join('/');

/** "2026-11-16T08-01-20..." (a run stamp, maybe with a suffix) → Date, or null. */
export function stampTime(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name || '');
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
}

const MAX_CHANGES = 5000; // per item; addon updates can touch tens of thousands of files
const ANSI = /\x1b\[[0-9;]*m/g;
const slash = (p) => p.replace(/\\/g, '/');

/** Path of `full` inside `root`, or null. Windows paths compare case-insensitively. */
function relTo(root, full) {
  const r = slash(root).replace(/\/+$/, '') + '/';
  const f = slash(full);
  const win = process.platform === 'win32';
  if ((win ? f.toLowerCase() : f).startsWith(win ? r.toLowerCase() : r)) return f.slice(r.length);
  return null;
}

/**
 * Which files a bisync run changed, from its log. bisync first lists what differs on each
 * side ("File is new / changed / was deleted"), then queues the work ("Queue copy to Path2",
 * "Queue delete"). Path1 is this computer, Path2 the NAS.
 * @returns {{path:string, action:'added'|'updated'|'deleted', dir:'in'|'out', backup:'local'|'nas'|null}[]}
 */
export function parseChanges(logs, local, remote) {
  const seen = { Path1: new Map(), Path2: new Map() };
  const changes = [];
  // bisync prints both roots as it resolved them (a remote shows as its real path)
  const roots = { Path1: [local], Path2: [remote, remote.replace(/^[^:/\\]+:/, '')] };
  const relFor = (side, full) => {
    for (const root of roots[side]) { const rel = relTo(root, full); if (rel) return rel; }
    return null;
  };
  for (const l of logs) {
    if (l.object) continue;
    const msg = (l.msg || '').replace(ANSI, '').trim();
    const sync = /^Synching Path1 "(.*)" with Path2 "(.*)"$/.exec(msg);
    if (sync) { roots.Path1.unshift(sync[1]); roots.Path2.unshift(sync[2]); continue; }
    let m = /^- (Path[12])\s+(File is new|File changed|File was deleted)\b.*?\s+- (.+)$/.exec(msg);
    if (m) { seen[m[1]].set(slash(m[3]), m[2] === 'File is new' ? 'new' : m[2] === 'File changed' ? 'changed' : 'deleted'); continue; }
    m = /^- (Path[12])\s+Queue copy to (Path[12])\s+- (.+)$/.exec(msg);
    if (m) {
      const [, from, to, dest] = m;
      const rel = relFor(to, dest);
      if (!rel) continue;
      // copied onto an existing file → its old version went to that side's history
      const added = seen[from].get(rel) === 'new' && !seen[to].has(rel);
      changes.push({ path: rel, action: added ? 'added' : 'updated', dir: to === 'Path1' ? 'in' : 'out', backup: added ? null : to === 'Path1' ? 'local' : 'nas' });
      continue;
    }
    m = /^- (Path[12])\s+Queue delete\s+- (.+)$/.exec(msg);
    if (m) {
      const [, side, full] = m;
      const rel = relFor(side, full);
      if (rel) changes.push({ path: rel, action: 'deleted', dir: side === 'Path1' ? 'in' : 'out', backup: side === 'Path1' ? 'local' : 'nas' });
    }
  }
  // folders show up as entries of their own; the files inside say more
  const parents = new Set(changes.flatMap((c) => c.path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  return changes.filter((c) => !parents.has(c.path));
}

/** A relative path inside a synced folder, never escaping it. */
export function safeRel(rel) {
  const p = slash(String(rel || ''));
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some((s) => s === '..' || s === '')) return null;
  return p;
}

export class SyncEngine {
  /**
   * @param {object} cfg
   * @param {string} cfg.rclone      path to the rclone binary
   * @param {string} cfg.remoteRoot  e.g. "/Volumes/data/WoW Sync" or "nas:data/WoW Sync"
   * @param {string} cfg.machine     short machine name, e.g. "mac"
   * @param {string} cfg.stateDir    local folder for sync state and local history
   * @param {string} [cfg.wowRoot]   WoW install folder; with cfg.flavors builds the items
   * @param {{id:string, enabled?:boolean, addons?:boolean}[]} [cfg.flavors]  game versions to sync
   * @param {{name:string, flavor:string, local:string}[]} [cfg.items]  explicit items (tests)
   * @param {string[]} [cfg.excludes]
   * @param {string} [cfg.rcloneConfig]  path to an rclone.conf (for the smb remote)
   * @param {Record<string,string>} [cfg.env]  extra environment, e.g. RCLONE_CONFIG_NAS_* remote definition
   * @param {(e:object)=>void} [cfg.onEvent]  progress callback
   */
  constructor(cfg) {
    this.cfg = { excludes: DEFAULT_EXCLUDES, onEvent: () => {}, ...cfg };
    const home = (p) => (typeof p === 'string' && /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
    for (const k of ['stateDir', 'wowRoot', 'remoteRoot', 'rclone', 'rcloneConfig']) this.cfg[k] = home(this.cfg[k]);
    if (!this.cfg.items) this.cfg.items = buildItems(this.cfg.wowRoot, this.cfg.flavors || []);
    for (const it of this.cfg.items) if (!it.flavor) it.flavor = it.name.split('/')[0];
  }

  /** Game versions this engine syncs, in order. */
  get flavors() { return [...new Set(this.cfg.items.map((i) => i.flavor))]; }

  emit(e) { this.cfg.onEvent({ time: Date.now(), ...e }); }

  /** Environment for rclone: lets the app define the NAS remote without a config file. */
  env() { return { ...process.env, ...(this.cfg.env || {}) }; }

  async prepare() {
    const { stateDir, excludes } = this.cfg;
    await mkdir(path.join(stateDir, 'bisync'), { recursive: true });
    await mkdir(path.join(stateDir, 'history'), { recursive: true });
    this.filtersFile = path.join(stateDir, 'filters.txt');
    const body = excludes.map((p) => `- ${p}`).join('\n') + '\n';
    let old = null;
    try { old = await readFile(this.filtersFile, 'utf8'); } catch {}
    // bisync demands a resync whenever the filter file changes, so only write when needed.
    if (old !== body) await writeFile(this.filtersFile, body);
  }

  /** Run rclone, collecting JSON log lines. Resolves {code, logs, stats, ms}. */
  run(args) {
    const { rclone, rcloneConfig } = this.cfg;
    // Stats every 2 s drive the live progress (files/bytes done of total, speed, time left).
    const full = [...args, '--use-json-log', '--log-level', 'INFO', '--stats', '2s', '--stats-log-level', 'NOTICE'];
    if (rcloneConfig) full.push('--config', rcloneConfig);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const p = spawn(rclone, full, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env() });
      this.child = p;
      const logs = [];
      let stats = null;
      let buf = '';
      const onData = (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { entry = { level: 'info', msg: line }; }
          if (entry.stats) {
            stats = entry.stats;
            const st = entry.stats;
            this.emit({
              type: 'stats',
              bytes: st.bytes ?? 0, totalBytes: st.totalBytes ?? 0,
              transfers: st.transfers ?? 0, totalTransfers: st.totalTransfers ?? 0,
              checks: st.checks ?? 0, totalChecks: st.totalChecks ?? 0,
              speed: st.speed ?? 0, eta: st.eta ?? null,
            });
            continue; // periodic stats are not log lines worth keeping
          }
          logs.push(entry);
          if (entry.object && /Copied|Deleted|Moved/.test(entry.msg || '')) {
            this.emit({ type: 'file', msg: entry.msg.trim(), object: entry.object });
          }
        }
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', reject);
      p.on('close', (code) => { if (this.child === p) this.child = null; resolve({ code, logs, stats, ms: Date.now() - started }); });
      p.stdin.end();
    });
  }

  /** Two-way sync of one item. */
  async syncItem(item, { forceResync = false } = {}) {
    const { remoteRoot, stateDir, machine } = this.cfg;
    const remote = joinRemote(remoteRoot, 'current', item.name);
    const runStamp = this.runStamp;
    const workdir = path.join(stateDir, 'bisync', item.name);
    await mkdir(workdir, { recursive: true });
    await mkdir(item.local, { recursive: true });

    // bisync needs both roots to exist; on a fresh NAS the remote one doesn't yet.
    const mk = await this.run(['mkdir', remote]);
    if (mk.code !== 0) {
      const result = { item: item.name, ok: false, code: mk.code, resync: false, ms: mk.ms, transfers: 0, bytes: 0, deletes: 0, checks: 0,
        errors: mk.logs.filter((l) => l.level === 'error').map((l) => l.msg?.trim()) };
      this.emit({ type: 'item-done', ...result });
      return result;
    }

    const firstRun = !existsSync(path.join(workdir, '.initialized'));
    const resync = forceResync || firstRun;

    const args = [
      'bisync', item.local, remote,
      '--workdir', workdir,
      '--filters-file', this.filtersFile,
      '--compare', 'size,modtime',
      '--modify-window', '2s',
      '--conflict-resolve', 'newer',
      // The losing version goes to the backup dirs (history), not next to the file.
      '--conflict-loser', 'delete',
      '--backup-dir1', path.join(stateDir, 'history', runStamp, item.name),
      '--backup-dir2', joinRemote(remoteRoot, 'history', `${runStamp}_${machine}`, item.name),
      '--create-empty-src-dirs',
      '--resilient', '--recover',
      '--max-lock', '5m',
      '--transfers', '16', '--checkers', '32',
    ];
    // bisync stops when *every* file in a folder changed ("all files were changed"), which is
    // a good brake for addons but exactly what WoW does to settings: on logout it rewrites all
    // SavedVariables. Settings folders are small and every replaced file goes to history, so
    // let them through.
    if (itemKind(item) === 'settings') args.push('--force');
    if (resync) args.push('--resync', '--resync-mode', 'newer');

    this.emit({ type: 'item-start', item: item.name, resync });
    let res = await this.run(args);

    // bisync refuses to continue after some failures until a resync. Newer-wins plus the
    // backup dirs keep that safe, so retry once instead of leaving the user stuck.
    const needsResync = res.logs.some((l) => /--resync|must run --resync|cannot find prior/i.test(l.msg || ''));
    // ...unless files were still changing under us: retrying now would hit the same churn.
    // The caller retries once the folder is quiet, and that run recovers with a resync.
    const churn = isInFlux(res.logs.filter((l) => l.level === 'error').map((l) => l.msg?.trim()));
    if (res.code !== 0 && !resync && needsResync && !churn && !this.cancelled) {
      this.emit({ type: 'item-resync', item: item.name });
      return this.syncItem(item, { forceResync: true });
    }

    if (res.code === 0) await writeFile(path.join(workdir, '.initialized'), new Date().toISOString());
    const s = res.stats || {};
    // Count file actions from the log too; stats can be missing if rclone exits early.
    const copied = res.logs.filter((l) => l.object && /^Copied/.test((l.msg || '').trim())).length;
    const deleted = res.logs.filter((l) => l.object && /^Deleted|^Moved/.test((l.msg || '').trim())).length;
    const result = {
      item: item.name,
      ok: res.code === 0,
      code: res.code,
      resync,
      ms: res.ms,
      transfers: Math.max(s.transfers ?? 0, copied),
      bytes: s.bytes ?? 0,
      deletes: Math.max(s.deletes ?? 0, deleted),
      checks: s.checks ?? 0,
      errors: res.logs.filter((l) => l.level === 'error').map((l) => l.msg?.trim()).slice(0, 10),
    };
    result.inFlux = !result.ok && isInFlux(result.errors);
    // A resync compares everything at once and does not log single files.
    const changes = resync ? [] : parseChanges(res.logs, item.local, remote);
    result.changesKnown = !resync;
    result.changeCount = changes.length;
    result.changes = changes.slice(0, MAX_CHANGES);
    this.emit({ type: 'item-done', ...result, changes: undefined });
    return result;
  }

  /**
   * Sync items in order (settings first).
   * @param {{flavors?:string[], parts?:string[]}} [only]  limit to some game versions / parts
   */
  async syncAll(only = {}) {
    await this.prepare();
    this.runStamp = stamp();
    const items = this.cfg.items.filter((i) =>
      (!only.flavors || only.flavors.includes(i.flavor)) &&
      (!only.parts || only.parts.includes(i.name.split('/').pop())));
    this.cancelled = false;
    const results = [];
    for (const item of items) {
      if (this.cancelled) break;
      results.push(await this.syncItem(item));
    }
    const ok = !this.cancelled && results.every((r) => r.ok);
    return { ok, cancelled: !!this.cancelled, ms: results.reduce((a, r) => a + r.ms, 0), results, runStamp: this.runStamp };
  }

  // ---- backups (history) ----------------------------------------------------

  /**
   * Put files back to their version from before a sync, taken from that sync's backups.
   * The restored files get the current time, so the next sync treats them as the newest
   * version and sends them to the NAS. Whatever they replace is kept in the local history.
   * @param {object} o
   * @param {string} o.run       run stamp of the sync to undo
   * @param {string} o.machine   computer name that ran it (part of the NAS history folder)
   * @param {{name:string, local:string}} o.item
   * @param {{path:string, backup:'local'|'nas'}[]} o.files  paths relative to the item
   * @returns {Promise<{restored:number, missing:string[]}>}
   */
  async restoreFiles({ run, machine, item, files }) {
    const { stateDir, remoteRoot } = this.cfg;
    const safe = files.map((f) => ({ ...f, path: safeRel(f.path) })).filter((f) => f.path && (f.backup === 'local' || f.backup === 'nas'));
    // keep what is there now, in case the restore was a mistake
    const keep = path.join(stateDir, 'history', `${stamp()}-restore`, item.name);
    for (const f of safe) {
      const cur = path.join(item.local, f.path);
      if (existsSync(cur)) {
        await mkdir(path.dirname(path.join(keep, f.path)), { recursive: true });
        await copyFile(cur, path.join(keep, f.path));
      }
    }
    const sources = {
      local: path.join(stateDir, 'history', run, item.name),
      nas: joinRemote(remoteRoot, 'history', `${run}_${machine}`, item.name),
    };
    let restored = 0;
    const missing = [];
    for (const side of ['local', 'nas']) {
      const list = safe.filter((f) => f.backup === side).map((f) => f.path);
      if (!list.length) continue;
      const listFile = path.join(stateDir, `restore-${side}.txt`);
      await writeFile(listFile, list.join('\n') + '\n');
      // --ignore-times: copy even when size and time happen to match the current file
      const r = await this.run(['copy', sources[side], item.local, '--files-from-raw', listFile, '--no-traverse', '--ignore-times', '--transfers', '8']);
      await rm(listFile, { force: true });
      const copied = new Set(r.logs.filter((l) => l.object && /^Copied/.test((l.msg || '').trim())).map((l) => slash(l.object)));
      const now = new Date();
      for (const p of list) {
        if (!copied.has(p)) { missing.push(p); continue; }
        await utimes(path.join(item.local, p), now, now);
        restored++;
      }
    }
    if (!restored && missing.length) throw new Error('The backup of these files is no longer there.');
    return { restored, missing };
  }

  /**
   * Delete backups older than `days` here and this computer's backups on the NAS.
   * Other computers clean up their own NAS backups.
   * @returns {Promise<{local:number, nas:number}>} folders removed
   */
  async pruneHistory(days) {
    const { stateDir, remoteRoot, machine } = this.cfg;
    const cutoff = Date.now() - days * 86_400_000;
    const old = (name) => { const t = stampTime(name); return t && t.getTime() < cutoff; };
    let local = 0, nas = 0;
    for (const dir of ['history', 'runs']) {
      let names = [];
      try { names = await readdir(path.join(stateDir, dir)); } catch { continue; }
      for (const n of names.filter(old)) { await rm(path.join(stateDir, dir, n), { recursive: true, force: true }); if (dir === 'history') local++; }
    }
    const { code, out } = await this.raw(['lsjson', joinRemote(remoteRoot, 'history'), '--dirs-only']);
    if (code === 0) {
      let dirs = [];
      try { dirs = JSON.parse(out); } catch {}
      const mine = dirs.map((d) => d.Name).filter((n) => n.endsWith(`_${machine}`) && old(n));
      for (const n of mine) {
        const r = await this.run(['purge', joinRemote(remoteRoot, 'history', n)]);
        if (r.code === 0) nas++;
      }
    }
    return { local, nas };
  }

  // ---- computers ------------------------------------------------------------

  machinePath(id) { return joinRemote(this.cfg.remoteRoot, 'machines', `${id}.json`); }

  /** Every computer that uses this NAS folder, from the one-line files in machines/. */
  async listMachines() {
    const { code, out } = await this.raw(['cat', joinRemote(this.cfg.remoteRoot, 'machines'), '--include', '*.json']);
    if (code !== 0) return [];
    return out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.id);
  }

  async writeMachine(info) {
    const { code } = await this.raw(['rcat', this.machinePath(info.id)], JSON.stringify(info) + '\n');
    if (code !== 0) throw new Error(`could not write computer info (rclone exit ${code})`);
  }

  async deleteMachine(id) {
    const { code } = await this.raw(['deletefile', this.machinePath(id)]);
    return code === 0;
  }

  /** Stop a running sync. bisync's --recover lets the next run continue safely. */
  cancel() {
    this.cancelled = true;
    if (this.child) this.child.kill('SIGTERM');
  }

  // ---- in-use marker (one per game version) --------------------------------

  lockPath(flavor) { return joinRemote(this.cfg.remoteRoot, 'locks', `${flavor}.json`); }

  /** Run rclone and return raw stdout (for cat/rcat). */
  raw(args, input = '') {
    const { rclone, rcloneConfig } = this.cfg;
    const full = rcloneConfig ? [...args, '--config', rcloneConfig] : args;
    return new Promise((resolve, reject) => {
      const p = spawn(rclone, full, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, out }));
      p.stdin.end(input);
    });
  }

  async readLock(flavor) {
    const { code, out } = await this.raw(['cat', this.lockPath(flavor)]);
    if (code !== 0) return null;
    try { return JSON.parse(out); } catch { return null; }
  }

  async writeLock(flavor) {
    const body = JSON.stringify({ flavor, machine: this.cfg.machine, host: os.hostname(), since: new Date().toISOString() });
    const { code } = await this.raw(['rcat', this.lockPath(flavor)], body);
    if (code !== 0) throw new Error(`could not write lock (rclone exit ${code})`);
  }

  async clearLock(flavor) { await this.run(['deletefile', this.lockPath(flavor)]); }
}
