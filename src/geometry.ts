import type { Geometry, Vec3 } from './types';

function dimension(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(Math.fround(value)) || Math.fround(value) === 0) {
    throw new RangeError(`${name} must be positive and representable in Float32`);
  }
}
export function createSphereGeometry(options: { radius?: number; widthSegments?: number; heightSegments?: number } = {}): Geometry {
  const { radius = 0.05, widthSegments = 32, heightSegments = 16 } = options;
  dimension(radius, 'radius');
  if (!Number.isSafeInteger(widthSegments) || widthSegments < 3 || !Number.isSafeInteger(heightSegments) || heightSegments < 2 || (widthSegments + 1) * (heightSegments + 1) > 1_000_000) {
    throw new RangeError('Sphere segments require width >= 3, height >= 2 and at most 1,000,000 vertices');
  }
  const count = (widthSegments + 1) * (heightSegments + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let y = 0; y <= heightSegments; y++) {
    const theta = y / heightSegments * Math.PI;
    for (let x = 0; x <= widthSegments; x++) {
      const phi = x / widthSegments * Math.PI * 2;
      const sin = y === 0 || y === heightSegments ? 0 : Math.sin(theta);
      const normal: Vec3 = [sin * Math.cos(phi), Math.cos(theta), sin * Math.sin(phi)];
      const offset = (y * (widthSegments + 1) + x) * 3;
      normals.set(normal, offset);
      positions.set(normal.map(value => value * radius), offset);
    }
  }
  const IndexArray = count > 65536 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(widthSegments * (heightSegments - 1) * 6);
  let cursor = 0;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * (widthSegments + 1) + x;
      const b = a + 1; const c = a + widthSegments + 1; const d = c + 1;
      if (y !== 0) { indices.set([a, b, c], cursor); cursor += 3; }
      if (y !== heightSegments - 1) { indices.set([b, d, c], cursor); cursor += 3; }
    }
  }
  return { positions, normals, indices };
}
export function createBoxGeometry(options: { width?: number; height?: number; depth?: number } = {}): Geometry {
  const { width = 0.1, height = 0.1, depth = 0.1 } = options;
  dimension(width, 'width'); dimension(height, 'height'); dimension(depth, 'depth');
  const half = [width / 2, height / 2, depth / 2];
  const positions: number[] = []; const normals: number[] = []; const indices: number[] = [];
  const faces: readonly [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [normal, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis++) positions.push((normal[axis] + su * u[axis] + sv * v[axis]) * half[axis]);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}
