#!/usr/bin/env node
// Writes release notes (Markdown) from the commits since the previous release tag.
// Usage: node scripts/release-notes.mjs --version 0.2.0 [--highlights "text"] [--repo owner/name]
import { execFileSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
const version = arg('--version');
const highlights = arg('--highlights').trim();
const repo = arg('--repo');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let prev = '';
try { prev = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD'); } catch { /* first release */ }
const range = prev ? `${prev}..HEAD` : 'HEAD';

// subject + body, separated by a marker; skip the automatic release commits
const raw = git('log', range, '--no-merges', '--format=%h%x1f%s%x1f%b%x1e');
const commits = raw.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
  const [hash, subject, body] = c.split('\x1f');
  return { hash, subject, body: body || '' };
}).filter((c) => !/^Release v\d/.test(c.subject));

const bucket = (s) => (/^(fix|keep|let|treat|hide|update the overview)/i.test(s) ? 'Fixes' : /^(add|show|sync|support)/i.test(s) ? 'New' : 'Changes');
const groups = { New: [], Changes: [], Fixes: [] };
for (const c of commits) groups[bucket(c.subject)].push(c);

const link = (h) => (repo ? `[\`${h}\`](https://github.com/${repo}/commit/${h})` : `\`${h}\``);
let out = '';
if (highlights) out += `${highlights}\n\n`;
for (const [title, list] of Object.entries(groups)) {
  if (!list.length) continue;
  out += `### ${title}\n\n`;
  for (const c of list) out += `- ${c.subject} (${link(c.hash)})\n`;
  out += '\n';
}
if (!commits.length) out += 'Maintenance release.\n\n';
out += `### Downloads\n\n`;
out += `- **Windows:** \`Leyline-Setup-${version}.exe\`. Not code-signed yet: in the SmartScreen warning choose *More info → Run anyway*.\n`;
out += `- **macOS (Apple silicon):** \`Leyline-${version}-arm64.dmg\`. Not notarized yet: after the first launch attempt, allow it in *System Settings → Privacy & Security → Open Anyway*.\n`;
if (prev && repo) out += `\n**Full changelog:** https://github.com/${repo}/compare/${prev}...v${version}\n`;
process.stdout.write(out);
