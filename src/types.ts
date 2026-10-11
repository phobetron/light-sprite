export type Vec3 = readonly [number, number, number];
/** Detached array snapshots accepted by WebGL vector uniform methods. */
export type MutableVec3 = [number, number, number];
export type Mat4 = ArrayLike<number>;
export interface Geometry {
  positions: Float32Array;
  normals?: Float32Array;
  indices?: Uint16Array | Uint32Array;
}
export interface Bounds3 { min: Vec3; max: Vec3 }
export interface PositionSource {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  /** Number of elements between successive vertices. */
  stride?: number;
  /** Position component offset, in elements. */
  offset?: number;
  /** First draw item (an index when indices are present). */
  start?: number;
  count?: number;
}
