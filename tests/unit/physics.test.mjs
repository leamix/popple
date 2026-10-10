import test from 'node:test';
import assert from 'node:assert/strict';
import { BubbleState } from './physics.js';

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
  assert.equal(advance(bubble, 0.45), 0);
  bubble.release();
  bubble.press(0, 0);
  assert.equal(advance(bubble, 0.45), 0);
  assert.equal(bubble.popped, false);
  assert.equal(advance(bubble, 0.34), 1);
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
  advance(edge, 0.3);
  advance(center, 0.3);
  assert.ok(edge.x < -0.7);
  assert.ok(edge.y > 0.3);
  assert.ok(edge.bulge > center.bulge * 1.5);
  edge.move(0.5, -0.2);
  advance(edge, 0.22);
  assert.ok(edge.x > 0.4);
  assert.ok(edge.y < -0.15);
});

test('opposite edge ruptures preserve their contact after release and settling', () => {
  for (const [x, y] of [[-0.8, 0.25], [0.8, -0.25]]) {
    const bubble = new BubbleState(8);
    bubble.press(x, y);
    assert.equal(advance(bubble, 0.8), 1);
    assert.equal(bubble.popX, x);
    assert.equal(bubble.popY, y);
    bubble.release();
    assert.equal(bubble.move(-x, -y), false);
    assert.equal(bubble.press(-x, -y), false);
    advance(bubble, 1.5);
    assert.equal(bubble.popX, x);
    assert.equal(bubble.popY, y);
    assert.ok(Math.abs(bubble.x) < 0.001 && Math.abs(bubble.y) < 0.001,
      'live deformation may recenter without moving the saved rupture contact');
  }
});

test('rupture captures the latest contact even when the deformation still lags', () => {
  const bubble = new BubbleState(9);
  bubble.press(-0.65, 0.2);
  advance(bubble, 0.77);
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
  assert.equal(advance(variable, 0.51), 0);
  assert.equal(variable.popped, false);
  assert.equal(advance(variable, 0.06), 1);
  assert.equal(advance(fixed, 0.57), 0);
  assert.equal(advance(fixed, 0.22), 1);
});

test('release cancels a near-complete hold and reset restores the same pocket', () => {
  const bubble = new BubbleState(6);
  const seed = bubble.seed;
  bubble.press(0, 0);
  advance(bubble, 0.76);
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
  assert.ok(bubble.holdProgress < 0.13);
  for (const key of ['x', 'y', 'popX', 'popY', 'compression', 'bulge', 'collapse', 'popAge', 'holdProgress']) {
    assert.ok(Number.isFinite(bubble[key]), `${key} stays finite`);
  }
});

test('hold duration remains consistent from 10 to 120 frames per second', () => {
  for (const frequency of [10, 15, 30, 60, 120]) {
    const bubble = new BubbleState(frequency);
    bubble.press(0.5, 0.1);
    assert.equal(advance(bubble, 0.75, frequency), 0);
    assert.equal(advance(bubble, 0.06, frequency), 1);
    assert.equal(advance(bubble, 1, frequency), 0);
    assert.ok(bubble.collapse > 0.99);
  }
});
