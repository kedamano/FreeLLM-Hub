import { test, expect } from '@playwright/test';

test.describe('FreeLLM Hub App', () => {
  test('should load the main page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=FreeLLM Hub')).toBeVisible();
  });

  test('should display sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=仪表盘')).toBeVisible();
    await expect(page.locator('text=服务商')).toBeVisible();
    await expect(page.locator('text=模型目录')).toBeVisible();
    await expect(page.locator('text=用量与成本')).toBeVisible();
    await expect(page.locator('text=请求审计')).toBeVisible();
    await expect(page.locator('text=配置档')).toBeVisible();
    await expect(page.locator('text=设置')).toBeVisible();
  });

  test('should navigate to providers page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=服务商');
    await expect(page.locator('text=服务商管理')).toBeVisible();
  });

  test('should navigate to models page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=模型目录');
    await expect(page.locator('text=模型目录')).toBeVisible();
  });

  test('should navigate to usage page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=用量与成本');
    await expect(page.locator('h2', { hasText: '用量与成本' })).toBeVisible();
  });

  test('should navigate to the request audit page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=请求审计');
    await expect(page.locator('h2', { hasText: '请求审计' })).toBeVisible();
  });

  test('should navigate to the profiles page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=配置档');
    await expect(page.locator('h2', { hasText: '配置档' })).toBeVisible();
  });

  test('should navigate to settings page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=设置');
    await expect(page.locator('text=设置')).toBeVisible();
  });

  test('should display dashboard stats cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=总请求数')).toBeVisible();
    await expect(page.locator('text=成功率')).toBeVisible();
  });
});
