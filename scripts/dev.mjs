import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

async function main() {
  console.log('[dev] Starting FreeLLM Hub development environment...');

  const dirs = ['dist/main', 'dist/renderer', 'logs'];
  for (const d of dirs) {
    const fullPath = resolve(root, d);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  const tscMain = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput'],
    { cwd: root, stdio: 'inherit', shell: true }
  );

  const vite = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', '5173'],
    { cwd: root, stdio: 'inherit', shell: true }
  );

  await new Promise((r) => setTimeout(r, 3000));

  const electron = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.', '--remote-debugging-port=9223'],
    { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, NODE_ENV: 'development' } }
  );

  const cleanup = () => {
    tscMain.kill();
    vite.kill();
    electron.kill();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

main().catch(console.error);
