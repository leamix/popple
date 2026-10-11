import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { synthesizeFriction } from './friction.js';

const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

function measurements({ samples, sampleRate }) {
  let energy = 0, differenceEnergy = 0, peak = 0;
  const window = Math.round(sampleRate * .005);
  const envelope = [];
  let blockEnergy = 0;
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Number.isFinite(samples[i]));
    energy += samples[i] ** 2;
    blockEnergy += samples[i] ** 2;
    peak = Math.max(peak, Math.abs(samples[i]));
    if (i) differenceEnergy += (samples[i] - samples[i - 1]) ** 2;
    if ((i + 1) % window === 0) {
      envelope.push(Math.sqrt(blockEnergy / window));
      blockEnergy = 0;
    }
  }
  const overallRms = Math.sqrt(energy / samples.length);
  let envelopeChange = 0, envelopeEnergy = 0, smooth = 0, run = 0;
  const runs = [];
  for (let i = 0; i < envelope.length; i++) {
    if (i) envelopeChange += (envelope[i] - envelope[i - 1]) ** 2;
    envelopeEnergy += envelope[i] ** 2;
    // Read audible swells from the signal rather than the event schedule.
    // 15 ms smoothing ignores fine carrier noise inside a sustained fold.
    smooth += .25 * (envelope[i] - smooth);
    if (smooth > overallRms * .55) run++;
    else if (run) { runs.push(run * window / sampleRate); run = 0; }
  }
  if (run) runs.push(run * window / sampleRate);
  runs.sort((a, b) => a - b);
  envelope.sort((a, b) => a - b);
  return {
    peak,
    rms: overallRms,
    brightness: differenceEnergy / energy,
    dynamicRatio: envelope[Math.floor(envelope.length * .9)] / Math.max(1e-9, envelope[Math.floor(envelope.length * .1)]),
    differenceRms: Math.sqrt(differenceEnergy / (samples.length - 1)),
    envelopeRoughness: Math.sqrt(envelopeChange / Math.max(1e-15, envelopeEnergy)),
    swellDensity: runs.length / (samples.length / sampleRate),
    medianSwell: runs[Math.floor(runs.length / 2)] ?? 0,
  };
}

test('both surfaces stay finite, quiet and bounded at device sample rates', () => {
  for (const sampleRate of [8000, 44100, 48000, 96000]) {
    for (const material of ['intact', 'popped']) for (const seed of [7, 1089, 4207]) {
      const sound = synthesizeFriction(sampleRate, seed, material);
      const measured = measurements(sound);
      assert.equal(sound.sampleRate, sampleRate);
      assert.equal(sound.material, material);
      assert.ok(sound.duration >= 3 && sound.duration <= 5);
      assert.equal(sound.duration, sound.samples.length / sampleRate);
      assert.ok(measured.peak <= .56001, `${material} peak ${measured.peak}`);
      const range = material === 'intact' ? [.045, .065] : [.035, .065];
      assert.ok(measured.rms >= range[0] && measured.rms <= range[1], `${material} rms ${measured.rms}`);
    }
  }
});

test('circular fold and creak tails wrap without an added boundary click', () => {
  for (const sampleRate of [8000, 48000, 96000]) {
    for (const material of ['intact', 'popped']) for (const seed of [1, 7, 23, 4207, 9817]) {
      const sound = synthesizeFriction(sampleRate, seed, material);
      const { samples } = sound;
      const measured = measurements(sound);
      const seamDifference = Math.abs(samples[0] - samples.at(-1));
      assert.ok(seamDifference < measured.differenceRms * 5,
        `${material} loop step ${seamDifference} vs ordinary steps ${measured.differenceRms}`);
      // The unchanged intact creak has genuine quiet pauses. Continuous
      // collapsed rustle should also flow across the seam without a fade-out.
      const radius = Math.round(sampleRate * .090);
      let seamEnergy = 0;
      for (let i = 0; i < radius; i++) seamEnergy += samples[i] ** 2 + samples[samples.length - 1 - i] ** 2;
      const seamRms = Math.sqrt(seamEnergy / (2 * radius));
      assert.ok(seamRms < measured.rms * 2.6);
      if (material === 'popped') assert.ok(seamRms > measured.rms * .3);
    }
  }
});

test('collapsed plastic flows through overlapping long folds with soft fine detail', () => {
  for (const seed of [7, 23, 4207, 9817]) {
    const sound = synthesizeFriction(48000, seed, 'popped', { includeLayers: true });
    const { bed, folds } = sound.layers;
    assert.ok(rms(bed) / rms(folds) < .06, 'the noise floor should sit at least 24 dB below folds');
    const measured = measurements({ samples: folds, sampleRate: 48000 });
    assert.ok(measured.dynamicRatio > 1.4, 'overlapping folds should still change instead of becoming a flat hiss');
    assert.ok(measured.envelopeRoughness < .20, 'fine detail must not break into rapid amplitude clicks');
    assert.ok(measured.swellDensity < 3.5 && measured.medianSwell > .350,
      'overlapping folds should sustain rustle, rather than repeatedly stop between dry grains');
    assert.ok(measured.brightness > .10 && measured.brightness < .40,
      'film needs light upper detail without a raw dry noise edge');
  }
});

test('intact output keeps the established creak with its requested level and no added rustle', () => {
  // Fingerprints of the previously accepted isolated creak, captured before
  // separating materials. Guard its tone, rhythm and amplitude together.
  const fixtures = [
    [44100, 7, 'ebe3073642a0bd89d1cce188ebc5c0030580c4fd5d4d426aff45e75f9583dbb6'],
    [48000, 4207, '77866f187b9a498d65013905b10a9d4199538db53ef7b21188f6be73ed9f139a'],
    [96000, 9817, '234edce56129b040b0097dfe3727533697614ea4335441e72d56764a15cc7dfa'],
  ];
  for (const [sampleRate, seed, expected] of fixtures) {
    const sound = synthesizeFriction(sampleRate, seed, 'intact', { includeLayers: true });
    const { bed, folds, squeak, foldEvents } = sound.layers;
    const bytes = Buffer.from(squeak.buffer, squeak.byteOffset, squeak.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    assert.deepEqual(sound.samples, Float32Array.from(squeak, value => value * 1.15));
    assert.equal(rms(bed), 0);
    assert.equal(rms(folds), 0);
    assert.deepEqual(foldEvents, []);
  }
});

test('intact creaks stay sparse and smooth; popped film has none', () => {
  const rate = 48000;
  for (const seed of [7, 23, 4207, 9817]) {
    const intact = synthesizeFriction(rate, seed, 'intact', { includeLayers: true });
    const { squeak, squeakEvents } = intact.layers;
    const measured = measurements({ samples: squeak, sampleRate: rate });
    assert.ok(measured.swellDensity < 3 && measured.medianSwell > .16,
      'audible creaks should linger instead of repeatedly chirping');
    assert.ok(measured.envelopeRoughness < .4, 'creak envelopes should not break up into rapid flutter');
    assert.ok(intact.entryPoints.length >= 4, 'short gestures still need several distinct safe entry choices');
    for (const point of intact.entryPoints) {
      assert.ok(point > .08 && point < intact.duration - .15);
      assert.ok(squeakEvents.some(event => event.start === point));
    }
    const popped = synthesizeFriction(rate, seed, 'popped', { includeLayers: true });
    assert.equal(rms(popped.layers.squeak), 0);
    assert.deepEqual(popped.layers.squeakEvents, []);
    assert.deepEqual(popped.entryPoints, []);
  }
});

test('short intact creaks retain tonal structure distinct from collapsed rustle', () => {
  function tonalCorrelation(samples, rate, center, span = .018) {
    const start = Math.round((center - span / 2) * rate);
    const count = Math.round(span * rate);
    let best = 0;
    for (let lag = Math.round(rate / 1500); lag <= Math.round(rate / 500); lag++) {
      let cross = 0, leftEnergy = 0, rightEnergy = 0;
      for (let i = 0; i < count; i++) {
        const left = samples[(start + i + samples.length) % samples.length];
        const right = samples[(start + i + lag + samples.length) % samples.length];
        cross += left * right;
        leftEnergy += left * left;
        rightEnergy += right * right;
      }
      best = Math.max(best, cross / Math.sqrt(Math.max(1e-15, leftEnergy * rightEnergy)));
    }
    return best;
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const seed of [7, 23, 4207, 9817]) {
    const intact = synthesizeFriction(48000, seed, 'intact', { includeLayers: true });
    const { layers } = intact;
    const creaks = [];
    for (const event of layers.squeakEvents.slice(2, 14)) {
      const center = event.start + event.duration * .48;
      creaks.push(tonalCorrelation(layers.squeak, 48000, center));
    }
    assert.ok(median(creaks) > .5 && median(creaks) < .96,
      'creaks need pitched structure with flutter, not hiss or a clean sine');
    // Compare actual outputs within a brief 150 ms gesture: the collapsed
    // film's broader resonance must stay distinct from the intact creak.
    const popped = synthesizeFriction(48000, seed, 'popped');
    const mixed = [], collapsed = [];
    for (const point of intact.entryPoints) {
      mixed.push(tonalCorrelation(intact.samples, 48000, point + .070, .036));
      collapsed.push(tonalCorrelation(popped.samples, 48000, point + .070, .036));
    }
    assert.ok(median(mixed) > .3 && median(mixed) < .85,
      'a short intact stroke must retain a soft pitched texture without becoming a pure note');
    assert.ok(median(mixed) > median(collapsed) * 2,
      'intact and collapsed short strokes must differ in tonal structure, not just volume');
  }
});

test('seeds reproduce textures and vary the crease and creak pattern', () => {
  for (const material of ['intact', 'popped']) {
    const a = synthesizeFriction(48000, 1089, material);
    const b = synthesizeFriction(48000, 1089, material);
    const c = synthesizeFriction(48000, 9817, material);
    assert.deepEqual(a, b);
    assert.notEqual(a.duration, c.duration);
    assert.notDeepEqual(a.samples, c.samples);
    assert.equal(a.layers, undefined, 'ordinary playback does not retain diagnostic buffers');
  }
  assert.equal(synthesizeFriction(8000, 1).material, 'intact');
});

test('invalid rates and unknown materials are rejected', () => {
  for (const rate of [0, 7999, 192001, NaN, Infinity]) assert.throws(() => synthesizeFriction(rate, 1), RangeError);
  assert.throws(() => synthesizeFriction(48000, 1, 'rubber'), RangeError);
});
