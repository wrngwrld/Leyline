// WoW game versions ("flavors"). Each one lives in its own folder under the WoW install,
// e.g. /Applications/World of Warcraft/_retail_ or C:\Program Files (x86)\World of Warcraft\_classic_era_.
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Display names for the folders Blizzard uses. Unknown folders still work, with a generated name. */
export const KNOWN_FLAVORS = {
  _retail_: 'Retail',
  _ptr_: 'Retail PTR',
  _xptr_: 'Retail Experimental PTR',
  _beta_: 'Retail Beta',
  _classic_: 'Classic',
  _classic_ptr_: 'Classic PTR',
  _classic_beta_: 'Classic Beta',
  _classic_era_: 'Classic Era',
  _classic_era_ptr_: 'Classic Era PTR',
  _anniversary_: 'Classic Anniversary',
  _forever_: 'Forever',
};

/** The parts of a flavor folder that get synced, settings first so they are safe soonest. */
export const PARTS = [
  { part: 'Account', rel: ['WTF', 'Account'], kind: 'settings' },
  { part: 'SavedVariables', rel: ['WTF', 'SavedVariables'], kind: 'settings' },
  { part: 'AddOns', rel: ['Interface', 'AddOns'], kind: 'addons' },
];

export function flavorName(id) {
  if (KNOWN_FLAVORS[id]) return KNOWN_FLAVORS[id];
  const words = id.replace(/^_+|_+$/g, '').split('_').filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function defaultWowRoot(platform = process.platform) {
  if (platform === 'darwin') return '/Applications/World of Warcraft';
  if (platform === 'win32') return 'C:\\Program Files (x86)\\World of Warcraft';
  return '';
}

const isDir = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

/** Common install locations, most likely first. */
export function wowRootCandidates(platform = process.platform) {
  if (platform === 'darwin') return ['/Applications/World of Warcraft'];
  if (platform !== 'win32') return [];
  const out = ['C:\\Program Files (x86)\\World of Warcraft', 'C:\\Program Files\\World of Warcraft'];
  for (const d of 'CDEFG') out.push(`${d}:\\Games\\World of Warcraft`, `${d}:\\World of Warcraft`, `${d}:\\Battle.net\\World of Warcraft`);
  return out;
}

/** First candidate that exists, or the platform default. */
export async function findWowRoot(platform = process.platform) {
  for (const c of wowRootCandidates(platform)) if (await isDir(c)) return c;
  return defaultWowRoot(platform);
}

/** Find installed flavors under a WoW root. Returns [{id, name, hasSettings, hasAddons}]. */
export async function detectFlavors(wowRoot) {
  let entries;
  try { entries = await readdir(wowRoot, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!/^_[a-z0-9_]+_$/i.test(e.name)) continue;
    const dir = path.join(wowRoot, e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && await isDir(dir)))) continue;
    const hasSettings = await isDir(path.join(dir, 'WTF'));
    const hasAddons = await isDir(path.join(dir, 'Interface', 'AddOns'));
    if (!hasSettings && !hasAddons) continue;
    out.push({ id: e.name, name: flavorName(e.name), hasSettings, hasAddons });
  }
  const order = Object.keys(KNOWN_FLAVORS);
  return out.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
}

// rclone glob characters in a folder name must not act as wildcards
const glob = (name) => name.replace(/[\\*?[\]{}]/g, (c) => `\\${c}`);

/**
 * rclone filter lines that leave out single addons for one part of a flavor.
 * skip.addons: addon folders under Interface/AddOns; skip.settings: their <Name>.lua files
 * under WTF (WoW names an addon's saved settings after its folder).
 */
export function skipFilters(part, skip = {}) {
  const lines = [];
  if (part === 'AddOns') for (const n of skip.addons || []) lines.push(`- /${glob(n)}/**`);
  if (part === 'Account') for (const n of skip.settings || []) lines.push(`- **/SavedVariables/${glob(n)}.lua`);
  if (part === 'SavedVariables') for (const n of skip.settings || []) lines.push(`- /${glob(n)}.lua`);
  return lines;
}

/**
 * Turn settings into engine items.
 * @param {string} wowRoot
 * @param {{id:string, enabled?:boolean, addons?:boolean, skip?:{addons?:string[], settings?:string[]}}[]} flavors
 *   addons:false syncs only settings for that flavor (e.g. when an addon manager handles it);
 *   skip leaves out single addons on this computer.
 */
export function buildItems(wowRoot, flavors) {
  const items = [];
  const enabled = flavors.filter((f) => f.enabled !== false);
  // All settings of all flavors first, then addons: settings are small and matter most.
  for (const kind of ['settings', 'addons']) {
    for (const f of enabled) {
      for (const p of PARTS.filter((x) => x.kind === kind)) {
        if (p.kind === 'addons' && f.addons === false) continue;
        items.push({ name: `${f.id}/${p.part}`, flavor: f.id, kind: p.kind, local: path.join(wowRoot, f.id, ...p.rel), filters: skipFilters(p.part, f.skip) });
      }
    }
  }
  return items;
}

/** Addon folders installed for a flavor, with their title from the .toc file. */
export async function listAddons(wowRoot, flavor) {
  const dir = path.join(wowRoot, flavor, 'Interface', 'AddOns');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!(e.isDirectory() || (e.isSymbolicLink() && await isDir(path.join(dir, e.name))))) continue;
    if (e.name.startsWith('.')) continue;
    out.push({ name: e.name, title: await tocTitle(path.join(dir, e.name), e.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function tocTitle(dir, name) {
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.toc')); } catch { return ''; }
  // prefer <Name>.toc, then any flavor-specific one (<Name>_Mainline.toc, …)
  files.sort((a, b) => (b.toLowerCase() === `${name.toLowerCase()}.toc`) - (a.toLowerCase() === `${name.toLowerCase()}.toc`));
  for (const f of files) {
    try {
      const m = /^##\s*Title:\s*(.+)$/m.exec(await readFile(path.join(dir, f), 'utf8'));
      // drop WoW color codes and texture tags
      if (m) return m[1].replace(/\|c[0-9a-f]{8}|\|r|\|T[^|]*\|t|\|A[^|]*\|a/gi, '').trim();
    } catch {}
  }
  return '';
}
