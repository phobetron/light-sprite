import type { LightSprite, LightSpriteOptions } from '../../../src/index';

const libraryURL = '/lib/index.js';
export const lib = await import(libraryURL) as typeof import('../../../src/index');

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function equal(actual: unknown, expected: unknown, message: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}
export function throws(operation: () => unknown, message: string) {
  let rejected = false;
  try { operation(); } catch { rejected = true; }
  check(rejected, message);
}

export function createGpu({ width = 96, height = width }: { width?: number; height?: number } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  check(gl, 'A real WebGL 2 context is available');
  const buffers: WebGLBuffer[] = [];
  const programs: WebGLProgram[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  const sprites: LightSprite[] = [];
  return {
    canvas, gl,
    buffer(data: BufferSource, target: number = gl.ARRAY_BUFFER) {
      const resource = gl.createBuffer();
      check(resource, 'Allocate buffer');
      buffers.push(resource);
      gl.bindBuffer(target, resource);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return resource;
    },
    program(vs: string, fs: string) {
      const resource = lib.createProgram(gl, vs, fs);
      programs.push(resource);
      return resource;
    },
    sprite(options: LightSpriteOptions = {}) {
      const resource = lib.createLightSprite(gl, options);
      sprites.push(resource);
      return resource;
    },
    vao() {
      const resource = gl.createVertexArray();
      check(resource, 'Allocate vertex array');
      vaos.push(resource);
      return resource;
    },
    pixel(x = Math.floor(width / 2), y = Math.floor(height / 2)) {
      const output = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, output);
      return [...output];
    },
    dispose() {
      for (const sprite of sprites) sprite.dispose();
      for (const resource of buffers) gl.deleteBuffer(resource);
      for (const resource of programs) gl.deleteProgram(resource);
      for (const resource of vaos) gl.deleteVertexArray(resource);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}

export async function restoreContext(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, whileLost?: () => void) {
  const extension = gl.getExtension('WEBGL_lose_context');
  check(extension, 'Context loss test extension is available');
  const event = (name: string) => new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 5000);
    canvas.addEventListener(name, () => { clearTimeout(timeout); done(); }, { once: true });
  });
  const lost = event('webglcontextlost');
  extension.loseContext();
  await lost;
  whileLost?.();
  await new Promise(done => setTimeout(done, 100));
  const restored = event('webglcontextrestored');
  extension.restoreContext();
  await restored;
}
