// WoW game versions ("flavors"). Each one lives in its own folder under the WoW install,
// e.g. /Applications/World of Warcraft/_retail_ or C:\Program Files (x86)\World of Warcraft\_classic_era_.
import { readdir, stat } from 'node:fs/promises';
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

/**
 * Turn settings into engine items.
 * @param {string} wowRoot
 * @param {{id:string, enabled?:boolean, addons?:boolean}[]} flavors
 *   addons:false syncs only settings for that flavor (e.g. when an addon manager handles it).
 */
export function buildItems(wowRoot, flavors) {
  const items = [];
  const enabled = flavors.filter((f) => f.enabled !== false);
  // All settings of all flavors first, then addons: settings are small and matter most.
  for (const kind of ['settings', 'addons']) {
    for (const f of enabled) {
      for (const p of PARTS.filter((x) => x.kind === kind)) {
        if (p.kind === 'addons' && f.addons === false) continue;
        items.push({ name: `${f.id}/${p.part}`, flavor: f.id, kind: p.kind, local: path.join(wowRoot, f.id, ...p.rel) });
      }
    }
  }
  return items;
}
