export const ROW_COUNTS = Object.freeze([3, 4, 3, 4]);
export const BUBBLE_COUNT = ROW_COUNTS.reduce((sum, count) => sum + count, 0);

// The welded rim extends beyond the hit target. Reserve space for that rim
// and the widest pressed shape, including two adjacent pockets being pressed.
export const MAX_FILM_SCALE = 1.085 * 1.05;
export const FILM_GAP = 4;
export const STAGE_PADDING = 20;

/** A centred hexagonal packing; all returned measurements are CSS pixels. */
export function createBubbleLayout(viewportWidth, requestedDiameter = 84) {
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 390;
  const desiredDiameter = Number.isFinite(requestedDiameter) && requestedDiameter > 0 ? requestedDiameter : 84;
  const columns = Math.max(...ROW_COUNTS);
  const preferredWidth = STAGE_PADDING * 2 + columns * desiredDiameter * MAX_FILM_SCALE + (columns - 1) * FILM_GAP;
  const width = Math.min(preferredWidth, Math.max(120, viewport - 12));
  const diameter = Math.min(desiredDiameter,
    (width - STAGE_PADDING * 2 - (columns - 1) * FILM_GAP) / (columns * MAX_FILM_SCALE));
  const radius = diameter / 2;
  const visualRadius = radius * MAX_FILM_SCALE;
  const pitch = diameter * MAX_FILM_SCALE + FILM_GAP;
  const rowPitch = pitch * Math.sqrt(3) / 2;
  const height = STAGE_PADDING * 2 + visualRadius * 2 + (ROW_COUNTS.length - 1) * rowPitch;
  const layout = ROW_COUNTS.flatMap((count, row) => {
    const startX = width / 2 - (count - 1) * pitch / 2;
    return Array.from({ length: count }, (_, column) => ({
      x: startX + column * pitch,
      y: STAGE_PADDING + visualRadius + row * rowPitch,
      radius,
      row,
      column,
    }));
  });
  return { width, height, diameter, pitch, rowPitch, visualRadius, layout };
}
