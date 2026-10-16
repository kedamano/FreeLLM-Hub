import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cross-platform packaging for FreeLLM Hub.
 *
 * Usage:
 *   node scripts/package.mjs                 # package for the host platform
 *   node scripts/package.mjs --mac --x64 --arm64
 *   node scripts/package.mjs --linux --all-builders
 *   node scripts/package.mjs --skip-build    # reuse an existing dist/
 *
 * macOS artefacts must be produced on a macOS host (electron-builder cannot build a
 * `.app` bundle from Linux/Windows), and Windows signing tools need Windows — so CI
 * runs this once per OS in a matrix instead of trying to cross-build.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const releaseDir = resolve(root, 'release');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

function run(command, cmdArgs, options = {}) {
  console.log(`[package] $ ${command} ${cmdArgs.join(' ')}`);
  const result = spawnSync(command, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) fail(`无法执行 ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} 以退出码 ${result.status} 结束`);
}

const requestedPlatforms = ['win', 'mac', 'linux'].filter((platform) => has(`--${platform}`));
if (has('--all')) requestedPlatforms.push('win', 'mac', 'linux');
const platforms = [...new Set(requestedPlatforms.length > 0 ? requestedPlatforms : [hostPlatform()])];

const archFlags = ['--x64', '--arm64', '--ia32', '--universal'].filter((flag) => has(flag));

function publishMode() {
  const arg = args.find((entry) => entry.startsWith('--publish'));
  if (!arg) return 'never';
  const value = arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];
  const mode = (value || '').trim();
  if (mode === '' || mode === 'never') return 'never';
  if (mode === 'always' || mode === 'onTag' || mode === 'onTagOrDraft') return mode;
  fail(`未知的 --publish 模式: ${mode}（可用：never | always | onTag | onTagOrDraft）`);
}

function hostPlatform() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

if (platforms.includes('mac') && process.platform !== 'darwin' && !has('--allow-cross')) {
  fail(
    'macOS 安装包必须在 macOS 上构建（electron-builder 无法跨平台产出 .app/.dmg）。' +
      ' 在 CI 中使用 macos-latest runner，或本地加 --allow-cross 强制执行。'
  );
}

const builderArgs = [];
for (const platform of platforms) builderArgs.push(`--${platform}`);
builderArgs.push(...archFlags);
if (has('--dir')) builderArgs.push('--dir');
// Publishing is opt-in. Left to itself, electron-builder resolves a GitHub publisher
// from the git remote and dies looking for GH_TOKEN *after* every artefact has already
// been built, so the default is explicit: `--publish never`.
// A release run asks for it with `--publish always`.
builderArgs.push('--publish', publishMode());

if (!has('--skip-build')) {
  run('node', [join('scripts', 'build.mjs')]);
}

run('npx', ['electron-builder', ...builderArgs]);

const ARTEFACT_PATTERN = /\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz)$/i;

if (existsSync(releaseDir)) {
  const artefacts = readdirSync(releaseDir)
    .filter((name) => ARTEFACT_PATTERN.test(name))
    .filter((name) => statSync(join(releaseDir, name)).isFile())
    .sort();
  console.log(`[package] 产物 (${platforms.join(', ')}) 已输出到 release/`);
  for (const name of artefacts) console.log(`  - ${name}`);
} else {
  console.log('[package] electron-builder 完成，但未找到 release/ 目录');
}
