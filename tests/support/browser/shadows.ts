import { createGpu, lib, check, restoreContext } from './gpu.js';
import type { LightSprite, LightingOptions } from '../../../src/index.js';

/** Minimal lit receiver and depth-draw observer shared by shadow scenarios. */
export function createShadowProbe() {
  const gpu = createGpu({ width: 32, height: 32 });
  const { gl } = gpu;
  const textures: WebGLTexture[] = [], samplers: WebGLSampler[] = [], framebuffers: WebGLFramebuffer[] = [];
  const vertex = `#version 300 es
  void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0,1); }`;
  const program = (source: string) => gpu.program(vertex, `#version 300 es
  precision highp float;
  uniform vec3 probePosition; uniform vec3 probeNormal;
  out vec4 color;
  ${source}
  void main() { color=vec4(lightSpriteShade(vec3(1),probePosition,probeNormal),1); }`);
  let probeVao = gpu.vao();
  const resetDrawState = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 32, 32);
    for (const cap of [gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.BLEND, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD]) gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.bindVertexArray(probeVao);
  };
  const probe = (controller: LightSprite, shader: WebGLProgram, position: number[], normal: number[], options: LightingOptions = {}) => {
    resetDrawState();
    controller.bindLighting(shader, { ambient: 0.05, ...options });
    gl.useProgram(shader);
    gl.uniform3fv(gl.getUniformLocation(shader, 'probePosition'), position);
    gl.uniform3fv(gl.getUniformLocation(shader, 'probeNormal'), normal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = gpu.pixel();
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Shadow probe WebGL error: ${error}`);
    return pixel;
  };
  let shadowDraws = 0;
  const indexedDrawTypes: number[] = [];
  const drawArrays = gl.drawArrays.bind(gl), drawElements = gl.drawElements.bind(gl);
  gl.drawArrays = (...args) => {
    if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)) shadowDraws++;
    return drawArrays(...args);
  };
  gl.drawElements = (...args) => {
    if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)) { shadowDraws++; indexedDrawTypes.push(args[2]); }
    return drawElements(...args);
  };
  return {
    ...gpu, lib, program, probe, indexedDrawTypes,
    box: () => lib.createBoxGeometry({ width: 0.3, height: 0.3, depth: 0.3 }),
    bindCount(controller: LightSprite, shader: WebGLProgram, options?: LightingOptions) {
      const before = shadowDraws;
      controller.bindLighting(shader, options);
      return shadowDraws - before;
    },
    texture() { const value = gl.createTexture(); check(value, 'Allocate host texture'); textures.push(value); return value; },
    sampler() { const value = gl.createSampler(); check(value, 'Allocate host sampler'); samplers.push(value); return value; },
    framebuffer() { const value = gl.createFramebuffer(); check(value, 'Allocate host framebuffer'); framebuffers.push(value); return value; },
    async restore() { await restoreContext(gpu.canvas, gl); probeVao = gpu.vao(); },
    dispose() {
      gl.drawArrays = drawArrays;
      gl.drawElements = drawElements;
      for (const value of textures) gl.deleteTexture(value);
      for (const value of samplers) gl.deleteSampler(value);
      for (const value of framebuffers) gl.deleteFramebuffer(value);
      gpu.dispose();
    },
  };
}
