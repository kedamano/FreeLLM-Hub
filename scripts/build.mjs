import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function run(command, args) {
  console.log(`[build] ${command} ${args.join(')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function main() {
  console.log('[build] Building FreeLLM Hub...');

  const distDir = resolve(root, 'dist');
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true });
  }
  mkdirSync(distDir, { recursive: true });

  run('npx', ['tsc', '-p', 'tsconfig.main.json']);
  run('npx', ['vite', 'build']);

  console.log('\n[build] Build complete!');
}

main().catch((err) => {
  console.error('[build] Error:', err);
  process.exit(1);
});
