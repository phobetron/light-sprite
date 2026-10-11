import { describe, expect, it } from '@rstest/core';
import { CAMERA_TARGET, INITIAL_EYE, OrbitCamera } from '../../examples/orbitCamera';

const distance = (eye: readonly number[]) => Math.hypot(...eye.map((value, index) => value - CAMERA_TARGET[index]));

describe('orbit camera', () => {
  it('starts at the oblique view and resets after orbiting', () => {
    const camera = new OrbitCamera();
    camera.eye.forEach((value, index) => expect(value).toBeCloseTo(INITIAL_EYE[index], 10));
    camera.orbit(150, 30);
    expect(camera.eye).not.toEqual(INITIAL_EYE);
    camera.reset();
    camera.eye.forEach((value, index) => expect(value).toBeCloseTo(INITIAL_EYE[index], 10));
  });

  it('preserves distance and keeps the view above the floor and away from the pole', () => {
    const camera = new OrbitCamera();
    const radius = distance(camera.eye);
    for (const delta of [100000, -100000]) {
      camera.orbit(9000, delta);
      const eye = camera.eye;
      expect(distance(eye)).toBeCloseTo(radius, 10);
      expect(Math.hypot(eye[0] - CAMERA_TARGET[0], eye[2] - CAMERA_TARGET[2])).toBeGreaterThan(0.5);
      expect(eye[1]).toBeGreaterThan(CAMERA_TARGET[1]);
      expect(eye.every(Number.isFinite)).toBe(true);
    }
  });

  it('ignores nonfinite input', () => {
    const camera = new OrbitCamera();
    const initial = camera.eye;
    camera.orbit(Infinity, 10);
    camera.orbit(10, NaN);
    expect(camera.eye).toEqual(initial);
  });
});

