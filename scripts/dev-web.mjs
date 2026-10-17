import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function portInUse(port) {
  return new Promise((fulfilled) => {
    const probe = createServer();
    probe.once('error', (err) => {
      probe.close();
      fulfilled(err.code === 'EADDRINUSE' || err.code === 'EACCES');
    });
    probe.once('listening', () => probe.close(() => fulfilled(false)));
    probe.listen(port, '127.0.0.1');
  });
}

// Only a hint: netstat is Windows-only and the owner may be a process we do not control.
function portOwner(port) {
  if (process.platform !== 'win32') return null;
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
  for (const line of out.split('\n')) {
    if (line.includes('LISTENING') && line.includes(`127.0.0.1:${port} `)) {
      return line.trim().split(/\s+/).pop();
    }
  }
  return null;
}

function spawnChild(command, args, options = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', shell: true, ...options });
}

// Children are spawned through cmd.exe on Windows, so `child.kill()` only reaches the shell
// wrapper: vite and tsc survive, keep holding ports 3000/5173, and the next `npm run dev:web`
// silently starts beside them. Kill the whole tree instead.
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

async function main() {
  console.log('[dev:web] Starting FreeLLM Hub web development environment...');

  for (const d of ['dist/main', 'dist/renderer', 'logs']) {
    const fullPath = resolve(root, d);
    if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
  }

  const adminPort = Number(process.env.ADMIN_PORT || 3000);
  const gatewayPort = Number(process.env.GATEWAY_PORT || 3001);
  const busy = [];
  for (const [label, port] of [
    ['admin API', adminPort],
    ['gateway', gatewayPort],
  ]) {
    if (await portInUse(port)) busy.push(`${label} :${port} (PID ${portOwner(port) ?? 'unknown'})`);
  }
  if (busy.length) {
    console.error('[dev:web] 端口已被占用，上一个 dev:web 可能还留着孤儿进程：');
    for (const line of busy) console.error(`  - ${line}`);
    console.error('[dev:web] 先结束这些进程再启动，否则新实例会和旧实例并存，浏览器可能连到错的那个。');
    process.exit(1);
  }
  if (await portInUse(5173)) {
    console.warn('[dev:web] 5173 已被占用，vite 会自动改用其他端口，请以下面打印的地址为准。');
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

  const children = [
    { name: 'tsc --watch', child: tscMain },
    { name: 'vite', child: vite },
    { name: 'admin server', child: server },
  ];
  let exiting = false;
  const cleanup = (code = 0) => {
    if (exiting) return;
    exiting = true;
    for (const { child } of children) killTree(child);
    process.exit(code);
  };

  for (const { name, child } of children) {
    child.on('exit', (code, signal) => {
      if (exiting) return;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`[dev:web] ${name} exited with ${reason}; stopping the dev environment.`);
      cleanup(code ?? 1);
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
