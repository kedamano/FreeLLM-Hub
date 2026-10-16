import packager from 'electron-packager';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = 'C:/temp/freellm-release';

// Clean previous
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

console.log('[package] Rebuilding native modules...');
execSync('npx @electron/rebuild --arch=x64', { cwd: root, stdio: 'inherit' });

console.log('[package] Packaging with electron-packager...');

const appPaths = await packager({
  dir: root,
  out: outDir,
  platform: 'win32',
  arch: 'x64',
  icon: resolve(root, 'resources/icons/icon.ico'),
  name: 'FreeLLM Hub',
  appVersion: '0.1.0',
  overwrite: true,
  asar: true,
  prune: true,
  quiet: false,
  win32metadata: {
    CompanyName: 'FreeLLM Hub Team',
    FileDescription: 'FreeLLM Hub',
    ProductName: 'FreeLLM Hub',
    InternalName: 'FreeLLM Hub',
  },
});

console.log('[package] Done! Output at:', appPaths[0]);
console.log('[package] Portable .exe ready to use.');
