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
  snap: { duration: .071, spread: .012, decay: .0029, cutoff: 11600, highpass: 950, noise: 1.3, resonance: .22, frequency: 410, ring: .0045, cracks: [1, 3], crackEnd: .023 },
  body: { duration: .101, spread: .013, decay: .0060, cutoff: 4200, highpass: 110, noise: .60, resonance: .93, frequency: 165, ring: .013, cracks: [2, 4], crackEnd: .037 },
  crinkle: { duration: .133, spread: .010, decay: .0035, cutoff: 8600, highpass: 620, noise: .92, resonance: .32, frequency: 280, ring: .006, cracks: [9, 15], crackEnd: .091 },
  tight: { duration: .084, spread: .012, decay: .0016, cutoff: 15400, highpass: 2900, noise: 1.4, resonance: .15, frequency: 720, ring: .0025, cracks: [2, 4], crackEnd: .026 },
  double: { duration: .133, spread: .010, decay: .0038, cutoff: 7300, highpass: 470, noise: .92, resonance: .45, frequency: 245, ring: .007, cracks: [3, 5], crackEnd: .076 },
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
    let bass = 0;
    for (let i = begin; i < end; i++) {
      const t = (i - begin) / sampleRate;
      low += lowCoefficient * ((random() * 2 - 1) - low);
      bass += highCoefficient * (low - bass);
      const rise = 1 - Math.exp(-t / attack);
      const noise = (low - bass) * noiseLevel * Math.exp(-t / noiseDecay);
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

  const crackCount = profile.cracks[0] + Math.floor(random() * (profile.cracks[1] - profile.cracks[0] + 1));
  for (let i = 0; i < crackCount; i++) {
    const spacing = (i + .45 + random() * .8) / (crackCount + 1);
    const start = .006 + spacing * profile.crackEnd;
    const level = family === 'crinkle' ? .16 + random() * .23 : .07 + random() * .12;
    transient(start, level, {
      decay: vary(family === 'crinkle' ? .0019 : .00115, .45),
      ring: .0015,
      resonance: .05,
      noise: 1,
      cutoff: vary(family === 'body' ? 6100 : 11500, .22),
      highpass: 1300,
      attack: .00009 + random() * .00009,
    });
  }

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    // A continuous tail gate guarantees silence in the final tenth, including
    // the longer crinkly examples; it never truncates the leading snap.
    const position = i / (samples.length - 1);
    const tail = clamp((.90 - position) / .12, 0, 1);
    samples[i] *= tail * tail * (3 - 2 * tail);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  const gain = .96 / Math.max(peak, .001);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return { samples, family, sampleRate, duration: samples.length / sampleRate };
}
