import { test as base, expect, type Page } from 'playwright/test';
import { startBrowserServer } from './browser-server';
export { expect };

async function trackErrors(page: Page, use: (page: Page) => Promise<void>) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`Failed request: ${request.url()}`));
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`);
  });
  await use(page);
  expect(errors, 'Browser modules and assets load without errors').toEqual([]);
}

export const test = base.extend<{ gpuPage: Page; demoPage: Page }, { assets: { origin: string } }>({
  assets: [async ({}, use) => {
    const server = await startBrowserServer();
    try { await use({ origin: server.origin }); } finally { await server.close(); }
  }, { scope: 'worker' }],
  gpuPage: async ({ page, assets }, use) => {
    await trackErrors(page, async tracked => {
      await tracked.goto(`${assets.origin}/gpu.html`);
      await use(tracked);
    });
  },
  demoPage: async ({ page, assets }, use) => {
    await trackErrors(page, async tracked => {
      await tracked.goto(assets.origin);
      await tracked.waitForFunction(() => document.querySelector('#status')?.textContent === '');
      await tracked.getByLabel('Movement', { exact: true }).uncheck();
      await tracked.getByRole('button', { name: 'Reset marker', exact: true }).click();
      await use(tracked);
    });
  },
});
