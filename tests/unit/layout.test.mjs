import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILM_SCALE, FILM_GAP, STAGE_PADDING, createBubbleLayout } from '../../public/js/core/layout.js';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

const bounds = ({ layout, visualRadius }) => ({
  left: Math.min(...layout.map(pocket => pocket.x - visualRadius)),
  right: Math.max(...layout.map(pocket => pocket.x + visualRadius)),
  top: Math.min(...layout.map(pocket => pocket.y - visualRadius)),
  bottom: Math.max(...layout.map(pocket => pocket.y + visualRadius)),
});

test('compact screens retain four-column density and add pockets beyond the original fourteen', () => {
  for (const [width, height] of [[320, 520], [390, 600]]) {
    const result = createBubbleLayout(width, 84, height);
    assert.ok(result.layout.length > 14, `${width}px screens should gain pockets`);
    assert.equal(result.layout.filter(pocket => pocket.row === 0).length, 3);
    assert.equal(result.layout.filter(pocket => pocket.row === 1).length, 4);
    assert.ok(result.diameter >= 44 && result.diameter < 84);
  }
});

test('fractional compact widths retain the complete fourth column without clipped rims', () => {
  for (const width of [281.9, 282.4, 282.8, 286.7]) {
    for (const requestedDiameter of [64, 84, 100]) {
      const result = createBubbleLayout(width, requestedDiameter, 680);
      assert.equal(result.layout.filter(pocket => pocket.row === 1).length, 4);
      const { left, right } = bounds(result);
      assert.ok(left >= STAGE_PADDING - 1e-8);
      assert.ok(right <= width - STAGE_PADDING + 1e-8);
    }
  }
});

// Wrong capacity calculations would leave complete rows or columns unused.
test('desktop, mobile and landscape pack the complete available rectangle', () => {
  for (const [width, height, count] of [[1440, 800, 108], [390, 600, 24], [844, 260, 15]]) {
    const result = createBubbleLayout(width, 84, height);
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.ok(result.diameter <= 84);
    if (width > 640) close(result.diameter, 84);
    assert.equal(result.layout.length, count, `${width}×${height} should use every complete row and column`);
  }
});

test('larger regions and smaller requested bubbles produce more pockets', () => {
  const base = createBubbleLayout(640, 84, 480);
  const larger = createBubbleLayout(960, 84, 720);
  const smaller = createBubbleLayout(640, 64, 480);
  assert.ok(larger.layout.length > base.layout.length);
  assert.ok(smaller.layout.length > base.layout.length);
  close(base.diameter, 84);
  close(larger.diameter, 84);
  close(smaller.diameter, 64);
});

test('rows alternate short then long with centred, evenly spaced hexagonal packing', () => {
  const result = createBubbleLayout(640, 84, 480);
  const { layout, width, pitch, rowPitch } = result;
  const rows = [...Map.groupBy(layout, pocket => pocket.row).values()];
  assert.deepEqual(rows.map(row => row.length), [5, 6, 5, 6]);
  rows.forEach((pockets, row) => {
    close(pockets.reduce((sum, pocket) => sum + pocket.x, 0) / pockets.length, width / 2);
    assert.deepEqual(pockets.map(pocket => pocket.column), Array.from({ length: pockets.length }, (_, column) => column));
    assert.ok(pockets.every(pocket => pocket.row === row));
    for (let column = 1; column < pockets.length; column++) close(pockets[column].x - pockets[column - 1].x, pitch);
    if (row > 0) close(pockets[0].y - rows[row - 1][0].y, rowPitch);
  });
  close(rows[0][0].x - rows[1][0].x, pitch / 2);
  close(rows[2][0].x - rows[3][0].x, pitch / 2);
  close(rowPitch / pitch, Math.sqrt(3) / 2);
});

test('every rim stays padded and every pair keeps the film gap', () => {
  for (const [width, height] of [[320, 520], [390, 600], [844, 260], [1440, 800], [120, 480]]) {
    for (const requestedDiameter of [64, 84, 100]) {
      const result = createBubbleLayout(width, requestedDiameter, height);
      assert.ok(result.diameter <= requestedDiameter);
      for (const pocket of result.layout) {
        const reach = pocket.radius * MAX_FILM_SCALE;
        assert.ok(pocket.x - reach >= STAGE_PADDING - 1e-8);
        assert.ok(pocket.x + reach <= width - STAGE_PADDING + 1e-8);
        assert.ok(pocket.y - reach >= STAGE_PADDING - 1e-8);
        assert.ok(pocket.y + reach <= height - STAGE_PADDING + 1e-8);
      }
      for (let a = 0; a < result.layout.length; a++) {
        for (let b = a + 1; b < result.layout.length; b++) {
          const left = result.layout[a], right = result.layout[b];
          const separation = Math.hypot(left.x - right.x, left.y - right.y);
          const combinedRadii = (left.radius + right.radius) * MAX_FILM_SCALE;
          assert.ok(separation >= combinedRadii + FILM_GAP - 1e-8,
            `${width}×${height}: pockets ${a}/${b} must keep their ${FILM_GAP}px gap`);
        }
      }
    }
  }
});

test('packing centres its unused space and cannot fit another complete row or column', () => {
  for (const [width, height] of [[320, 520], [390, 600], [844, 260], [1440, 800], [120, 480]]) {
    const result = createBubbleLayout(width, 84, height);
    const { left, right, top, bottom } = bounds(result);
    close(left, width - right);
    close(top, height - bottom);
    assert.ok(left + width - right - STAGE_PADDING * 2 < result.pitch + 1e-8);
    assert.ok(top + height - bottom - STAGE_PADDING * 2 < result.rowPitch + 1e-8);
  }
});

test('one-row regions use all columns and one-column regions keep vertical film gaps', () => {
  const singleRow = createBubbleLayout(640, 84, 140);
  assert.equal(singleRow.layout.length, 6);
  assert.ok(singleRow.layout.every(pocket => pocket.row === 0));
  const singleColumn = createBubbleLayout(140, 84, 480);
  assert.equal(singleColumn.layout.length, 4);
  assert.ok(singleColumn.layout.every(pocket => pocket.column === 0));
  close(singleColumn.layout[1].y - singleColumn.layout[0].y, singleColumn.pitch);
});

test('row and column identities stay unique and reusable after dimensions change', () => {
  const wide = createBubbleLayout(960, 84, 720);
  const narrow = createBubbleLayout(390, 84, 600);
  const identity = ({ row, column }) => `${row}:${column}`;
  const wideKeys = new Set(wide.layout.map(identity));
  const narrowKeys = new Set(narrow.layout.map(identity));
  assert.equal(wideKeys.size, wide.layout.length);
  assert.equal(narrowKeys.size, narrow.layout.length);
  assert.ok([...narrowKeys].every(key => wideKeys.has(key)));
  assert.ok(narrow.layout[0].x !== wide.layout[0].x);
  assert.ok(narrow.diameter < wide.diameter);
});

test('narrow regions keep useful targets and short regions cap their diameter', () => {
  close(createBubbleLayout(140, 84, 140).diameter, 84);
  for (const width of [140, 200, 240, 320]) {
    assert.ok(createBubbleLayout(width, 84, 480).diameter >= 44);
  }
  for (const [width, height] of [[120, 480], [640, 100]]) {
    const result = createBubbleLayout(width, 84, height);
    assert.ok(result.diameter > 0 && result.diameter < 84);
    const { left, right, top, bottom } = bounds(result);
    assert.ok(left >= STAGE_PADDING - 1e-8 && right <= width - STAGE_PADDING + 1e-8);
    assert.ok(top >= STAGE_PADDING - 1e-8 && bottom <= height - STAGE_PADDING + 1e-8);
  }
});

test('tiny positive regions retain a positive bubble entirely inside the region', () => {
  for (const [width, height] of [[1, 1], [20, 30], [40, 40]]) {
    const result = createBubbleLayout(width, 84, height);
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.ok(result.layout.length >= 1);
    assert.ok(Number.isFinite(result.diameter) && result.diameter > 0);
    const { left, right, top, bottom } = bounds(result);
    assert.ok(left >= 0 && top >= 0 && right <= width && bottom <= height);
  }
});

test('missing and invalid dimensions and diameters use finite defaults', () => {
  const fallback = createBubbleLayout();
  assert.equal(fallback.width, 390);
  assert.equal(fallback.height, 680);
  assert.ok(fallback.diameter > 74 && fallback.diameter < 75);
  assert.equal(fallback.layout.length, 28);
  for (const invalid of [0, -1, NaN, Infinity, -Infinity, null, '390']) {
    assert.deepEqual(createBubbleLayout(invalid, invalid, invalid), fallback);
  }
});
