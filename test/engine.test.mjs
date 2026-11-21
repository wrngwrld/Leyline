// Engine tests with a fake rclone (no NAS needed): node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine, isNetworkError, isInFlux } from '../engine/sync.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-rclone.mjs');

async function setup(plan, { items = ['_retail_/Account'], mkdirFails = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leyline-test-'));
  await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan));
  if (mkdirFails) await writeFile(path.join(dir, 'mkdir-fails'), '');
  const events = [];
  const engine = new SyncEngine({
    rclone: FAKE,
    remoteRoot: 'nas:Leyline',
    machine: 'test',
    stateDir: path.join(dir, 'state'),
    items: items.map((name) => ({ name, local: path.join(dir, 'local', name) })),
    env: { FAKE_RCLONE_DIR: dir },
    retryDelays: [10, 10, 10],
    onEvent: (e) => events.push(e),
  });
  const bisyncs = async () => (await readFile(path.join(dir, 'calls.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === 'bisync').length;
  return { dir, engine, events, bisyncs };
}

test('classifies connection errors', () => {
  assert.ok(isNetworkError(['Failed to bisync: connection error: read tcp 1.2.3.4:5->6.7.8.9:445: read: connection reset by peer']));
  assert.ok(isNetworkError(['couldn\'t connect SMB: dial tcp 192.168.1.10:445: i/o timeout', 'Bisync critical error: x']));
  assert.ok(!isNetworkError(['Failed to bisync: bisync aborted: too many deletes']));
  assert.ok(!isNetworkError(['can\'t copy - source file is being updated (size changed from 10 to 12)']));
  assert.ok(!isNetworkError([]));
  assert.ok(isInFlux(['can\'t copy - source file is being updated (size changed from 10 to 12)']));
});

test('retries a step after the connection drops, then succeeds', async () => {
  const { engine, events, bisyncs } = await setup(['reset', 'reset', 'ok']);
  const r = await engine.syncAll();
  assert.equal(r.ok, true);
  assert.equal(await bisyncs(), 3);
  assert.equal(r.results[0].retries.length, 2);
  assert.equal(events.filter((e) => e.type === 'item-retry').length, 2);
});

test('gives up after the last retry and skips the remaining steps', async () => {
  const { engine, bisyncs } = await setup(['reset'], { items: ['_retail_/Account', '_retail_/SavedVariables', '_retail_/AddOns'] });
  const r = await engine.syncAll();
  assert.equal(r.ok, false);
  assert.equal(await bisyncs(), 4); // first try + 3 retries, nothing for the other two steps
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].network, true);
  assert.deepEqual(r.results.slice(1).map((x) => x.skipped), [true, true]);
  assert.match(r.results[1].errors[0], /^Not synced: the connection to the NAS kept failing/);
});

test('does not retry errors that are not about the connection', async () => {
  for (const kind of ['other', 'flux']) {
    const { engine, bisyncs } = await setup([kind, 'ok']);
    const r = await engine.syncAll();
    assert.equal(r.ok, false, kind);
    assert.equal(await bisyncs(), 1, kind);
    assert.equal(r.results[0].retries, undefined, kind);
  }
});

test('retries when the NAS cannot be reached at all', async () => {
  const { engine, dir } = await setup(['ok'], { mkdirFails: true });
  const r = await engine.syncAll();
  assert.equal(r.ok, false);
  const mkdirs = (await readFile(path.join(dir, 'calls.log'), 'utf8')).trim().split('\n').filter((l) => l.startsWith('["mkdir"')).length;
  assert.equal(mkdirs, 4);
  assert.equal(r.results[0].network, true);
});

test('cancelling stops the wait before a retry', async () => {
  const { engine, bisyncs, events } = await setup(['reset', 'ok']);
  engine.cfg.retryDelays = [60_000];
  engine.cfg.onEvent = (e) => { events.push(e); if (e.type === 'item-retry') setTimeout(() => engine.cancel(), 20); };
  const t0 = Date.now();
  const r = await engine.syncAll();
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the full delay');
  assert.equal(r.cancelled, true);
  assert.equal(await bisyncs(), 1);
});

test('passes shorter connection timeouts to rclone', async () => {
  const { engine, dir } = await setup(['ok']);
  await engine.syncAll();
  const bisync = (await readFile(path.join(dir, 'calls.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[0] === 'bisync');
  assert.equal(bisync[bisync.indexOf('--timeout') + 1], '2m');
  assert.equal(bisync[bisync.indexOf('--contimeout') + 1], '30s');
});
