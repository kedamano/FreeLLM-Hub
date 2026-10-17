// Captures the admin UI into docs/images for the README.
// Requires `npm run build` and a running `npm run start:web`.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs/images');
const baseUrl = process.env.FREELLM_ADMIN_URL || 'http://127.0.0.1:3000';

const pages = [
  { label: '仪表盘', file: 'dashboard.png' },
  { label: '服务商', file: 'providers.png' },
  { label: '模型目录', file: 'models.png' },
  { label: '用量与成本', file: 'usage.png' },
  { label: '请求审计', file: 'audit.png' },
  { label: '配置档', file: 'profiles.png' },
];

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

for (const { label, file } of pages) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(outDir, file) });
  console.log(`[screenshots] ${file}`);
}

await browser.close();
