import { defineConfig } from '@rstest/core';
export default defineConfig({
  projects: [
    { name: 'unit', include: ['tests/unit/**/*.test.ts'], testEnvironment: 'node' },
    { name: 'package', include: ['tests/package/**/*.test.ts'], testEnvironment: 'node' },
  ],
});
