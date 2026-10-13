import { LAYOUT_CONFIG } from './config.js';

export const ROW_COUNTS = LAYOUT_CONFIG.rowCounts;
export const BUBBLE_COUNT = ROW_COUNTS.reduce((sum, count) => sum + count, 0);

// The welded rim extends beyond the hit target. Reserve space for that rim
// and the widest pressed shape, including two adjacent pockets being pressed.
export const MAX_FILM_SCALE = LAYOUT_CONFIG.maximumFilmScale;
export const FILM_GAP = LAYOUT_CONFIG.filmGap;
export const STAGE_PADDING = LAYOUT_CONFIG.stagePadding;

/** A centred hexagonal packing; all returned measurements are CSS pixels. */
export function createBubbleLayout(viewportWidth, requestedDiameter = LAYOUT_CONFIG.defaultBubbleDiameter) {
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : LAYOUT_CONFIG.fallbackViewportWidth;
  const desiredDiameter = Number.isFinite(requestedDiameter) && requestedDiameter > 0
    ? requestedDiameter : LAYOUT_CONFIG.defaultBubbleDiameter;
  const columns = Math.max(...ROW_COUNTS);
  const preferredWidth = STAGE_PADDING * 2 + columns * desiredDiameter * MAX_FILM_SCALE + (columns - 1) * FILM_GAP;
  const width = Math.min(preferredWidth, Math.max(LAYOUT_CONFIG.minimumStageWidth, viewport - LAYOUT_CONFIG.viewportInset));
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
