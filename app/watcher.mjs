// Watches the synced folders of each game version and reports when they have *settled*:
// changes stopped for `quietMs`. An addon manager replacing addons (0.1 s each, or a minute
// for "update all") then leads to one sync of the finished state instead of a half-done one.
import { watch } from 'node:fs';
import { realpath } from 'node:fs/promises';

// Files that never matter for syncing (same spirit as the engine's exclude list).
const NOISE = /(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^\\/]*)$|\.(bak|old|tmp)$/i;

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
  }

  /** (Re)start watching. @param {{flavor:string, local:string}[]} items */
  async start(items) {
    this.stop();
    for (const it of items) await this.add(it.flavor, it.local);
  }

  async add(flavor, local) {
    let dir;
    try { dir = await realpath(local); } catch { return; } // folder doesn't exist (yet)
    try {
      const w = watch(dir, { recursive: true, persistent: false }, (_type, file) => {
        if (file && NOISE.test(String(file))) return;
        this.touch(flavor);
      });
      const entry = { flavor, local, w };
      w.on('error', () => {
        // e.g. the folder was deleted and recreated: drop this watcher and try again shortly
        w.close();
        this.watchers = this.watchers.filter((x) => x !== entry);
        setTimeout(() => { if (this.active) this.add(flavor, local); }, 10_000);
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
}
