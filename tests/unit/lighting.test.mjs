import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceLighting, MAX_LIGHT_SHIFT, angleDifference, readOrientation, orientationLight } from './lighting.js';

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener); this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  count(name) { return this.listeners.get(name)?.size ?? 0; }
}

function environment({ permission, secure = true, supported = true } = {}) {
  const env = new Events(), document = new Events(), orientation = new Events();
  let time = 0, permissionCalls = 0, nextTimer = 0;
  const timers = new Map();
  document.hidden = false; document.focused = true; document.hasFocus = () => document.focused; orientation.angle = 0;
  Object.assign(env, {
    document, isSecureContext: secure, screen: { orientation },
    navigator: { userActivation: { isActive: true } },
    performance: { now: () => time },
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, at: time + delay }); return nextTimer; },
    clearTimeout: timer => timers.delete(timer)
  });
  if (supported) {
    env.DeviceOrientationEvent = class {};
    if (permission !== undefined) env.DeviceOrientationEvent.requestPermission = () => {
      permissionCalls++; return typeof permission === 'function' ? permission() : Promise.resolve(permission);
    };
  }
  env.sample = (beta, gamma, alpha = 0) => { time += 20; env.dispatch('deviceorientation', { beta, gamma, alpha }); };
  env.advance = ms => {
    time += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
  };
  env.expire = () => env.advance(5000);
  env.permissionCalls = () => permissionCalls;
  env.timerCount = () => timers.size;
  return env;
}

const baseline = { alpha: 0, beta: 0, gamma: 0 };
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`);

test('null or nonfinite tilt is unavailable, while missing yaw permits tilt', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) {
    assert.equal(readOrientation({ beta: value, gamma: 0 }), null);
    assert.equal(readOrientation({ beta: 0, gamma: value }), null);
  }
  assert.equal(readOrientation({ beta: 181, gamma: 0 }), null);
  assert.equal(readOrientation({ beta: 0, gamma: 91 }), null);
  assert.deepEqual(readOrientation({ beta: 0, gamma: 0, alpha: null }), { beta: 0, gamma: 0, alpha: null });
});

test('orientation maps neutral, tilt and yaw to a small bounded light vector', () => {
  assert.deepEqual(orientationLight(baseline, baseline), { x: 0, y: 0, angle: 0 });
  assert.ok(orientationLight({ ...baseline, gamma: 25 }, baseline).x > 0);
  assert.ok(orientationLight({ ...baseline, beta: 25 }, baseline).y < 0);
  assert.ok(Math.abs(orientationLight({ ...baseline, alpha: 45 }, baseline).x) > .005);
  const ordinaryTilt = orientationLight({ ...baseline, gamma: 25 }, baseline);
  // A comfortable tilt has visible travel, while keeping far below the safety bound.
  assert.ok(ordinaryTilt.x > .075 && ordinaryTilt.x < .085);
  assert.equal(ordinaryTilt.y, 0);
  for (let beta = -180; beta <= 180; beta += 20) for (let gamma = -90; gamma <= 90; gamma += 10) {
    const vector = orientationLight({ alpha: 130, beta, gamma }, baseline);
    assert.ok(Number.isFinite(vector.x) && Number.isFinite(vector.y));
    assert.ok(Math.hypot(vector.x, vector.y) <= MAX_LIGHT_SHIFT);
  }
});

test('yaw wraps through north smoothly and invalid input never introduces NaN', () => {
  assert.equal(angleDifference(1, 359), 2);
  assert.equal(angleDifference(359, 1), -2);
  const crossing = orientationLight({ ...baseline, alpha: 1 }, { ...baseline, alpha: 359 });
  const equivalent = orientationLight({ ...baseline, alpha: 2 }, baseline);
  close(crossing.x, equivalent.x); close(crossing.y, equivalent.y);
  assert.deepEqual(orientationLight({ ...baseline, beta: null }, baseline), { x: 0, y: 0, angle: 0 });
  assert.deepEqual(orientationLight(baseline, null), { x: 0, y: 0, angle: 0 });
  const extremeYaw = orientationLight({ ...baseline, alpha: 1e308 }, { ...baseline, alpha: -1e308 });
  assert.ok(Number.isFinite(extremeYaw.x) && Number.isFinite(extremeYaw.y));
  assert.ok(Math.hypot(extremeYaw.x, extremeYaw.y) <= MAX_LIGHT_SHIFT);
});

test('landscape maps device axes to displayed axes without changing displacement', () => {
  const input = { ...baseline, gamma: 25, beta: 12 };
  const portrait = orientationLight(input, baseline);
  const right = orientationLight(input, baseline, 90);
  const left = orientationLight(input, baseline, 270);
  close(right.x, portrait.y); close(right.y, -portrait.x);
  close(left.x, -portrait.y); close(left.y, portrait.x);
  close(Math.hypot(portrait.x, portrait.y), Math.hypot(right.x, right.y));
});

test('ordinary tilt and yaw move reflection angular placement visibly around the bubble', () => {
  const roll = orientationLight({ ...baseline, gamma: 25 }, baseline);
  const yaw = orientationLight({ ...baseline, alpha: 25 }, baseline);
  const degrees = radians => radians * 180 / Math.PI;
  assert.ok(degrees(roll.angle) >= 20 && degrees(roll.angle) <= 25);
  assert.ok(degrees(yaw.angle) >= 13 && degrees(yaw.angle) <= 17);
  assert.ok(Math.hypot(roll.x, roll.y) <= MAX_LIGHT_SHIFT);
});

test('reflection orbit is screen-relative, smoothly bounded, and continuous through yaw wrap', () => {
  const portraitRoll = orientationLight({ ...baseline, gamma: 25 }, baseline);
  const landscapeRoll = orientationLight({ ...baseline, beta: 25 }, baseline, 90);
  close(portraitRoll.angle, landscapeRoll.angle);
  close(orientationLight({ ...baseline, gamma: -25 }, baseline).angle, -portraitRoll.angle);
  const crossing = orientationLight({ ...baseline, alpha: 1 }, { ...baseline, alpha: 359 });
  const equivalent = orientationLight({ ...baseline, alpha: 2 }, baseline);
  close(crossing.angle, equivalent.angle);
  const beforeHalfTurn = orientationLight({ ...baseline, alpha: 179 }, baseline);
  const afterHalfTurn = orientationLight({ ...baseline, alpha: 181 }, baseline);
  assert.ok(Math.abs(beforeHalfTurn.angle - afterHalfTurn.angle) < .025);
  for (let beta = -180; beta <= 180; beta += 30) for (let gamma = -90; gamma <= 90; gamma += 15) {
    for (let alpha = 0; alpha < 360; alpha += 30) {
      const vector = orientationLight({ alpha, beta, gamma }, baseline);
      assert.ok(Number.isFinite(vector.angle));
      assert.ok(Math.abs(vector.angle) <= .95);
    }
  }
  assert.ok(orientationLight({ alpha: 90, beta: 160, gamma: 90 }, baseline).angle > .9);
});

test('sensor helper smooths orbit independently and resets its angle for reduced motion', async () => {
  const env = environment(), changes = [];
  const light = new DeviceLighting({ environment: env, onChange: vector => changes.push(vector) });
  await light.enable(); env.sample(0, 0); env.sample(0, 25);
  const target = orientationLight({ ...baseline, gamma: 25 }, baseline);
  assert.ok(light.vector.angle > 0 && light.vector.angle < target.angle);
  light.setReduced(true); assert.equal(light.vector.angle, 0);
  light.setReduced(false); env.sample(0, 0); const changeCount = changes.length;
  // A counter-tilt cancels the light's source displacement while twist still
  // moves its angular placement. Such an event must still trigger rendering.
  env.sample(.635, 5.106, 25);
  assert.ok(Math.hypot(light.vector.x, light.vector.y) < .0001);
  assert.ok(light.vector.angle > .03); assert.ok(changes.length > changeCount);
  light.disable(); assert.equal(light.vector.angle, 0); light.destroy();
});

test('permission never prompts on startup, resume or false activation', async () => {
  const env = environment({ permission: 'granted' }), light = new DeviceLighting({ environment: env });
  await light.enable(); assert.equal(light.status, 'permission-required');
  env.dispatch('focus'); light.setReduced(true); light.setReduced(false);
  assert.equal(env.permissionCalls(), 0);
  env.navigator.userActivation.isActive = false;
  await light.enable({ userGesture: true });
  assert.equal(env.permissionCalls(), 0);
  assert.equal(env.count('deviceorientation'), 1); light.destroy();
});

test('explicit settings click requests only relative orientation and waits for real data', async () => {
  const env = environment({ permission: 'granted' }), vectors = [], statuses = [];
  const light = new DeviceLighting({ environment: env, onChange: value => vectors.push(value), onStatus: value => statuses.push(value) });
  const promise = light.enable({ userGesture: true });
  assert.equal(env.permissionCalls(), 1); assert.equal(light.status, 'pending');
  await promise;
  assert.equal(light.status, 'listening'); assert.equal(env.count('deviceorientation'), 1);
  env.sample(null, null); assert.equal(light.status, 'listening');
  env.sample(40, 15, null); assert.equal(light.status, 'granted');
  assert.equal(light.hasData, true); assert.equal(env.timerCount(), 1);
  assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
  env.sample(40, 25, null); assert.ok(light.vector.x > 0);
  assert.ok(light.vector.x < orientationLight({ alpha: null, beta: 40, gamma: 25 }, { alpha: null, beta: 40, gamma: 15 }).x);
  assert.ok(statuses.includes('pending') && statuses.includes('granted')); light.destroy();
});

test('denied or thrown permission does not listen or repeatedly prompt', async () => {
  for (const permission of ['denied', () => { throw new Error('blocked'); }]) {
    const env = environment({ permission }), light = new DeviceLighting({ environment: env });
    await light.enable({ userGesture: true });
    assert.equal(light.status, 'denied'); assert.equal(env.count('deviceorientation'), 0);
    env.dispatch('blur'); env.dispatch('focus');
    assert.equal(light.status, 'denied');
    assert.equal(env.permissionCalls(), 1); light.destroy();
  }
});

test('insecure, missing API and reduced motion never request permission', async () => {
  for (const scenario of [
    { options: { secure: false, permission: 'granted' }, reduced: false, status: 'insecure' },
    { options: { supported: false }, reduced: false, status: 'unavailable' },
    { options: { permission: 'granted' }, reduced: true, status: 'reduced' }
  ]) {
    const env = environment(scenario.options), light = new DeviceLighting({ environment: env, reduced: scenario.reduced });
    await light.enable({ userGesture: true }); assert.equal(light.status, scenario.status);
    assert.equal(env.permissionCalls(), 0); assert.equal(env.count('deviceorientation'), 0); light.destroy();
  }
});

test('lack of events remains static with no-data status; late data is still accepted', async () => {
  const env = environment(), light = new DeviceLighting({ environment: env });
  await light.enable(); env.expire();
  assert.equal(light.status, 'no-data'); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
  env.sample(0, 0); assert.equal(light.status, 'granted'); light.destroy();
});

test('screen rotation recenters before measuring the new screen', async () => {
  const env = environment(), light = new DeviceLighting({ environment: env });
  await light.enable(); env.sample(0, 0); env.sample(0, 20);
  assert.ok(light.vector.x > 0);
  env.screen.orientation.angle = 90; env.screen.orientation.dispatch('change');
  assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 }); assert.equal(light.baseline, null);
  assert.equal(light.status, 'listening');
  env.sample(0, 20); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
  env.sample(0, 30); assert.ok(light.vector.y < 0); light.destroy();
});

test('missing yaw calibrates independently when it becomes available', async () => {
  const env = environment(), light = new DeviceLighting({ environment: env });
  await light.enable(); env.sample(0, 0, null); env.sample(0, 0, 123);
  assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
  env.sample(0, 0, 150); assert.ok(light.vector.x < 0); light.destroy();
});

test('reduced motion, hidden page, blur and context loss recenter and stop sensor effects', async () => {
  const env = environment(), light = new DeviceLighting({ environment: env });
  await light.enable(); env.sample(0, 0); env.sample(0, 20);
  for (const [pause, resume, status] of [
    [() => light.setReduced(true), () => light.setReduced(false), 'reduced'],
    [() => { env.document.hidden = true; env.document.dispatch('visibilitychange'); }, () => { env.document.hidden = false; env.document.dispatch('visibilitychange'); }, 'suspended'],
    [() => env.dispatch('blur'), () => env.dispatch('focus'), 'suspended'],
    [() => light.setSuspended(true), () => light.setSuspended(false), 'suspended']
  ]) {
    pause(); assert.equal(light.status, status); assert.equal(env.count('deviceorientation'), 0);
    env.sample(40, 45); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
    resume(); assert.equal(env.count('deviceorientation'), 1);
    env.sample(40, 45); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
    env.sample(40, 55); assert.ok(light.vector.x > 0);
  }
  light.destroy();
});

test('disabling or destroying during permission pending cannot attach late listeners', async () => {
  for (const finish of [light => light.disable(), light => light.destroy()]) {
    let resolve;
    const env = environment({ permission: () => new Promise(done => { resolve = done; }) });
    const light = new DeviceLighting({ environment: env });
    const pending = light.enable({ userGesture: true }); finish(light); resolve('granted'); await pending;
    assert.equal(light.status, 'idle'); assert.equal(env.count('deviceorientation'), 0);
    assert.equal(env.timerCount(), 0); light.destroy();
    for (const listeners of env.listeners.values()) assert.equal(listeners.size, 0);
    for (const listeners of env.document.listeners.values()) assert.equal(listeners.size, 0);
    for (const listeners of env.screen.orientation.listeners.values()) assert.equal(listeners.size, 0);
  }
});

test('permission is reused on re-enable but calibration never reuses a stale pose', async () => {
  const env = environment({ permission: 'granted' }), light = new DeviceLighting({ environment: env });
  await light.enable({ userGesture: true }); env.sample(0, 0); env.sample(0, 20); light.disable();
  await light.enable(); assert.equal(env.permissionCalls(), 1);
  env.sample(30, 30); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 }); light.destroy();
});

test('turning off reduced motion starts an opted-in device without a permission API', async () => {
  const env = environment(), light = new DeviceLighting({ environment: env, reduced: true });
  await light.enable(); assert.equal(light.status, 'reduced');
  light.setReduced(false); assert.equal(light.status, 'listening');
  assert.equal(env.count('deviceorientation'), 1);
  env.sample(0, 0); assert.equal(light.status, 'granted'); light.destroy();
});

test('startup can receive previously permitted browser events across a new helper without prompting', async () => {
  const env = environment({ permission: 'granted' });
  const previous = new DeviceLighting({ environment: env });
  await previous.enable({ userGesture: true }); env.sample(0, 0); previous.destroy();
  const light = new DeviceLighting({ environment: env });
  await light.enable();
  assert.equal(light.enabled, true); assert.equal(light.status, 'permission-required');
  assert.equal(light.permissionGranted, false); assert.equal(light.hasData, false);
  assert.equal(env.count('deviceorientation'), 1); assert.equal(env.permissionCalls(), 1);
  env.sample(20, 10); assert.equal(light.status, 'granted'); assert.equal(light.hasData, true);
  env.sample(20, 30); assert.ok(light.vector.x > 0);
  assert.equal(env.permissionCalls(), 1); light.destroy();
});

test('startup observation never invents permission when browser events are blocked or null', async () => {
  const env = environment({ permission: 'granted' }), light = new DeviceLighting({ environment: env });
  await light.enable(); env.sample(null, null); env.expire();
  assert.equal(light.enabled, true); assert.equal(light.active, true);
  assert.equal(light.status, 'permission-required'); assert.equal(light.permissionGranted, false);
  assert.equal(light.hasData, false); assert.equal(env.permissionCalls(), 0);
  assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
  await light.enable({ userGesture: true }); assert.equal(env.permissionCalls(), 1);
  assert.equal(light.status, 'listening'); env.sample(null, 0); env.expire();
  assert.equal(light.status, 'no-data'); assert.equal(light.hasData, false); light.destroy();
});

test('permission completion recovers a visible focused page even when prompt never fires focus', async () => {
  let resolve;
  const env = environment({ permission: () => new Promise(done => { resolve = done; }) });
  const light = new DeviceLighting({ environment: env });
  const pending = light.enable({ userGesture: true }); env.dispatch('blur');
  assert.equal(light.interrupted, true); resolve('granted'); await pending;
  assert.equal(light.interrupted, false); assert.equal(light.status, 'listening');
  env.sample(0, 0); env.sample(0, 20); assert.ok(light.vector.x > 0); light.destroy();
});

test('denying a native prompt after blur restores the denial explanation without a focus event', async () => {
  let resolve;
  const env = environment({ permission: () => new Promise(done => { resolve = done; }) });
  const light = new DeviceLighting({ environment: env });
  const pending = light.enable({ userGesture: true }); env.dispatch('blur');
  assert.equal(light.pending, true); assert.equal(light.interrupted, true);
  resolve('denied'); await pending;
  assert.equal(light.status, 'denied'); assert.equal(light.permissionDenied, true);
  assert.equal(light.pending, false); assert.equal(light.interrupted, false);
  assert.equal(env.count('deviceorientation'), 0); assert.equal(env.permissionCalls(), 1);
  env.sample(0, 30); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 }); light.destroy();
});

test('denial completing in a hidden or unfocused page preserves suspension until a real return', async () => {
  for (const state of ['hidden', 'unfocused']) {
    let resolve;
    const env = environment({ permission: () => new Promise(done => { resolve = done; }) });
    const light = new DeviceLighting({ environment: env });
    const pending = light.enable({ userGesture: true }); env.dispatch('blur');
    if (state === 'hidden') env.document.hidden = true;
    else env.document.focused = false;
    resolve('denied'); await pending;
    assert.equal(light.permissionDenied, true); assert.equal(light.status, 'suspended');
    assert.equal(light.interrupted, true); assert.equal(env.count('deviceorientation'), 0);
    if (state === 'hidden') { env.document.hidden = false; env.document.dispatch('visibilitychange'); }
    else { env.document.focused = true; env.dispatch('focus'); }
    assert.equal(light.status, 'denied'); assert.equal(env.count('deviceorientation'), 0);
    assert.equal(env.permissionCalls(), 1); light.destroy();
  }
});

test('permission completion stays paused in an unfocused page until trusted visible interaction', async () => {
  let resolve;
  const env = environment({ permission: () => new Promise(done => { resolve = done; }) });
  const light = new DeviceLighting({ environment: env });
  const pending = light.enable({ userGesture: true }); env.document.focused = false; env.dispatch('blur');
  resolve('granted'); await pending;
  assert.equal(light.status, 'suspended'); assert.equal(env.count('deviceorientation'), 0);
  env.document.dispatch('pointerdown', { isTrusted: false });
  assert.equal(env.count('deviceorientation'), 0);
  env.document.dispatch('pointerdown', { isTrusted: true });
  assert.equal(light.status, 'listening'); env.sample(0, 0); env.sample(0, 20);
  assert.ok(light.vector.x > 0); assert.equal(env.permissionCalls(), 1); light.destroy();
});

test('permission completing in a hidden page cannot resume until a visible return', async () => {
  let resolve;
  const env = environment({ permission: () => new Promise(done => { resolve = done; }) });
  const light = new DeviceLighting({ environment: env });
  const pending = light.enable({ userGesture: true }); env.document.hidden = true; env.dispatch('blur');
  resolve('granted'); await pending;
  assert.equal(light.status, 'suspended'); assert.equal(env.count('deviceorientation'), 0);
  env.document.dispatch('pointerdown', { isTrusted: true }); assert.equal(env.count('deviceorientation'), 0);
  env.document.hidden = false; env.document.dispatch('visibilitychange');
  assert.equal(light.status, 'listening'); assert.equal(env.permissionCalls(), 1); light.destroy();
});

test('trusted interaction cannot bypass hidden, reduced, suspended or insecure restrictions', async () => {
  const env = environment({ permission: 'granted' }), light = new DeviceLighting({ environment: env });
  await light.enable({ userGesture: true }); env.dispatch('blur');
  for (const [block, unblock] of [
    [() => { env.document.hidden = true; }, () => { env.document.hidden = false; }],
    [() => light.setReduced(true), () => light.setReduced(false)],
    [() => light.setSuspended(true), () => light.setSuspended(false)],
    [() => { env.isSecureContext = false; }, () => { env.isSecureContext = true; }]
  ]) {
    block(); env.document.dispatch('pointerdown', { isTrusted: true });
    assert.equal(env.count('deviceorientation'), 0); assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
    unblock(); env.dispatch('blur');
  }
  light.destroy();
});

test('pageshow or visibility return restores a focused page without a permission prompt', async () => {
  const env = environment({ permission: 'granted' }), light = new DeviceLighting({ environment: env });
  await light.enable(); env.dispatch('blur');
  env.dispatch('pageshow'); assert.equal(env.count('deviceorientation'), 1);
  env.sample(0, 0); assert.equal(light.status, 'granted');
  env.document.hidden = true; env.dispatch('blur'); env.document.dispatch('visibilitychange');
  assert.equal(env.count('deviceorientation'), 0);
  env.document.hidden = false; env.document.dispatch('visibilitychange');
  assert.equal(env.count('deviceorientation'), 1);
  assert.equal(env.permissionCalls(), 0); light.destroy();
});

test('loss of sensor data clears stale lighting and can recover without another permission prompt', async () => {
  const env = environment({ permission: 'granted' }), light = new DeviceLighting({ environment: env });
  await light.enable({ userGesture: true }); env.sample(0, 0); env.sample(0, 25);
  assert.equal(light.hasData, true); assert.ok(light.vector.x > 0);
  env.expire(); assert.equal(light.status, 'no-data'); assert.equal(light.hasData, false);
  assert.deepEqual(light.vector, { x: 0, y: 0, angle: 0 });
  env.sample(0, 25); assert.equal(light.status, 'granted'); env.sample(0, 35);
  assert.ok(light.vector.x > 0); assert.equal(env.permissionCalls(), 1); light.destroy();
});
