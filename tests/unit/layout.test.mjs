import test from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_COUNT, ROW_COUNTS, MAX_FILM_SCALE, FILM_GAP, STAGE_PADDING, createBubbleLayout } from './layout.js';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

test('four centred staggered rows contain 3, 4, 3, 4 pockets', () => {
  const { layout, width, pitch, rowPitch } = createBubbleLayout(1440, 84);
  assert.equal(BUBBLE_COUNT, 14);
  assert.equal(layout.length, BUBBLE_COUNT);
  ROW_COUNTS.forEach((count, row) => {
    const pockets = layout.filter(pocket => pocket.row === row);
    assert.equal(pockets.length, count);
    close(pockets.reduce((sum, pocket) => sum + pocket.x, 0) / count, width / 2);
    for (let column = 1; column < count; column++) close(pockets[column].x - pockets[column - 1].x, pitch);
  });
  close(layout[0].x - layout[3].x, pitch / 2);
  close(layout[7].x - layout[10].x, pitch / 2);
  close(layout[3].y - layout[0].y, rowPitch);
  close(rowPitch / pitch, Math.sqrt(3) / 2);
});

test('desktop keeps the requested 84px hit target and a rectangular stage', () => {
  const layout = createBubbleLayout(1365, 84);
  close(layout.diameter, 84);
  assert.ok(layout.width >= 430 && layout.width <= 440);
  assert.ok(layout.height < layout.width);
  assert.ok(layout.height > 390 && layout.height < 400);
});

test('320px and 390px screens fit every rim, including simultaneous deformation', () => {
  for (const viewport of [320, 390]) {
    for (const requestedDiameter of [64, 84, 100]) {
      const { layout, width, height, diameter } = createBubbleLayout(viewport, requestedDiameter);
      assert.ok(width <= viewport - 12);
      assert.ok(diameter <= requestedDiameter);
      for (const pocket of layout) {
        const reach = pocket.radius * MAX_FILM_SCALE;
        assert.ok(pocket.x - reach >= STAGE_PADDING - 1e-8);
        assert.ok(pocket.x + reach <= width - STAGE_PADDING + 1e-8);
        assert.ok(pocket.y - reach >= STAGE_PADDING - 1e-8);
        assert.ok(pocket.y + reach <= height - STAGE_PADDING + 1e-8);
      }
      for (let a = 0; a < layout.length; a++) {
        for (let b = a + 1; b < layout.length; b++) {
          const left = layout[a], right = layout[b];
          const separation = Math.hypot(left.x - right.x, left.y - right.y);
          const combinedRadii = (left.radius + right.radius) * MAX_FILM_SCALE;
          assert.ok(separation >= combinedRadii + FILM_GAP - 1e-8,
            `${viewport}px: pockets ${a}/${b} must keep their ${FILM_GAP}px gap`);
        }
      }
    }
  }
});

test('resizing changes size and position while preserving row-major pocket identities', () => {
  const wide = createBubbleLayout(1440, 84);
  const narrow = createBubbleLayout(320, 84);
  assert.ok(narrow.diameter < wide.diameter);
  assert.deepEqual(narrow.layout.map(({ row, column }) => [row, column]), wide.layout.map(({ row, column }) => [row, column]));
});
