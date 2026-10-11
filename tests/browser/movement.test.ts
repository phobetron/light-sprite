import { test } from '../support/browser-fixture';

test('recentered GPU marker matches its planned world enclosure', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const { equal } = helpers;
    const harness = await helpers.createMovementHarness();
    const { lib, canvas, gl, sprite, box } = harness;
    try {
      const farPivotGeometry = box(0.2);
      for (let index = 0; index < farPivotGeometry.positions.length; index += 3)
        farPivotGeometry.positions[index] += 1e6;
      const offsetRender = sprite({ marker: farPivotGeometry, position: [-1e6 + 0.04, 0, 0], movement: { bounds: { shape: 'sphere', center: [0.04, 0, 0], radius: 0.19 } } });
      canvas.width = canvas.height = 256;
      gl.viewport(0, 0, 256, 256);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      offsetRender.render({ viewProjection: lib.identityMatrix() });
      const offsetPixel = new Uint8Array(4);
      gl.readPixels(151, 140, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, offsetPixel);
      equal([...offsetPixel], [0, 0, 0, 255], 'Off-center GPU geometry does not drift outside its planned enclosure due to translation cancellation');
      gl.readPixels(140, 140, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, offsetPixel);
      equal([...offsetPixel], [255, 255, 255, 255], 'Recentered custom marker geometry remains visible in its expected world location');
    } finally {
      harness.dispose();
    }
  });
});

test('registered obstacles constrain seeded movement and paused repositioning', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const check: typeof helpers.check = helpers.check;
    const { equal, near, rejects, distance } = helpers;
    const harness = await helpers.createMovementHarness();
    const { lib, sprite, box, cubeBounds, sphereBounds, validate } = harness;
    try {
      const obstacleModels = [-0.8, 0.8].map(x => ({ geometry: box(), worldMatrix: lib.translationMatrix([x, 0, 0]), castsShadow: false }));
      for (const bounds of [cubeBounds, sphereBounds]) {
        const options: import('../../src/index').LightSpriteOptions = { diameter: 0.2, movement: { bounds, seed: 17, speed: 0.8 }, models: obstacleModels };
        const source = sprite(options), twin = sprite(options);
        const alternateSeed = sprite({ ...options, movement: { bounds, seed: 91, speed: 0.8 } });
        const initial = source.position;
        for (let step = 0; step < 120; step++) {
          source.update(1 / 60);
          twin.update(1 / 60);
          alternateSeed.update(1 / 60);
          equal(source.position, twin.position, 'Equal seeds and caller clocks produce identical paths');
          validate(source, bounds, source.getModelBounds());
          check(source.isMoving, 'Valid bounded motion remains active');
        }
        check(distance(source.position, initial) > 1e-3, 'Caller updates move the light');
        check(distance(source.position, alternateSeed.position) > 1e-3, 'The public controller forwards distinct seeds to movement planning');
        source.setMovement(false);
        const paused = source.position, settings = source.movement!;
        source.update(100);
        equal(source.position, paused, 'Pause stops motion');
        check(!source.isMoving && !settings.enabled, 'Pause is visible in the public state');
        rejects(() => source.setPosition([3, 0, 0]), 'Paused movement still validates its domain');
        equal(source.position, paused, 'Rejected repositioning is atomic');
        source.setMovement(true);
        source.update(0.25);
        check(source.isMoving && distance(source.position, paused) > 0, 'Resume retains settings and advances motion');
        near(source.movement!.speed, settings.speed, 0, 'Resume preserves speed');
      }
    } finally {
      harness.dispose();
    }
  });
});

test('custom marker enclosures retain offset and obstacle clearance', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const check: typeof helpers.check = helpers.check;
    const { near } = helpers;
    const harness = await helpers.createMovementHarness();
    const { sprite, box, cubeBounds, validate } = harness;
    try {
      const cubeMarker = sprite({ marker: 'cube', diameter: 0.2, movement: { bounds: cubeBounds } });
      near(cubeMarker.movementSphere.radius, Math.sqrt(3) * 0.1, 1e-7, 'Cube enclosure uses its diagonal radius');
      const offsetGeometry = box(0.2);
      for (let i = 0; i < offsetGeometry.positions.length; i += 3)
        offsetGeometry.positions[i] += 0.4;
      const offset = sprite({ marker: offsetGeometry, movement: { bounds: cubeBounds, seed: 41 } });
      for (let i = 0; i < 300; i++) {
        offset.update(1 / 60);
        near(offset.movementSphere.center[0], offset.position[0] + 0.4, 1e-7, 'Custom enclosure retains its local center offset');
        near(offset.movementSphere.center[1], offset.position[1], 1e-7, 'Custom enclosure follows the current translation');
        validate(offset, cubeBounds);
      }
      const corner = sprite({ position: [0.2, 0.2, 0], diameter: 0.2, movement: { bounds: cubeBounds }, models: [{ geometry: box(0.2) }] });
      validate(corner, cubeBounds, corner.getModelBounds());
      check(corner.isMoving, 'Exact sphere-to-box clearance accepts valid diagonal corners');
      const ignored = sprite({ movement: { bounds: cubeBounds }, models: [{ geometry: box(), obstacle: false, castsShadow: true }] });
      ignored.update(0.25);
      check(ignored.isMoving, 'A shadow caster can independently opt out of movement obstacles');
    } finally {
      harness.dispose();
    }
  });
});

test('transform updates and explicit GPU bounds refresh reach collision planning', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const check: typeof helpers.check = helpers.check;
    const { equal, near, rejects } = helpers;
    const harness = await helpers.createMovementHarness();
    const { lib, gl, sprite, box, cubeBounds, validate } = harness;
    try {
      const getBufferSubData = gl.getBufferSubData.bind(gl), getParameter = gl.getParameter.bind(gl);
      let readbacks = 0, queries = 0;
      gl.getBufferSubData = (...args) => { readbacks++; return getBufferSubData(...args); };
      gl.getParameter = (...args) => { queries++; return getParameter(...args); };
      try {
        let matrixReads = 0;
        let matrix = lib.translationMatrix([1, 0, 0]);
        const changing = sprite({ movement: { bounds: cubeBounds }, models: [{ geometry: box(), worldMatrix: () => { matrixReads++; return matrix; }, castsShadow: false }] });
        const beforeMatrices = matrixReads;
        changing.update(0.25);
        check(matrixReads > beforeMatrices, 'Caller updates observe current consumer transforms');
        matrix = lib.translationMatrix([-1, 0, 0]);
        changing.update(0.25);
        validate(changing, cubeBounds, changing.getModelBounds());
        const beforeOverlap = changing.position;
        matrix = lib.translationMatrix(beforeOverlap);
        rejects(() => changing.update(1 / 60), 'A moved model overlapping the enclosure is revalidated');
        equal(changing.position, beforeOverlap, 'Invalid transformed obstacles do not advance the pose');
        matrix = lib.translationMatrix([1, 0, 0]);
        changing.update(0.25);
        validate(changing, cubeBounds, changing.getModelBounds());
        const gpuGeometry = box();
        const gpuBuffer = harness.buffer(new Float32Array());
        const gpuPositions = gpuGeometry.positions.slice();
        for (let i = 0; i < gpuPositions.length; i += 3)
          gpuPositions[i] += 1;
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, gpuPositions, gl.DYNAMIC_DRAW);
        const gpu = sprite({ movement: { bounds: cubeBounds }, models: [{ geometry: { buffer: gpuBuffer, count: gpuPositions.length / 3 }, castsShadow: false }] });
        const cachedReads = readbacks, cachedQueries = queries;
        for (let i = 0; i < 300; i++)
          gpu.update(1 / 60);
        equal(readbacks, cachedReads, 'Static movement frames never reread GPU geometry');
        equal(queries, cachedQueries, 'Collision updates perform no WebGL state queries');
        for (let i = 0; i < gpuPositions.length; i += 3)
          gpuPositions[i] -= 2;
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, gpuPositions);
        gpu.refreshBounds();
        check(readbacks > cachedReads, 'Explicit bounds refresh rereads changed GPU geometry');
        near(gpu.getModelBounds()[0].min[0], -1.15, 1e-6, 'Refreshed GPU bounds reach movement integration');
        gpu.update(0.25);
        validate(gpu, cubeBounds, gpu.getModelBounds());
      } finally {
        gl.getBufferSubData = getBufferSubData;
        gl.getParameter = getParameter;
      }
    } finally {
      harness.dispose();
    }
  });
});

test('virtual movement bounds preserve lighting and moving shadow invalidation', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const check: typeof helpers.check = helpers.check;
    const { equal, near } = helpers;
    const harness = await helpers.createMovementHarness();
    const { lib, gl, sprite, box, sphereBounds, program, probe } = harness;
    try {
      // The domain is virtual: a caster and receiver outside it still participate in lighting.
      const tight: import('../../src/index').MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [0.4, 0.4, 0.4] };
      const caster = { geometry: box(), worldMatrix: lib.translationMatrix([0, 0, -0.5]), obstacle: false };
      const small = sprite({ movement: { bounds: tight }, models: [caster], shadows: { resolution: 64 } });
      const large = sprite({ movement: { bounds: sphereBounds }, models: [caster], shadows: { resolution: 64 } });
      equal(small.lightingGLSL, large.lightingGLSL, 'Movement bounds never alter consumer GLSL');
      const lighting = program(small.lightingGLSL);
      const blocked = probe(small, lighting, [0, 0, -1], [0, 0, 1]);
      check(Math.abs(blocked[0] - 13) <= 2, 'An outside-domain registered caster shadows an outside-domain receiver');
      equal(probe(large, lighting, [0, 0, -1], [0, 0, 1]), blocked, 'Domain size does not restrict shadow range');
      const clear = probe(small, lighting, [0.8, 0, -1], [0, 0, 1]);
      equal(clear, probe(large, lighting, [0.8, 0, -1], [0, 0, 1]), 'Outside-domain clear receivers retain unchanged illumination');
      equal(clear, probe(small, lighting, [0.8, 0, -1], [0, 0, 1], { shadows: false }), 'Virtual bounds do not cast their own shadows');
      check(clear[0] > blocked[0] + 15, 'Outside-domain direct lighting remains visible');
      const plain = sprite({ movement: { bounds: tight } });
      equal(plain.lightingGLSL, lib.LIGHT_SPRITE_GLSL, 'Movement alone keeps base lighting GLSL unchanged');
      const unbounded = sprite();
      const baseLighting = program(plain.lightingGLSL);
      equal(probe(plain, baseLighting, [0.8, 0, -1], [0, 0, 1]), probe(unbounded, baseLighting, [0.8, 0, -1], [0, 0, 1]), 'Virtual bounds do not clip ordinary receiver lighting');
      const drawArrays = gl.drawArrays.bind(gl), drawElements = gl.drawElements.bind(gl);
      let shadowDraws = 0;
      let disabledShadowDraws = 0;
      gl.drawArrays = (...args) => { shadowDraws++; return drawArrays(...args); };
      gl.drawElements = (...args) => { shadowDraws++; return drawElements(...args); };
      try {
        large.bindLighting(lighting);
        const initialDraws = shadowDraws;
        large.bindLighting(lighting);
        equal(shadowDraws, initialDraws, 'Static light binds reuse their shadow map');
        large.update(0.25);
        large.bindLighting(lighting);
        check(shadowDraws > initialDraws, 'Actual motion invalidates and rebuilds the shadow map');
        large.update(0.25);
        const beforeDisabled = shadowDraws;
        large.bindLighting(lighting, { shadows: false });
        disabledShadowDraws = shadowDraws - beforeDisabled;
        equal(disabledShadowDraws, 0, 'Disabled shadows perform no depth geometry passes during movement');
        large.bindLighting(lighting);
        check(shadowDraws > beforeDisabled, 'Re-enabling shadows rebuilds for the new source position');
        const uniform = gl.getUniform(lighting, gl.getUniformLocation(lighting, 'u_lightSpritePosition')!);
        (uniform as Float32Array).forEach((value, axis) => near(value, large.position[axis], 1e-7, 'Consumer light uniforms follow the current pose'));
      } finally {
        gl.drawArrays = drawArrays;
        gl.drawElements = drawElements;
      }
    } finally {
      harness.dispose();
    }
  });
});

test('context restoration preserves independent movement trajectory and shadow pixels', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const check: typeof helpers.check = helpers.check;
    const { equal } = helpers;
    const harness = await helpers.createMovementHarness();
    const { lib, canvas, gl, sprite, box, cubeBounds, program, probe } = harness;
    try {
      const caster = { geometry: box(), worldMatrix: lib.translationMatrix([0, 0, -0.5]), obstacle: false };
      const recovering = sprite({ movement: { bounds: cubeBounds, seed: 81 }, models: [caster], shadows: { resolution: 32 } });
      const twinHarness = await helpers.createMovementHarness();
      try {
        const recoveryTwin = twinHarness.sprite({ movement: { bounds: cubeBounds, seed: 81 }, models: [caster], shadows: { resolution: 32 } });
        recovering.update(0.25);
        recoveryTwin.update(0.25);
        const recoveryPosition = recovering.position;
        const beforeLighting = program(recovering.lightingGLSL);
        const beforePixels = probe(recovering, beforeLighting, [0, 0, -1], [0, 0, 1]);
        check(beforePixels[0] <= 15, 'Recovery fixture receiver is shadowed before loss');
        const extension = gl.getExtension('WEBGL_lose_context');
        check(extension, 'Movement context recovery extension is available');
        const event = (name: string) => new Promise<void>((done, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timed out waiting for movement ${name}`)), 5000);
          canvas.addEventListener(name, () => { clearTimeout(timeout); done(); }, { once: true });
        });
        const lost = event('webglcontextlost');
        extension.loseContext();
        await lost;
        await new Promise(done => setTimeout(done, 100));
        const restored = event('webglcontextrestored');
        extension.restoreContext();
        await restored;
        harness.renewVao();
        equal(recovering.position, recoveryPosition, 'Context restoration preserves source position');
        const restoredLighting = program(recovering.lightingGLSL);
        equal(probe(recovering, restoredLighting, [0, 0, -1], [0, 0, 1]), beforePixels, 'Restored shadow map preserves blocked receiver pixels');
        for (let frame = 0; frame < 120; frame++) {
          recovering.update(0.025);
          recoveryTwin.update(0.025);
          equal(recovering.position, recoveryTwin.position, 'Context restoration preserves movement phase and random state');
        }
        probe(recovering, restoredLighting, [0.8, 0, -1], [0, 0, 1]);
        check(gl.getError() === gl.NO_ERROR, 'The same moving controller restores shadow resources');
      } finally {
        twinHarness.dispose();
      }
    } finally {
      harness.dispose();
    }
  });
});

test('caller delta caps movement while the effects clock advances in full', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const { equal, near } = helpers;
    const harness = await helpers.createMovementHarness();
    const { sprite, cubeBounds } = harness;
    try {
      const options = { movement: { bounds: cubeBounds, seed: 29 }, flicker: { seed: 7, depth: 0.8, speed: 2 } };
      const capped = sprite(options);
      const shortFrame = sprite(options);
      const effectsOnly = sprite({ flicker: options.flicker });
      capped.update(5);
      shortFrame.update(0.25);
      effectsOnly.update(5);
      equal(capped.position, shortFrame.position, 'Long caller frames cap movement advancement');
      near(capped.brightness, effectsOnly.brightness, 0, 'Effects receive the full caller delta independently of movement');
    } finally { harness.dispose(); }
  });
});

test('movement defaults and rejected updates preserve the composed controller state', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/movement.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/movement');
    const check: typeof helpers.check = helpers.check;
    const { equal, rejects } = helpers;
    const harness = await helpers.createMovementHarness();
    const { sprite, cubeBounds } = harness;
    try {
      const disabled = sprite();
      check(!disabled.isMoving && disabled.movement === null, 'Movement defaults to disabled without a domain');
      const defaults = { position: disabled.position, movement: disabled.movement, brightness: disabled.brightness };
      rejects(() => disabled.setMovement(true), 'Enabling movement requires bounds');
      equal({ position: disabled.position, movement: disabled.movement, brightness: disabled.brightness }, defaults, 'Rejected activation preserves defaults');
      const source = sprite({ movement: { bounds: cubeBounds, seed: 29 }, flicker: { seed: 7, depth: 0.8, speed: 2 } });
      source.update(0.125);
      const before = { position: source.position, movement: source.movement, brightness: source.brightness };
      rejects(() => source.setMovement({ speed: 0 }), 'Invalid movement configuration is rejected');
      equal({ position: source.position, movement: source.movement, brightness: source.brightness }, before, 'Rejected settings preserve position, configuration and effects phase');
    } finally { harness.dispose(); }
  });
});
