#!/usr/bin/env node
// Stand-in for rclone in engine tests. FAKE_RCLONE_DIR holds the script for each run:
// plan.json = ["reset", "reset", "ok"] says what the 1st, 2nd, 3rd bisync does.
// Every call is appended to calls.log.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_RCLONE_DIR;
const args = process.argv.slice(2);
appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\n');
const log = (level, msg) => console.log(JSON.stringify({ level, msg }));

const ERRORS = {
  reset: 'Failed to bisync: connection error: read tcp 192.168.1.2:58421->192.168.1.10:445: read: connection reset by peer',
  unreachable: 'couldn\'t connect SMB: dial tcp 192.168.1.10:445: connect: no route to host',
  flux: 'Failed to copy: can\'t copy - source file is being updated (size changed from 10 to 12)',
  other: 'Failed to bisync: bisync aborted: too many deletes',
};

const cmd = args[0];
if (cmd === 'mkdir' && existsSync(path.join(dir, 'mkdir-fails'))) { log('error', ERRORS.unreachable); process.exit(1); }
if (cmd !== 'bisync') process.exit(0);

const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const counter = path.join(dir, 'count');
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(n + 1));
const step = plan[Math.min(n, plan.length - 1)];
if (step === 'ok') process.exit(0);
log('error', ERRORS[step]);
process.exit(2);
