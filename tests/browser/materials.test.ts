import { test, expect } from '../support/browser-fixture';

test('roughness controls aligned highlight strength and angular spread', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      const sharp = gpu.material({ baseColor: [0, 0, 0], roughness: 0.2 });
      const rough = gpu.material({ baseColor: [0, 0, 0], roughness: 0.8 });
      return {
        alignedSharp: gpu.probe(light, shader, sharp).pixel,
        alignedRough: gpu.probe(light, shader, rough).pixel,
        angledSharp: gpu.probe(light, shader, sharp, { camera: [1, 0, 1] }).pixel,
        angledRough: gpu.probe(light, shader, rough, { camera: [1, 0, 1] }).pixel,
      };
    } finally { gpu.dispose(); }
  });
  expect(result.alignedSharp[0]).toBeGreaterThan(result.alignedRough[0] + 80);
  expect(result.angledSharp[0]).toBeLessThan(result.alignedSharp[0] / 4);
  expect(result.angledRough[0]).toBeGreaterThan(result.angledSharp[0]);
});

test('scalar and RGB reflectance independently control highlights', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      return {
        weak: gpu.probe(light, shader, gpu.material({ baseColor: [0, 0, 0], roughness: 0.4, specularReflectance: 0.02 })).pixel,
        strong: gpu.probe(light, shader, gpu.material({ baseColor: [0, 0, 0], roughness: 0.4, specularReflectance: 0.12 })).pixel,
        tint: gpu.probe(light, shader, gpu.material({ baseColor: [0, 0, 0], roughness: 0.4, specularReflectance: [0.12, 0.02, 0.02] })).pixel,
      };
    } finally { gpu.dispose(); }
  });
  expect(result.strong[0]).toBeGreaterThan(result.weak[0] + 20);
  expect(result.tint[0]).toBeGreaterThan(result.tint[1] + 20);
  expect(result.tint[1]).toBe(result.tint[2]);
});

test('camera position and explicit view direction agree and preserve the consumer program', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] });
      const surface = gpu.material({ baseColor: [0, 0, 0], roughness: 0.4, specularReflectance: 0.12 });
      return {
        implicit: gpu.probe(light, gpu.program(light), surface, { camera: [1, 0, 1] }),
        explicit: gpu.probe(light, gpu.program(light, 'view'), surface, { binding: {}, view: [1, 0, 1] }),
      };
    } finally { gpu.dispose(); }
  });
  expect(result.implicit.pixel).toEqual(result.explicit.pixel);
  expect(result.implicit.preservedProgram).toBe(true);
  expect(result.explicit.preservedProgram).toBe(true);
});

test('compiled implicit-view shaders reject omitted and malformed camera positions', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      const rejected = (fn: () => unknown) => { try { fn(); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); } };
      return [
        rejected(() => light.bindLighting(shader)),
        ...[[NaN, 0, 0], [1e40, 0, 0], [0, 0]].map(cameraPosition => rejected(() => light.bindLighting(shader, { cameraPosition: cameraPosition as unknown as import('../../src/index').Vec3 }))),
      ];
    } finally { gpu.dispose(); }
  });
  expect(result).toHaveLength(4);
  for (const message of result) expect(message).toMatch(/cameraPosition/);
});

test('custom incoming-light BRDF retains legacy matte brightness', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] });
      const surface = gpu.material({ baseColor: [0.2, 0.4, 0.6] });
      return {
        legacy: gpu.probe(light, gpu.program(light, 'legacy'), surface, { ambient: 0.03, binding: {} }).pixel,
        custom: gpu.probe(light, gpu.program(light, 'sample'), surface, { ambient: 0.03, binding: {} }).pixel,
      };
    } finally { gpu.dispose(); }
  });
  expect(result.custom).toEqual(result.legacy);
  for (const [channel, base] of [0.2, 0.4, 0.6].entries()) {
    const linear = base * (0.03 + 6 / (4 * Math.PI));
    expect(Math.abs(result.legacy[channel] - 255 * linear / (1 + linear))).toBeLessThanOrEqual(1);
  }
});

test('aligned GPU shading agrees with the independent GGX reference', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      return gpu.probe(light, shader, gpu.material({ baseColor: [0, 0, 0], roughness: 0.4, specularReflectance: 0.12 })).pixel;
    } finally { gpu.dispose(); }
  });
  // Aligned GGX: D = 1/(pi * roughness^4), V = 1/4, F = F0.
  const linear = 0.12 / (4 * Math.PI * 0.4 ** 4) * 6 / (4 * Math.PI);
  expect(Math.abs(result[0] - 255 * linear / (1 + linear))).toBeLessThanOrEqual(1);
});

test('marker movement changes highlights and range cuts off specular light', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      const surface = gpu.material({ baseColor: [0, 0, 0], roughness: 0.2 });
      const initial = gpu.probe(light, shader, surface).pixel;
      light.setPosition([0.6, 0, 1]);
      const moved = gpu.probe(light, shader, surface).pixel;
      light.setPosition([0, 0, 1]);
      light.setLight({ range: 0.5 });
      return { initial, moved, outsideRange: gpu.probe(light, shader, surface).pixel };
    } finally { gpu.dispose(); }
  });
  expect(result.moved[0]).toBeLessThan(result.initial[0] / 4);
  expect(result.outsideRange[0]).toBe(0);
});

test('degenerate and back-facing surfaces produce finite dark direct lighting', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      const surface = gpu.material({ roughness: 0 });
      return [
        gpu.probe(light, shader, surface, { normal: [0, 0, 0] }).pixel,
        gpu.probe(light, shader, surface, { normal: [0, 0, -1] }).pixel,
        gpu.probe(light, shader, surface, { camera: [0, 0, -2] }).pixel,
        gpu.probe(light, shader, surface, { position: [0, 0, 1] }).pixel,
      ];
    } finally { gpu.dispose(); }
  });
  for (const pixel of result) expect(pixel.slice(0, 3)).toEqual([0, 0, 0]);
});

test('shadows remove diffuse and specular while retaining ambient and expose standalone visibility', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1], shadows: { resolution: 64 }, models: [{ geometry: gpu.lib.createBoxGeometry({ width: 0.3, height: 0.3, depth: 0.3 }), worldMatrix: gpu.lib.translationMatrix([0, 0, 0.5]) }] });
      const shader = gpu.program(light);
      const surface = gpu.material({ baseColor: [0.4, 0.4, 0.4], roughness: 0.4, specularReflectance: 0.12 });
      return {
        blocked: gpu.probe(light, shader, surface, { ambient: 0.03 }).pixel,
        unblocked: gpu.probe(light, shader, surface, { ambient: 0.03, binding: { cameraPosition: [0, 0, 2], shadows: false } }).pixel,
        visibility: gpu.probe(light, gpu.program(light, 'visibility'), surface, { binding: {} }).pixel,
      };
    } finally { gpu.dispose(); }
  });
  expect(Math.abs(result.blocked[0] - 255 * 0.012 / 1.012)).toBeLessThanOrEqual(1);
  expect(result.unblocked[0]).toBeGreaterThan(result.blocked[0] + 30);
  expect(result.visibility[0]).toBe(0);
});

test('radiance-only shaders skip invalidated shadow maps while enabled visibility regenerates them', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const { gl } = gpu;
      const light = gpu.sprite({ position: [0, 0, 1], shadows: { resolution: 64 }, models: [{ geometry: gpu.lib.createBoxGeometry({ width: 0.3, height: 0.3, depth: 0.3 }), worldMatrix: gpu.lib.translationMatrix([0, 0, 0.5]) }] });
      const visibilityShader = gpu.program(light, 'visibility'), radianceShader = gpu.program(light, 'radiance');
      const surface = gpu.material({});
      gpu.probe(light, visibilityShader, surface, { binding: {} });
      // Dirty an already generated map so a zero count cannot merely reflect cache reuse.
      light.setPosition([0, 0, 1.1]);
      let depthDraws = 0;
      const drawArrays = gl.drawArrays.bind(gl), drawElements = gl.drawElements.bind(gl);
      gl.drawArrays = (...args) => { if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)) depthDraws++; return drawArrays(...args); };
      gl.drawElements = (...args) => { if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)) depthDraws++; return drawElements(...args); };
      try {
        const radiance = gpu.probe(light, radianceShader, surface, { binding: { shadows: false } }).pixel;
        const unusedDraws = depthDraws;
        let omittedShadowsError = '';
        try { light.bindLighting(radianceShader); } catch (error) { omittedShadowsError = error instanceof Error ? error.message : String(error); }
        gpu.probe(light, visibilityShader, surface, { binding: {} });
        return { radiance, unusedDraws, enabledDraws: depthDraws - unusedDraws, omittedShadowsError };
      } finally { gl.drawArrays = drawArrays; gl.drawElements = drawElements; }
    } finally { gpu.dispose(); }
  });
  expect(result.radiance[0]).toBeGreaterThan(20);
  expect(result.unusedDraws).toBe(0);
  expect(result.enabledDraws).toBeGreaterThan(0);
  expect(result.omittedShadowsError).toMatch(/visibility|shadows/);
});

test('shared flicker multiplier dims specular intensity according to the GGX reference', async ({ gpuPage }) => {
  const result = await gpuPage.evaluate(async () => {
    const url = '/support/materials.js';
    const { createMaterialProbe } = await import(url) as typeof import('../support/browser/materials');
    const gpu = createMaterialProbe();
    try {
      const light = gpu.sprite({ position: [0, 0, 1] }), shader = gpu.program(light);
      const surface = gpu.material({ baseColor: [0, 0, 0], roughness: 0.4, specularReflectance: 0.12 });
      const aligned = gpu.probe(light, shader, surface).pixel;
      light.setFlicker({ depth: 0.8, speed: 2, seed: 17 });
      for (let frame = 0; frame < 32 && light.brightness > 0.65; frame++) light.update(0.125);
      return { aligned, dimmed: gpu.probe(light, shader, surface).pixel, brightness: light.brightness };
    } finally { gpu.dispose(); }
  });
  const linear = 0.12 / (4 * Math.PI * 0.4 ** 4) * 6 / (4 * Math.PI) * result.brightness;
  expect(Math.abs(result.dimmed[0] - 255 * linear / (1 + linear))).toBeLessThanOrEqual(1);
  expect(result.dimmed[0]).toBeLessThan(result.aligned[0]);
});

