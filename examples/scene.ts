import type { Geometry, Vec3, MovementBounds } from '../src/index';

export const CYLINDER_RADIUS = 0.5;
export const CYLINDER_HEIGHT = 4;
export const FLOOR_SIZE = 16;
export const MOVEMENT_BOUNDS: MovementBounds = { shape: 'cube', center: [0, (CYLINDER_HEIGHT + 1) / 2, 0], size: [FLOOR_SIZE, CYLINDER_HEIGHT + 1, FLOOR_SIZE] };
export const CYLINDER_CENTERS: readonly Vec3[] = [[-1, 0, 0], [1, 0, 0]];
export const MARKER_POSITION: Vec3 = [0, 2, 0];
export const MARKER_DIAMETER = 0.1;
export const AMBIENT = 0.03;
// Material-aware diffuse shading includes Lambert's 1/pi normalization.
export const LIGHT_INTENSITY = 6 * Math.PI;
export const CYLINDER_COLORS: readonly Vec3[] = [[0.48, 0.48, 0.48], [0.95, 0.018, 0.025]];

export function createCylinderGeometry(segments = 96): Geometry & { normals: Float32Array; indices: Uint16Array } {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    for (const y of [0, CYLINDER_HEIGHT]) {
      positions.push(x * CYLINDER_RADIUS, y, z * CYLINDER_RADIUS);
      normals.push(x, 0, z);
    }
    if (i < segments) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  }
  for (const top of [false, true]) {
    const center = positions.length / 3;
    const y = top ? CYLINDER_HEIGHT : 0;
    const normalY = top ? 1 : -1;
    positions.push(0, y, 0);
    normals.push(0, normalY, 0);
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      positions.push(Math.cos(angle) * CYLINDER_RADIUS, y, Math.sin(angle) * CYLINDER_RADIUS);
      normals.push(0, normalY, 0);
      if (i < segments) {
        const a = center + 1 + i;
        indices.push(center, top ? a + 1 : a, top ? a : a + 1);
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}

export function createFloorGeometry(): Geometry & { normals: Float32Array; indices: Uint16Array } {
  const half = FLOOR_SIZE / 2;
  return {
    positions: new Float32Array([-half, 0, -half, -half, 0, half, half, 0, half, half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}
