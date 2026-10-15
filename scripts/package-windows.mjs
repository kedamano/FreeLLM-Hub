import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function run(command, args) {
  console.log(`[package] ${command} ${args.join(')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function main() {
  console.log('[package] Packaging FreeLLM Hub for Windows...');
  run('node', ['scripts/build.mjs']);
  run('npx', ['electron-builder', '--win', '--x64']);
  console.log('[package] Packaging complete! Check the release/ directory.');
}

main().catch((err) => {
  console.error('[package] Error:', err);
  process.exit(1);
});
