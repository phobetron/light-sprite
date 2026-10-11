import { boundsSphere, computeBounds, transformBounds } from './bounds';
import { identityMatrix, lookAtMatrix, multiplyMatrices, perspectiveMatrix } from './math';
import type { Bounds3, Geometry, Mat4, PositionSource, Vec3 } from './types';
import { createProgram } from './webgl';
import type { BufferPositionSource } from './webgl';

export interface ShadowOptions {
  /** Square cubemap face size. Default: 512, limited by the context's maximum. */
  resolution?: number;
  /** Minimum world-space tolerance; the shader also accounts for surface slope. */
  bias?: number;
  /** Reserved fragment texture unit. Default: MAX_TEXTURE_IMAGE_UNITS - 1. */
  textureUnit?: number;
}
export interface ShadowCaster {
  geometry: Geometry | PositionSource | BufferPositionSource;
  worldMatrix?: Mat4 | (() => Mat4);
  castsShadow?: boolean;
}
export interface ShadowMap {
  update(position: Vec3, enabled?: boolean): { texture: WebGLTexture; far: number; bias: number; textureUnit: number };
  refresh(): void;
  contextLost(): void;
  restore(): void;
  dispose(): void;
}
interface Snapshot { model: ShadowCaster; positions: Float32Array; indices?: Uint16Array | Uint32Array; bounds: Bounds3 }
interface MatrixSnapshot { values: number[]; upload: Float32Array }
interface Mesh { buffer: WebGLBuffer; indexBuffer?: WebGLBuffer; indexType?: number; vao: WebGLVertexArrayObject; count: number }
interface Resources { texture: WebGLTexture; framebuffer: WebGLFramebuffer; program: WebGLProgram; meshes: Mesh[] }

const vertexSource = `#version 300 es
layout(location=0) in vec3 position;
uniform mat4 worldMatrix;
uniform mat4 viewProjection;
out vec3 worldPosition;
void main() {
  worldPosition = (worldMatrix * vec4(position, 1.0)).xyz;
  gl_Position = viewProjection * vec4(worldPosition, 1.0);
}`;
const fragmentSource = `#version 300 es
precision highp float;
in vec3 worldPosition;
uniform vec3 lightPosition;
uniform float shadowFar;
void main() { gl_FragDepth = length(worldPosition - lightPosition) / shadowFar; }`;
const directions: readonly [Vec3, Vec3][] = [
  [[1, 0, 0], [0, -1, 0]], [[-1, 0, 0], [0, -1, 0]],
  [[0, 1, 0], [0, 0, 1]], [[0, -1, 0], [0, 0, -1]],
  [[0, 0, 1], [0, -1, 0]], [[0, 0, -1], [0, -1, 0]],
];

function snapshot(gl: WebGL2RenderingContext, model: ShadowCaster): Snapshot {
  let source: PositionSource;
  if ('buffer' in model.geometry) {
    const geometry = model.geometry;
    if (!gl.isBuffer(geometry.buffer)) throw new TypeError('Position buffer must belong to the supplied WebGL context.');
    if (gl.isContextLost()) throw new Error('Cannot read geometry while the WebGL context is lost.');
    const byteStride = geometry.byteStride ?? 12;
    const byteOffset = geometry.byteOffset ?? 0;
    if (!Number.isSafeInteger(byteStride) || byteStride < 12 || byteStride % 4 !== 0) throw new RangeError('byteStride must be a multiple of four and at least 12.');
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0) throw new RangeError('byteOffset must be a nonnegative multiple of four.');
    const previous = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      gl.bindBuffer(gl.COPY_READ_BUFFER, geometry.buffer);
      const size = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE) as number;
      if (size % 4 !== 0) throw new RangeError('Float32 position buffer size must be a multiple of four.');
      const positions = new Float32Array(size / 4);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, positions);
      const stride = byteStride / 4;
      const offset = byteOffset / 4;
      const available = Math.max(0, Math.floor((positions.length - offset - 3) / stride) + 1);
      const vertexCount = geometry.count ?? available;
      if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0 || vertexCount > available) throw new RangeError('count must select one or more complete vertices in the buffer.');
      if (geometry.indices) for (const index of geometry.indices) {
        if (index >= vertexCount) throw new RangeError('Index references a vertex outside count.');
      }
      source = { positions, stride, offset, indices: geometry.indices, count: geometry.indices?.length ?? vertexCount };
    } finally { gl.bindBuffer(gl.COPY_READ_BUFFER, previous); }
  } else source = model.geometry;
  const bounds = computeBounds(source);
  const { positions, stride = 3, offset = 0, start = 0, indices } = source;
  const available = indices?.length ?? Math.max(0, Math.floor((positions.length - offset - 3) / stride) + 1);
  const count = source.count ?? available - start;
  if (count % 3 !== 0) throw new RangeError('Shadow casters require complete triangles (a draw count divisible by three).');
  // Remap only referenced vertices: draw ranges may select a small part of a
  // large/interleaved source. Keep triangle order and use indices only if cheaper.
  let remap: Map<number, number> | undefined;
  if (indices) {
    remap = new Map();
    for (let item = 0; item < count; item++) {
      const vertex = indices[start + item];
      if (!remap.has(vertex)) remap.set(vertex, remap.size);
    }
  }
  // WebGL 2 reserves the maximum element value for fixed primitive restart.
  const indexBytes = remap && remap.size <= 65535 ? 2 : 4;
  const indexed = remap && remap.size * 12 + count * indexBytes < count * 12;
  const packed = new Float32Array((indexed ? remap!.size : count) * 3);
  const packedIndices = indexed ? (indexBytes === 2 ? new Uint16Array(count) : new Uint32Array(count)) : undefined;
  if (indexed) {
    for (const [vertex, destination] of remap!) {
      for (let axis = 0; axis < 3; axis++) packed[destination * 3 + axis] = positions[offset + vertex * stride + axis];
    }
    for (let item = 0; item < count; item++) packedIndices![item] = remap!.get(indices![start + item])!;
  } else {
    for (let item = 0; item < count; item++) {
      const vertex = indices ? indices[start + item] : start + item;
      for (let axis = 0; axis < 3; axis++) packed[item * 3 + axis] = positions[offset + vertex * stride + axis];
    }
  }
  if (!packed.every(Number.isFinite)) throw new RangeError('Shadow positions must be representable as finite float32 values.');
  return { model, positions: packed, indices: packedIndices, bounds };
}
const identity = identityMatrix();
function worldMatrix(model: ShadowCaster): Mat4 {
  const matrix = typeof model.worldMatrix === 'function' ? model.worldMatrix() : model.worldMatrix ?? identity;
  if (!matrix || matrix.length !== 16) throw new RangeError('Shadow caster worldMatrix must contain sixteen finite numbers');
  for (let component = 0; component < 16; component++) {
    if (!Number.isFinite(matrix[component])) throw new RangeError('Shadow caster worldMatrix must contain sixteen finite numbers');
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) throw new RangeError('Shadow casters require an affine worldMatrix.');
  for (let component = 0; component < 16; component++) {
    if (!Number.isFinite(Math.fround(matrix[component]))) throw new RangeError('Shadow worldMatrix must be representable as finite float32 values.');
  }
  return matrix;
}
function release(gl: WebGL2RenderingContext, resources: Resources): void {
  for (const mesh of resources.meshes) { gl.deleteBuffer(mesh.buffer); if (mesh.indexBuffer) gl.deleteBuffer(mesh.indexBuffer); gl.deleteVertexArray(mesh.vao); }
  gl.deleteTexture(resources.texture); gl.deleteFramebuffer(resources.framebuffer); gl.deleteProgram(resources.program);
}

/** Owns a cached radial-depth cubemap and immutable snapshots of registered triangles. */
export function createShadowMap(gl: WebGL2RenderingContext, models: readonly ShadowCaster[], options: ShadowOptions, markerRadius: number): ShadowMap {
  const resolution = options.resolution ?? 512;
  const textureUnit = options.textureUnit ?? (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number) - 1;
  const units = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  const maximum = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) as number;
  if (!Number.isSafeInteger(resolution) || resolution < 1 || resolution > maximum) throw new RangeError('Shadow resolution must be a positive integer within MAX_CUBE_MAP_TEXTURE_SIZE.');
  if (!Number.isSafeInteger(textureUnit) || textureUnit < 0 || textureUnit >= units) throw new RangeError('Shadow textureUnit must be an available fragment texture unit.');
  if (options.bias !== undefined && (!Number.isFinite(options.bias) || options.bias < 0 || !Number.isFinite(Math.fround(options.bias)))) throw new RangeError('Shadow bias must be a finite nonnegative float32 value.');
  if (!Number.isFinite(markerRadius) || markerRadius < 0) throw new RangeError('Shadow markerRadius must be finite and nonnegative.');
  const configuredBias = options.bias;
  let snapshots = models.filter(model => model.castsShadow !== false).map(model => snapshot(gl, model));
  snapshots.forEach(item => worldMatrix(item.model));
  let resources: Resources | undefined;
  let disposed = false;
  let lost = false;
  let cache: { position: number[]; matrices: MatrixSnapshot[]; far: number; bias: number } | undefined;

  function allocate(items: readonly Snapshot[]): Resources {
    const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const cube = gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP) as WebGLTexture | null;
    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const array = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const unpack = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
    const result: Partial<Resources> = { meshes: [] };
    try {
      result.program = createProgram(gl, vertexSource, fragmentSource);
      result.texture = gl.createTexture() ?? undefined;
      result.framebuffer = gl.createFramebuffer() ?? undefined;
      if (!result.texture || !result.framebuffer) throw new Error('Unable to allocate shadow map.');
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, result.texture);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      for (let face = 0; face < 6; face++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT32F, resolution, resolution, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, result.framebuffer);
      gl.drawBuffers([gl.NONE]);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_CUBE_MAP_POSITIVE_X, result.texture, 0);
      if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Shadow depth framebuffer is incomplete.');
      for (const item of items) {
        const buffer = gl.createBuffer();
        const meshVao = gl.createVertexArray();
        if (!buffer || !meshVao) {
          if (buffer) gl.deleteBuffer(buffer);
          if (meshVao) gl.deleteVertexArray(meshVao);
          throw new Error('Unable to allocate shadow geometry.');
        }
        const mesh: Mesh = { buffer, vao: meshVao, count: item.indices?.length ?? item.positions.length / 3 };
        result.meshes!.push(mesh);
        gl.bindVertexArray(meshVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, item.positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
        if (item.indices) {
          mesh.indexBuffer = gl.createBuffer() ?? undefined;
          if (!mesh.indexBuffer) throw new Error('Unable to allocate shadow indices.');
          mesh.indexType = item.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, item.indices, gl.STATIC_DRAW);
        }
      }
      return result as Resources;
    } catch (error) {
      for (const mesh of result.meshes!) { gl.deleteBuffer(mesh.buffer); if (mesh.indexBuffer) gl.deleteBuffer(mesh.indexBuffer); gl.deleteVertexArray(mesh.vao); }
      if (result.texture) gl.deleteTexture(result.texture);
      if (result.framebuffer) gl.deleteFramebuffer(result.framebuffer);
      if (result.program) gl.deleteProgram(result.program);
      throw error;
    } finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack);
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, array);
      gl.activeTexture(active); gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
    }
  }
  function render(position: Vec3, matrices: MatrixSnapshot[], far: number): void {
    const current = resources!;
    const state = {
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
      depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
      depthClear: gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number,
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
      depthRange: gl.getParameter(gl.DEPTH_RANGE) as Float32Array,
      feedbackActive: gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE) as boolean,
      feedbackPaused: gl.getParameter(gl.TRANSFORM_FEEDBACK_PAUSED) as boolean,
    };
    const capabilities = [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE];
    const enabled = capabilities.map(capability => gl.isEnabled(capability));
    try {
      if (state.feedbackActive && !state.feedbackPaused) gl.pauseTransformFeedback();
      for (const capability of capabilities) gl.disable(capability);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.clearDepth(1); gl.depthRange(0, 1);
      gl.colorMask(false, false, false, false);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, current.framebuffer);
      gl.viewport(0, 0, resolution, resolution);
      gl.useProgram(current.program);
      gl.uniform3fv(gl.getUniformLocation(current.program, 'lightPosition'), new Float32Array(position));
      gl.uniform1f(gl.getUniformLocation(current.program, 'shadowFar'), far);
      const worldUniform = gl.getUniformLocation(current.program, 'worldMatrix');
      const cameraUniform = gl.getUniformLocation(current.program, 'viewProjection');
      // Distant casters must not push the near plane past nearby occluders.
      const near = Math.max(1e-6, Math.min(0.001, markerRadius * 0.01));
      const projection = perspectiveMatrix(Math.PI / 2, 1, near, far);
      for (let face = 0; face < 6; face++) {
        const [direction, up] = directions[face];
        const view = lookAtMatrix([0, 0, 0], direction, up);
        for (let row = 0; row < 3; row++) view[12 + row] = -(view[row] * position[0] + view[4 + row] * position[1] + view[8 + row] * position[2]);
        const viewProjection = multiplyMatrices(projection, view);
        gl.uniformMatrix4fv(cameraUniform, false, viewProjection);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, current.texture, 0);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        for (let index = 0; index < current.meshes.length; index++) {
          gl.uniformMatrix4fv(worldUniform, false, matrices[index].upload);
          gl.bindVertexArray(current.meshes[index].vao);
          const mesh = current.meshes[index];
          if (mesh.indexBuffer) gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType!, 0);
          else gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
        }
      }
    } finally {
      capabilities.forEach((capability, index) => enabled[index] ? gl.enable(capability) : gl.disable(capability));
      gl.depthFunc(state.depthFunc); gl.depthMask(state.depthMask); gl.clearDepth(state.depthClear); gl.depthRange(state.depthRange[0], state.depthRange[1]);
      gl.colorMask(...state.colorMask as [boolean, boolean, boolean, boolean]);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.read);
      gl.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
      gl.useProgram(state.program); gl.bindVertexArray(state.vao);
      if (state.feedbackActive && !state.feedbackPaused) gl.resumeTransformFeedback();
    }
  }
  function assertLive(): void { if (disposed) throw new Error('Shadow map has been disposed.'); }
  resources = allocate(snapshots);
  return {
    update(position, enabled = true) {
      assertLive();
      if (lost || gl.isContextLost() || !resources) throw new Error('Cannot update shadow map while the context is lost.');
      if (!position || position.length !== 3 || !Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !Number.isFinite(position[2])) throw new RangeError('Shadow light position must contain three finite numbers');
      if (!Number.isFinite(Math.fround(position[0])) || !Number.isFinite(Math.fround(position[1])) || !Number.isFinite(Math.fround(position[2]))) throw new RangeError('Shadow light position must be representable as finite float32 values.');
      // Keep a complete texture bound for the shader, but do no geometry passes
      // when shadow comparison or the direct light is disabled. Do not move the
      // cache key: re-enabling must rebuild for the current source position.
      if (!enabled) return { texture: resources.texture, far: cache?.far ?? 1, bias: cache?.bias ?? configuredBias ?? 0, textureUnit };
      let matrices: MatrixSnapshot[] | undefined;
      for (let index = 0; index < snapshots.length; index++) {
        const matrix = worldMatrix(snapshots[index].model);
        const previous = cache?.matrices[index];
        let same = !!previous;
        for (let component = 0; same && component < 16; component++) same = matrix[component] === previous!.values[component];
        if (!same) {
          // Capture immediately, before the next callback can mutate its source.
          matrices ??= cache ? cache.matrices.slice() : [];
          const values = Array.from(matrix);
          matrices[index] = { values, upload: new Float32Array(values) };
        }
      }
      const samePosition = cache && cache.position[0] === position[0] && cache.position[1] === position[1] && cache.position[2] === position[2];
      if (matrices || !samePosition) {
        matrices ??= cache?.matrices ?? [];
        let extent = Math.max(1, markerRadius);
        let distance = Math.max(1, markerRadius * 2);
        snapshots.forEach((item, index) => {
          const sphere = boundsSphere(transformBounds(item.bounds, matrices![index].values));
          extent = Math.max(extent, sphere.radius * 2);
          distance = Math.max(distance, Math.hypot(sphere.center[0] - position[0], sphere.center[1] - position[1], sphere.center[2] - position[2]) + sphere.radius);
        });
        const far = distance * 1.01;
        const bias = configuredBias ?? Math.max(0.0001, extent / resolution * 0.25);
        if (!Number.isFinite(Math.fround(far)) || !Number.isFinite(Math.fround(bias))) throw new RangeError('Shadow scene exceeds finite float32 range.');
        render(position, matrices, far);
        cache = { position: Array.from(position), matrices, far, bias };
      }
      return { texture: resources.texture, far: cache!.far, bias: cache!.bias, textureUnit };
    },
    refresh() {
      assertLive();
      if (lost || gl.isContextLost()) throw new Error('Cannot refresh shadow geometry while the context is lost.');
      const next = models.filter(model => model.castsShadow !== false).map(model => snapshot(gl, model));
      next.forEach(item => worldMatrix(item.model));
      const nextResources = allocate(next);
      if (resources) release(gl, resources);
      snapshots = next; resources = nextResources; cache = undefined;
    },
    contextLost() { if (disposed) return; lost = true; resources = undefined; cache = undefined; },
    restore() {
      assertLive();
      if (gl.isContextLost()) throw new Error('Cannot restore shadows while the context is lost.');
      const nextResources = allocate(snapshots);
      if (resources) release(gl, resources);
      resources = nextResources; lost = false; cache = undefined;
    },
    dispose() { if (disposed) return; if (resources && !gl.isContextLost()) release(gl, resources); resources = undefined; cache = undefined; snapshots = []; disposed = true; },
  };
}
