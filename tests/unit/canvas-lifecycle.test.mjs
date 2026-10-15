import test from 'node:test';
import assert from 'node:assert/strict';
import { FilmRenderer } from '../../public/js/rendering/renderer.js';
import { BurstLayer } from '../../public/js/audio/effects.js';

// Canvas storage and drawing are browser-owned. Keep the actual classes and
// record their writes at that boundary without starting a browser or GPU.
function canvas(width = 100, height = 200) {
  const writes = [], clears = [], transforms = [];
  const context = new Proxy({
    clearRect: (...args) => clears.push(args),
    setTransform: (...args) => transforms.push(args),
  }, { get: (target, property) => property in target ? target[property] : () => {} });
  return {
    writes, clears, transforms, style: {},
    get width() { return width; },
    set width(value) { writes.push(['width', value]); width = value; },
    get height() { return height; },
    set height(value) { writes.push(['height', value]); height = value; },
    getContext: () => context,
    setAttribute() {},
  };
}

test('film resize changes only framebuffer dimensions whose rounded pixels differ', () => {
  const surface = canvas(), renderer = Object.create(FilmRenderer.prototype);
  renderer.canvas = surface;
  renderer.resize(50, 100, 2);
  renderer.resize(50.1, 100.1, 2);
  assert.deepEqual(surface.writes, [], 'unchanged rounded dimensions must not clear and reallocate the WebGL drawing buffer');
  renderer.resize(51, 100.1, 2);
  assert.deepEqual(surface.writes, [['width', 102]]);
  renderer.resize(51, 101, 2);
  assert.deepEqual(surface.writes, [['width', 102], ['height', 202]]);
  assert.deepEqual(renderer.geometry, { width: 51, height: 101, dpr: 2, framebufferWidth: 102, framebufferHeight: 202 });
});

test('burst resize preserves same-size storage and restores the DPR transform after a real dimension change', () => {
  const surface = canvas(), layer = new BurstLayer(surface);
  layer.resize(50, 100, 2);
  layer.resize(50.1, 100.1, 2);
  assert.deepEqual(surface.writes, []);
  assert.equal(surface.style.width, '50.1px');
  layer.resize(51, 100.1, 2);
  assert.deepEqual(surface.writes, [['width', 102]]);
  assert.deepEqual(surface.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
});

test('empty burst frames leave an already clear overlay untouched and the last burst clears once', t => {
  const originalPath = globalThis.Path2D;
  globalThis.Path2D = class { constructor(source) { this.source = source; } };
  t.after(() => { if (originalPath === undefined) delete globalThis.Path2D; else globalThis.Path2D = originalPath; });
  const surface = canvas(), layer = new BurstLayer(surface);
  layer.resize(50, 100, 2);
  assert.equal(layer.render(1), false);
  assert.equal(layer.render(2), false);
  assert.equal(surface.clears.length, 0);
  layer.burst(20, 20, 6, { reducedMotion: true });
  const start = layer.bursts[0].start;
  assert.equal(layer.render(start), true);
  assert.equal(layer.render(start + 10), false);
  assert.equal(surface.clears.length, 2, 'the final active frame must be cleared after expiry');
  assert.equal(layer.render(start + 11), false);
  layer.clear();
  assert.equal(surface.clears.length, 2);
  layer.burst(20, 20, 6, { reducedMotion: true });
  layer.render(layer.bursts[0].start);
  layer.clear();
  assert.equal(layer.render(start + 12), false);
  assert.equal(surface.clears.length, 4, 'explicit clearing after drawing removes pixels exactly once');
});
