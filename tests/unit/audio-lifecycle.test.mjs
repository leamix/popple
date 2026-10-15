import test from 'node:test';
import assert from 'node:assert/strict';
import { PopAudio } from '../../public/js/audio/effects.js';

// Audio devices are browser-owned. Exercise PopAudio against nodes that record
// its real graph, activation and playback calls without opening an audio device.
function installAudio(t, { failConstruction = 0, failGraph = 0, failStart = 0, rejectResume = false } = {}) {
  const original = globalThis.AudioContext, legacy = globalThis.webkitAudioContext;
  const contexts = [], calls = [];
  const parameter = () => ({ value: 0, setTargetAtTime: (...args) => calls.push(['setTargetAtTime', ...args]) });
  const node = kind => ({
    kind, connect: target => calls.push(['connect', kind, target.kind]),
    disconnect: () => calls.push(['disconnect', kind]),
  });
  globalThis.AudioContext = class {
    constructor(options) {
      calls.push(['construct', options]);
      if (failConstruction-- > 0) throw new Error('audio device unavailable');
      this.state = 'suspended'; this.sampleRate = 22050; this.currentTime = 3;
      this.destination = { kind: 'destination' };
      contexts.push(this);
    }
    createGain() { calls.push(['gain']); return { ...node('gain'), gain: parameter() }; }
    createDynamicsCompressor() {
      if (failGraph-- > 0) throw new Error('graph unavailable');
      return { ...node('compressor'), threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter() };
    }
    createWaveShaper() { return node('ceiling'); }
    createBuffer(channels, length, sampleRate) {
      calls.push(['buffer', channels, length, sampleRate]);
      return { getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      calls.push(['source']);
      return { ...node('source'), playbackRate: parameter(),
        start: (...args) => { calls.push(['start', ...args]); if (failStart-- > 0) throw new Error('source unavailable'); },
        stop: () => calls.push(['stop']),
      };
    }
    resume() {
      calls.push(['resume']);
      if (rejectResume) return Promise.reject(new Error('activation required'));
      this.state = 'running'; return Promise.resolve();
    }
    close() { calls.push(['close']); this.state = 'closed'; return Promise.resolve(); }
  };
  delete globalThis.webkitAudioContext;
  t.after(() => {
    if (original === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = original;
    if (legacy === undefined) delete globalThis.webkitAudioContext; else globalThis.webkitAudioContext = legacy;
  });
  return { contexts, calls, count: name => calls.filter(call => call[0] === name).length };
}

test('preparing audio constructs one silent graph without resuming or starting a source', t => {
  const fake = installAudio(t), audio = new PopAudio();
  assert.equal(audio.prepare(), true);
  const context = audio.context;
  assert.equal(audio.prepare(), true);
  assert.equal(fake.count('construct'), 1);
  assert.equal(fake.count('source'), 0);
  assert.equal(fake.count('start'), 0);
  assert.equal(fake.count('resume'), 0);
  assert.equal(audio.context, context);
  assert.equal(context.state, 'suspended');
  assert.deepEqual(fake.calls.filter(call => call[0] === 'connect'), [
    ['connect', 'compressor', 'ceiling'], ['connect', 'ceiling', 'gain'], ['connect', 'gain', 'destination'],
  ]);
  assert.equal(audio.output.gain.value, .9);
  assert.equal(audio.limiter.threshold.value, -4);
  assert.equal(audio.ceiling.curve.length, 2048);
});

test('unlock uses the prepared graph and starts its WebKit prime once before resume', async t => {
  const fake = installAudio(t), audio = new PopAudio();
  audio.prepare();
  const context = audio.context;
  assert.equal(await audio.unlock(), true);
  assert.equal(fake.count('construct'), 1);
  assert.equal(fake.count('source'), 1);
  assert.equal(fake.count('start'), 1);
  assert.equal(fake.count('resume'), 1);
  assert.ok(fake.calls.findIndex(call => call[0] === 'start') < fake.calls.findIndex(call => call[0] === 'resume'));
  assert.equal(audio.context, context);
  assert.equal(await audio.unlock(), true);
  assert.equal(fake.count('start'), 1);
  assert.equal(fake.count('resume'), 1);
  assert.equal(audio.pop(), true, 'prepared playback retains the normal pop graph');
  assert.equal(fake.count('start'), 2);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'start').at(-1), ['start', 3.002]);
});

test('a trusted unlock still constructs and primes audio when idle preparation has not run', async t => {
  const fake = installAudio(t), audio = new PopAudio();
  assert.equal(await audio.unlock(), true);
  assert.equal(fake.count('construct'), 1);
  assert.equal(fake.count('start'), 1);
  assert.equal(fake.count('resume'), 1);
});

test('disabled and disposed audio never construct or activate a context', async t => {
  const fake = installAudio(t), audio = new PopAudio();
  audio.setEnabled(false);
  assert.equal(audio.prepare(), false);
  assert.equal(await audio.unlock(), false);
  audio.setEnabled(true);
  audio.dispose();
  assert.equal(audio.prepare(), false);
  assert.equal(await audio.unlock(), false);
  assert.equal(fake.count('construct'), 0);
});

test('preparation failures release incomplete graphs and allow a later retry', t => {
  const fake = installAudio(t, { failConstruction: 1, failGraph: 1 }), audio = new PopAudio();
  assert.equal(audio.prepare(), false);
  assert.equal(audio.prepare(), false);
  assert.equal(audio.context, null);
  assert.equal(audio.output, null);
  assert.equal(audio.limiter, null);
  assert.equal(fake.count('close'), 1);
  assert.equal(audio.prepare(), true);
  assert.equal(fake.count('construct'), 3);
  assert.equal(fake.count('start'), 0);
});

test('a failed silent prime releases its graph and a later unlock can retry', async t => {
  const fake = installAudio(t, { failStart: 1 }), audio = new PopAudio();
  assert.equal(audio.prepare(), true);
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.context, null);
  assert.equal(fake.count('close'), 1);
  assert.equal(await audio.unlock(), true);
  assert.equal(fake.count('construct'), 2);
  assert.equal(fake.count('start'), 2);
  assert.equal(fake.count('resume'), 1);
});

test('rejected activation remains silent and retries resume without replaying the prime', async t => {
  const fake = installAudio(t, { rejectResume: true }), audio = new PopAudio();
  assert.equal(audio.prepare(), true);
  assert.equal(await audio.unlock(), false);
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.pop(), false);
  assert.equal(fake.count('construct'), 1);
  assert.equal(fake.count('start'), 1);
  assert.equal(fake.count('resume'), 2);
});
