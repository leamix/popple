// Deterministic, dependency-free synthesis of small, dry plastic ruptures.
// Different material envelopes matter much more than simply changing pitch.

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function randomFrom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let n = value;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export const POP_FAMILIES = Object.freeze(['snap', 'body', 'crinkle', 'tight', 'double']);
const weights = [3, 3, 2.2, 2, 0.65];

/** Reproducible selection, with no adjacent matching families or short loop. */
export class PopSequence {
  constructor(seed = Math.floor(Math.random() * 4294967296)) {
    this.random = randomFrom(seed);
    this.previous = -1;
  }

  next() {
    const total = weights.reduce((sum, weight, index) => sum + (index === this.previous ? 0 : weight), 0);
    let choice = this.random() * total;
    let index = 0;
    for (; index < weights.length - 1; index++) {
      if (index === this.previous) continue;
      choice -= weights[index];
      if (choice < 0) break;
    }
    this.previous = index;
    return { family: POP_FAMILIES[index], seed: Math.floor(this.random() * 4294967296) };
  }
}

const profiles = {
  snap: { duration: .068, spread: .010, decay: .0027, cutoff: 7800, highpass: 700, noise: 1.18, resonance: .20, frequency: 600, ring: .0028 },
  body: { duration: .078, spread: .012, decay: .0034, cutoff: 6200, highpass: 450, noise: 1.20, resonance: .36, frequency: 350, ring: .0045 },
  // Keep the public family ID, but use one slightly longer folded-film snap.
  // Delayed noise microcracks sounded like electrical static in headphones.
  crinkle: { duration: .078, spread: .013, decay: .0042, cutoff: 6900, highpass: 650, noise: 1.14, resonance: .26, frequency: 470, ring: .0040 },
  tight: { duration: .061, spread: .012, decay: .00165, cutoff: 7600, highpass: 1000, noise: 1.24, resonance: .18, frequency: 880, ring: .0021 },
  double: { duration: .109, spread: .012, decay: .0028, cutoff: 7500, highpass: 600, noise: 1.18, resonance: .25, frequency: 500, ring: .0033 },
};

/**
 * Returns mono float samples, without constructing an AudioContext.
 * An optional family preserves makeSnap(seed)'s deterministic testing API.
 */
export function synthesizePop(sampleRate, seed, family = POP_FAMILIES[(seed >>> 0) % POP_FAMILIES.length]) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8000 and 192000 Hz');
  }
  if (!Object.hasOwn(profiles, family)) throw new RangeError(`Unknown pop family: ${family}`);
  const profile = profiles[family];
  const random = randomFrom(seed);
  const vary = (base, amount = .2) => base * (1 + (random() * 2 - 1) * amount);
  const duration = profile.duration + random() * profile.spread;
  const samples = new Float32Array(Math.ceil(sampleRate * duration));
  const frequency = vary(profile.frequency, .24);
  const decay = vary(profile.decay, .22);
  const cutoff = vary(profile.cutoff, .18);

  function transient(start, level, options = {}) {
    const noiseDecay = options.decay ?? decay;
    const ringDecay = options.ring ?? vary(profile.ring, .16);
    const resonance = options.resonance ?? profile.resonance;
    const resonanceFrequency = options.frequency ?? frequency;
    const noiseLevel = options.noise ?? profile.noise;
    const highpass = options.highpass ?? profile.highpass;
    const lowpass = clamp(options.cutoff ?? cutoff, 500, sampleRate * .44);
    const lowCoefficient = 1 - Math.exp(-TAU * lowpass / sampleRate);
    const highCoefficient = 1 - Math.exp(-TAU * highpass / sampleRate);
    const attack = options.attack ?? vary(.00022, .4);
    const begin = Math.round(start * sampleRate);
    const end = Math.min(samples.length, begin + Math.ceil(Math.max(noiseDecay, ringDecay) * 8 * sampleRate));
    let low = 0;
    let smooth = 0;
    let bass = 0;
    for (let i = begin; i < end; i++) {
      const t = (i - begin) / sampleRate;
      low += lowCoefficient * ((random() * 2 - 1) - low);
      // Two low-pass stages keep a defined attack without the sand-like
      // near-white-noise edge of a single high-cutoff filter.
      smooth += lowCoefficient * (low - smooth);
      bass += highCoefficient * (smooth - bass);
      const rise = 1 - Math.exp(-t / attack);
      const noise = (smooth - bass) * noiseLevel * Math.exp(-t / noiseDecay);
      // Very short fixed resonances supply the body of trapped air. No pitch
      // sweep, reverb, or sustained tone that could read as a game laser.
      const body = (Math.sin(TAU * resonanceFrequency * t) +
        .19 * Math.sin(TAU * resonanceFrequency * 2.13 * t)) *
        resonance * Math.exp(-t / ringDecay);
      samples[i] += (noise + body) * rise * level;
    }
  }

  transient(0, 1);
  const doubleAt = family === 'double' ? .029 + random() * .018 : 0;
  if (doubleAt) {
    transient(doubleAt, .65 + random() * .24, {
      frequency: frequency * vary(1.2, .12),
      decay: decay * vary(.85, .15),
      cutoff: cutoff * vary(1.2, .15),
    });
  }

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    // A continuous tail gate guarantees silence in the final tenth, including
    // the occasional double rupture; it never truncates the leading snap.
    const position = i / (samples.length - 1);
    const tail = clamp((.90 - position) / .12, 0, 1);
    samples[i] *= tail * tail * (3 - 2 * tail);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  const gain = .96 / Math.max(peak, .001);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return { samples, family, sampleRate, duration: samples.length / sampleRate };
}
