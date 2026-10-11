import type { MutableVec3, Vec3 } from './types';

const uniformsGLSL = `
uniform vec3 u_lightSpritePosition;
uniform vec3 u_lightSpriteColor;
uniform float u_lightSpriteIntensity;
uniform float u_lightSpriteRange;
uniform float u_lightSpriteRadius;
uniform vec3 u_lightSpriteAmbient;
uniform vec3 u_lightSpriteCameraPosition;

vec3 lightSpriteSafeNormalize(vec3 value) {
  float scale = max(max(abs(value.x), abs(value.y)), abs(value.z));
  if (scale == 0.0) return vec3(0.0);
  vec3 scaled = value / scale;
  return scaled / length(scaled);
}
`;

const shadowGLSL = `
uniform highp samplerCube u_lightSpriteShadowMap;
uniform float u_lightSpriteShadowFar;
uniform float u_lightSpriteShadowBias;
uniform float u_lightSpriteShadowTexelSize;
uniform bool u_lightSpriteShadowEnabled;

float lightSpriteShadowVisibility(vec3 worldPosition, vec3 worldNormal) {
  if (!u_lightSpriteShadowEnabled) return 1.0;
  vec3 direction = worldPosition - u_lightSpritePosition;
  float distanceFromLight = length(direction);
  if (distanceFromLight < 0.000001) return 1.0;
  // Account for depth variation between neighbouring rays at grazing angles.
  float cosine = clamp(dot(lightSpriteSafeNormalize(worldNormal), -direction / distanceFromLight), 0.0, 1.0);
  float slope = sqrt(max(1.0 - cosine * cosine, 0.0)) / max(cosine, 0.05);
  float footprint = 2.0 * distanceFromLight * u_lightSpriteShadowTexelSize;
  float bias = max(u_lightSpriteShadowBias, footprint * slope);
  float storedDepth = texture(u_lightSpriteShadowMap, direction).r;
  if (storedDepth >= 1.0) return 1.0;
  return distanceFromLight - bias <= storedDepth * u_lightSpriteShadowFar ? 1.0 : 0.0;
}
`;

const helpersGLSL = `
struct LightSpriteMaterial {
  vec3 baseColor;
  float roughness;
  vec3 specularReflectance;
};

LightSpriteMaterial lightSpriteMaterial(vec3 baseColor, float roughness, vec3 specularReflectance) {
  return LightSpriteMaterial(clamp(baseColor, 0.0, 1.0), clamp(roughness, 0.0, 1.0), clamp(specularReflectance, 0.0, 1.0));
}
LightSpriteMaterial lightSpriteMaterial(vec3 baseColor, float roughness, float specularReflectance) {
  return lightSpriteMaterial(baseColor, roughness, vec3(specularReflectance));
}
LightSpriteMaterial lightSpriteMaterial(vec3 baseColor) {
  return lightSpriteMaterial(baseColor, 0.5, 0.04);
}

struct LightSpriteLightSample {
  vec3 direction;
  vec3 radiance;
  float visibility;
};

vec3 lightSpriteDirection(vec3 worldPosition) {
  return lightSpriteSafeNormalize(u_lightSpritePosition - worldPosition);
}

// Radiance excludes visibility, the surface cosine, and ambient lighting.
vec3 lightSpriteRadiance(vec3 worldPosition) {
  vec3 offset = u_lightSpritePosition - worldPosition;
  float distanceSquared = dot(offset, offset);
  float attenuation = 1.0 / (12.5663706144 * max(max(distanceSquared, u_lightSpriteRadius * u_lightSpriteRadius), 0.000000000001));
  if (u_lightSpriteRange > 0.0) {
    float ratio = sqrt(distanceSquared) / u_lightSpriteRange;
    float cutoff = max(1.0 - pow(ratio, 4.0), 0.0);
    attenuation *= cutoff * cutoff;
  }
  return u_lightSpriteColor * u_lightSpriteIntensity * attenuation;
}

LightSpriteLightSample lightSpriteSample(vec3 worldPosition, vec3 worldNormal) {
  return LightSpriteLightSample(lightSpriteDirection(worldPosition), lightSpriteRadiance(worldPosition),
    lightSpriteShadowVisibility(worldPosition, worldNormal));
}

// Preserve the original matte brightness convention for existing shaders.
vec3 lightSpriteShade(vec3 baseColor, vec3 worldPosition, vec3 worldNormal) {
  LightSpriteLightSample light = lightSpriteSample(worldPosition, worldNormal);
  float diffuse = max(dot(lightSpriteSafeNormalize(worldNormal), light.direction), 0.0);
  return baseColor * (u_lightSpriteAmbient + light.radiance * diffuse * light.visibility);
}

// Cook-Torrance: GGX distribution, height-correlated Smith visibility, Schlick Fresnel.
vec3 lightSpriteShade(LightSpriteMaterial material, vec3 worldPosition, vec3 worldNormal, vec3 viewDirection) {
  vec3 baseColor = clamp(material.baseColor, 0.0, 1.0);
  vec3 result = baseColor * u_lightSpriteAmbient;
  vec3 normal = lightSpriteSafeNormalize(worldNormal);
  vec3 view = lightSpriteSafeNormalize(viewDirection);
  LightSpriteLightSample light = lightSpriteSample(worldPosition, normal);
  float nDotL = clamp(dot(normal, light.direction), 0.0, 1.0);
  float nDotV = clamp(dot(normal, view), 0.0, 1.0);
  if (nDotL <= 0.0 || nDotV <= 0.0) return result;
  vec3 halfDirection = lightSpriteSafeNormalize(light.direction + view);
  float nDotH = clamp(dot(normal, halfDirection), 0.0, 1.0);
  float vDotH = clamp(dot(view, halfDirection), 0.0, 1.0);
  float roughness = clamp(material.roughness, 0.045, 1.0);
  float alpha = roughness * roughness;
  float alphaSquared = alpha * alpha;
  // The cross product avoids cancellation of 1 - nDotH squared near sharp peaks.
  vec3 normalCrossHalf = cross(normal, halfDirection);
  float denominator = dot(normalCrossHalf, normalCrossHalf) + alphaSquared * nDotH * nDotH;
  float distribution = alphaSquared / (3.1415926536 * denominator * denominator);
  float viewMask = nDotL * sqrt(nDotV * nDotV * (1.0 - alphaSquared) + alphaSquared);
  float lightMask = nDotV * sqrt(nDotL * nDotL * (1.0 - alphaSquared) + alphaSquared);
  float visibility = 0.5 / max(viewMask + lightMask, 0.0000001);
  vec3 reflectance = clamp(material.specularReflectance, 0.0, 1.0);
  vec3 fresnel = reflectance + (vec3(1.0) - reflectance) * pow(1.0 - vDotH, 5.0);
  vec3 diffuse = (vec3(1.0) - fresnel) * baseColor / 3.1415926536;
  vec3 specular = distribution * visibility * fresnel;
  return result + (diffuse + specular) * light.radiance * nDotL * light.visibility;
}

// View direction points from the surface toward the world-space camera.
vec3 lightSpriteShade(LightSpriteMaterial material, vec3 worldPosition, vec3 worldNormal) {
  return lightSpriteShade(material, worldPosition, worldNormal, u_lightSpriteCameraPosition - worldPosition);
}

vec3 lightSpriteToneMap(vec3 linearColor) {
  vec3 color = max(linearColor, vec3(0.0));
  return color / (vec3(1.0) + color);
}

vec3 lightSpriteLinearToSRGB(vec3 linearColor) {
  vec3 color = max(linearColor, vec3(0.0));
  return mix(12.92 * color, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), color));
}
`;

/** Shader variant matched to a controller's optional shadow resources. */
export function createLightingGLSL(shadows: boolean): string {
  const visibility = shadows ? shadowGLSL : `
float lightSpriteShadowVisibility(vec3 worldPosition, vec3 worldNormal) {
  return 1.0;
}
`;
  return uniformsGLSL + visibility + helpersGLSL;
}

/** Include in a GLSL ES 3.00 fragment shader after its precision declaration. */
export const LIGHT_SPRITE_GLSL = createLightingGLSL(false);

export interface PointLightOptions {
  /** Linear RGB components in [0, 1]. Default: white. */
  color?: Vec3;
  /** Source strength; the shader uses intensity / (4π distance²). Default: 6. */
  intensity?: number;
  /** World-space cutoff distance; zero means unlimited. Default: 0. */
  range?: number;
}

export interface PointLight {
  position: Vec3;
  color: Vec3;
  intensity: number;
  range: number;
}

/** Detached light arrays returned by a controller snapshot. */
export interface PointLightSnapshot extends PointLight {
  position: MutableVec3;
  color: MutableVec3;
}

export interface LightingOptions {
  /** World-space camera position; required when the material camera overload is used. */
  cameraPosition?: Vec3;
  /** Linear ambient contribution. Default: 0.03 on each channel. */
  ambient?: number | Vec3;
  /** Rebuild cached uniform locations after relinking a consumer-owned program. */
  refresh?: boolean;
  /** Disable shadow comparison for this draw; enabled by default when configured. */
  shadows?: boolean;
}
