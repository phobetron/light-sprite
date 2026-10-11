import type { Mat4, Vec3 } from './types';

export function assertVec3(value: Vec3, name: string): void {
  if (!value || value.length !== 3 || !Array.from(value).every(Number.isFinite)) {
    throw new RangeError(`${name} must contain three finite numbers`);
  }
}
export function assertMatrix(value: Mat4, name = 'matrix'): void {
  if (!value || value.length !== 16 || !Array.from(value).every(Number.isFinite)) {
    throw new RangeError(`${name} must contain sixteen finite numbers`);
  }
}
export function identityMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
export function translationMatrix(position: Vec3): Float32Array {
  assertVec3(position, 'position');
  const result = identityMatrix();
  result.set(position, 12);
  assertMatrix(result);
  return result;
}
export function multiplyMatrices(a: Mat4, b: Mat4): Float32Array {
  assertMatrix(a, 'a');
  assertMatrix(b, 'b');
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      result[column * 4 + row] = sum;
    }
  }
  assertMatrix(result);
  return result;
}
export function perspectiveMatrix(fovY: number, aspect: number, near: number, far: number): Float32Array {
  if (![fovY, aspect, near, far].every(Number.isFinite) || fovY <= 0 || fovY >= Math.PI || aspect <= 0 || near <= 0 || far <= near) {
    throw new RangeError('Perspective requires 0 < fovY < PI, aspect > 0 and 0 < near < far');
  }
  const f = 1 / Math.tan(fovY / 2);
  const result = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
  assertMatrix(result);
  return result;
}
export function lookAtMatrix(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Float32Array {
  assertVec3(eye, 'eye'); assertVec3(target, 'target'); assertVec3(up, 'up');
  const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(...v);
    if (!Number.isFinite(length) || length === 0) throw new RangeError('Camera direction and up must define a finite basis');
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(normalize(up), z));
  const y = cross(z, x);
  const result = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  assertMatrix(result);
  return result;
}
