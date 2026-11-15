// Detects which WoW game versions are running right now, by looking at process paths.
// The version is the "_name_" folder in the executable's path, e.g. .../_retail_/World of Warcraft.app
import { execFile } from 'node:child_process';

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
});

async function processPaths() {
  if (process.platform === 'darwin') {
    const out = await run('ps', ['-axo', 'comm=']);
    return out.split('\n').filter((l) => l.includes('World of Warcraft') && l.includes('.app/Contents/MacOS/'));
  }
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name LIKE 'Wow%.exe'\" | ForEach-Object { $_.ExecutablePath }";
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return out.split(/\r?\n/).filter(Boolean);
  }
  return [];
}

/** Set of running flavor ids, e.g. Set {'_retail_'}. */
export async function runningFlavors() {
  const found = new Set();
  for (const p of await processPaths()) {
    const m = p.match(/[\\/](_[a-z0-9_]+_)[\\/]/i);
    if (m) found.add(m[1]);
  }
  return found;
}
