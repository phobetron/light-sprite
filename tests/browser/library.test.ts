import type { MutableVec3 } from '../../src/index';
import { test } from '../support/browser-fixture';

test('GPU bounds preserve bindings, reject invalid layouts, and refresh model snapshots', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const { createGpu, lib, equal, throws } = support;
    const gpu = createGpu();
    const { gl, buffer, sprite } = gpu;
    try {
      const geometryBuffer = buffer(new Float32Array([-0.5, 0, 0, 99, 0.5, 4, 0, 99]));
      const previousCopy = buffer(new Float32Array([1, 2, 3]), gl.COPY_READ_BUFFER);
      const source = { buffer: geometryBuffer, byteStride: 16, count: 2 };
      equal(lib.computeBufferBounds(gl, source), { min: [-0.5, 0, 0], max: [0.5, 4, 0] }, 'GPU interleaved bounds');
      check(gl.getParameter(gl.COPY_READ_BUFFER_BINDING) === previousCopy, 'GPU bounds preserve read binding');
      check(gl.getParameter(gl.ARRAY_BUFFER_BINDING) === geometryBuffer, 'GPU bounds preserve vertex binding');
      throws(() => lib.computeBufferBounds(gl, { ...source, count: 3 }), 'Reject GPU count beyond available vertices');
      throws(() => lib.computeBufferBounds(gl, { ...source, byteStride: 13 }), 'Reject unaligned GPU layout');
      throws(() => lib.computeBufferBounds(gl, { ...source, indices: new Uint16Array([2]) }), 'Reject GPU indices outside vertex count');
      check(gl.getParameter(gl.COPY_READ_BUFFER_BINDING) === previousCopy, 'Failed bounds preserve read binding');

      const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
      let matrix = lib.translationMatrix([2, 0, 0]);
      const models = sprite({ models: [{ geometry: { positions }, worldMatrix: () => matrix }, { geometry: source }] });
      equal(models.getModelBounds()[0], { min: [1, -1, 0], max: [3, 1, 0] }, 'Automatic model bounds');
      matrix = lib.translationMatrix([3, 0, 0]);
      equal(models.getModelBounds()[0], { min: [2, -1, 0], max: [4, 1, 0] }, 'Current transforms are reread');
      positions[0] = -2;
      equal(models.getModelBounds()[0].min, [2, -1, 0], 'Local geometry is cached');
      models.refreshBounds();
      equal(models.getModelBounds()[0].min, [1, -1, 0], 'Geometry refresh updates cached bounds');
      const ownedBounds = models.getModelBounds();
      // Deliberately mutate the detached snapshot to verify controller ownership.
      (ownedBounds[0].min as MutableVec3)[0] = 999;
      equal(models.getModelBounds()[0].min, [1, -1, 0], 'Returned bounds are detached snapshots');
    } finally { gpu.dispose(); }
  });
});

test('Light updates validate atomically and expose detached state', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const { createGpu, equal, throws } = support;
    const gpu = createGpu();
    const { sprite } = gpu;
    try {
      const point = sprite({ position: [0, 0, 0.5] });
      const bounds = point.getMarkerBounds();
      check(Math.abs(bounds.max[0] - bounds.min[0] - 0.1) < 1e-7, 'Default marker is 10 cm in diameter');
      const original = point.light;
      throws(() => point.setLight({ color: [1, 0, 0], intensity: -1 }), 'Invalid light update is rejected');
      equal(point.light, original, 'Invalid light update is atomic');
      throws(() => point.setPosition([1e40, 0, 0]), 'Reject uniform overflow');
      throws(() => point.setLight({ intensity: 1e40 }), 'Reject intensity overflow');
      throws(() => sprite({ diameter: 0 }), 'Reject zero diameter');
      throws(() => sprite({ marker: { positions: new Float32Array([0, 0, 0]) } }), 'Reject incomplete marker triangles');
      throws(() => point.render({ viewProjection: [1, 2] }), 'Reject invalid camera matrices');
      const snapshot = point.light;
      snapshot.position[0] = 100;
      equal(point.position, [0, 0, 0.5], 'Light state cannot mutate the controller');
    } finally { gpu.dispose(); }
  });
});

test('Point lighting responds to intensity and range while preserving the host program', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const url = '/support/library.js';
    const { createScene } = await import(url) as typeof import('../support/browser/library');
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const { equal } = support;
    const gpu = createScene();
    const { gl, point, litProgram, solidProgram, drawSurface, pixel } = gpu;
    try {
      gl.useProgram(solidProgram);
      point.bindLighting(litProgram, { ambient: 0 });
      check(gl.getParameter(gl.CURRENT_PROGRAM) === solidProgram, 'Lighting binding restores the consumer program');
      drawSurface(litProgram, 0);
      const lit = pixel();
      check(lit[0] > 150 && lit[1] === lit[0], 'The source illuminates consumer-drawn geometry');
      point.setLight({ intensity: 0 });
      point.bindLighting(litProgram, { ambient: 0 });
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawSurface(litProgram, 0);
      equal(pixel(), [0, 0, 0, 255], 'Zero source intensity removes illumination');
      point.setLight({ intensity: 6, range: 0.25 });
      point.bindLighting(litProgram, { ambient: 0 });
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawSurface(litProgram, 0);
      equal(pixel(), [0, 0, 0, 255], 'Source range limits surface illumination');
      point.setLight({ range: 0 });
    } finally { gpu.dispose(); }
  });
});

test('Lighting uniforms recover after consumer shader relinking', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const url = '/support/library.js';
    const { createScene } = await import(url) as typeof import('../support/browser/library');
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const gpu = createScene();
    const { gl, point, litProgram, vs, fs, drawSurface, pixel } = gpu;
    try {
      // Populate the cached locations before relinking invalidates them.
      point.bindLighting(litProgram, { ambient: 0 });
      drawSurface(litProgram, 0);
      check(pixel()[0] > 150, 'Lighting uses cached uniform locations before relinking');
      // Reattach a shader pair and relink the same consumer program.
      const shaderSources: [number, string][] = [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]];
      const relinkShaders = shaderSources.map(([type, text]) => {
        const shader = gl.createShader(type);
        check(shader, 'Allocate relink shader');
        gl.shaderSource(shader, text);
        gl.compileShader(shader);
        gl.attachShader(litProgram, shader);
        return shader;
      });
      gl.linkProgram(litProgram);
      check(gl.getProgramParameter(litProgram, gl.LINK_STATUS), 'Consumer program relink succeeds');
      for (const shader of relinkShaders) { gl.detachShader(litProgram, shader); gl.deleteShader(shader); }
      point.bindLighting(litProgram, { ambient: 0, refresh: true });
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawSurface(litProgram, 0);
      check(pixel()[0] > 150, 'Uniform binding recovers after a consumer program relink');
    } finally { gpu.dispose(); }
  });
});

test('Markers share host depth and preserve WebGL state', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const url = '/support/library.js';
    const { createScene } = await import(url) as typeof import('../support/browser/library');
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const { equal } = support;
    const gpu = createScene();
    const { gl, point, solidProgram, vertices, vp, drawSurface, pixel } = gpu;
    try {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawSurface(solidProgram, 0.8);
      point.render({ viewProjection: vp });
      equal(pixel(), [0, 255, 0, 255], 'Consumer geometry occludes the marker using shared depth');
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.depthFunc(gl.ALWAYS);
      gl.depthMask(false);
      gl.colorMask(false, true, false, false);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.enable(gl.RASTERIZER_DISCARD);
      const keys = [gl.CURRENT_PROGRAM, gl.VERTEX_ARRAY_BINDING, gl.ARRAY_BUFFER_BINDING,
        gl.COPY_READ_BUFFER_BINDING, gl.FRAMEBUFFER_BINDING, gl.DEPTH_FUNC, gl.DEPTH_WRITEMASK];
      const before = keys.map(key => gl.getParameter(key));
      const masks = [...gl.getParameter(gl.COLOR_WRITEMASK)];
      const viewport = [...gl.getParameter(gl.VIEWPORT)];
      const capabilities = [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD];
      const enabled = capabilities.map(cap => gl.isEnabled(cap));
      point.render({ viewProjection: vp });
      check(keys.every((key, i) => gl.getParameter(key) === before[i]), 'Marker draw preserves host bindings and depth state');
      equal([...gl.getParameter(gl.COLOR_WRITEMASK)], masks, 'Marker draw preserves write masks');
      equal([...gl.getParameter(gl.VIEWPORT)], viewport, 'Marker draw preserves viewport');
      equal(capabilities.map(cap => gl.isEnabled(cap)), enabled, 'Marker draw preserves capability state');
      check(pixel().slice(0, 3).every(value => value === 255), 'Library draws its own luminous sphere');
      check(gl.getParameter(gl.ARRAY_BUFFER_BINDING) === vertices, 'Consumer vertex binding remains intact');
      check(gl.getError() === gl.NO_ERROR, 'No WebGL errors in lighting, readback, drawing, or relinking');
    } finally { gpu.dispose(); }
  });
});

test('Disposal is idempotent and retains consumer GPU resources', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const url = '/support/library.js';
    const { createScene } = await import(url) as typeof import('../support/browser/library');
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const { lib, throws } = support;
    const gpu = createScene();
    const { gl, point, litProgram, vp, fs } = gpu;
    try {
      const geometryBuffer = gpu.buffer(new Float32Array([0, 0, 0]));
      throws(() => lib.createProgram(gl, '#version 300 es\ninvalid', fs), 'Shader compilation reports failure');
      point.dispose();
      point.dispose();
      check(gl.isBuffer(geometryBuffer) && gl.isProgram(litProgram), 'Disposal keeps consumer resources alive');
      throws(() => point.render({ viewProjection: vp }), 'Disposed markers reject drawing');
    } finally { gpu.dispose(); }
  });
});

test('The same controller rebuilds marker resources after context restoration', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const url = '/support/library.js';
    const { createScene } = await import(url) as typeof import('../support/browser/library');
    const gpuURL = '/support/gpu.js';
    const support = await import(gpuURL) as typeof import('../support/browser/gpu');
    const check: typeof support.check = support.check;
    const { restoreContext } = support;
    const gpu = createScene();
    const { gl, vp, pixel } = gpu;
    try {
      const recovering = gpu.sprite({ position: [0, 0, 0.5] });
      await restoreContext(gpu.canvas, gl, () => recovering.render({ viewProjection: vp }));
      gl.viewport(0, 0, 96, 96);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      recovering.render({ viewProjection: vp });
      check(pixel().slice(0, 3).every(value => value === 255), 'The same marker controller rebuilds resources after context restoration');
      check(gl.getError() === gl.NO_ERROR, 'Restored marker drawing is free of WebGL errors');
    } finally { gpu.dispose(); }
  });
});

