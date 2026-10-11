import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rspack } from '@rsbuild/core';
import { root } from './packed-artifact';

export async function buildConsumerBundles() {
  const output = await mkdtemp(path.join(tmpdir(), 'light-sprite-bundle-'));
  try {
    // Native resolution observes package exports without the test runner's source aliases.
    const publicEntry = fileURLToPath(execFileSync(process.execPath, ['--input-type=module', '-e',
      "process.stdout.write(import.meta.resolve('light-sprite'))"], { cwd: root, encoding: 'utf8' }));
    assert.equal(publicEntry, path.join(root, 'dist/index.js'), 'Bundle consumers resolve the built public entry');
    const consumers = ['controller', 'all-exports'] as const;
    await new Promise<void>((resolve, reject) => {
      const compiler = rspack(consumers.map(name => ({
        mode: 'production', target: ['web', 'es2022'],
        entry: path.join(root, 'tests/fixtures/bundle', `${name}.fixture.ts`),
        devtool: false,
        module: {
          rules: [{
            test: /\.ts$/, type: 'javascript/auto',
            use: [{ loader: 'builtin:swc-loader', options: {
              jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
            } }],
          }],
        },
        resolve: { alias: { 'light-sprite$': publicEntry } },
        output: { path: output, filename: `${name}.min.js` },
        optimization: { minimize: true },
      })));
      compiler.run((error, stats) => {
        compiler.close(closeError => {
          if (error || closeError) reject(error || closeError);
          else if (!stats || stats.hasErrors()) reject(new Error(stats?.toString({}) || 'Missing bundle stats'));
          else resolve();
        });
      });
    });
    const sizes = await Promise.all(consumers.map(async name => {
      const source = await readFile(path.join(output, `${name}.min.js`));
      return [name, gzipSync(source, { level: 9 }).length] as const;
    }));
    return Object.fromEntries(sizes) as Record<typeof consumers[number], number>;
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
