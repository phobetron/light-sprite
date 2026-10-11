import { describe, expect, it } from '@rstest/core';
import { distanceToBounds, firstObstacleDistance, movementPadding, normalizeMovementBounds, pointInDomain, prepareDomain, rayDomainDistance } from '../../src/movementGeometry';
import type { Bounds3, Vec3 } from '../../src/types';

const obstacle: Bounds3 = { min: [0, 0, 0], max: [1, 1, 1] };
function along(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  return [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, origin[2] + direction[2] * distance];
}
function verifyApproach(origin: Vec3, direction: Vec3, limit: number, box: Bounds3, clearance: number): number {
  const hit = firstObstacleDistance(origin, direction, limit, box, clearance);
  for (const fraction of [0, 0.25, 0.5, 0.75, 0.99]) {
    expect(distanceToBounds(along(origin, direction, hit * fraction), box)).toBeGreaterThanOrEqual(clearance);
  }
  return hit;
}

describe('continuous movement geometry', () => {
  it('copies movement bounds and rejects malformed or unrepresentable inputs', () => {
    const center: [number, number, number] = [0, 0, 0], size: [number, number, number] = [16, 5, 16];
    const normalized = normalizeMovementBounds({ shape: 'cube', center, size });
    center[0] = 9;
    size[0] = 99;
    expect(normalized).toEqual({ shape: 'cube', center: [0, 0, 0], size: [16, 5, 16] });
    for (const radius of [0, -1, NaN, Infinity, 1e40, 1e-50]) expect(() => normalizeMovementBounds({ shape: 'sphere', center: [0, 0, 0], radius })).toThrow();
    expect(() => normalizeMovementBounds({ shape: 'cube', center: [NaN, 0, 0], size: [1, 1, 1] })).toThrow();
    expect(() => normalizeMovementBounds({ shape: 'cube', center: [0, 0, 0], size: [1, 0, 1] })).toThrow();
  });

  it('erodes whole-body cube and ball containment only by radius and guard', () => {
    const cube = { shape: 'cube' as const, center: [3, 4, 5] as Vec3, size: [16, 5, 16] as Vec3 };
    const padding = movementPadding(cube, 0.5), domain = prepareDomain(cube, 0.5, padding);
    const exit = rayDomainDistance(domain, cube.center, [0, 1, 0]);
    expect(exit).toBeCloseTo(2 - padding, 10);
    expect(pointInDomain(domain, along(cube.center, [0, 1, 0], exit))).toBe(false);
    expect(pointInDomain(domain, along(cube.center, [0, 1, 0], exit * 0.99))).toBe(true);
    const sphere = prepareDomain({ shape: 'sphere', center: [3, 4, 5], radius: 5 }, 1, 1e-5);
    const direction: Vec3 = [0.6, 0.8, 0];
    const sphereExit = rayDomainDistance(sphere, [3, 4, 5], direction);
    expect(sphereExit + 1).toBeLessThan(5);
    expect(pointInDomain(sphere, along([3, 4, 5], direction, sphereExit * 0.999))).toBe(true);
    expect(() => rayDomainDistance(domain, domain.max, [1, 0, 0])).toThrow();
  });

  it('rejects zero room and permits a strictly positive small fit', () => {
    expect(() => prepareDomain({ shape: 'sphere', center: [0, 0, 0], radius: 1 }, 1, 0)).toThrow(/positive interior/);
    expect(() => prepareDomain({ shape: 'cube', center: [0, 0, 0], size: [2, 2, 2] }, 1, 0)).toThrow(/positive interior/);
    const bounds = { shape: 'cube' as const, center: [0, 0, 0] as Vec3, size: [0.002, 0.002, 0.002] as Vec3 };
    const padding = movementPadding(bounds, 0.0009);
    expect(padding).toBe(1e-6);
    expect(pointInDomain(prepareDomain(bounds, 0.0009, padding), [0, 0, 0])).toBe(true);
    expect(movementPadding({ shape: 'sphere', center: [1e6, 0, 0], radius: 10 }, 1)).toBeGreaterThan(0.9);
  });

  it('detects a thin obstacle even when both ray endpoints clear it', () => {
    const thin: Bounds3 = { min: [0, -1, -1], max: [0.000001, 1, 1] };
    const origin: Vec3 = [-100, 0, 0], direction: Vec3 = [1, 0, 0];
    expect(distanceToBounds(along(origin, direction, 200), thin)).toBeGreaterThan(1);
    const hit = verifyApproach(origin, direction, 200, thin, 0.6);
    expect(hit).toBeCloseTo(99.4, 10);
    expect(distanceToBounds(along(origin, direction, hit + 0.01), thin)).toBeLessThan(0.6);
  });

  it('allows rounded-corner passages that expanded box slabs would exclude', () => {
    const origin: Vec3 = [-2, 1.8, 1.8], direction: Vec3 = [1, 0, 0];
    expect(firstObstacleDistance(origin, direction, 5, obstacle, 1)).toBe(5);
    for (const distance of [0, 1, 2, 2.5, 3, 4, 5]) expect(distanceToBounds(along(origin, direction, distance), obstacle)).toBeGreaterThan(1);
    const hit = verifyApproach([-2, 1.6, 1.6], direction, 5, obstacle, 1);
    expect(hit).toBeGreaterThan(1);
    expect(hit).toBeLessThan(2);
    expect(distanceToBounds(along([-2, 1.6, 1.6], direction, hit + 0.001), obstacle)).toBeLessThan(1);
  });

  it('handles rays away, parallel, tangent and initially unsafe', () => {
    expect(firstObstacleDistance([-2, 0.5, 0.5], [-1, 0, 0], 5, obstacle, 1)).toBe(5);
    expect(firstObstacleDistance([-2, 3, 0.5], [1, 0, 0], 5, obstacle, 1)).toBe(5);
    expect(verifyApproach([-2, 2, 0.5], [1, 0, 0], 5, obstacle, 1)).toBeCloseTo(2, 10);
    expect(firstObstacleDistance([-0.5, 0.5, 0.5], [1, 0, 0], 5, obstacle, 1)).toBe(0);
    expect(() => firstObstacleDistance([-2, 0, 0], [0, 0, 0], 5, obstacle, 1)).toThrow();
    expect(() => firstObstacleDistance([-2, 0, 0], [1, 0, 0], 5, { min: [1, 0, 0], max: [0, 1, 1] }, 1)).toThrow();
  });

  it('finds oblique corner contact across face crossing intervals', () => {
    const origin: Vec3 = [-3, -2, -1], direction: Vec3 = [3 / Math.sqrt(14), 2 / Math.sqrt(14), 1 / Math.sqrt(14)];
    const hit = verifyApproach(origin, direction, 8, obstacle, 0.6);
    expect(hit).toBeLessThan(Math.sqrt(14));
    expect(distanceToBounds(along(origin, direction, hit), obstacle)).toBeCloseTo(0.6, 10);
    expect(distanceToBounds(along(origin, direction, hit + 0.001), obstacle)).toBeLessThan(0.6);
    expect(firstObstacleDistance(origin, direction, hit / 2, obstacle, 0.6)).toBe(hit / 2);
  });

  it('finds stable sphere exits close to the boundary', () => {
    const domain = prepareDomain({ shape: 'sphere', center: [0, 0, 0], radius: 1 }, 0, 0);
    expect(rayDomainDistance(domain, [1 - 1e-10, 0, 0], [1, 0, 0])).toBeCloseTo(1e-10, 15);
    expect(rayDomainDistance(domain, [1 - 1e-10, 0, 0], [-1, 0, 0])).toBeCloseTo(2 - 1e-10, 10);
  });
});
