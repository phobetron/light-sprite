import { describe, expect, it } from '@rstest/core';
import { expectOutwardMesh } from '../support/unit/meshAssertions';
import {
  createCylinderGeometry, CYLINDER_CENTERS, CYLINDER_HEIGHT, CYLINDER_RADIUS,
  MARKER_DIAMETER, MARKER_POSITION,
} from '../../examples/scene';

describe('static scene dimensions', () => {
  it('places two 1 m diameter, 4 m tall cylinders exactly 1 m apart', () => {
    expect(CYLINDER_RADIUS * 2).toBe(1);
    expect(CYLINDER_HEIGHT).toBe(4);
    expect(CYLINDER_CENTERS).toEqual([[-1, 0, 0], [1, 0, 0]]);
    expect(CYLINDER_CENTERS[1][0] - CYLINDER_CENTERS[0][0] - 2 * CYLINDER_RADIUS).toBe(1);
    expect(MARKER_POSITION).toEqual([0, 2, 0]);
    expect(MARKER_DIAMETER).toBe(0.1);
  });

  it('generates matching outward normals and geometry from floor to 4 m', () => {
    const geometry = createCylinderGeometry();
    expectOutwardMesh(geometry, [0, CYLINDER_HEIGHT / 2, 0]);
    const heights = Array.from(geometry.positions).filter((_, index) => index % 3 === 1);
    expect(Math.min(...heights)).toBe(0);
    expect(Math.max(...heights)).toBe(4);
  });
});
