// Taut film keeps its established soft creak alone. Collapsed film has a
// separate, longer flowing plastic rustle without pitched stick-slip modes.
const TAU = Math.PI * 2;
const smoothstep = x => x * x * (3 - 2 * x);
const coefficient = (frequency, rate) => 1 - Math.exp(-TAU * Math.min(frequency, rate * .38) / rate);

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

function rms(samples) {
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] ** 2;
  return Math.sqrt(energy / samples.length);
}

function matchRms(samples, target) {
  const gain = target / Math.max(rms(samples), 1e-9);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
}

/**
 * Mono loop, no AudioContext or side effects. External motion gain: 0–0.30.
 * includeLayers is an optional offline diagnostic; playback needs only samples.
 * entryPoints are safe creak start times for gesture-synchronised playback.
 */
export function synthesizeFriction(sampleRate, seed, material = 'intact', { includeLayers = false } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8000 and 192000 Hz');
  }
  if (material !== 'intact' && material !== 'popped') throw new RangeError(`Unknown friction material: ${material}`);
  const popped = material === 'popped';
  const random = randomFrom((seed >>> 0) ^ (popped ? 0x5A28C179 : 0));
  const length = Math.round(sampleRate * (3.8 + random() * .6));
  const duration = length / sampleRate;
  const bed = new Float32Array(length);
  const folds = new Float32Array(length);
  const squeak = new Float32Array(length);
  const colour = .88 + random() * .24;

  // On intact film these legacy bed/fold calculations intentionally still run:
  // their random-number consumption fixes the existing creak's exact waveform.
  // Their output is silenced below, after the unchanged creak is generated.
  const overlap = Math.round(sampleRate * .035);
  const bedWork = new Float32Array(length + overlap);
  const bedLow = coefficient((popped ? 3300 : 4500) * colour, sampleRate);
  const bedHigh = coefficient(popped ? 700 : 1300, sampleRate);
  let low = 0, bass = 0;
  for (let i = -Math.round(sampleRate * .01); i < bedWork.length; i++) {
    low += bedLow * ((random() * 2 - 1) - low);
    bass += bedHigh * (low - bass);
    if (i >= 0) bedWork[i] = low - bass;
  }
  bed.set(bedWork.subarray(0, length));
  for (let i = 0; i < overlap; i++) {
    const w = smoothstep(i / (overlap - 1));
    bed[i] = (bed[i] * w + bedWork[length + i] * (1 - w)) / Math.sqrt(w * w + (1 - w) ** 2);
  }

  // A fold now slides as one long, softly uneven episode. Its fine plastic
  // detail remains bright, but the amplitude no longer breaks into dozens of
  // tiny cracks. Slow irregular colour changes avoid both a flat hiss and a
  // regularly fluttering texture.
  const foldEvents = [];
  let foldAt = random() * .050;
  while (foldAt < duration && !popped) {
    const n = Math.round(sampleRate * (.130 + random() * (popped ? .170 : .140)));
    const start = Math.round(foldAt * sampleRate);
    const cutoff = coefficient((popped ? 4700 : 4300) * colour * (.85 + random() * .30), sampleRate);
    const detailCutoff = coefficient(6500 * colour, sampleRate);
    const highpass = coefficient(750 + random() * 500, sampleRate);
    const level = .75 + random() * .40;
    const driftCoefficient = coefficient(7, sampleRate);
    let a = 0, b = 0, h = 0, detail = 0;
    let drift = .7, target = .7, nextTarget = 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      if (i >= nextTarget) {
        target = .45 + random() * .55;
        nextTarget = i + Math.round(sampleRate * (.040 + random() * .060));
      }
      drift += driftCoefficient * (target - drift);
      const envelope = smoothstep(Math.min(1, x / .22)) * smoothstep(Math.min(1, (1 - x) / .40));
      const noise = random() * 2 - 1;
      a += cutoff * (noise - a);
      b += cutoff * (a - b);
      h += highpass * (b - h);
      detail += detailCutoff * (noise - detail);
      const plastic = (b - h) + (detail - a) * (popped ? .25 : .16) * drift;
      folds[(start + i) % length] += plastic * envelope * level * (.6 + drift * .4);
    }
    foldEvents.push({ start: start / sampleRate, duration: n / sampleRate });
    foldAt += .190 + random() * .140;
  }

  if (popped) {
    // Flattened film slides through broad, overlapping folds. Low-Q bands
    // colour noise rather than ring at a pitch; a little lower body and a
    // softer upper edge replace the former dry, finely separated creases.
    while (foldAt < duration) {
      const n = Math.round(sampleRate * (.450 + random() * .350));
      const start = Math.round(foldAt * sampleRate);
      const level = .75 + random() * .35;
      const bodyFrequency = (490 + random() * 240) * colour;
      const sheenFrequency = (1650 + random() * 600) * colour;
      const highpass = coefficient(260 + random() * 120, sampleRate);
      const driftCoefficient = coefficient(3.5, sampleRate);
      let drift = .65, target = .65, nextTarget = 0;
      let a = 0, b = 0, h = 0, cutoff = 0;
      let e1 = 0, e2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
      let a0 = 0, a1 = 0, a2 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        if (i >= nextTarget) {
          target = .35 + random() * .65;
          nextTarget = i + Math.round(sampleRate * (.080 + random() * .110));
        }
        drift += driftCoefficient * (target - drift);
        if (i % 64 === 0) {
          cutoff = coefficient((2800 + drift * 1300) * colour, sampleRate);
          const omega = TAU * Math.min(bodyFrequency * (.9 + drift * .2), sampleRate * .30) / sampleRate;
          const alpha = Math.sin(omega) / (2 * .72);
          a0 = alpha / (1 + alpha);
          a1 = 2 * Math.cos(omega) / (1 + alpha);
          a2 = (1 - alpha) / (1 + alpha);
          const omega2 = TAU * Math.min(sheenFrequency * (.92 + drift * .16), sampleRate * .35) / sampleRate;
          const alpha2 = Math.sin(omega2) / (2 * .88);
          b0 = alpha2 / (1 + alpha2);
          b1 = 2 * Math.cos(omega2) / (1 + alpha2);
          b2 = (1 - alpha2) / (1 + alpha2);
        }
        const noise = random() * 2 - 1;
        a += cutoff * (noise - a);
        b += cutoff * (a - b);
        h += highpass * (b - h);
        const body = a0 * (a - e2) + a1 * y1 - a2 * y2;
        const sheen = b0 * (a - e2) + b1 * z1 - b2 * z2;
        e2 = e1; e1 = a;
        y2 = y1; y1 = body;
        z2 = z1; z1 = sheen;
        const envelope = smoothstep(Math.min(1, x / .25)) * smoothstep(Math.min(1, (1 - x) / .38));
        // A small broad upper skirt keeps light film detail without bringing
        // back isolated dry ticks or turning the smoother folds into cloth.
        const plastic = (b - h) * .82 + body * .35 + sheen * .18 + (a - b) * .12;
        folds[(start + i) % length] += plastic * envelope * level * (.65 + drift * .35);
      }
      foldEvents.push({ start: start / sampleRate, duration: n / sampleRate });
      foldAt += .300 + random() * .170;
    }
  }

  const squeakEvents = [];
  if (!popped) {
    // A restrained tonal trace stays inside a longer friction movement. Fewer
    // episodes, a softer exciter and gently wandering pitch avoid the former
    // rapid sequence of tiny chirps. There is no programmed rising/falling
    // sweep that would stretch into an electronic whistle.
    const materialFrequency = (740 + random() * 220) * colour;
    let at = random() * .070;
    while (at < duration) {
      const n = Math.round(sampleRate * (.220 + random() * .160));
      const start = Math.round(at * sampleRate);
      const event = new Float32Array(n);
      const frequency = materialFrequency * (.94 + random() * .12);
      const q = 8.5 + random() * 3;
      const pulseRate = 170 + random() * 90;
      const pulseWidth = .12 + random() * .08;
      const ratio = 1.94 + random() * .16;
      let phase = random(), pulseLevel = .8, flutter = .8;
      let cycleSpeed = 1, wander = 0, wanderTarget = 0, nextWander = 0;
      const wanderCoefficient = coefficient(5, sampleRate);
      const flutterCoefficient = coefficient(9, sampleRate);
      let e1 = 0, e2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
      let a0 = 0, a1 = 0, a2 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        if (i >= nextWander) {
          wanderTarget = (random() * 2 - 1) * .018;
          nextWander = i + Math.round(sampleRate * (.045 + random() * .055));
        }
        wander += wanderCoefficient * (wanderTarget - wander);
        if (i % 24 === 0) {
          const f = frequency * (1 + wander);
          const omega = TAU * Math.min(f, sampleRate * .31) / sampleRate;
          const alpha = Math.sin(omega) / (2 * q);
          a0 = alpha / (1 + alpha);
          a1 = 2 * Math.cos(omega) / (1 + alpha);
          a2 = (1 - alpha) / (1 + alpha);
          const omega2 = TAU * Math.min(f * ratio, sampleRate * .38) / sampleRate;
          const alpha2 = Math.sin(omega2) / (2 * (q * .7));
          b0 = alpha2 / (1 + alpha2);
          b1 = 2 * Math.cos(omega2) / (1 + alpha2);
          b2 = (1 - alpha2) / (1 + alpha2);
        }
        phase += pulseRate * cycleSpeed / sampleRate;
        if (phase >= 1) {
          phase -= 1;
          pulseLevel = .70 + random() * .40;
          cycleSpeed = .88 + random() * .24;
        }
        flutter += flutterCoefficient * (pulseLevel - flutter);
        const impulse = Math.exp(-phase / pulseWidth) * pulseLevel;
        const excitation = impulse * .40 + (random() * 2 - 1) * .20;
        const y = a0 * (excitation - e2) + a1 * y1 - a2 * y2;
        const z = b0 * (excitation - e2) + b1 * z1 - b2 * z2;
        e2 = e1; e1 = excitation;
        y2 = y1; y1 = y;
        z2 = z1; z1 = z;
        // The soft onset must emerge during a brief swipe, before its motion
        // envelope releases. Keep the long body/tail and sparse event spacing.
        const envelope = smoothstep(Math.min(1, x / .12)) * smoothstep(Math.min(1, (1 - x) / .34));
        event[i] = (y + z * .30) * envelope * flutter;
      }
      matchRms(event, .055 + random() * .015);
      for (let i = 0; i < n; i++) squeak[(start + i) % length] += event[i];
      squeakEvents.push({ start: start / sampleRate, duration: n / sampleRate });
      at += .340 + random() * .220;
    }
  }

  if (popped) {
    matchRms(bed, .003);
    matchRms(folds, .077);
  } else {
    bed.fill(0);
    folds.fill(0);
    foldEvents.length = 0;
    matchRms(squeak, .052);
  }
  // Independent playback levels keep the collapsed rustle quiet without
  // changing either texture.
  const outputGain = popped ? .4368 : 1.15;
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    if (!popped) {
      // Keep the established creak, with only the requested level adjustment.
      samples[i] = squeak[i] * outputGain;
      continue;
    }
    const mixed = bed[i] + folds[i];
    // A smooth knee catches rare coincident creases without hard clipping.
    const absolute = Math.abs(mixed);
    samples[i] = (absolute <= .32 ? mixed : Math.sign(mixed) * (.32 + .24 * (1 - Math.exp(-((absolute - .32) / .24))))) * outputGain;
  }
  const entryPoints = squeakEvents.map(event => event.start).filter(start => start > .08 && start < duration - .15);
  const result = { samples, sampleRate, duration, material, entryPoints };
  if (includeLayers) result.layers = { bed, folds, squeak, squeakEvents, foldEvents, foldCount: foldEvents.length };
  return result;
}
