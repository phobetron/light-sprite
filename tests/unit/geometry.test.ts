import { describe, expect, it } from '@rstest/core';
import { createBoxGeometry, createSphereGeometry } from '../../src/geometry';
import { computeBounds } from '../../src/bounds';
import { expectOutwardMesh } from '../support/unit/meshAssertions';

describe('geometry', () => {
  it('creates outward 10 cm meshes with unit normals', () => {
    for (const geometry of [createBoxGeometry(), createSphereGeometry()]) {
      expectOutwardMesh(geometry);
      const bounds = computeBounds(geometry);
      for (let axis = 0; axis < 3; axis++) {
        expect(bounds.min[axis]).toBeCloseTo(-0.05, 7);
        expect(bounds.max[axis]).toBeCloseTo(0.05, 7);
      }
    }
  });

  it('handles custom box dimensions and minimum sphere segments', () => {
    expect(computeBounds(createBoxGeometry({ width: 2, height: 4, depth: 6 }))).toEqual({ min: [-1, -2, -3], max: [1, 2, 3] });
    expectOutwardMesh(createSphereGeometry({ widthSegments: 3, heightSegments: 2 }));
  });

  it('rejects invalid dimensions and excessive allocations', () => {
    for (const radius of [0, -1, NaN, Infinity, 1e50]) expect(() => createSphereGeometry({ radius })).toThrow();
    for (const options of [{ widthSegments: 2 }, { heightSegments: 1 }, { widthSegments: 3.5 }, { widthSegments: 1_000_000 }]) expect(() => createSphereGeometry(options)).toThrow();
    expect(() => createBoxGeometry({ depth: 0 })).toThrow();
  });
});
