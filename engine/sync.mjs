// Leyline sync engine: two-way sync of WoW folders against a NAS using rclone bisync.
// Used by the CLI now and by the Electron main process later.
//
// An item is one synced folder, named "<flavor>/<part>", e.g. "_retail_/Account".
//
// Remote layout (root = NAS folder or rclone remote path):
//   <root>/current/<flavor>/<part>                    live copy every machine syncs against
//   <root>/history/<stamp>_<machine>/<flavor>/<part>  files replaced or deleted by a sync
//   <root>/locks/<flavor>.json                        who is playing that game version now
//
// Local state per machine (stateDir):
//   bisync/<flavor>/<part>/      rclone bisync listings (which files each side had)
//   history/<stamp>/<flavor>/<part>  local files replaced by a sync
//   filters.txt                  exclude rules

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
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

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const joinRemote = (root, ...parts) => [root.replace(/\/+$/, ''), ...parts].join('/');

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
      const p = spawn(rclone, full, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env() });
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
    if (resync) args.push('--resync', '--resync-mode', 'newer');

    this.emit({ type: 'item-start', item: item.name, resync });
    let res = await this.run(args);

    // bisync refuses to continue after some failures until a resync. Newer-wins plus the
    // backup dirs keep that safe, so retry once instead of leaving the user stuck.
    const needsResync = res.logs.some((l) => /--resync|must run --resync|cannot find prior/i.test(l.msg || ''));
    if (res.code !== 0 && !resync && needsResync && !this.cancelled) {
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
    this.emit({ type: 'item-done', ...result });
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
    return { ok, cancelled: !!this.cancelled, ms: results.reduce((a, r) => a + r.ms, 0), results };
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
      const p = spawn(rclone, full, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env() });
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
