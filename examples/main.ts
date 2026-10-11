import {
  createLightSprite, createLightSpriteMaterial, createProgram, identityMatrix,
  lookAtMatrix, multiplyMatrices, perspectiveMatrix, translationMatrix,
} from '../src/index';
import type { Geometry, Mat4, Vec3, LightSpriteMaterial } from '../src/index';
import { CAMERA_TARGET, OrbitCamera } from './orbitCamera';
import {
  AMBIENT, LIGHT_INTENSITY, createCylinderGeometry, createFloorGeometry, CYLINDER_CENTERS,
  CYLINDER_COLORS, MARKER_DIAMETER, MARKER_POSITION, MOVEMENT_BOUNDS,
} from './scene';
import './styles.css';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const lightToggle = document.querySelector<HTMLInputElement>('#marker-light')!;
const shadowToggle = document.querySelector<HTMLInputElement>('#shadows')!;
const glowToggle = document.querySelector<HTMLInputElement>('#glow')!;
const flickerToggle = document.querySelector<HTMLInputElement>('#flicker')!;
const movementToggle = document.querySelector<HTMLInputElement>('#movement')!;
const movementSpeed = document.querySelector<HTMLInputElement>('#movement-speed')!;
const movementVariation = document.querySelector<HTMLInputElement>('#movement-variation')!;
const movementStops = document.querySelector<HTMLInputElement>('#movement-stops')!;
const movementInputs = [movementSpeed, movementVariation, movementStops];
const resetMarkerButton = document.querySelector<HTMLButtonElement>('#reset-marker')!;
const glowRadius = document.querySelector<HTMLInputElement>('#glow-radius')!;
const glowIntensity = document.querySelector<HTMLInputElement>('#glow-intensity')!;
const flickerDepth = document.querySelector<HTMLInputElement>('#flicker-depth')!;
const flickerSpeed = document.querySelector<HTMLInputElement>('#flicker-speed')!;
const effectInputs = [glowRadius, glowIntensity, flickerDepth, flickerSpeed];
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const camera = new OrbitCamera();
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });

const vertexSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
uniform mat4 world;
uniform mat4 viewProjection;
out vec3 worldPosition;
out vec3 worldNormal;
void main() {
  vec4 p = world * vec4(position, 1.0);
  worldPosition = p.xyz;
  worldNormal = mat3(world) * normal;
  gl_Position = viewProjection * p;
}`;
const fragmentSource = (lightingGLSL: string) => `#version 300 es
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
uniform vec3 baseColor;
uniform float roughness;
uniform vec3 specularReflectance;
out vec4 fragmentColor;
${lightingGLSL}
void main() {
  LightSpriteMaterial material = lightSpriteMaterial(baseColor, roughness, specularReflectance);
  vec3 lit = lightSpriteShade(material, worldPosition, normalize(worldNormal));
  fragmentColor = vec4(lightSpriteLinearToSRGB(lightSpriteToneMap(lit)), 1.0);
}`;

interface Mesh { vao: WebGLVertexArrayObject; count: number; }
interface Renderer {
  draw(viewProjection: Mat4, deltaSeconds: number): void;
  configureEffects(): void;
  configureMovement(): void;
  resetMarker(): void;
  readonly animated: boolean;
  dispose(): void;
}

function syncEffectLabels(): void {
  document.querySelector<HTMLOutputElement>('#glow-radius-value')!.value = `${glowRadius.value} cm`;
  document.querySelector<HTMLOutputElement>('#glow-intensity-value')!.value = Number(glowIntensity.value).toFixed(1);
  document.querySelector<HTMLOutputElement>('#flicker-depth-value')!.value = `${flickerDepth.value}%`;
  document.querySelector<HTMLOutputElement>('#flicker-speed-value')!.value = `${flickerSpeed.value}/s`;
  glowRadius.disabled = glowIntensity.disabled = !glowToggle.checked;
  flickerDepth.disabled = flickerSpeed.disabled = !flickerToggle.checked;
  document.querySelector<HTMLOutputElement>('#movement-speed-value')!.value = `${Number(movementSpeed.value).toFixed(2)}×`;
  document.querySelector<HTMLOutputElement>('#movement-variation-value')!.value = `${movementVariation.value}%`;
  document.querySelector<HTMLOutputElement>('#movement-stops-value')!.value = `${movementStops.value}%`;
  movementInputs.forEach(input => { input.disabled = !movementToggle.checked; });
}

function disableControls(disabled: boolean): void {
  for (const control of [lightToggle, shadowToggle, glowToggle, flickerToggle, movementToggle, resetButton, resetMarkerButton]) control.disabled = disabled;
  if (disabled) [...effectInputs, ...movementInputs].forEach(input => { input.disabled = true; });
  else syncEffectLabels();
}

function createRenderer(context: WebGL2RenderingContext): Renderer {
  const buffers: WebGLBuffer[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  let program: WebGLProgram | undefined;
  let sprite: ReturnType<typeof createLightSprite> | undefined;
  const dispose = () => {
    sprite?.dispose();
    buffers.forEach(buffer => context.deleteBuffer(buffer));
    vaos.forEach(vao => context.deleteVertexArray(vao));
    if (program) context.deleteProgram(program);
  };
  try {
    const upload = (geometry: Geometry & { normals: Float32Array; indices: Uint16Array }): Mesh => {
      const vao = context.createVertexArray();
      if (!vao) throw new Error('Could not create scene geometry.');
      vaos.push(vao);
      context.bindVertexArray(vao);
      for (const [location, data] of [[0, geometry.positions], [1, geometry.normals]] as const) {
        const buffer = context.createBuffer();
        if (!buffer) throw new Error('Could not create scene buffers.');
        buffers.push(buffer);
        context.bindBuffer(context.ARRAY_BUFFER, buffer);
        context.bufferData(context.ARRAY_BUFFER, data, context.STATIC_DRAW);
        context.enableVertexAttribArray(location);
        context.vertexAttribPointer(location, 3, context.FLOAT, false, 0, 0);
      }
      const indexBuffer = context.createBuffer();
      if (!indexBuffer) throw new Error('Could not create scene indices.');
      buffers.push(indexBuffer);
      context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
      context.bufferData(context.ELEMENT_ARRAY_BUFFER, geometry.indices, context.STATIC_DRAW);
      context.bindVertexArray(null);
      return { vao, count: geometry.indices.length };
    };
    const cylinderGeometry = createCylinderGeometry();
    const floorGeometry = createFloorGeometry();
    const cylinder = upload(cylinderGeometry);
    const floor = upload(floorGeometry);
    const worlds = CYLINDER_CENTERS.map(center => translationMatrix(center));
    sprite = createLightSprite(context, {
      position: MARKER_POSITION, diameter: MARKER_DIAMETER, marker: 'sphere',
      light: { intensity: LIGHT_INTENSITY, range: 8, color: [1, 1, 1] },
      shadows: true,
      movement: { bounds: MOVEMENT_BOUNDS },
      models: [...worlds.map(worldMatrix => ({ geometry: cylinderGeometry, worldMatrix })), { geometry: floorGeometry, castsShadow: false }],
    });
    const lightSprite = sprite;
    const configureEffects = () => {
      lightSprite.setGlow(glowToggle.checked ? { radius: Number(glowRadius.value) / 100, intensity: Number(glowIntensity.value) } : false);
      lightSprite.setFlicker(flickerToggle.checked ? { depth: Number(flickerDepth.value) / 100, speed: Number(flickerSpeed.value) } : false);
      syncEffectLabels();
    };
    configureEffects();
    const configureMovement = () => {
      const configuration = {
        speed: Number(movementSpeed.value),
        speedVariation: Number(movementVariation.value) / 100,
        stopProbability: Number(movementStops.value) / 100,
      };
      const current = lightSprite.movement;
      const samePlanOptions = current?.speedVariation === configuration.speedVariation && current.stopProbability === configuration.stopProbability;
      lightSprite.setMovement(movementToggle.checked
        ? samePlanOptions ? { speed: configuration.speed } : configuration
        : false);
      syncEffectLabels();
    };
    configureMovement();
    const surfaceProgram = createProgram(context, vertexSource, fragmentSource(lightSprite.lightingGLSL));
    program = surfaceProgram;
    const worldLocation = context.getUniformLocation(surfaceProgram, 'world');
    const viewProjectionLocation = context.getUniformLocation(surfaceProgram, 'viewProjection');
    const colorLocation = context.getUniformLocation(surfaceProgram, 'baseColor');
    const roughnessLocation = context.getUniformLocation(surfaceProgram, 'roughness');
    const reflectanceLocation = context.getUniformLocation(surfaceProgram, 'specularReflectance');
    const floorMaterial = createLightSpriteMaterial({ baseColor: [0.23, 0.27, 0.33], roughness: 0.85 });
    const cylinderMaterials = CYLINDER_COLORS.map((baseColor, index) => createLightSpriteMaterial({ baseColor, roughness: index === 0 ? 0.75 : 0.25, specularReflectance: index === 0 ? 0.04 : 0.08 }));
    const drawMesh = (mesh: Mesh, world: Mat4, material: LightSpriteMaterial) => {
      context.uniformMatrix4fv(worldLocation, false, new Float32Array(world));
      context.uniform3fv(colorLocation, material.baseColor);
      context.uniform1f(roughnessLocation, material.roughness);
      context.uniform3fv(reflectanceLocation, material.specularReflectance);
      context.bindVertexArray(mesh.vao);
      context.drawElements(context.TRIANGLES, mesh.count, context.UNSIGNED_SHORT, 0);
    };
    return {
      dispose,
      configureEffects,
      configureMovement,
      resetMarker() { lightSprite.setPosition(MARKER_POSITION); },
      get animated() { return lightSprite.isFlickering || lightSprite.isMoving; },
      draw(viewProjection, deltaSeconds) {
        lightSprite.update(deltaSeconds);
        context.viewport(0, 0, canvas.width, canvas.height);
        context.enable(context.DEPTH_TEST);
        context.depthFunc(context.LESS);
        context.depthMask(true);
        context.disable(context.BLEND);
        context.disable(context.CULL_FACE);
        context.clearColor(0.028, 0.037, 0.055, 1);
        context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
        context.useProgram(surfaceProgram);
        lightSprite.setLight({ intensity: lightToggle.checked ? LIGHT_INTENSITY : 0 });
        lightSprite.bindLighting(surfaceProgram, { ambient: AMBIENT, shadows: shadowToggle.checked, cameraPosition: camera.eye });
        context.uniformMatrix4fv(viewProjectionLocation, false, new Float32Array(viewProjection));
        drawMesh(floor, identityMatrix(), floorMaterial);
        worlds.forEach((world, index) => drawMesh(cylinder, world, cylinderMaterials[index]));
        context.bindVertexArray(null);
        lightSprite.render({ viewProjection });
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

if (!gl) {
  status.textContent = 'This scene needs WebGL2. Try a browser with hardware acceleration enabled.';
  disableControls(true);
} else {
  const context = gl;
  let renderer: Renderer | undefined;
  let frame = 0;
  let suspended = false;
  let lastTime: number | undefined;
  let pointer: { id: number; x: number; y: number } | undefined;

  const redraw = () => {
    if (frame || suspended || document.hidden || !renderer || context.isContextLost()) return;
    frame = requestAnimationFrame(timestamp => {
      frame = 0;
      if (suspended || document.hidden || !renderer || context.isContextLost()) { lastTime = undefined; return; }
      const deltaSeconds = lastTime === undefined ? 0 : Math.max(0, (timestamp - lastTime) / 1000);
      lastTime = renderer.animated ? timestamp : undefined;
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const projection = perspectiveMatrix(Math.PI / 4, width / height, 0.1, 100);
      renderer.draw(multiplyMatrices(projection, lookAtMatrix(camera.eye, CAMERA_TARGET)), deltaSeconds);
      if (renderer.animated) redraw();
    });
  };
  const boot = () => {
    if (suspended || context.isContextLost() || renderer) return;
    try {
      renderer = createRenderer(context);
      status.textContent = '';
      disableControls(false);
      redraw();
    } catch (error) {
      console.error(error);
      status.textContent = 'The scene could not start. Reload the page to try again.';
      disableControls(true);
    }
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = undefined;
    renderer?.dispose();
    renderer = undefined;
    const capturedPointer = pointer?.id;
    pointer = undefined;
    if (capturedPointer !== undefined && canvas.hasPointerCapture(capturedPointer)) {
      canvas.releasePointerCapture(capturedPointer);
    }
  };
  const endPointer = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerdown', event => {
    if (pointer || !event.isPrimary || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointermove', event => {
    if (pointer?.id !== event.pointerId) return;
    camera.orbit(event.clientX - pointer.x, event.clientY - pointer.y);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    redraw();
  });
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  canvas.addEventListener('keydown', event => {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    camera.orbit(...delta);
    redraw();
  });
  resetButton.addEventListener('click', () => { camera.reset(); redraw(); });
  lightToggle.addEventListener('change', redraw);
  shadowToggle.addEventListener('change', redraw);
  const applyEffects = () => {
    renderer?.configureEffects();
    if (!renderer?.animated) lastTime = undefined;
    redraw();
  };
  glowToggle.addEventListener('change', applyEffects);
  flickerToggle.addEventListener('change', applyEffects);
  effectInputs.forEach(input => input.addEventListener('input', applyEffects));
  const applyMovement = () => {
    renderer?.configureMovement();
    if (!renderer?.animated) lastTime = undefined;
    redraw();
  };
  movementToggle.addEventListener('change', applyMovement);
  movementInputs.forEach(input => input.addEventListener('input', applyMovement));
  resetMarkerButton.addEventListener('click', () => { renderer?.resetMarker(); lastTime = undefined; redraw(); });
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = undefined;
    if (!document.hidden) redraw();
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    stop();
    status.textContent = 'The scene is paused while the graphics connection recovers.';
  });
  canvas.addEventListener('webglcontextrestored', boot);
  const observer = new ResizeObserver(redraw);
  observer.observe(canvas);
  window.addEventListener('resize', redraw);
  window.addEventListener('pagehide', () => { suspended = true; stop(); observer.disconnect(); });
  window.addEventListener('pageshow', () => { suspended = false; observer.observe(canvas); boot(); });
  boot();
}
