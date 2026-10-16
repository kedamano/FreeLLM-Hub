// Kept as an alias so older docs/CI invocations still work; the real logic lives in
// scripts/package.mjs, which handles win/mac/linux uniformly.
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('node', [resolve(root, 'scripts/package.mjs'), '--win', '--x64'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
