/** Optional soft halo around a marker. */
export interface GlowOptions {
  /** World-space radius; default is 2.5 times the marker's widest extent. */
  radius?: number;
  /** Additive halo strength. Default: 0.6. */
  intensity?: number;
  /** Radial fading coefficient, greater values fade faster. Default: 4. */
  falloff?: number;
}
/** Seeded brightness variation, advanced explicitly in seconds. */
export interface FlickerOptions {
  /** Maximum dimming from steady brightness, in [0, 1]. Default: 0.35. */
  depth?: number;
  /** Smooth random keyframes per second. Default: 2. */
  speed?: number;
  /** Unsigned 32-bit seed for repeatable flicker. Default: 1. */
  seed?: number;
}
export interface ResolvedGlow {
  enabled: boolean;
  radius: number;
  intensity: number;
  falloff: number;
}
export interface ResolvedFlicker {
  enabled: boolean;
  depth: number;
  speed: number;
  seed: number;
}

function float32(value: number, name: string, positive: boolean): void {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || (positive ? value <= 0 || Math.fround(value) <= 0 : value < 0)) {
    throw new RangeError(`${name} must be a finite ${positive ? 'positive' : 'nonnegative'} float32 number`);
  }
}
function optionObject(input: unknown, name: string): void {
  if (input !== undefined && typeof input !== 'boolean' && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError(`${name} must be a boolean or options object`);
  }
}

/** Objects enable and merge options; booleans preserve previous numeric settings. */
export function resolveGlow(input: boolean | GlowOptions | undefined, defaultRadius: number, previous?: ResolvedGlow): ResolvedGlow {
  optionObject(input, 'glow');
  const base = previous ?? { enabled: false, radius: defaultRadius, intensity: 0.6, falloff: 4 };
  const options = typeof input === 'object' ? input : undefined;
  const result = {
    enabled: input !== undefined && input !== false,
    radius: options?.radius ?? base.radius,
    intensity: options?.intensity ?? base.intensity,
    falloff: options?.falloff ?? base.falloff,
  };
  float32(result.radius, 'glow.radius', true);
  float32(result.intensity, 'glow.intensity', false);
  float32(result.falloff, 'glow.falloff', true);
  return result;
}

/** Undefined disables; objects enable and merge; booleans preserve numeric settings. */
export function resolveFlicker(input: boolean | FlickerOptions | undefined, previous?: ResolvedFlicker): ResolvedFlicker {
  optionObject(input, 'flicker');
  const base = previous ?? { enabled: false, depth: 0.35, speed: 2, seed: 1 };
  const options = typeof input === 'object' ? input : undefined;
  const result = {
    enabled: input !== undefined && input !== false,
    depth: options?.depth ?? base.depth,
    speed: options?.speed ?? base.speed,
    seed: options?.seed ?? base.seed,
  };
  if (!Number.isFinite(result.depth) || result.depth < 0 || result.depth > 1) throw new RangeError('flicker.depth must be between zero and one');
  float32(result.speed, 'flicker.speed', true);
  if (!Number.isInteger(result.seed) || result.seed < 0 || result.seed > 0xffffffff) throw new RangeError('flicker.seed must be an unsigned 32-bit integer');
  return result;
}

const PERIOD = 0x100000000;
function noise(node: number, seed: number): number {
  // Node zero starts fully bright and makes the bounded phase periodic.
  if (node === 0) return 0;
  let hash = (node ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * Pure, explicitly advanced effect clock. Noise is smooth at keyframes and only dims.
 * Speed/depth edits preserve phase; enabling, restoring nonzero depth, or changing
 * seed restarts at brightness one. Disabled clocks do not accumulate elapsed time.
 */
export class FlickerClock {
  private options: ResolvedFlicker;
  private phase = 0;
  private compensation = 0;

  constructor(options: ResolvedFlicker) {
    this.options = resolveFlicker(options.enabled ? options : false, options);
  }

  get active(): boolean { return this.options.enabled && this.options.depth > 0; }
  get brightness(): number {
    if (!this.active) return 1;
    const node = Math.floor(this.phase);
    const fraction = this.phase - node;
    const smooth = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
    const first = noise(node, this.options.seed);
    const second = noise((node + 1) % PERIOD, this.options.seed);
    return Math.max(1 - this.options.depth, Math.min(1, 1 - this.options.depth * (first + (second - first) * smooth)));
  }

  set(options: ResolvedFlicker): void {
    const next = resolveFlicker(options.enabled ? options : false, options);
    const reset = !this.active || !next.enabled || next.depth === 0 || next.seed !== this.options.seed;
    this.options = next;
    if (reset) {
      this.phase = 0;
      this.compensation = 0;
    }
  }

  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be finite and nonnegative');
    if (!this.active || deltaSeconds === 0) return;
    const advance = deltaSeconds * this.options.speed;
    if (!Number.isFinite(advance)) throw new RangeError('deltaSeconds times flicker.speed must be finite');
    // Compensated accumulation avoids cadence-dependent drift. Reduce huge advances
    // before adding, so the phase stays bounded and the sum cannot overflow.
    const adjusted = (advance % PERIOD) - this.compensation;
    const sum = this.phase + adjusted;
    const compensation = (sum - this.phase) - adjusted;
    this.phase = sum >= PERIOD ? sum - PERIOD : sum < 0 ? sum + PERIOD : sum;
    this.compensation = compensation;
  }
}
