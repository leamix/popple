import test from 'node:test';
import assert from 'node:assert/strict';
import { BubbleState, DEFAULT_HOLD_SECONDS } from '../../public/js/core/physics.js';

function advance(bubble, seconds, frequency = 120) {
  let events = 0;
  for (let t = 0; t < seconds - 1e-8; t += 1 / frequency) {
    events += Number(bubble.step(Math.min(1 / frequency, seconds - t), t));
  }
  return events;
}

test('a tap deforms immediately, releases without popping and returns to rest', () => {
  const bubble = new BubbleState(0);
  bubble.press(0.2, -0.3);
  assert.ok(bubble.compression > 0);
  advance(bubble, 0.12);
  assert.ok(bubble.compression > 0.16);
  bubble.release();
  assert.equal(bubble.holdProgress, 0);
  advance(bubble, 1.2);
  assert.equal(bubble.popped, false);
  assert.equal(bubble.compression, 0);
  assert.equal(bubble.bulge, 0);
  assert.equal(bubble.x, 0);
  assert.equal(bubble.y, 0);
});

test('two short holds never accumulate and a complete hold pops once', () => {
  const bubble = new BubbleState(1);
  bubble.press(0, 0);
  assert.equal(advance(bubble, 0.16), 0);
  bubble.release();
  bubble.press(0, 0);
  assert.equal(advance(bubble, 0.16), 0);
  assert.equal(bubble.popped, false);
  assert.equal(advance(bubble, 0.14), 1);
  assert.equal(bubble.holdProgress, 1);
  assert.equal(advance(bubble, 1), 0);
  assert.equal(bubble.press(0, 0), false);
  assert.ok(bubble.collapse > 0.99);
});

test('off-centre contact retains its direction and displaces more air', () => {
  const edge = new BubbleState(2);
  const center = new BubbleState(3);
  edge.press(-0.75, 0.35);
  center.press(0, 0);
  advance(edge, 0.24);
  advance(center, 0.24);
  assert.ok(edge.x < -0.7);
  assert.ok(edge.y > 0.3);
  assert.ok(edge.bulge > center.bulge * 1.5);
  edge.move(0.5, -0.2);
  advance(edge, 0.22);
  assert.ok(edge.x > 0.4);
  assert.ok(edge.y < -0.15);
});

test('opposite edge ruptures preserve their creases after new film contact and settling', () => {
  for (const [x, y] of [[-0.8, 0.25], [0.8, -0.25]]) {
    const bubble = new BubbleState(8);
    bubble.press(x, y);
    assert.equal(advance(bubble, 0.8), 1);
    assert.equal(bubble.popX, x);
    assert.equal(bubble.popY, y);
    bubble.release();
    assert.equal(bubble.move(-x, -y), false);
    assert.equal(bubble.press(-x, -y), true);
    assert.equal(advance(bubble, 0.4), 0);
    bubble.release();
    advance(bubble, 1.5);
    assert.equal(bubble.popX, x);
    assert.equal(bubble.popY, y);
    assert.ok(Math.abs(bubble.x) < 0.001 && Math.abs(bubble.y) < 0.001,
      'live deformation may recenter without moving the saved rupture contact');
  }
});

test('a held finger keeps deforming the film after its single rupture', () => {
  const bubble = new BubbleState(11);
  bubble.press(-0.6, 0.2);
  assert.equal(advance(bubble, DEFAULT_HOLD_SECONDS), 1);
  assert.equal(bubble.active, true);
  assert.equal(bubble.move(0.6, -0.4), true);
  assert.equal(advance(bubble, 0.5), 0);
  assert.ok(bubble.x > 0.55 && bubble.y < -0.35);
  assert.ok(bubble.compression > 0.1 && bubble.compression < 0.2);
  assert.equal(bubble.bulge, 0, 'the ruptured film has no air to displace');
  assert.equal(bubble.holdProgress, 1);
  assert.equal(bubble.popX, -0.6);
  assert.equal(bubble.popY, 0.2);
});

test('popped film kneads shallowly, dissipates a release and never reinflates or repops', () => {
  const bubble = new BubbleState(12);
  bubble.press(0.4, -0.5);
  assert.equal(advance(bubble, 0.8), 1);
  bubble.release();
  advance(bubble, 1.5);
  const age = bubble.popAge;
  const collapse = bubble.collapse;
  assert.equal(bubble.compression, 0.06);
  assert.equal(bubble.press(-0.7, 0.3, 0.3), true);
  assert.equal(bubble.press(0, 0), false, 'one film accepts one live contact');
  assert.ok(bubble.compression > 0.06);
  assert.equal(bubble.popAge, age, 'a new touch does not restart collapse');
  assert.equal(bubble.collapse, collapse);
  bubble.move(0.7, -0.3, 0.9);
  assert.equal(advance(bubble, 2), 0);
  assert.ok(bubble.x > 0.65 && bubble.y < -0.25);
  assert.ok(bubble.compression > 0.13 && bubble.compression < 0.2);
  assert.ok(bubble.popAge > age);
  assert.equal(bubble.bulge, 0);
  bubble.release();
  let previous = bubble.compression;
  for (let frame = 0; frame < 180; frame += 1) {
    assert.equal(bubble.step(1 / 120), false);
    assert.ok(bubble.compression <= previous + 1e-9, 'release cannot spring back into a dome');
    assert.ok(bubble.compression >= 0.06 - 1e-9);
    assert.equal(bubble.bulge, 0);
    previous = bubble.compression;
  }
  assert.equal(bubble.compression, 0.06);
  assert.equal(bubble.x, 0);
  assert.equal(bubble.y, 0);
  assert.equal(bubble.popX, 0.4);
  assert.equal(bubble.popY, -0.5);
  assert.equal(bubble.popped, true);
  assert.equal(bubble.holdProgress, 1);
});

test('nominal hold time uses the new default and follows a configured duration', () => {
  assert.equal(DEFAULT_HOLD_SECONDS, 0.3);
  for (const duration of [DEFAULT_HOLD_SECONDS, 0.2, 0.4, 1.2, 2]) {
    const bubble = new BubbleState(13, duration);
    assert.equal(bubble.holdDuration, duration);
    bubble.press(0, 0);
    assert.equal(advance(bubble, duration - 0.01), 0);
    assert.equal(advance(bubble, 0.01), 1);
    assert.equal(advance(bubble, 1), 0);
    bubble.reset();
    assert.equal(bubble.holdDuration, duration, 'sheet reset preserves the selected response');
  }
});

test('hold duration changes clamp to supported times and discard invalid values', () => {
  const bubble = new BubbleState(14);
  assert.equal(bubble.holdDuration, DEFAULT_HOLD_SECONDS);
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '1']) {
    assert.equal(bubble.setHoldDuration(invalid), DEFAULT_HOLD_SECONDS);
  }
  assert.equal(bubble.setHoldDuration(-10), 0.2);
  assert.equal(bubble.setHoldDuration(100), 2);
  assert.equal(bubble.setHoldDuration(1.1), 1.1);
  bubble.press(0, 0);
  assert.equal(advance(bubble, 1.09), 0);
  assert.equal(advance(bubble, 0.01), 1);
});

test('genuine variable force shortens hold time proportionally at every setting', () => {
  for (const duration of [DEFAULT_HOLD_SECONDS, 0.3, 1.2, 2]) {
    const variable = new BubbleState(15, duration);
    const fixed = new BubbleState(16, duration);
    variable.press(0, 0, 0.3);
    variable.move(0, 0, 0.9);
    variable.move(0, 0, 1);
    fixed.press(0, 0, 1);
    const forceDuration = duration * (0.2 / 0.3);
    assert.equal(advance(variable, forceDuration - 0.01), 0);
    assert.equal(advance(variable, 0.01), 1);
    assert.equal(advance(fixed, forceDuration), 0, 'fixed pressure hardware retains nominal timing');
    assert.equal(advance(fixed, duration - forceDuration), 1);
  }
});

test('rupture captures the latest contact even when the deformation still lags', () => {
  const bubble = new BubbleState(9);
  bubble.press(-0.65, 0.2);
  advance(bubble, 0.29);
  bubble.move(0.7, -0.3);
  assert.ok(bubble.x < 0, 'the spring has not reached the new contact');
  assert.equal(bubble.step(0.02), true);
  assert.equal(bubble.popX, 0.7);
  assert.equal(bubble.popY, -0.3);
  assert.ok(bubble.x < 0, 'the saved position must not come from the lagging spring');
});

test('reset clears the rupture contact and the next rupture captures a new one', () => {
  const bubble = new BubbleState(10);
  bubble.press(0.6, -0.4);
  advance(bubble, 0.8);
  bubble.reset();
  assert.equal(bubble.popX, 0);
  assert.equal(bubble.popY, 0);
  bubble.press(-0.5, 0.35);
  assert.equal(bubble.popX, 0);
  assert.equal(bubble.popY, 0);
  assert.equal(advance(bubble, 0.8), 1);
  assert.equal(bubble.popX, -0.5);
  assert.equal(bubble.popY, 0.35);
});

test('variable force accelerates a pop but a fixed hardware value does not', () => {
  const variable = new BubbleState(4);
  const fixed = new BubbleState(5);
  variable.press(0, 0, 0.3);
  fixed.press(0, 0, 1);
  variable.move(0, 0, 0.9);
  assert.equal(advance(variable, 0.19), 0);
  assert.equal(variable.popped, false);
  assert.equal(advance(variable, 0.03), 1);
  assert.equal(advance(fixed, 0.22), 0);
  assert.equal(advance(fixed, 0.1), 1);
});

test('release cancels a near-complete hold and reset restores the same pocket', () => {
  const bubble = new BubbleState(6);
  const seed = bubble.seed;
  bubble.press(0, 0);
  advance(bubble, 0.28);
  bubble.release();
  advance(bubble, 0.2);
  assert.equal(bubble.popped, false);
  bubble.press(0, 0);
  assert.equal(advance(bubble, 0.8), 1);
  bubble.reset();
  assert.equal(bubble.seed, seed);
  assert.equal(bubble.popped, false);
  assert.equal(bubble.popAge, 0);
  assert.equal(bubble.collapse, 0);
  assert.equal(bubble.compression, 0);
  bubble.press(0, 0);
  assert.equal(advance(bubble, 0.8), 1);
});

test('stalled, invalid and negative frames cannot jump the hold or corrupt state', () => {
  const bubble = new BubbleState(7);
  bubble.press(NaN, Infinity, NaN, Infinity);
  for (const dt of [NaN, Infinity, -1, 0]) assert.equal(bubble.step(dt, Infinity), false);
  assert.equal(bubble.holdProgress, 0);
  assert.equal(bubble.step(1000, 1000), false);
  assert.ok(bubble.holdProgress < 0.34);
  for (const key of ['x', 'y', 'popX', 'popY', 'compression', 'bulge', 'collapse', 'popAge', 'holdProgress']) {
    assert.ok(Number.isFinite(bubble[key]), `${key} stays finite`);
  }
});

test('hold duration remains consistent from 10 to 120 frames per second', () => {
  for (const frequency of [10, 15, 30, 60, 120]) {
    const bubble = new BubbleState(frequency);
    bubble.press(0.5, 0.1);
    assert.equal(advance(bubble, 0.27, frequency), 0);
    assert.equal(advance(bubble, 0.06, frequency), 1);
    assert.equal(advance(bubble, 1, frequency), 0);
    assert.ok(bubble.collapse > 0.99);
  }
});
