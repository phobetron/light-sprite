import { describe, expect, it } from '@rstest/core';
import { createLightSpriteMaterial } from '../../src/material';
import type { MaterialOptions } from '../../src/material';
import { createLightingGLSL, LIGHT_SPRITE_GLSL } from '../../src/lighting';

describe('material configuration', () => {
  it('resolves linear surface defaults without GPU resources', () => {
    expect(createLightSpriteMaterial()).toEqual({ baseColor: [1, 1, 1], roughness: 0.5, specularReflectance: [0.04, 0.04, 0.04] });
    expect(createLightSpriteMaterial({ baseColor: [0.2, 0.4, 0.6], specularReflectance: 0.08 })).toEqual({
      baseColor: [0.2, 0.4, 0.6], roughness: 0.5, specularReflectance: [0.08, 0.08, 0.08],
    });
  });

  it('copies input vectors and creates independent defaults', () => {
    const baseColor: [number, number, number] = [0.2, 0.4, 0.6];
    const specularReflectance: [number, number, number] = [0.1, 0.2, 0.3];
    const material = createLightSpriteMaterial({ baseColor, specularReflectance });
    baseColor[0] = 1;
    specularReflectance[0] = 1;
    expect(material.baseColor).toEqual([0.2, 0.4, 0.6]);
    expect(material.specularReflectance).toEqual([0.1, 0.2, 0.3]);
    const first = createLightSpriteMaterial(), second = createLightSpriteMaterial();
    expect(first.baseColor).not.toBe(second.baseColor);
    expect(first.specularReflectance).not.toBe(second.specularReflectance);
  });

  it('accepts zero and one without remapping CPU roughness or reflectance', () => {
    expect(createLightSpriteMaterial({ roughness: 0, baseColor: [0, 1, 0], specularReflectance: 0 })).toEqual({
      baseColor: [0, 1, 0], roughness: 0, specularReflectance: [0, 0, 0],
    });
    expect(createLightSpriteMaterial({ roughness: 1, specularReflectance: [0, 0.5, 1] }).specularReflectance).toEqual([0, 0.5, 1]);
    expect(createLightSpriteMaterial({ specularReflectance: 1 }).specularReflectance).toEqual([1, 1, 1]);
  });

  it('rejects nonfinite and out-of-range components', () => {
    for (const value of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => createLightSpriteMaterial({ roughness: value })).toThrow();
      expect(() => createLightSpriteMaterial({ specularReflectance: value })).toThrow();
      for (let component = 0; component < 3; component++) {
        const vector: [number, number, number] = [0, 0, 0];
        vector[component] = value;
        expect(() => createLightSpriteMaterial({ baseColor: vector })).toThrow();
        expect(() => createLightSpriteMaterial({ specularReflectance: vector })).toThrow();
      }
    }
  });

  it('rejects malformed runtime inputs rather than silently defaulting them', () => {
    for (const options of [null, false, [], { roughness: null }, { baseColor: null }, { baseColor: [1, 1] },
      { baseColor: [1, 1, 1, 1] }, { baseColor: ['1', 1, 1] }, { specularReflectance: null }]) {
      expect(() => createLightSpriteMaterial(options as unknown as MaterialOptions)).toThrow();
    }
  });
});

describe('lighting GLSL composition', () => {
  it('provides the same material and sampling API with and without shadow resources', () => {
    for (const shadows of [false, true]) {
      const source = createLightingGLSL(shadows);
      expect(source).toContain('struct LightSpriteMaterial');
      expect(source).toContain('struct LightSpriteLightSample');
      expect(source).toContain('LightSpriteLightSample lightSpriteSample(');
      expect(source).toContain('float lightSpriteShadowVisibility(');
      expect(source).toContain('vec3 viewDirection)');
      expect(source.includes('uniform highp samplerCube')).toBe(shadows);
    }
    expect(LIGHT_SPRITE_GLSL).toBe(createLightingGLSL(false));
  });
});
