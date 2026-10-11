import type { ResolvedGlow } from './effects';
import { assertMatrix } from './math';
import type { Mat4, Vec3 } from './types';
import { createProgram } from './webgl';

export interface GlowRenderer {
  render(params: { viewProjection: Mat4; position: Vec3; color: Vec3; brightness: number; options: ResolvedGlow }): void;
  dispose(): void;
}

const GLOW_LAYERS = 16;

/** Direction in which conventional framebuffer depth increases. */
export function glowDepthDirection(viewProjection: Mat4, right: Vec3, up: Vec3): Vec3 {
  const normal: Vec3 = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
  const orientation = viewProjection[2] * normal[0] + viewProjection[6] * normal[1] + viewProjection[10] * normal[2];
  if (!Number.isFinite(orientation) || orientation === 0) throw new RangeError('Glow camera must define a forward depth direction.');
  const sign = Math.sign(orientation);
  return [normal[0] * sign, normal[1] * sign, normal[2] * sign];
}

const layeredVertexSource = `#version 300 es
uniform mat4 u_viewProjection;
uniform vec3 u_position;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_depthDirection;
uniform float u_radius;
out vec2 v_quad;
flat out float v_layer;
const vec2 corners[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
void main() {
  v_layer = (float(gl_InstanceID) + 0.5) / ${GLOW_LAYERS}.0;
  v_quad = corners[gl_VertexID] * sqrt(max(0.0, 1.0 - v_layer * v_layer));
  vec3 world = u_position + u_radius * (u_right * v_quad.x + u_up * v_quad.y + u_depthDirection * v_layer);
  gl_Position = u_viewProjection * vec4(world, 1.0);
}
`;

const layeredFragmentSource = `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_brightness;
uniform float u_intensity;
uniform float u_falloff;
uniform float u_normalization;
in vec2 v_quad;
flat in float v_layer;
out vec4 outColor;
void main() {
  float r2 = dot(v_quad, v_quad) + v_layer * v_layer;
  if (r2 >= 1.0) discard;
  float nearestLayer = 0.5 / ${GLOW_LAYERS}.0;
  float weight = exp(-u_falloff * max(0.0, r2 - nearestLayer * nearestLayer)) * (1.0 - smoothstep(0.64, 1.0, r2)) * u_normalization;
  outColor = vec4(u_color * u_brightness * u_intensity * weight, 0.0);
}
`;

/**
 * Recover a world-space billboard basis from a standard symmetric perspective
 * or orthographic projection times a rigid camera view. Rows 0 and 1 encode
 * the scaled camera right/up vectors. Arbitrary projective/sheared cameras
 * need an explicit camera basis and are outside this renderer's contract.
 */
export function glowBillboardBasis(viewProjection: Mat4): { right: Vec3; up: Vec3 } {
  assertMatrix(viewProjection, 'viewProjection');
  const normalize = (value: Vec3): Vec3 => {
    const length = Math.hypot(...value);
    if (!Number.isFinite(length) || length === 0) {
      throw new RangeError('Glow camera must define nonzero independent right and up vectors.');
    }
    return [value[0] / length, value[1] / length, value[2] / length];
  };
  const right = normalize([viewProjection[0], viewProjection[4], viewProjection[8]]);
  const rowUp = normalize([viewProjection[1], viewProjection[5], viewProjection[9]]);
  const dot = right[0] * rowUp[0] + right[1] * rowUp[1] + right[2] * rowUp[2];
  const orthogonal: Vec3 = [rowUp[0] - dot * right[0], rowUp[1] - dot * right[1], rowUp[2] - dot * right[2]];
  if (Math.hypot(...orthogonal) < 1e-7) {
    throw new RangeError('Glow camera must define nonzero independent right and up vectors.');
  }
  return { right, up: normalize(orthogonal) };
}

/** A depth-tested world-space halo; this does not sample or bloom the host scene. */
export function createGlowRenderer(gl: WebGL2RenderingContext): GlowRenderer {
  const program = createProgram(gl, layeredVertexSource, layeredFragmentSource);
  let vao: WebGLVertexArrayObject | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null>;
  try {
    // Allocation alone changes no bindings; the quad needs no vertex buffer.
    vao = gl.createVertexArray();
    if (!vao) throw new Error('Unable to allocate glow vertex array.');
    uniforms = Object.fromEntries(['viewProjection', 'position', 'right', 'up', 'depthDirection', 'normalization', 'radius', 'color', 'brightness', 'intensity', 'falloff']
      .map((name) => [name, gl.getUniformLocation(program, `u_${name}`)]));
  } catch (error) {
    if (vao) gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    throw error;
  }
  let disposed = false;
  let cachedFalloff = NaN, normalization = 0;
  return {
    render({ viewProjection, position, color, brightness, options }) {
      if (disposed) throw new Error('Glow renderer has been disposed.');
      if (!options.enabled || brightness === 0 || options.intensity === 0) return;
      // Reject invalid cameras before changing any host state.
      const { right, up } = glowBillboardBasis(viewProjection);
      const depthDirection = glowDepthDirection(viewProjection, right, up);
      const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
      const blend = [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map((key) => gl.getParameter(key) as number);
      const equations = [gl.getParameter(gl.BLEND_EQUATION_RGB) as number, gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number];
      const depthFunc = gl.getParameter(gl.DEPTH_FUNC) as number;
      const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
      const colorMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
      const capabilities = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE];
      const enabled = capabilities.map((capability) => gl.isEnabled(capability));
      try {
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.enable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        for (const capability of capabilities.slice(2)) gl.disable(capability);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.colorMask(true, true, true, true);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        // Premultiplied halo RGB avoids clamping intensity before radial fading;
        // destination alpha remains unchanged.
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        gl.uniformMatrix4fv(uniforms.viewProjection, false, new Float32Array(Array.from(viewProjection)));
        gl.uniform3fv(uniforms.position, position);
        gl.uniform3fv(uniforms.color, color);
        gl.uniform3fv(uniforms.right, right);
        gl.uniform3fv(uniforms.up, up);
        gl.uniform1f(uniforms.radius, options.radius);
        gl.uniform1f(uniforms.brightness, brightness);
        gl.uniform1f(uniforms.intensity, options.intensity);
        gl.uniform1f(uniforms.falloff, options.falloff);
        if (options.falloff !== cachedFalloff) {
          let densitySum = 0;
          const nearestLayerSquared = (0.5 / GLOW_LAYERS) ** 2;
          for (let slice = 0; slice < GLOW_LAYERS; slice++) {
            const r2 = ((slice + 0.5) / GLOW_LAYERS) ** 2;
            const edge = Math.max(0, Math.min(1, (r2 - 0.64) / 0.36));
            // Factor out the nearest layer's density to keep normalization
            // finite even for very large supported falloff coefficients.
            densitySum += Math.exp(-options.falloff * (r2 - nearestLayerSquared)) * (1 - edge * edge * (3 - 2 * edge));
          }
          normalization = 1 / densitySum;
          cachedFalloff = options.falloff;
        }
        gl.uniform3fv(uniforms.depthDirection, depthDirection);
        gl.uniform1f(uniforms.normalization, normalization);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, GLOW_LAYERS);
      } finally {
        gl.useProgram(previousProgram);
        gl.bindVertexArray(previousVao);
        gl.blendFuncSeparate(blend[0], blend[1], blend[2], blend[3]);
        gl.blendEquationSeparate(equations[0], equations[1]);
        gl.depthFunc(depthFunc);
        gl.depthMask(depthMask);
        gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
        capabilities.forEach((capability, index) => enabled[index] ? gl.enable(capability) : gl.disable(capability));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
