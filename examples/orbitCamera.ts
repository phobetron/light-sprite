import type { Vec3 } from '../src/index';

export const INITIAL_EYE: Vec3 = [0, 4.5, 8];
export const CAMERA_TARGET: Vec3 = [0, 2, 0];
const MIN_PITCH = 0.03;
const MAX_PITCH = Math.PI / 2 - 0.08;

/** A fixed-distance orbit: dragging changes the view, never the scene. */
export class OrbitCamera {
  private yaw = 0;
  private pitch = 0;
  private radius = 1;

  constructor() {
    this.reset();
  }

  reset(): void {
    const x = INITIAL_EYE[0] - CAMERA_TARGET[0];
    const y = INITIAL_EYE[1] - CAMERA_TARGET[1];
    const z = INITIAL_EYE[2] - CAMERA_TARGET[2];
    this.radius = Math.hypot(x, y, z);
    this.yaw = Math.atan2(x, z);
    this.pitch = Math.asin(y / this.radius);
  }

  orbit(deltaX: number, deltaY: number): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.yaw = (this.yaw - deltaX * 0.006) % (2 * Math.PI);
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + deltaY * 0.006));
  }

  get eye(): Vec3 {
    const horizontalRadius = this.radius * Math.cos(this.pitch);
    return [
      CAMERA_TARGET[0] + horizontalRadius * Math.sin(this.yaw),
      CAMERA_TARGET[1] + this.radius * Math.sin(this.pitch),
      CAMERA_TARGET[2] + horizontalRadius * Math.cos(this.yaw),
    ];
  }
}
