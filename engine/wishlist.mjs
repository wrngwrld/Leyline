// The "to try" list: addons a person wants to look at later. Entries are small JSON files in
// <NAS folder>/wishlist/, one per addon, so two computers never overwrite each other's list.
import { createHash } from 'node:crypto';

const pretty = (slug) => decodeURIComponent(slug).split(/[-_+.]+|\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Recognise an addon link. Returns { url, source, name } or null when it is not an http(s) link.
 * The url is normalised so that the same addon pasted twice ends up as one entry.
 */
export function parseLink(input) {
  let text = String(input || '').trim().split(/\s+/)[0];
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname.includes('.')) return null; // plain words are not links
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'curseforge.com' && parts[0] === 'wow' && parts[1] === 'addons' && parts[2])
    return { url: `https://www.curseforge.com/wow/addons/${parts[2].toLowerCase()}`, source: 'CurseForge', name: pretty(parts[2]) };
  if (host === 'addons.wago.io' && parts[0] === 'addons' && parts[1])
    return { url: `https://addons.wago.io/addons/${parts[1].toLowerCase()}`, source: 'Wago', name: pretty(parts[1]) };
  if (host === 'wowinterface.com' && parts[0] === 'downloads') {
    const m = /^info(\d+)(?:-(.+?))?(?:\.html)?$/i.exec(parts[1] || '');
    if (m) return { url: `https://www.wowinterface.com/downloads/info${m[1]}${m[2] ? `-${m[2]}` : ''}.html`, source: 'WoWInterface', name: m[2] ? pretty(m[2]) : `WoWInterface addon ${m[1]}` };
  }
  if (host === 'github.com' && parts[0] && parts[1]) {
    const repo = parts[1].replace(/\.git$/, '');
    return { url: `https://github.com/${parts[0]}/${repo}`, source: 'GitHub', name: pretty(repo) };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/$/, '')}${u.search}`, source: host, name: parts.length ? pretty(parts.at(-1).replace(/\.\w+$/, '')) : host };
}

/** Same addon, same id: the file name on the NAS. */
export const entryId = (url) => createHash('sha1').update(url.toLowerCase()).digest('hex').slice(0, 10);

/** A new entry from pasted text, or null if it is not a link. */
export function newEntry(input, note = '', by = '', now = new Date()) {
  const p = parseLink(input);
  if (!p) return null;
  return { id: entryId(p.url), url: p.url, source: p.source, name: p.name, note: String(note || '').trim().slice(0, 300), status: 'todo', added: now.toISOString(), by };
}

/** The CurseForge search page for a name. */
export const searchUrl = (query) => `https://www.curseforge.com/wow/search?page=1&pageSize=20&sortBy=popularity&class=addons&search=${encodeURIComponent(query)}`;

/** Text a person typed instead of a link, cleaned up. Empty when there is nothing to search for. */
export const cleanQuery = (text) => String(text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** An addon known only by name: found on the desktop later, with the CurseForge search. */
export function newSearchEntry(query, note = '', by = '', now = new Date()) {
  const q = cleanQuery(query);
  if (q.length < 2 || !/[\p{L}\p{N}]/u.test(q)) return null;
  return { id: entryId(`search:${q}`), url: searchUrl(q), source: 'Search', name: q, query: q, note: String(note || '').trim().slice(0, 300), status: 'todo', added: now.toISOString(), by };
}

const simple = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Is this wishlist entry among a computer's installed addons?
 * @param {{name:string, url:string}} entry
 * @param {Record<string, Record<string, {t?:string}>>} addons  { flavor: { folder: {v, t} } }
 */
export function isInstalled(entry, addons) {
  const slug = entry.source === 'Search' ? '' : simple(entry.url.split('/').filter(Boolean).at(-1)?.replace(/^info\d+-?/i, '').replace(/\.html$/i, ''));
  const keys = [...new Set([simple(entry.name), slug].filter((k) => k.length >= 3))];
  for (const folders of Object.values(addons || {})) {
    for (const [folder, a] of Object.entries(folders || {})) {
      const f = simple(folder), t = simple(a?.t);
      for (const k of keys) {
        if (f === k || (t && t === k)) return true;
        // "details-damage-meter" for the folder "Details", "weakauras-2" for "WeakAuras"
        if (f.length >= 5 && k.startsWith(f)) return true;
        if (t.length >= 5 && k.startsWith(t)) return true;
      }
    }
  }
  return false;
}
