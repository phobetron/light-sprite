import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from '@rstest/core';
import { packArtifact, requireTool, type PackedArtifact } from '../support/package/packed-artifact';

interface DeclarationMap { sources: string[]; sourcesContent?: (string | null)[]; sourceRoot?: string }

describe('published package', () => {
  let artifact: PackedArtifact;
  beforeAll(async () => { artifact = await packArtifact(); }, 30_000);
  afterAll(async () => {
    if (artifact) await rm(artifact.workspace, { recursive: true, force: true });
  });

  it('imports the public ESM exports in native Node without a TypeScript loader', () => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const api = await import('light-sprite');
      for (const name of [
        'createLightSprite', 'createLightSpriteMaterial', 'createProgram', 'computeBufferBounds',
        'createSphereGeometry', 'createBoxGeometry', 'computeBounds', 'transformBounds',
        'unionBounds', 'boundsSphere', 'identityMatrix', 'translationMatrix',
        'multiplyMatrices', 'perspectiveMatrix', 'lookAtMatrix',
      ]) assert.equal(typeof api[name], 'function', name + ' is a public function');
      assert.equal(typeof api.LIGHT_SPRITE_GLSL, 'string');
      assert.ok(api.LIGHT_SPRITE_GLSL.length > 0, 'public shader source is available');
    `], { cwd: artifact.workspace, encoding: 'utf8' });
  });

  it('compiles public declarations for ES2022 + DOM with uniform outputs and readonly structural inputs', () => {
    const result = spawnSync(process.execPath, [requireTool.resolve('typescript/lib/tsc.js'),
      '--project', path.join(artifact.workspace, 'tsconfig.json')],
    { cwd: artifact.workspace, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Consumer compilation failed:\n${result.stdout}${result.stderr}`);
  }, 30_000);

  it('packages the public targets, source files, documentation, and no development artifacts', () => {
    assert.equal(artifact.manifest.name, 'light-sprite');
    for (const target of [artifact.manifest.types, artifact.manifest.exports['.'].types, artifact.manifest.exports['.'].import,
      'src/index.ts', 'README.md', 'LICENSE']) {
      assert.ok(artifact.files.has(target.replace(/^\.\//, '')), `Missing package file: ${target}`);
    }
    for (const file of artifact.files) {
      assert.ok(!/^(?:tests|examples|node_modules|build|demo-dist)\//.test(file), `Development artifact packaged: ${file}`);
    }
  });

  it('resolves every declaration-map source within the extracted package', async () => {
    const declarations = (await readdir(path.join(artifact.installed, 'dist'))).filter(name => name.endsWith('.d.ts'));
    assert.ok(declarations.includes('index.d.ts'), 'Public declarations are present');
    for (const name of declarations) {
      const declaration = await readFile(path.join(artifact.installed, 'dist', name), 'utf8');
      const reference = declaration.match(/\/\/# sourceMappingURL=(.+)/)?.[1]?.trim();
      assert.ok(reference, `${name} lacks a declaration map`);
      const mapPath = path.resolve(artifact.installed, 'dist', reference);
      const map = JSON.parse(await readFile(mapPath, 'utf8')) as DeclarationMap;
      assert.ok(map.sources.length > 0, `${name} map has no sources`);
      for (const [index, source] of map.sources.entries()) {
        if (map.sourcesContent?.[index] != null) {
          assert.ok(map.sourcesContent[index].length > 0, `Empty embedded source: ${source}`);
          continue;
        }
        const sourcePath = path.resolve(path.dirname(mapPath), map.sourceRoot || '', source);
        const relative = path.relative(artifact.installed, sourcePath);
        assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `Source escapes package: ${source}`);
        assert.ok(artifact.files.has(relative.split(path.sep).join('/')), `Source absent from package: ${source}`);
        assert.ok((await readFile(sourcePath, 'utf8')).length > 0, `Empty source: ${source}`);
      }
    }
  });

});
