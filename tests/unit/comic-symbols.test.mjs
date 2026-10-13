import test from 'node:test';
import assert from 'node:assert/strict';
import { BurstLayer } from '../../public/js/audio/effects.js';
import { COMIC_SYMBOLS, chooseComicSymbol } from '../../public/js/core/comic-symbols.js';

function createLayer() {
  const layer = new BurstLayer({
    style: {},
    setAttribute() {},
    getContext() { return {}; },
  });
  layer.serial = 42;
  return layer;
}

test('a pop uses a varied group of distinct manga symbols', () => {
  const layer = createLayer();
  const seen = new Set();
  for (let pop = 0; pop < 80; pop++) {
    layer.burst(100, 100, 40);
    const rays = layer.bursts.at(-1).rays;
    assert.equal(new Set(rays.map(ray => ray.kind)).size, rays.length,
      'One pop should not repeat the same doodle.');
    rays.forEach(ray => seen.add(ray.kind));
  }
  assert.ok(seen.size >= 16, `Expected at least 16 symbol designs, found ${seen.size}.`);
});

test('reduced motion keeps the symbol variety without animated travel or rotation', () => {
  const layer = createLayer();
  layer.burst(100, 100, 40, { reducedMotion: true });
  const burst = layer.bursts.at(-1);
  assert.equal(burst.duration, 0.18);
  assert.ok(burst.rays.length >= 3 && burst.rays.length <= 5);
  assert.equal(new Set(burst.rays.map(ray => ray.kind)).size, burst.rays.length);
  for (const ray of burst.rays) {
    assert.equal(ray.delay, 0);
    assert.equal(ray.turn, 0);
  }
});

test('reloading can select every other logo symbol without repeating the previous one', () => {
  for (let previous = 0; previous < COMIC_SYMBOLS.length; previous++) {
    const choices = new Set();
    for (let step = 0; step < 160; step++) {
      choices.add(chooseComicSymbol(previous, () => step / 160));
    }
    assert.equal(choices.size, COMIC_SYMBOLS.length - 1);
    assert.equal(choices.has(previous), false);
    for (const choice of choices) assert.ok(COMIC_SYMBOLS[choice]);
  }
  for (const previous of [-1, 100, NaN]) {
    assert.equal(chooseComicSymbol(previous, () => 0), 0);
    assert.equal(chooseComicSymbol(previous, () => 0.999), COMIC_SYMBOLS.length - 1);
  }
});
