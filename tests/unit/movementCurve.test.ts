import { describe, expect, it } from '@rstest/core';
import { certifyMovementCurve, createMovementCurve, createMovementCurveEvaluator, evaluateMovementCurve, movementCurveSpeedBound, movementCurveVelocity, remainingMovementCurve } from '../../src/movementCurve';
import type { MovementCurve } from '../../src/movementCurve';
import { distanceToBounds, movementPadding, pointInDomain, prepareDomain } from '../../src/movementGeometry';
import type { Bounds3, Vec3 } from '../../src/types';

const cube = prepareDomain({ shape: 'cube', center: [0, 0, 0], size: [20, 20, 20] }, 0, 0);
const obstacle: Bounds3 = { min: [-0.2, 0.8, -0.2], max: [0.2, 1.2, 0.2] };
const bulge: MovementCurve = { duration: 2, controlPoints: [[-2, 0, 0], [-1, 2, 0], [-0.5, 2, 0], [0.5, 2, 0], [1, 2, 0], [2, 0, 0]] };

describe('movement curve evaluation', () => {
  it('matches the validated evaluator exactly with isolated reusable scratch and immutable inputs', () => {
    const evaluate = createMovementCurveEvaluator(), other = createMovementCurveEvaluator();
    const curves = [bulge, createMovementCurve([-2, 0, 1], [3, -2, 4], [2, 1, -1], [-1, 2, 0], 3),
      createMovementCurve([1e12, -1e-12, 3], [1e12 + 10, 1e-12, -3], [0.1, 2, 0], [-0.1, -2, 0], 4)];
    const snapshots = JSON.stringify(curves);
    for (const curve of curves) {
      const retained = evaluate(curve, 0.25), expected = [...retained];
      for (let i = -1; i <= 10001; i++) {
        const time = curve.duration * i / 10000;
        expect(evaluate(curve, time)).toEqual(evaluateMovementCurve(curve, time));
        other(curves[0], time);
      }
      expect(retained).toEqual(expected);
      (retained as unknown as number[])[0] = Infinity;
      expect(evaluate(curve, 0.25)).toEqual(expected);
    }
    expect(JSON.stringify(curves)).toBe(snapshots);
    expect(() => evaluateMovementCurve({ ...bulge, duration: 0 }, 0)).toThrow();
    expect(() => evaluateMovementCurve({ ...bulge, controlPoints: [[NaN, 0, 0], ...bulge.controlPoints.slice(1)] as unknown as MovementCurve['controlPoints'] }, 0)).toThrow();
  });

  it('preserves endpoint positions, velocities and zero accelerations', () => {
    const start: Vec3 = [2, -1, 3], end: Vec3 = [5, 3, 2], incoming: Vec3 = [0.3, 0.2, -0.1], outgoing: Vec3 = [-0.1, 0.5, 0.2];
    const curve = createMovementCurve(start, end, incoming, outgoing, 2.5);
    expect(evaluateMovementCurve(curve, -1)).toEqual(start);
    expect(evaluateMovementCurve(curve, 3)).toEqual(end);
    for (let axis = 0; axis < 3; axis++) {
      expect(movementCurveVelocity(curve, 0)[axis]).toBeCloseTo(incoming[axis], 12);
      expect(movementCurveVelocity(curve, 2.5)[axis]).toBeCloseTo(outgoing[axis], 12);
      const p = curve.controlPoints;
      expect(p[2][axis] - 2 * p[1][axis] + p[0][axis]).toBeCloseTo(0, 12);
      expect(p[5][axis] - 2 * p[4][axis] + p[3][axis]).toBeCloseTo(0, 12);
    }
    for (const duration of [0, -1, Infinity, NaN]) expect(() => createMovementCurve(start, end, incoming, outgoing, duration)).toThrow();
    expect(() => evaluateMovementCurve(curve, NaN)).toThrow();
  });

  it('bounds speed for the complete derivative curve', () => {
    const curve = createMovementCurve([-2, 0, 1], [3, -2, 4], [2, 1, -1], [-1, 2, 0], 3);
    const bound = movementCurveSpeedBound(curve);
    for (let i = 0; i <= 200; i++) expect(Math.hypot(...movementCurveVelocity(curve, i * 3 / 200))).toBeLessThanOrEqual(bound + 1e-12);
  });

  it('bounds the peak speed of a straight stop-to-stop curve', () => {
    const curve = createMovementCurve([0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0], 1);
    expect(movementCurveSpeedBound(curve)).toBeCloseTo(1.875, 12);
    expect(movementCurveSpeedBound(curve)).toBeGreaterThanOrEqual(Math.hypot(...movementCurveVelocity(curve, 0.5)));
  });

  it('preserves future curve geometry and velocity phase when retaining its remainder', () => {
    const curve = createMovementCurve([-2, 0, 1], [3, -2, 4], [2, 1, -1], [-1, 2, 0], 3);
    const remaining = remainingMovementCurve(curve, 1.2)!;
    expect(remaining.duration).toBe(1.8);
    for (let i = 0; i <= 20; i++) {
      const time = remaining.duration * i / 20;
      for (let axis = 0; axis < 3; axis++) {
        expect(evaluateMovementCurve(remaining, time)[axis]).toBeCloseTo(evaluateMovementCurve(curve, time + 1.2)[axis], 12);
        expect(movementCurveVelocity(remaining, time)[axis]).toBeCloseTo(movementCurveVelocity(curve, time + 1.2)[axis], 12);
      }
    }
    expect(remainingMovementCurve(curve, -1)).toEqual(curve);
    expect(remainingMovementCurve(curve, 3)).toBeUndefined();
    expect(remainingMovementCurve(curve, 4)).toBeUndefined();
    expect(() => remainingMovementCurve(curve, NaN)).toThrow();
  });
});

describe('movement curve certification', () => {
  it('certifies large obstacle collections without argument spreading', () => {
    const outside = { min: [20, 20, 20] as Vec3, max: [21, 21, 21] as Vec3 };
    expect(certifyMovementCurve(bulge, cube, Array.from({ length: 30000 }, () => outside), 0.1)).toBe(true);
    expect(certifyMovementCurve(bulge, cube, [...Array.from({ length: 30000 }, () => outside), { min: [-0.2, 1.8, -0.2], max: [0.2, 2, 0.2] }], 0.1)).toBe(false);
  });

  it('keeps a distant obstacle from inflating nearby clearance while retaining large-coordinate guards', () => {
    const far: Bounds3 = { min: [1e15, 1e15, 1e15], max: [1e15 + 1, 1e15 + 1, 1e15 + 1] };
    expect(certifyMovementCurve(bulge, cube, [obstacle], 0.1)).toBe(true);
    expect(certifyMovementCurve(bulge, cube, [far], 0.1)).toBe(true);
    expect(certifyMovementCurve(bulge, cube, [obstacle, far], 0.1)).toBe(true);
    const center = 1e12;
    const domain = prepareDomain({ shape: 'cube', center: [center, 0, 0], size: [20, 20, 20] }, 0, 0);
    const box: Bounds3 = { min: [center, 0, 0], max: [center + 1, 1, 1] };
    for (const y of [0.5, 2, 2.001]) {
      const curve = createMovementCurve([center - 2, y, 0.5], [center + 3, y, 0.5], [1, 0, 0], [1, 0, 0], 5);
      expect(certifyMovementCurve(curve, domain, [box, far], 1)).toBe(false);
    }
    const clear = createMovementCurve([center - 2, 2.5, 0.5], [center + 3, 2.5, 0.5], [1, 0, 0], [1, 0, 0], 5);
    expect(certifyMovementCurve(clear, domain, [box, far], 1)).toBe(true);
  });

  it('certifies only the future trajectory after an obstacle is added behind it', () => {
    const curve = createMovementCurve([-3, 0, 0], [3, 0, 0], [1, 0, 0], [1, 0, 0], 6);
    const behind: Bounds3 = { min: [-2.1, -0.2, -0.2], max: [-1.9, 0.2, 0.2] };
    expect(certifyMovementCurve(curve, cube, [behind], 0.2)).toBe(false);
    expect(certifyMovementCurve(remainingMovementCurve(curve, 3)!, cube, [behind], 0.2)).toBe(true);
    const ahead: Bounds3 = { min: [1.9, -0.2, -0.2], max: [2.1, 0.2, 0.2] };
    expect(certifyMovementCurve(remainingMovementCurve(curve, 3)!, cube, [ahead], 0.2)).toBe(false);
  });

  it('allows an inward curve from a valid start beside the padded domain boundary', () => {
    const bounds = { shape: 'cube' as const, center: [0, 0, 0] as Vec3, size: [10, 10, 10] as Vec3 };
    const domain = prepareDomain(bounds, 0.2, movementPadding(bounds, 0.2));
    const start: Vec3 = [4.799995231628417, 0, 0];
    expect(pointInDomain(domain, start)).toBe(true);
    expect(certifyMovementCurve(createMovementCurve(start, [4, 0, 0], [-0.2, 0, 0], [-0.2, 0, 0], 4), domain, [], 0.2)).toBe(true);
    expect(certifyMovementCurve(createMovementCurve(domain.max, [4, 0, 0], [-0.2, 0, 0], [-0.2, 0, 0], 4), domain, [], 0.2)).toBe(false);
  });

  it('rejects curved collision even with clear endpoints and chord', () => {
    const hit: Bounds3 = { min: [-0.2, 1.8, -0.2], max: [0.2, 2, 0.2] };
    expect(distanceToBounds(bulge.controlPoints[0], hit)).toBeGreaterThan(0.1);
    expect(distanceToBounds(bulge.controlPoints[5], hit)).toBeGreaterThan(0.1);
    expect(distanceToBounds(evaluateMovementCurve(bulge, 1), hit)).toBeLessThan(0.1);
    expect(certifyMovementCurve(bulge, cube, [hit], 0.1)).toBe(false);
  });

  it('certifies a curved passage through adaptive subdivision', () => {
    expect(certifyMovementCurve(bulge, cube, [obstacle], 0.1)).toBe(true);
    expect(certifyMovementCurve(bulge, cube, [obstacle], 0.1, { maxNodes: 1 })).toBe(false);
    expect(certifyMovementCurve(bulge, cube, [obstacle], 0.1, { maxDepth: 0 })).toBe(false);
  });

  it('certifies a diagonal rounded-corner passage with a single chord', () => {
    // The control hull's AABB overlaps the obstacle; the diagonal chord still
    // clears its rounded corner by more than one world unit.
    const diagonal = createMovementCurve([-3, 0.8, 0.5], [0.8, -3, 0.5], [0.76, -0.76, 0], [0.76, -0.76, 0], 5);
    expect(certifyMovementCurve(diagonal, cube, [{ min: [0, 0, 0], max: [1, 1, 1] }], 1, { maxNodes: 1 })).toBe(true);
  });

  it('rejects tangency and near tangency without weakening clearance', () => {
    const box: Bounds3 = { min: [0, 0, 0], max: [1, 1, 1] };
    for (const y of [2, 2 - 1e-10, 2 + 1e-14]) {
      const curve = createMovementCurve([-2, y, 0.5], [3, y, 0.5], [1, 0, 0], [1, 0, 0], 5);
      expect(certifyMovementCurve(curve, cube, [box], 1)).toBe(false);
    }
    const clear = createMovementCurve([-2, 2.001, 0.5], [3, 2.001, 0.5], [1, 0, 0], [1, 0, 0], 5);
    expect(certifyMovementCurve(clear, cube, [box], 1)).toBe(true);
  });

  it('enforces entire-curve cube and sphere containment', () => {
    const sphere = prepareDomain({ shape: 'sphere', center: [0, 0, 0], radius: 2.1 }, 0, 0);
    const smallCube = prepareDomain({ shape: 'cube', center: [0, 0, 0], size: [5, 3, 5] }, 0, 0);
    expect(certifyMovementCurve(bulge, cube, [], 0)).toBe(true);
    expect(certifyMovementCurve(bulge, smallCube, [], 0)).toBe(false);
    expect(certifyMovementCurve(bulge, sphere, [], 0)).toBe(true);
    const outside = { ...bulge, controlPoints: bulge.controlPoints.map(point => [point[0], point[1] * 2, point[2]] as Vec3) as unknown as MovementCurve['controlPoints'] };
    expect(certifyMovementCurve(outside, sphere, [], 0)).toBe(false);
    const boundary = createMovementCurve([0, 0, 0], [2.1, 0, 0], [0, 0, 0], [0, 0, 0], 1);
    expect(certifyMovementCurve(boundary, sphere, [], 0)).toBe(false);
  });

  it('rejects invalid clearance and budgets', () => {
    for (const clearance of [-1, NaN, Infinity]) expect(() => certifyMovementCurve(bulge, cube, [], clearance)).toThrow();
    for (const maxNodes of [0, 1.5, 65536]) expect(() => certifyMovementCurve(bulge, cube, [], 0, { maxNodes })).toThrow();
  });
});
