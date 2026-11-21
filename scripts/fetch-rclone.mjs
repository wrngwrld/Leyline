#!/usr/bin/env node
// Download a pinned rclone release into vendor/rclone/<platform>-<arch>/ and verify its checksum.
// Usage: node scripts/fetch-rclone.mjs [darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64 ...]
// (linux-x64 is only for running the tests in CI; there is no Linux app)
// With no arguments it fetches the binary for the current machine.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, copyFile, chmod, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v1.76.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-amd64',
  'win32-x64': 'windows-amd64',
  'win32-arm64': 'windows-arm64',
  'linux-x64': 'linux-amd64',
};

const targets = process.argv.slice(2);
if (!targets.length) targets.push(`${process.platform}-${process.arch}`);

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const sums = (await get(`https://downloads.rclone.org/${VERSION}/SHA256SUMS`)).toString();

for (const t of targets) {
  const name = NAMES[t];
  if (!name) throw new Error(`unknown target ${t}; known: ${Object.keys(NAMES).join(', ')}`);
  const zipName = `rclone-${VERSION}-${name}.zip`;
  const expected = sums.split('\n').find((l) => l.endsWith(` ${zipName}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`no checksum listed for ${zipName}`);

  console.log(`fetching ${zipName}`);
  const zip = await get(`https://downloads.rclone.org/${VERSION}/${zipName}`);
  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch for ${zipName}`);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'leyline-rclone-'));
  try {
    await writeFile(path.join(tmp, zipName), zip);
    // bsdtar reads zip files and ships with macOS and Windows 10+; Linux has GNU tar, so unzip.
    if (process.platform === 'linux') execFileSync('unzip', ['-q', zipName], { cwd: tmp });
    else execFileSync('tar', ['-xf', zipName], { cwd: tmp });
    const dir = (await readdir(tmp)).find((d) => d.startsWith('rclone-'));
    const exe = t.startsWith('win32') ? 'rclone.exe' : 'rclone';
    const outDir = path.join(ROOT, 'vendor', 'rclone', t);
    await mkdir(outDir, { recursive: true });
    await copyFile(path.join(tmp, dir, exe), path.join(outDir, exe));
    if (!t.startsWith('win32')) await chmod(path.join(outDir, exe), 0o755);
    console.log(`  ok, checksum verified -> vendor/rclone/${t}/${exe}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
