import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const root = process.cwd();
export const requireTool = createRequire(path.join(root, 'package.json'));

interface PackMetadata { filename: string; files: { path: string }[] }
export interface PackageManifest {
  name: string;
  types: string;
  exports: { '.': { types: string; import: string } };
}

export async function packArtifact() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'light-sprite-package-'));
  try {
    // The suite's caller builds once. Packing must not invoke prepack again.
    const [packed] = JSON.parse(execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', workspace,
    ], { cwd: root, encoding: 'utf8' })) as PackMetadata[];
    assert.ok(packed?.filename && packed.files.length, 'npm pack returned no artifact');
    const installed = path.join(workspace, 'node_modules', 'light-sprite');
    await mkdir(installed, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(workspace, packed.filename), '--strip-components=1', '-C', installed]);
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
    await cp(path.join(root, 'tests/fixtures/package/consumer-types.fixture.ts'), path.join(workspace, 'consumer.ts'));
    await writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'], types: [], strict: true, skipLibCheck: false,
        noEmit: true, noUnusedLocals: true,
      },
      files: ['consumer.ts'],
    }));
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')) as PackageManifest;
    return { workspace, installed, manifest, files: new Set(packed.files.map(file => file.path)) };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export type PackedArtifact = Awaited<ReturnType<typeof packArtifact>>;
