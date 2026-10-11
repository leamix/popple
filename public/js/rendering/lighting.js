const RADIANS = Math.PI / 180;
const DATA_TIMEOUT = 5000;
export const MAX_LIGHT_SHIFT = .17;
export const MAX_REFLECTION_ANGLE = .95;

export function angleDifference(angle, reference) {
  const difference = angle % 360 - reference % 360;
  return ((difference + 540) % 360 + 360) % 360 - 180;
}

export function readOrientation(event) {
  // null means that the device did not provide this axis; it is not zero.
  const { alpha, beta, gamma } = event ?? {};
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)
    || Math.abs(beta) > 180 || Math.abs(gamma) > 90) return null;
  return { alpha: Number.isFinite(alpha) ? alpha : null, beta, gamma };
}

export function orientationLight(event, baseline, screenAngle = 0) {
  const sample = readOrientation(event), reference = readOrientation(baseline);
  if (!sample || !reference) return { x: 0, y: 0, angle: 0 };
  const yaw = sample.alpha === null || reference.alpha === null
    ? 0 : angleDifference(sample.alpha, reference.alpha) * RADIANS;
  const roll = angleDifference(sample.gamma, reference.gamma);
  const pitch = angleDifference(sample.beta, reference.beta);
  // A small movement of a broad light source, not an object sliding on the film.
  // Tilt is softened before the radial bound; yaw gently turns the same reflection.
  const dx = .14 * Math.tanh(roll / 35)
    - .048 * Math.sin(yaw);
  const dy = -.124 * Math.tanh(pitch / 35)
    + .024 * (1 - Math.cos(yaw));
  const angle = (Number.isFinite(screenAngle) ? screenAngle : 0) * RADIANS;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  // Rotate device axes into the currently displayed screen axes.
  const x = dx * cosine + dy * sine;
  const y = -dx * sine + dy * cosine;
  const distance = Math.hypot(x, y);
  const scale = distance ? MAX_LIGHT_SHIFT * Math.tanh(distance / MAX_LIGHT_SHIFT) / distance : 1;
  // Orbit moves reflection placement around the bubble, independently of the
  // light source's subtle x/y shift. Roll leads, pitch adds gentler travel.
  const screenRoll = roll * cosine + pitch * sine;
  const screenPitch = -roll * sine + pitch * cosine;
  const orbitAngle = MAX_REFLECTION_ANGLE * Math.tanh(
    .95 * screenRoll / 50 + .35 * screenPitch / 50 + .65 * Math.sin(yaw)
  );
  return { x: x * scale, y: y * scale, angle: orbitAngle };
}

/** Device-only illumination. Call enable({ userGesture: true }) from a settings click. */
export class DeviceLighting {
  constructor({ onChange = () => {}, onStatus = () => {}, reduced = false, environment = globalThis.window } = {}) {
    this.environment = environment;
    this.document = environment?.document;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.reduced = Boolean(reduced);
    this.enabled = false;
    this.active = false;
    this.hasData = false;
    this.status = 'idle';
    this.vector = { x: 0, y: 0, angle: 0 };
    this.baseline = null;
    this.permissionGranted = false;
    this.permissionDenied = false;
    this.pending = false;
    this.destroyed = false;
    this.suspended = false;
    this.interrupted = false;
    this.epoch = 0;
    this.timer = null;
    this.lastTime = null;
    this.lastDataTime = null;
    this.angle = this.screenAngle();
    this.handleOrientation = event => this.receive(event);
    this.handleRotation = () => {
      this.angle = this.screenAngle();
      this.recenter();
      if (this.active) this.awaitData();
    };
    this.handleReturn = () => {
      if (!this.document?.hidden && this.document?.hasFocus?.() !== false) this.interrupted = false;
      this.sync();
    };
    this.handleVisibility = this.handleReturn;
    this.handleBlur = () => { this.interrupted = true; this.sync(); };
    this.handleFocus = () => { this.interrupted = false; this.sync(); };
    this.handleInteraction = event => {
      // A genuine interaction can restore a mobile page if closing a native
      // permission sheet omitted focus. It never requests another permission.
      if (!event.isTrusted || this.document?.hidden || !this.interrupted) return;
      this.interrupted = false;
      this.sync();
    };
    environment?.addEventListener('orientationchange', this.handleRotation);
    environment?.screen?.orientation?.addEventListener('change', this.handleRotation);
    environment?.addEventListener('blur', this.handleBlur);
    environment?.addEventListener('focus', this.handleFocus);
    environment?.addEventListener('pageshow', this.handleReturn);
    this.document?.addEventListener('visibilitychange', this.handleVisibility);
    this.document?.addEventListener('pointerdown', this.handleInteraction, true);
    this.document?.addEventListener('keydown', this.handleInteraction, true);
  }

  screenAngle() {
    const angle = this.environment?.screen?.orientation?.angle;
    const legacyAngle = this.environment?.orientation;
    return Number.isFinite(angle) ? angle : Number.isFinite(legacyAngle) ? legacyAngle : 0;
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }

  async enable({ userGesture = false } = {}) {
    if (this.destroyed) return this.status;
    this.enabled = true;
    const env = this.environment, api = env?.DeviceOrientationEvent;
    if (env?.isSecureContext === false) { this.setStatus('insecure'); return this.status; }
    if (!api) { this.setStatus('unavailable'); return this.status; }
    if (this.reduced) { this.setStatus('reduced'); return this.status; }
    if (this.pending) return this.status;
    if (typeof api.requestPermission === 'function' && !this.permissionGranted) {
      // Registering a listener can reuse a browser's existing grant after reload.
      // Observing does not request permission or assume the browser preserved it.
      if (!userGesture || env.navigator?.userActivation?.isActive === false) {
        this.sync(); return this.status;
      }
      if (!this.document?.hidden) this.interrupted = false;
      const epoch = ++this.epoch;
      this.pending = true;
      this.sync();
      let permission;
      try {
        // Invoked before the first await so iOS retains the click's activation.
        permission = await api.requestPermission();
      } catch { permission = 'denied'; }
      if (this.destroyed || epoch !== this.epoch) return this.status;
      this.pending = false;
      this.permissionDenied = permission !== 'granted';
      // A settled permission sheet is a deliberate return to a visible focused
      // page, even if the browser emitted blur without a matching focus event.
      if (!this.document?.hidden && this.document?.hasFocus?.() !== false) this.interrupted = false;
      if (this.permissionDenied) { this.sync(); return this.status; }
      this.permissionGranted = true;
    } else this.permissionGranted = true;
    this.sync();
    return this.status;
  }

  setReduced(reduced) {
    this.reduced = Boolean(reduced);
    this.sync();
  }

  setSuspended(suspended) {
    this.suspended = Boolean(suspended);
    this.sync();
  }

  sync() {
    if (this.destroyed) return;
    const api = this.environment?.DeviceOrientationEvent;
    if (api && this.environment.isSecureContext !== false && typeof api.requestPermission !== 'function') {
      this.permissionGranted = true;
    }
    const blocked = this.reduced || this.suspended || this.interrupted || this.document?.hidden;
    if (!this.enabled || blocked || !api || this.environment.isSecureContext === false
      || this.pending || this.permissionDenied) {
      this.stopListening();
      if (!this.enabled) this.setStatus('idle');
      else if (this.reduced) this.setStatus('reduced');
      else if (blocked) this.setStatus('suspended');
      else if (!this.environment?.DeviceOrientationEvent) this.setStatus('unavailable');
      else if (this.environment.isSecureContext === false) this.setStatus('insecure');
      else if (this.pending) this.setStatus('pending');
      else if (this.permissionDenied) this.setStatus('denied');
      else this.setStatus('permission-required');
      return;
    }
    if (this.active) return;
    this.active = true;
    this.recenter();
    this.environment.addEventListener('deviceorientation', this.handleOrientation, { passive: true });
    this.awaitData();
  }

  awaitData() {
    this.clearTimer();
    this.setStatus(this.permissionGranted ? 'listening' : 'permission-required');
    this.watchData();
  }

  watchData(delay = DATA_TIMEOUT) {
    this.timer = this.environment.setTimeout(() => {
      this.timer = null;
      if (!this.active) return;
      if (this.hasData) {
        const silence = this.now() - this.lastDataTime;
        if (silence < DATA_TIMEOUT) { this.watchData(DATA_TIMEOUT - silence); return; }
        this.recenter();
      }
      this.setStatus(this.permissionGranted ? 'no-data' : 'permission-required');
    }, delay);
  }

  now() {
    return this.environment.performance?.now?.() ?? Date.now();
  }

  receive(event) {
    if (!this.active || this.destroyed || this.reduced || this.suspended
      || this.interrupted || this.document?.hidden) return;
    const sample = readOrientation(event);
    if (!sample) return;
    const angle = this.screenAngle();
    if (angle !== this.angle) { this.angle = angle; this.recenter(); }
    if (!this.baseline) this.baseline = { ...sample };
    // Devices may start providing yaw after tilt; its first reading is neutral.
    if (this.baseline.alpha === null && sample.alpha !== null) this.baseline.alpha = sample.alpha;
    this.hasData = true;
    // Finite sensor output is evidence that this browser actually allowed access.
    this.permissionGranted = true;
    this.setStatus('granted');
    const target = orientationLight(sample, this.baseline, angle);
    const time = this.now();
    this.lastDataTime = time;
    if (this.timer === null) this.watchData();
    const dt = this.lastTime === null ? 1 / 60 : Math.max(0, Math.min(.1, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const easing = 1 - Math.exp(-dt * 12);
    const next = {
      x: this.vector.x + (target.x - this.vector.x) * easing,
      y: this.vector.y + (target.y - this.vector.y) * easing,
      angle: this.vector.angle + (target.angle - this.vector.angle) * easing
    };
    if (Math.hypot(next.x - this.vector.x, next.y - this.vector.y) > .0001
      || Math.abs(next.angle - this.vector.angle) > .0001) {
      this.vector = next;
      this.onChange({ ...next });
    }
  }

  clearTimer() {
    if (this.timer !== null) this.environment.clearTimeout(this.timer);
    this.timer = null;
  }

  recenter() {
    this.baseline = null;
    this.hasData = false;
    this.lastTime = null;
    this.lastDataTime = null;
    this.vector = { x: 0, y: 0, angle: 0 };
    this.onChange({ ...this.vector });
  }

  stopListening() {
    if (this.active) this.environment.removeEventListener('deviceorientation', this.handleOrientation);
    this.active = false;
    this.clearTimer();
    this.recenter();
  }

  disable() {
    this.enabled = false;
    this.epoch++;
    this.pending = false;
    this.sync();
  }

  destroy() {
    if (this.destroyed) return;
    this.disable();
    const env = this.environment;
    env?.removeEventListener('orientationchange', this.handleRotation);
    env?.screen?.orientation?.removeEventListener('change', this.handleRotation);
    env?.removeEventListener('blur', this.handleBlur);
    env?.removeEventListener('focus', this.handleFocus);
    env?.removeEventListener('pageshow', this.handleReturn);
    this.document?.removeEventListener('visibilitychange', this.handleVisibility);
    this.document?.removeEventListener('pointerdown', this.handleInteraction, true);
    this.document?.removeEventListener('keydown', this.handleInteraction, true);
    this.destroyed = true;
  }
}
