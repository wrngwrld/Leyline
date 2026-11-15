// Detects which WoW game versions are running right now, by looking at process paths.
// The version is the "_name_" folder in the executable's path, e.g. .../_retail_/World of Warcraft.app
import { execFile } from 'node:child_process';

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
});

const flavorsFrom = (paths) => {
  const found = new Set();
  for (const p of paths) {
    const m = p.match(/[\\/](_[a-z0-9_]+_)[\\/]/i);
    if (m) found.add(m[1]);
  }
  return found;
};

async function macRunning() {
  const out = await run('ps', ['-axo', 'comm=']);
  return flavorsFrom(out.split('\n').filter((l) => l.includes('World of Warcraft') && l.includes('.app/Contents/MacOS/')));
}

// Windows: `tasklist` is cheap, PowerShell is not (≈0.3 s of CPU per call). Use tasklist to see
// whether any Wow*.exe runs and ask PowerShell for the paths only when that set of processes changes.
let winCache = { pids: '', flavors: new Set() };
async function winRunning() {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
  const pids = out.split(/\r?\n/)
    .map((l) => l.match(/^"([^"]+)","(\d+)"/))
    .filter((m) => m && /^wow.*\.exe$/i.test(m[1]))
    .map((m) => m[2]).sort().join(',');
  if (!pids) { winCache = { pids: '', flavors: new Set() }; return winCache.flavors; }
  if (pids === winCache.pids) return winCache.flavors;
  const ps = `Get-CimInstance Win32_Process -Filter "ProcessId=${pids.split(',').join(' OR ProcessId=')}" | ForEach-Object { $_.ExecutablePath }`;
  const paths = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])).split(/\r?\n/).filter(Boolean);
  winCache = { pids, flavors: flavorsFrom(paths) };
  return winCache.flavors;
}

/** Set of running flavor ids, e.g. Set {'_retail_'}. */
export async function runningFlavors() {
  if (process.platform === 'darwin') return macRunning();
  if (process.platform === 'win32') return winRunning();
  return new Set();
}
