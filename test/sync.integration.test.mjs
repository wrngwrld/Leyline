// Two computers syncing through a "NAS" folder, with the real rclone (no network needed).
// Skipped when vendor/rclone has no binary for this machine: node scripts/fetch-rclone.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine, NAS_FORMAT, NasFormatError } from '../engine/sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RCLONE = path.join(ROOT, 'vendor', 'rclone', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
const skip = !existsSync(RCLONE) && 'no rclone binary in vendor/rclone (run node scripts/fetch-rclone.mjs)';

let T;
const machines = {};
// mtimes far enough apart for bisync's 2 s modify window, without sleeping
let clock = Date.now() / 1000 - 3600;
const tick = () => (clock += 10);

async function put(machine, rel, body) {
  const f = path.join(T, machine, 'AddOns', rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, body);
  const t = tick();
  await utimes(f, t, t);
}
const get = (where, rel) => readFile(path.join(T, where, rel), 'utf8').catch(() => null);
const local = (machine, rel) => get(machine, path.join('AddOns', rel));
const nas = (rel) => get('nas', path.join('current', '_retail_', 'AddOns', rel));

async function sync(machine) {
  // a new run stamp each time (they have 1 s resolution)
  await new Promise((r) => setTimeout(r, 1100));
  const r = await machines[machine].syncAll();
  assert.equal(r.ok, true, `${machine} sync failed: ${JSON.stringify(r.results.map((x) => x.errors))}`);
  return r.results[0];
}

before(async () => {
  if (skip) return;
  T = await mkdtemp(path.join(os.tmpdir(), 'leyline-integ-'));
  for (const m of ['mac', 'pc']) {
    await mkdir(path.join(T, m, 'AddOns'), { recursive: true });
    machines[m] = new SyncEngine({
      rclone: RCLONE, remoteRoot: path.join(T, 'nas'), machine: m, stateDir: path.join(T, `${m}-state`),
      items: [{ name: '_retail_/AddOns', flavor: '_retail_', local: path.join(T, m, 'AddOns') }],
      retryDelays: [],
    });
  }
});

test('first syncs bring both computers to the same files', { skip }, async () => {
  await put('mac', 'Questie/Questie.lua', 'mac v1');
  await put('mac', 'Details/Details.toc', 'details');
  await put('pc', 'WeakAuras/WeakAuras.lua', 'pc only');
  await sync('mac');
  await sync('pc');
  await sync('mac');
  for (const m of ['mac', 'pc']) {
    assert.equal(await local(m, 'Questie/Questie.lua'), 'mac v1');
    assert.equal(await local(m, 'WeakAuras/WeakAuras.lua'), 'pc only');
  }
  assert.equal(await nas('Details/Details.toc'), 'details');
});

test('a change travels to the other computer and the old version is backed up', { skip }, async () => {
  await put('mac', 'Questie/Questie.lua', 'mac v2');
  const sent = await sync('mac');
  assert.ok(sent.changes.some((c) => c.path === 'Questie/Questie.lua' && c.dir === 'out'));
  const got = await sync('pc');
  assert.equal(await local('pc', 'Questie/Questie.lua'), 'mac v2');
  const change = got.changes.find((c) => c.path === 'Questie/Questie.lua');
  assert.equal(change?.dir, 'in');
  assert.equal(change?.action, 'updated');
});

test('a deletion travels to the other computer', { skip }, async () => {
  await rm(path.join(T, 'pc', 'AddOns', 'Details'), { recursive: true });
  await sync('pc');
  await sync('mac');
  assert.equal(await local('mac', 'Details/Details.toc'), null);
  assert.equal(await nas('Details/Details.toc'), null);
});

test('when both computers change a file, the newer one wins everywhere', { skip }, async () => {
  await put('mac', 'Questie/Questie.lua', 'mac v3 (older)');
  await put('pc', 'Questie/Questie.lua', 'pc v3 (newer)');
  await sync('mac');
  await sync('pc');
  await sync('mac');
  for (const m of ['mac', 'pc']) assert.equal(await local(m, 'Questie/Questie.lua'), 'pc v3 (newer)');
  assert.equal(await nas('Questie/Questie.lua'), 'pc v3 (newer)');
});

test('a file replaced by a sync can be restored from its backup', { skip }, async () => {
  await put('pc', 'WeakAuras/WeakAuras.lua', 'pc edit that mac regrets');
  await sync('pc');
  const r = await machines.mac.syncAll();
  const res = r.results[0];
  const c = res.changes.find((x) => x.path === 'WeakAuras/WeakAuras.lua');
  assert.ok(c?.backup, 'the replaced file has a backup');
  assert.equal(await local('mac', 'WeakAuras/WeakAuras.lua'), 'pc edit that mac regrets');
  await machines.mac.restoreFiles({ run: r.runStamp, machine: 'mac', item: machines.mac.cfg.items[0], files: [c] });
  assert.equal(await local('mac', 'WeakAuras/WeakAuras.lua'), 'pc only');
  // the restore is an ordinary change: it travels back to the pc
  await sync('mac');
  await sync('pc');
  assert.equal(await local('pc', 'WeakAuras/WeakAuras.lua'), 'pc only');
});

test('the NAS gets a format marker on the first sync', { skip }, async () => {
  const marker = JSON.parse(await get('nas', 'format.json'));
  assert.equal(marker.format, NAS_FORMAT);
});

test('a NAS set up by a newer Leyline is left alone', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leyline-newer-'));
  const nasRoot = path.join(dir, 'nas');
  await mkdir(path.join(nasRoot, 'current', '_retail_', 'AddOns'), { recursive: true });
  await writeFile(path.join(nasRoot, 'format.json'), JSON.stringify({ format: NAS_FORMAT + 1 }));
  await writeFile(path.join(nasRoot, 'current', '_retail_', 'AddOns', 'new-layout.txt'), 'from the future');
  await mkdir(path.join(dir, 'local'), { recursive: true });
  await writeFile(path.join(dir, 'local', 'mine.lua'), 'mine');
  const e = new SyncEngine({
    rclone: RCLONE, remoteRoot: nasRoot, machine: 'old', stateDir: path.join(dir, 'state'),
    items: [{ name: '_retail_/AddOns', flavor: '_retail_', local: path.join(dir, 'local') }], retryDelays: [],
  });
  await assert.rejects(e.syncAll(), (err) => err instanceof NasFormatError && /Update Leyline/.test(err.message));
  assert.equal(existsSync(path.join(nasRoot, 'current', '_retail_', 'AddOns', 'mine.lua')), false);
  assert.equal(existsSync(path.join(dir, 'local', 'new-layout.txt')), false);
  assert.equal(JSON.parse(await readFile(path.join(nasRoot, 'format.json'), 'utf8')).format, NAS_FORMAT + 1);
});

test('a NAS synced by 0.1.25 (no marker) keeps syncing and gets the marker', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leyline-old-'));
  const nasRoot = path.join(dir, 'nas');
  const old = path.join(nasRoot, 'current', '_retail_', 'AddOns', 'Old');
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'Old.toc'), 'from 0.1.25');
  await mkdir(path.join(nasRoot, 'machines'), { recursive: true });
  await writeFile(path.join(nasRoot, 'machines', 'pc.json'), JSON.stringify({ id: 'pc', name: 'PC', platform: 'win32', version: '0.1.25', lastSync: null, seen: new Date().toISOString(), playing: [], flavors: ['_retail_'] }) + '\n');
  const e = new SyncEngine({
    rclone: RCLONE, remoteRoot: nasRoot, machine: 'mac', stateDir: path.join(dir, 'state'),
    items: [{ name: '_retail_/AddOns', flavor: '_retail_', local: path.join(dir, 'local') }], retryDelays: [],
  });
  const r = await e.syncAll();
  assert.equal(r.ok, true);
  assert.equal(await readFile(path.join(dir, 'local', 'Old', 'Old.toc'), 'utf8'), 'from 0.1.25');
  assert.equal(JSON.parse(await readFile(path.join(nasRoot, 'format.json'), 'utf8')).format, NAS_FORMAT);
  assert.deepEqual((await e.listMachines()).map((m) => m.id), ['pc']);
});

test('a brand-new NAS folder gets the marker after its first sync', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leyline-fresh-'));
  await mkdir(path.join(dir, 'local'), { recursive: true });
  await writeFile(path.join(dir, 'local', 'a.lua'), 'a');
  const e = new SyncEngine({
    rclone: RCLONE, remoteRoot: path.join(dir, 'nas'), machine: 'mac', stateDir: path.join(dir, 'state'),
    items: [{ name: '_retail_/AddOns', flavor: '_retail_', local: path.join(dir, 'local') }], retryDelays: [],
  });
  assert.equal((await e.syncAll()).ok, true);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'nas', 'format.json'), 'utf8')).format, NAS_FORMAT);
});
