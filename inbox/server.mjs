// Leyline inbox: a tiny server that takes addon links from your phone and drops them into the
// "inbox" folder of your Leyline NAS folder. The Leyline app picks them up and adds them to the
// Wishlist. No dependencies; runs on Node 20 or newer.
//
//   LEYLINE_TOKEN  required  secret the phone has to send
//   PORT           optional  default 8787
//   INBOX_DIR      optional  default /data (mount <share>/<Leyline folder>/inbox there)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import path from 'node:path';

const TOKEN = process.env.LEYLINE_TOKEN || '';
const PORT = Number(process.env.PORT) || 8787;
const DIR = process.env.INBOX_DIR || '/data';
const MAX_BODY = 8 * 1024;

if (!TOKEN || TOKEN.length < 8) {
  console.error('Set LEYLINE_TOKEN to a secret of at least 8 characters.');
  process.exit(1);
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// a link someone can open: http(s), with a dotted host name
function cleanLink(text) {
  let t = String(text || '').trim().split(/\s+/)[0];
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) return null;
    return u.href.slice(0, 1000);
  } catch { return null; }
}

// at most 30 requests a minute per address
const seen = new Map();
function limited(ip) {
  const now = Date.now();
  const hits = (seen.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  seen.set(ip, hits);
  if (seen.size > 500) for (const [k, v] of seen) if (!v.some((t) => now - t < 60_000)) seen.delete(k);
  return hits.length > 30;
}

// a name someone typed instead of a link, for the app to search for later
function cleanName(text) {
  const t = String(text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return t.length >= 2 && /[\p{L}\p{N}]/u.test(t) ? t : null;
}

async function save(item, note) {
  await mkdir(DIR, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
  const tmp = path.join(DIR, `.${name}.tmp`); // Leyline only reads finished *.json files
  await writeFile(tmp, JSON.stringify({ ...item, note: String(note || '').trim().slice(0, 300), by: 'phone', added: new Date().toISOString() }) + '\n');
  await rename(tmp, path.join(DIR, name));
  await chmod(path.join(DIR, name), 0o666).catch(() => {}); // any user of the share may read and delete it
}

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    let refused = false;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) return void parts.push(c);
      if (!refused) { refused = true; reject(Object.assign(new Error('too large'), { status: 413 })); } // the rest is read and dropped, so the answer can still be sent
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/add') {
      if (limited(req.socket.remoteAddress || '')) return send(res, 429, { error: 'Too many requests, try again in a minute.' });
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-token'] || '');
      if (!same(auth, TOKEN)) return send(res, 401, { error: 'Wrong or missing token.' });
      const raw = await readBody(req);
      let url0 = raw, note = '';
      const type = String(req.headers['content-type'] || '');
      if (type.includes('json')) { const j = JSON.parse(raw || '{}'); url0 = j.url ?? j.name ?? j.query; note = j.note; }
      else if (type.includes('x-www-form-urlencoded')) { const f = new URLSearchParams(raw); url0 = f.get('url') ?? raw; // a bare link sent as a form is the link itself
      note = f.get('note'); }
      const link = cleanLink(url0);
      if (link) { await save({ url: link }, note); return send(res, 200, { ok: true }); }
      const name = cleanName(url0); // not a link: an addon name, found by the app later
      if (!name) return send(res, 400, { error: 'Type an addon name or paste a link.' });
      await save({ query: name }, note);
      return send(res, 200, { ok: true, name });
    }
    send(res, 404, { error: 'Not found.' });
  } catch (err) {
    send(res, err.status || 500, { error: err.status === 413 ? 'Too large.' : 'Could not save that.' });
  }
}).listen(PORT, () => console.log(`Leyline inbox listening on :${PORT}, saving to ${DIR}`));
