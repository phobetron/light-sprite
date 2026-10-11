import type { LightSprite } from '../../../src/index';
import { createGpu, lib } from './gpu.js';
export { check, equal, near, rejects as throws } from './movement.js';
// Sixteen blended layers round by up to half a byte in each compared frame.
export const haloTolerance = (scale: number) => 16 * 0.5 * (1 + Math.abs(scale));
export async function createEffectsHarness() {
  const gpu = await createGpu({ width: 192, height: 192 });
  const { gl } = gpu;
  const program = (fragment: string) => {
    const result = gpu.program(`#version 300 es
    uniform float z;
    void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, z, 1.0);
    }`, fragment);
    return result;
  };
  let vao = gpu.vao();
  const vp = lib.identityMatrix();
  const reset = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 192, 192);
    gl.depthFunc(gl.LESS);
    gl.depthRange(0, 1);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE])
      gl.disable(cap);
    gl.clearColor(0, 0, 0, 0.25);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  };
  const pixel = (x = 96, y = 96) => {
    const output = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, output);
    return [...output];
  };
  const render = (controller: LightSprite) => {
    reset();
    controller.render({ viewProjection: vp });
    return { center: pixel(), ring: pixel(106), outer: pixel(114) };
  };
  const draw = (target: WebGLProgram, z = 0) => {
    gl.useProgram(target);
    gl.bindVertexArray(vao);
    gl.uniform1f(gl.getUniformLocation(target, 'z'), z);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  return { ...gpu, lib, program, vp, reset, pixel, render, draw, get vao() { return vao; },
    renewVao: () => { vao = gpu.vao(); },
  };
}
