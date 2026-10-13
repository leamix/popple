import test from 'node:test';
import assert from 'node:assert/strict';
import { BurstLayer } from '../../public/js/audio/effects.js';
import { COMIC_SYMBOLS, chooseComicSymbol } from '../../public/js/core/comic-symbols.js';

const brandAccentModule = await import('../../public/js/app/brand-accent.js').catch(() => null);

function createLayer(context = {}) {
  const layer = new BurstLayer({
    style: {},
    setAttribute() {},
    getContext() { return context; },
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
  assert.equal(seen.size, COMIC_SYMBOLS.length, 'Repeated pops should use the complete approved catalogue.');
});

test('a normal-motion pop stays airy with six to eight distinct symbols', () => {
  const layer = createLayer();
  for (let serial = 1; serial <= 80; serial++) {
    layer.serial = serial;
    layer.burst(100, 100, 40);
    const rays = layer.bursts.at(-1).rays;
    assert.ok(rays.length >= 6 && rays.length <= 8,
      `Normal motion must use 6–8 symbols, received ${rays.length}.`);
    assert.equal(new Set(rays.map(ray => ray.kind)).size, rays.length,
      'A smaller burst must still not repeat a symbol.');
  }
});

test('a normal-motion pop spaces its symbols at equal angles', () => {
  const layer = createLayer();
  for (let serial = 1; serial <= 80; serial++) {
    layer.serial = serial;
    layer.burst(100, 100, 40);
    const rays = layer.bursts.at(-1).rays;
    const step = Math.PI * 2 / rays.length;
    for (let index = 1; index < rays.length; index++) {
      assert.ok(Math.abs((rays[index].angle - rays[index - 1].angle) - step) < 1e-10,
        'Adjacent symbols must keep a constant angular step.');
    }
  }
});

test('the rejected questions, sweat, moving puff and arrows are absent from bursts and logo choices', () => {
  const rejected = new Set(['question-pair', 'sweat-drops', 'moving-puff', 'attention-arrows']);
  assert.equal(COMIC_SYMBOLS.length, 16);
  assert.equal(COMIC_SYMBOLS.some(symbol => rejected.has(symbol.id)), false);
});

test('all four approved legacy families are available alongside the remaining manga designs', () => {
  const ids = new Set(COMIC_SYMBOLS.map(symbol => symbol.id));
  for (const id of ['legacy-dart', 'legacy-lightning', 'legacy-strokes', 'legacy-star']) assert.ok(ids.has(id), `${id} must be available for both consumers.`);
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

test('the logo excludes the tiny legacy star while retaining varied non-repeating accents', () => {
  assert.ok(brandAccentModule, 'The logo needs an independently loadable accent module.');
  const { BRAND_SYMBOL_INDICES, chooseBrandAccent } = brandAccentModule;
  const star = COMIC_SYMBOLS.findIndex(symbol => symbol.id === 'legacy-star');
  assert.equal(BRAND_SYMBOL_INDICES.includes(star), false, 'The tiny star is not a logo candidate.');
  for (const previous of BRAND_SYMBOL_INDICES) {
    const choices = new Set();
    for (let step = 0; step < BRAND_SYMBOL_INDICES.length * 10; step++) {
      choices.add(chooseBrandAccent(previous, () => step / (BRAND_SYMBOL_INDICES.length * 10)));
    }
    assert.equal(choices.size, BRAND_SYMBOL_INDICES.length - 1);
    assert.equal(choices.has(previous), false);
    assert.equal(choices.has(star), false);
  }
});

test('the logo glyph keeps its native lower side facing down', () => {
  assert.ok(brandAccentModule, 'The logo needs an independently loadable accent module.');
  const { BRAND_SYMBOL_INDICES, drawBrandAccent } = brandAccentModule;
  const OriginalPath2D = globalThis.Path2D;
  globalThis.Path2D = class { constructor(data) { this.data = data; } };
  try {
    let matrix = [1, 0, 0, 1, 0, 0];
    const drawings = [];
    const context = {
      setTransform(a, b, c, d, e, f) { matrix = [a, b, c, d, e, f]; },
      translate(x, y) {
        const [a, b, c, d, e, f] = matrix;
        matrix = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
      },
      rotate(angle) {
        const [a, b, c, d, e, f] = matrix, cosine = Math.cos(angle), sine = Math.sin(angle);
        matrix = [a * cosine + c * sine, b * cosine + d * sine,
          c * cosine - a * sine, d * cosine - b * sine, e, f];
      },
      scale(x, y) {
        const [a, b, c, d, e, f] = matrix;
        matrix = [a * x, b * x, c * y, d * y, e, f];
      },
      fill() { drawings.push([...matrix]); },
      stroke() { drawings.push([...matrix]); },
    };
    drawBrandAccent({ getContext() { return context; } }, BRAND_SYMBOL_INDICES[0], true, 1);
    assert.ok(drawings.length > 0, 'The logo symbol should draw immediately on its own canvas.');
    for (const [, , c, d] of drawings) {
      assert.ok(Math.abs(c) < 1e-10 && d > 0.8,
        `Native +Y (the lower side) must still point down; received (${c}, ${d}).`);
    }
  } finally {
    if (OriginalPath2D === undefined) delete globalThis.Path2D;
    else globalThis.Path2D = OriginalPath2D;
  }
});

test('each glyph faces the bubble radially at appearance and keeps facing it during flight', () => {
  // Record the real canvas transform at drawing time. Path2D itself only holds
  // path data; its browser rasterizer is irrelevant to this orientation check.
  const OriginalPath2D = globalThis.Path2D;
  globalThis.Path2D = class { constructor(data) { this.data = data; } };
  try {
    for (const reducedMotion of [false, true]) for (const radius of [18, 40, 90]) {
      let matrix = [1, 0, 0, 1, 0, 0];
      const stack = [], drawings = [];
      const context = {
        clearRect() { drawings.length = 0; },
        save() { stack.push([...matrix]); },
        restore() { matrix = stack.pop(); },
        translate(x, y) {
          const [a, b, c, d, e, f] = matrix;
          matrix = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
        },
        rotate(angle) {
          const [a, b, c, d, e, f] = matrix, cosine = Math.cos(angle), sine = Math.sin(angle);
          matrix = [a * cosine + c * sine, b * cosine + d * sine,
            c * cosine - a * sine, d * cosine - b * sine, e, f];
        },
        scale(x, y) {
          const [a, b, c, d, e, f] = matrix;
          matrix = [a * x, b * x, c * y, d * y, e, f];
        },
        beginPath() {}, rect() {}, arc() {}, clip() {}, fill() {},
        stroke() { drawings.push([...matrix]); },
      };
      const layer = createLayer(context);
      layer.serial = radius * 193;
      layer.burst(312, 208, radius, { reducedMotion });
      const burst = layer.bursts.at(-1);
      for (const age of [.035, burst.duration * .8]) {
        layer.render(burst.start + age);
        assert.ok(drawings.length >= burst.rays.length, 'Every symbol should have appeared by this sample.');
        for (const [, , c, d, x, y] of drawings) {
          const toCentreX = burst.x - x, toCentreY = burst.y - y;
          const alignment = (c * toCentreX + d * toCentreY) /
            (Math.hypot(c, d) * Math.hypot(toCentreX, toCentreY));
          assert.ok(alignment > 1 - 1e-10,
            `Native glyph +Y must point inward, independent of random placement or motion (alignment=${alignment}).`);
        }
      }
    }
  } finally {
    if (OriginalPath2D === undefined) delete globalThis.Path2D;
    else globalThis.Path2D = OriginalPath2D;
  }
});
