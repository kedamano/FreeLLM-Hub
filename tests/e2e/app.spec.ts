import { test, expect, type Page } from '@playwright/test';

/**
 * Role + exact-name locators throughout. The sidebar also carries a profile switcher
 * whose label and option contain words like 「配置档」, so substring `text=` selectors
 * resolve to several elements and strict mode fails the run for reasons that have
 * nothing to do with the app.
 */
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

test.describe('FreeLLM Hub App', () => {
  test('should load the main page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('FreeLLM Hub')).toBeVisible();
  });

  test('should display sidebar navigation', async ({ page }) => {
    await page.goto('/');
    for (const item of ['仪表盘', '服务商', '模型目录', '用量与成本', '请求审计', '配置档', '设置']) {
      await expect(nav(page, item)).toBeVisible();
    }
  });

  test('should navigate to providers page', async ({ page }) => {
    await page.goto('/');
    await nav(page, '服务商').click();
    await expect(heading(page, '服务商管理')).toBeVisible();
  });

  test('should navigate to models page', async ({ page }) => {
    await page.goto('/');
    await nav(page, '模型目录').click();
    await expect(heading(page, '模型目录')).toBeVisible();
  });

  test('should navigate to usage page', async ({ page }) => {
    await page.goto('/');
    await nav(page, '用量与成本').click();
    await expect(heading(page, '用量与成本')).toBeVisible();
  });

  test('should navigate to the request audit page', async ({ page }) => {
    await page.goto('/');
    await nav(page, '请求审计').click();
    await expect(heading(page, '请求审计')).toBeVisible();
  });

  test('should navigate to the profiles page', async ({ page }) => {
    await page.goto('/');
    await nav(page, '配置档').click();
    await expect(heading(page, '配置档')).toBeVisible();
    // The create form is static, so this also proves the body left its loading state.
    await expect(page.getByRole('button', { name: '创建', exact: true })).toBeVisible();
  });

  test('should navigate to settings page', async ({ page }) => {
    await page.goto('/');
    await nav(page, '设置').click();
    await expect(heading(page, '设置')).toBeVisible();
  });

  test('should display dashboard stats cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('总请求数')).toBeVisible();
    await expect(page.getByText('成功率')).toBeVisible();
  });
});
