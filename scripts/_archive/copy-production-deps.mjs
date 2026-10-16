// Copy only production dependencies into the packaged app
import { readFileSync, existsSync, cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcModules = resolve(root, 'node_modules');
const dstModules = resolve('C:/temp/freellm-release/FreeLLM Hub-win32-x64/resources/app/node_modules');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const topDeps = new Set(Object.keys(pkg.dependencies || {}));

// Recursively resolve all transitive production deps
const visited = new Set();
function resolveDeps(depName) {
  if (visited.has(depName)) return;
  visited.add(depName);

  const depPkgPath = resolve(srcModules, depName, 'package.json');
  if (!existsSync(depPkgPath)) {
    console.warn('  WARN: ' + depName + ' not found, skipping');
    return;
  }
  const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf8'));
  const subDeps = Object.keys(depPkg.dependencies || {});
  for (const sub of subDeps) {
    resolveDeps(sub);
  }
}

console.log('[copy-deps] Resolving dependency tree...');
for (const dep of topDeps) {
  resolveDeps(dep);
}
console.log('[copy-deps] Found ' + visited.size + ' packages to copy');

// Clean and recreate dst
if (existsSync(dstModules)) {
  rmSync(dstModules, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
mkdirSync(dstModules, { recursive: true });

let copied = 0;
for (const dep of visited) {
  const src = resolve(srcModules, dep);
  const dst = resolve(dstModules, dep);
  if (existsSync(src)) {
    cpSync(src, dst, { recursive: true, force: true });
    copied++;
  } else {
    console.warn('  WARN: ' + dep + ' not in node_modules');
  }
}

console.log('[copy-deps] Copied ' + copied + ' packages');
console.log('[copy-deps] Verifying avvio:', existsSync(resolve(dstModules, 'avvio/package.json')) ? 'OK' : 'MISSING');
console.log('[copy-deps] Verifying fastify:', existsSync(resolve(dstModules, 'fastify/package.json')) ? 'OK' : 'MISSING');
console.log('[copy-deps] Verifying better-sqlite3:', existsSync(resolve(dstModules, 'better-sqlite3/package.json')) ? 'OK' : 'MISSING');
