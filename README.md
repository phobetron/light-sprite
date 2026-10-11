# Light Sprite

Light markers and point-light shading for WebGL 2, with optional shadows, seeded movement, glow, and flicker. Light Sprite has no runtime dependencies and works with consumer-owned geometry, shaders, cameras, and frame loops.

The library draws the marker. To illuminate your models, include its lighting helpers in your surface shaders. Register model geometry when you need automatic bounds, movement obstacles, or shadow casters. One world unit represents one metre by convention.

## Install

```sh
pnpm add light-sprite
```

The package exposes ES module imports and includes TypeScript declarations. Use it from an ESM-capable frontend project. Drawing requires a browser with a WebGL 2 context; geometry, matrix, material-value, and CPU bounds helpers can also be used without a rendering context.

[Draw a marker](#draw-a-marker) · [Light your scene](#light-your-scene) · [API overview](#api-overview) · [Materials](#surface-materials) · [Shadows](#shadows) · [Movement](#movement) · [Effects](#glow-and-flicker) · [Bounds](#automatic-bounds) · [Lifecycle](#ownership-and-lifecycle)

## Draw a marker

Add a canvas to your page, then put the TypeScript below in the frontend module loaded by that page:

```html
<canvas id="scene" width="640" height="360"></canvas>
```

```ts
import {
  createLightSprite,
  lookAtMatrix,
  multiplyMatrices,
  perspectiveMatrix,
} from 'light-sprite';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('The scene canvas is missing.');
const gl = canvas.getContext('webgl2');
if (!gl) throw new Error('WebGL 2 is required.');

const sprite = createLightSprite(gl); // White sphere, 0.1 m in diameter.
const viewProjection = multiplyMatrices(
  perspectiveMatrix(Math.PI / 3, canvas.width / canvas.height, 0.01, 10),
  lookAtMatrix([0, 0, 0.5], [0, 0, 0]),
);

gl.viewport(0, 0, canvas.width, canvas.height);
gl.clearColor(0.025, 0.03, 0.045, 1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
sprite.render({ viewProjection });

// When the component or scene is removed:
// sprite.dispose();
```

You should see a white sphere in the centre of a dark canvas. This static example needs one draw. Redraw after changing the marker or camera; after resizing the canvas, update the viewport and projection too. Movement and flicker need explicit time updates, as shown below.

The [runnable demo](https://github.com/phobetron/light-sprite/tree/main/examples) includes model uploads, surface shaders, a camera, animation, controls, and context recovery. See [examples/main.ts](https://github.com/phobetron/light-sprite/blob/main/examples/main.ts) for the complete host integration, or [run it locally](#run-the-demo-and-develop).

## Light your scene

For an existing renderer, you supply the model buffers and VAOs, model transforms, camera matrices, and draw calls. Light Sprite supplies the shader helpers and light uniforms. A luminous marker alone does not illuminate shaders that omit those helpers.

This complete shader pair uses positions at attribute location `0` and normals at `1`. It can use the `gl` and `sprite` from the marker example:

```ts
import { createProgram } from 'light-sprite';

const surfaceProgram = createProgram(gl, `#version 300 es
precision highp float;
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
uniform mat4 modelMatrix;
uniform mat4 viewProjection;
uniform mat3 normalMatrix;
out vec3 worldPosition;
out vec3 worldNormal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  worldPosition = world.xyz;
  worldNormal = normalMatrix * normal;
  gl_Position = viewProjection * world;
}`, `#version 300 es
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
uniform vec3 baseColor;
out vec4 fragmentColor;
${sprite.lightingGLSL}
void main() {
  vec3 lit = lightSpriteShade(baseColor, worldPosition, worldNormal);
  fragmentColor = vec4(lightSpriteLinearToSRGB(lightSpriteToneMap(lit)), 1.0);
}`);
```

For each model, your draw code binds its VAO and uploads `modelMatrix`, `normalMatrix`, `viewProjection`, and linear RGB `baseColor`. Matrices are column-major; `viewProjection` is projection × view. The normal matrix is the inverse transpose of the model matrix's upper-left 3 × 3 portion, including for nonuniform scale. Normals passed to the lighting helpers must be in world space.

Use this order in your frame loop. Here `updateConsumerModelTransforms()` and `drawConsumerScene()` are your existing host functions; drawing includes the per-model uniforms and draw calls above:

```ts
function drawFrame(deltaSeconds: number) {
  updateConsumerModelTransforms();
  sprite.update(deltaSeconds); // Seconds, not the millisecond RAF timestamp.

  gl.useProgram(surfaceProgram);
  sprite.bindLighting(surfaceProgram, { ambient: 0.03 });
  drawConsumerScene();
  sprite.render({ viewProjection }); // After opaque models, on the same depth buffer.
}
```

The host clears its target at the start of the frame. The library never clears it or starts an animation loop. Convert successive `requestAnimationFrame` timestamps to seconds with `(now - previous) / 1000`. For an otherwise static scene, `sprite.isMoving || sprite.isFlickering` tells you whether the source needs continuing updates; camera, model, or option changes still require a redraw.

Lighting helpers return linear RGB. The example applies Reinhard tone mapping and sRGB output conversion; omit either if your renderer already performs that step. Light strength uses inverse-square attenuation with a near-source clamp and an optional smooth range cutoff. Use `sprite.lightingGLSL` so the shader matches the controller's shadow configuration; `LIGHT_SPRITE_GLSL` is also exported for non-shadow integrations.

## API overview

### Construction

`createLightSprite(gl, options?)` takes a WebGL 2 context and returns a controller.

| Option | Default | Purpose |
| --- | --- | --- |
| `position` | `[0, 0, 0]` | World-space marker origin and light position. |
| `marker` | `'sphere'` | `'sphere'`, `'cube'`, or custom triangle `Geometry`. |
| `diameter` | `0.1` | Sphere diameter or cube side length; custom geometry keeps its own size. |
| `light` | White, intensity `6`, range `0` | Linear RGB colour, nonnegative strength, and cutoff distance; range `0` is unlimited. |
| `models` | `[]` | Geometry and optional affine local-to-world matrices, supplied directly or by getters. Used for bounds, obstacles, and shadow casters. |
| `shadows` | `false` | `true` or [shadow options](#shadows). |
| `movement` | Disabled | [Movement options](#movement) with a required sphere or box domain. |
| `glow`, `flicker` | `false` | `true` or [effect options](#glow-and-flicker). |

Each model is `{ geometry, worldMatrix?, obstacle?, castsShadow? }`. `obstacle` and `castsShadow` both default to `true` and can be disabled independently. Custom marker geometry uses `Float32Array` positions and optional `Uint16Array`/`Uint32Array` triangle indices; marker normals are optional. Model geometry also accepts strided CPU position sources or [GPU position buffers](#automatic-bounds).

### Controller

| Method or property | Consumer contract |
| --- | --- |
| `update(deltaSeconds)` | Advance movement and flicker once per frame, before binding and drawing. |
| `render({ viewProjection })` | Draw the marker and optional glow into the current target and viewport. |
| `bindLighting(program, options?)` | Upload light uniforms and prepare shadows if needed; restore the previously active program. Options: `ambient`, `cameraPosition`, `shadows`, `refresh`. |
| `setPosition(vec3)`, `setLight(options)` | Change position or merge light properties. Configured movement bounds still constrain manual positioning. |
| `setMovement(optionsOrBoolean)` | Configure, pause, or resume movement. Enabling with `true` requires previously configured bounds. |
| `setGlow(optionsOrBoolean)`, `setFlicker(optionsOrBoolean)` | Merge effect settings or toggle them while retaining numeric settings. |
| `getModelBounds()`, `getMarkerBounds()` | Return world-space axis-aligned bounds. |
| `refreshBounds()` | Refresh registered geometry after array/buffer or caster-eligibility changes. |
| `position`, `light`, `brightness` | Detached pose/light snapshots and the current brightness multiplier. `light.intensity` includes flicker. |
| `movement`, `movementSphere`, `glow`, `flicker` | Configuration snapshots and the marker's world-space movement enclosure. `movement` is `null` until configured. |
| `isMoving`, `isFlickering` | Whether continuing updates are useful for each animation. |
| `lightingGLSL` | Fragment-shader helpers matching this controller. |
| `dispose()` | Release owned resources and listeners; safe to call repeatedly. |

Use setters to change the controller; editing returned snapshots does not change it. Invalid inputs throw. After disposal, other controller methods reject use.

## Surface materials

Materials belong to the consumer's surfaces, independently of geometry registered for movement or shadows. `createLightSpriteMaterial()` validates and copies CPU values without allocating GPU resources:

```ts
import { createLightSpriteMaterial } from 'light-sprite';

const material = createLightSpriteMaterial({
  baseColor: [0.95, 0.018, 0.025], // Linear RGB.
  roughness: 0.25,
  specularReflectance: 0.08,
});

// Select the material-enabled shader before uploading its uniforms.
gl.useProgram(surfaceProgram);
sprite.bindLighting(surfaceProgram, { cameraPosition: camera.position, ambient: 0.03 });
gl.uniform3fv(baseColorLocation, material.baseColor);
gl.uniform1f(roughnessLocation, material.roughness);
gl.uniform3fv(reflectanceLocation, material.specularReflectance);
drawObject();
```

To make the surface shader material-enabled, add `uniform float roughness;` and `uniform vec3 specularReflectance;` to the fragment shader above and replace its `lightSpriteShade(...)` call with:

```glsl
LightSpriteMaterial material = lightSpriteMaterial(baseColor, roughness, specularReflectance);
vec3 lit = lightSpriteShade(material, worldPosition, worldNormal);
```

The upload example assumes you have obtained the three uniform locations from that program and have a world-space `camera.position`. `bindLighting()` restores the previously active program, so it does not select a program for subsequent material uploads or draw calls.

`baseColor` defaults to white, `roughness` to `0.5`, and `specularReflectance` to `0.04`. All components must be finite and in `[0, 1]`. Reflectance accepts a scalar or RGB vector; `0.04` means 4% reflection at normal incidence. Lower roughness sharpens highlights; higher roughness spreads them. Very low roughness is clamped internally for numerical stability. `lightSpriteMaterial(baseColor)` provides the same GLSL defaults.

The material overload adds specular highlights and uses normalized diffuse shading, so its brightness differs from the original matte overload and adopting it may require adjusting light intensity. Shadows affect both direct components; ambient remains diffuse. Movement, range, light colour, and flicker apply to both components. Material and camera changes do not invalidate shadow maps. Metallic workflows and environment reflections are not provided.

The three-argument material overload requires `cameraPosition` on each `bindLighting()` call. If your shader already has a surface-to-viewer direction, call `lightSpriteShade(material, worldPosition, worldNormal, viewDirection)` and omit that binding option.

### Using your own shading

Include `sprite.lightingGLSL` and call `bindLighting()` as usual, then use the source with your own BRDF:

```glsl
LightSpriteLightSample source = lightSpriteSample(worldPosition, worldNormal);
vec3 direct = myBRDF(...) * source.radiance * source.visibility
  * max(dot(normalize(worldNormal), source.direction), 0.0);
```

`direction` points toward the light (zero at its exact position). `radiance` includes attenuation, range, colour, and flicker, but excludes the surface cosine, shadow visibility, and ambient. `visibility` is the shadow factor, or `1.0` with shadows disabled. The separate helpers `lightSpriteDirection()`, `lightSpriteRadiance()`, and `lightSpriteShadowVisibility()` are available too.

For intentionally unoccluded custom shading, use `lightSpriteRadiance()` and bind with `{ shadows: false }`. A radiance-only shader then skips unused shadow binding and depth passes. Shadow-only shaders can use visibility without consuming light intensity. After relinking any consumer program, pass `{ refresh: true }` once to rebuild cached uniform locations.

## Shadows

Enable shadows at construction with `shadows: true`, or supply `{ resolution, bias, textureUnit }`. Compile surface shaders with `sprite.lightingGLSL`. All registered models cast by default; use `castsShadow: false` for bounds proxies or other non-casters. Casters need opaque triangle geometry. Any surface using the shadow-enabled shader can receive shadows without being registered as a caster. The marker does not cast from its own light.

**Reserve the shadow texture unit in your renderer.** By default this is `MAX_TEXTURE_IMAGE_UNITS - 1`; `textureUnit` selects another available fragment unit. Binding leaves the cubemap bound and clears the sampler object on that unit. Keep consumer material textures and samplers off it. The previously active texture unit and program are restored.

The default map has six 512 × 512 float32 depth faces (6 MiB of depth data). `resolution` changes the per-face size; `bias` sets the minimum world-space tolerance. Hard edges can alias and bias can separate contact shadows slightly. Transparent/deformed casters and soft shadows are unsupported.

`bindLighting()` regenerates the six faces after light-position or caster-transform changes, then reuses them while unchanged. Camera, colour, intensity, and material changes do not invalidate the map. Call `refreshBounds()` after modifying geometry or `castsShadow`. Moving lights therefore have a higher rendering cost than static ones.

Pass `{ shadows: false }` to `bindLighting()` to disable comparison and skip depth passes for that draw. Zero direct-light intensity also skips depth passes. Re-enabling uses the current light and geometry. A shadow-enabled controller whose shader omits shadow visibility requires the explicit `{ shadows: false }` opt-out. Shadow passes preserve the host framebuffer, viewport, clipping, and depth state; they never clear the host scene.

## Movement

Supply bounds to enable movement. The domain is either a sphere or an axis-aligned cube/box; `size` can give a cube side length or separate dimensions:

```ts
const sprite = createLightSprite(gl, {
  position: [0, 2, 0],
  models: [...cylinderModels, { geometry: floorGeometry, castsShadow: false }],
  movement: {
    bounds: { shape: 'cube', center: [0, 2.5, 0], size: [16, 5, 16] },
    speed: 1,
    distance: 2,
    seed: 1,
    stopProbability: 0.25,
    speedVariation: 0.45,
  },
});

// Alternative domain: { shape: 'sphere', center: [0, 2.5, 0], radius: 2.5 }
sprite.setMovement(false);        // Pause without losing configuration or phase.
sprite.setMovement(true);         // Resume configured movement.
sprite.setMovement({ speed: 2 }); // Enable and merge: twice the reference pace.
```

Here `cylinderModels` and `floorGeometry` are your scene data. Registered models are obstacles unless `obstacle: false`; `castsShadow` is independent. Call `update(deltaSeconds)` in the frame order above. If movement was omitted at construction, configure it with `setMovement({ bounds, ... })` before enabling it with a boolean.

| Option | Default | Meaning |
| --- | --- | --- |
| `speed` | `1` | Positive relative pace multiplier: `0.5` is half pace, `2` is twice the pace. Not a speed in metres per second. |
| `distance` | `2` | Conservative maximum length of each curved leg, not just endpoint separation. |
| `seed` | `1` | Unsigned 32-bit seed for repeatable motion. |
| `stopProbability` | `0.25` | Probability of a planned stop, in `[0, 1]`; stops have no extra dwell time. |
| `speedVariation` | `0.45` | Randomly lowers each leg's reference pace by up to this fraction; `0` removes this variation. |
| `maxDeltaSeconds` | `0.25` | Maximum scaled movement time accepted per update; greater than zero and at most `1`. |

The complete marker stays inside the domain. Spheres use their radius; cubes and custom geometry use an enclosing sphere, including any local centre offset. Obstacle clearance adds at least **10% of the enclosure's diameter** beyond its surface: 1 cm for the default 10 cm sphere. `movementSphere` exposes its current centre, radius, and clearance.

Collision checks use conservative world-axis-aligned model bounds. Register hollow structures as separate walls or parts; one box around a hollow group also excludes its empty interior. The entire planned curve is checked, including between rendered frames. Movement makes smooth turns and stops; when a safe continuation cannot be found within the planning budget, it brakes to a stop and tries again. That safety stop can occur even with `stopProbability: 0`.

Movement advances by elapsed seconds × `speed`, capped by `maxDeltaSeconds`; excess scaled time is discarded. Flicker uses the full unscaled elapsed time. Under ordinary deltas below the cap, the same seed and inputs produce deterministic movement across update cadences. Very large pace multipliers or slow frames can hit the cap instead of giving an exact pace ratio.

Position and configuration changes validate before committing. Manual positioning must respect the configured domain and clearance even while paused. Changing only `speed` preserves phase; changing planning options or calling `setPosition()` can restart motion. Bounds must leave positive room, and extremely small or unrepresentable distances are rejected.

Update model transforms before the sprite and keep them consistent through rendering. Transform changes are detected automatically; geometry changes require `refreshBounds()`. An obstacle change that blocks the remaining safe path can make `update()` or a setter throw even if the current position is clear. Correct the obstacle or reposition the marker; the controller does not weaken clearance to continue.

The domain is virtual: it is not drawn and does not clip glow, lighting, or shadow range. Geometry and receivers outside it still participate in lighting and shadows.

## Glow and flicker

Both effects default to disabled. Use `true` for defaults or an options object:

```ts
const sprite = createLightSprite(gl, {
  glow: { radius: 0.25, intensity: 0.6, falloff: 4 },
  flicker: { depth: 0.35, speed: 2, seed: 1 },
});

// In the host's frame loop, before binding lighting and drawing:
sprite.update(deltaSeconds);

sprite.setGlow(false);
sprite.setGlow(true);             // Reuse previous numeric settings.
sprite.setFlicker(false);         // Restore steady brightness immediately.
sprite.setFlicker({ speed: 3 });  // Enable and merge the partial configuration.
```

Glow is a camera-facing halo centred on the marker's local origin. `radius` defaults to 2.5 times the marker's widest extent (25 cm for the default sphere), `intensity` to `0.6`, and `falloff` to `4`. Larger falloff fades faster. Radius and falloff must be positive; intensity can be zero.

The halo respects existing depth, adds light without changing destination alpha, and does not write depth. Its sixteen rear depth layers soften intersections with nearby surfaces while retaining foreground occlusion, in one additional instanced draw. This is a view-dependent approximation, not full-scene bloom. Standard symmetric perspective and orthographic cameras are supported. Large screen-space halos add fragment work.

Flicker smoothly varies brightness between `1 - depth` and `1`, without exceeding the steady output. Defaults are depth `0.35` (allowed `[0, 1]`), speed `2` smooth random keyframes per second, and unsigned 32-bit seed `1`. One multiplier controls the light, marker, and glow together. Colour, bounds, and shadow-map validity are unchanged.

Use `isFlickering` with `isMoving` for scheduling. Disabled or zero-depth flicker needs no continuing frames. Changing speed or nonzero depth preserves phase; enabling flicker again, changing its seed, or restoring nonzero depth restarts at full brightness. Context loss freezes the clock; restoration preserves its phase. Hosts can pause updates while hidden or when honouring motion preferences.

Effect setters validate atomically. Boolean toggles preserve previous numeric settings; option objects enable the effect and merge settings. Zero light intensity stops surface illumination while leaving the marker visible; flicker still controls its brightness.

## Automatic bounds

Register geometry and optional affine local-to-world transforms through `models`. CPU geometry can be `{ positions, indices? }`; `PositionSource` also supports `stride`, `offset`, `start`, and `count`. `stride` and `offset` are measured in array elements. `start`/`count` select draw items: indices when indexed, vertices otherwise. Omit a model matrix only when its positions are already world-space.

`getModelBounds()` rereads transforms using cached local geometry bounds. Call `refreshBounds()` after changing vertex/index arrays, replacing GPU buffers, or changing caster eligibility. Transform changes alone do not require refresh. `computeBounds()`, `transformBounds()`, `unionBounds()`, and `boundsSphere()` are also available independently.

For model positions already uploaded to WebGL 2:

```ts
const sprite = createLightSprite(gl, {
  models: [{
    geometry: { buffer: existingPositionBuffer }, // Packed float32 XYZ by default.
    worldMatrix: () => existingWorldMatrix,
  }],
});
```

GPU geometry accepts `byteStride`, `byteOffset`, a vertex `count`, and optional CPU-side indices. `computeBufferBounds()` performs the readback independently. Readback is synchronous at registration/refresh; avoid refreshing every frame. You identify the buffer layout and transform. GPU-only deformation and automatic discovery of arbitrary renderer draw calls are unsupported.

## Ownership and lifecycle

`render()` uses the current framebuffer and viewport, inherits scissor/stencil clipping, and restores the program, VAO, and depth/blend/cull/mask state it changes. It uses conventional forward depth with `LEQUAL`. Draw the marker after opaque surfaces and before host post-processing, outside active transform feedback. The [reserved shadow texture unit](#shadows) is the binding exception to account for in your renderer.

Call `sprite.dispose()` when removing the source. It removes listeners and releases owned GPU resources, including shadow maps. It does not delete consumer programs, model buffers, or arrays. Repeated disposal is safe; other controller methods reject use afterward. The host is responsible for stopping its own frame callbacks and disposing its own geometry/programs.

On context loss, updates, rendering, and lighting binding pause. The controller rebuilds its GPU resources from CPU snapshots after restoration and retains movement/flicker state. The host must rebuild its own surface programs and model resources. Use the controller's `lightingGLSL` for new programs; replace registered GPU buffer references and call `refreshBounds()`, or recreate the controller. Creating a controller while its context is lost is rejected.

## Run the demo and develop

From a checkout of this repository, use Node.js 20.19+ on the 20.x line or Node.js 22.12+, and pnpm 12.7.0:

```sh
pnpm install
pnpm dev
```

Open the URL printed by the dev server. The demo shows lit cylinders, a moving marker, orbit controls, and independent movement, lighting, shadow, glow, and flicker controls. You do not need to install browser-test tooling just to run it.

```sh
pnpm exec playwright install chromium # One-time setup for browser tests.
pnpm typecheck
pnpm test                            # Build once; unit, package, and browser suites.
pnpm test:list                       # List named cases without builds or test setup.
pnpm benchmark:movement              # Optional CPU movement measurements.
```

Use `CHROME_PATH` to select an existing Chrome/Chromium executable for tests. See the [test guide](https://github.com/phobetron/light-sprite/blob/main/tests/README.md) for focused commands and fixture ownership. Authored source, configuration, tests, and fixtures are TypeScript.

`pnpm build` writes the ESM library and declarations to `dist/`; the demo builds to `demo-dist/`. `pnpm pack` builds and packages the library. Package tests verify packed imports, isolated consumer types, declaration-map sources, and package contents. The working delivery limit is **20 KiB gzip (20,480 bytes)** per default-controller and full-runtime-API consumer bundle, enforced by production Rspack builds targeting ES2022 with gzip at level 9. Published TypeScript sources support editor navigation from declaration maps.
