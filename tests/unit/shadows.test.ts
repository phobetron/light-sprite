import { describe, expect, it } from '@rstest/core';
import { createShadowMap } from '../../src/shadows';
import { perspectiveMatrix } from '../../src/math';
import { recordingGl, uploadedTrianglePositions } from '../support/unit/shadowRecorder';

// Invalid inputs must fail before any resource allocation or host GL mutation.
function limitsOnlyGl(): WebGL2RenderingContext {
  return {
    MAX_CUBE_MAP_TEXTURE_SIZE: 1, MAX_TEXTURE_IMAGE_UNITS: 2,
    getParameter(parameter: number) { return parameter === 1 ? 2048 : 8; },
    createProgram() { throw new Error('Unexpected GPU allocation'); },
  } as unknown as WebGL2RenderingContext;
}
const triangle = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) };

describe('shadow input contracts', () => {
  it('validates cubemap resolution against the supplied context limits', () => {
    for (const resolution of [0, -1, 0.5, NaN, Infinity, 2049]) {
      expect(() => createShadowMap(limitsOnlyGl(), [], { resolution }, 1)).toThrow(/resolution/);
    }
  });

  it('requires a fragment texture unit and a finite nonnegative bias', () => {
    for (const textureUnit of [-1, 8, 1.5, Infinity]) {
      expect(() => createShadowMap(limitsOnlyGl(), [], { textureUnit }, 1)).toThrow(/textureUnit/);
    }
    for (const bias of [-1, NaN, Infinity, 1e100]) {
      expect(() => createShadowMap(limitsOnlyGl(), [], { bias }, 1)).toThrow(/bias/);
    }
  });

  it('rejects incomplete triangle ranges and invalid selected indices', () => {
    expect(() => createShadowMap(limitsOnlyGl(), [{ geometry: { positions: [0, 0, 0, 1, 0, 0] } }], {}, 1)).toThrow(/complete triangles/);
    expect(() => createShadowMap(limitsOnlyGl(), [{ geometry: { ...triangle, indices: [0, 1, 3] } }], {}, 1)).toThrow(/Index exceeds/);
    expect(() => createShadowMap(limitsOnlyGl(), [{ geometry: { ...triangle, count: 2 } }], {}, 1)).toThrow(/complete triangles/);
  });

  it('rejects non-affine transforms and coordinates that cannot reach the GPU', () => {
    expect(() => createShadowMap(limitsOnlyGl(), [{ geometry: triangle, worldMatrix: perspectiveMatrix(1, 1, 1, 100) }], {}, 1)).toThrow(/affine/);
    expect(() => createShadowMap(limitsOnlyGl(), [{ geometry: { positions: [1e100, 0, 0, 0, 1, 0, 0, 0, 1] } }], {}, 1)).toThrow(/float32/);
  });

  it('restores the caller buffer binding when GPU indices exceed the selected vertex count', () => {
    const buffer = {} as WebGLBuffer;
    const previous = {} as WebGLBuffer;
    let bound = previous;
    let reads = 0;
    const gl = {
      ...limitsOnlyGl(), COPY_READ_BUFFER_BINDING: 3, COPY_READ_BUFFER: 4, BUFFER_SIZE: 5,
      getParameter(parameter: number) { return parameter === 1 ? 2048 : parameter === 2 ? 8 : previous; },
      isBuffer(value: WebGLBuffer) { return value === buffer; }, isContextLost() { return false; },
      bindBuffer(_target: number, value: WebGLBuffer) { bound = value; },
      getBufferParameter() { return 48; },
      getBufferSubData(_target: number, _offset: number, destination: Float32Array) {
        reads++;
        destination.set([0, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0, 99]);
      },
    } as unknown as WebGL2RenderingContext;
    expect(() => createShadowMap(gl, [{ geometry: { buffer, byteStride: 16, count: 2, indices: new Uint16Array([0, 1, 2]) } }], {}, 1)).toThrow(/outside count/);
    expect(bound).toBe(previous);
    expect(reads).toBe(1);
  });

  it('ignores opted out casters without accessing their geometry', () => {
    const gl = {
      ...limitsOnlyGl(), createShader() { throw new Error('Reached allocation'); },
      bindFramebuffer() {}, bindBuffer() {}, bindVertexArray() {}, activeTexture() {}, bindTexture() {},
    } as unknown as WebGL2RenderingContext;
    const model = { castsShadow: false, get geometry(): typeof triangle { throw new Error('Excluded geometry was read'); } };
    expect(() => createShadowMap(gl, [model], {}, 1)).toThrow('Reached allocation');
  });
});

describe('shadow snapshots and GPU resources', () => {
  it('packs only referenced interleaved vertices and preserves selected triangle order', () => {
    const recorder = recordingGl();
    const geometry = {
      positions: [99, 9, 9, 9, 99, 0, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0, 99, 1, 1, 0],
      offset: 1, stride: 4, indices: [0, 0, 0, 3, 1, 2, 2, 1, 4], start: 3, count: 6,
    };
    const map = createShadowMap(recorder.gl, [{ geometry }], {}, 1);
    expect(uploadedTrianglePositions(recorder.uploads)).toEqual([
      [0, 1, 0], [0, 0, 0], [1, 0, 0],
      [1, 0, 0], [0, 0, 0], [1, 1, 0],
    ]);
    expect(recorder.uploads[1].data).toBeInstanceOf(Uint16Array);
    expect(recorder.uploads.reduce((bytes, item) => bytes + item.data.byteLength, 0)).toBe(60);
    map.update([0, 0, 1]);
    expect(recorder.draws).toHaveLength(6);
    expect(recorder.draws.every(draw => draw.indexed && draw.count === 6 && draw.type === recorder.gl.UNSIGNED_SHORT)).toBe(true);
    geometry.indices[3] = 4;
    geometry.indices[8] = 3;
    geometry.positions[13] = 2;
    const before = recorder.uploads.length;
    map.update([0, 0, 1]);
    expect(recorder.uploads).toHaveLength(before);
    map.refresh();
    const refreshed = uploadedTrianglePositions(recorder.uploads.slice(before));
    expect(refreshed).toEqual([
      [1, 1, 0], [0, 0, 0], [1, 0, 0],
      [1, 0, 0], [0, 0, 0], [2, 1, 0],
    ]);
    const beforeRestore = recorder.uploads.length;
    map.restore();
    expect(uploadedTrianglePositions(recorder.uploads.slice(beforeRestore))).toEqual(refreshed);
    map.dispose();
    map.dispose();
    expect(new Set(recorder.deleted).size).toBe(recorder.created.length);
    expect(recorder.deleted).toHaveLength(recorder.created.length);
  });

  it('avoids fixed primitive restart at the uint16 boundary, and omits indices without savings', () => {
    for (const vertices of [65535, 65536, 65537]) {
      const recorder = recordingGl();
      const positions = new Float32Array(vertices * 3);
      for (let vertex = 0; vertex < vertices; vertex++) positions[vertex * 3] = vertex;
      const count = Math.ceil(vertices * 2 / 3) * 3;
      // ArrayLike indices permit vertex 65535, unlike WebGL's reserved uint16 element.
      const indices = Array.from({ length: count }, (_, index) => index % vertices);
      const map = createShadowMap(recorder.gl, [{ geometry: { positions, indices } }, { geometry: triangle }], {}, 1);
      const Type = vertices <= 65535 ? Uint16Array : Uint32Array;
      const type = vertices <= 65535 ? recorder.gl.UNSIGNED_SHORT : recorder.gl.UNSIGNED_INT;
      expect(recorder.uploads[1].data).toBeInstanceOf(Type);
      const uploadedPositions = recorder.uploads[0].data;
      const uploadedIndices = recorder.uploads[1].data;
      expect(uploadedPositions[uploadedIndices[vertices - 1] * 3]).toBe(vertices - 1);
      expect(recorder.uploads).toHaveLength(3);
      map.update([0, 0, 1]);
      expect(recorder.draws[0]).toMatchObject({ indexed: true, count, type });
      expect(recorder.draws[1]).toMatchObject({ indexed: false, count: 3 });
      map.contextLost();
      const before = recorder.uploads.length;
      map.restore();
      expect(recorder.uploads[before + 1].data).toBeInstanceOf(Type);
      map.dispose();
    }
  });

  it('uploads 3.6 MB for a shared 100k vertex, 200k triangle mesh', () => {
    const recorder = recordingGl();
    const positions = new Float32Array(100000 * 3);
    const indices = new Uint32Array(200000 * 3);
    for (let index = 0; index < indices.length; index++) indices[index] = index % 100000;
    const map = createShadowMap(recorder.gl, [{ geometry: { positions, indices } }], {}, 1);
    expect(recorder.uploads.reduce((total, upload) => total + upload.data.byteLength, 0)).toBe(3600000);
    expect(recorder.uploads[0].data.length).toBe(positions.length);
    expect(recorder.uploads[1].data.length).toBe(indices.length);
    map.dispose();
  });

  it('cleans partial index allocation and leaves the previous refreshed map usable', () => {
    const recorder = recordingGl();
    const geometry = { positions: triangle.positions, indices: [0, 1, 2, 0, 1, 2] };
    const map = createShadowMap(recorder.gl, [{ geometry }], {}, 1);
    const originalCreateBuffer = recorder.gl.createBuffer;
    let buffers = 0;
    // Simulate allocation failure even when DOM typings declare a nonnull result.
    recorder.gl.createBuffer = () => ++buffers === 2 ? null as unknown as WebGLBuffer : originalCreateBuffer();
    const created = recorder.created.length, deleted = recorder.deleted.length;
    expect(() => map.refresh()).toThrow(/shadow indices/);
    expect(recorder.deleted.length - deleted).toBe(recorder.created.length - created);
    map.update([0, 0, 1]);
    expect(recorder.draws).toHaveLength(6);
    expect(recorder.draws.every(draw => draw.indexed)).toBe(true);
    map.dispose();
    expect(recorder.deleted).toHaveLength(recorder.created.length);
  });
});

describe('shadow matrix caching and atomic updates', () => {
  it('rechecks unchanged matrices without uploading or drawing', () => {
    const recorder = recordingGl();
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let reads = 0;
    const models = Array.from({ length: 100 }, () => ({ geometry: triangle, worldMatrix: () => { reads++; return matrix; } }));
    const map = createShadowMap(recorder.gl, models, {}, 1);
    map.update([0, 0, 1]);
    const draws = recorder.draws.length, uploads = recorder.uploads.length, beforeReads = reads;
    // Repeated calls exercise the cache. Duration is not part of this contract.
    for (let iteration = 0; iteration < 3; iteration++) map.update([0, 0, 1]);
    expect(reads - beforeReads).toBe(models.length * 3);
    expect(recorder.draws).toHaveLength(draws);
    expect(recorder.uploads).toHaveLength(uploads);
    matrix[12] = 0.5;
    map.update([0, 0, 1]);
    expect(recorder.draws).toHaveLength(draws * 2);
    matrix[12] = 1e100;
    expect(() => map.update([0, 0, 1])).toThrow(/float32/);
    matrix[12] = 0.5;
    map.update([0, 0, 1]);
    expect(recorder.draws).toHaveLength(draws * 2);
    map.dispose();
  });

  it('commits matrix changes only after all casters validate, and captures callback results immediately', () => {
    const recorder = recordingGl();
    const shared = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let offset = 0, invalid = false;
    // Different geometry identifies each caster independently of upload/draw order.
    const secondTriangle = { positions: new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0]) };
    const map = createShadowMap(recorder.gl, [
      { geometry: triangle, worldMatrix: () => { shared[12] = offset; return shared; } },
      { geometry: secondTriangle, worldMatrix: () => { shared[12] = invalid ? NaN : 2; return shared; } },
    ], {}, 1);
    map.update([0, 0, 1]);
    expect(new Set(recorder.draws.map(draw => draw.vertexArray)).size).toBe(2);
    expect(recorder.uniforms.filter(uniform => uniform.name === 'worldMatrix')).toHaveLength(12);
    for (const draw of recorder.draws) {
      expect(draw.positions).toBeDefined();
      expect([0, 5]).toContain(draw.positions?.[0]);
      expect(draw.worldMatrix?.[12]).toBe(draw.positions?.[0] === 0 ? 0 : 2);
    }
    const before = recorder.draws.length;
    offset = 1;
    invalid = true;
    expect(() => map.update([0, 0, 1])).toThrow(/finite/);
    expect(recorder.draws).toHaveLength(before);
    invalid = false;
    map.update([0, 0, 1]);
    expect(recorder.draws).toHaveLength(before * 2);
    for (const draw of recorder.draws.slice(before)) {
      expect(draw.positions).toBeDefined();
      expect([0, 5]).toContain(draw.positions?.[0]);
      expect(draw.worldMatrix?.[12]).toBe(draw.positions?.[0] === 0 ? 1 : 2);
    }
    map.dispose();
  });
});
