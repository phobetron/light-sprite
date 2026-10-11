import { describe, expect, it } from '@rstest/core';
import { FlickerClock, resolveFlicker, resolveGlow } from '../../src/effects';

const clock = (seed = 42) => new FlickerClock(resolveFlicker({ seed }));

describe('effect configuration', () => {
  it('defaults to disabled effects and enables sensible defaults explicitly', () => {
    expect(resolveGlow(undefined, 5)).toEqual({ enabled: false, radius: 5, intensity: 0.6, falloff: 4 });
    expect(resolveGlow(true, 5).enabled).toBe(true);
    expect(resolveFlicker(undefined)).toEqual({ enabled: false, depth: 0.35, speed: 2, seed: 1 });
    expect(resolveFlicker(true).enabled).toBe(true);
  });

  it('preserves options across toggles and merges partial objects', () => {
    const glow = resolveGlow({ radius: 9, intensity: 2, falloff: 3 }, 5);
    expect(resolveGlow(false, 5, glow)).toEqual({ ...glow, enabled: false });
    expect(resolveGlow(true, 5, glow)).toEqual(glow);
    expect(resolveGlow({ intensity: 0 }, 5, glow)).toEqual({ ...glow, intensity: 0 });
    const flicker = resolveFlicker({ depth: 0.8, speed: 3, seed: 123 });
    expect(resolveFlicker(false, flicker)).toEqual({ ...flicker, enabled: false });
    expect(resolveFlicker(true, flicker)).toEqual(flicker);
    expect(resolveFlicker({ speed: 4 }, flicker)).toEqual({ ...flicker, speed: 4 });
  });

  it('rejects invalid ranges and float32 overflow or positive underflow', () => {
    for (const value of [-1, 0, NaN, Infinity, Number.MAX_VALUE, Number.MIN_VALUE]) {
      expect(() => resolveGlow({ radius: value }, 5)).toThrow();
      expect(() => resolveGlow({ falloff: value }, 5)).toThrow();
      expect(() => resolveFlicker({ speed: value })).toThrow();
    }
    for (const value of [-1, NaN, Infinity, Number.MAX_VALUE]) expect(() => resolveGlow({ intensity: value }, 5)).toThrow();
    for (const value of [-0.1, 1.1, NaN, Infinity]) expect(() => resolveFlicker({ depth: value })).toThrow();
    for (const value of [-1, 1.5, NaN, Infinity, 0x100000000]) expect(() => resolveFlicker({ seed: value })).toThrow();
    expect(resolveFlicker({ seed: 0xffffffff, depth: 1 }).seed).toBe(0xffffffff);
    expect(resolveGlow({ radius: Math.fround(3.4e38), intensity: 0 }, 5).radius).toBe(Math.fround(3.4e38));
  });
});

describe('deterministic effect clock', () => {
  it('starts bright, stays in bounds, and has irregular seed-dependent variation', () => {
    const first = clock(), second = clock(7);
    expect(first.brightness).toBe(1);
    const values: number[] = [];
    let differs = false;
    for (let i = 0; i < 300; i++) {
      first.update(0.05);
      second.update(0.05);
      expect(first.brightness).toBeGreaterThanOrEqual(0.65);
      expect(first.brightness).toBeLessThanOrEqual(1);
      values.push(first.brightness);
      differs ||= first.brightness !== second.brightness;
    }
    expect(differs).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(200);
  });

  it('is exactly deterministic across binary and decimal cadences', () => {
    const one = clock(), many = clock(), decimal = clock();
    one.update(4);
    for (let i = 0; i < 256; i++) many.update(1 / 64);
    for (let i = 0; i < 240; i++) decimal.update(1 / 60);
    expect(many.brightness).toBe(one.brightness);
    expect(decimal.brightness).toBe(one.brightness);
    one.update(0.125);
    many.update(0.125);
    decimal.update(0.125);
    expect(many.brightness).toBe(one.brightness);
    expect(decimal.brightness).toBe(one.brightness);
  });

  it('is smooth on startup and across keyframes', () => {
    const initial = clock();
    initial.update(0.00001);
    expect(initial.brightness).toBeCloseTo(1, 12);
    for (let frame = 1; frame < 10; frame++) {
      const left = clock(), center = clock(), right = clock();
      left.update(frame / 2 - 0.00001);
      center.update(frame / 2);
      right.update(frame / 2 + 0.00001);
      expect(left.brightness).toBeCloseTo(center.brightness, 12);
      expect(right.brightness).toBeCloseTo(center.brightness, 12);
    }
  });

  it('resets when toggled or reseeded and preserves phase across depth and speed changes', () => {
    const effect = clock();
    effect.update(0.4);
    const value = effect.brightness;
    effect.set(resolveFlicker({ speed: 4, seed: 42 }));
    expect(effect.brightness).toBe(value);
    effect.set(resolveFlicker({ depth: 0.7, speed: 4, seed: 42 }));
    expect(effect.brightness).toBeCloseTo(1 - 2 * (1 - value), 14);
    effect.set(resolveFlicker(false));
    expect(effect.active).toBe(false);
    expect(effect.brightness).toBe(1);
    effect.update(100);
    effect.set(resolveFlicker({ seed: 42 }));
    expect(effect.brightness).toBe(1);
    effect.update(0.4);
    effect.set(resolveFlicker({ seed: 7 }));
    expect(effect.brightness).toBe(1);
    effect.set(resolveFlicker({ depth: 0 }));
    expect(effect.active).toBe(false);
    expect(effect.brightness).toBe(1);
    effect.set(resolveFlicker({ depth: 0.35 }));
    expect(effect.active).toBe(true);
    expect(effect.brightness).toBe(1);
  });

  it('rejects invalid updates and configurations atomically, and handles huge finite advances', () => {
    const first = clock(), reference = clock();
    first.update(0.25);
    reference.update(0.25);
    for (const value of [-1, NaN, Infinity, Number.MAX_VALUE]) {
      expect(() => first.update(value)).toThrow();
      expect(first.brightness).toBe(reference.brightness);
    }
    expect(() => first.set({ ...resolveFlicker(true), speed: Infinity })).toThrow();
    first.update(0.25);
    reference.update(0.25);
    expect(first.brightness).toBe(reference.brightness);
    first.update(Number.MAX_VALUE / 4);
    expect(Number.isFinite(first.brightness)).toBe(true);
    first.update(0.125);
    expect(first.brightness).toBeGreaterThanOrEqual(0.65);
    expect(first.brightness).toBeLessThanOrEqual(1);
  });
});
