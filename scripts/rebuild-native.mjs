import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const electronVersion = (pkg.devDependencies?.electron ?? '').replace(/^[\^~]/, '');

const target = process.argv[2];
if (target !== 'electron' && target !== 'node') {
  console.error('usage: node scripts/rebuild-native.mjs <electron|node>');
  process.exit(2);
}

let cmd;
let args;
if (target === 'electron') {
  cmd = 'npx';
  args = ['--no-install', 'prebuild-install', '-r', 'electron', '-t', electronVersion];
} else {
  cmd = 'npx';
  args = ['--no-install', 'prebuild-install', '-r', 'node'];
}

const prebuild = spawnSync(cmd, args, {
  cwd: resolve(root, 'node_modules/better-sqlite3'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (prebuild.status === 0) {
  console.log(`[rebuild-native] better-sqlite3 rebuilt for ${target}.`);
  process.exit(0);
}

if (target === 'electron') {
  console.log('[rebuild-native] prebuild unavailable; falling back to @electron/rebuild.');
  const fallback = spawnSync('npx', ['--no-install', 'electron-rebuild', '-f', '-w', 'better-sqlite3'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(fallback.status ?? 1);
}

console.log('[rebuild-native] prebuild unavailable; falling back to npm rebuild (source compile).');
const source = spawnSync('npm', ['rebuild', 'better-sqlite3'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(source.status ?? 1);
