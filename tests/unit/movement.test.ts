import { describe, expect, it } from '@rstest/core';
import { createMovement } from '../../src/movement';
import type { MovementBounds, MovementController, MovementOptions } from '../../src/movement';
import { distanceToBounds, firstObstacleDistance, movementPadding } from '../../src/movementGeometry';
import { certifyMovementCurve, evaluateMovementCurve, movementCurveVelocity, movementCurveSpeedBound } from '../../src/movementCurve';
import { prepareDomain } from '../../src/movementGeometry';
import type { Bounds3, Vec3 } from '../../src/types';

const cube: MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [12, 12, 12] };
const enclosure = { center: [0, 0, 0] as Vec3, radius: 0.2 };
const difference = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function movement(input: Partial<MovementOptions> = {}, obstacles: readonly Bounds3[] = [], origin: Vec3 = [0, 0, 0]): MovementController {
  return createMovement({ bounds: cube, ...input }, enclosure, origin, obstacles);
}
function safe(controller: MovementController, bounds: MovementBounds, obstacles: readonly Bounds3[]): void {
  const { center, radius, clearance } = controller.sphere;
  expect(clearance).toBeCloseTo(radius * 0.2, 12);
  if (bounds.shape === 'cube') center.forEach((value, i) => expect(Math.abs(value - bounds.center[i]) + radius).toBeLessThan(bounds.size[i] / 2));
  else expect(Math.hypot(...difference(center, bounds.center)) + radius).toBeLessThan(bounds.radius);
  for (const obstacle of obstacles) expect(distanceToBounds(center, obstacle) - radius).toBeGreaterThanOrEqual(clearance);
}

describe('movement safety and curve continuity', () => {
  it('plans identical safe motion when a far obstacle accompanies a nearby box', () => {
    const near: Bounds3 = { min: [2, 2, 2], max: [3, 3, 3] };
    const far: Bounds3 = { min: [1e15, 1e15, 1e15], max: [1e15 + 1, 1e15 + 1, 1e15 + 1] };
    const a = movement({}, [near]), b = movement({}, [near, far]);
    expect(b.plan).toEqual(a.plan);
    for (let frame = 0; frame < 1000; frame++) {
      a.update(0.02);
      b.update(0.02);
      expect(b.position).toEqual(a.position);
      safe(b, cube, [near, far]);
    }
    b.setObstacles([near]);
    expect(b.plan).toEqual(a.plan);
  });

  it('uses exact curve evaluation through updates while isolating snapshots and controllers', () => {
    const local = { center: [1, 2, 3] as Vec3, radius: 0.2 };
    const a = createMovement({ bounds: cube }, local, [-1, -2, -3], []), b = movement({ seed: 31 });
    for (let frame = 0; frame < 2000; frame++) {
      a.update(0.02);
      b.update(0.03);
      const plan = a.plan;
      expect(a.position).toEqual(difference(evaluateMovementCurve(plan.curve, plan.elapsed), local.center));
      (plan.curve.controlPoints[0] as unknown as number[])[0] = Infinity;
      expect(a.plan.curve.controlPoints[0][0]).not.toBe(Infinity);
    }
  });

  it('keeps long seeded cube and ball runs clear of all obstacle faces and rounded corners', () => {
    const obstacles: Bounds3[] = [
      { min: [-1, -2, -1], max: [1, 2, 1] },
      { min: [2, -4, -3], max: [3, 4, -2] },
    ];
    const ball: MovementBounds = { shape: 'sphere', center: [0, 0, 0], radius: 6 };
    for (const bounds of [cube, ball]) {
      const controller = movement({ bounds, seed: 19, speed: 4, distance: 20 }, obstacles, [-2, 0, 0]);
      for (let frame = 0; frame < 10000; frame++) {
        controller.update(0.025);
        safe(controller, bounds, obstacles);
      }
      expect(controller.active).toBe(true);
    }
  });

  it('continues through hundreds of destination changes inside a sealed pocket', () => {
    const walls: Bounds3[] = [
      { min: [-1.5, -2, -2], max: [-1, 2, 2] }, { min: [1, -2, -2], max: [1.5, 2, 2] },
      { min: [-2, -1.5, -2], max: [2, -1, 2] }, { min: [-2, 1, -2], max: [2, 1.5, 2] },
      { min: [-2, -2, -1.5], max: [2, 2, -1] }, { min: [-2, -2, 1], max: [2, 2, 1.5] },
    ];
    const controller = movement({ speed: 10, distance: 10 }, walls);
    let previous = controller.position, previousDirection: Vec3 = [0, 0, 0], turns = 0;
    for (let frame = 0; frame < 8000; frame++) {
      controller.update(0.1);
      safe(controller, cube, walls);
      const delta = difference(controller.position, previous), length = Math.hypot(...delta);
      const direction: Vec3 = delta.map(value => value / length) as unknown as Vec3;
      if (Math.hypot(...difference(direction, previousDirection)) > 0.01) turns++;
      previous = controller.position;
      previousDirection = direction;
      expect(controller.position.every(value => Math.abs(value) < 0.76)).toBe(true);
    }
    expect(turns).toBeGreaterThan(500);
    expect(controller.active).toBe(true);
  });

  it('verifies continuous straight portions, including travel near an obstacle corner', () => {
    const obstacle: Bounds3 = { min: [0, 0, -2], max: [2, 2, 2] };
    const controller = movement({ seed: 41, speed: 2, distance: 8 }, [obstacle], [-0.18, -0.18, 0]);
    let previous = controller.position;
    for (let frame = 0; frame < 5000; frame++) {
      controller.update(0.005);
      const next = controller.position;
      const delta = difference(next, previous), length = Math.hypot(...delta);
      if (length > 0) {
        const direction: Vec3 = delta.map(value => value / length) as unknown as Vec3;
        // Verify each tiny chord against the analytic rounded box.
        expect(firstObstacleDistance(previous, direction, length, obstacle, 1.2 * enclosure.radius)).toBe(length);
        for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
          const point: Vec3 = previous.map((value, i) => value + delta[i] * fraction) as unknown as Vec3;
          expect(distanceToBounds(point, obstacle)).toBeGreaterThan(1.2 * enclosure.radius);
        }
      }
      safe(controller, cube, [obstacle]);
      previous = next;
    }
  });

  it('certifies full curves, braking reserves, speed and arc length through many mixed joins', () => {
    const obstacles: Bounds3[] = [{ min: [0, 0, -2], max: [2, 2, 2] }];
    const controller = movement({ seed: 9, distance: 0.7 }, obstacles, [-0.5, -0.5, 0]);
    const pad = movementPadding(cube, enclosure.radius), domain = prepareDomain(cube, enclosure.radius, pad);
    let stops = 0, passes = 0, bends = 0;
    for (let segment = 0; segment < 300; segment++) {
      const plan = controller.plan;
      for (const curve of [plan.curve, plan.tail].filter(value => value !== undefined)) {
        expect(certifyMovementCurve(curve!, domain, obstacles, 1.2 * enclosure.radius + pad)).toBe(true);
        expect(movementCurveSpeedBound(curve!)).toBeLessThanOrEqual(0.8 + 1e-10);
        const polygon = curve!.controlPoints.slice(1).reduce((sum, point, i) => sum + Math.hypot(...difference(point, curve!.controlPoints[i])), 0);
        expect(polygon).toBeLessThanOrEqual(0.7);
      }
      const velocity = movementCurveVelocity(plan.curve, plan.curve.duration);
      const endpointSpeed = Math.hypot(...velocity);
      if (plan.stop) { stops++; expect(endpointSpeed).toBeLessThan(1e-10); }
      else {
        passes++;
        expect(endpointSpeed).toBeGreaterThan(0);
        expect(plan.tail).toBeDefined();
        expect(endpointSpeed).toBeLessThanOrEqual(Math.min(plan.intent.speed, plan.nextIntent.speed));
        const middle = evaluateMovementCurve(plan.curve, plan.curve.duration / 2);
        if (Math.hypot(...difference(middle, plan.curve.controlPoints[0].map((v, i) => (v + plan.target[i]) / 2) as unknown as Vec3)) > 1e-4) bends++;
      }
      // Advance exactly to the logical transition using reference-time frames.
      let remaining = plan.curve.duration - plan.elapsed;
      while (remaining > 0) { const step = Math.min(remaining, 0.25); controller.update(step); remaining -= step; }
      const next = controller.plan;
      const incoming = movementCurveVelocity(next.curve, 0);
      incoming.forEach((value, i) => expect(value).toBeCloseTo(velocity[i], 9));
      if (!next.fallback) expect(next.target).toEqual(plan.lookahead);
      for (const [curve, end] of [[plan.curve, true], [next.curve, false]] as const) {
        const c = curve.controlPoints, i = end ? 3 : 0;
        const acceleration = c[i].map((value, axis) => 20 * (value - 2 * c[i + 1][axis] + c[i + 2][axis]) / curve.duration ** 2);
        expect(Math.hypot(...acceleration)).toBeLessThan(1e-9);
      }
      safe(controller, cube, obstacles);
    }
    expect(stops).toBeGreaterThan(20);
    expect(passes).toBeGreaterThan(20);
    expect(bends).toBeGreaterThan(20);
  });

  it('consumes its certified braking reserve when continuation fails and resumes after stopping', () => {
    const walls: Bounds3[] = [];
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const min: [number, number, number] = [-2, -2, -2], max: [number, number, number] = [2, 2, 2];
      min[axis] = sign < 0 ? -1.5 : 1;
      max[axis] = sign < 0 ? -1 : 1.5;
      walls.push({ min, max });
    }
    let fallbacks = 0, resumptions = 0;
    for (let seed = 0; seed < 5; seed++) {
      const controller = movement({ seed, distance: 10, stopProbability: 0 }, walls);
      let previous = controller.plan;
      for (let frame = 0; frame < 3000; frame++) {
        controller.update(0.25);
        const current = controller.plan;
        if (current.fallback && !previous.fallback) {
          fallbacks++;
          expect(Math.hypot(...movementCurveVelocity(current.curve, current.curve.duration))).toBeLessThan(1e-10);
          if (previous.tail) expect(current.curve).toEqual(previous.tail);
        }
        if (!current.fallback && previous.fallback) resumptions++;
        safe(controller, cube, walls);
        previous = current;
      }
    }
    expect(fallbacks).toBeGreaterThan(0);
    expect(resumptions).toBeGreaterThan(0);
  });
});

describe('movement clocks and configuration', () => {
  it('treats speed as a relative clock multiplier and preserves phase when pace changes', () => {
    const normal = movement({ speed: 1 }), half = movement({ speed: 0.5 }), double = movement({ speed: 2 });
    for (let frame = 0; frame < 1000; frame++) {
      normal.update(0.02);
      half.update(0.04);
      double.update(0.01);
    }
    expect(half.position).toEqual(normal.position);
    expect(double.position).toEqual(normal.position);
    const before = normal.plan;
    normal.setOptions({ speed: 2 });
    expect(normal.plan).toEqual(before);
    normal.update(0.01);
    half.update(0.04);
    expect(normal.position).toEqual(half.position);
  });

  it('preserves targets, kinematics and randomness during harmless obstacle refresh', () => {
    const a = movement(), b = movement();
    a.update(0.2);
    b.update(0.2);
    const plan = a.plan;
    a.setObstacles([{ min: [20, 20, 20], max: [21, 21, 21] }]);
    expect(a.plan).toEqual(plan);
    for (let frame = 0; frame < 2000; frame++) { a.update(0.02); b.update(0.02); expect(a.position).toEqual(b.position); }
  });

  it('is deterministic across ordinary frame partitions and uint32 seeds', () => {
    for (const seed of [0, 1, 0xffffffff]) {
      const a = movement({ seed }), b = movement({ seed });
      for (let frame = 0; frame < 4000; frame++) {
        a.update(0.02);
        b.update(0.007);
        b.update(0.013);
      }
      a.position.forEach((value, i) => expect(value).toBeCloseTo(b.position[i], 9));
    }
    expect(movement({ seed: 1 }).position).toEqual(movement({ seed: 2 }).position);
    const a = movement({ seed: 1 }), b = movement({ seed: 2 });
    a.update(0.2);
    b.update(0.2);
    expect(a.position).not.toEqual(b.position);
  });

  it('uses the offset enclosing sphere and copies mutable consumer inputs', () => {
    const local = { center: [1, 2, 3] as [number, number, number], radius: 0.2 };
    const bounds = { shape: 'sphere' as const, center: [10, 20, 30] as [number, number, number], radius: 3 };
    const controller = createMovement({ bounds }, local, [9, 18, 27], []);
    local.center[0] = 500;
    bounds.center[0] = 500;
    expect(controller.sphere.center).toEqual([10, 20, 30]);
    for (let frame = 0; frame < 1000; frame++) {
      controller.update(0.02);
      expect(Math.hypot(...difference(controller.sphere.center, [10, 20, 30])) + 0.2).toBeLessThan(3);
      difference(controller.sphere.center, controller.position).forEach((value, i) => expect(value).toBeCloseTo(i + 1, 12));
    }
  });

  it('caps discarded excess time and pauses/resumes without losing options', () => {
    const a = movement({ seed: 78, maxDeltaSeconds: 0.1 }), b = movement({ seed: 78, maxDeltaSeconds: 0.1 });
    a.update(1000000);
    b.update(0.1);
    expect(a.position).toEqual(b.position);
    const options = a.options, position = a.position;
    a.setOptions(false);
    a.update(10);
    expect(a.active).toBe(false);
    expect(a.position).toEqual(position);
    a.setOptions(true);
    expect(a.options).toEqual(options);
    expect(a.active).toBe(true);
    a.update(0.1);
    expect(a.position).not.toEqual(position);
  });

  it('rejects malformed configuration and invalid poses atomically', () => {
    for (const options of [{ speed: 0 }, { speed: Number.MIN_VALUE }, { distance: -1 }, { seed: -1 }, { seed: 0.5 }, { seed: 0x100000000 }, { maxDeltaSeconds: 0 }, { maxDeltaSeconds: 1.1 }, { bounds: { shape: 'sphere' as const, center: [0, 0, 0] as Vec3, radius: 0.2 } }]) expect(() => movement(options)).toThrow();
    expect(() => movement({}, [], [6, 0, 0])).toThrow();
    expect(() => movement({}, [{ min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] }])).toThrow();
    const a = movement(), control = movement();
    a.update(0.1);
    control.update(0.1);
    const position = a.position, options = a.options;
    expect(() => a.setOptions({ bounds: { shape: 'sphere', center: [10, 0, 0], radius: 1 } })).toThrow();
    expect(() => a.setOptions({ speed: Number.MIN_VALUE })).toThrow();
    expect(() => a.setPosition([6, 0, 0])).toThrow();
    expect(() => a.setObstacles([{ min: [-1, -1, -1], max: [1, 1, 1] }])).toThrow();
    expect(() => a.update(NaN)).toThrow();
    expect(() => a.update(-1)).toThrow();
    expect(a.position).toEqual(position);
    expect(a.options).toEqual(options);
    a.update(0.1);
    control.update(0.1);
    expect(a.position).toEqual(control.position);
  });
});

describe('movement precision and transactional setters', () => {
  it('moves inward when a valid initial outward random ray rounds onto the padded boundary', () => {
    const bounds: MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [10, 10, 10] };
    const origin: Vec3 = [4.799995231628417, 0, 0];
    const controller = createMovement({ bounds, seed: 1 }, enclosure, origin, []);
    controller.update(0.25);
    expect(controller.position[0]).toBeLessThan(origin[0]);
    for (let frame = 0; frame < 2000; frame++) {
      controller.update(0.025);
      safe(controller, bounds, []);
    }
    expect(controller.active).toBe(true);
  });

  it('skips rounded boundary proposals for multiple pass-through seeds', () => {
    const bounds: MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [10, 10, 10] };
    const origin: Vec3 = [4.799995231628417, 0, 0];
    for (const seed of [11, 26, 39]) {
      const controller = createMovement({ bounds, seed, stopProbability: 0 }, enclosure, origin, []);
      controller.update(0.25);
      expect(controller.position[0]).toBeLessThan(origin[0]);
      for (let frame = 0; frame < 1000; frame++) { controller.update(0.025); safe(controller, bounds, []); }
    }
  });

  it('uses a certified startup stop when tiny offset pockets cannot represent pass-through handles', () => {
    const size = 0.400002 + 2 * 1.2e-10;
    const bounds: MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [size, size, size] };
    const local = { center: [1e6, 1e6, 1e6] as Vec3, radius: 0.2 };
    const origin: Vec3 = [-1e6, -1e6, -1e6];
    const controller = createMovement({ bounds, seed: 9, stopProbability: 0 }, local, origin, []);
    expect(controller.plan.fallback).toBe(true);
    expect(controller.plan.stop).toBe(true);
    expect(controller.plan.restart).toBeDefined();
    expect(Math.hypot(...difference(controller.plan.target, controller.plan.curve.controlPoints[0]))).toBeGreaterThan(0);
    for (let frame = 0; frame < 100; frame++) { controller.update(0.25); safe(controller, bounds, []); }
    controller.setPosition(origin);
    expect(controller.plan.fallback).toBe(true);
    controller.setOptions({ seed: 8 });
    controller.setOptions({ seed: 9, stopProbability: 0 });
    expect(controller.plan.fallback).toBe(true);
  });

  it('rejects travel below the numerical guard before changing settings or random state', () => {
    const controller = movement({}, [], [1, 1, 1]), twin = movement({}, [], [1, 1, 1]);
    controller.update(0.1);
    twin.update(0.1);
    for (const distance of [1e-300, 1e-8]) {
      expect(() => controller.setOptions({ distance, seed: 123 })).toThrow();
      expect(controller.options).toEqual(twin.options);
      expect(controller.position).toEqual(twin.position);
    }
    for (let frame = 0; frame < 2000; frame++) {
      controller.update(0.02);
      twin.update(0.02);
      expect(controller.position).toEqual(twin.position);
    }
  });

  it('keeps every setter atomic when candidate planning itself fails after drawing random values', () => {
    // The offset is supported, but a new pocket's residual room is smaller than
    // the origin's representable increments. Certification fails after proposals.
    const local = { center: [1e6, 1e6, 1e6] as Vec3, radius: 0.2 };
    const origin: Vec3 = [-1e6, -1e6, -1e6];
    const bounds: MovementBounds = { shape: 'cube', center: [0, 0, 0], size: [10, 10, 10] };
    const gap = 1.2 * local.radius + movementPadding(bounds, local.radius) + 5e-12;
    function pocket(center: Vec3): Bounds3[] {
      const walls: Bounds3[] = [];
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const min = center.map(value => value - 1) as [number, number, number];
        const max = center.map(value => value + 1) as [number, number, number];
        min[axis] = center[axis] + (sign < 0 ? -gap - 0.2 : gap);
        max[axis] = center[axis] + (sign < 0 ? -gap : gap + 0.2);
        walls.push({ min, max });
      }
      return walls;
    }
    for (const setter of ['options', 'position', 'obstacles'] as const) {
      const field = setter === 'position' ? pocket([4, 4, 4]) : [];
      const controller = createMovement({ bounds, distance: 4 }, local, origin, field);
      const twin = createMovement({ bounds, distance: 4 }, local, origin, field);
      controller.update(0.1);
      twin.update(0.1);
      const currentCenter = controller.sphere.center;
      const reject = () => {
        if (setter === 'options') controller.setOptions({ bounds: { shape: 'cube', center: currentCenter, size: [0.40000200001, 0.40000200001, 0.40000200001] }, seed: 123 });
        if (setter === 'position') controller.setPosition([-1e6 + 4, -1e6 + 4, -1e6 + 4]);
        if (setter === 'obstacles') controller.setObstacles(pocket(currentCenter));
      };
      expect(reject).toThrow(/precision/);
      expect(controller.options).toEqual(twin.options);
      expect(controller.position).toEqual(twin.position);
      for (let frame = 0; frame < 1000; frame++) {
        controller.update(0.02);
        twin.update(0.02);
        expect(controller.position).toEqual(twin.position);
      }
    }
  });
});
