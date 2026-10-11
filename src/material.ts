import type { MutableVec3, Vec3 } from './types';

/** Renderer-independent surface parameters for the material-aware GLSL helpers. */
export interface MaterialOptions {
  /** Linear RGB diffuse color in [0, 1]. Default: white. */
  baseColor?: Vec3;
  /** Perceptual roughness in [0, 1]; lower values give sharper highlights. Default: 0.5. */
  roughness?: number;
  /** Normal-incidence specular reflectance in [0, 1]. Default: 0.04 per channel. */
  specularReflectance?: number | Vec3;
}

export interface LightSpriteMaterial {
  baseColor: Vec3;
  roughness: number;
  specularReflectance: Vec3;
}

/** Validated, detached arrays returned by the material factory. */
export interface LightSpriteMaterialSnapshot extends LightSpriteMaterial {
  baseColor: MutableVec3;
  specularReflectance: MutableVec3;
}

function unit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be finite and between zero and one`);
  return value;
}
function color(value: Vec3, name: string): MutableVec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must contain three components`);
  return [unit(value[0], name), unit(value[1], name), unit(value[2], name)];
}

/** Validate and copy CPU values. This does not allocate or bind GPU resources. */
export function createLightSpriteMaterial(options: MaterialOptions = {}): LightSpriteMaterialSnapshot {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('material must be an options object');
  const reflectance = options.specularReflectance === undefined ? 0.04 : options.specularReflectance;
  return {
    baseColor: color(options.baseColor === undefined ? [1, 1, 1] : options.baseColor, 'material.baseColor'),
    roughness: unit(options.roughness === undefined ? 0.5 : options.roughness, 'material.roughness'),
    specularReflectance: typeof reflectance === 'number'
      ? [unit(reflectance, 'material.specularReflectance'), reflectance, reflectance]
      : color(reflectance, 'material.specularReflectance'),
  };
}
