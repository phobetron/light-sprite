import { createGpu, lib } from './gpu.js';
import type { LightSprite, LightingOptions, LightSpriteMaterialSnapshot, MutableVec3, Vec3 } from '../../../src/index.js';

type ShaderMode = 'camera' | 'view' | 'legacy' | 'sample' | 'radiance' | 'visibility';
export interface MaterialProbeOptions {
  ambient?: number;
  binding?: LightingOptions;
  camera?: Vec3;
  position?: MutableVec3;
  normal?: MutableVec3;
  view?: MutableVec3;
}

/** A fullscreen consumer shader exercising the public lighting GLSL on a real GPU. */
export function createMaterialProbe() {
  const gpu = createGpu({ width: 32, height: 32 });
  const { gl } = gpu;
  const vao = gpu.vao();
  const vertex = `#version 300 es
  void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0,1); }`;
  const program = (sprite: LightSprite, mode: ShaderMode = 'camera') => {
    const expression = mode === 'camera' ? 'lightSpriteShade(material, surfacePosition, surfaceNormal)'
      : mode === 'view' ? 'lightSpriteShade(material, surfacePosition, surfaceNormal, viewDirection)'
      : mode === 'legacy' ? 'lightSpriteShade(baseColor, surfacePosition, surfaceNormal)'
      : mode === 'sample' ? 'baseColor * (u_lightSpriteAmbient + incoming.radiance * incoming.visibility * max(dot(normalize(surfaceNormal),incoming.direction),0.0))'
      : mode === 'radiance' ? 'lightSpriteRadiance(surfacePosition)'
      : 'vec3(lightSpriteShadowVisibility(surfacePosition, surfaceNormal))';
    return gpu.program(vertex, `#version 300 es
    precision highp float;
    uniform vec3 baseColor; uniform float roughness; uniform vec3 reflectance;
    uniform vec3 surfacePosition; uniform vec3 surfaceNormal; uniform vec3 viewDirection;
    out vec4 color;
    ${sprite.lightingGLSL}
    void main() {
      LightSpriteMaterial material=lightSpriteMaterial(baseColor,roughness,reflectance);
      ${mode === 'sample' ? 'LightSpriteLightSample incoming=lightSpriteSample(surfacePosition,surfaceNormal);' : ''}
      color=vec4(lightSpriteToneMap(${expression}),1.0);
    }`);
  };
  const probe = (sprite: LightSprite, shader: WebGLProgram, material: LightSpriteMaterialSnapshot, options: MaterialProbeOptions = {}) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 32, 32);
    for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.DITHER, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.CULL_FACE]) gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(vao);
    gl.useProgram(shader);
    const before = gl.getParameter(gl.CURRENT_PROGRAM);
    sprite.bindLighting(shader, { ambient: options.ambient ?? 0, ...(options.binding ?? { cameraPosition: options.camera ?? [0, 0, 2] }) });
    const preservedProgram = gl.getParameter(gl.CURRENT_PROGRAM) === before;
    gl.uniform3fv(gl.getUniformLocation(shader, 'baseColor'), material.baseColor);
    gl.uniform1f(gl.getUniformLocation(shader, 'roughness'), material.roughness);
    gl.uniform3fv(gl.getUniformLocation(shader, 'reflectance'), material.specularReflectance);
    gl.uniform3fv(gl.getUniformLocation(shader, 'surfacePosition'), options.position ?? [0, 0, 0]);
    gl.uniform3fv(gl.getUniformLocation(shader, 'surfaceNormal'), options.normal ?? [0, 0, 1]);
    gl.uniform3fv(gl.getUniformLocation(shader, 'viewDirection'), options.view ?? [0, 0, 1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = gpu.pixel(16, 16);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Material probe WebGL error: ${error}`);
    return { pixel, preservedProgram };
  };
  return { ...gpu, lib, program, probe, material: lib.createLightSpriteMaterial };
}
