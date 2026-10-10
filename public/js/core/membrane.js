// A visual approximation of vented, molded film, not a fracture simulation.
// The contact dent is near the finger; a freer lobe survives on the other side.
// Folds connect different slack regions, rather than one mirrored star centre.
export function makeMembrane(seed, popX = 0, popY = 0) {
  let n = Math.floor(seed * 4294967295) >>> 0;
  const random = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
  const contactLength = Math.hypot(popX, popY);
  const contactScale = contactLength > .92 ? .92 / contactLength : 1;
  const x = popX * contactScale, y = popY * contactScale;
  const bias = Math.min(1, contactLength / .6);
  const bound = (px, py, radius = .72) => {
    const scale = Math.min(1, radius / (Math.hypot(px, py) || 1));
    return [px * scale, py * scale];
  };
  const air = .15 + random() * .12;
  const jitter = .34 - bias * .20;
  const dent = new Float32Array([
    x * .62 + (random() - .5) * jitter,
    y * .62 + (random() - .5) * jitter,
    .18 + random() * .13, .14 + random() * .13,
  ]);
  const pockets = new Float32Array(12), folds = new Float32Array(20), profiles = new Float32Array(20);
  for (let i = 0; i < 3; i++) {
    const angle = random() * Math.PI * 2, radius = .25 + random() * .39;
    const influence = i === 0 ? bias * .85 : bias * .30;
    const [px, py] = bound(
      Math.cos(angle) * radius * (1 - influence) - x * (i === 0 ? .56 : .22),
      Math.sin(angle) * radius * (1 - influence) - y * (i === 0 ? .56 : .22),
    );
    pockets.set([px, py, .10 + random() * .18 + (i === 0 ? bias * .055 : 0), .08 + random() * .12], i * 4);
  }
  const count = 3 + Math.floor(random() * 3);
  for (let i = 0; i < 5; i++) {
    const angle = random() * Math.PI * 2, ax = Math.cos(angle), ay = Math.sin(angle);
    const offset = (random() - .5) * 1.14, width = .022 + random() * .030;
    const amplitude = i < count ? .038 + random() * .052 : 0;
    const curvature = (random() - .5) * .45, end = .15 + random() * .63;
    // Two contact-related folds meet different points near the depression;
    // the remaining independent folds preserve the film's own irregularity.
    const anchorX = dent[0] + (random() - .5) * .32;
    const anchorY = dent[1] + (random() - .5) * .32;
    const along = anchorX * ax + anchorY * ay;
    const contactOffset = -anchorX * ay + anchorY * ax - curvature * along * along;
    const blend = i < 2 ? bias * .86 : bias * .15;
    folds.set([ax, ay, offset * (1 - blend) + contactOffset * blend, width], i * 4);
    profiles.set([amplitude, curvature, end, 0], i * 4);
  }
  return { seed, popX, popY, air, dent, pockets, folds, profiles };
}
