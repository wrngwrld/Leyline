// NAS connection: finds the bundled rclone, defines the "nas" SMB remote through
// environment variables and tests the connection.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function rclonePath() {
  const exe = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
  const target = `${process.platform}-${process.arch}`;
  const candidates = [
    app.isPackaged && path.join(process.resourcesPath, 'rclone', exe),
    path.join(ROOT, 'vendor', 'rclone', target, exe),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`rclone not found. Run "npm run fetch-rclone" (looked in ${candidates.join(', ')})`);
  return found;
}

function runRclone(args, { input = '', env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(rclonePath(), args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); err += '\nTimed out'; }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.stdin.end(input);
  });
}

/** rclone wants the password in its reversible "obscured" form; read via stdin so it never shows in a process list. */
export async function obscure(password) {
  const r = await runRclone(['obscure', '-'], { input: password });
  if (r.code !== 0) throw new Error(`could not prepare password: ${r.err.trim()}`);
  return r.out.trim();
}

export function remoteEnv(nas, obscuredPass) {
  return {
    RCLONE_CONFIG_NAS_TYPE: 'smb',
    RCLONE_CONFIG_NAS_HOST: nas.host,
    RCLONE_CONFIG_NAS_USER: nas.user,
    RCLONE_CONFIG_NAS_PASS: obscuredPass,
  };
}

export const remoteRoot = (nas) => {
  const folder = (nas.folder || '').replace(/^[\\/]+|[\\/]+$/g, '');
  return folder ? `nas:${nas.share}/${folder}` : `nas:${nas.share}`;
};

function friendlyError(text) {
  const t = text.toLowerCase();
  if (t.includes('logon failure') || t.includes('access denied') || t.includes('status_logon')) return 'The NAS rejected the user name or password.';
  if (t.includes('bad network name') || t.includes('status_bad_network_name')) return 'That share does not exist or is not exported over SMB.';
  if (t.includes('timed out') || t.includes('i/o timeout') || t.includes('no route') || t.includes('connection refused')) return 'Could not reach the NAS. Check the address and that you are on the same network.';
  return text.trim().split('\n').pop() || 'Unknown error';
}

/** Check address, login, share and that the Leyline folder can be created. */
export async function testConnection(nas, password) {
  if (!nas.host || !nas.user || !nas.share) return { ok: false, error: 'Fill in address, user and share first.' };
  const env = remoteEnv(nas, await obscure(password));
  const shares = await runRclone(['lsd', 'nas:'], { env });
  if (shares.code !== 0) return { ok: false, error: friendlyError(shares.err) };
  const names = shares.out.split('\n').map((l) => l.trim().split(/\s+/).slice(4).join(' ')).filter(Boolean);
  if (!names.includes(nas.share)) return { ok: false, error: `No share named "${nas.share}". Shares you can see: ${names.join(', ')}`, shares: names };
  const mk = await runRclone(['mkdir', remoteRoot(nas)], { env });
  if (mk.code !== 0) return { ok: false, error: friendlyError(mk.err), shares: names };
  return { ok: true, shares: names };
}
