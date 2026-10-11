import { computeBounds } from './bounds';
import type { Bounds3 } from './types';

/** A float32 XYZ attribute in an existing consumer-owned WebGL buffer. */
export interface BufferPositionSource {
  buffer: WebGLBuffer;
  /** Bytes between vertices. Default: 12 (packed XYZ). */
  byteStride?: number;
  /** Byte offset of the first position. Default: 0. */
  byteOffset?: number;
  /** Number of vertices. Default: all complete positions in the buffer. */
  count?: number;
  /** Optional CPU-side index list selecting referenced vertices. */
  indices?: Uint16Array | Uint32Array;
}

/** Read an existing float32 position buffer once, without changing its bindings. */
export function computeBufferBounds(gl: WebGL2RenderingContext, source: BufferPositionSource): Bounds3 {
  if (!gl.isBuffer(source.buffer)) throw new TypeError('Position buffer must belong to the supplied WebGL context.');
  if (gl.isContextLost()) throw new Error('Cannot read geometry while the WebGL context is lost.');
  const byteStride = source.byteStride ?? 12;
  const byteOffset = source.byteOffset ?? 0;
  if (!Number.isSafeInteger(byteStride) || byteStride < 12 || byteStride % 4 !== 0) {
    throw new RangeError('byteStride must be a multiple of four and at least 12.');
  }
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0) {
    throw new RangeError('byteOffset must be a nonnegative multiple of four.');
  }
  const previous = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) as WebGLBuffer | null;
  try {
    gl.bindBuffer(gl.COPY_READ_BUFFER, source.buffer);
    const size = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE) as number;
    if (size % 4 !== 0) throw new RangeError('Float32 position buffer size must be a multiple of four.');
    const positions = new Float32Array(size / 4);
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, positions);
    const available = Math.max(0, Math.floor((size - byteOffset - 12) / byteStride) + 1);
    const vertexCount = source.count ?? available;
    if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0 || vertexCount > available) {
      throw new RangeError('count must select one or more complete vertices in the buffer.');
    }
    if (source.indices) {
      for (const index of source.indices) {
        if (index >= vertexCount) throw new RangeError('Index references a vertex outside count.');
      }
    }
    return computeBounds({
      positions,
      stride: byteStride / 4,
      offset: byteOffset / 4,
      indices: source.indices,
      count: source.indices?.length ?? vertexCount,
    });
  } finally {
    gl.bindBuffer(gl.COPY_READ_BUFFER, previous);
  }
}

/** Compile a consumer shader pair with useful diagnostics and no binding changes. */
export function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  try {
    for (const [type, source, label] of [
      [gl.VERTEX_SHADER, vertexSource, 'Vertex'],
      [gl.FRAGMENT_SHADER, fragmentSource, 'Fragment'],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error(`Unable to allocate ${label.toLowerCase()} shader.`);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`${label} shader compilation failed: ${gl.getShaderInfoLog(shader) ?? 'unknown error'}`);
      }
    }
    program = gl.createProgram();
    if (!program) throw new Error('Unable to allocate shader program.');
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader program linking failed: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`);
    }
    for (const shader of shaders) gl.detachShader(program, shader);
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}
