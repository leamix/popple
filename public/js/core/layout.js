import { LAYOUT_CONFIG } from './config.js';

// The welded rim extends beyond the hit target. Reserve space for that rim
// and the widest pressed shape, including two adjacent pockets being pressed.
export const MAX_FILM_SCALE = LAYOUT_CONFIG.maximumFilmScale;
export const FILM_GAP = LAYOUT_CONFIG.filmGap;
export const COMPACT_SIDE_GAP = LAYOUT_CONFIG.compactSideGap;

// Fractional CSS widths can put an exact capacity just below its integer.
const completeFits = ratio => Math.floor(ratio + Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8);

/** Fill the field from its top with horizontally centred rows in CSS pixels. */
export function createBubbleLayout(
  viewportWidth,
  requestedDiameter = LAYOUT_CONFIG.defaultBubbleDiameter,
  availableHeight = LAYOUT_CONFIG.fallbackViewportHeight,
) {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth : LAYOUT_CONFIG.fallbackViewportWidth;
  const height = Number.isFinite(availableHeight) && availableHeight > 0
    ? availableHeight : LAYOUT_CONFIG.fallbackViewportHeight;
  const desiredDiameter = Number.isFinite(requestedDiameter) && requestedDiameter > 0
    ? requestedDiameter : LAYOUT_CONFIG.defaultBubbleDiameter;
  // The page owns the title gap. Only compact screens need a little room
  // beside their welded rims; do not add another inset above the first row.
  const sideGap = width <= LAYOUT_CONFIG.compactViewportWidth
    ? Math.min(COMPACT_SIDE_GAP, width / 4) : 0;
  const innerWidth = width - sideGap * 2;
  // Retain the familiar compact density without forcing tiny hit targets when
  // fewer than four useful pockets can fit across a genuinely narrow region.
  const compactPitch = LAYOUT_CONFIG.minimumCompactDiameter * MAX_FILM_SCALE + FILM_GAP;
  const compactColumns = Math.max(1, Math.min(LAYOUT_CONFIG.compactColumns,
    completeFits((innerWidth + FILM_GAP) / compactPitch)));
  const compactDiameter = (innerWidth - (compactColumns - 1) * FILM_GAP)
    / (compactColumns * MAX_FILM_SCALE);
  const diameter = Math.min(desiredDiameter, compactDiameter, height / MAX_FILM_SCALE);
  const radius = diameter / 2;
  const visualRadius = radius * MAX_FILM_SCALE;
  const pitch = diameter * MAX_FILM_SCALE + FILM_GAP;
  const columns = Math.max(1, completeFits((innerWidth + FILM_GAP) / pitch));
  // A single column has no diagonal offset, so it needs the full separation.
  const rowPitch = columns === 1 ? pitch : pitch * Math.sqrt(3) / 2;
  const rows = Math.max(1, completeFits((height - visualRadius * 2) / rowPitch) + 1);
  const startY = visualRadius;
  const layout = Array.from({ length: rows }, (_, row) => {
    // One row can use every column without needing a staggered neighbour.
    const count = rows === 1 || columns === 1 || row % 2 === 1 ? columns : columns - 1;
    const startX = width / 2 - (count - 1) * pitch / 2;
    return Array.from({ length: count }, (_, column) => ({
      x: startX + column * pitch,
      y: startY + row * rowPitch,
      radius,
      row,
      column,
    }));
  }).flat();
  return { width, height, diameter, pitch, rowPitch, visualRadius, layout };
}
