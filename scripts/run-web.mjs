import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const req = createRequire(import.meta.url);

// better-sqlite3 is a native module: in this repo node_modules it is commonly
// rebuilt for Electron's ABI, which plain Node cannot dlopen. Detect that and
// fall back to the bundled Electron binary running in Node mode.
function sqliteAbiMatches() {
  try {
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('PRAGMA user_version');
    db.close();
    return true;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (err?.code === 'ERR_DLOPEN_FAILED' || msg.includes('NODE_MODULE_VERSION')) return false;
    throw err;
  }
}

function electronBinary() {
  try {
    const relative = readFileSync(resolve(root, 'node_modules/electron/path.txt'), 'utf8').trim();
    return resolve(root, 'node_modules/electron/dist', relative);
  } catch {
    return null;
  }
}

function main() {
  const target = resolve(root, 'dist/server/index.js');
  let child;
  if (sqliteAbiMatches()) {
    child = spawn(process.execPath, [target], { cwd: root, stdio: 'inherit' });
  } else {
    const exe = electronBinary();
    if (!exe) {
      console.error('[run-web] better-sqlite3 native module is incompatible with this Node runtime and no Electron binary was found.');
      console.error('[run-web] Run `npm run rebuild:node` to rebuild it for plain Node instead.');
      process.exit(1);
    }
    console.log('[run-web] Node ABI mismatch for better-sqlite3; launching via Electron in Node mode.');
    child = spawn(exe, [target], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  }

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main();
