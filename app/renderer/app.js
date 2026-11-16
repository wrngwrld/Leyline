// Leyline window. Talks to the main process only through window.leyline (see preload.cjs).
const api = window.leyline;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let data = null;
let page = 'overview';

if (navigator.userAgent.includes('Windows')) document.body.classList.add('win');

// ---- formatting -----------------------------------------------------------

const FLAVOR_STYLE = {
  _retail_: ['R', 42], _ptr_: ['P', 42], _xptr_: ['X', 42], _beta_: ['B', 42],
  _classic_: ['C', 212], _classic_ptr_: ['P', 212], _classic_beta_: ['B', 250],
  _classic_era_: ['E', 22], _classic_era_ptr_: ['P', 22],
  _anniversary_: ['A', 330], _forever_: ['F', 160],
};
const flavorName = (id) => data?.state.detected.find((d) => d.id === id)?.name
  || id.replace(/^_+|_+$/g, '').split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const badge = (id) => {
  const [l, h] = FLAVOR_STYLE[id] || [flavorName(id)[0], 270];
  return `<div class="mono-badge" style="--h:${h}">${esc(l)}</div>`;
};

function rel(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dur = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const bytes = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n < 104857600 ? 1 : 0)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const left = (s) => (s == null ? '' : s < 60 ? 'less than a minute left' : s < 3600 ? `about ${Math.round(s / 60)} min left` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const TRIGGERS = { manual: 'Manual', auto: 'Automatic', 'game-closed': 'After playing', startup: 'At startup', 'files-changed': 'Files changed', restore: 'Restore', 'addons-changed': 'Addon choice', 'first-sync': 'First sync' };

const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  sync: '<path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L19.5 9"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1L4.5 15"/><path d="M4.5 19.5V15H9"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
};
const svg = (name, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}">${ICON[name]}</svg>`;

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${svg(bad ? 'x' : 'check', 'h-ic')}<span>${esc(text)}</span>`;
  el.querySelector('svg').style.cssText = `width:16px;height:16px;fill:none;stroke:var(${bad ? '--bad' : '--ok'});stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;flex:none`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, bad ? 6000 : 3600);
}

// ---- shared pieces --------------------------------------------------------

const machineLabel = () => (data.platform === 'darwin' ? 'This Mac' : 'This PC');

function renderMachine() {
  const { state, settings } = data;
  let dot = 'ok', text = `In sync · ${rel(state.lastSync)}`;
  if (!state.configured) { dot = 'warn'; text = 'Not set up yet'; }
  else if (state.status === 'syncing') { dot = 'busy'; text = 'Syncing…'; }
  else if (state.status === 'error') { dot = 'bad'; text = 'Last sync failed'; }
  else if (state.running.length) { dot = 'warn'; text = `Playing ${state.running.map(flavorName).join(', ')}`; }
  else if (!state.lastSync) { dot = ''; text = 'Waiting for first sync'; }
  $('#machine').innerHTML = `<span class="dot ${dot}"></span><span class="m-name">${esc(settings.machine)}</span><span class="m-status">${esc(text)}</span>`;
}

// ---- updates --------------------------------------------------------------

function renderUpdate() {
  const u = data.update;
  const slot = $('#update-slot');
  if (u?.status === 'ready') {
    const busy = data.state.status === 'syncing';
    slot.innerHTML = `<button class="update-card" data-act="install-update" ${busy ? 'disabled' : ''}>
      <span class="u-title">Leyline ${esc(u.version)} is ready</span>
      <span class="u-sub">${busy ? 'Installs after this sync' : 'Restart now to update'}</span></button>`;
  } else if (u?.status === 'downloading') {
    slot.innerHTML = `<div class="update-card"><span class="u-title">Downloading Leyline ${esc(u.version)}</span>
      <span class="u-sub">${u.percent ?? 0}%</span><div class="u-bar"><span style="width:${u.percent ?? 0}%"></span></div></div>`;
  } else {
    slot.innerHTML = '';
  }
}

function updateRow() {
  const u = data.update || { status: 'unsupported' };
  const text = {
    unsupported: 'Updates are only installed in the released app.',
    idle: 'Leyline checks for updates automatically.',
    checking: 'Checking for updates…',
    latest: 'You have the newest version.',
    downloading: `Downloading ${esc(u.version)}: ${u.percent ?? 0}%.`,
    ready: `Version ${esc(u.version)} is ready and installs when Leyline restarts.`,
    error: esc(u.error || 'Could not check for updates.'),
  }[u.status];
  const button = u.status === 'ready'
    ? `<button class="btn primary" data-act="install-update" ${data.state.status === 'syncing' ? 'disabled' : ''}>Restart now</button>`
    : `<button class="btn" data-act="check-updates" ${['unsupported', 'checking', 'downloading'].includes(u.status) ? 'disabled' : ''}>${svg('sync')}Check for updates</button>`;
  return `<div class="s-text"><div class="s-title">Leyline ${esc(data.version)}</div>
    <div class="s-sub">${text} Open source, MIT licensed. Not affiliated with Blizzard Entertainment.</div></div>${button}`;
}

function scene() {
  // Three nodes linked by ley lines: this computer — NAS — your other computers.
  const motes = [[120, 112], [160, 82], [262, 84], [300, 118], [188, 74]].map(([x, y], i) =>
    `<circle class="mote on" cx="${x}" cy="${y}" r="1.6" style="animation-delay:${i * 1.1}s"/>`).join('');
  return `
  <svg class="scene" viewBox="0 0 420 200" aria-hidden="true">
    <defs>
      <linearGradient id="ley" x1="0" x2="1"><stop offset="0" stop-color="var(--ley-a)"/><stop offset="1" stop-color="var(--ley-b)"/></linearGradient>
      <radialGradient id="halo"><stop offset="0" stop-color="var(--ley-b)" stop-opacity=".35"/><stop offset="1" stop-color="var(--ley-b)" stop-opacity="0"/></radialGradient>
    </defs>
    <path class="path" d="M72 132 C 132 132, 150 70, 210 70"/>
    <path class="path dash" d="M210 70 C 270 70, 288 132, 348 132"/>
    <path class="flow" d="M72 132 C 132 132, 150 70, 210 70"/>
    <path class="flow f2" d="M210 70 C 150 70, 132 132, 72 132"/>
    ${motes}
    <circle class="halo" cx="210" cy="70" r="54"/>
    <g transform="translate(46 106)"><rect class="node-bg" width="52" height="52" rx="16"/>
      <g class="node-ic" transform="translate(14 15)"><rect x="2" y="1" width="20" height="14" rx="2"/><path d="M0 20h24"/></g></g>
    <g transform="translate(182 42)"><rect class="node-bg" width="56" height="56" rx="17" style="stroke:url(#ley);stroke-width:1.4"/>
      <g class="node-ic" transform="translate(16 15)"><rect x="0" y="0" width="24" height="10" rx="2.5"/><rect x="0" y="14" width="24" height="10" rx="2.5"/><path d="M5 5h.01M5 19h.01"/></g></g>
    <g transform="translate(322 106)"><rect class="node-bg" width="52" height="52" rx="16" style="stroke-dasharray:3 4"/>
      <g class="node-ic" transform="translate(14 14)" style="opacity:.7"><rect x="1" y="1" width="22" height="16" rx="2"/><path d="M8 23h8M12 17v6"/></g></g>
    <text x="72" y="178">${esc(machineLabel())}</text>
    <text x="210" y="122">NAS</text>
    <text x="348" y="178">Other computers</text>
  </svg>`;
}

// ---- pages ----------------------------------------------------------------

const syncLabel = (p) => `${p.label[0].toUpperCase() + p.label.slice(1)}. Settings go first, so they are safe within seconds.`;
/**
 * Progress of the step that is running, by bytes (or files). Steps differ hugely in size
 * (settings are a few MB, addons gigabytes), so counting steps would mislead.
 */
function syncPct(p) {
  if (p.resync) return 100; // shown as a moving bar: the totals are not known yet
  const x = p.xfer;
  const frac = x?.totalBytes ? x.bytes / x.totalBytes : x?.totalTransfers ? x.transfers / x.totalTransfers : 0;
  return Math.max(3, Math.min(100, frac * 100));
}
function syncMeta(p) {
  const x = p.xfer;
  const step = `Step ${p.index || 1} of ${p.total || '…'}`;
  if (!x || !x.totalTransfers) return [`${step} · comparing files…`, ""];
  const speed = x.speed ? `${bytes(x.speed)}/s` : '';
  // A full comparison finds files while it copies, so its totals keep growing:
  // show only what is done, not a percentage or time left that would be wrong.
  if (p.resync) return [`${step} · comparing everything · ${plural(x.transfers, 'file')}, ${bytes(x.bytes)} so far`, speed];
  return [
    `${x.transfers.toLocaleString()} of ${plural(x.totalTransfers, 'file')} · ${bytes(x.bytes)} of ${bytes(x.totalBytes)}`,
    [speed, left(x.eta)].filter(Boolean).join(' · '),
  ];
}

/** Which hero card to show; the card is rebuilt only when this changes. */
function heroMode() {
  const { state } = data;
  if (!state.configured) return 'setup';
  if (state.status === 'syncing') return 'syncing';
  if (state.status === 'error') return 'error';
  if (state.running.length) return 'playing';
  return state.lastSync ? 'ok' : 'ready';
}

function heroContent() {
  const { state, settings, history } = data;
  if (!state.configured) {
    const nasDone = settings.nas.host && settings.nas.share && settings.hasPassword;
    const verDone = settings.flavors.some((f) => f.enabled);
    const step = (n, done, title, sub, target) => `
      <div class="step ${done ? 'done' : ''}" data-go="${target}">
        <div class="num">${done ? svg('check').replace('<svg', '<svg style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.6"') : n}</div>
        <div><div class="s-title">${title}</div><div class="s-sub">${sub}</div></div>${svg('chev', 'chev')}
      </div>`;
    return `
      <div>
        <span class="status-eyebrow"><span class="dot warn"></span>Welcome</span>
        <h2>Link your computers</h2>
        <p>Leyline keeps your WoW settings and addons in sync through your own NAS, so you can start playing right away on any machine.</p>
        <div class="steps">
          ${step(1, nasDone, 'Connect your NAS', 'Address, share and login', 'nas')}
          ${step(2, verDone, 'Choose game versions', 'Retail, Classic, Forever and more', 'versions')}
        </div>
      </div>`;
  }
  if (state.status === 'syncing') {
    const p = state.progress || { index: 0, total: 0, files: 0, label: 'starting' };
    const pct = syncPct(p);
    return `
      <div>
        <span class="status-eyebrow"><span class="dot busy"></span>Syncing</span>
        <h2>Weaving your settings together</h2>
        <p class="js-label">${esc(syncLabel(p))}</p>
        <div class="row"><button class="btn" data-act="cancel">${svg('stop')}Stop</button></div>
        <div class="progress"><div class="bar ${p.resync ? 'sweep' : ''}"><i class="js-bar" style="width:${pct}%"></i></div>
          <div class="meta"><span class="js-step">${esc(syncMeta(p)[0])}</span><span class="js-files">${esc(syncMeta(p)[1])}</span></div></div>
      </div>`;
  }
  if (state.status === 'error') {
    return `
      <div>
        <span class="status-eyebrow"><span class="dot bad"></span>Sync failed</span>
        <h2>Something got in the way</h2>
        <p>${esc(state.lastError || 'The last sync did not finish.')} Nothing was lost: Leyline only replaces files after keeping the old ones in history.</p>
        <div class="row"><button class="btn primary" data-act="sync">${svg('sync')}Try again</button><button class="btn ghost" data-go="nas">Check NAS settings</button></div>
      </div>`;
  }
  if (state.running.length) {
    const names = state.running.map(flavorName).join(' and ');
    return `
      <div>
        <span class="status-eyebrow"><span class="dot warn"></span>In game</span>
        <h2>Enjoy your session</h2>
        <p>${esc(names)} is running. Leyline waits until you close it, then saves your settings to the NAS straight away.</p>
        <div class="row"><button class="btn" data-go="history">View history</button></div>
      </div>`;
  }
  if (!state.lastSync) {
    return `
      <div>
        <span class="status-eyebrow"><span class="dot"></span>Ready</span>
        <h2>Ready for the first sync</h2>
        <p>The first sync compares this computer with the NAS and copies whatever is missing. Newer files win; anything replaced is kept in history.</p>
        <div class="row"><button class="btn primary" data-act="sync">${svg('sync')}Start first sync</button></div>
      </div>`;
  }
  const last = history.find((h) => h.ok);
  const changed = last ? (last.transfers ? `${plural(last.transfers, 'file')} updated` : 'nothing needed changing') : '';
  return `
    <div>
      <span class="status-eyebrow"><span class="dot ok"></span>In sync</span>
      <h2>Everything is in sync</h2>
      <p>Last sync ${rel(state.lastSync)}${changed ? `, ${changed}` : ''}. ${settings.autoSync ? `Leyline syncs right after you close the game or update addons, and checks the NAS every ${settings.syncIntervalMin} minutes.` : 'Automatic sync is off.'}</p>
      <div class="row"><button class="btn primary" data-act="sync">${svg('sync')}Sync now</button><button class="btn ghost" data-go="history">View history</button></div>
    </div>`;
}

function versionTiles() {
  const { settings, state, history } = data;
  const enabled = settings.flavors.filter((f) => f.enabled);
  if (!enabled.length) return '';
  const lastFor = (id) => history.find((h) => h.ok && h.items.some((i) => i.item.startsWith(id + '/')))?.time;
  return `
    <div class="section-title"><h3>Game versions</h3><a data-go="versions">Manage</a></div>
    <div class="tiles">${enabled.map((f) => {
      const playing = state.running.includes(f.id);
      const syncing = state.status === 'syncing' && state.progress?.item?.startsWith(f.id + '/');
      const pending = (state.pending || []).includes(f.id);
      const pill = playing ? '<span class="pill play">Playing now</span>'
        : syncing ? '<span class="pill busy">Syncing</span>'
        : pending ? '<span class="pill busy" title="Leyline syncs once the files stop changing">Changes detected</span>'
        : lastFor(f.id) ? `<span class="pill ok">Synced ${rel(lastFor(f.id))}</span>` : '<span class="pill">Not synced yet</span>';
      return `<div class="tile"><div class="t-top">${badge(f.id)}<div><div class="t-name">${esc(flavorName(f.id))}</div>
        <div class="t-sub">${f.addons === false ? 'Settings only' : 'Settings and addons'}</div></div></div><div>${pill}</div></div>`;
    }).join('')}</div>`;
}

function historyRows(items) {
  return items.map((h) => {
    const ic = h.cancelled || h.inFlux ? svg('stop', 'h-ic off') : h.ok ? svg('check', 'h-ic ok') : svg('x', 'h-ic bad');
    const title = h.cancelled ? 'Stopped' : h.inFlux ? 'Files were still changing, retried later'
      : !h.ok ? 'Sync failed' : h.transfers ? `Synced ${plural(h.transfers, 'file')}` : 'Checked, nothing to change';
    const versions = [...new Set(h.items.map((i) => i.item.split('/')[0]))].map(flavorName).join(', ');
    const err = !h.ok && !h.cancelled && !h.inFlux ? h.items.find((i) => !i.ok)?.error : '';
    const open = h.run && openRun === h.run;
    return `<div class="hrow ${h.run ? 'clickable' : ''} ${open ? 'open' : ''}" ${h.run ? `data-run="${esc(h.run)}"` : ''}>${ic}
      <div class="h-main"><div class="h-title">${title}</div><div class="h-sub">${esc(err || versions)}</div></div>
      <span class="pill">${TRIGGERS[h.trigger] || h.trigger}</span>
      <div class="h-num">${dur(h.ms)}</div>
      <div class="h-num">${esc(when(h.time))}</div>
      ${h.run ? svg('chev', 'h-chev') : '<span></span>'}</div>${open ? runDetailsHtml(h.run) : ''}`;
  }).join('');
}

// ---- per-addon choices ----------------------------------------------------

let openAddons = null;            // flavor id whose addon list is open on the Game versions page
const addonCache = new Map();     // flavor id -> [{name, title}]
let addonQuery = '';

function skipSummary(f) {
  const a = f.skip?.addons?.length || 0, st = f.skip?.settings?.length || 0;
  if (!a && !st) return 'Every addon syncs · Choose…';
  const parts = [a && `${plural(a, 'addon')} not synced`, st && `${st} with settings only here`].filter(Boolean);
  return `${parts.join(', ')} · Change…`;
}

function addonPanel(f) {
  const list = addonCache.get(f.id);
  if (!list) return `<div class="apanel"><div class="d-note">Looking for addons…</div></div>`;
  const skipA = new Set(f.skip?.addons || []), skipS = new Set(f.skip?.settings || []);
  // addons that are skipped but no longer installed stay listed, so they can be switched back on
  const names = [...new Map([...[...skipA, ...skipS].map((name) => ({ name, title: '' })), ...list].map((x) => [x.name, x])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const filesOff = f.addons === false;
  const rows = names.map((x) => {
    const hide = addonQuery && !`${x.name} ${x.title}`.toLowerCase().includes(addonQuery.toLowerCase());
    return `<div class="arow" data-flavor="${esc(f.id)}" data-name="${esc(x.name)}" ${hide ? 'hidden' : ''}>
      <div class="a-name"><span class="mono">${esc(x.name)}</span>${x.title && x.title !== x.name ? `<small>${esc(x.title)}</small>` : ''}${!list.some((l) => l.name === x.name) ? '<small>not installed here</small>' : ''}</div>
      <label class="toggle sm" title="${filesOff ? 'Addons are switched off for this whole version' : 'The addon folder in Interface/AddOns'}">Files <span class="switch"><input type="checkbox" data-a="addons" ${!skipA.has(x.name) && !filesOff ? 'checked' : ''} ${filesOff ? 'disabled' : ''}><span></span></span></label>
      <label class="toggle sm" title="Its saved settings (${esc(x.name)}.lua under WTF)">Settings <span class="switch"><input type="checkbox" data-a="settings" ${!skipS.has(x.name) ? 'checked' : ''}><span></span></span></label>
    </div>`;
  }).join('');
  return `<div class="apanel">
    <div class="a-head"><input class="input" id="addon-search" placeholder="Search ${esc(plural(names.length, 'addon'))}" value="${esc(addonQuery)}">
      <button class="btn ghost sm" data-act="close-addons">Done</button></div>
    <div class="d-note">Switched off here means this computer neither sends nor receives it. Your other computers keep syncing it, and nothing is deleted.</div>
    <div class="alist">${rows || '<div class="d-note">No addons installed for this version.</div>'}</div>
  </div>`;
}

async function toggleAddons(id) {
  openAddons = openAddons === id ? null : id;
  addonQuery = '';
  render(true, true);
  if (openAddons && !addonCache.has(id)) { addonCache.set(id, await api.addons(id)); if (openAddons === id) render(true, true); }
}

// ---- computers --------------------------------------------------------------

let comp = null; // { ok, list, me, fetched, error } from the main process

const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const vnum = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
const older = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

function computerRow(m, me) {
  const isMe = m.id === me;
  const seenMs = m.seen ? Date.now() - new Date(m.seen).getTime() : Infinity;
  // a computer that has not checked in for half a day is not "playing" any more, just gone
  // computers report every few minutes while playing; an older entry is a crashed or offline one
  const playing = m.playing?.length && seenMs < 15 * 60_000;
  const status = playing ? `<span class="pill play">Playing ${esc(m.playing.map(flavorName).join(', '))}</span>`
    : seenMs > 30 * 86_400_000 ? `<span class="pill">Last seen ${esc(rel(m.seen))}</span>` : '';
  const sub = [OS[m.platform] || m.platform, `Leyline ${m.version || '?'}`, `last sync ${rel(m.lastSync)}`, (m.flavors || []).map(flavorName).join(', ')].filter(Boolean).join(' · ');
  const icon = m.platform === 'darwin'
    ? '<svg viewBox="0 0 24 24" class="c-ic"><rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 15h18l-1.2 3.2a1 1 0 0 1-.9.6H5.1a1 1 0 0 1-.9-.6z"/></svg>'
    : '<svg viewBox="0 0 24 24" class="c-ic"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v3.5M8 19.5h8"/></svg>';
  const forgetKey = JSON.stringify({ forget: m.id });
  return `<div class="hrow crow">${icon}
    <div class="h-main"><div class="h-title">${esc(m.name || 'Computer')} ${isMe ? '<span class="pill ok">This computer</span>' : ''}
      ${!isMe && older(m.version, data.version) ? '<span class="pill">Older Leyline</span>' : ''}</div>
      <div class="h-sub">${esc(sub)}</div></div>
    ${status}
    ${isMe || seenMs < 30 * 86_400_000 ? '<span></span>' /* only old computers can be cleared out; active ones would come back at their next sync */
      : `<button class="btn ghost sm" data-act="forget-computer" data-id="${esc(m.id)}" title="Take this old computer off the list. Its backups on the NAS stay.">${armed === forgetKey ? 'Click again to remove' : 'Remove'}</button>`}</div>`;
}

async function loadComputers() {
  comp = await api.computers();
  if (page === 'computers') render(true, true);
}

// ---- sync details & restore -----------------------------------------------

let openRun = null;           // run id whose details are expanded on the History page
const runCache = new Map();   // run id → details from the main process (null: none recorded)
let armed = null;             // restore button waiting for its confirming second click

const ACTION = { updated: 'Updated', added: 'Added', deleted: 'Deleted' };
const partLabel = (item) => { const [fl, part] = item.split('/'); return `${flavorName(fl)} ${part === 'AddOns' ? 'addons' : part === 'Account' ? 'account settings' : 'settings'}`; };

function restoreBtn(req, label, title) {
  const key = JSON.stringify(req);
  const isArmed = armed === key;
  return `<button class="btn sm ${isArmed ? 'primary' : ''}" data-act="restore" data-req="${esc(key)}" title="${esc(title)}">${isArmed ? 'Click again to confirm' : label}</button>`;
}

/** Button for a group of changes: put back what was replaced or deleted, remove what was added. */
function undoBtn(run, item, cs, can, what) {
  const open = cs.filter((c) => !c.done);
  const back = open.filter(can), added = open.filter((c) => c.action === 'added');
  if (!back.length && !added.length) {
    // already undone from here: say so instead of offering it again
    const done = cs.filter((c) => c.done);
    if (!done.length) return '';
    const label = done.every((c) => c.action === 'added') ? 'Removed' : done.some((c) => c.action === 'added') ? 'Undone' : 'Restored';
    return `<span class="d-done">${svg('check')}${label}</span>`;
  }
  const label = !back.length ? 'Remove' : !added.length ? 'Restore' : 'Undo';
  const title = !back.length ? `Delete ${what} on all your computers (a copy stays in the backups)`
    : !added.length ? `Put ${what} back to how it was before this sync`
    : `Put ${what} back to how it was before this sync and remove what it added`;
  return restoreBtn({ run, item, paths: [...back, ...added].map((c) => c.path) }, label, title);
}

function runDetailsHtml(run) {
  if (!runCache.has(run)) return `<div class="hdetail"><div class="d-note">Loading…</div></div>`;
  const d = runCache.get(run);
  if (!d) return `<div class="hdetail"><div class="d-note">No file list for this sync. Leyline records which files changed from version 0.1.4 on.</div></div>`;
  const can = (c) => c.backup && d.backups[c.backup];
  // mark what was restored or removed from this sync already
  for (const it of d.items) { const u = new Set(d.undone?.[it.item] || []); for (const c of it.changes || []) c.done = u.has(c.path); }
  const all = d.items.flatMap((i) => i.changes || []);
  const undoable = all.filter((c) => !c.done && (can(c) || c.action === 'added')).length;
  const allDone = all.length > 0 && all.every((c) => c.done);
  const lostBackups = all.some((c) => c.backup && !can(c));
  const groups = d.items.filter((i) => !i.changesKnown || i.changes?.length).map((it) => {
    if (!it.changesKnown) return `<div class="d-item"><div class="d-head">${esc(partLabel(it.item))}</div>
      <div class="d-note">Compared in one go (first sync or recovery), so there is no list of single files.</div></div>`;
    const dirs = [['in', 'Received from your other computers'], ['out', 'Sent to the NAS']].map(([dir, label]) => {
      const list = it.changes.filter((c) => c.dir === dir);
      if (!list.length) return '';
      let rows;
      if (it.item.endsWith('/AddOns')) {
        // one row per addon folder
        const by = new Map();
        for (const c of list) { const k = c.path.split('/')[0]; if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
        rows = [...by].slice(0, 60).map(([name, cs]) => {
          const counts = Object.entries(cs.reduce((a, c) => ({ ...a, [c.action]: (a[c.action] || 0) + 1 }), {})).map(([a, n]) => `${n} ${a}`).join(', ');
          return `<div class="d-row"><span class="d-act">Addon</span><span class="d-path">${esc(name)}<small>${esc(plural(cs.length, 'file'))}: ${esc(counts)}</small></span>
            ${undoBtn(run, it.item, cs, can, name)}</div>`;
        });
        if (by.size > 60) rows.push(`<div class="d-note">and ${by.size - 60} more addons</div>`);
      } else {
        rows = list.slice(0, 60).map((c) => `<div class="d-row"><span class="d-act ${c.action}">${ACTION[c.action]}</span><span class="d-path" title="${esc(c.path)}">${esc(c.path)}${c.conflict ? '<small>changed on both computers, newer kept</small>' : ''}</span>
          ${undoBtn(run, it.item, [c], can, 'this file')}</div>`);
        if (list.length > 60) rows.push(`<div class="d-note">and ${list.length - 60} more files</div>`);
      }
      return `<div class="d-dir">${label}</div>${rows.join('')}`;
    }).join('');
    const more = it.changeCount > (it.changes?.length || 0) ? `<div class="d-note">Only the first ${it.changes.length.toLocaleString()} of ${it.changeCount.toLocaleString()} changes are listed.</div>` : '';
    const note = it.fromBackups ? `<div class="d-note">This sync compared everything in one go, so these are the files it replaced, taken from its backups${it.nasUnknown ? ' on this computer (the NAS could not be read just now)' : ''}. Files it added are not listed.</div>` : '';
    return `<div class="d-item"><div class="d-head">${esc(partLabel(it.item))}</div>${note}${dirs}${more}</div>`;
  }).join('');
  if (!groups) return `<div class="hdetail"><div class="d-note">This sync did not change any files.</div></div>`;
  const note = allDone ? 'Everything this sync changed has been undone.'
    : undoable
    ? 'Restore puts a file back to its version from before this sync, Remove deletes a file this sync added. Leyline then syncs that to your other computers, and keeps a copy of everything it replaces or removes.'
    : lostBackups ? 'The backups of this sync have been cleaned up, so it can no longer be undone.'
    : 'Nothing to undo here.';
  return `<div class="hdetail">${groups}
    <div class="d-foot">
      <span class="d-note">${note}</span>
      <div class="d-actions">
        <button class="btn ghost sm" data-act="open-backups">${svg('folder')}Show backups</button>
        ${(groups.match(/data-act="restore"/g) || []).length > 1 ? restoreBtn({ run }, 'Undo this sync', 'Put back what this sync replaced or deleted and remove what it added') : ''}
      </div>
    </div></div>`;
}

async function toggleRun(run) {
  armed = null;
  openRun = openRun === run ? null : run;
  render(true, true);
  if (openRun && !runCache.has(run)) { runCache.set(run, await api.run(run)); if (openRun === run) render(true, true); }
}

const recentActivity = () => (data.history.length ? `<div class="section-title"><h3>Recent activity</h3><a data-go="history">All history</a></div>
  <div class="card list">${historyRows(data.history.slice(0, 4))}</div>` : '');

/** Update the overview in place, so the scene's animations keep running. */
function patchOverview() {
  const hero = $('#page .hero');
  hero.classList.toggle('syncing', data.state.status === 'syncing');
  const body = $('.hero-body', hero);
  const mode = heroMode();
  if (mode === 'syncing' && body.dataset.mode === 'syncing') {
    const p = data.state.progress || { index: 0, total: 0, files: 0, label: 'starting' };
    $('.js-label', body).textContent = syncLabel(p);
    $('.js-bar', body).style.width = `${syncPct(p)}%`;
    $('.js-bar', body).parentElement.classList.toggle('sweep', !!p.resync);
    const [a, b] = syncMeta(p);
    $('.js-step', body).textContent = a;
    $('.js-files', body).textContent = b;
  } else {
    body.innerHTML = heroContent();
    body.dataset.mode = mode;
  }
  const al = alerts();
  if ($('#ov-alerts').dataset.html !== al) { $('#ov-alerts').innerHTML = al; $('#ov-alerts').dataset.html = al; }
  $('#ov-tiles').innerHTML = versionTiles();
  $('#ov-activity').innerHTML = recentActivity();
}

/** Things that need the user: a version waiting for its start choice, or playing twice. */
function alerts() {
  const { state } = data;
  const start = (state.needsStart || []).map((id) => `
    <div class="banner alert">${svg('info')}<div class="b-body"><b>${esc(flavorName(id))} already has settings and addons on your NAS.</b>
      <small>How should this computer start? Taking the NAS state is best when your other computers have the newer setup. Merging keeps the newer of each file. Whatever gets replaced here is kept in the backups.</small>
      <div class="row" style="margin-top:10px"><button class="btn primary sm" data-act="start-nas" data-id="${esc(id)}">Take from the NAS</button>
        <button class="btn sm" data-act="start-merge" data-id="${esc(id)}">Merge with this computer</button></div></div></div>`).join('');
  const twice = (state.alsoPlaying || []).map((x) => `
    <div class="banner warn">${svg('info')}<div class="b-body"><b>${esc(x.machines.join(' and '))} ${x.machines.length > 1 ? 'are' : 'is'} also playing ${esc(flavorName(x.flavor))} right now.</b>
      <small>Whichever computer closes the game last overwrites the other one's settings. Close it on one of them.</small></div></div>`).join('');
  return twice + start;
}

const PAGES = {
  overview() {
    const { state, history } = data;
    return `
      <div class="head"><div class="eyebrow">${esc(data.settings.machine)}</div><h1 class="title">Overview</h1></div>
      <div id="ov-alerts">${alerts()}</div>
      <div class="card hero ${state.status === 'syncing' ? 'syncing' : ''}"><div class="hero-body" data-mode="${heroMode()}">${heroContent()}</div>${scene()}</div>
      <div id="ov-tiles">${versionTiles()}</div>
      <div id="ov-activity">${recentActivity()}</div>`;
  },

  versions() {
    const { settings, state } = data;
    const detected = new Map(state.detected.map((d) => [d.id, d]));
    const rows = settings.flavors.filter((f) => detected.has(f.id) || f.enabled);
    return `
      <div class="head"><div class="eyebrow">Library</div><h1 class="title">Game versions</h1>
        <p class="sub">Choose which versions Leyline keeps in sync. Each one has its own settings and addons, and its own spot on the NAS.</p></div>
      <div class="card">
        <div class="field"><label>World of Warcraft folder</label>
          <div class="folder"><div class="path mono">${esc(settings.wowRoot || 'Not chosen')}</div>
            <button class="btn" data-act="pick">${svg('folder')}Change…</button>
            <button class="btn ghost" data-act="rescan">${svg('sync')}Rescan</button></div></div>
      </div>
      <div class="card list" style="margin-top:18px">
        ${rows.length ? rows.map((f) => {
          const d = detected.get(f.id);
          const playing = state.running.includes(f.id);
          return `<div class="vrow" data-id="${esc(f.id)}">${badge(f.id)}
            <div><div class="v-name">${esc(flavorName(f.id))}${playing ? '<span class="pill play">Playing</span>' : ''}${!d ? '<span class="pill bad">Folder missing</span>' : ''}${(state.needsStart || []).includes(f.id) ? '<a class="pill play" data-go="overview">Waiting for your choice</a>' : ''}</div>
              <div class="v-sub"><span class="mono">${esc(f.id)}</span> · <a class="v-link" data-act="choose-addons" data-id="${esc(f.id)}">${esc(skipSummary(f))}</a></div></div>
            <label class="toggle">Addons <span class="switch"><input type="checkbox" data-k="addons" ${f.addons !== false ? 'checked' : ''}><span></span></span></label>
            <label class="toggle">Sync <span class="switch"><input type="checkbox" data-k="enabled" ${f.enabled ? 'checked' : ''}><span></span></span></label>
          </div>${openAddons === f.id ? addonPanel(f) : ''}`;
        }).join('') : `<div class="empty"><b>No game versions found</b>Choose the folder that contains _retail_, _classic_ and so on.</div>`}
      </div>
      <div class="banner">${svg('info')}<div class="b-body">New versions you install show up here switched off, so nothing syncs until you decide.
        <small>Turn off Addons for a version if an addon manager handles it on each computer.</small></div></div>`;
  },

  nas() {
    const { nas, hasPassword } = data.settings;
    return `
      <div class="head"><div class="eyebrow">Connection</div><h1 class="title">NAS</h1>
        <p class="sub">Leyline talks to your NAS directly over SMB. It does not need the share mounted in Finder or Explorer.</p></div>
      <div class="card">
        <form class="form" id="nas-form" autocomplete="off">
          <div class="field"><label for="host">Address</label><input class="input" id="host" placeholder="192.168.1.10 or nas.local" value="${esc(nas.host)}"></div>
          <div class="field"><label for="share">Share</label><input class="input" id="share" placeholder="leyline" value="${esc(nas.share)}"></div>
          <div class="field"><label for="user">User</label><input class="input" id="user" placeholder="Your NAS user" value="${esc(nas.user)}"></div>
          <div class="field"><label for="password">Password</label><input class="input" id="password" type="password" placeholder="${hasPassword ? 'Saved — type to replace' : 'Your NAS password'}"></div>
          <div class="field full"><label for="folder">Folder on the share</label><input class="input mono" id="folder" placeholder="Empty: use the root of the share" value="${esc(nas.folder)}">
            <span class="hint">Leyline keeps everything inside this folder: <span class="mono">current</span> for the live copy, <span class="mono">history</span> for replaced files. Leave it empty if the share is only for Leyline.</span></div>
        </form>
        <div class="row" style="margin-top:20px">
          <button class="btn primary" data-act="nas-save">Save</button>
          <button class="btn" data-act="nas-test">${svg('plug')}Test connection</button>
          <span class="hint" style="color:var(--text-3);font-size:12px">Your password is encrypted with the system keychain.</span>
        </div>
        <div id="nas-result"></div>
      </div>
      <div class="card tip" style="margin-top:18px"><div class="t-ic">${svg('bolt')}</div>
        <div><b>Make syncing fast</b><p>Thousands of small addon files are slow on shares that span several disks. A dedicated share that lives only on your SSD cache (on Unraid: primary storage Cache, secondary None, exclusive access) is many times faster.</p></div></div>`;
  },

  history() {
    const { history } = data;
    return `
      <div class="head"><div class="eyebrow">Activity</div><h1 class="title">History</h1>
        <p class="sub">Every sync, and what it did. Click one to see which files changed and to put files back to how they were before it.</p></div>
      <div class="card list">${history.length ? historyRows(history) : `
        <div class="empty"><svg viewBox="0 0 120 60"><path d="M12 46 C 40 46, 46 14, 60 14 S 80 46, 108 46" fill="none" stroke="url(#bm)" stroke-width="2" stroke-dasharray="3 6" stroke-linecap="round"/><circle cx="12" cy="46" r="5" fill="var(--ley-a)"/><circle cx="108" cy="46" r="5" fill="var(--ley-b)"/></svg>
        <b>No syncs yet</b>Your first sync will appear here.</div>`}</div>`;
  },

  computers() {
    const c = comp;
    const list = !c ? `<div class="d-note pad">Asking the NAS…</div>`
      : !c.ok ? `<div class="banner bad">${svg('x')}<div class="b-body">${esc(c.error || 'Could not read the list of computers from the NAS.')}</div></div>`
      : c.list.slice().sort((a, b) => (b.id === c.me) - (a.id === c.me) || (b.seen || '').localeCompare(a.seen || '')).map((m) => computerRow(m, c.me)).join('');
    return `
      <div class="head"><div class="eyebrow">Library</div><h1 class="title">Your computers</h1>
        <p class="sub">Every computer that syncs with this NAS folder, what it last did and whether someone is playing on it.</p></div>
      <div class="card list">${list}</div>
      <div class="row" style="margin-top:14px"><button class="btn ghost" data-act="refresh-computers">${svg('sync')}Refresh</button>
        ${c?.fetched ? `<span class="d-note">Updated ${esc(rel(c.fetched))}</span>` : ''}</div>`;
  },

  settings() {
    const s = data.settings;
    const opts = [5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${s.syncIntervalMin === m ? 'selected' : ''}>Every ${m} minutes</option>`).join('');
    const keep = [[7, '7 days'], [14, '14 days'], [30, '30 days'], [90, '90 days'], [0, 'Forever']]
      .map(([d, l]) => `<option value="${d}" ${(s.keepHistoryDays ?? 30) === d ? 'selected' : ''}>${l}</option>`).join('');
    return `
      <div class="head"><div class="eyebrow">Preferences</div><h1 class="title">Settings</h1></div>
      <div class="card">
        <div class="srow"><div class="s-text"><div class="s-title">Computer name</div><div class="s-sub">Shown in history and when this computer is playing.</div></div>
          <input class="input" id="machine-name" value="${esc(s.machine)}"></div>
        <div class="srow"><div class="s-text"><div class="s-title">Start at login</div><div class="s-sub">Leyline starts quietly in the ${data.platform === 'darwin' ? 'menu bar' : 'system tray'} and syncs before you play.</div></div>
          <span class="switch"><input type="checkbox" id="start-login" ${s.startAtLogin ? 'checked' : ''}><span></span></span></div>
        <div class="srow"><div class="s-text"><div class="s-title">Sync automatically</div><div class="s-sub">Right after you close a game version or your addon manager finishes, plus a regular check of the NAS.</div></div>
          <span class="switch"><input type="checkbox" id="auto-sync" ${s.autoSync ? 'checked' : ''}><span></span></span></div>
        <div class="srow"><div class="s-text"><div class="s-title">Background interval</div><div class="s-sub">How often to look for changes from your other computers.</div></div>
          <select class="input" id="interval" ${s.autoSync ? '' : 'disabled'}>${opts}</select></div>
        <div class="srow"><div class="s-text"><div class="s-title">Keep backups</div><div class="s-sub">Old versions of files a sync replaced or deleted, so you can restore them from History. Cleaned up on this computer and from this computer's backups on the NAS.</div></div>
          <select class="input" id="keep-days">${keep}</select></div>
      </div>
      <div class="card" style="margin-top:18px"><div class="srow" id="upd-row">${updateRow()}</div></div>`;
  },
};

// ---- rendering & events ---------------------------------------------------

const LIVE_PAGES = new Set(['overview', 'versions', 'history', 'computers']); // safe to redraw on every update (no text inputs)

/** force: redraw the page even if it has inputs; keepScroll: stay where the user is. */
function render(force = false, keepScroll = false) {
  if (!data) return;
  renderMachine();
  renderUpdate();
  if (!force && page === 'settings' && $('#upd-row')) $('#upd-row').innerHTML = updateRow(); // only this row: the rest has inputs
  if (!force && !LIVE_PAGES.has(page)) return;
  if (!force && page === 'versions' && openAddons) return; // keep the search box steady while typing
  if (!force && page === 'overview' && $('#page .hero')) return patchOverview();
  const el = $('#page');
  const scroll = el.scrollTop;
  el.innerHTML = PAGES[page]();
  if (!force || keepScroll) { el.scrollTop = scroll; el.style.animation = 'none'; } else { el.style.animation = ''; el.scrollTop = 0; }
}

function go(p) {
  page = p;
  armed = null;
  openAddons = null;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  const el = $('#page');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  render(true);
  if (p === 'computers') loadComputers();
}

/** Two-step buttons: the first click arms, the second (within 4 s) acts. */
function arm(key) {
  if (armed === key) { armed = null; return true; }
  armed = key;
  render(true, true);
  setTimeout(() => { if (armed === key) { armed = null; render(true, true); } }, 4000);
  return false;
}

// An empty folder means the root of the share (fine for a share dedicated to Leyline).
const nasFields = () => ({ host: $('#host').value.trim(), share: $('#share').value.trim(), user: $('#user').value.trim(), folder: $('#folder').value.trim().replace(/^[\\/]+|[\\/]+$/g, '') });

function nasResult(r) {
  $('#nas-result').innerHTML = r.ok
    ? `<div class="banner ok">${svg('check')}<div class="b-body">Connected. The Leyline folder is ready on the NAS.<small>Shares you can see: ${esc(r.shares.join(', '))}</small></div></div>`
    : `<div class="banner bad">${svg('x')}<div class="b-body">${esc(r.error)}</div></div>`;
}

async function withBusy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg viewBox="0 0 24 24" class="spin"><path d="M12 4a8 8 0 1 1-8 8"/></svg>Working…`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('#nav button');
  if (nav) return go(nav.dataset.page);
  const target = e.target.closest('[data-go]');
  if (target) return go(target.dataset.go);
  const act = e.target.closest('[data-act]');
  const runRow = !act && e.target.closest('.hrow[data-run]');
  if (runRow) {
    if (page !== 'history') { openRun = null; go('history'); }
    return toggleRun(runRow.dataset.run);
  }
  if (!act) return;
  switch (act.dataset.act) {
    case 'restore': {
      if (!arm(act.dataset.req)) return;
      const req = JSON.parse(act.dataset.req);
      act.disabled = true;
      act.textContent = 'Working…';
      const r = await api.restore(req);
      runCache.set(req.run, await api.run(req.run)); // now shows what was undone
      render(true, true);
      if (!r.ok) return toast(r.error, true);
      const did = [r.restored && `restored ${plural(r.restored, 'file')}`, r.removed && `removed ${plural(r.removed, 'file')}`].filter(Boolean).join(' and ');
      if (!did) return toast('Already undone, nothing left to do.');
      return toast(`${did[0].toUpperCase()}${did.slice(1)}${r.missing ? ` (${r.missing} no longer in the backups)` : ''}. Syncing to your other computers now.`);
    }
    case 'open-backups': return api.openBackups();
    case 'start-nas': case 'start-merge': {
      act.disabled = true;
      data = await api.chooseStart(act.dataset.id, act.dataset.act === 'start-nas' ? 'nas' : 'merge');
      return render(true, true);
    }
    case 'choose-addons': return toggleAddons(act.dataset.id);
    case 'close-addons': openAddons = null; return render(true, true);
    case 'refresh-computers': comp = null; render(true, true); return loadComputers();
    case 'forget-computer': {
      if (!arm(JSON.stringify({ forget: act.dataset.id }))) return;
      comp = await api.forgetComputer(act.dataset.id);
      return render(true, true);
    }
    case 'sync': return api.sync();
    case 'cancel': return api.cancel();
    case 'pick': {
      const dir = await api.pickFolder();
      if (dir) { data = await api.detect(dir); render(true); toast('WoW folder updated'); }
      return;
    }
    case 'rescan': data = await api.detect(); render(true); return toast('Scanned for game versions');
    case 'nas-save': return withBusy(act, async () => {
      const pw = $('#password').value;
      data = await api.save({ nas: nasFields(), ...(pw ? { password: pw } : {}) });
      $('#password').value = '';
      $('#password').placeholder = 'Saved — type to replace';
      toast('NAS settings saved');
      nasResult(await api.test(nasFields()));
    });
    case 'check-updates': data = await api.checkUpdates(); return render();
    case 'install-update': if (!(await api.installUpdate())) toast('The update installs after the current sync'); return;
    case 'nas-test': return withBusy(act, async () => nasResult(await api.test(nasFields(), $('#password').value)));
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'addon-search') return;
  addonQuery = e.target.value;
  const q = addonQuery.toLowerCase();
  for (const r of $$('.arow')) r.hidden = !!q && !r.textContent.toLowerCase().includes(q);
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  const arow = t.closest('.arow');
  if (arow) {
    const { flavor, name } = arow.dataset, k = t.dataset.a;
    const flavors = data.settings.flavors.map((f) => {
      if (f.id !== flavor) return f;
      const list = new Set(f.skip?.[k] || []);
      if (t.checked) list.delete(name); else list.add(name);
      return { ...f, skip: { ...f.skip, [k]: [...list].sort() } };
    });
    data = await api.save({ flavors });
    const link = $(`.v-link[data-id="${CSS.escape(flavor)}"]`);
    if (link) link.textContent = skipSummary(data.settings.flavors.find((f) => f.id === flavor));
    return;
  }
  const row = t.closest('.vrow');
  if (row) {
    const flavors = data.settings.flavors.map((f) => (f.id === row.dataset.id ? { ...f, [t.dataset.k]: t.checked } : f));
    data = await api.save({ flavors });
    render(); // redraw in place: keeps the scroll position
    return;
  }
  if (t.id === 'machine-name' && t.value.trim()) { data = await api.save({ machine: t.value.trim() }); renderMachine(); toast('Name saved'); }
  if (t.id === 'start-login') { data = await api.save({ startAtLogin: t.checked }); toast(t.checked ? 'Leyline will start at login' : 'Start at login turned off'); }
  if (t.id === 'auto-sync') { data = await api.save({ autoSync: t.checked }); $('#interval').disabled = !t.checked; }
  if (t.id === 'interval') { data = await api.save({ syncIntervalMin: Number(t.value) }); toast('Interval saved'); }
  if (t.id === 'keep-days') { data = await api.save({ keepHistoryDays: Number(t.value) }); toast(Number(t.value) ? `Backups are kept for ${t.value} days` : 'Backups are kept forever'); }
});

api.onUpdate((d) => { data = d; render(); });
api.get().then((d) => { data = d; render(true); });
setInterval(() => render(), 30000); // keep relative times fresh
