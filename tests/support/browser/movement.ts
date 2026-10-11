import type { Bounds3, LightSprite, LightingOptions, MovementBounds, Vec3 } from '../../../src/index';
import { createGpu, lib } from './gpu.js';
export { check, equal, throws as rejects } from './gpu.js';
import { check, equal } from './gpu.js';
export function near(actual: number, expected: number, tolerance: number, message: string) {
  check(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);
}
export const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((value, axis) => value - b[axis]));
export async function createMovementHarness() {
  const gpu = await createGpu({ width: 32, height: 32 });
  const { gl } = gpu;
  const box = (size = 0.3) => lib.createBoxGeometry({ width: size, height: size, depth: size });
  const cubeBounds: MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [4, 4, 4] };
  const sphereBounds: MovementBounds = { shape: 'sphere', center: [0, 0, 0], radius: 2 };
  const validate = (controller: LightSprite, bounds: MovementBounds, obstacles: readonly Bounds3[] = []) => {
    const enclosure = controller.movementSphere;
    check(enclosure && enclosure.radius > 0, 'Movement supplies a positive world enclosure');
    near(enclosure.clearance, enclosure.radius * 0.2, 1e-8, 'Clearance is ten percent of the enclosure diameter');
    if (bounds.shape === 'sphere') {
      check(distance(enclosure.center, bounds.center) + enclosure.radius < bounds.radius + 1e-7, 'The complete enclosure stays within spherical bounds');
    } else {
      check(enclosure.center.every((value, axis) => Math.abs(value - bounds.center[axis]) + enclosure.radius < bounds.size[axis] / 2 + 1e-7), 'The complete enclosure stays within cube bounds');
    }
    for (const obstacle of obstacles) {
      const gap = Math.hypot(...enclosure.center.map((value, axis) => Math.max(obstacle.min[axis] - value, 0, value - obstacle.max[axis])));
      check(gap > enclosure.radius + enclosure.clearance - 1e-7, `Enclosure retains obstacle clearance: ${gap}`);
    }
  };
  const program = (source: string) => {
    const result = gpu.program(`#version 300 es
    void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0,1); }`, `#version 300 es
    precision highp float;
    uniform vec3 probePosition; uniform vec3 probeNormal; out vec4 color;
    ${source}
    void main() { color=vec4(lightSpriteShade(vec3(1),probePosition,probeNormal),1); }`);
    return result;
  };
  let vao = gpu.vao();
  const probe = (controller: LightSprite, target: WebGLProgram, position: Vec3, normal: Vec3, options: LightingOptions = {}) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 32, 32);
    for (const cap of [gl.DEPTH_TEST, gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD])
      gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.bindVertexArray(vao);
    controller.bindLighting(target, { ambient: 0.05, ...options });
    gl.useProgram(target);
    gl.uniform3fv(gl.getUniformLocation(target, 'probePosition'), position);
    gl.uniform3fv(gl.getUniformLocation(target, 'probeNormal'), normal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = new Uint8Array(4);
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    check(gl.getError() === gl.NO_ERROR, 'Moving light and receiver rendering have no WebGL errors');
    return [...pixel];
  };
  return { ...gpu, lib, box, cubeBounds, sphereBounds, validate, program, probe,
    renewVao: () => { vao = gpu.vao(); },
  };
}
// Optional browser CPU benchmark; never invoked by correctness tests.
export async function benchmarkMovement() {
  const harness = await createMovementHarness();
  const { gl, lib, sprite, box, cubeBounds, validate } = harness;
  const getBufferSubData = gl.getBufferSubData.bind(gl), getParameter = gl.getParameter.bind(gl);
  let readbacks = 0, queries = 0;
  gl.getBufferSubData = (...args) => { readbacks++; return getBufferSubData(...args); };
  gl.getParameter = (...args) => { queries++; return getParameter(...args); };
  try {
    const timings = [];
    for (const modelCount of [2, 100]) {
      let matrixReads = 0;
      const benchmarkBounds: MovementBounds = modelCount === 2 ? cubeBounds : { shape: 'cube', center: [0, 0, 0], size: [16, 16, 16] };
      const models = Array.from({ length: modelCount }, (_, index) => {
        const transform = lib.translationMatrix(modelCount === 2
          ? [index === 0 ? -0.8 : 0.8, 0, 0]
          : [(index % 10 - 4.5), 0, (Math.floor(index / 10) - 4.5)]);
        return { geometry: box(), worldMatrix: () => { matrixReads++; return transform; }, castsShadow: false };
      });
      const samples = [];
      const percentiles99 = [], worstUpdates = [];
      for (const seed of [1, 17, 91]) {
        const measured = sprite({ movement: { bounds: benchmarkBounds, seed }, models });
        for (let i = 0; i < 100; i++)
          measured.update(1 / 60);
        const beforeReads = readbacks, beforeQueries = queries, beforeMatrices = matrixReads;
        const start = performance.now();
        const updateTimes = [];
        for (let i = 0; i < 3000; i++) {
          const beginUpdate = performance.now();
          measured.update(1 / 60);
          updateTimes.push(performance.now() - beginUpdate);
        }
        samples.push((performance.now() - start) / 3000);
        updateTimes.sort((a, b) => a - b);
        percentiles99.push(updateTimes[Math.floor(updateTimes.length * 0.99)]);
        worstUpdates.push(updateTimes[updateTimes.length - 1]);
        equal(readbacks, beforeReads, 'Benchmarked updates use cached local geometry');
        equal(queries, beforeQueries, 'Benchmarked updates issue no WebGL queries');
        check(matrixReads - beforeMatrices >= modelCount * 3000, 'Updates observe current consumer transform getters');
        validate(measured, benchmarkBounds, measured.getModelBounds());
        measured.dispose();
      }
      timings.push({ models: modelCount, samples: 3000, seeds: [1, 17, 91], millisecondsPerUpdate: samples, percentile99Milliseconds: percentiles99, worstUpdateMilliseconds: worstUpdates });
    }
    return timings;
  } finally {
    gl.getBufferSubData = getBufferSubData;
    gl.getParameter = getParameter;
    harness.dispose();
  }
}
