// Files written by older Leyline versions must keep working after an update.
// test/fixtures/v0.1.25/ holds them as that version wrote them: never edit those files,
// add a folder for the next format change instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_VERSION, migrateSettings, readJsonSafe, writeJsonSafe } from '../app/settings-format.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = async (v, name) => JSON.parse(await readFile(path.join(FIX, v, name), 'utf8'));
const DEFAULTS = {
  machine: 'computer', wowRoot: '/wow', flavors: [], nas: { host: '', share: '', folder: 'Leyline', user: '' },
  passwordEnc: '', startAtLogin: true, autoSync: true, syncIntervalMin: 10, keepHistoryDays: 30, machineId: '', lastPrune: null,
  settingsVersion: SETTINGS_VERSION,
};
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'leyline-compat-'));

test('settings from 0.1.25 load with every value kept', async () => {
  const old = await fixture('v0.1.25', 'settings.json');
  const { settings, migrated } = migrateSettings(old, DEFAULTS);
  assert.equal(migrated, true);
  assert.equal(settings.settingsVersion, SETTINGS_VERSION);
  for (const [k, v] of Object.entries(old)) assert.deepEqual(settings[k], v, k);
  // migrating again changes nothing
  const again = migrateSettings(settings, DEFAULTS);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.settings, settings);
});

test('missing settings get their defaults, also inside nas', () => {
  const { settings } = migrateSettings({ nas: { host: 'nas.local' } }, DEFAULTS);
  assert.equal(settings.syncIntervalMin, 10);
  assert.deepEqual(settings.nas, { host: 'nas.local', share: '', folder: 'Leyline', user: '' });
});

test('settings from a newer Leyline keep their version and unknown fields', () => {
  const newer = { settingsVersion: SETTINGS_VERSION + 5, machine: 'pc', futureOption: { on: true } };
  const { settings, newer: isNewer, migrated } = migrateSettings(newer, DEFAULTS);
  assert.equal(isNewer, true);
  assert.equal(migrated, false);
  assert.equal(settings.settingsVersion, SETTINGS_VERSION + 5);
  assert.deepEqual(settings.futureOption, { on: true });
});

test('a corrupted file is replaced by its previous copy, never overwritten', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'settings.json');
  await writeJsonSafe(f, { machine: 'first' });
  await writeJsonSafe(f, { machine: 'second' }); // first becomes the .bak
  await writeFile(f, '{"machine": "sec'); // a crash or full disk cut it off
  const r = await readJsonSafe(f, {});
  assert.equal(r.recovered, 'backup');
  assert.deepEqual(r.data, { machine: 'first' });
  assert.equal(await readFile(r.brokenFile, 'utf8'), '{"machine": "sec');
  assert.deepEqual(JSON.parse(await readFile(f, 'utf8')), { machine: 'first' });
});

test('a corrupted file without a backup is set aside, not lost', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'history.json');
  await writeFile(f, 'not json');
  const r = await readJsonSafe(f, []);
  assert.equal(r.recovered, 'reset');
  assert.deepEqual(r.data, []);
  assert.ok((await readdir(dir)).some((n) => n.startsWith('history.json.broken-')));
});

test('a missing file is just the fallback', async () => {
  const r = await readJsonSafe(path.join(await tmp(), 'nope.json'), { a: 1 });
  assert.deepEqual(r, { data: { a: 1 } });
});

test('a broken file never becomes the backup', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'x.json');
  await writeJsonSafe(f, { v: 1 });
  await writeJsonSafe(f, { v: 2 });
  await writeFile(f, 'garbage');
  await writeJsonSafe(f, { v: 3 });
  assert.deepEqual(JSON.parse(await readFile(`${f}.bak`, 'utf8')), { v: 1 });
});

// What the History page and restore read from older entries. A new version may add fields,
// but must keep reading these.
test('history entries from 0.1.25 have what History reads', async () => {
  const history = await fixture('v0.1.25', 'history.json');
  for (const h of history) {
    assert.ok(!Number.isNaN(Date.parse(h.time)));
    assert.equal(typeof h.ok, 'boolean');
    assert.equal(typeof h.trigger, 'string');
    assert.equal(typeof h.ms, 'number');
    assert.match(h.run, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    for (const i of h.items) {
      assert.match(i.item, /^_\w+_\/(Account|SavedVariables|AddOns)$/);
      assert.equal(typeof i.ok, 'boolean');
      if (!i.ok) assert.equal(typeof i.error, 'string');
    }
  }
});

test('sync file lists from 0.1.25 have what restore reads', async () => {
  const run = await fixture('v0.1.25', 'run.json');
  assert.match(run.run, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  for (const i of run.items) {
    assert.equal(typeof i.changesKnown, 'boolean');
    for (const c of i.changes || []) {
      assert.ok(['updated', 'added', 'deleted'].includes(c.action));
      assert.ok(['in', 'out'].includes(c.dir));
      if (c.backup) assert.ok(['local', 'nas'].includes(c.backup));
    }
  }
});
