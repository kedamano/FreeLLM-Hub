const { readFileSync, existsSync, cpSync, mkdirSync, rmSync, readdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');

const root = resolve(__dirname, '..');
const srcModules = resolve(root, 'node_modules');
const dstModules = resolve('C:/temp/freellm-release/FreeLLM Hub-win32-x64/resources/app/node_modules');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const topDeps = new Set(Object.keys(pkg.dependencies || {}));

const visited = new Set();
function resolveDeps(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const pkgJson = resolve(srcModules, name, 'package.json');
  if (!existsSync(pkgJson)) {
    console.warn('  WARN: ' + name + ' not found, skipping');
    return;
  }
  const sub = JSON.parse(readFileSync(pkgJson, 'utf8'));
  Object.keys(sub.dependencies || {}).forEach(resolveDeps);
}

console.log('[deps] Resolving...');
topDeps.forEach(resolveDeps);
console.log('[deps] Found ' + visited.size + ' packages');

// Remove dst with retries
console.log('[deps] Removing old dst...');
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    if (existsSync(dstModules)) {
      rmSync(dstModules, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
    break;
  } catch (e) {
    console.warn('  attempt ' + attempt + ' failed: ' + e.code);
    if (attempt === 5) {
      console.error('Could not remove dst, continuing anyway');
    }
    // Wait before retry
    const start = Date.now();
    while (Date.now() - start < 1000) {} // Sync sleep
  }
}

mkdirSync(dstModules, { recursive: true });

let copied = 0;
visited.forEach(name => {
  const s = resolve(srcModules, name);
  const d = resolve(dstModules, name);
  if (existsSync(s)) {
    cpSync(s, d, { recursive: true, force: true });
    copied++;
  }
});
console.log('[deps] Copied ' + copied);

// Verify
['avvio', 'fastify', 'find-my-way', 'light-my-request', '@fastify/cors', 'better-sqlite3', 'ws'].forEach(n => {
  console.log('  ' + n + ': ' + (existsSync(resolve(dstModules, n, 'package.json')) ? 'OK' : 'MISSING!'));
});
