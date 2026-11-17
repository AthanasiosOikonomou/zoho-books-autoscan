#!/usr/bin/env node
'use strict';

/**
 * Deploy the function to Catalyst using this repo's own identity.
 *
 *   npm run deploy            → regenerate catalyst-config.json from .env, then `catalyst deploy --only functions`
 *   npm run deploy -- --check → only regenerate + show the command, deploy nothing
 *
 * Identity: if CATALYST_TOKEN is set in .env, every catalyst command gets
 * `--token <token>` so the globally logged-in CLI user (another project) is
 * not used. Generate it once while logged in as the right user:
 *     catalyst login --force --dc eu      (sign in as the user invited to the target project)
 *     catalyst token:generate             → CATALYST_TOKEN=... in .env
 */
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');
const check = process.argv.includes('--check');

const gen = spawnSync(process.execPath, [path.join(__dirname, 'catalyst-config.js'), ...(check ? ['--check'] : [])], { stdio: 'inherit', cwd: root });
if (gen.status !== 0) process.exit(gen.status || 1);

const args = ['deploy', '--only', 'functions'];
if (process.env.CATALYST_DC) args.push('--dc', process.env.CATALYST_DC);
if (process.env.CATALYST_TOKEN) args.push('--token', process.env.CATALYST_TOKEN);
const shown = args.map((a, i) => (args[i - 1] === '--token' ? '<token>' : a)).join(' ');
console.log(`\n$ catalyst ${shown}${process.env.CATALYST_TOKEN ? '' : '   (no CATALYST_TOKEN in .env → uses the CLI\'s global login)'}`);
if (check) process.exit(0);

const dep = spawnSync('catalyst', args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
process.exit(dep.status === null ? 1 : dep.status);
