import { describe, expect, it } from '@rstest/core';
import { boundsSphere, computeBounds, transformBounds, unionBounds } from '../../src/bounds';
import { identityMatrix, lookAtMatrix, multiplyMatrices, perspectiveMatrix, translationMatrix } from '../../src/math';

describe('bounds and matrix contracts', () => {
  it('uses indexed draw ranges and interleaved offsets in elements', () => {
    expect(computeBounds({ positions: [99, 1, 2, 3, 99, -4, 5, 6, 99, 100, 100, 100], stride: 4, offset: 1, indices: [2, 1, 0], start: 1, count: 2 })).toEqual({ min: [-4, 2, 3], max: [1, 5, 6] });
    expect(computeBounds({ positions: [99, 99, 99, 1, 2, 3], start: 1 })).toEqual({ min: [1, 2, 3], max: [1, 2, 3] });
  });

  it('transforms all corners through parent rotation, scale and shear', () => {
    const parent = [0, 2, 0, 0, -3, 1, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1];
    const matrix = multiplyMatrices(parent, translationMatrix([1, 2, 3]));
    expect(transformBounds({ min: [-1, -2, -3], max: [1, 2, 3] }, matrix)).toEqual({ min: [-2, 20, 30], max: [10, 28, 54] });
  });

  it('unions bounds and encloses their corners in a sphere', () => {
    const bounds = unionBounds([{ min: [0, 1, 2], max: [1, 2, 3] }, { min: [-2, -3, -4], max: [2, 3, 4] }]);
    expect(bounds).toEqual({ min: [-2, -3, -4], max: [2, 3, 4] });
    expect(boundsSphere(bounds)).toEqual({ center: [0, 0, 0], radius: Math.sqrt(29) });
  });

  it('rejects empty, malformed and nonfinite inputs', () => {
    for (const source of [{ positions: [] }, { positions: [0, 0, NaN] }, { positions: [0, 0, 0], indices: [-1] }, { positions: [0, 0, 0], indices: [1] }, { positions: [0, 0, 0], count: 0 }, { positions: [0, 0, 0], stride: 2 }, { positions: [0, 0, 0], start: 2 }]) expect(() => computeBounds(source)).toThrow();
    expect(() => unionBounds([])).toThrow();
    expect(() => boundsSphere({ min: [2, 0, 0], max: [1, 0, 0] })).toThrow();
    expect(() => transformBounds({ min: [0, 0, 0], max: [1, 1, 1] }, perspectiveMatrix(1, 1, 1, 100))).toThrow();
  });

  it('computes view and projection matrices with correct conventions', () => {
    const view = lookAtMatrix([0, 0, 5], [0, 0, 0]);
    translationMatrix([0, 0, -5]).forEach((value, index) => expect(view[index]).toBeCloseTo(value));
    expect(Array.from(multiplyMatrices(identityMatrix(), translationMatrix([1, 2, 3])))).toEqual(Array.from(translationMatrix([1, 2, 3])));
    const projection = perspectiveMatrix(Math.PI / 2, 2, 1, 11);
    expect(projection[0]).toBeCloseTo(0.5);
    expect(projection[5]).toBeCloseTo(1);
    expect(projection[10]).toBeCloseTo(-1.2);
    expect(projection[14]).toBeCloseTo(-2.2);
    expect(() => lookAtMatrix([0, 0, 0], [0, 0, 0])).toThrow();
    expect(() => lookAtMatrix([0, 1, 0], [0, 0, 0])).toThrow();
    expect(() => perspectiveMatrix(0, 1, 1, 10)).toThrow();
  });
});
