import { test, expect } from '../support/browser-fixture';

test('base lighting renders without shadow resources', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const plain = sprite({ position: [0, 0, 1] });
      return probe(plain, program(plain.lightingGLSL), [0, 0, 0], [0, 0, 1]);
    } finally { gpu.dispose(); }
  });
  expect(result[0]).toBeGreaterThan(100);
});

test('opaque casters retain ambient and clear receivers match unshadowed lighting beyond caster distance', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const source = sprite({ position: [0, 0, 1], models: [{ geometry: box(), worldMatrix: lib.translationMatrix([0, 0, 0.5]) }], shadows: true });
      const shader = program(source.lightingGLSL);
      return {
        blocked: probe(source, shader, [0, 0, 0], [0, 0, 1]),
        disabled: probe(source, shader, [0, 0, 0], [0, 0, 1], { shadows: false }),
        clear: probe(source, shader, [0.8, 0, 0], [0, 0, 1]),
        farBlocked: probe(source, shader, [0, 0, -1], [0, 0, 1]),
        farClear: probe(source, shader, [1.5, 0, -1], [0, 0, 1]),
        farReference: probe(source, shader, [1.5, 0, -1], [0, 0, 1], { shadows: false }),
      };
    } finally { gpu.dispose(); }
  });
  for (const pixel of [result.blocked, result.farBlocked]) {
    for (const channel of pixel.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
    expect(pixel[3]).toBe(255);
  }
  expect(result.disabled[0]).toBeGreaterThan(result.blocked[0] + 15);
  expect(result.clear[0]).toBeGreaterThan(result.blocked[0] + 15);
  // Point attenuation at this distance yields roughly 0.061 direct light.
  expect(Math.abs(result.farReference[0] - 28)).toBeLessThanOrEqual(2);
  expect(result.farClear).toEqual(result.farReference);
});

test('shadow cache ignores appearance and camera but follows transform and light movement', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      let matrix = lib.translationMatrix([0, 0, 0.5]);
      const source = sprite({ position: [0, 0, 1], models: [{ geometry: box(), worldMatrix: () => matrix }], shadows: true });
      const shader = program(source.lightingGLSL);
      const first = bindCount(source, shader), cached = bindCount(source, shader);
      const blocked = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      source.setLight({ intensity: 7, color: [0.8, 0.7, 0.6] });
      const appearance = bindCount(source, shader);
      source.render({ viewProjection: lib.identityMatrix() });
      const rendered = bindCount(source, shader);
      source.setLight({ intensity: 6, color: [1, 1, 1] });
      matrix[12] = 1;
      const transform = bindCount(source, shader), transformCached = bindCount(source, shader);
      const movedCaster = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      matrix = lib.translationMatrix([0, 0, 0.5]);
      const returnedCaster = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      source.setPosition([1, 0, 1]);
      const light = bindCount(source, shader);
      const movedLight = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      source.setPosition([0, 0, 1]);
      return { first, cached, appearance, rendered, transform, transformCached, light, blocked, movedCaster, returnedCaster, movedLight, returnedLight: probe(source, shader, [0, 0, 0], [0, 0, 1]) };
    } finally { gpu.dispose(); }
  });
  expect(result.first).toBeGreaterThan(0);
  for (const count of [result.cached, result.appearance, result.rendered, result.transformCached]) expect(count).toBe(0);
  expect(result.transform).toBeGreaterThan(0);
  expect(result.light).toBeGreaterThan(0);
  expect(result.movedCaster[0]).toBeGreaterThan(result.blocked[0] + 15);
  expect(result.movedLight[0]).toBeGreaterThan(result.blocked[0] + 15);
  expect(result.returnedCaster).toEqual(result.blocked);
  expect(result.returnedLight).toEqual(result.blocked);
});

test('explicit refresh uploads in-place CPU caster edits and invalidates the map', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const geometry = box();
      const source = sprite({ position: [0, 0, 1], models: [{ geometry, worldMatrix: lib.translationMatrix([0, 0, 0.5]) }], shadows: true });
      const shader = program(source.lightingGLSL);
      const blocked = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      for (let i = 0; i < geometry.positions.length; i += 3) geometry.positions[i] += 1;
      const unrefreshed = bindCount(source, shader);
      source.refreshBounds();
      const refreshed = bindCount(source, shader);
      return { blocked, unrefreshed, refreshed, clear: probe(source, shader, [0, 0, 0], [0, 0, 1]) };
    } finally { gpu.dispose(); }
  });
  expect(result.unrefreshed).toBe(0);
  expect(result.refreshed).toBeGreaterThan(0);
  expect(result.clear[0]).toBeGreaterThan(result.blocked[0] + 15);
});

test('a remote registered caster preserves nearby occlusion precision', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const source = sprite({ position: [0, 0, 0], shadows: true, models: [
        { geometry: lib.createBoxGeometry({ width: 0.1, height: 0.1, depth: 0.1 }), worldMatrix: lib.translationMatrix([0, 0, 0.5]) },
        { geometry: lib.createBoxGeometry({ width: 0.1, height: 0.1, depth: 0.1 }), worldMatrix: lib.translationMatrix([0, 0, 1e6]) },
      ] });
      const shader = program(source.lightingGLSL);
      return { blocked: probe(source, shader, [0, 0, 1], [0, 0, -1]), reference: probe(source, shader, [0, 0, 1], [0, 0, -1], { shadows: false }) };
    } finally { gpu.dispose(); }
  });
  for (const channel of result.blocked.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
  expect(result.blocked[3]).toBe(255);
  expect(result.reference[0]).toBeGreaterThan(result.blocked[0] + 15);
});

test('grazing-angle bias avoids self-shadow speckles on illuminated surfaces', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const source = sprite({ position: [1.8, 0, 0.05], light: { intensity: 60 }, shadows: true, models: [{ geometry: { positions: new Float32Array([-2, -2, 0, 2, -2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2, 2, 0]) } }] });
      const shader = program(source.lightingGLSL);
      return [-0.61, -0.13, 0.27].flatMap(x => [-0.19, 0.07, 0.31].map(y => ({
        position: [x, y, 0],
        reference: probe(source, shader, [x, y, 0], [0, 0, 1], { shadows: false }),
        shadowed: probe(source, shader, [x, y, 0], [0, 0, 1]),
      })));
    } finally { gpu.dispose(); }
  });
  for (const sample of result) {
    expect(sample.reference[0], `reference at ${sample.position}`).toBeGreaterThan(15);
    expect(sample.shadowed, `self-shadow at ${sample.position}`).toEqual(sample.reference);
  }
});

test('excluded models and marker proxies cast no shadows and empty maps keep distant receivers lit', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const source = sprite({ position: [0, 0, 1], models: [{ geometry: box(), worldMatrix: lib.translationMatrix([0, 0, 0.5]) }], shadows: true });
      const shader = program(source.lightingGLSL);
      const blocked = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      const excluded = sprite({ position: [0, 0, 1], marker: 'cube', diameter: 0.5, shadows: true, models: [{ geometry: box(), worldMatrix: lib.translationMatrix([0, 0, 0.5]), castsShadow: false }] });
      const empty = sprite({ position: [0, 0, 1], models: [], shadows: true });
      return { blocked, excluded: probe(excluded, shader, [0, 0, 0], [0, 0, 1]), empty: probe(empty, shader, [0, 0, -1], [0, 0, 1]) };
    } finally { gpu.dispose(); }
  });
  expect(result.excluded[0]).toBeGreaterThan(result.blocked[0] + 15);
  expect(result.empty[0]).toBeGreaterThan(result.blocked[0] + 15);
});

test('CPU position sources honor interleaved layouts and selected indexed draw ranges', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const geometry = box();
      if (!geometry.indices) throw new Error('Box fixture requires indices');
      const positions = new Float32Array(geometry.positions.length / 3 * 4);
      for (let i = 0; i < geometry.positions.length / 3; i++) positions.set([99, ...geometry.positions.slice(i * 3, i * 3 + 3)], i * 4);
      const indices = new Float32Array([0, 0, 0, ...geometry.indices]);
      const source = sprite({ position: [0, 0, 1], shadows: true, models: [{ geometry: { positions, stride: 4, offset: 1, indices, start: 3, count: geometry.indices.length }, worldMatrix: lib.translationMatrix([0, 0, 0.5]) }] });
      return probe(source, program(source.lightingGLSL), [0, 0, 0], [0, 0, 1]);
    } finally { gpu.dispose(); }
  });
  for (const channel of result.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
  expect(result[3]).toBe(255);
});

test('65536 compact vertices widen shadow indices past the primitive restart sentinel', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      // Vertex 65535 is a numeric source reference, but a reserved uint16 GPU index.
      const positions = new Float32Array(65536 * 3);
      positions.set([-0.2, -0.2, 0.5, 0.2, -0.2, 0.5, 0, 0.2, 0.5], 65533 * 3);
      const indices = new Uint16Array(65536 * 3 + 3);
      for (let vertex = 0; vertex < 65536; vertex++) indices.fill(vertex, vertex * 3, vertex * 3 + 3);
      indices.set([65533, 65534, 65535], 65536 * 3);
      const source = sprite({ position: [0, 0, 1], shadows: true, models: [{ geometry: { positions, indices } }] });
      const pixel = probe(source, program(source.lightingGLSL), [0, 0, 0], [0, 0, 1]);
      return { pixel, drawTypes: gpu.indexedDrawTypes, uint32: gl.UNSIGNED_INT };
    } finally { gpu.dispose(); }
  });
  for (const channel of result.pixel.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
  expect(result.pixel[3]).toBe(255);
  expect(result.drawTypes).toEqual(Array(6).fill(result.uint32));
});

test('GPU position source refresh reads changed interleaved geometry and disposal preserves consumer resources', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const geometry = box();
      if (!geometry.indices) throw new Error('Box fixture requires indices');
      const interleaved = new Float32Array(geometry.positions.length / 3 * 4 + 1);
      for (let i = 0; i < geometry.positions.length / 3; i++) interleaved.set([...geometry.positions.slice(i * 3, i * 3 + 3), 99], i * 4 + 1);
      const buffer = gpu.buffer(interleaved);
      // Float32 indices deliberately exercise the wider numeric runtime input for GPU readback.
      const geometrySource = { buffer, byteStride: 16, byteOffset: 4, count: (interleaved.length - 1) / 4, indices: new Float32Array(geometry.indices) } as unknown as import('../../src/index').BufferPositionSource;
      const source = sprite({ position: [0, 0, 1], shadows: true, models: [{ geometry: geometrySource, worldMatrix: lib.translationMatrix([0, 0, 0.5]) }] });
      const shader = program(source.lightingGLSL);
      const blocked = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      for (let i = 1; i < interleaved.length; i += 4) interleaved[i] += 1;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, interleaved);
      source.refreshBounds();
      const clear = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      source.dispose();
      return { blocked, clear, bufferAlive: gl.isBuffer(buffer), programAlive: gl.isProgram(shader) };
    } finally { gpu.dispose(); }
  });
  for (const channel of result.blocked.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
  expect(result.blocked[3]).toBe(255);
  expect(result.clear[0]).toBeGreaterThan(result.blocked[0] + 15);
  expect(result.bufferAlive).toBe(true);
  expect(result.programAlive).toBe(true);
});

test('shadow rendering restores hostile consumer GL state and reserves only its shadow texture unit', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const base = sprite({ position: [0, 0, 1] });
      const baseProgram = program(base.lightingGLSL);
      const textureUnit = Math.min(3, gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) - 1);
      const source = sprite({ position: [0, 0, 1], models: [{ geometry: box(), worldMatrix: lib.translationMatrix([0, 0, 0.5]) }], shadows: { resolution: 64, bias: 0.001, textureUnit } });
      const shader = program(source.lightingGLSL);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, gpu.framebuffer());
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.framebuffer());
      gl.bindVertexArray(gpu.vao());
      gpu.buffer(new Uint16Array([0, 1, 2]), gl.ELEMENT_ARRAY_BUFFER);
      gl.useProgram(baseProgram);
      gl.viewport(3, 4, 19, 21);
      gl.scissor(7, 8, 9, 10);
      gl.clearDepth(0.37);
      gl.depthFunc(gl.GREATER);
      gl.depthRange(0.2, 0.8);
      gl.depthMask(false);
      gl.colorMask(false, true, false, true);
      gl.frontFace(gl.CW);
      gl.cullFace(gl.FRONT);
      gl.polygonOffset(2, 3);
      const capabilities = [gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.BLEND, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD];
      for (const cap of capabilities) gl.enable(cap);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gpu.texture());
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, gpu.texture());
      gl.bindSampler(0, gpu.sampler());
      gl.bindSampler(textureUnit, gpu.sampler());
      const scalarKeys = [gl.CURRENT_PROGRAM, gl.VERTEX_ARRAY_BINDING, gl.ARRAY_BUFFER_BINDING, gl.ELEMENT_ARRAY_BUFFER_BINDING, gl.COPY_READ_BUFFER_BINDING, gl.DRAW_FRAMEBUFFER_BINDING, gl.READ_FRAMEBUFFER_BINDING, gl.DEPTH_FUNC, gl.DEPTH_WRITEMASK, gl.DEPTH_CLEAR_VALUE, gl.FRONT_FACE, gl.CULL_FACE_MODE, gl.POLYGON_OFFSET_FACTOR, gl.POLYGON_OFFSET_UNITS, gl.ACTIVE_TEXTURE, gl.TEXTURE_BINDING_2D, gl.TEXTURE_BINDING_CUBE_MAP, gl.SAMPLER_BINDING];
      const arrayKeys = [gl.VIEWPORT, gl.SCISSOR_BOX, gl.COLOR_WRITEMASK, gl.DEPTH_RANGE];
      const scalarsBefore: unknown[] = scalarKeys.map(key => gl.getParameter(key));
      const arraysBefore = arrayKeys.map(key => [...gl.getParameter(key)] as unknown[]);
      const enabledBefore = capabilities.map(cap => gl.isEnabled(cap));
      const draws = bindCount(source, shader);
      // Compare WebGL object identities in the browser; objects do not cross evaluate intact.
      const preservedScalars = scalarKeys.map((key, i) => gl.getParameter(key) === scalarsBefore[i]);
      const arraysAfter = arrayKeys.map(key => [...gl.getParameter(key)] as unknown[]);
      const enabledAfter = capabilities.map(cap => gl.isEnabled(cap));
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      const reservedSamplerDetached = gl.getParameter(gl.SAMPLER_BINDING) === null;
      const reservedCubeBound = gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP) !== null;
      gl.activeTexture(gl.TEXTURE0);
      return { draws, preservedScalars, scalarKeys, arraysBefore, arraysAfter, enabledBefore, enabledAfter, reservedSamplerDetached, reservedCubeBound, pixel: probe(source, shader, [0, 0, 0], [0, 0, 1]) };
    } finally { gpu.dispose(); }
  });
  expect(result.draws).toBeGreaterThan(0);
  for (const [index, preserved] of result.preservedScalars.entries()) expect(preserved, `GL parameter ${result.scalarKeys[index]}`).toBe(true);
  expect(result.arraysAfter).toEqual(result.arraysBefore);
  expect(result.enabledAfter).toEqual(result.enabledBefore);
  expect(result.reservedSamplerDetached).toBe(true);
  expect(result.reservedCubeBound).toBe(true);
  for (const channel of result.pixel.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
  expect(result.pixel[3]).toBe(255);
});

test('the same controller rebuilds shadows after context restoration', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/shadows.js';
    const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
    const gpu = createShadowProbe();
    const { gl, lib, sprite, box, program, probe, bindCount } = gpu;
    try {
      const source = sprite({ position: [0, 0, 1], models: [{ geometry: box(), worldMatrix: lib.translationMatrix([0, 0, 0.5]) }], shadows: true });
      const shader = program(source.lightingGLSL);
      const initial = probe(source, shader, [0, 0, 0], [0, 0, 1]);
      await gpu.restore();
      const restoredProgram = program(source.lightingGLSL);
      return { initial, blocked: probe(source, restoredProgram, [0, 0, 0], [0, 0, 1]), clear: probe(source, restoredProgram, [0.8, 0, 0], [0, 0, 1]) };
    } finally { gpu.dispose(); }
  });
  for (const pixel of [result.initial, result.blocked]) {
    for (const channel of pixel.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
    expect(pixel[3]).toBe(255);
  }
  expect(result.clear[0]).toBeGreaterThan(result.blocked[0] + 15);
});

for (const [name, axis] of [
  ['+X', [1, 0, 0]], ['-X', [-1, 0, 0]],
  ['+Y', [0, 1, 0]], ['-Y', [0, -1, 0]],
  ['+Z', [0, 0, 1]], ['-Z', [0, 0, -1]],
] as const) {
  test(`radial shadow comparison covers cube face ${name}`, async ({ gpuPage }) => {
    const result = await gpuPage.evaluate(async axis => {
      const url = '/support/shadows.js';
      const { createShadowProbe } = await import(url) as typeof import('../support/browser/shadows');
      const gpu = createShadowProbe();
      try {
        const source = gpu.sprite({ position: [0, 0, 0], models: [{ geometry: gpu.box(), worldMatrix: gpu.lib.translationMatrix([axis[0] * 0.5, axis[1] * 0.5, axis[2] * 0.5]) }], shadows: true });
        const shader = gpu.program(source.lightingGLSL);
        const position = axis.map(v => v * 1.2), normal = axis.map(v => -v);
        return { blocked: gpu.probe(source, shader, position, normal), reference: gpu.probe(source, shader, position, normal, { shadows: false }) };
      } finally { gpu.dispose(); }
    }, axis);
    for (const channel of result.blocked.slice(0, 3)) expect(Math.abs(channel - 13)).toBeLessThanOrEqual(2);
    expect(result.blocked[3]).toBe(255);
    expect(result.reference[0]).toBeGreaterThan(result.blocked[0] + 15);
  });
}
