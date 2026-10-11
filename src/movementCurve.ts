import { assertVec3 } from './math';
import { distanceToBounds, firstObstacleDistance, pointInDomain } from './movementGeometry';
import type { MovementDomain } from './movementGeometry';
import type { Bounds3, Vec3 } from './types';

export type CurveControlPoints = readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
export interface MovementCurve { controlPoints: CurveControlPoints; duration: number }
export interface CurveCertificateOptions { maxDepth?: number; maxNodes?: number }

function validateCurve(curve: MovementCurve): void {
  if (!Number.isFinite(curve.duration) || curve.duration <= 0) throw new RangeError('Curve duration must be positive and finite');
  if (curve.controlPoints.length !== 6) throw new RangeError('Curve requires six control points');
  curve.controlPoints.forEach(point => assertVec3(point, 'control point'));
}
function combine(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
}
function evaluate(points: readonly Vec3[], t: number): Vec3 {
  let level = [...points];
  while (level.length > 1) level = level.slice(0, -1).map((point, i) => combine(point, level[i + 1], t));
  return level[0];
}
function parameter(curve: MovementCurve, time: number): number {
  validateCurve(curve);
  if (!Number.isFinite(time)) throw new RangeError('Curve time must be finite');
  return Math.max(0, Math.min(1, time / curve.duration));
}

/** Quintic Bezier with the requested endpoint velocities and zero endpoint accelerations. */
export function createMovementCurve(start: Vec3, end: Vec3, startVelocity: Vec3, endVelocity: Vec3, duration: number): MovementCurve {
  [start, end, startVelocity, endVelocity].forEach(point => assertVec3(point, 'curve input'));
  const offset = (point: Vec3, velocity: Vec3, factor: number): Vec3 => point.map((value, i) => value + velocity[i] * duration * factor) as unknown as Vec3;
  const curve: MovementCurve = { duration, controlPoints: [[...start], offset(start, startVelocity, 1 / 5), offset(start, startVelocity, 2 / 5), offset(end, endVelocity, -2 / 5), offset(end, endVelocity, -1 / 5), [...end]] };
  validateCurve(curve);
  return curve;
}
export function evaluateMovementCurve(curve: MovementCurve, time: number): Vec3 {
  return evaluate(curve.controlPoints, parameter(curve, time));
}
/** Internal controller evaluator: curves and elapsed times are already validated.
 * Each controller owns its scratch; returned positions never alias that storage.
 */
export function createMovementCurveEvaluator(): (curve: MovementCurve, time: number) => Vec3 {
  const scratch = new Float64Array(18);
  return (curve, time) => {
    const t = Math.max(0, Math.min(1, time / curve.duration));
    for (let point = 0; point < 6; point++) {
      for (let axis = 0; axis < 3; axis++) scratch[point * 3 + axis] = curve.controlPoints[point][axis];
    }
    // Match de Casteljau's arithmetic and order exactly. Ascending writes only
    // replace the left operand after both operands for that point were read.
    for (let count = 5; count > 0; count--) {
      for (let point = 0; point < count; point++) {
        for (let axis = 0; axis < 3; axis++) {
          const index = point * 3 + axis;
          scratch[index] = scratch[index] * (1 - t) + scratch[index + 3] * t;
        }
      }
    }
    return [scratch[0], scratch[1], scratch[2]];
  };
}
export function movementCurveVelocity(curve: MovementCurve, time: number): Vec3 {
  const t = parameter(curve, time);
  return evaluate(derivatives(curve), t);
}
function derivatives(curve: MovementCurve): Vec3[] {
  return curve.controlPoints.slice(0, -1).map((point, i) => point.map((value, axis) => (curve.controlPoints[i + 1][axis] - value) * 5 / curve.duration) as unknown as Vec3);
}
/** Bound speed using the convex hulls of eight fixed derivative subdivisions. */
export function movementCurveSpeedBound(curve: MovementCurve): number {
  validateCurve(curve);
  let sections = [derivatives(curve)];
  const originalBound = Math.max(...sections[0].map(point => Math.hypot(...point)));
  if (!Number.isFinite(originalBound)) return Infinity;
  for (let depth = 0; depth < 3; depth++) sections = sections.flatMap(section => split(section));
  const bound = Math.max(...sections.flatMap(section => section.map(point => Math.hypot(...point))));
  return bound + originalBound * Number.EPSILON * 32;
}

function split(points: readonly Vec3[], t = 0.5): [Vec3[], Vec3[]] {
  let level = [...points];
  const left = [level[0]], right = [level[level.length - 1]];
  while (level.length > 1) {
    level = level.slice(0, -1).map((point, i) => combine(point, level[i + 1], t));
    left.push(level[0]); right.unshift(level[level.length - 1]);
  }
  return [left, right];
}

/** Preserve the exact future path and elapsed-time phase; completed curves have no remainder. */
export function remainingMovementCurve(curve: MovementCurve, time: number): MovementCurve | undefined {
  const t = parameter(curve, time);
  if (t === 1) return undefined;
  const [, right] = split(curve.controlPoints, t);
  return { controlPoints: right as unknown as CurveControlPoints, duration: curve.duration - Math.max(0, time) };
}
function hullDistance(points: readonly Vec3[], obstacle: Bounds3): number {
  const gaps = [0, 1, 2].map(axis => {
    const low = Math.min(...points.map(point => point[axis])), high = Math.max(...points.map(point => point[axis]));
    return Math.max(obstacle.min[axis] - high, low - obstacle.max[axis], 0);
  });
  return Math.hypot(...gaps);
}
function chordClear(points: readonly Vec3[], obstacle: Bounds3, clearance: number): boolean {
  const start = points[0], end = points[points.length - 1];
  const delta = end.map((value, i) => value - start[i]) as unknown as Vec3;
  const length = Math.hypot(...delta);
  if (!Number.isFinite(length) || length === 0) return false;
  const direction = delta.map(value => value / length) as unknown as Vec3;
  const flatness = Math.max(...points.map(point => {
    const projection = Math.max(0, Math.min(length, point.reduce((sum, value, i) => sum + (value - start[i]) * direction[i], 0)));
    return Math.hypot(...point.map((value, i) => value - start[i] - projection * direction[i]));
  }));
  const inflated = clearance + flatness;
  // Distance to a convex segment is convex, so every curve point is within
  // flatness of the chord. The entire inflated chord must clear the obstacle.
  return Number.isFinite(inflated) && Number.isFinite(Math.fround(length)) && Number.isFinite(Math.fround(inflated)) &&
    distanceToBounds(start, obstacle) > inflated && distanceToBounds(end, obstacle) > inflated &&
    firstObstacleDistance(start, direction, length, obstacle, inflated) === length;
}

/** Continuous, conservative certificate. Budget exhaustion never accepts a curve. */
export function certifyMovementCurve(curve: MovementCurve, domain: MovementDomain, obstacles: readonly Bounds3[], requiredDistance: number, options: CurveCertificateOptions = {}): boolean {
  validateCurve(curve);
  if (!Number.isFinite(requiredDistance) || requiredDistance < 0) throw new RangeError('Curve clearance must be nonnegative and finite');
  const maxDepth = options.maxDepth ?? 10, maxNodes = options.maxNodes ?? 127;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 65535) throw new RangeError('Invalid curve certificate budget');
  obstacles.forEach(obstacle => distanceToBounds(curve.controlPoints[0], obstacle));
  // Cover interpolation and distance arithmetic at every permitted split depth.
  // This guard supplements the caller's world/float32 movement padding.
  let curveScale = 1;
  for (const point of [...curve.controlPoints, domain.min, domain.max]) {
    for (const value of point) curveScale = Math.max(curveScale, Math.abs(value));
  }
  // Each distance calculation involves this curve and one obstacle only. Keep
  // its full coordinate-scale guard without letting a distant obstacle inflate
  // the clearance used for unrelated nearby obstacles. The loops are bounded
  // per box, so obstacle counts cannot exceed an engine's argument limit.
  const clearances = obstacles.map(obstacle => {
    let scale = curveScale;
    for (let axis = 0; axis < 3; axis++) scale = Math.max(scale, Math.abs(obstacle.min[axis]), Math.abs(obstacle.max[axis]));
    return requiredDistance + scale * Number.EPSILON * 1024;
  });
  // The prepared domain already includes movement padding. Preserve its strict
  // containment semantics so valid starts arbitrarily close to it can move inward.
  if (!pointInDomain(domain, curve.controlPoints[0]) || !pointInDomain(domain, curve.controlPoints[5])) return false;
  const pending = [{ points: curve.controlPoints as readonly Vec3[], depth: 0 }];
  let visited = 0;
  while (pending.length) {
    if (++visited > maxNodes) return false;
    const { points, depth } = pending.pop()!;
    const contained = points.every(point => pointInDomain(domain, point));
    const clear = obstacles.every((obstacle, i) => hullDistance(points, obstacle) > clearances[i] || chordClear(points, obstacle, clearances[i]));
    if (contained && clear) continue;
    if (depth >= maxDepth) return false;
    const [left, right] = split(points);
    pending.push({ points: right, depth: depth + 1 }, { points: left, depth: depth + 1 });
  }
  return true;
}
