#!/usr/bin/env node
// Writes reader-focused release notes from the commits since the previous release tag.
// Usage: node scripts/release-notes.mjs --version 0.2.0 [--highlights "text"] [--repo owner/name] [--previous v0.1.0] [--all]
import { execFileSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
const version = arg('--version');
const highlights = arg('--highlights').trim();
const repo = arg('--repo');
const previous = arg('--previous');
const all = process.argv.includes('--all');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let prev = previous;
if (!prev && !all) {
  try { prev = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD'); } catch { /* first release */ }
}
const range = !all && prev ? `${prev}..HEAD` : 'HEAD';

// subject + body, separated by a marker; skip the automatic release commits
const raw = git('log', range, '--no-merges', '--format=%h%x1f%s%x1f%b%x1e');
const commits = raw.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
  const [hash, subject, body] = c.split('\x1f');
  return { hash, subject, body: body || '' };
}).filter((c) => !/^Release v\d/.test(c.subject));

const curated = new Map([
  ['Ask macOS for Local Network access so the app can reach the NAS', ['Fixes', 'Fix "Could not reach the NAS" in the macOS app: Leyline now asks for Local Network access, which it needs to connect to your NAS.']],
  ['Add Windows build and fix Windows-specific issues', ['Features', 'Install Leyline on Windows as well as macOS.']],
  ['Sync addons when their folder settles, not mid-update', ['Features', 'Wait until addon-manager updates finish before syncing, so other computers never receive a half-updated addon.']],
  ['Show real sync progress: files, data, speed and time left', ['Features', 'Follow each sync with live file and data counts, transfer speed, and estimated time remaining.']],
  ['Add Leyline desktop app: tray, window and setup screens', ['Features', 'Configure Leyline and monitor syncs from the desktop app, with a menu bar (macOS) or system tray (Windows) icon.']],
  ['Add sync engine prototype', ['Features', 'Sync World of Warcraft settings and addons between your computers through your own NAS.']],
  ["Use Electron's async safeStorage API for the NAS password", ['Security & privacy', "Protect your NAS password with your operating system's secure storage."]],
  ['Let settings folders sync after WoW rewrites all of them', ['Fixes', 'Wait for WoW to finish rewriting settings folders before syncing them.']],
  ['Update the overview in place during a sync', ['Fixes', 'Keep the sync overview in place while it updates.']],
  ['Treat an empty NAS folder as the root of the share', ['Fixes', 'Allow the NAS share root to be used without specifying a subfolder.']],
  ['Keep scroll position when toggling a game version', ['Fixes', 'Keep your place in the game-version list when you toggle a version.']],
  ['Let the Addons switch be set before a version is enabled', ['Fixes', 'Let you choose the Addons setting before enabling a game version.']],
]);

const internal = /^(add (readme|mit license|nas speed comparison script|script to download)|revert version number|improve release notes)/i;
const classify = (subject) => {
  if (/\b(password|safe.?storage|encrypt|credential)\b/i.test(subject)) return 'Security & privacy';
  if (/^(fix|let|keep|treat|hide)\b|^update the overview\b/i.test(subject)) return 'Fixes';
  if (/^(add|show|sync|support|enable|allow)\b/i.test(subject)) return 'Features';
  return 'Improvements';
};

const groups = { Features: [], Improvements: [], Fixes: [], 'Security & privacy': [] };
for (const commit of commits) {
  const known = curated.get(commit.subject);
  if (known) {
    groups[known[0]].push(known[1]);
  } else if (!internal.test(commit.subject)) {
    groups[classify(commit.subject)].push(commit.subject.replace(/^(feat|fix|docs|refactor|perf|chore)(\([^)]*\))?:\s*/i, ''));
  }
}

let out = '';
if (highlights) out += `${highlights}\n\n`;
for (const [title, list] of Object.entries(groups)) {
  if (!list.length) continue;
  out += `## ${title}\n\n`;
  for (const summary of list) out += `- ${summary}\n`;
  out += '\n';
}
if (!commits.length) out += 'Maintenance release.\n\n';
out += `## Downloads\n\n`;
out += `- **Windows:** \`Leyline-Setup-${version}.exe\`. Not code-signed yet: in the SmartScreen warning choose *More info → Run anyway*.\n`;
out += `- **macOS (Apple silicon):** \`Leyline-${version}-arm64.dmg\`. Not notarized yet: after the first launch attempt, allow it in *System Settings → Privacy & Security → Open Anyway*. When asked, allow Leyline to access your local network so it can reach your NAS (*System Settings → Privacy & Security → Local Network*).\n`;
if (prev && repo) out += `\n## Full changelog\n\nhttps://github.com/${repo}/compare/${prev}...v${version}\n`;
process.stdout.write(out);
