import { describe, expect, it } from '@rstest/core';
import { glowBillboardBasis, glowDepthDirection } from '../../src/glow';
import { identityMatrix, lookAtMatrix, multiplyMatrices, perspectiveMatrix } from '../../src/math';
import type { Mat4, Vec3 } from '../../src/types';

function project(matrix: Mat4, point: Vec3): number[] {
  return [0, 1, 2, 3].map((row) => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row]);
}

describe('glow world-space billboard', () => {
  it('places depth layers away from the viewer for perspective, orthographic and identity fixtures', () => {
    const orthographic = identityMatrix();
    orthographic[10] = -0.02;
    const view = lookAtMatrix([3, 4, 5], [0, 0, 0], [1, 2, -1]);
    for (const matrix of [identityMatrix(), multiplyMatrices(orthographic, view), multiplyMatrices(perspectiveMatrix(0.8, 1.4, 0.1, 100), view)]) {
      const { right, up } = glowBillboardBasis(matrix);
      const direction = glowDepthDirection(matrix, right, up);
      const center = project(matrix, [0, 0, 0]), behind = project(matrix, direction);
      expect(Math.hypot(...direction)).toBeCloseTo(1);
      expect(behind[2] / behind[3]).toBeGreaterThan(center[2] / center[3]);
    }
  });

  it('faces a rotated, rolled perspective camera despite projection aspect and field of view', () => {
    const view = lookAtMatrix([3, 4, 5], [0, 0, 0], [1, 2, -1]);
    for (const aspect of [0.3, 1, 4]) {
      const matrix = multiplyMatrices(perspectiveMatrix(0.8, aspect, 0.1, 100), view);
      const { right, up } = glowBillboardBasis(matrix);
      const center = project(matrix, [0, 0, 0]);
      const horizontal = project(matrix, right);
      const vertical = project(matrix, up);
      expect(Math.hypot(...right)).toBeCloseTo(1);
      expect(Math.hypot(...up)).toBeCloseTo(1);
      expect(right.reduce((sum, value, index) => sum + value * up[index], 0)).toBeCloseTo(0);
      expect(horizontal[0]).toBeGreaterThan(center[0]);
      expect(horizontal[1]).toBeCloseTo(center[1]);
      expect(vertical[0]).toBeCloseTo(center[0]);
      expect(vertical[1]).toBeGreaterThan(center[1]);
      // Every point on the halo shares the center's depth and clip W.
      for (const edge of [horizontal, vertical]) {
        expect(edge[2]).toBeCloseTo(center[2]);
        expect(edge[3]).toBeCloseTo(center[3]);
      }
    }
  });

  it('supports an orthographic camera with unequal world-to-screen axis scales', () => {
    const projection = identityMatrix();
    projection[0] = 0.25;
    projection[5] = 0.5;
    projection[10] = -0.02;
    const matrix = multiplyMatrices(projection, lookAtMatrix([-2, 3, 4], [0, 0, 0]));
    const { right, up } = glowBillboardBasis(matrix);
    const center = project(matrix, [0, 0, 0]);
    const horizontal = project(matrix, right);
    const vertical = project(matrix, up);
    expect(horizontal[0] - center[0]).toBeCloseTo(0.25);
    expect(horizontal[1]).toBeCloseTo(center[1]);
    expect(vertical[1] - center[1]).toBeCloseTo(0.5);
    expect(vertical[0]).toBeCloseTo(center[0]);
    expect(horizontal[2]).toBeCloseTo(center[2]);
    expect(vertical[2]).toBeCloseTo(center[2]);
  });

  it('rejects missing, parallel, nearly parallel and nonfinite camera axes', () => {
    const zero = new Float32Array(16);
    const parallel = identityMatrix();
    parallel[1] = 1;
    parallel[5] = 0;
    const nearlyParallel = new Float64Array(parallel);
    nearlyParallel[5] = 1e-10;
    const nonfinite = identityMatrix();
    nonfinite[0] = Infinity;
    for (const matrix of [zero, parallel, nearlyParallel, nonfinite, [1, 2, 3]]) {
      expect(() => glowBillboardBasis(matrix)).toThrow();
    }
  });
});
