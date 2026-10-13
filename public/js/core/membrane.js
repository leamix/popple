import { MEMBRANE_CONFIG } from './config.js';

// A visual approximation of vented, molded film, not a fracture simulation.
// The contact dent is near the finger; a freer lobe survives on the other side.
// Folds connect different slack regions, rather than one mirrored star centre.
export function makeMembrane(seed, popX = 0, popY = 0) {
  let n = Math.floor(seed * MEMBRANE_CONFIG.seedRange) >>> 0;
  const random = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
  const contactLength = Math.hypot(popX, popY);
  const contactScale = contactLength > MEMBRANE_CONFIG.contact.edgeThreshold
    ? MEMBRANE_CONFIG.contact.edgeThreshold / contactLength : 1;
  const x = popX * contactScale, y = popY * contactScale;
  const bias = Math.min(1, contactLength / MEMBRANE_CONFIG.contact.biasRadius);
  const bound = (px, py, radius = MEMBRANE_CONFIG.contact.maximumRadius) => {
    const scale = Math.min(1, radius / (Math.hypot(px, py) || 1));
    return [px * scale, py * scale];
  };
  const air = MEMBRANE_CONFIG.air.base + random() * MEMBRANE_CONFIG.air.range;
  const jitter = MEMBRANE_CONFIG.jitter.base - bias * MEMBRANE_CONFIG.jitter.biasScale;
  const dent = new Float32Array([
    x * MEMBRANE_CONFIG.dent.contactScale + (random() - .5) * jitter,
    y * MEMBRANE_CONFIG.dent.contactScale + (random() - .5) * jitter,
    MEMBRANE_CONFIG.dent.sizeBase + random() * MEMBRANE_CONFIG.dent.sizeRange,
    MEMBRANE_CONFIG.dent.secondaryBase + random() * MEMBRANE_CONFIG.dent.secondaryRange,
  ]);
  const pockets = new Float32Array(12), folds = new Float32Array(20), profiles = new Float32Array(20);
  for (let i = 0; i < MEMBRANE_CONFIG.pocket.count; i++) {
    const angle = random() * Math.PI * 2, radius = MEMBRANE_CONFIG.pocket.radiusBase
      + random() * MEMBRANE_CONFIG.pocket.radiusRange;
    const influence = i === 0 ? bias * MEMBRANE_CONFIG.pocket.primaryBias : bias * MEMBRANE_CONFIG.pocket.secondaryBias;
    const [px, py] = bound(
      Math.cos(angle) * radius * (1 - influence) - x * (i === 0
        ? MEMBRANE_CONFIG.pocket.primaryContactScale : MEMBRANE_CONFIG.pocket.secondaryContactScale),
      Math.sin(angle) * radius * (1 - influence) - y * (i === 0
        ? MEMBRANE_CONFIG.pocket.primaryContactScale : MEMBRANE_CONFIG.pocket.secondaryContactScale),
    );
    pockets.set([px, py, MEMBRANE_CONFIG.pocket.sizeBase + random() * MEMBRANE_CONFIG.pocket.sizeRange
      + (i === 0 ? bias * MEMBRANE_CONFIG.pocket.primaryBiasScale : 0),
    MEMBRANE_CONFIG.pocket.secondarySizeBase + random() * MEMBRANE_CONFIG.pocket.secondarySizeRange], i * 4);
  }
  const count = MEMBRANE_CONFIG.folds.countBase + Math.floor(random() * MEMBRANE_CONFIG.folds.countRange);
  for (let i = 0; i < MEMBRANE_CONFIG.folds.maximumCount; i++) {
    const angle = random() * Math.PI * 2, ax = Math.cos(angle), ay = Math.sin(angle);
    const offset = (random() - .5) * MEMBRANE_CONFIG.folds.offsetRange,
      width = MEMBRANE_CONFIG.folds.widthBase + random() * MEMBRANE_CONFIG.folds.widthRange;
    const amplitude = i < count ? MEMBRANE_CONFIG.folds.amplitudeBase
      + random() * MEMBRANE_CONFIG.folds.amplitudeRange : 0;
    const curvature = (random() - .5) * MEMBRANE_CONFIG.folds.curvatureRange,
      end = MEMBRANE_CONFIG.folds.endBase + random() * MEMBRANE_CONFIG.folds.endRange;
    // Two contact-related folds meet different points near the depression;
    // the remaining independent folds preserve the film's own irregularity.
    const anchorX = dent[0] + (random() - .5) * MEMBRANE_CONFIG.folds.anchorRange;
    const anchorY = dent[1] + (random() - .5) * MEMBRANE_CONFIG.folds.anchorRange;
    const along = anchorX * ax + anchorY * ay;
    const contactOffset = -anchorX * ay + anchorY * ax - curvature * along * along;
    const blend = i < MEMBRANE_CONFIG.folds.primaryContactCount
      ? bias * MEMBRANE_CONFIG.folds.primaryBlend : bias * MEMBRANE_CONFIG.folds.secondaryBlend;
    folds.set([ax, ay, offset * (1 - blend) + contactOffset * blend, width], i * 4);
    profiles.set([amplitude, curvature, end, 0], i * 4);
  }
  return { seed, popX, popY, air, dent, pockets, folds, profiles };
}
