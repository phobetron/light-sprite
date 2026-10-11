import { assertMatrix, assertVec3 } from './math';
import type { Bounds3, Mat4, PositionSource, Vec3 } from './types';

function assertBounds(bounds: Bounds3): void {
  if (!bounds) throw new RangeError('Bounds are required');
  assertVec3(bounds.min, 'bounds.min'); assertVec3(bounds.max, 'bounds.max');
  if (bounds.min.some((v, i) => v > bounds.max[i])) throw new RangeError('Bounds min must not exceed max');
}
function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`);
}
export function computeBounds(source: PositionSource): Bounds3 {
  const { positions, indices, stride = 3, offset = 0, start = 0 } = source;
  integer(positions.length, 'positions.length'); integer(stride, 'stride', 3); integer(offset, 'offset'); integer(start, 'start');
  const vertices = Math.max(0, Math.floor((positions.length - offset - 3) / stride) + 1);
  if (indices) integer(indices.length, 'indices.length');
  const available = indices ? indices.length : vertices;
  const count = source.count ?? available - start;
  integer(count, 'count', 1);
  if (start > available || count > available - start) throw new RangeError('Draw range exceeds available items');
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let item = start; item < start + count; item++) {
    const vertex = indices ? indices[item] : item;
    integer(vertex, 'index');
    if (vertex >= vertices) throw new RangeError('Index exceeds available vertices');
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[offset + vertex * stride + axis];
      if (!Number.isFinite(value)) throw new RangeError('Positions must contain finite coordinates');
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}
export function transformBounds(bounds: Bounds3, matrix: Mat4): Bounds3 {
  assertBounds(bounds); assertMatrix(matrix);
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) throw new RangeError('Bounds require an affine matrix');
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(axis => (corner & (1 << axis)) ? bounds.max[axis] : bounds.min[axis]);
    for (let row = 0; row < 3; row++) positions.push(matrix[row] * p[0] + matrix[4 + row] * p[1] + matrix[8 + row] * p[2] + matrix[12 + row]);
  }
  return computeBounds({ positions });
}
export function unionBounds(bounds: readonly Bounds3[]): Bounds3 {
  if (bounds.length === 0) throw new RangeError('At least one bounds is required');
  const positions: number[] = [];
  for (const bound of bounds) { assertBounds(bound); positions.push(...bound.min, ...bound.max); }
  return computeBounds({ positions });
}
export function boundsSphere(bounds: Bounds3): { center: Vec3; radius: number } {
  assertBounds(bounds);
  const center: Vec3 = [bounds.min[0] / 2 + bounds.max[0] / 2, bounds.min[1] / 2 + bounds.max[1] / 2, bounds.min[2] / 2 + bounds.max[2] / 2];
  const radius = Math.hypot(bounds.max[0] / 2 - bounds.min[0] / 2, bounds.max[1] / 2 - bounds.min[1] / 2, bounds.max[2] / 2 - bounds.min[2] / 2);
  if (!Number.isFinite(radius)) throw new RangeError('Bounds sphere exceeds finite range');
  return { center, radius };
}
