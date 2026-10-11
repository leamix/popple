import test from 'node:test';
import assert from 'node:assert/strict';
import { POP_FAMILIES, PopSequence, synthesizePop } from './sound.js';
import { PopAudio } from './effects.js';

function measurements(sound) {
  const { samples, sampleRate } = sound;
  let peak = 0, energy = 0, highFrequency = 0, lateEnergy = 0;
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Number.isFinite(samples[i]));
    peak = Math.max(peak, Math.abs(samples[i]));
    energy += samples[i] ** 2;
    if (i) highFrequency += (samples[i] - samples[i - 1]) ** 2;
    if (i > sampleRate * .028) lateEnergy += samples[i] ** 2;
  }
  return { peak, rms: Math.sqrt(energy / samples.length), brightness: highFrequency / energy, lateFraction: lateEnergy / energy };
}

test('every family has a finite audible transient, bounded peak and silent tail', () => {
  for (const sampleRate of [8000, 44100, 48000, 49000, 96000]) {
    for (const family of POP_FAMILIES) for (const seed of [1, 1089, 4207, 9817, 26131]) {
      const sound = synthesizePop(sampleRate, seed, family);
      const result = measurements(sound);
      assert.ok(sound.duration > .06 && sound.duration < .15);
      assert.ok(result.peak > .9 && result.peak <= .961);
      assert.ok(result.rms > .025 && result.rms < .24);
      assert.equal(sound.samples[0], 0);
      assert.ok(sound.samples.slice(Math.ceil(sound.samples.length * .9)).every(value => value === 0));
    }
  }
});

test('single pops keep a defined attack and fade without detached late crackles', () => {
  for (const family of POP_FAMILIES.filter(family => family !== 'double')) {
    for (let i = 0; i < 64; i++) {
      const result = measurements(synthesizePop(48000, 4207 + i * 9817, family));
      // The former bass-heavy family lost almost all attack definition, while
      // its thin counterpart approached raw white noise (brightness ~2).
      assert.ok(result.brightness > .12 && result.brightness < 1.3,
        `${family} has an overly dull or harsh attack: ${result.brightness}`);
      // A single rupture must decay promptly, without new noise clicks tens
      // of milliseconds later that read as electrical static in headphones.
      assert.ok(result.lateFraction < .005,
        `${family} has detached late noise: ${result.lateFraction}`);
    }
  }
});

test('family changes alter colour and envelope, not just pitch', () => {
  const results = Object.fromEntries(POP_FAMILIES.map(family => [family, measurements(synthesizePop(48000, 4207, family))]));
  // Fuller and tauter film still differ, while both keep a clear attack.
  assert.ok(results.tight.brightness > results.body.brightness * 1.4);
  assert.ok(results.snap.brightness > results.body.brightness * 1.2);
  // Only the intentional, occasional double has an audible second rupture.
  assert.ok(results.crinkle.lateFraction < .005);
  assert.ok(results.double.lateFraction > .2);
  assert.ok(results.snap.lateFraction < .015);
  assert.ok(results.tight.lateFraction < .015);
});

test('fresh seeds vary waveform, duration and timbre within each family', () => {
  for (const family of POP_FAMILIES) {
    const examples = [7, 23, 88, 173, 449, 818, 1420, 7799].map(seed => synthesizePop(48000, seed, family));
    const durations = examples.map(sound => sound.duration);
    const brightness = examples.map(sound => measurements(sound).brightness);
    assert.ok(Math.max(...durations) - Math.min(...durations) > .004);
    assert.ok(Math.max(...brightness) / Math.min(...brightness) > 1.12);
    for (let i = 1; i < examples.length; i++) assert.notDeepEqual(examples[i].samples, examples[i - 1].samples);
  }
});

test('selection avoids neighbouring families and keeps double snaps occasional', () => {
  const sequence = new PopSequence(7654);
  const counts = Object.fromEntries(POP_FAMILIES.map(family => [family, 0]));
  let previous;
  const firstSeeds = new Set();
  for (let i = 0; i < 5000; i++) {
    const next = sequence.next();
    assert.notEqual(next.family, previous);
    counts[next.family]++;
    previous = next.family;
    if (i < 100) firstSeeds.add(next.seed);
  }
  assert.equal(firstSeeds.size, 100);
  assert.ok(counts.double > 150 && counts.double < 600);
  for (const family of ['snap', 'body', 'crinkle', 'tight']) assert.ok(counts[family] > 700);
});

test('seeded synthesis and sequence are deterministic for reproducible checks', () => {
  const a = new PopSequence(555), b = new PopSequence(555);
  for (let i = 0; i < 20; i++) assert.deepEqual(a.next(), b.next());
  assert.deepEqual(synthesizePop(44100, 8701), synthesizePop(44100, 8701));
});

test('legacy makeSnap(seed) remains usable with an externally supplied audio context', () => {
  const audio = new PopAudio();
  // No global AudioContext: construction and makeSnap never autoplay.
  assert.equal(audio.context, null);
  audio.context = { sampleRate: 49000, createBuffer: (_, length, sampleRate) => {
    const samples = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => samples };
  } };
  for (const seed of [1089, 4207, 9817, 26131]) {
    const buffer = audio.makeSnap(seed);
    const result = measurements({ samples: buffer.getChannelData(0), sampleRate: 49000 });
    assert.ok(buffer.duration < .15 && result.peak <= .961 && result.rms > .025);
  }
});
