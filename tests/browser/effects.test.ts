import { test } from '../support/browser-fixture';

test('glow radius, intensity and sixteen layers produce additive pixels', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal, near, throws, haloTolerance } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { gl, sprite, render, draw } = harness;
    try {
      const huge = sprite({ diameter: 2e38 });
      check(!huge.glow.enabled && Number.isFinite(Math.fround(huge.glow.radius)), 'Disabled glow preserves the finite supported marker-size range');
      huge.dispose();
      const source = sprite({ position: [0, 0, 0.5], light: { intensity: 1 } });
      check(source.brightness === 1 && !source.isFlickering, 'Effects are disabled by default');
      const plain = render(source);
      equal(plain.center, [255, 255, 255, 255], 'Default marker retains fully bright pixels');
      equal(plain.ring.slice(0, 3), [0, 0, 0], 'Default marker has no halo outside its 10 cm diameter');
      source.update(10);
      equal(render(source), plain, 'Explicit updates leave disabled effects unchanged');
      source.setGlow(true);
      const glowing = render(source);
      check(glowing.ring[0] > 20 && glowing.outer[0] > 0, 'Glow adds visible pixels beyond the marker');
      equal(glowing.center, plain.center, 'The marker depth occludes halo contribution at its center');
      near(glowing.ring[3], 64, 1, 'Additive halo preserves destination alpha');
      const originalGlow = source.glow;
      // Deliberately mutate the detached snapshot to verify consumer writes cannot affect the controller.
      const detachedGlow = source.glow as unknown as import('../../src/index').ResolvedGlow;
      detachedGlow.radius = 99;
      equal(source.glow, originalGlow, 'Glow options are detached snapshots');
      throws(() => source.setGlow({ radius: 0, intensity: 0.1 }), 'Invalid glow update is rejected');
      equal(source.glow, originalGlow, 'Rejected glow updates are atomic');
      source.setGlow({ intensity: originalGlow.intensity / 2 });
      near(render(source).ring[0], glowing.ring[0] / 2, haloTolerance(0.5), 'Glow intensity controls additive pixels');
      source.setGlow({ intensity: originalGlow.intensity * 2 });
      near(render(source).ring[0], glowing.ring[0] * 2, haloTolerance(2), 'Glow intensity above one retains unsaturated halo strength');
      source.setGlow({ intensity: originalGlow.intensity, falloff: originalGlow.falloff * 2 });
      check(render(source).ring[0] < glowing.ring[0] - 10, 'Higher falloff dims the halo away from its center');
      source.setGlow({ radius: 0.08, falloff: originalGlow.falloff });
      equal(render(source).ring.slice(0, 3), [0, 0, 0], 'World-space radius limits halo extent');
      source.setGlow(originalGlow);
      source.setGlow(false);
      equal(render(source), plain, 'Disabling glow restores the original marker pixels');
      source.setGlow(true);
      equal(render(source), glowing, 'Re-enabling glow preserves numeric settings');
      const uniform1f = gl.uniform1f.bind(gl), drawInstanced = gl.drawArraysInstanced.bind(gl);
      let haloDraws = 0;
      gl.uniform1f = (location, value) => {
        check(Number.isFinite(Math.fround(value)), 'Supported glow options upload finite scalar uniforms');
        return uniform1f(location, value);
      };
      gl.drawArraysInstanced = (...args) => {
        haloDraws++;
        equal(args[3], 16, 'The halo uses a fixed sixteen-layer budget');
        return drawInstanced(...args);
      };
      try {
        source.setGlow({ falloff: 500000 });
        equal(render(source).center, plain.center, 'Large falloff leaves the opaque marker unchanged');
        equal(haloDraws, 1, 'Layered glow needs one instanced draw');
      } finally {
        gl.uniform1f = uniform1f;
        gl.drawArraysInstanced = drawInstanced;
        source.setGlow(originalGlow);
      }
    } finally {
      harness.dispose();
    }
  });
});

test('layered glow fades through an intersecting surface and preserves alpha', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { gl, sprite, program, vp, reset, render, draw } = harness;
    try {
      const surface = program(`#version 300 es
    precision highp float; out vec4 color;
    void main() {
    float worldX = gl_FragCoord.x / 192.0 * 2.0 - 1.0;
    gl_FragDepth = clamp(0.5 + 0.5 * (0.5 + (worldX - 0.16)), 0.0, 1.0);
    color = vec4(0.2, 0.07, 0.02, 0.25);
    }`);
      const intersecting = sprite({ position: [0, 0, 0.5], glow: { radius: 0.5 } });
      const surfaceRow = (enabled: boolean) => {
        intersecting.setGlow(enabled);
        reset();
        gl.enable(gl.DEPTH_TEST);
        draw(surface);
        intersecting.render({ viewProjection: vp });
        const row = new Uint8Array(192 * 4);
        gl.readPixels(0, 96, 192, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        return row;
      };
      const unlitRow = surfaceRow(false), glowRow = surfaceRow(true);
      const contributions: number[] = [];
      for (let x = 107; x < 142; x++) {
        for (let channel = 0; channel < 3; channel++)
          check(glowRow[x * 4 + channel] >= unlitRow[x * 4 + channel], 'Glow never darkens a nearby colored surface');
        equal(glowRow[x * 4 + 3], unlitRow[x * 4 + 3], 'Intersecting glow preserves surface alpha');
        contributions.push(glowRow[x * 4] - unlitRow[x * 4]);
      }
      const largestEdge = Math.max(...contributions.slice(1).map((value, i) => Math.abs(value - contributions[i])));
      check(largestEdge < 20, `Nearby surfaces fade through the glow rather than cutting a bright plane: ${largestEdge}`);
      check(contributions.filter(value => value > 0 && value < Math.max(...contributions)).length > 8, 'The intersection contains intermediate glow levels');
    } finally {
      harness.dispose();
    }
  });
});

test('shared depth occludes rear glow while halo leaves depth unwritten', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { gl, sprite, program, vp, reset, pixel, render, draw } = harness;
    try {
      const source = sprite({ position: [0, 0, 0.5], light: { intensity: 1 }, glow: true });
      const intersecting = sprite({ position: [0, 0, 0.5], glow: { radius: 0.5 } });
      const solid = program(`#version 300 es
    precision highp float; out vec4 color;
    void main() { color = vec4(0, 1, 0, 1); }`);
      reset();
      gl.enable(gl.DEPTH_TEST);
      draw(solid, 0);
      source.render({ viewProjection: vp });
      equal(pixel(106), [0, 255, 0, 255], 'Foreground consumer geometry occludes the halo through shared depth');
      intersecting.render({ viewProjection: vp });
      equal(pixel(118), [0, 255, 0, 255], 'Rear glow layers retain complete foreground occlusion');
      reset();
      gl.enable(gl.DEPTH_TEST);
      draw(solid, 0.499);
      intersecting.render({ viewProjection: vp });
      equal(pixel(118), [0, 255, 0, 255], 'A surface just in front of the marker center occludes every rear glow layer');
      reset();
      source.render({ viewProjection: vp });
      gl.enable(gl.DEPTH_TEST);
      draw(solid, 0.75);
      equal(pixel(106), [0, 255, 0, 255], 'Halo does not write depth outside the marker');
      equal(pixel(), [255, 255, 255, 255], 'Marker retains its own depth writes');
    } finally {
      harness.dispose();
    }
  });
});

test('glow restores consumer bindings, masks and render state', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { gl, sprite, program, vp, reset, render, vao } = harness;
    try {
      const source = sprite({ position: [0, 0, 0.5], light: { intensity: 1 }, glow: true });
      const solid = program(`#version 300 es
    precision highp float; out vec4 color;
    void main() { color = vec4(0, 1, 0, 1); }`);
      reset();
      gl.useProgram(solid);
      gl.bindVertexArray(vao);
      gl.viewport(2, 3, 180, 181);
      gl.depthFunc(gl.GREATER);
      gl.depthMask(false);
      gl.colorMask(false, true, false, false);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ZERO);
      gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_SUBTRACT);
      const caps = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE];
      caps.forEach(cap => gl.enable(cap));
      const keys = [gl.CURRENT_PROGRAM, gl.VERTEX_ARRAY_BINDING, gl.ARRAY_BUFFER_BINDING, gl.DRAW_FRAMEBUFFER_BINDING, gl.READ_FRAMEBUFFER_BINDING, gl.DEPTH_FUNC, gl.DEPTH_WRITEMASK, gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA, gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA];
      const before = keys.map(key => gl.getParameter(key));
      const masks = [...gl.getParameter(gl.COLOR_WRITEMASK)], viewport = [...gl.getParameter(gl.VIEWPORT)];
      source.render({ viewProjection: vp });
      check(keys.every((key, i) => gl.getParameter(key) === before[i]), 'Glow rendering preserves host bindings, blending, and depth state');
      equal([...gl.getParameter(gl.COLOR_WRITEMASK)], masks, 'Glow rendering restores host color masks');
      equal([...gl.getParameter(gl.VIEWPORT)], viewport, 'Glow rendering retains host viewport');
      check(caps.every(cap => gl.isEnabled(cap)), 'Glow rendering restores host enable flags');
    } finally {
      harness.dispose();
    }
  });
});

test('caller clock dims marker, halo and receiver coherently', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal, near, throws, haloTolerance } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { lib, gl, sprite, program, reset, pixel, render, draw } = harness;
    try {
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => { throw new Error('Effects must use the caller clock'); };
      try {
        const source = sprite({ position: [0, 0, 0.5], light: { intensity: 1 }, glow: true });
        const glowing = render(source);
        const lit = program(`#version 300 es
    precision highp float; out vec4 color;
    ${lib.LIGHT_SPRITE_GLSL}
    void main() { color = vec4(lightSpriteShade(vec3(1), vec3(0, 0, -0.5), vec3(0, 0, 1)), 1); }`);
        const receiver = () => {
          reset();
          source.bindLighting(lit, { ambient: 0 });
          near(gl.getUniform(lit, gl.getUniformLocation(lit, 'u_lightSpriteIntensity')!), source.light.intensity, 1e-6, 'Consumer uniform agrees with effective light snapshot');
          draw(lit);
          return pixel()[0];
        };
        const receiverBright = receiver();
        check(receiverBright > 10 && receiverBright < 100, 'Consumer fixture has unsaturated direct lighting');
        source.setFlicker({ depth: 0.8, speed: 2, seed: 17 });
        check(source.isFlickering && source.brightness === 1, 'Enabling flicker starts fully bright and requests continuous caller frames');
        const twin = sprite({ flicker: { depth: 0.8, speed: 2, seed: 17 } });
        for (let i = 0; i < 32 && source.brightness > 0.65; i++) {
          source.update(0.125);
          twin.update(0.125);
        }
        near(source.brightness, twin.brightness, 1e-12, 'Identical seeds and caller times produce identical brightness');
        check(source.brightness >= 0.2 && source.brightness < 0.65, 'Controlled clock reaches a visibly dim frame within configured depth');
        const brightness = source.brightness;
        near(source.light.intensity, brightness, 1e-12, 'Effective point intensity is base intensity times brightness');
        const dim = render(source);
        near(dim.center[0], 255 * brightness, 2, 'Marker uses the shared flicker multiplier');
        near(dim.ring[0], glowing.ring[0] * brightness, haloTolerance(brightness), 'Halo uses the same flicker multiplier');
        near(receiver(), receiverBright * brightness, 2, 'Consumer illumination dims coherently with marker and halo');
        near(source.brightness, brightness, 0, 'Rendering and lighting binds do not advance the caller clock');
        const savedFlicker = source.flicker;
        throws(() => source.setFlicker({ seed: -1, depth: 0.1 }), 'Invalid flicker options are rejected');
        equal(source.flicker, savedFlicker, 'Rejected flicker update is atomic');
        near(source.brightness, brightness, 0, 'Rejected flicker update preserves phase');
        source.setFlicker(false);
        check(!source.isFlickering && source.brightness === 1 && source.light.intensity === 1, 'Disabling flicker restores base intensity immediately');
        equal(render(source), glowing, 'Disabling flicker restores marker and halo pixels');
        equal(receiver(), receiverBright, 'Disabling flicker restores consumer illumination');
        source.setFlicker({ depth: 0 });
        check(!source.isFlickering, 'Zero depth does not require continuous frames');
      } finally {
        window.requestAnimationFrame = raf;
      }
    } finally {
      harness.dispose();
    }
  });
});

test('effect changes retain shadow cache and disposal retains consumer resources', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { lib, gl, sprite, program, reset, render, vao } = harness;
    try {
      const drawArrays = gl.drawArrays.bind(gl), drawElements = gl.drawElements.bind(gl);
      let shadowDraws = 0;
      gl.drawArrays = (...args) => {
        if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING))
          shadowDraws++;
        return drawArrays(...args);
      };
      gl.drawElements = (...args) => {
        if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING))
          shadowDraws++;
        return drawElements(...args);
      };
      try {
        const shadowed = sprite({ position: [0, 0, 1], shadows: { resolution: 32 }, glow: true, flicker: true,
          models: [{ geometry: lib.createBoxGeometry({ width: 0.2, height: 0.2, depth: 0.2 }), worldMatrix: lib.translationMatrix([0, 0, 0.5]) }] });
        const shadowProgram = program(`#version 300 es
    precision highp float; out vec4 color;
    ${shadowed.lightingGLSL}
    void main() { color = vec4(lightSpriteShade(vec3(1), vec3(0), vec3(0, 0, 1)), 1); }`);
        gl.bindVertexArray(vao);
      reset();
        const bindCount = () => {
          const before = shadowDraws;
          shadowed.bindLighting(shadowProgram);
          return shadowDraws - before;
        };
        check(bindCount() > 0, 'Initial shadow bind draws registered casters');
        equal(bindCount(), 0, 'Repeated lighting bind caches the shadow map');
        shadowed.update(0.5);
        shadowed.setGlow({ intensity: 0.2 });
        equal(bindCount(), 0, 'Clock and halo appearance changes retain cached shadows');
        shadowed.setPosition([0.1, 0, 1]);
        check(bindCount() > 0, 'Light movement still invalidates cached shadows');
        const cube = sprite({ marker: 'cube', position: [0, 0, 0.5], glow: true });
        check(render(cube).ring[0] > 20, 'Custom cube markers can use glow');
        cube.dispose();
        cube.dispose();
        shadowed.dispose();
        check(gl.isProgram(shadowProgram) && gl.isVertexArray(vao), 'Disposal retains borrowed consumer resources');
        check(gl.getError() === gl.NO_ERROR, 'Effects and consumer drawing have no WebGL errors');
      } finally {
        gl.drawArrays = drawArrays;
        gl.drawElements = drawElements;
      }
    } finally {
      harness.dispose();
    }
  });
});

test('context restoration rebuilds marker and halo without resetting flicker', async ({ gpuPage }) => {
  await gpuPage.evaluate(async () => {
    const helperURL = '/support/effects.js';
    const helpers = await import(helperURL) as typeof import('../support/browser/effects');
    const check: typeof helpers.check = helpers.check;
    const { equal, near } = helpers;
    const harness = await helpers.createEffectsHarness();
    const { canvas, gl, sprite, vp, render, draw } = harness;
    try {
      const source = sprite({ position: [0, 0, 0.5], light: { intensity: 1 }, glow: true });
      source.setFlicker({ depth: 0.8, speed: 2, seed: 17 });
      source.update(0.625);
      const recoveringBrightness = source.brightness;
      const recoveringPixels = render(source);
      const extension = gl.getExtension('WEBGL_lose_context');
      check(extension, 'Context loss extension is available for effect recovery');
      const event = (name: string) => new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for effects ${name}`)), 5000);
        canvas.addEventListener(name, () => { clearTimeout(timeout); done(); }, { once: true });
      });
      const lost = event('webglcontextlost');
      extension.loseContext();
      await lost;
      source.render({ viewProjection: vp });
      await new Promise(done => setTimeout(done, 100));
      const restored = event('webglcontextrestored');
      extension.restoreContext();
      await restored;
      harness.renewVao();
      near(source.brightness, recoveringBrightness, 0, 'Context recovery preserves explicit clock phase');
      equal(render(source), recoveringPixels, 'Same controller rebuilds marker and halo resources after context restoration');
      check(gl.getError() === gl.NO_ERROR, 'Recovered effects draw without WebGL errors');
    } finally {
      harness.dispose();
    }
  });
});
