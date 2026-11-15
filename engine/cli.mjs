#!/usr/bin/env node
// Leyline command line, for testing the engine without the app.
//
//   cli.mjs detect [wowRoot]                       list installed game versions
//   cli.mjs sync   <config.json> [--flavor _retail_,_classic_] [--only Account,AddOns] [--quiet]
//   cli.mjs lock   <config.json> --flavor _retail_  mark a game version as in use (exit 2 if taken)
//   cli.mjs unlock <config.json> --flavor _retail_
//   cli.mjs status <config.json>                   show in-use markers
import { readFile } from 'node:fs/promises';
import { SyncEngine } from './sync.mjs';
import { detectFlavors, defaultWowRoot } from './flavors.mjs';

const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const list = (name) => opt(name)?.split(',');

if (cmd === 'detect') {
  console.log(JSON.stringify(await detectFlavors(arg || defaultWowRoot()), null, 2));
  process.exit(0);
}
if (!cmd || !arg) {
  console.error('usage: cli.mjs <detect|sync|lock|unlock|status> ...  (see top of file)');
  process.exit(64);
}

const cfg = JSON.parse(await readFile(arg, 'utf8'));
const quiet = rest.includes('--quiet');
let files = 0;
cfg.onEvent = (e) => {
  if (e.type === 'file') { files++; if (!quiet && files <= 20) console.error(`  ${e.msg}: ${e.object}`); return; }
  if (e.type === 'item-start') console.error(`> ${e.item}${e.resync ? ' (first sync / resync)' : ''}`);
  if (e.type === 'item-resync') console.error(`  ${e.item}: retrying with resync`);
  if (e.type === 'item-done') console.error(`  ${e.item}: ${e.ok ? 'ok' : 'FAILED code ' + e.code} in ${(e.ms / 1000).toFixed(1)}s, ${e.transfers} transfers, ${(e.bytes / 1048576).toFixed(1)} MB, ${e.checks} checks, ${e.deletes} deletes`);
};
const engine = new SyncEngine(cfg);

if (cmd === 'sync') {
  const r = await engine.syncAll({ flavors: list('--flavor'), parts: list('--only') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'status') {
  const out = {};
  for (const f of engine.flavors) out[f] = await engine.readLock(f);
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const flavor = opt('--flavor');
if (!flavor) { console.error(`${cmd} needs --flavor`); process.exit(64); }
if (cmd === 'lock') {
  const held = await engine.readLock(flavor);
  if (held && held.machine !== cfg.machine) { console.log(JSON.stringify({ ok: false, heldBy: held })); process.exit(2); }
  await engine.writeLock(flavor);
  console.log(JSON.stringify({ ok: true, lock: await engine.readLock(flavor) }));
} else if (cmd === 'unlock') {
  await engine.clearLock(flavor);
  console.log(JSON.stringify({ ok: true, lock: await engine.readLock(flavor) }));
}
