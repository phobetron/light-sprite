// Records owned uploads/draws/lifetimes without relying on a browser driver.
export function recordingGl() {
  const uploads: Array<{ target: number; data: Float32Array | Uint16Array | Uint32Array }> = [];
  const draws: Array<{
    indexed: boolean;
    count: number;
    type?: number;
    vertexArray: WebGLVertexArrayObject | null;
    worldMatrix: Float32Array | undefined;
    positions: Float32Array | undefined;
  }> = [];
  let vertexArray: WebGLVertexArrayObject | null = null;
  const matrices = new Map<string, Float32Array>();
  const boundBuffers = new Map<number, WebGLBuffer | null>();
  const bufferContents = new Map<WebGLBuffer, Float32Array | Uint16Array | Uint32Array>();
  const vertexBuffers = new Map<WebGLVertexArrayObject, WebGLBuffer>();
  function recordDraw(indexed: boolean, count: number, type?: number): void {
    const buffer = vertexArray ? vertexBuffers.get(vertexArray) : undefined;
    const data = buffer ? bufferContents.get(buffer) : undefined;
    draws.push({
      indexed, count, ...(type === undefined ? {} : { type }), vertexArray,
      worldMatrix: matrices.get('worldMatrix')?.slice(),
      positions: data instanceof Float32Array ? data : undefined,
    });
  }
  const created: object[] = [], deleted: object[] = [];
  const uniforms: Array<{ name: string; matrix: Float32Array }> = [];
  const constants = new Map<string, number>();
  const gl = new Proxy({} as WebGL2RenderingContext, {
    get(target, property: string) {
      if (Object.hasOwn(target, property)) return Reflect.get(target, property);
      if (property === property.toUpperCase()) {
        if (!constants.has(property)) constants.set(property, constants.size + 1);
        return constants.get(property);
      }
      if (property === 'getParameter') return (key: number) => {
        if (key === gl.MAX_CUBE_MAP_TEXTURE_SIZE) return 2048;
        if (key === gl.MAX_TEXTURE_IMAGE_UNITS) return 8;
        if (key === gl.VIEWPORT) return new Int32Array([0, 0, 32, 32]);
        if (key === gl.DEPTH_RANGE) return new Float32Array([0, 1]);
        if (key === gl.COLOR_WRITEMASK) return [true, true, true, true];
        return null;
      };
      if (property.startsWith('create')) return () => { const value = {}; created.push(value); return value; };
      if (property.startsWith('delete')) return (value: object) => { deleted.push(value); };
      if (property === 'getShaderParameter' || property === 'getProgramParameter') return () => true;
      if (property === 'checkFramebufferStatus') return () => gl.FRAMEBUFFER_COMPLETE;
      if (property === 'isContextLost' || property === 'isEnabled') return () => false;
      if (property === 'bindBuffer') return (target: number, buffer: WebGLBuffer | null) => {
        boundBuffers.set(target, buffer);
      };
      if (property === 'bufferData') return (target: number, data: Float32Array | Uint16Array | Uint32Array) => {
        const snapshot = data.slice();
        uploads.push({ target, data: snapshot });
        const buffer = boundBuffers.get(target);
        if (buffer) bufferContents.set(buffer, snapshot);
      };
      if (property === 'vertexAttribPointer') return () => {
        const buffer = boundBuffers.get(gl.ARRAY_BUFFER);
        if (vertexArray && buffer) vertexBuffers.set(vertexArray, buffer);
      };
      if (property === 'drawArrays') return (_mode: number, _start: number, count: number) => recordDraw(false, count);
      if (property === 'drawElements') return (_mode: number, count: number, type: number) => recordDraw(true, count, type);
      if (property === 'getUniformLocation') return (_program: WebGLProgram, name: string) => name;
      if (property === 'bindVertexArray') return (value: WebGLVertexArrayObject | null) => { vertexArray = value; };
      if (property === 'uniformMatrix4fv') return (name: string, _transpose: boolean, matrix: Float32Array) => {
        const snapshot = matrix.slice();
        uniforms.push({ name, matrix: snapshot });
        matrices.set(name, snapshot);
      };
      return () => {};
    },
  });
  return { gl, uploads, draws, created, deleted, uniforms };
}

// Expand the uploaded draw data so vertex compaction numbering remains free to change.
export function uploadedTrianglePositions(uploads: ReturnType<typeof recordingGl>['uploads']): number[][] {
  const positions = uploads.find(upload => upload.data instanceof Float32Array)?.data;
  if (!positions) throw new Error('Missing position upload');
  const indices = uploads.find(upload => upload.data instanceof Uint16Array || upload.data instanceof Uint32Array)?.data;
  const selected = indices ?? Array.from({ length: positions.length / 3 }, (_, index) => index);
  return Array.from(selected, index => Array.from(positions.slice(index * 3, index * 3 + 3)));
}
