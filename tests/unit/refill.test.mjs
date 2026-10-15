import test from 'node:test';
import assert from 'node:assert/strict';
import * as physics from '../../public/js/core/physics.js';
import { SheetState } from '../../public/js/core/sheet.js';

function poppedBubble(index = 0) {
  const bubble = new physics.BubbleState(index);
  bubble.press(.65, -.3);
  for (let frame = 0; frame < 100; frame++) bubble.step(.01);
  bubble.release();
  return bubble;
}

function randomFor(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function refill(bubbles, options) {
  assert.equal(typeof physics.refillBubbles, 'function', 'physics must schedule animated refills');
  return physics.refillBubbles(bubbles, options);
}

test('refills start at varied overlapping times and all finish in 1–1.5 seconds', () => {
  for (const count of [1, 2, 7, 14]) for (const frequency of [30, 60, 120]) {
    const bubbles = Array.from({ length: count }, (_, index) => poppedBubble(index));
    const duration = refill(bubbles, { random: randomFor(count + frequency) });
    assert.ok(duration >= 1 && duration <= 1.5);
    assert.ok(bubbles.every(b => b.popped && b.refilling));
    const starts = new Map(), finishes = new Map();
    let events = 0;
    for (let frame = 1; frame <= Math.ceil(1.55 * frequency); frame++) {
      const time = frame / frequency;
      for (const b of bubbles) {
        events += Number(b.step(1 / frequency));
        if (b.collapse < .99 && !starts.has(b.index)) starts.set(b.index, time);
        if (!b.refilling && !finishes.has(b.index)) finishes.set(b.index, time);
      }
    }
    const orderedStarts = [...starts.values()].sort((a, b) => a - b);
    const orderedFinishes = [...finishes.values()].sort((a, b) => a - b);
    assert.equal(starts.size, count);
    assert.equal(finishes.size, count);
    assert.ok(orderedFinishes.at(-1) >= 1 && orderedFinishes.at(-1) <= 1.5 + 1 / frequency);
    if (count > 1) {
      assert.ok(orderedStarts.at(-1) > orderedStarts[0] + .2, 'starts must be visibly staggered');
      assert.ok(orderedStarts.at(-1) < orderedFinishes[0], 'next pockets inflate before earlier ones finish');
    }
    assert.equal(events, 0, 'inflation must never emit another pop');
    assert.ok(bubbles.every(b => !b.popped && b.collapse === 0 && b.compression === 0));
  }
});

test('inflation smoothly unfolds the existing film, ignores presses and does not restart', () => {
  const b = poppedBubble(3), seed = b.seed, contact = [b.popX, b.popY];
  refill([b], { random: () => .5 });
  const collapse = b.collapse, compression = b.compression;
  assert.equal(b.press(-.7, .2), false, 'a partly inflated pocket cannot pop');
  b.step(.05);
  assert.ok(b.collapse < collapse && b.collapse > .9);
  assert.ok(b.compression < compression);
  const afterFirstFrame = b.collapse;
  refill([b], { random: () => .1 });
  assert.equal(b.collapse, afterFirstFrame, 'another click must keep current progress');
  for (let frame = 0; frame < 23; frame++) {
    const previous = b.collapse;
    b.step(.05);
    assert.ok(b.collapse <= previous && b.collapse >= 0);
    assert.deepEqual([b.popX, b.popY], contact, 'wrinkles retain their contact until completely unfolded');
  }
  b.step(.06);
  assert.equal(b.refilling, false);
  assert.equal(b.seed, seed, 'identity must not jump at either end of inflation');
  assert.equal(b.press(0, 0), true);
  assert.equal(b.step(.1), false);
  assert.equal(b.step(.1), false);
  assert.equal(b.step(.1), true, 'the restored pocket keeps its normal hold time');
});

test('only popped pockets refill and reduced motion restores them immediately', () => {
  const intact = new physics.BubbleState(0), popped = poppedBubble(1);
  intact.press(.2, .3);
  const before = { ...intact };
  refill([intact, popped], { reduced: true });
  assert.deepEqual({ ...intact }, before);
  assert.equal(popped.popped, false);
  assert.equal(popped.refilling, false);
  assert.equal(popped.collapse, 0);
  assert.equal(refill([intact, popped]), 0, 'an intact sheet needs no refill');
});

test('reset or enabling reduced motion completes a pending refill without a later restart', () => {
  for (const finish of [b => b.reset(), b => refill([b], { reduced: true })]) {
    const b = poppedBubble();
    refill([b]);
    b.step(.1);
    finish(b);
    for (let frame = 0; frame < 30; frame++) assert.equal(b.step(.1), false);
    assert.ok(!b.refilling && !b.popped && b.collapse === 0);
  }
});

test('slow foreground frames catch up to the refill deadline without accelerating a hold', () => {
  const b = poppedBubble();
  refill([b], { random: () => .5 });
  b.step(.5);
  assert.ok(b.refilling && b.collapse > 0 && b.collapse < 1);
  b.step(.75);
  assert.ok(!b.refilling && !b.popped && b.collapse === 0);
  b.press(0, 0);
  assert.equal(b.step(1.75), false);
  assert.equal(b.popped, false, 'a slow frame still cannot finish a new hold');
});

test('a fresh pop pulse expires naturally while the pocket inflates', () => {
  const b = new physics.BubbleState();
  b.press(0, 0);
  for (let frame = 0; frame < 30; frame++) b.step(.01);
  const sheet = new SheetState();
  sheet.resize([{ x: 20, y: 20, radius: 10 }], 40, 40);
  sheet.update([b]);
  assert.ok(sheet.deformation[3] > 0);
  refill([b]);
  b.step(.5);
  sheet.update([b]);
  assert.equal(sheet.deformation[3], 0, 'inflation must not freeze the sheet at its initial rupture pulse');
});

test('a new refill randomizes pocket order and the spacing between starts', () => {
  const sequences = [];
  for (const seed of [12, 345]) {
    const bubbles = Array.from({ length: 7 }, (_, index) => poppedBubble(index));
    refill(bubbles, { random: randomFor(seed) });
    const starts = [];
    for (let frame = 0; frame < 120; frame++) for (const b of bubbles) {
      b.step(.01);
      if (b.collapse < .99 && !starts.some(start => start.index === b.index)) starts.push({ index: b.index, frame });
    }
    assert.equal(starts.length, 7);
    const gaps = starts.slice(1).map((start, i) => start.frame - starts[i].frame);
    assert.ok(new Set(gaps).size > 1, 'the delay must not be a fixed interval');
    sequences.push(starts.map(start => start.index));
  }
  assert.notDeepEqual(sequences[0], sequences[1]);
});
