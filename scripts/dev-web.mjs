import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function spawnChild(command, args, options = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', shell: true, ...options });
}

async function main() {
  console.log('[dev:web] Starting FreeLLM Hub web development environment...');

  for (const d of ['dist/main', 'dist/renderer', 'logs']) {
    const fullPath = resolve(root, d);
    if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
  }

  const initial = spawnSync(npx, ['tsc', '-p', 'tsconfig.main.json'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (initial.status !== 0) {
    console.error('[dev:web] Initial TypeScript build failed');
    process.exit(initial.status || 1);
  }

  const tscMain = spawnChild(npx, ['tsc', '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);
  const vite = spawnChild(npx, ['vite', '--port', '5173']);
  const server = spawnChild('node', ['scripts/run-web.mjs'], {
    env: { ...process.env },
  });

  const children = [tscMain, vite, server];
  let exiting = false;
  const cleanup = (code = 0) => {
    if (exiting) return;
    exiting = true;
    for (const child of children) child.kill();
    process.exit(code);
  };

  for (const child of children) {
    child.on('exit', (code) => {
      if (!exiting && code !== 0 && code !== null) {
        console.error(`[dev:web] A child process exited with code ${code}`);
        cleanup(code);
      }
    });
  }

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
  process.on('exit', () => cleanup(0));
}

main().catch((err) => {
  console.error('[dev:web] Error:', err);
  process.exit(1);
});
