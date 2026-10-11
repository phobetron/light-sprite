import { chromium } from 'playwright';
import { startBrowserServer } from '../tests/support/browser-server';
// Build the library first. Reports browser CPU update cost, not GPU frame time.
const server = await startBrowserServer();
try {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/gpu.html`);
    const timings = await page.evaluate(async () => {
      const helperURL = '/support/movement.js';
      const { benchmarkMovement } = await import(helperURL) as typeof import('../tests/support/browser/movement');
      return benchmarkMovement();
    });
    console.log(JSON.stringify({ scope: 'browser CPU movement updates; excludes rendering', timings }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
