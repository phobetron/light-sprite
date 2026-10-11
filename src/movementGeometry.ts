import { assertVec3 } from './math';
import type { Bounds3, Vec3 } from './types';

export type MovementBounds =
  | { shape: 'cube'; center: Vec3; size: Vec3 }
  | { shape: 'sphere'; center: Vec3; radius: number };
export interface MovementDomain {
  shape: 'cube' | 'sphere';
  center: Vec3;
  min: Vec3;
  max: Vec3;
  radius?: number;
}

function finiteFloat(value: number, name: string, positive = false): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || (positive && (value <= 0 || Math.fround(value) <= 0))) {
    throw new RangeError(`${name} must be ${positive ? 'positive and ' : ''}finite in float32`);
  }
}
function nonnegative(value: number, name: string): void {
  finiteFloat(value, name);
  if (value < 0) throw new RangeError(`${name} must be nonnegative`);
}
function validateBounds(bounds: Bounds3): void {
  if (!bounds) throw new RangeError('Obstacle bounds are required');
  assertVec3(bounds.min, 'bounds.min'); assertVec3(bounds.max, 'bounds.max');
  for (let i = 0; i < 3; i++) {
    finiteFloat(bounds.min[i], 'bounds.min'); finiteFloat(bounds.max[i], 'bounds.max');
    if (bounds.min[i] > bounds.max[i]) throw new RangeError('Bounds min must not exceed max');
  }
}
function validateRay(origin: Vec3, direction: Vec3): void {
  assertVec3(origin, 'origin'); assertVec3(direction, 'direction');
  if (Math.abs(Math.hypot(...direction) - 1) > 1e-6) throw new RangeError('Ray direction must be a unit vector');
}

export function normalizeMovementBounds(input: MovementBounds): MovementBounds {
  if (!input || (input.shape !== 'cube' && input.shape !== 'sphere')) throw new RangeError('Movement bounds require cube or sphere shape');
  assertVec3(input.center, 'center');
  input.center.forEach(value => finiteFloat(value, 'center'));
  const center: Vec3 = [...input.center];
  if (input.shape === 'sphere') {
    finiteFloat(input.radius, 'radius', true);
    center.forEach(value => { finiteFloat(value - input.radius, 'bounds extent'); finiteFloat(value + input.radius, 'bounds extent'); });
    return { shape: 'sphere', center, radius: input.radius };
  }
  assertVec3(input.size, 'size');
  input.size.forEach((value, i) => {
    finiteFloat(value, 'size', true);
    finiteFloat(center[i] - value / 2, 'bounds extent'); finiteFloat(center[i] + value / 2, 'bounds extent');
  });
  return { shape: 'cube', center, size: [...input.size] };
}

export function movementPadding(bounds: MovementBounds, markerRadius: number): number {
  nonnegative(markerRadius, 'markerRadius');
  const normalized = normalizeMovementBounds(bounds);
  const extents = normalized.shape === 'cube' ? normalized.size.map(value => value / 2) : [normalized.radius, normalized.radius, normalized.radius];
  const scale = Math.max(markerRadius, ...normalized.center.map((value, i) => Math.abs(value) + extents[i]));
  return Math.max(1e-6, scale * 2 ** -20);
}

export function prepareDomain(bounds: MovementBounds, markerRadius: number, padding: number): MovementDomain {
  const normalized = normalizeMovementBounds(bounds);
  nonnegative(markerRadius, 'markerRadius'); nonnegative(padding, 'padding');
  const inset = markerRadius + padding;
  const radius = normalized.shape === 'sphere' ? normalized.radius - inset : undefined;
  const half = normalized.shape === 'cube' ? normalized.size.map(value => value / 2 - inset) : [radius!, radius!, radius!];
  const min = normalized.center.map((value, i) => value - half[i]) as unknown as Vec3;
  const max = normalized.center.map((value, i) => value + half[i]) as unknown as Vec3;
  if (half.some(value => value <= 0) || min.some((value, i) => value >= max[i])) throw new RangeError('Movement bounds have no positive interior room for the marker');
  return { shape: normalized.shape, center: normalized.center, min, max, ...(radius === undefined ? {} : { radius }) };
}

export function distanceToBounds(point: Vec3, bounds: Bounds3): number {
  assertVec3(point, 'point'); validateBounds(bounds);
  return Math.hypot(...point.map((value, i) => Math.max(bounds.min[i] - value, 0, value - bounds.max[i])));
}

export function pointInDomain(domain: MovementDomain, point: Vec3): boolean {
  assertVec3(point, 'point');
  if (domain.shape === 'sphere') return Math.hypot(...point.map((value, i) => value - domain.center[i])) < domain.radius!;
  return point.every((value, i) => value > domain.min[i] && value < domain.max[i]);
}

export function rayDomainDistance(domain: MovementDomain, origin: Vec3, direction: Vec3): number {
  validateRay(origin, direction);
  if (!pointInDomain(domain, origin)) throw new RangeError('Ray origin must be strictly inside the movement domain');
  if (domain.shape === 'cube') {
    let exit = Infinity;
    for (let i = 0; i < 3; i++) {
      if (direction[i] !== 0) exit = Math.min(exit, ((direction[i] > 0 ? domain.max[i] : domain.min[i]) - origin[i]) / direction[i]);
    }
    return exit;
  }
  const relative = origin.map((value, i) => value - domain.center[i]);
  const a = direction.reduce((sum, value) => sum + value * value, 0);
  const b = relative.reduce((sum, value, i) => sum + value * direction[i], 0);
  const c = (Math.hypot(...relative) - domain.radius!) * (Math.hypot(...relative) + domain.radius!);
  const root = Math.sqrt(b * b - a * c);
  return b > 0 ? -c / (b + root) : (-b + root) / a;
}

/** Earliest contact with the rounded box; tangency is conservatively a contact. */
export function firstObstacleDistance(origin: Vec3, direction: Vec3, maxDistance: number, bounds: Bounds3, requiredDistance: number): number {
  validateRay(origin, direction); validateBounds(bounds);
  nonnegative(maxDistance, 'maxDistance'); nonnegative(requiredDistance, 'requiredDistance');
  if (distanceToBounds(origin, bounds) <= requiredDistance) return 0;
  let enter = 0, exit = maxDistance;
  for (let i = 0; i < 3; i++) {
    const low = bounds.min[i] - requiredDistance, high = bounds.max[i] + requiredDistance;
    if (direction[i] === 0) {
      if (origin[i] < low || origin[i] > high) return maxDistance;
    } else {
      const t1 = (low - origin[i]) / direction[i], t2 = (high - origin[i]) / direction[i];
      enter = Math.max(enter, Math.min(t1, t2)); exit = Math.min(exit, Math.max(t1, t2));
    }
  }
  if (enter > exit || enter >= maxDistance) return maxDistance;
  const splits = [enter, exit];
  for (let i = 0; i < 3; i++) if (direction[i] !== 0) {
    for (const face of [bounds.min[i], bounds.max[i]]) {
      const t = (face - origin[i]) / direction[i];
      if (t > enter && t < exit) splits.push(t);
    }
  }
  splits.sort((a, b) => a - b);
  for (let segment = 0; segment < splits.length - 1; segment++) {
    const start = splits[segment], length = splits[segment + 1] - start;
    let a = 0, b = 0, c = -requiredDistance * requiredDistance;
    for (let i = 0; i < 3; i++) {
      const middle = origin[i] + direction[i] * (start + length / 2);
      const face = middle < bounds.min[i] ? bounds.min[i] : middle > bounds.max[i] ? bounds.max[i] : undefined;
      if (face !== undefined) {
        const offset = origin[i] + direction[i] * start - face;
        a += direction[i] * direction[i]; b += offset * direction[i]; c += offset * offset;
      }
    }
    if (c <= 0) return start;
    if (a === 0 || b >= 0) continue;
    let discriminant = b * b - a * c;
    const error = 8 * Number.EPSILON * (b * b + Math.abs(a * c));
    if (discriminant < -error) continue;
    discriminant = Math.max(0, discriminant);
    // Here b < 0, so this form avoids subtracting nearly equal values.
    const contact = c / (-b + Math.sqrt(discriminant));
    if (contact >= 0 && contact <= length) return Math.min(maxDistance, start + contact);
  }
  // A zero-length broad phase interval may be a tangent contact.
  if (enter === exit && distanceToBounds(origin.map((value, i) => value + direction[i] * enter) as unknown as Vec3, bounds) <= requiredDistance) return enter;
  return maxDistance;
}
