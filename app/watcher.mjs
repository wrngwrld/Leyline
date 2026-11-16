// Watches the synced folders of each game version and reports when they have *settled*:
// changes stopped for `quietMs`. An addon manager replacing addons (0.1 s each, or a minute
// for "update all") then leads to one sync of the finished state instead of a half-done one.
import { watch } from 'node:fs';
import { realpath } from 'node:fs/promises';

// Files that never matter for syncing (same spirit as the engine's exclude list).
const NOISE = /(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^\\/]*)$|\.(bak|old|tmp)$/i;

/**
 * Which paths a sync wrote itself, from its results: files that came in from the NAS (rclone
 * writes them via a temporary "<name>.<id>.partial" file) and the folders whose times it set.
 * Without a complete file list (a full comparison), everything in that folder counts as its own.
 * @returns {(name:string, rel:string)=>boolean}
 */
// Windows compares file names without regard to case, and may report them in another case.
const norm = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;

export function ownWrites(results) {
  const own = new Map();
  for (const x of results) {
    if (!x.changesKnown || x.changeCount > (x.changes?.length || 0)) { own.set(x.item, 'all'); continue; }
    const set = new Set(['']);
    for (const c of x.changes || []) {
      if (c.dir === 'in') set.add(norm(c.path));
      const parts = c.path.split('/');
      for (let i = 1; i < parts.length; i++) set.add(norm(parts.slice(0, i).join('/')));
    }
    own.set(x.item, set);
  }
  return (name, rel) => {
    const o = own.get(name);
    if (o === 'all') return true;
    return !!o && o.has(norm(rel.replace(/\.[0-9a-z]+\.partial$/i, '')));
  };
}

export class FolderWatcher {
  /**
   * @param {object} opts
   * @param {number} [opts.quietMs]   how long a folder must stay unchanged before it counts as settled
   * @param {number} [opts.maxWaitMs] settle anyway after this long, even if changes keep coming
   * @param {(flavor:string)=>void} opts.onSettled
   * @param {(pending:string[])=>void} [opts.onPending]  flavors with changes waiting to settle
   */
  constructor({ quietMs = 30_000, maxWaitMs = 180_000, onSettled, onPending = () => {} }) {
    Object.assign(this, { quietMs, maxWaitMs, onSettled, onPending });
    this.watchers = [];
    this.timers = new Map();   // flavor -> settle timer
    this.firstAt = new Map();  // flavor -> time of first change in the current burst
    this.held = new Map();     // flavor -> {count, events: [{name, rel}]} while Leyline itself syncs it
    this.recent = [];          // [{flavors, isOwn, until}]: a finished sync's own writes, for late reports
  }

  /** (Re)start watching. @param {{flavor:string, local:string, name?:string}[]} items */
  async start(items) {
    this.stop();
    for (const it of items) await this.add(it.flavor, it.local, it.name);
  }

  async add(flavor, local, name = flavor) {
    let dir;
    try { dir = await realpath(local); } catch { return; } // folder doesn't exist (yet)
    try {
      const w = watch(dir, { recursive: true, persistent: false }, (_type, file) => {
        if (file && NOISE.test(String(file))) return;
        const held = this.held.get(flavor);
        const rel = String(file || '').replace(/\\/g, '/');
        if (held) { held.events.push({ name, rel }); return; }
        // the file system can report a big sync's writes well after it finished
        if (this.isRecentOwn(flavor, name, rel)) return;
        this.touch(flavor);
      });
      const entry = { flavor, local, w };
      w.on('error', () => {
        // e.g. the folder was deleted and recreated: drop this watcher and try again shortly
        w.close();
        this.watchers = this.watchers.filter((x) => x !== entry);
        setTimeout(() => { if (this.active) this.add(flavor, local, name); }, 10_000);
      });
      this.watchers.push(entry);
      this.active = true;
    } catch { /* watching unsupported here: the interval sync still covers it */ }
  }

  stop() {
    this.active = false;
    for (const { w } of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.firstAt.clear();
    this.onPending([]);
  }

  /** A change happened in a flavor's folders: restart its quiet-period timer. */
  touch(flavor) {
    const now = Date.now();
    if (!this.firstAt.has(flavor)) this.firstAt.set(flavor, now);
    clearTimeout(this.timers.get(flavor));
    const waited = now - this.firstAt.get(flavor);
    const delay = Math.max(0, Math.min(this.quietMs, this.maxWaitMs - waited));
    this.timers.set(flavor, setTimeout(() => this.settle(flavor), delay));
    this.onPending(this.pending());
  }

  settle(flavor) {
    this.timers.delete(flavor);
    this.firstAt.delete(flavor);
    this.onPending(this.pending());
    this.onSettled(flavor);
  }

  pending() { return [...this.timers.keys()]; }

  isRecentOwn(flavor, name, rel) {
    const now = Date.now();
    return this.recent.some((r) => r.until > now && r.flavors.has(flavor) && r.isOwn(name, rel));
  }

  /**
   * Leyline is about to sync these versions: collect changes instead of reacting to them,
   * because most will be Leyline's own writes. Changes seen before now are covered by the sync.
   */
  hold(flavors) {
    for (const f of flavors) {
      const h = this.held.get(f) || { count: 0, events: [] };
      h.count++;
      this.held.set(f, h);
      clearTimeout(this.timers.get(f));
      this.timers.delete(f);
      this.firstAt.delete(f);
    }
    this.onPending(this.pending());
  }

  /**
   * The sync is done. Changes that are not Leyline's own writes count as real ones.
   * @param {string[]} flavors
   * @param {(name:string, rel:string)=>boolean} isOwn  true for a path the sync itself wrote
   */
  release(flavors, isOwn, graceMs = 60_000) {
    const now = Date.now();
    this.recent = this.recent.filter((r) => r.until > now);
    this.recent.push({ flavors: new Set(flavors), isOwn, until: now + graceMs });
    for (const f of flavors) {
      const h = this.held.get(f);
      if (!h || --h.count > 0) continue;
      this.held.delete(f);
      if (h.events.some((e) => !isOwn(e.name, e.rel) && !this.isRecentOwn(f, e.name, e.rel))) this.touch(f);
    }
  }
}
