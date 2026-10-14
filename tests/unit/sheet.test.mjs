import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetState, MAX_SHEET_SITES } from '../../public/js/core/sheet.js';
import { BubbleState } from '../../public/js/core/physics.js';
import { createBubbleLayout } from '../../public/js/core/layout.js';
import { SHEET_CONFIG } from '../../public/js/core/config.js';

const pocket = (x, y, radius = 10) => ({ x, y, radius });
const states = count => Array.from({ length: count }, (_, index) => new BubbleState(index));
const tension = (sheet, index) => sheet.deformation[index * 4 + 2];
const pulse = (sheet, index) => sheet.deformation[index * 4 + 3];
const advance = (bubble, seconds) => {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 1 / 120) bubble.step(1 / 120);
};

// A second-hop spread would move the rightmost pocket; a whole-sheet spread
// would move the isolated pocket. Neither shares the pressed pocket's weld.
test('press tension reaches adjacent pockets but does not propagate twice or across empty sheet', () => {
  const sheet = new SheetState();
  sheet.resize([pocket(20, 20), pocket(44, 20), pocket(68, 20), pocket(180, 20)], 200, 50);
  const bubbles = states(4);
  bubbles[0].press(0.3, 0);
  advance(bubbles[0], 0.15);
  sheet.update(bubbles);
  assert.ok(tension(sheet, 0) > 0.1);
  assert.ok(tension(sheet, 1) > 0);
  assert.ok(sheet.deformation[4] < 0, 'the adjacent weld pulls toward contact');
  assert.deepEqual(Array.from(sheet.deformation.slice(8)), Array(8).fill(0));
});

test('released air pocket keeps a small sheet response until its spring settles', () => {
  const sheet = new SheetState();
  sheet.resize([pocket(20, 20), pocket(44, 20)], 70, 50);
  const bubbles = states(2);
  bubbles[0].press(0, 0);
  advance(bubbles[0], 0.12);
  sheet.update(bubbles);
  const pressedTension = tension(sheet, 1);
  bubbles[0].release();
  sheet.update(bubbles);
  assert.ok(tension(sheet, 1) > 0, 'release must not sever the sheet instantly');
  advance(bubbles[0], 2);
  sheet.update(bubbles);
  assert.ok(tension(sheet, 1) < pressedTension * 0.01);
});

test('one firm press gives visible local weld travel without activating neighbours', () => {
  const geometry=createBubbleLayout(390);
  const sheet=new SheetState();
  sheet.resize(geometry.layout,geometry.width,geometry.height);
  const bubbles=states(geometry.layout.length);
  bubbles[4].press(0.4,-0.2);
  bubbles[4].compression=0.7;bubbles[4].bulge=0.3;
  sheet.update(bubbles);
  for(const index of sheet.neighbours[4]) {
    const offset=index*4;
    assert.ok(Math.hypot(sheet.deformation[offset],sheet.deformation[offset+1])>0.0175,
      'a firm press should move each adjacent weld by more than 1.75% of its radius');
    assert.ok(tension(sheet,index)>0.075,'the adjacent shoulder should visibly relight');
    assert.equal(bubbles[index].active,false);assert.equal(bubbles[index].compression,0);
  }
  assert.ok(SHEET_CONFIG.supportRadius>=3+SHEET_CONFIG.maximumOffset,
    'render tile supports must include the largest possible weld travel');
});

test('a pop creates one damped local pulse and reduced motion suppresses it', () => {
  const sheet = new SheetState();
  sheet.resize([pocket(20, 20), pocket(44, 20), pocket(180, 20)], 200, 50);
  const bubbles = states(3);
  bubbles[0].press(0.2, 0.1);
  advance(bubbles[0], 0.3);
  assert.equal(bubbles[0].popped, true);
  sheet.update(bubbles);
  assert.ok(pulse(sheet, 0) > 0);
  assert.ok(pulse(sheet, 1) > 0);
  assert.equal(pulse(sheet, 2), 0);
  sheet.update(bubbles, true);
  assert.equal(pulse(sheet, 0), 0);
  assert.equal(pulse(sheet, 1), 0);
  assert.ok(tension(sheet, 1) > 0, 'contact tension remains with reduced motion');
  bubbles[0].release();
  advance(bubbles[0], 0.4);
  sheet.update(bubbles);
  assert.equal(pulse(sheet, 0), 0);
  assert.equal(pulse(sheet, 1), 0);
});

test('popped film has no lasting tension at rest and still responds to kneading', () => {
  const sheet = new SheetState();
  sheet.resize([pocket(20, 20), pocket(44, 20)], 70, 50);
  const bubbles = states(2);
  bubbles[0].press(0, 0);
  advance(bubbles[0], 0.3);
  bubbles[0].release();
  advance(bubbles[0], 2);
  sheet.update(bubbles);
  assert.ok(tension(sheet, 1) < 0.00001);
  bubbles[0].press(0.5, 0);
  advance(bubbles[0], 0.1);
  sheet.update(bubbles);
  assert.ok(tension(sheet, 1) > 0);
});

test('multiple contacts stay subtle, reuse cached arrays, and never change pocket physics', () => {
  const geometry = createBubbleLayout(390);
  const sheet = new SheetState();
  sheet.resize(geometry.layout, geometry.width, geometry.height);
  const bubbles = states(geometry.layout.length);
  for (const bubble of bubbles) {
    bubble.press(0.5, -0.5);
    advance(bubble, 0.25);
  }
  const before = bubbles.map(bubble => ({ ...bubble }));
  const deformation = sheet.deformation;
  const tiles = sheet.tiles;
  const neighbours = sheet.neighbours;
  sheet.update(bubbles);
  sheet.update(bubbles);
  assert.equal(sheet.deformation, deformation);
  assert.equal(sheet.tiles, tiles);
  assert.equal(sheet.neighbours, neighbours);
  assert.deepEqual(bubbles.map(bubble => ({ ...bubble })), before);
  for (let index = 0; index < bubbles.length; index += 1) {
    assert.ok(Math.hypot(deformation[index * 4], deformation[index * 4 + 1]) <= 0.050001);
    assert.ok(tension(sheet, index) >= 0 && tension(sheet, index) <= 1);
    assert.ok(neighbours[index].length <= 6);
  }
  sheet.reset();
  assert.ok(deformation.every(value => value === 0));
});

const lattice = count => {
  const columns = Math.ceil(Math.sqrt(count));
  const radius = 10;
  const pitch = 22.6;
  const layout = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    return pocket(20 + (index % columns + (row % 2) * 0.5) * pitch, 20 + row * pitch * Math.sqrt(3) / 2, radius);
  });
  return { layout, width: 40 + columns * pitch, height: 40 + Math.ceil(count / columns) * pitch * Math.sqrt(3) / 2 };
};

const intersects = (site, tile) => {
  const nearestX = Math.max(tile.x, Math.min(site.x, tile.x + tile.width));
  const nearestY = Math.max(tile.y, Math.min(site.y, tile.y + tile.height));
  return Math.hypot(site.x - nearestX, site.y - nearestY) <= site.radius * SHEET_CONFIG.supportRadius;
};

test('render tiles cover the clipped viewport exactly and retain every intersecting support disc', () => {
  const layout = [pocket(-4, 10), pocket(24, 22), pocket(48, 37)];
  const sheet = new SheetState();
  sheet.resize(layout, 51, 43);
  let area = 0;
  for (const tile of sheet.tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.width > 0 && tile.height > 0);
    assert.ok(tile.x + tile.width <= 51 && tile.y + tile.height <= 43);
    area += tile.width * tile.height;
    const expected = layout.flatMap((site, index) => intersects(site, tile) ? [index] : []);
    assert.deepEqual(Array.from(tile.indices).sort((a, b) => a - b), expected);
  }
  assert.equal(area, 51 * 43);
  for (let a = 0; a < sheet.tiles.length; a += 1) {
    for (let b = a + 1; b < sheet.tiles.length; b += 1) {
      const first = sheet.tiles[a], second = sheet.tiles[b];
      assert.ok(first.x + first.width <= second.x || second.x + second.width <= first.x
        || first.y + first.height <= second.y || second.y + second.height <= first.y);
    }
  }
});

test('current hex sheet and large regular sheets retain bounded local rendering and six welds', () => {
  const current = createBubbleLayout(390);
  for (const geometry of [current, lattice(100), lattice(1000), lattice(10000)]) {
    const sheet = new SheetState();
    sheet.resize(geometry.layout, geometry.width, geometry.height);
    assert.ok(sheet.tiles.length > 0);
    if (geometry.layout.length >= 100) {
      assert.ok(sheet.tiles.length < geometry.layout.length * 0.5, 'cached tile batch count must stay below half the site count');
    }
    assert.ok(sheet.tiles.every(tile => tile.indices.length <= MAX_SHEET_SITES));
    assert.ok(sheet.neighbours.every(adjacent => adjacent.length <= 6));
    const references = sheet.tiles.reduce((sum, tile) => sum + tile.indices.length, 0);
    assert.ok(references < geometry.layout.length * 18, 'candidate work must scale with local area');
    const middle = Math.floor(geometry.layout.length / 2);
    if (geometry.layout.length > 100) assert.equal(sheet.neighbours[middle + 1].length, 6);
    // Brute-force expected candidates only for a few spatially separate tiles.
    // This catches hash cell-edge omissions without making the test quadratic.
    for (const tileIndex of [0, Math.floor(sheet.tiles.length / 3), Math.floor(sheet.tiles.length * 2 / 3), sheet.tiles.length - 1]) {
      const tile = sheet.tiles[tileIndex];
      const expected = geometry.layout.flatMap((site, index) => intersects(site, tile) ? [index] : []);
      assert.deepEqual(Array.from(tile.indices).sort((a, b) => a - b), expected);
    }
  }
});

test('resize refreshes original site IDs and caches while an empty sheet still draws its background', () => {
  const sheet = new SheetState();
  sheet.resize([pocket(20, 20), pocket(44, 20)], 70, 50);
  const old = sheet.deformation;
  sheet.resize([pocket(20, 20)], 35, 25);
  assert.notEqual(sheet.deformation, old);
  assert.equal(sheet.deformation.length, 4);
  assert.deepEqual(Array.from(sheet.neighbours[0]), []);
  assert.ok(sheet.tiles.every(tile => Array.from(tile.indices).every(index => index === 0)));
  sheet.resize([], 35, 25);
  assert.equal(sheet.deformation.length, 0);
  assert.equal(sheet.tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0), 35 * 25);
  assert.ok(sheet.tiles.every(tile => tile.indices.length === 0));
});

test('impossible dense overlap fails explicitly instead of dropping shader sites', () => {
  const sheet = new SheetState();
  assert.throws(() => sheet.resize(Array.from({ length: 25 }, () => pocket(20, 20)), 40, 40), /dense|overlap|24/i);
});

test('hashed hit testing finds actual discs at cell edges and preserves earliest overlap identity', () => {
  const sheet = new SheetState();
  sheet.resize([pocket(20, 20), pocket(29, 20), pocket(180, 20)], 200, 50);
  assert.equal(sheet.hitIndex(20, 20), 0);
  assert.equal(sheet.hitIndex(28, 20), 0, 'overlap uses the original lowest site identity');
  assert.equal(sheet.hitIndex(38, 20), 1);
  assert.equal(sheet.hitIndex(180, 20), 2);
  assert.equal(sheet.hitIndex(80, 20), -1);
  assert.equal(sheet.hitIndex(29, 31), -1, 'a bounding square is not a disc');
  assert.equal(sheet.hitIndex(NaN, 20), -1);
});
