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
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const TRIGGERS = { manual: 'Manual', auto: 'Automatic', 'game-closed': 'After playing', startup: 'At startup' };

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

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${svg('check', 'h-ic')}<span>${esc(text)}</span>`;
  el.querySelector('svg').style.cssText = 'width:16px;height:16px;fill:none;stroke:var(--ok);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round';
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
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
    const pct = p.total ? Math.max(4, Math.round(((p.index - 0.5) / p.total) * 100)) : 4;
    return `
      <div>
        <span class="status-eyebrow"><span class="dot busy"></span>Syncing</span>
        <h2>Weaving your settings together</h2>
        <p>${esc(p.label[0].toUpperCase() + p.label.slice(1))}. Settings go first, so they are safe within seconds.</p>
        <div class="row"><button class="btn" data-act="cancel">${svg('stop')}Stop</button></div>
        <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div>
          <div class="meta"><span>Step ${p.index || 1} of ${p.total || '…'}</span><span>${plural(p.files, 'file')} changed</span></div></div>
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
      <p>Last sync ${rel(state.lastSync)}${changed ? `, ${changed}` : ''}. ${settings.autoSync ? `Leyline syncs every ${settings.syncIntervalMin} minutes and right after you close the game.` : 'Automatic sync is off.'}</p>
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
      const pill = playing ? '<span class="pill play">Playing now</span>'
        : syncing ? '<span class="pill busy">Syncing</span>'
        : lastFor(f.id) ? `<span class="pill ok">Synced ${rel(lastFor(f.id))}</span>` : '<span class="pill">Not synced yet</span>';
      return `<div class="tile"><div class="t-top">${badge(f.id)}<div><div class="t-name">${esc(flavorName(f.id))}</div>
        <div class="t-sub">${f.addons === false ? 'Settings only' : 'Settings and addons'}</div></div></div><div>${pill}</div></div>`;
    }).join('')}</div>`;
}

function historyRows(items) {
  return items.map((h) => {
    const ic = h.cancelled ? svg('stop', 'h-ic off') : h.ok ? svg('check', 'h-ic ok') : svg('x', 'h-ic bad');
    const title = h.cancelled ? 'Stopped' : !h.ok ? 'Sync failed' : h.transfers ? `Synced ${plural(h.transfers, 'file')}` : 'Checked, nothing to change';
    const versions = [...new Set(h.items.map((i) => i.item.split('/')[0]))].map(flavorName).join(', ');
    const err = !h.ok && !h.cancelled ? h.items.find((i) => !i.ok)?.error : '';
    return `<div class="hrow">${ic}
      <div class="h-main"><div class="h-title">${title}</div><div class="h-sub">${esc(err || versions)}</div></div>
      <span class="pill">${TRIGGERS[h.trigger] || h.trigger}</span>
      <div class="h-num">${dur(h.ms)}</div>
      <div class="h-num">${esc(when(h.time))}</div></div>`;
  }).join('');
}

const PAGES = {
  overview() {
    const { state, history } = data;
    return `
      <div class="head"><div class="eyebrow">${esc(data.settings.machine)}</div><h1 class="title">Overview</h1></div>
      <div class="card hero ${state.status === 'syncing' ? 'syncing' : ''}">${heroContent()}${scene()}</div>
      ${versionTiles()}
      ${history.length ? `<div class="section-title"><h3>Recent activity</h3><a data-go="history">All history</a></div>
        <div class="card list">${historyRows(history.slice(0, 4))}</div>` : ''}`;
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
            <div><div class="v-name">${esc(flavorName(f.id))}${playing ? '<span class="pill play">Playing</span>' : ''}${!d ? '<span class="pill bad">Folder missing</span>' : ''}</div>
              <div class="v-sub mono">${esc(f.id)}</div></div>
            <label class="toggle">Addons <span class="switch"><input type="checkbox" data-k="addons" ${f.addons !== false ? 'checked' : ''}><span></span></span></label>
            <label class="toggle">Sync <span class="switch"><input type="checkbox" data-k="enabled" ${f.enabled ? 'checked' : ''}><span></span></span></label>
          </div>`;
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
        <p class="sub">Every sync, and what it did. Files a sync replaced or deleted are kept on the NAS in the history folder.</p></div>
      <div class="card list">${history.length ? historyRows(history) : `
        <div class="empty"><svg viewBox="0 0 120 60"><path d="M12 46 C 40 46, 46 14, 60 14 S 80 46, 108 46" fill="none" stroke="url(#bm)" stroke-width="2" stroke-dasharray="3 6" stroke-linecap="round"/><circle cx="12" cy="46" r="5" fill="var(--ley-a)"/><circle cx="108" cy="46" r="5" fill="var(--ley-b)"/></svg>
        <b>No syncs yet</b>Your first sync will appear here.</div>`}</div>`;
  },

  settings() {
    const s = data.settings;
    const opts = [5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${s.syncIntervalMin === m ? 'selected' : ''}>Every ${m} minutes</option>`).join('');
    return `
      <div class="head"><div class="eyebrow">Preferences</div><h1 class="title">Settings</h1></div>
      <div class="card">
        <div class="srow"><div class="s-text"><div class="s-title">Computer name</div><div class="s-sub">Shown in history and when this computer is playing.</div></div>
          <input class="input" id="machine-name" value="${esc(s.machine)}"></div>
        <div class="srow"><div class="s-text"><div class="s-title">Start at login</div><div class="s-sub">Leyline starts quietly in the ${data.platform === 'darwin' ? 'menu bar' : 'system tray'} and syncs before you play.</div></div>
          <span class="switch"><input type="checkbox" id="start-login" ${s.startAtLogin ? 'checked' : ''}><span></span></span></div>
        <div class="srow"><div class="s-text"><div class="s-title">Sync automatically</div><div class="s-sub">In the background, and right after you close a game version.</div></div>
          <span class="switch"><input type="checkbox" id="auto-sync" ${s.autoSync ? 'checked' : ''}><span></span></span></div>
        <div class="srow"><div class="s-text"><div class="s-title">Background interval</div><div class="s-sub">How often to check the NAS while the game is closed.</div></div>
          <select class="input" id="interval" ${s.autoSync ? '' : 'disabled'}>${opts}</select></div>
      </div>
      <div class="card" style="margin-top:18px"><div class="srow"><div class="s-text"><div class="s-title">Leyline ${esc(data.version)}</div>
        <div class="s-sub">Open source, MIT licensed. Not affiliated with Blizzard Entertainment.</div></div></div></div>`;
  },
};

// ---- rendering & events ---------------------------------------------------

const LIVE_PAGES = new Set(['overview', 'versions', 'history']); // safe to redraw on every update (no text inputs)

function render(force = false) {
  if (!data) return;
  renderMachine();
  if (!force && !LIVE_PAGES.has(page)) return;
  const el = $('#page');
  const scroll = el.scrollTop;
  el.innerHTML = PAGES[page]();
  if (!force) { el.scrollTop = scroll; el.style.animation = 'none'; } else { el.style.animation = ''; el.scrollTop = 0; }
}

function go(p) {
  page = p;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  const el = $('#page');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  render(true);
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
  if (!act) return;
  switch (act.dataset.act) {
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
    case 'nas-test': return withBusy(act, async () => nasResult(await api.test(nasFields(), $('#password').value)));
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
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
});

api.onUpdate((d) => { data = d; render(); });
api.get().then((d) => { data = d; render(true); });
setInterval(() => render(), 30000); // keep relative times fresh
