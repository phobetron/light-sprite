import { expect } from '@rstest/core';
import type { Geometry } from '../../../src/types';

export function expectOutwardMesh(geometry: Geometry, center: readonly number[] = [0, 0, 0]): void {
  const { positions: p, normals: n, indices } = geometry;
  expect(n?.length).toBe(p.length);
  expect(indices!.length % 3).toBe(0);
  for (let i = 0; i < indices!.length; i += 3) {
    const a = indices![i] * 3;
    const b = indices![i + 1] * 3;
    const c = indices![i + 2] * 3;
    expect(Math.max(a, b, c)).toBeLessThan(p.length);
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    expect(cross.reduce((sum, value, axis) => sum + value * n![a + axis], 0)).toBeGreaterThan(0);
  }
  for (let i = 0; i < n!.length; i += 3) {
    expect(Math.hypot(n![i], n![i + 1], n![i + 2])).toBeCloseTo(1, 6);
    // Winding agreement alone also permits consistently inward-facing meshes.
    const outward = [0, 1, 2].reduce((sum, axis) => sum + n![i + axis] * (p[i + axis] - center[axis]), 0);
    expect(outward).toBeGreaterThan(0);
  }
}
