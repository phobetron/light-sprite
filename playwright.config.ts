import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.test.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    viewport: { width: 1200, height: 1050 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: ['--enable-unsafe-swiftshader'],
    },
  },
  outputDir: 'build/browser-results',
});
