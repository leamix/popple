export const DEFAULT_HOLD_SECONDS = 0.78;
const MIN_HOLD_SECONDS = 0.52;
const HOLD_PRESSURE_RATIO = MIN_HOLD_SECONDS / DEFAULT_HOLD_SECONDS;
const FILM_REST_COMPRESSION = 0.06;
const MAX_FRAME_SECONDS = 0.05;
const MAX_HOLD_FRAME_SECONDS = 0.1;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const position = value => clamp(finite(value), -1, 1);
const pressureValue = value => clamp(finite(value, 0.5), 0, 1);

function seedFor(index) {
  let value = (Math.trunc(finite(index)) + 1) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

/**
 * One sealed air pocket. All positions are relative to its centre, in [-1, 1].
 * The renderer places the extra bulge opposite (x, y), and derives normals from
 * the resulting surface. No device is assumed to have a force sensor.
 */
export class BubbleState {
  constructor(index = 0, holdSeconds = DEFAULT_HOLD_SECONDS) {
    this.index = index;
    this.seed = seedFor(index);
    this.setHoldDuration(holdSeconds);
    this.reset();
  }

  /** Nominal hold time; genuine varying force can shorten it proportionally. */
  setHoldDuration(seconds) {
    this.holdDuration = clamp(finite(seconds, DEFAULT_HOLD_SECONDS), 0.2, 2);
    return this.holdDuration;
  }

  reset() {
    this.x = 0;
    this.y = 0;
    this.popX = 0;
    this.popY = 0;
    this.compression = 0;
    this.bulge = 0;
    this.popped = false;
    this.collapse = 0;
    this.holdProgress = 0;
    this.active = false;
    this.popAge = 0;
    this._targetX = 0;
    this._targetY = 0;
    this._vx = 0;
    this._vy = 0;
    this._compressionVelocity = 0;
    this._bulgeVelocity = 0;
    this._heldSeconds = 0;
    this._pressure = 0.5;
    this._minPressure = 0.5;
    this._maxPressure = 0.5;
    this._pressureVaries = false;
    this._pressStartedAt = 0;
  }

  press(x, y, pressure = 0.5, timeSeconds = 0) {
    if (this.active) return false;
    this.active = true;
    this.x = this._targetX = position(x);
    this.y = this._targetY = position(y);
    this._vx = this._vy = 0;
    this._pressure = pressureValue(pressure);
    this._minPressure = this._maxPressure = this._pressure;
    this._pressureVaries = false;
    this._pressStartedAt = finite(timeSeconds);
    this._heldSeconds = 0;
    this.holdProgress = this.popped ? 1 : 0;
    // A visible dimple belongs to the very first contact frame.
    this.compression = Math.max(this.compression, this.popped ? 0.085 : 0.16);
    this.bulge = this.popped ? 0 : Math.max(this.bulge, 0.035);
    return true;
  }

  move(x, y, pressure = 0.5) {
    if (!this.active) return false;
    this._targetX = position(x);
    this._targetY = position(y);
    this._pressure = pressureValue(pressure);
    this._minPressure = Math.min(this._minPressure, this._pressure);
    this._maxPressure = Math.max(this._maxPressure, this._pressure);
    // Touch screens commonly report a constant 0.5, or simply 0/1. Only a
    // changing intermediate value provides useful evidence of pressure.
    if (this._pressure > 0.02 && this._pressure < 0.98 &&
        this._maxPressure - this._minPressure >= 0.075) {
      this._pressureVaries = true;
    }
    return true;
  }

  release() {
    this.active = false;
    this._targetX = this._targetY = 0;
    this._heldSeconds = 0;
    if (!this.popped) this.holdProgress = 0;
  }

  /**
   * Advance using elapsed *foreground frame* time, never wall time since press.
   * A stalled/background frame therefore cannot unexpectedly burst a pocket.
   * Returns true for precisely the frame on which the pocket first bursts.
   */
  step(dt, timeSeconds = 0) {
    const delta = clamp(finite(dt), 0, MAX_FRAME_SECONDS);
    const elapsed = clamp(finite(dt), 0, MAX_HOLD_FRAME_SECONDS);
    if (!delta) return false;
    let didPop = false;

    if (this.active && !this.popped) {
      this._heldSeconds += elapsed;
      const force = this._pressureVaries
        ? clamp((this._pressure - 0.35) / 0.65, 0, 1) : 0;
      const duration = this.holdDuration * (1 - force * (1 - HOLD_PRESSURE_RATIO));
      this.holdProgress = clamp(this._heldSeconds / duration, 0, 1);
      if (this._heldSeconds + 1e-9 >= duration) {
        // Preserve the actual latest contact, not the spring-smoothed x/y.
        // These coordinates stay fixed while the released film settles.
        this.popX = this._targetX;
        this.popY = this._targetY;
        this.popped = true;
        // Contact remains live after rupture, so the same finger can drag the
        // slack film. It never starts another hold or another pop event.
        this.holdProgress = 1;
        this.popAge = 0;
        this.bulge = this._bulgeVelocity = 0;
        didPop = true;
      }
    }

    if (this.popped && !didPop) {
      this.popAge += elapsed;
      // Fast loss of air, then two tiny film-settling ripples. The public
      // collapse value remains in [0,1], including during the rebound.
      const age = this.popAge;
      this.collapse = clamp(1 - Math.exp(-16 * age) *
        (Math.cos(26 * age) + (16 / 26) * Math.sin(26 * age)), 0, 1);
    }

    const force = this._pressureVaries ? this._pressure : 0.5;
    // A ruptured pocket has no sealed air to displace. Only a shallow local
    // indentation remains; saved popX/popY still locate the permanent creases.
    const targetCompression = this.popped
      ? this.active ? 0.12 + 0.07 * force : FILM_REST_COMPRESSION : this.active
      ? 0.25 + 0.53 * Math.pow(this.holdProgress, 0.85) + 0.05 * force : 0;
    const distance = Math.min(1, Math.hypot(this.x, this.y));
    const targetBulge = this.popped ? 0 : targetCompression * (0.20 + distance * 0.36);

    // Small integration steps keep the same damped spring behaviour at 30,
    // 60 and 120 Hz, without an external animation/physics dependency.
    const count = Math.ceil(delta / (1 / 180));
    const h = delta / count;
    for (let i = 0; i < count; i += 1) {
      const positionStiffness = this.popped ? this.active ? 390 : 165 : this.active ? 650 : 205;
      const positionDamping = this.popped ? this.active ? 42 : 29 : this.active ? 36 : 21;
      this._vx += ((this._targetX - this.x) * positionStiffness - this._vx * positionDamping) * h;
      this._vy += ((this._targetY - this.y) * positionStiffness - this._vy * positionDamping) * h;
      this.x += this._vx * h;
      this.y += this._vy * h;

      const stiffness = this.popped ? 560 : this.active ? 430 : 270;
      // Slack plastic dissipates the poke instead of rebounding like an air
      // pocket. Keep this response close to critically damped.
      const damping = this.popped ? 48 : this.active ? 30 : 24;
      this._compressionVelocity += ((targetCompression - this.compression) * stiffness -
        this._compressionVelocity * damping) * h;
      this.compression += this._compressionVelocity * h;
      this._bulgeVelocity += ((targetBulge - this.bulge) * 330 - this._bulgeVelocity * 28) * h;
      this.bulge += this._bulgeVelocity * h;
    }

    this.compression = clamp(this.compression, 0, 1);
    this.bulge = this.popped ? 0 : clamp(this.bulge, 0, 0.6);
    this.x = clamp(this.x, -1, 1);
    this.y = clamp(this.y, -1, 1);
    if (!this.active && !this.popped && this.compression < 0.0001 && this.bulge < 0.0001) {
      this.compression = this.bulge = 0;
      this._compressionVelocity = this._bulgeVelocity = 0;
      this.x = this.y = this._vx = this._vy = 0;
    }
    if (!this.active && this.popped &&
        Math.abs(this.compression - FILM_REST_COMPRESSION) < 0.0001 &&
        Math.hypot(this.x, this.y) < 0.0001) {
      this.compression = FILM_REST_COMPRESSION;
      this._compressionVelocity = this._bulgeVelocity = 0;
      this.x = this.y = this._vx = this._vy = 0;
    }
    return didPop;
  }
}
