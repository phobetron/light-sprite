import { boundsSphere, computeBounds, transformBounds } from './bounds';
import { createBoxGeometry, createSphereGeometry } from './geometry';
import { assertMatrix, assertVec3, identityMatrix, translationMatrix } from './math';
import type { LightingOptions, PointLight, PointLightOptions, PointLightSnapshot } from './lighting';
import type { Bounds3, Geometry, Mat4, MutableVec3, PositionSource, Vec3 } from './types';
import { computeBufferBounds, createProgram, type BufferPositionSource } from './webgl';
import { createLightingGLSL } from './lighting';
import { createShadowMap, type ShadowOptions } from './shadows';
import { FlickerClock, resolveFlicker, resolveGlow, type GlowOptions, type FlickerOptions, type ResolvedGlow, type ResolvedFlicker } from './effects';
import { createGlowRenderer, type GlowRenderer } from './glow';
import { createMovement, type MovementController, type MovementOptions, type ResolvedMovement, type MovementSphere } from './movement';

export interface ModelSource {
  geometry: Geometry | PositionSource | BufferPositionSource;
  /** Column-major affine local-to-world matrix. Omitted for world-space vertices. */
  worldMatrix?: Mat4 | (() => Mat4);
  /** Exclude simplified bounds proxies or non-casting surfaces. Default: true. */
  castsShadow?: boolean;
  /** Include this model in movement clearance checks. Default: true. */
  obstacle?: boolean;
}

export interface LightSpriteOptions {
  /** World coordinates, in metres by convention. Default: [0, 0, 0]. */
  position?: Vec3;
  /** Built-in shape or borrowed triangle geometry. Default: sphere. */
  marker?: 'sphere' | 'cube' | Geometry;
  /** Built-in diameter / cube side, in world units. Default: 0.1. */
  diameter?: number;
  light?: PointLightOptions;
  /** Existing models; their local bounds are calculated automatically. */
  models?: readonly ModelSource[];
  /** Optional cached hard point-light shadows from registered triangle models. */
  shadows?: boolean | ShadowOptions;
  /** Optional soft world-space halo. Disabled by default. */
  glow?: boolean | GlowOptions;
  /** Optional seeded brightness variation. Disabled by default. */
  flicker?: boolean | FlickerOptions;
  /** Random safe wandering in a consumer-supplied virtual sphere or cube. */
  movement?: false | MovementOptions;
}

export interface LightSprite {
  readonly position: Vec3;
  readonly light: PointLight;
  /** Shared light, marker, and glow brightness multiplier. */
  readonly brightness: number;
  /** Whether the consumer should schedule continuing effect frames. */
  readonly isFlickering: boolean;
  readonly glow: Readonly<ResolvedGlow>;
  readonly flicker: Readonly<ResolvedFlicker>;
  readonly isMoving: boolean;
  readonly movement: Readonly<ResolvedMovement> | null;
  readonly movementSphere: MovementSphere;
  /** Include this shader source to match this controller's shadow configuration. */
  readonly lightingGLSL: string;
  setPosition(position: Vec3): void;
  setLight(options: PointLightOptions): void;
  setGlow(options: boolean | GlowOptions): void;
  setFlicker(options: boolean | FlickerOptions): void;
  setMovement(options: boolean | Partial<MovementOptions>): void;
  /** Advance movement and effects once before lighting and rendering a frame. */
  update(deltaSeconds: number): void;
  /** Draw into the current framebuffer and viewport, without clearing either. */
  render(camera: { viewProjection: Mat4 }): void;
  /** Bind the GLSL helper's uniforms, preserving the current program binding. */
  bindLighting(program: WebGLProgram, options?: LightingOptions): void;
  /** Read current model transforms using cached local geometry bounds. */
  getModelBounds(): readonly Bounds3[];
  getMarkerBounds(): Bounds3;
  /** Recalculate geometry bounds after consumer arrays or buffers change. */
  refreshBounds(): void;
  dispose(): void;
}

/** Controller whose vector getters return detached arrays suitable for WebGL. */
export interface LightSpriteSnapshot extends LightSprite {
  readonly position: MutableVec3;
  readonly light: PointLightSnapshot;
}

const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_viewProjection;
uniform vec3 u_position;
void main() { gl_Position = u_viewProjection * vec4(a_position + u_position, 1.0); }
`;
const fragmentSource = `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_brightness;
out vec4 outColor;
void main() { outColor = vec4(u_color * u_brightness, 1.0); }
`;

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value <= 0) throw new RangeError(`${name} must fit a finite float32 and be greater than zero.`);
}

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < 0) throw new RangeError(`${name} must fit a finite float32 and be nonnegative.`);
}

function assertPosition(value: Vec3): void {
  assertVec3(value, 'position');
  if (value.some((coordinate) => !Number.isFinite(Math.fround(coordinate)))) {
    throw new RangeError('Position coordinates must fit finite float32 values.');
  }
}

function colorValue(value: Vec3): Vec3 {
  assertVec3(value, 'color');
  if (value.some((channel) => channel < 0 || channel > 1)) throw new RangeError('Color components must be in [0, 1].');
  return [...value];
}

function modelBounds(gl: WebGL2RenderingContext, model: ModelSource): Bounds3 {
  return 'buffer' in model.geometry ? computeBufferBounds(gl, model.geometry) : computeBounds(model.geometry);
}

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  indexType?: number;
  viewProjection: WebGLUniformLocation | null;
  position: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  brightness: WebGLUniformLocation | null;
}

function createResources(gl: WebGL2RenderingContext, geometry: Geometry, center: Vec3): Resources {
  const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
  const previousArray = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const buffers: WebGLBuffer[] = [];
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  try {
    program = createProgram(gl, vertexSource, fragmentSource);
    vao = gl.createVertexArray();
    if (!vao) throw new Error('Unable to allocate marker vertex array.');
    gl.bindVertexArray(vao);
    const vertices = gl.createBuffer();
    if (!vertices) throw new Error('Unable to allocate marker vertex buffer.');
    buffers.push(vertices);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    // Keep custom vertices near their enclosing center. Adding a large local
    // offset to its opposite translation on the GPU can otherwise lose centimetres.
    const verticesNearCenter = center.some(value => value !== 0)
      ? Float32Array.from(geometry.positions, (value, index) => value - center[index % 3])
      : geometry.positions;
    gl.bufferData(gl.ARRAY_BUFFER, verticesNearCenter, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (geometry.indices) {
      const indices = gl.createBuffer();
      if (!indices) throw new Error('Unable to allocate marker index buffer.');
      buffers.push(indices);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    }
    return {
      program, vao, buffers,
      count: geometry.indices?.length ?? geometry.positions.length / 3,
      indexType: geometry.indices ? geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT : undefined,
      viewProjection: gl.getUniformLocation(program, 'u_viewProjection'),
      position: gl.getUniformLocation(program, 'u_position'),
      color: gl.getUniformLocation(program, 'u_color'),
      brightness: gl.getUniformLocation(program, 'u_brightness'),
    };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    if (vao) gl.deleteVertexArray(vao);
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    throw error;
  } finally {
    gl.bindVertexArray(previousVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArray);
  }
}

function deleteResources(gl: WebGL2RenderingContext, resources: Resources): void {
  gl.deleteProgram(resources.program);
  gl.deleteVertexArray(resources.vao);
  for (const buffer of resources.buffers) gl.deleteBuffer(buffer);
}

/** A static marker and point source; the consumer owns the scene and frame loop. */
export function createLightSprite(gl: WebGL2RenderingContext, options: LightSpriteOptions = {}): LightSpriteSnapshot {
  if (typeof gl.createVertexArray !== 'function') throw new TypeError('Light Sprite requires a WebGL 2 context.');
  if (gl.isContextLost()) throw new Error('Create Light Sprite after the WebGL context is available.');
  const diameter = options.diameter ?? 0.1;
  positive(diameter, 'diameter');
  const marker = options.marker ?? 'sphere';
  if (typeof marker === 'string' && marker !== 'sphere' && marker !== 'cube') {
    throw new TypeError('marker must be sphere, cube, or triangle geometry.');
  }
  const source = typeof marker === 'string'
    ? marker === 'sphere' ? createSphereGeometry({ radius: diameter / 2 }) : createBoxGeometry({ width: diameter, height: diameter, depth: diameter })
    : marker;
  // Keep a CPU snapshot for restoration; caller-owned arrays/resources stay borrowed.
  const geometry: Geometry = {
    positions: new Float32Array(source.positions),
    indices: source.indices ? source.indices.slice() : undefined,
  };
  const localBounds = computeBounds(geometry);
  const triangleCount = geometry.indices?.length ?? geometry.positions.length / 3;
  if (geometry.positions.length % 3 !== 0 || triangleCount % 3 !== 0) {
    throw new RangeError('Marker geometry must contain complete XYZ triangle vertices or triangle indices.');
  }
  const markerEnclosure = boundsSphere(localBounds);
  const radius = Math.max(markerEnclosure.radius, 0.000001);
  const defaultGlowRadius = Math.min(3.4028234663852886e38, Math.max(1e-6, 2.5 * Math.max(...localBounds.max.map((value, axis) => value - localBounds.min[axis]))));
  let glow = resolveGlow(options.glow, defaultGlowRadius);
  let flicker = resolveFlicker(options.flicker);
  const clock = new FlickerClock(flicker);
  let glowRenderer: GlowRenderer | null = null;
  let position: Vec3 = options.position ?? [0, 0, 0];
  assertPosition(position);
  position = [...position];
  let color = colorValue(options.light?.color ?? [1, 1, 1]);
  let intensity = options.light?.intensity ?? 6;
  let range = options.light?.range ?? 0;
  nonnegative(intensity, 'intensity');
  nonnegative(range, 'range');
  const models = [...(options.models ?? [])];
  let bounds = models.map((model) => modelBounds(gl, model));
  const movementEnclosure = marker === 'sphere'
    ? { center: [0, 0, 0] as Vec3, radius: Math.max(diameter / 2, 1e-6) }
    : { ...markerEnclosure, radius: Math.max(markerEnclosure.radius, 1e-6) };
  const defaultMatrix = identityMatrix();
  type ObstacleSnapshot = { boxes: (Bounds3 | undefined)[]; matrices: (number[] | undefined)[]; flags: boolean[]; combined: Bounds3[] };
  let obstacleSnapshot: ObstacleSnapshot = { boxes: [], matrices: [], flags: [], combined: [] };
  // Compare only the 16 matrix values in steady frames. Allocate/transform bounds
  // only after a change; movement never reads back GPU geometry during updates.
  const sampleObstacles = (local = bounds, force = false): ObstacleSnapshot => {
    let next = obstacleSnapshot;
    const writable = () => {
      if (next === obstacleSnapshot) next = {
        boxes: [...next.boxes], matrices: [...next.matrices], flags: [...next.flags], combined: next.combined,
      };
    };
    for (let index = 0; index < models.length; index++) {
      const model = models[index];
      const include = model.obstacle !== false;
      if (!include) {
        if (next.flags[index] !== false) { writable(); next.flags[index] = false; next.boxes[index] = undefined; next.matrices[index] = undefined; }
        continue;
      }
      const matrix = typeof model.worldMatrix === 'function' ? model.worldMatrix() : model.worldMatrix ?? defaultMatrix;
      const previous = next.matrices[index];
      let changed = force || !previous || matrix.length !== 16 || next.flags[index] !== true;
      if (!changed) for (let component = 0; component < 16; component++) {
        if (matrix[component] !== previous![component]) { changed = true; break; }
      }
      if (changed) {
        const box = transformBounds(local[index], matrix);
        const snapshot = Array.from(matrix);
        writable(); next.boxes[index] = box; next.matrices[index] = snapshot; next.flags[index] = true;
      }
    }
    if (next !== obstacleSnapshot) next.combined = next.boxes.filter((box): box is Bounds3 => box !== undefined);
    return next;
  };
  let movement: MovementController | null = null;
  if (options.movement) {
    const next = sampleObstacles();
    movement = createMovement(options.movement, movementEnclosure, position, next.combined);
    obstacleSnapshot = next;
  }
  const shadowOptions = typeof options.shadows === 'object' ? { ...options.shadows } : {};
  const shadowTexelSize = 1 / (shadowOptions.resolution ?? 512);
  const shadowMap = options.shadows ? createShadowMap(gl, models, shadowOptions, radius) : null;
  let resources: Resources | null;
  try {
    resources = createResources(gl, geometry, markerEnclosure.center);
  } catch (error) {
    shadowMap?.dispose();
    throw error;
  }
  let disposed = false;
  let uniformCache = new WeakMap<WebGLProgram, Record<string, WebGLUniformLocation | null>>();
  let restorationError: unknown;
  const assertLive = () => {
    if (disposed) throw new Error('Light Sprite has been disposed.');
    if (restorationError) throw new Error('Unable to restore marker resources.', { cause: restorationError });
  };
  const onLost = (event: Event) => {
    event.preventDefault();
    resources = null;
    glowRenderer?.dispose();
    glowRenderer = null;
    uniformCache = new WeakMap();
    shadowMap?.contextLost();
  };
  const onRestored = () => {
    try {
      resources = createResources(gl, geometry, markerEnclosure.center);
      shadowMap?.restore();
      restorationError = undefined;
    } catch (error) {
      restorationError = error;
    }
  };
  gl.canvas.addEventListener('webglcontextlost', onLost);
  gl.canvas.addEventListener('webglcontextrestored', onRestored);

  return {
    get position(): MutableVec3 { assertLive(); return [...position]; },
    get light(): PointLightSnapshot { assertLive(); return { position: [...position], color: [...color], intensity: intensity * clock.brightness, range }; },
    get brightness() { assertLive(); return clock.brightness; },
    get isFlickering() { assertLive(); return clock.active; },
    get glow() { assertLive(); return { ...glow }; },
    get flicker() { assertLive(); return { ...flicker }; },
    get isMoving() { assertLive(); return movement?.active ?? false; },
    get movement() { assertLive(); return movement?.options ?? null; },
    get movementSphere(): MovementSphere {
      assertLive();
      return { center: [position[0] + movementEnclosure.center[0], position[1] + movementEnclosure.center[1], position[2] + movementEnclosure.center[2]], radius: movementEnclosure.radius, clearance: movementEnclosure.radius * 0.2 };
    },
    lightingGLSL: createLightingGLSL(shadowMap !== null),
    setPosition(value) {
      assertLive();
      assertPosition(value);
      if (movement) {
        const next = sampleObstacles();
        const candidate = createMovement(movement.options, movementEnclosure, value, next.combined);
        if (!movement.active) candidate.setOptions(false);
        movement = candidate;
        obstacleSnapshot = next;
      }
      position = [...value];
    },
    setLight(value) {
      assertLive();
      const nextColor = value.color === undefined ? color : colorValue(value.color);
      const nextIntensity = value.intensity ?? intensity;
      const nextRange = value.range ?? range;
      nonnegative(nextIntensity, 'intensity');
      nonnegative(nextRange, 'range');
      color = nextColor;
      intensity = nextIntensity;
      range = nextRange;
    },
    setGlow(value) {
      assertLive();
      glow = resolveGlow(value, defaultGlowRadius, glow);
    },
    setFlicker(value) {
      assertLive();
      const next = resolveFlicker(value, flicker);
      clock.set(next);
      flicker = next;
    },
    setMovement(value) {
      assertLive();
      if (value === false) { movement?.setOptions(false); return; }
      if (value === true && !movement) throw new Error('Configure movement bounds before enabling movement.');
      const next = sampleObstacles();
      if (movement && value === true) {
        if (next !== obstacleSnapshot) movement.setObstacles(next.combined);
        movement.setOptions(true); obstacleSnapshot = next; return;
      }
      if (movement && next === obstacleSnapshot) { movement.setOptions(value); return; }
      const configuration = value === true ? movement!.options : { ...movement?.options, ...value };
      const candidate = createMovement(configuration as MovementOptions, movementEnclosure, position, next.combined);
      movement = candidate;
      obstacleSnapshot = next;
    },
    update(deltaSeconds) {
      assertLive();
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be finite and nonnegative.');
      if (gl.isContextLost()) return;
      if (clock.active && !Number.isFinite(deltaSeconds * flicker.speed)) throw new RangeError('deltaSeconds times flicker.speed must be finite.');
      if (movement?.active && deltaSeconds > 0) {
        const next = sampleObstacles();
        if (next !== obstacleSnapshot) { movement.setObstacles(next.combined); obstacleSnapshot = next; }
        movement.update(deltaSeconds);
        position = movement.position;
      }
      clock.update(deltaSeconds);
    },
    render({ viewProjection }) {
      assertLive();
      assertMatrix(viewProjection, 'viewProjection');
      if (Array.from(viewProjection).some((value) => !Number.isFinite(Math.fround(value)))) {
        throw new RangeError('viewProjection must fit finite float32 values.');
      }
      if (gl.isContextLost() || !resources) return;
      const current = resources;
      const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
      const previousDepthFunc = gl.getParameter(gl.DEPTH_FUNC) as number;
      const previousDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
      const previousColorMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
      const capabilities = [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD];
      const previousCapabilities = capabilities.map((capability) => gl.isEnabled(capability));
      try {
        gl.useProgram(current.program);
        gl.bindVertexArray(current.vao);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.colorMask(true, true, true, true);
        gl.uniformMatrix4fv(current.viewProjection, false, new Float32Array(Array.from(viewProjection)));
        gl.uniform3fv(current.position, [position[0] + markerEnclosure.center[0], position[1] + markerEnclosure.center[1], position[2] + markerEnclosure.center[2]]);
        // A visible luminous surface is independent of whether intensity is zero.
        gl.uniform3fv(current.color, color);
        gl.uniform1f(current.brightness, clock.brightness);
        if (current.indexType !== undefined) gl.drawElements(gl.TRIANGLES, current.count, current.indexType, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, current.count);
      } finally {
        gl.useProgram(previousProgram);
        gl.bindVertexArray(previousVao);
        gl.depthFunc(previousDepthFunc);
        gl.depthMask(previousDepthMask);
        gl.colorMask(...previousColorMask as [boolean, boolean, boolean, boolean]);
        capabilities.forEach((capability, index) => previousCapabilities[index] ? gl.enable(capability) : gl.disable(capability));
      }
      if (glow.enabled && glow.intensity > 0 && clock.brightness > 0) {
        glowRenderer ??= createGlowRenderer(gl);
        glowRenderer.render({ viewProjection, position, color, brightness: clock.brightness, options: glow });
      }
    },
    bindLighting(program, lighting = {}) {
      assertLive();
      const ambientValue = lighting.ambient ?? 0.03;
      const ambient: Vec3 = typeof ambientValue === 'number' ? [ambientValue, ambientValue, ambientValue] : ambientValue;
      assertVec3(ambient, 'ambient');
      ambient.forEach((channel) => nonnegative(channel, 'ambient'));
      if (lighting.cameraPosition !== undefined) {
        assertVec3(lighting.cameraPosition, 'cameraPosition');
        if (lighting.cameraPosition.some(value => !Number.isFinite(Math.fround(value)))) throw new RangeError('cameraPosition must fit finite float32 values.');
      }
      if (gl.isContextLost()) return;
      if (!gl.isProgram(program)) throw new TypeError('Lighting program must belong to the supplied WebGL context.');
      if (lighting.refresh) uniformCache.delete(program);
      let uniforms = uniformCache.get(program);
      if (!uniforms) {
        uniforms = Object.fromEntries(['Position', 'Color', 'Intensity', 'Range', 'Radius', 'Ambient', 'CameraPosition', 'ShadowMap', 'ShadowFar', 'ShadowBias', 'ShadowTexelSize', 'ShadowEnabled'].map((name) => [name, gl.getUniformLocation(program, `u_lightSprite${name}`)]));
        if (uniforms.Position === null) {
          throw new Error('Lighting program must use the supplied shading, sampling, or shadow-visibility helpers.');
        }
        uniformCache.set(program, uniforms);
      }
      if (shadowMap && uniforms.ShadowMap === null && lighting.shadows !== false) throw new Error('Shadow-enabled programs must use sprite.lightingGLSL and consume visibility, or bind with shadows: false.');
      if (!shadowMap && uniforms.ShadowMap !== null) throw new Error('A shadow shader requires a shadow-enabled Light Sprite controller.');
      if (uniforms.CameraPosition !== null && lighting.cameraPosition === undefined) throw new Error('This material shader requires cameraPosition in bindLighting(), or an explicit view direction in lightSpriteShade().');
      const shadowEnabled = lighting.shadows !== false && intensity * clock.brightness > 0;
      const shadow = uniforms.ShadowMap === null ? undefined : shadowMap?.update(position, shadowEnabled);
      const previous = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      try {
        gl.useProgram(program);
        gl.uniform3fv(uniforms.Position, position);
        gl.uniform3fv(uniforms.Color, color);
        gl.uniform1f(uniforms.Intensity, intensity * clock.brightness);
        gl.uniform1f(uniforms.Range, range);
        gl.uniform1f(uniforms.Radius, radius);
        gl.uniform3fv(uniforms.Ambient, ambient);
        if (lighting.cameraPosition !== undefined) gl.uniform3fv(uniforms.CameraPosition, lighting.cameraPosition);
        if (shadow) {
          const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
          try {
            gl.activeTexture(gl.TEXTURE0 + shadow.textureUnit);
            // This unit is reserved for shadows until the consumer finishes drawing.
            gl.bindTexture(gl.TEXTURE_CUBE_MAP, shadow.texture);
            gl.bindSampler(shadow.textureUnit, null);
          } finally {
            gl.activeTexture(activeTexture);
          }
          gl.uniform1i(uniforms.ShadowMap, shadow.textureUnit);
          gl.uniform1f(uniforms.ShadowFar, shadow.far);
          gl.uniform1f(uniforms.ShadowBias, shadow.bias);
          gl.uniform1f(uniforms.ShadowTexelSize, shadowTexelSize);
          gl.uniform1i(uniforms.ShadowEnabled, shadowEnabled ? 1 : 0);
        }
      } finally {
        gl.useProgram(previous);
      }
    },
    getModelBounds() {
      assertLive();
      return bounds.map((local, index) => {
        const sourceMatrix = models[index].worldMatrix;
        const matrix = typeof sourceMatrix === 'function' ? sourceMatrix() : sourceMatrix ?? identityMatrix();
        return transformBounds(local, matrix);
      });
    },
    getMarkerBounds() {
      assertLive();
      return transformBounds(localBounds, translationMatrix(position));
    },
    refreshBounds() {
      assertLive();
      const next = models.map((model) => modelBounds(gl, model));
      const obstacleCandidate = movement ? sampleObstacles(next, true) : null;
      if (movement && obstacleCandidate) movement.setObstacles(obstacleCandidate.combined, false);
      shadowMap?.refresh();
      bounds = next;
      if (movement && obstacleCandidate) { movement.setObstacles(obstacleCandidate.combined); obstacleSnapshot = obstacleCandidate; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gl.canvas.removeEventListener('webglcontextlost', onLost);
      gl.canvas.removeEventListener('webglcontextrestored', onRestored);
      if (resources) deleteResources(gl, resources);
      glowRenderer?.dispose();
      glowRenderer = null;
      shadowMap?.dispose();
      resources = null;
      uniformCache = new WeakMap();
    },
  };
}
