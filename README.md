# Light Sprite

A renderer-independent WebGL MVP with safe seeded wandering, optional shadows, glow and flicker, and automatic model bounds. No rendering framework or runtime dependencies are required. Initial movement is implemented; its behavior remains open to review before the MVP is finalized.

The library draws the marker; the consumer keeps their models, renderer, camera, and frame loop. One world unit represents one metre by convention. The WebGL drawing backend requires WebGL 2; geometry, math, and bounds utilities work independently of WebGL.

## Integration

```ts
import { createLightSprite } from 'light-sprite';

const sprite = createLightSprite(gl, {
  position: [0, 2, 0],
  shadows: true, // optional; disabled by default
  // Defaults: a white 0.1 m diameter sphere; intensity 6; unlimited range.
  models: models.map(model => ({
    geometry: model.geometry, // { positions, indices? }; existing arrays
    worldMatrix: () => model.worldMatrix,
  })),
});

// Include sprite.lightingGLSL after the fragment shader's precision declaration.
// Your shader supplies worldPosition, worldNormal, and linear RGB baseColor:
// vec3 lit = lightSpriteShade(baseColor, worldPosition, worldNormal);
// outColor = vec4(lightSpriteLinearToSRGB(lightSpriteToneMap(lit)), 1.0);

gl.useProgram(surfaceProgram);
sprite.bindLighting(surfaceProgram, { ambient: 0.03 });
drawConsumerScene();
sprite.render({ viewProjection }); // same target/depth buffer; no clear

const bounds = sprite.getModelBounds(); // calculated world-space boxes
```

`viewProjection` is a column-major projection × view matrix. Model matrices are affine local-to-world transforms; omit them only for world-space positions. For nonuniformly scaled objects, the host shader must transform normals with an appropriate normal matrix. The example uses translation-only model transforms.

The library provides the lighting calculation and uniform binding. Consumer surface shaders must call that calculation for the light to affect their objects; drawing a luminous marker does not automatically rewrite other shaders. Helpers return linear RGB, with optional Reinhard tone mapping and sRGB output conversion. Consumers with an existing color pipeline should use only the helpers they need to avoid applying conversions twice. Source strength uses `intensity / (4π distance²)` with a near-source clamp; optional `range` adds a smooth cutoff. The original `vec3` shading overload provides matte diffuse lighting; the material overload adds specular highlights. `LIGHT_SPRITE_GLSL` remains available for non-shadow integrations.

## Surface materials

Material properties belong to consumer surfaces, independently of geometry registered for collision or shadow casting. `createLightSpriteMaterial()` validates and copies CPU values without allocating GPU resources:

```ts
import { createLightSpriteMaterial } from 'light-sprite';

const material = createLightSpriteMaterial({
  baseColor: [0.95, 0.018, 0.025], // linear RGB
  roughness: 0.25,
  specularReflectance: 0.08,
});

sprite.bindLighting(surfaceProgram, { cameraPosition: camera.position, ambient: 0.03 });
// Upload consumer-owned material uniforms for each object:
gl.uniform3fv(baseColorLocation, material.baseColor);
gl.uniform1f(roughnessLocation, material.roughness);
gl.uniform3fv(reflectanceLocation, material.specularReflectance);
drawObject();
```

The fragment shader includes `sprite.lightingGLSL` and uses:

```glsl
LightSpriteMaterial material = lightSpriteMaterial(baseColor, roughness, specularReflectance);
vec3 lit = lightSpriteShade(material, worldPosition, worldNormal);
```

`baseColor` defaults to white, `roughness` to `0.5`, and `specularReflectance` to `0.04`. All components are finite values in `[0, 1]`. Reflectance is the normal-incidence fraction: `0.04` means 4%, with Fresnel increasing reflection at grazing angles. A scalar applies to all channels; an RGB vector allows tinted highlights. Lower roughness sharpens highlights; higher roughness spreads them. The shader internally floors roughness at `0.045` for numerical stability. The GLSL shorthand `lightSpriteMaterial(baseColor)` uses these defaults. Fields can also come from consumer textures or vertex inputs.

Material shading uses GGX, height-correlated Smith visibility, Schlick Fresnel, and Fresnel-reduced Lambert diffuse. Shadow visibility affects both direct components, while ambient remains a simple diffuse contribution. Movement, flicker, range, and light color apply automatically; changing materials or the camera does not invalidate shadow maps. This adds fragment calculations without additional rendering passes. Material diffuse includes `1/π`; its brightness differs from the original matte convention, so light intensity may need adjustment when adopting it.

The three-argument material overload requires a world-space `cameraPosition` on each `bindLighting()` call. Consumers already calculating the surface-to-viewer direction can use `lightSpriteShade(material, worldPosition, worldNormal, viewDirection)` and omit that binding option. These parameters control direct-light highlights; metallic workflows and environment/scene reflections are outside this MVP.

Consumers with their own BRDF can reuse the source without adopting the material model:

```glsl
LightSpriteLightSample source = lightSpriteSample(worldPosition, worldNormal);
// source.direction: unit direction toward the light (zero at its exact position)
// source.radiance: incoming RGB strength, including attenuation/range/flicker
// source.visibility: shadow visibility, or 1.0 when shadows are disabled
vec3 direct = myBRDF(...) * source.radiance * source.visibility
  * max(dot(normalize(worldNormal), source.direction), 0.0);
```

Radiance excludes the surface cosine, shadow visibility, and ambient, allowing each to be applied once. `lightSpriteDirection(worldPosition)`, `lightSpriteRadiance(worldPosition)`, and `lightSpriteShadowVisibility(worldPosition, worldNormal)` can also be used independently. Compile with `sprite.lightingGLSL` and call `bindLighting()` as usual; shadow-only shaders do not need to consume the light intensity uniform. For intentionally unoccluded custom shading, use `lightSpriteRadiance()` and pass `{ shadows: false }` when binding a shadow-enabled controller; unused shadow resources are not bound or rendered. Relinked programs still require `{ refresh: true }`.

## Shadows

Set `shadows: true` to enable library-managed point-light shadows using the registered models. Compile the consumer surface shader with `sprite.lightingGLSL`; it selects the matching shadow or non-shadow variant. The `lightSpriteShade()` call and existing `bindLighting()`/`render()` calls stay the same. Shadow-enabled controllers require the shadow uniforms unless the binding explicitly opts out with `{ shadows: false }`.

All registered models cast shadows by default; specify `castsShadow: false` for simplified collision proxies or other non-casters. Casters must supply opaque triangle geometry, not just bounds. Any surface using the shadow-enabled helper receives shadows, even if that receiver is not registered as a caster. The marker does not cast a shadow from its own light. Occlusion removes only the direct point-light contribution and retains ambient lighting.

The default map has six 512 × 512 floating-point depth faces. Optional `shadows: { resolution, bias, textureUnit }` overrides resolution, the minimum world-space bias, and the reserved texture unit. The shader also derives a slope tolerance from surface normals, distance, and map resolution to prevent grazing-angle self-shadowing. The far plane and default minimum bias are derived from registered geometry; a small marker-scale near plane preserves nearby occluders even when other casters are far away. Hard shadow edges may alias, and bias can slightly separate contact shadows; soft filtering and transparent/deformed geometry are outside the current MVP.

`bindLighting()` generates the map when enabled and reuses it while source position and model transforms remain unchanged. Camera orbit, color, and intensity changes do not invalidate it. `refreshBounds()` refreshes both bounds and shadow geometry after array/buffer changes or caster eligibility changes. Pass `{ shadows: false }` to `bindLighting()` to disable comparison and skip depth passes without rebuilding the shader. Zero direct-light intensity also skips depth passes. Re-enabling rebuilds for the current source position and geometry.

## Movement

Movement is off unless the consumer supplies a bounding area. The area may be a sphere or an axis-aligned cube/box; nonuniform cube dimensions allow the example's 16 × 5 × 16 m region:

```ts
const sprite = createLightSprite(gl, {
  position: [0, 2, 0],
  models: [...cylinderModels, { geometry: floorGeometry, castsShadow: false }],
  movement: {
    bounds: { shape: 'cube', center: [0, 2.5, 0], size: [16, 5, 16] },
    speed: 1, // relative pace: 0.5 is half as fast, 2 is twice as fast
    distance: 2,
    seed: 1,
    stopProbability: 0.25,
    speedVariation: 0.45,
  },
});

// Alternative area: { shape: 'sphere', center: [0, 2.5, 0], radius: 2.5 }
updateConsumerModelTransforms();
sprite.update(deltaSeconds);
sprite.bindLighting(surfaceProgram);
drawConsumerScene();
sprite.render({ viewProjection });

sprite.setMovement(false);        // pause, preserving configuration
sprite.setMovement(true);         // continue from the current position
sprite.setMovement({ speed: 2 }); // enable and merge: twice the default pace
```

The whole marker stays within the area. Built-in spheres use their actual radius; cubes and custom geometry use a sphere enclosing their local bounds, including any center offset. Obstacle clearance is at least **10% of that sphere's diameter beyond its surface**: 1 cm for the default 10 cm sphere. `movementSphere` exposes the current world center, radius, and clearance. Small scale-aware numerical padding protects these requirements after float32 rendering.

All registered models are obstacles by default. `obstacle: false` excludes a model from movement checks independently of `castsShadow`. Movement uses conservative world-axis-aligned bounds, with exact sphere-to-box distance rather than an unnecessarily inflated box. Register distinct walls/parts separately for hollow groups: a group-wide box also excludes its empty interior. No manual clearance coordinates are required.

Movement plans a random target and an additional target ahead. Each leg chooses a random pace and whether its destination is a stop or a pass-through waypoint. Lookahead allows the planner to account for the next direction, pace, and stop when choosing the current waypoint velocity. Time-parameterized quintic Bézier curves match position, velocity, and acceleration at joins. Stops reach zero velocity and acceleration; waypoints carry a nonzero velocity through the turn. A stop has no added dwell time.

The entire curved path is certified against obstacles and the virtual domain before use. Conservative control-hull bounds, swept-chord bounds, and bounded subdivision cover the continuous curve rather than just rendered samples. Uncertain curves are rejected. Before approaching a waypoint at nonzero velocity, the planner reserves a certified smooth braking path. If further planning cannot certify a continuation within its budget, the marker follows that reserve to an unscheduled stop and then resumes wandering. This fallback preserves clearance and was chosen instead of unbounded search. Closed pockets with room keep wandering.

`speed` is a **relative pace multiplier**, default `1`; it is not a minimum, maximum, or constant speed in metres per second. `0.5` plays the same seeded motion at half pace and `2` at twice the pace. Actual travel varies with leg pace, turn geometry, stops, and room to brake. `speedVariation` defaults to `0.45` and randomly lowers each leg's reference pace by up to 45%; `0` removes this random variation. `stopProbability` defaults to `0.25` and accepts `[0, 1]`; `0` requests pass-through destinations, `1` requests stops at every destination. Safety fallbacks can still stop when it is zero.

`distance: 2` bounds each curve's length conservatively, not just its endpoint separation; seed defaults to `1`. Curves take at least 0.5 reference animation seconds. Movement advances its reference clock by elapsed seconds times `speed`, capped at `maxDeltaSeconds: 0.25` per update (configurable above zero up to 1). Excess scaled time is discarded to bound catch-up work; unusually large multipliers or slow frames can therefore reach the cap instead of reproducing an exact pace ratio. Flicker still advances by the full unscaled elapsed time. Under ordinary deltas below the cap, seeded movement is deterministic across update cadence.

`isMoving` indicates when continuing frames are needed; use it together with `isFlickering`. `movement` exposes a detached configuration snapshot. Configuration/position changes and geometry refreshes validate before committing. Changing only `speed` retains the curve and phase; changing planning options can restart motion. Configured bounds/clearance remain enforced during manual positioning even while paused. Bounds require positive numerical room, and `distance` must exceed the area's computed float32 guard. Invalid or equality-only fits reject with a validation error; they are not treated as a failed random route or enclosure.

Clearance covers the registered static world snapshots used for planning. Changed matrices automatically update cached world bounds and recertify the remaining plan and braking reserve; geometry changes require `refreshBounds()`. Harmless changes preserve the current phase and kinematics. Changes that invalidate the certified continuation reject transactionally; an externally moved obstacle may leave no smooth safe continuation, even if the marker's current position is clear. Correct the obstacle or explicitly reposition with `setPosition()`. Manual positioning and configuration edits may restart motion; pause/resume preserves phase. Consumer transforms must be updated before the library's update and remain consistent through rendering.

Bounding areas are entirely virtual. They are never drawn, included as shadow casters, or used to clip light, glow, or shadow range. The light can still illuminate receivers outside the movement area, and registered outside-area geometry can cast shadows.

Shadow-enabled binding reserves the highest fragment texture unit by default (`MAX_TEXTURE_IMAGE_UNITS - 1`), or the configured `textureUnit`. It leaves the cubemap bound and clears any sampler object on that unit so the consumer shader can sample it. The previously active texture unit and program are restored; keep other material textures/samplers off the reserved unit. Internal shadow passes preserve the host framebuffer, viewport, bindings, clipping, and depth state and never clear the host scene.

## Marker and lighting options

`marker` accepts `'sphere'`, `'cube'`, or custom `Geometry`. `diameter` defaults to `0.1`; for a cube it is the side length. Custom triangle geometry uses its own dimensions and local origin without rescaling. Its normals are optional because the marker itself uses a luminous unlit surface. `createSphereGeometry()` and `createBoxGeometry()` also support consumer-owned drawing.

`light` accepts `color` (linear RGB in `[0, 1]`, default white), `intensity` (default `6`), and `range` (default `0`, unlimited). Use `setLight()` to change these base properties and `setPosition()` to change the position, then redraw. Zero intensity disables illumination while keeping the marker visible. `light` and `position` expose snapshots for consumer drawing; when flicker is enabled, `light.intensity` reports the effective intensity for the current frame. No internal animation loop is created.

`bindLighting()` caches locations and preserves the previously active program. If the consumer relinks the same program, pass `{ refresh: true }` once afterward to rebuild the locations.

## Glow and flicker


Both effects are optional and disabled by default. Set `glow: true` or `flicker: true` in the constructor for defaults, or supply options:

```ts
const sprite = createLightSprite(gl, {
  glow: { radius: 0.25, intensity: 0.6, falloff: 4 },
  flicker: { depth: 0.35, speed: 2, seed: 1 },
});

// Once per consumer frame, before binding lighting and drawing:
sprite.update(deltaSeconds);
sprite.bindLighting(surfaceProgram);
drawConsumerScene();
sprite.render({ viewProjection });

sprite.setGlow(false);
sprite.setGlow(true);       // reuse the previous numeric configuration
sprite.setFlicker(false);   // restore steady brightness immediately
sprite.setFlicker({ speed: 3 }); // enable and merge a partial configuration
```

Glow is a soft camera-facing halo centered on the marker's local origin. The default radius is 2.5 times the marker's widest extent (25 cm for the 10 cm sphere), intensity is `0.6`, and falloff is `4`. Radius uses world units; intensity sets additive strength, and larger falloff fades faster away from the center. Sixteen shrinking depth layers form a rounded volume behind the marker's center plane, rendered in one instanced draw. Nearby surfaces progressively occlude these layers rather than sharply cutting a single bright plane. Surfaces in front of the center plane retain full occlusion. This is a view-dependent approximation chosen to preserve occlusion, rather than a symmetric physical volume.

Halo pixels add light while testing existing scene depth, without writing depth or changing destination alpha; the opaque marker and its flicker brightness remain unchanged. No scene-depth texture or extra consumer calls are needed. Layer normalization is cached until falloff changes. Layering adds fragment work compared with a flat halo, with a fixed sixteen-layer budget and shrinking quads to limit overdraw. This renderer supports standard symmetric perspective and orthographic cameras; it does not take over host post-processing or perform full-scene bloom.

Flicker defaults to depth `0.35`, speed `2` smooth random keyframes per second, and unsigned 32-bit seed `1`. Depth is in `[0, 1]`: brightness varies smoothly between `1 - depth` and `1`, with no overshoot above the configured steady output. A seed makes the sequence repeatable. One multiplier drives point-light intensity, marker brightness, and glow together. Color, geometry, bounds, and shadow-map validity are unchanged.

The consumer owns time and scheduling. `update(deltaSeconds)` advances the clock explicitly; neither `bindLighting()` nor `render()` advances it. Read `isFlickering` to decide whether continuing animation frames are useful; disabled or zero-depth flicker requires no continuing frames. `brightness`, `glow`, and `flicker` expose current values/configuration snapshots for consumer rendering. Changing speed or nonzero depth preserves the noise phase; turning flicker back on, changing seed, or restoring nonzero depth restarts at full brightness. Context loss freezes clock advancement, and GPU restoration preserves phase. Hosts can pause updates while hidden or when honoring motion preferences.

Runtime setters accept booleans or partial option objects, validate atomically, and preserve previous numeric settings on boolean toggles. Turning flicker off restores base lighting and marker/glow brightness immediately. The source can remain visually present when its base illumination intensity is zero, consistent with the marker's existing behavior.

## Automatic bounds

Register geometry and transforms through `models` to avoid calculating numeric bounds. `getModelBounds()` rereads transforms but reuses local geometry bounds. Call `refreshBounds()` after changing vertex/index data; transforms alone do not require refresh. Movement compares matrix snapshots and transforms bounds only when changed. Bounds are conservative world-axis-aligned boxes used as movement obstacles.

`computeBounds()` supports array-like positions, optional indices, and draw subranges. Its `stride` and `offset` are measured in elements. `transformBounds()`, `unionBounds()`, and `boundsSphere()` provide common spatial operations.

For models already uploaded to WebGL 2:

```ts
const sprite = createLightSprite(gl, {
  models: [{
    geometry: { buffer: existingPositionBuffer }, // packed float32 XYZ default
    worldMatrix: () => existingWorldMatrix,
  }],
});
```

GPU geometry accepts `byteStride`, `byteOffset`, vertex `count`, and optional CPU-side indices. `computeBufferBounds()` performs the same readback independently. Readback is synchronous at registration/refresh and should not be repeated every frame. Consumers identify the buffer layout and transform; the library cannot infer them from arbitrary shaders. Registration can occur after upload or the first host render. GPU-only deformation and automatic draw discovery are not supported.

## Ownership and lifecycle

`render()` uses the current framebuffer and viewport, inherits scissor/stencil clipping, and never clears the scene. It restores the program, VAO, and depth/blend/cull/mask state it changes. The MVP uses conventional forward depth with `LEQUAL`; insert the marker into an ordinary scene pass before host post-processing, outside active transform-feedback operations. Specialized pipelines can draw the supplied geometry and light state themselves.

`dispose()` removes listeners and deletes library-owned resources, including shadow maps; repeated disposal is safe. It does not dispose consumer programs, model buffers, or arrays. Other controller methods reject use after disposal. On context loss, updates/drawing/binding pause; graphics resources rebuild from CPU snapshots while movement and flicker state are retained. The host must rebuild its own programs and models and use `sprite.lightingGLSL` for restored surface programs. Replace registered GPU buffer references and refresh bounds, or recreate the controller after restoring those host buffers. Creating a controller while its context is lost is rejected.

## Example and development

The raw WebGL host shows two 4 m tall, 1 m diameter cylinders with a 1 m surface gap, resting on `y = 0`: rough gray and glossy red finishes demonstrate material shading. The source intensity is adjusted for normalized diffuse lighting. A white 10 cm sphere starts between them at `y = 2` and wanders within a 16 × 5 × 16 m cube/box aligned to the floor. The floor is registered as an obstacle so its clearance also applies. Drag to orbit; keyboard arrows also work. **Movement**, **Marker light**, **Shadows**, **Glow**, and **Flicker** have independent toggles; **Effect settings** exposes relative movement pace, speed variation, stop chance, and visual effect controls. **Reset marker** returns to the starting point. Movement/glow start on, flicker starts off. The host draws continuously only while movement or flicker is active and pauses while hidden.

Use Node.js 20.19+ on the 20.x line, or Node.js 22.12+, and pnpm 12.7.0.

```sh
pnpm install
pnpm exec playwright install chromium # one-time browser setup
pnpm dev
pnpm typecheck
pnpm test                            # build once; unit, package, and browser suites
pnpm test:list                       # list all named cases without builds or test setup
pnpm test:unit                       # fast source-level checks
pnpm test:package                    # build and validate packed consumers and bundles
pnpm test:browser                    # build library/demo and run real WebGL browser cases
pnpm benchmark:movement              # optional CPU movement measurements
```

Alternatively, set `CHROME_PATH` to a Chrome/Chromium executable. All authored source, configuration, tests, support modules, and consumer fixtures use TypeScript. RSTest runs unit and package cases; Playwright runs isolated real WebGL cases and demo interactions, with traces and screenshots retained on failure. `pnpm typecheck` checks these files separately from execution. See [the test guide](https://github.com/phobetron/light-sprite/blob/main/tests/README.md) for suite boundaries, selection, and fixture ownership.

Library output and declarations are in `dist/`; the example builds into `demo-dist/`. `pnpm pack` rebuilds and packages the library. Package checks compile isolated consumers, load the packed ESM entry, verify declaration-map sources and package contents, and enforce the **20 KiB gzip (20,480 bytes)** consumer bundle budget. The default controller and full runtime API fixtures use production Rspack minification targeting ES2022 with no source maps and Node's gzip at level 9. Published TypeScript sources preserve editor navigation from declaration maps.
