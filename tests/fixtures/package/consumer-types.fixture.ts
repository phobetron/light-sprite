import {
  createLightSprite,
  createLightSpriteMaterial,
  type LightSprite,
  type LightSpriteMaterial,
  type LightSpriteMaterialSnapshot,
  type LightSpriteSnapshot,
  type LightingOptions,
  type MaterialOptions,
  type MutableVec3,
  type PointLight,
  type PointLightOptions,
  type PointLightSnapshot,
  type Vec3,
} from 'light-sprite';

declare const gl: WebGL2RenderingContext;
declare const program: WebGLProgram;
const readonlyVector = [0.2, 0.3, 0.4] as const;
const vector: Vec3 = readonlyVector;
// @ts-expect-error Vec3 remains a readonly input tuple.
vector[0] = 1;

const materialOptions: MaterialOptions = {
  baseColor: readonlyVector,
  specularReflectance: readonlyVector,
};
const material = createLightSpriteMaterial(materialOptions);
gl.uniform3fv(null, material.baseColor);
gl.uniform3fv(null, material.specularReflectance);
const materialSnapshot: LightSpriteMaterialSnapshot = material;
const materialContract: LightSpriteMaterial = materialSnapshot;
const structuralMaterial: LightSpriteMaterial = {
  baseColor: readonlyVector,
  roughness: 0.5,
  specularReflectance: readonlyVector,
};
createLightSpriteMaterial(structuralMaterial);
createLightSpriteMaterial({ specularReflectance: 0.04 });

const lightOptions: PointLightOptions = { color: readonlyVector };
const sprite = createLightSprite(gl, { position: readonlyVector, light: lightOptions });
gl.uniform3fv(null, sprite.position);
gl.uniform3fv(null, sprite.light.position);
gl.uniform3fv(null, sprite.light.color);
const mutableVector: MutableVec3 = sprite.position;
const spriteSnapshot: LightSpriteSnapshot = sprite;
const spriteContract: LightSprite = spriteSnapshot;
const lightSnapshot: PointLightSnapshot = sprite.light;
const lightContract: PointLight = lightSnapshot;
const structuralLight: PointLight = {
  position: readonlyVector,
  color: readonlyVector,
  intensity: 6,
  range: 0,
};
sprite.setPosition(readonlyVector);
sprite.setLight(structuralLight);
const lightingOptions: LightingOptions = { cameraPosition: readonlyVector, ambient: readonlyVector };
sprite.bindLighting(program, lightingOptions);

// Existing structural controllers need not supply mutable snapshot arrays.
declare const controllerMethods: Omit<LightSprite, 'position' | 'light'>;
const structuralSprite: LightSprite = {
  ...controllerMethods,
  position: readonlyVector,
  light: structuralLight,
};

// These uses also keep the fixture valid with noUnusedLocals enabled by a consumer.
void [materialContract, spriteContract, lightContract, mutableVector, structuralSprite];
