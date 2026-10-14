// Product and interaction tuning lives here. Keep numerical literals that are
// intrinsic to an algorithm (vector dimensions, bit operations, GLSL/DSP
// equations and path coordinates) beside that algorithm instead.

const freeze = value => Object.freeze(value);

export const BRAND_CONFIG = freeze({
  canvasSize: 32,
  glyphScale: 0.86,
  maxDevicePixelRatio: 3,
});

export const BURST_CONFIG = freeze({
  randomSeedMultiplier: 9817,
  normal: freeze({ minSymbols: 6, symbolCountRange: 3, duration: 0.51 }),
  reduced: freeze({ minSymbols: 3, symbolCountRange: 3, duration: 0.18 }),
  glyph: freeze({
    size: 0.66,
    sizeRange: 0.32,
    aspect: 0.88,
    aspectRange: 0.24,
    reach: 0.65,
    reachRange: 0.65,
    offset: 5,
    offsetRange: 5,
    delayRange: 0.028,
    minimumRadius: 8,
    clipRadiusScale: 1.045,
    travelDistance: 30,
    baseDistance: 12,
    inwardRotation: Math.PI / 2,
  }),
  animation: freeze({
    radiusReference: 40,
    minimumScale: 0.65,
    maximumScale: 1.65,
    reducedOpacity: 0.7,
    opacityStart: 0.15,
    opacityRamp: 30,
    opacityFalloff: 0.85,
    reducedAppear: 0.6,
    appearBase: 0.78,
    appearPulse: 0.25,
  }),
  maximumConcurrentBursts: 20,
});

export const LAYOUT_CONFIG = freeze({
  rowCounts: freeze([3, 4, 3, 4]),
  maximumFilmScale: 1.085 * 1.05,
  filmGap: 4,
  stagePadding: 20,
  fallbackViewportWidth: 390,
  minimumStageWidth: 120,
  viewportInset: 12,
  defaultBubbleDiameter: 84,
});

export const SHEET_CONFIG = freeze({
  maximumShaderSites: 24,
  supportRadius: 3.065,
  neighbourRadius: 2.7,
  maximumOffset: 0.05,
  tileRadiusFactor: 4,
  popPulseSeconds: 0.28,
  strain: freeze({ compression: 0.8, bulge: 0.95 }),
  pull: freeze({ compression: 0.042, bulge: 0.035, pulse: 0.0115 }),
  coupling: freeze({ distanceGain: 4, strain: 0.23, pulseTension: 0.06 }),
  pulse: freeze({ frequency: 32, decay: 16, self: 0.11, neighbour: 0.055, maximum: 0.18 }),
});

export const PHYSICS_CONFIG = freeze({
  defaultHoldSeconds: 0.3,
  minimumHoldSeconds: 0.2,
  maximumHoldSeconds: 2,
  maximumFrameSeconds: 0.05,
  maximumHoldFrameSeconds: 0.1,
  settledCompression: 0.06,
  coordinateLimit: 1,
  defaultPressure: 0.5,
  pressure: freeze({ minimumEvidence: 0.02, maximumEvidence: 0.98, minimumVariation: 0.075, forceFloor: 0.35 }),
  initialContact: freeze({ intactCompression: 0.16, poppedCompression: 0.085, intactBulge: 0.035 }),
  activeCompression: freeze({ poppedBase: 0.12, poppedForce: 0.07, intactBase: 0.25, intactProgress: 0.53, intactForce: 0.05 }),
  resistance: freeze({ yieldEnd: 0.28, yieldCompression: 0.40, tensionEnd: 0.56, tensionCompression: 0.50, yieldVariation: 0.016, tensionVariation: 0.036, stiffnessVariation: 0.06 }),
  bulge: freeze({ base: 0.20, distance: 0.36, tensionGain: 0.16, maximum: 0.6 }),
  collapse: freeze({ decay: 16, frequency: 26 }),
  integrationFrequency: 180,
  spring: freeze({
    position: freeze({ poppedActiveStiffness: 390, poppedIdleStiffness: 165, intactActiveStiffness: 650, intactIdleStiffness: 205, poppedActiveDamping: 42, poppedIdleDamping: 29, intactActiveDamping: 36, intactIdleDamping: 21 }),
    compression: freeze({ poppedStiffness: 560, intactActiveStiffness: 430, intactIdleStiffness: 270, poppedDamping: 48, intactActiveDamping: 30, intactIdleDamping: 24 }),
    bulge: freeze({ stiffness: 330, damping: 28 }),
  }),
  settleEpsilon: 0.0001,
});

export const MEMBRANE_CONFIG = freeze({
  seedRange: 4294967295,
  contact: freeze({ edgeThreshold: 0.92, maximumRadius: 0.72, biasRadius: 0.6 }),
  air: freeze({ base: 0.15, range: 0.12 }),
  jitter: freeze({ base: 0.34, biasScale: 0.20 }),
  dent: freeze({ contactScale: 0.62, positionJitter: 0.5, sizeBase: 0.18, sizeRange: 0.13, secondaryBase: 0.14, secondaryRange: 0.13 }),
  pocket: freeze({ count: 3, radiusBase: 0.25, radiusRange: 0.39, primaryBias: 0.85, secondaryBias: 0.30, primaryContactScale: 0.56, secondaryContactScale: 0.22, sizeBase: 0.10, sizeRange: 0.18, primaryBiasScale: 0.055, secondarySizeBase: 0.08, secondarySizeRange: 0.12 }),
  folds: freeze({ maximumCount: 5, countBase: 3, countRange: 3, offsetRange: 1.14, widthBase: 0.022, widthRange: 0.030, amplitudeBase: 0.038, amplitudeRange: 0.052, curvatureRange: 0.45, endBase: 0.15, endRange: 0.63, anchorRange: 0.32, primaryContactCount: 2, primaryBlend: 0.86, secondaryBlend: 0.15 }),
});

export const APP_CONFIG = freeze({
  burstPadding: 80,
  wakeSeconds: 0.9,
  popWakeSeconds: 1.1,
  themeWakeSeconds: 0.4,
  tiltWakeSeconds: 0.7,
  pointerLightWakeSeconds: 0.55,
  maximumDevicePixelRatio: 2.5,
  desktopFieldPadding: 24,
  mobileBreakpoint: 540,
  pointerLightShift: 0.055,
  hapticPressMilliseconds: 5,
  hapticPopMilliseconds: 12,
  assistivePoppedDurationSeconds: 0.24,
  assistiveHoldGraceSeconds: 0.2,
});

export const LIGHTING_CONFIG = freeze({
  dataTimeoutMilliseconds: 5000,
  maximumLightShift: 0.17,
  maximumReflectionAngle: 0.95,
});

export const POP_SOUND_CONFIG = freeze({
  families: freeze(['snap', 'body', 'crinkle', 'tight', 'double']),
  familyWeights: freeze([3, 3, 2.2, 2, 0.65]),
  minimumSampleRate: 8000,
  maximumSampleRate: 192000,
  profiles: freeze({
    snap: freeze({ duration: 0.068, spread: 0.010, decay: 0.0027, cutoff: 7800, highpass: 700, noise: 1.18, resonance: 0.20, frequency: 600, ring: 0.0028 }),
    body: freeze({ duration: 0.078, spread: 0.012, decay: 0.0034, cutoff: 6200, highpass: 450, noise: 1.20, resonance: 0.36, frequency: 350, ring: 0.0045 }),
    crinkle: freeze({ duration: 0.078, spread: 0.013, decay: 0.0042, cutoff: 6900, highpass: 650, noise: 1.14, resonance: 0.26, frequency: 470, ring: 0.0040 }),
    tight: freeze({ duration: 0.061, spread: 0.012, decay: 0.00165, cutoff: 7600, highpass: 1000, noise: 1.24, resonance: 0.18, frequency: 880, ring: 0.0021 }),
    double: freeze({ duration: 0.109, spread: 0.012, decay: 0.0028, cutoff: 7500, highpass: 600, noise: 1.18, resonance: 0.25, frequency: 500, ring: 0.0033 }),
  }),
});
