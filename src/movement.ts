import { assertVec3 } from './math';
import { distanceToBounds, firstObstacleDistance, movementPadding, normalizeMovementBounds, pointInDomain, prepareDomain, rayDomainDistance } from './movementGeometry';
import type { MovementBounds, MovementDomain } from './movementGeometry';
import type { Bounds3, Vec3 } from './types';
import { createMovementCurve, createMovementCurveEvaluator, movementCurveVelocity, movementCurveSpeedBound, certifyMovementCurve, remainingMovementCurve, type MovementCurve } from './movementCurve';

export type { MovementBounds } from './movementGeometry';
export interface MovementOptions {
  bounds: MovementBounds;
  /** Relative pace multiplier: 1 is normal, 0.5 is half pace, 2 is twice pace. */
  speed?: number;
  /** Maximum leg length; must be finite in float32 and exceed the domain's numerical padding. */
  distance?: number;
  seed?: number;
  /** Chance that a destination is a full stop. Default: 0.25. */
  stopProbability?: number;
  /** Fraction of reference pace used for random speed variation. Default: 0.45. */
  speedVariation?: number;
  /** Excess scaled movement time is discarded; defaults to 0.25 seconds. */
  maxDeltaSeconds?: number;
}
export interface ResolvedMovement {
  enabled: boolean;
  bounds: MovementBounds;
  speed: number;
  distance: number;
  seed: number;
  stopProbability: number;
  speedVariation: number;
  maxDeltaSeconds: number;
}
export interface MovementSphere { center: Vec3; radius: number; clearance: number }
export interface MovementController {
  readonly position: Vec3;
  readonly active: boolean;
  readonly options: Readonly<ResolvedMovement>;
  readonly sphere: MovementSphere;
  /** Internal planning diagnostics; snapshots cannot mutate the controller. */
  readonly plan: Readonly<Leg>;
  update(deltaSeconds: number): void;
  setPosition(origin: Vec3): void;
  setOptions(input: boolean | Partial<MovementOptions>): void;
  setObstacles(bounds: readonly Bounds3[], commit?: boolean): void;
}

const copy = (v: Vec3): Vec3 => [v[0], v[1], v[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
interface TargetIntent { speed: number; stop: boolean }
interface Leg { intent: TargetIntent; nextIntent: TargetIntent; curve: MovementCurve; elapsed: number; tail?: MovementCurve; restart?: MovementCurve; target: Vec3; lookahead: Vec3; stop: boolean; fallback: boolean }
const referenceSpeed = 0.8;
const zero: Vec3 = [0, 0, 0];
const scale = (v: Vec3, factor: number): Vec3 => [v[0] * factor, v[1] * factor, v[2] * factor];
const unit = (v: Vec3): Vec3 => scale(v, 1 / Math.hypot(...v));
const length = (v: Vec3): number => Math.hypot(...v);
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
  return value;
}
function resolve(input: Partial<MovementOptions>, previous?: ResolvedMovement): ResolvedMovement {
  if (!input || typeof input !== 'object') throw new RangeError('Movement options are required');
  const bounds = normalizeMovementBounds(input.bounds ?? previous?.bounds!);
  const speed = positive(input.speed ?? previous?.speed ?? 1, 'Movement speed');
  if (!Number.isFinite(Math.fround(speed)) || Math.fround(speed) <= 0) throw new RangeError('Movement speed must be positive and finite in float32');
  const distance = positive(input.distance ?? previous?.distance ?? 2, 'Movement distance');
  if (!Number.isFinite(Math.fround(distance)) || Math.fround(distance) <= 0) throw new RangeError('Movement distance must be positive and finite in float32');
  const seed = input.seed ?? previous?.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Movement seed must be a uint32');
  const maxDeltaSeconds = positive(input.maxDeltaSeconds ?? previous?.maxDeltaSeconds ?? 0.25, 'Movement maxDeltaSeconds');
  if (maxDeltaSeconds > 1) throw new RangeError('Movement maxDeltaSeconds must not exceed one second');
  const stopProbability = input.stopProbability ?? previous?.stopProbability ?? 0.25;
  const speedVariation = input.speedVariation ?? previous?.speedVariation ?? 0.45;
  for (const [name, value] of [['stopProbability', stopProbability], ['speedVariation', speedVariation]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`Movement ${name} must be in [0, 1]`);
  }
  return { enabled: true, bounds, speed, distance, seed, maxDeltaSeconds, stopProbability, speedVariation };
}
function cloneObstacles(bounds: readonly Bounds3[]): Bounds3[] {
  if (!Array.isArray(bounds)) throw new RangeError('Movement obstacles must be an array');
  return bounds.map((bound: Bounds3) => {
    if (!bound) throw new RangeError('Movement obstacle bounds are required');
    assertVec3(bound.min, 'obstacle.min'); assertVec3(bound.max, 'obstacle.max');
    if (bound.min.some((value, axis) => value > bound.max[axis])) throw new RangeError('Obstacle min must not exceed max');
    return { min: copy(bound.min), max: copy(bound.max) };
  });
}

/** Wanders inside the consumer's domain using conservative world AABB obstacle proxies. */
export function createMovement(options: MovementOptions, enclosure: { center: Vec3; radius: number }, origin: Vec3, obstacles: readonly Bounds3[]): MovementController {
  assertVec3(enclosure.center, 'Movement enclosure center');
  const localCenter = copy(enclosure.center);
  const radius = positive(enclosure.radius, 'Movement enclosure radius');
  let settings = resolve(options);
  let field = cloneObstacles(obstacles);
  let domain: MovementDomain;
  let requiredDistance: number;
  let position = copy(origin);
  const evaluateCurve = createMovementCurveEvaluator();
  let randomState = settings.seed;
  let leg: Leg | undefined;


  function geometry(next: ResolvedMovement): { domain: MovementDomain; requiredDistance: number } {
    const pad = Math.max(movementPadding(next.bounds, radius), Math.max(...localCenter.map(Math.abs)) * Number.EPSILON * 64);
    if (next.distance <= pad) throw new RangeError('Movement distance must exceed the bounds numerical padding');
    const requiredDistance = 1.2 * radius + pad;
    if (!Number.isFinite(requiredDistance)) throw new RangeError('Movement clearance exceeds finite range');
    const domain = prepareDomain(next.bounds, radius, pad);
    const longestLeg = Math.min(next.distance, Math.hypot(...subtract(domain.max, domain.min)));
    if (!Number.isFinite(1.875 * longestLeg / referenceSpeed)) throw new RangeError('Movement speed is too small for a finite leg duration');
    return { domain, requiredDistance };
  }
  function validate(nextOrigin: Vec3, nextDomain: MovementDomain, nextField: readonly Bounds3[], clearance: number): Vec3 {
    assertVec3(nextOrigin, 'Movement position');
    const center = add(nextOrigin, localCenter);
    assertVec3(center, 'Movement world center');
    if (!pointInDomain(nextDomain, center)) throw new RangeError('Movement enclosure must fit strictly inside its bounds');
    if (nextField.some(box => distanceToBounds(center, box) <= clearance)) throw new RangeError('Movement enclosure violates obstacle clearance');
    return center;
  }
  ({ domain, requiredDistance } = geometry(settings));
  validate(position, domain, field, requiredDistance);

  // Candidate preparation is transactional, including its private PRNG state.
  function prepareLeg(nextOrigin: Vec3, next: ResolvedMovement, nextDomain: MovementDomain, nextField: readonly Bounds3[], clearance: number, state: number, startVelocity: Vec3 = zero, preferred?: Vec3, intent?: TargetIntent): { leg: Leg; randomState: number } {
    const start = validate(nextOrigin, nextDomain, nextField, clearance);
    function random(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    }
    function randomDirection(): Vec3 {
      const z = 2 * random() - 1, angle = 2 * Math.PI * random(), radial = Math.sqrt(Math.max(0, 1 - z * z));
      return [radial * Math.cos(angle), radial * Math.sin(angle), z];
    }
    function prefix(point: Vec3, direction: Vec3): number {
      let result = Math.min(next.distance, rayDomainDistance(nextDomain, point, direction));
      for (const box of nextField) result = Math.min(result, firstObstacleDistance(point, direction, result, box, clearance));
      return result;
    }
    // Round through the consumer's origin representation before certifying.
    const rounded = (center: Vec3): Vec3 => add(subtract(center, localCenter), localCenter);
    function ray(point: Vec3, direction: Vec3, fraction: number): Vec3 {
      return rounded(add(point, scale(direction, prefix(point, direction) * fraction)));
    }
    function accepted(curve: MovementCurve): boolean {
      const polygon = curve.controlPoints.slice(1).reduce((sum, point, i) => sum + length(subtract(point, curve.controlPoints[i])), 0);
      return polygon > 0 && polygon <= next.distance && movementCurveSpeedBound(curve) <= referenceSpeed * (1 + 1e-12) && certifyMovementCurve(curve, nextDomain, nextField, clearance);
    }
    const validCenter = (point: Vec3): boolean => point.every(Number.isFinite) && pointInDomain(nextDomain, point) && nextField.every(box => distanceToBounds(point, box) > clearance);
    const desiredSpeed = intent?.speed ?? referenceSpeed * (1 - next.speedVariation * random());
    const stop = intent?.stop ?? random() < next.stopProbability;
    const nextIntent = { speed: referenceSpeed * (1 - next.speedVariation * random()), stop: random() < next.stopProbability };
    const fraction = 0.2 + 0.4 * random();
    const directions: Vec3[] = [randomDirection()];
    if (preferred && length(subtract(preferred, start)) > 0) directions.unshift(unit(subtract(preferred, start)));
    // A fixed, bounded set of local alternatives keeps sealed pockets wandering.
    directions.push(randomDirection(), randomDirection(), unit(subtract(nextDomain.center, start)));
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const direction: [number, number, number] = [0, 0, 0]; direction[axis] = sign; directions.push(direction);
    }
    for (const [index, direction] of (preferred ? directions.slice(0, 1) : directions).entries()) {
      if (!direction.every(Number.isFinite)) continue;
      const target = preferred && index === 0 ? copy(preferred) : ray(start, direction, fraction);
      const chord = length(subtract(target, start));
      if (!Number.isFinite(chord) || chord === 0 || !validCenter(target)) continue;
      const outgoing = randomDirection();
      const lookahead = ray(target, outgoing, 0.4);
      if (!validCenter(lookahead) || length(subtract(lookahead, target)) === 0) continue;
      const headingSum = add(unit(subtract(target, start)), outgoing);
      const heading = length(headingSum) > 1e-8 ? unit(headingSum) : outgoing;
      const available = prefix(target, heading);
      // A half-second straight braking reserve has hull velocities [v,v,0,0,0].
      // Its length is 0.2*v, so it is certified before approaching a moving join.
      const joinSpeed = stop ? 0 : Math.min(Math.min(desiredSpeed, nextIntent.speed) * 0.45, available * 2, next.distance * 0.5, length(subtract(lookahead, target)) * (nextIntent.stop ? 0.5 : 1));
      if (!stop && joinSpeed <= 0) continue;
      const endVelocity = scale(heading, joinSpeed);
      const tailEnd = rounded(add(target, scale(endVelocity, 0.2)));
      const tail = joinSpeed > 0 ? createMovementCurve(target, tailEnd, endVelocity, zero, 0.5) : undefined;
      if (tail && !accepted(tail)) continue;
      // Timing affects control points. Certify only after duration is fixed.
      for (const timing of [2, 3, 5]) {
        const duration = Math.max(0.5, timing * chord / desiredSpeed);
        if (!Number.isFinite(duration)) continue;
        const curve = createMovementCurve(start, target, startVelocity, endVelocity, duration);
        if (!accepted(curve) || movementCurveSpeedBound(curve) > desiredSpeed * (1 + 1e-12)) continue;
        // Every planned stop also reserves a positive rest-to-rest departure.
        const restart = stop ? createMovementCurve(target, start, zero, zero, Math.max(0.5, 2 * chord / referenceSpeed)) : undefined;
        if (restart && !accepted(restart)) continue;
        return { leg: { restart, intent: { speed: desiredSpeed, stop }, nextIntent, curve, elapsed: 0, tail, target, lookahead, stop, fallback: false }, randomState: state };
      }
    }
    // At initialization and explicit restarts, nonzero waypoint handles may be
    // unrepresentable even though a positive safe straight departure exists.
    // This approved stop fallback uses the same bounded local directions and
    // private random state, and reserves its certified return before committing.
    if (!preferred && length(startVelocity) === 0) {
      for (const direction of directions) {
        if (!direction.every(Number.isFinite)) continue;
        for (const fallbackFraction of [fraction, 0.5, 0.8]) {
          const target = ray(start, direction, fallbackFraction);
          const chord = length(subtract(target, start));
          if (!Number.isFinite(chord) || chord === 0 || !validCenter(target)) continue;
          const duration = Math.max(0.5, 2 * chord / desiredSpeed);
          if (!Number.isFinite(duration)) continue;
          const curve = createMovementCurve(start, target, zero, zero, duration);
          const restart = createMovementCurve(target, start, zero, zero, duration);
          if (!accepted(curve) || !accepted(restart) || movementCurveSpeedBound(curve) > desiredSpeed * (1 + 1e-12)) continue;
          return { leg: { curve, restart, elapsed: 0, target, lookahead: copy(start), stop: true, fallback: true, intent: { speed: desiredSpeed, stop: true }, nextIntent }, randomState: state };
        }
      }
    }
    throw new RangeError('Movement precision cannot represent a safe positive leg from this position');
  }
  function plan(startVelocity: Vec3 = zero, preferred?: Vec3, intent?: TargetIntent): void {
    const prepared = prepareLeg(position, settings, domain, field, requiredDistance, randomState, startVelocity, preferred, intent);
    leg = prepared.leg; randomState = prepared.randomState;
  }
  plan();
  const snapshotCurve = (curve: MovementCurve): MovementCurve => ({ duration: curve.duration, controlPoints: curve.controlPoints.map(copy) as unknown as MovementCurve['controlPoints'] });

  return {
    get position() { return copy(position); },
    get active() { return settings.enabled; },
    get options() { return { ...settings, bounds: normalizeMovementBounds(settings.bounds) }; },
    get sphere() { return { center: add(position, localCenter), radius, clearance: 0.2 * radius }; },
    get plan() { const current = leg!; return { ...current, intent: { ...current.intent }, nextIntent: { ...current.nextIntent }, curve: snapshotCurve(current.curve), tail: current.tail && snapshotCurve(current.tail), restart: current.restart && snapshotCurve(current.restart), target: copy(current.target), lookahead: copy(current.lookahead) }; },
    update(deltaSeconds) {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('Movement deltaSeconds must be finite and nonnegative');
      if (!settings.enabled || deltaSeconds === 0) return;
      let remaining = Math.min(deltaSeconds, settings.maxDeltaSeconds / settings.speed) * settings.speed;
      while (remaining > 0) {
        const current = leg!;
        const step = Math.min(remaining, current.curve.duration - current.elapsed);
        current.elapsed += step; remaining -= step;
        position = subtract(evaluateCurve(current.curve, current.elapsed), localCenter);
        if (current.elapsed >= current.curve.duration) {
          position = subtract(current.target, localCenter);
          const velocity = movementCurveVelocity(current.curve, current.curve.duration);
          try { if (current.fallback) plan(velocity); else plan(velocity, current.lookahead, current.nextIntent); }
          catch (error) {
            if (!current.tail) {
              const restart = current.restart;
              if (!restart) throw error;
              leg = { ...current, curve: restart, elapsed: 0, target: copy(restart.controlPoints[5]), restart: createMovementCurve(restart.controlPoints[5], restart.controlPoints[0], zero, zero, restart.duration), stop: true, fallback: true };
              continue;
            }
            const tail = current.tail;
            leg = { restart: createMovementCurve(tail.controlPoints[5], tail.controlPoints[0], zero, zero, tail.duration), intent: current.intent, nextIntent: current.nextIntent, curve: tail, elapsed: 0, target: copy(tail.controlPoints[5]), lookahead: current.lookahead, stop: true, fallback: true };
          }
        }
      }
    },
    setPosition(nextOrigin) {
      const prepared = prepareLeg(nextOrigin, settings, domain, field, requiredDistance, randomState);
      position = copy(nextOrigin); leg = prepared.leg; randomState = prepared.randomState;
    },
    setOptions(input) {
      if (typeof input === 'boolean') { settings = { ...settings, enabled: input }; return; }
      const next = resolve(input, settings);
      if (Object.keys(input).every(key => key === 'speed')) { settings = next; return; }
      const nextGeometry = geometry(next);
      const prepared = prepareLeg(position, next, nextGeometry.domain, field, nextGeometry.requiredDistance, next.seed !== settings.seed ? next.seed : randomState);
      settings = next; domain = nextGeometry.domain; requiredDistance = nextGeometry.requiredDistance;
      leg = prepared.leg; randomState = prepared.randomState;
    },
    setObstacles(bounds, commit = true) {
      const next = cloneObstacles(bounds);
      validate(position, domain, next, requiredDistance);
      // Recertification preserves phase, target identity, velocity and random state.
      const remaining = remainingMovementCurve(leg!.curve, leg!.elapsed);
      if ((remaining && !certifyMovementCurve(remaining, domain, next, requiredDistance)) || (leg!.tail && !certifyMovementCurve(leg!.tail, domain, next, requiredDistance)) || (leg!.restart && !certifyMovementCurve(leg!.restart, domain, next, requiredDistance))) {
        throw new RangeError('Movement precision cannot certify the current path and braking reserve after obstacle changes');
      }
      if (commit) field = next;
    },
  };
}
