import { synthesizeFriction } from './friction.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const materialFor = popped => popped ? 'popped' : 'intact';

/** Motion-powered sound. Every movement expires on the audio clock, even if
 * the main thread stalls or no further pointer event arrives. */
export class FrictionPlayer {
  constructor(owner) {
    this.owner = owner;
    this.contacts = new Map();
    this.voices = new Set();
    this.buffers = new Map();
    this.entryPoints = new Map();
    this.seed = Math.floor(Math.random() * 4294967296);
    this.warmup = null;
    this.cancelWarmup = null;
  }

  prepare() {
    if (this.warmup !== null || this.buffers.size === 2) return;
    const run = () => {
      this.warmup = null;
      if (!this.owner.enabled || this.owner.disposed || !this.owner.context) return;
      this.buffer('intact');
      this.buffer('popped');
    };
    // Warm once after unlock, preferably between frames rather than on a drag.
    if (globalThis.requestIdleCallback) {
      this.cancelWarmup = id => globalThis.cancelIdleCallback(id);
      this.warmup = globalThis.requestIdleCallback(run, { timeout: 500 });
    } else {
      this.cancelWarmup = clearTimeout;
      this.warmup = setTimeout(run, 30);
    }
  }

  begin(id, { x, y, popped = false, pan = 0 }, time) {
    this.end(id);
    if (!this.owner.enabled || this.owner.disposed || ![x, y, time].every(Number.isFinite)) return;
    this.contacts.set(id, { x, y, time, pan, material: materialFor(popped), speed: 0,
      variation: Math.random(), strokes: 0, voice: null });
  }

  buffer(material) {
    const ctx = this.owner.context;
    const key = `${ctx.sampleRate}:${material}`;
    if (!this.buffers.has(key)) {
      const { samples, entryPoints = [] } = synthesizeFriction(ctx.sampleRate, this.seed, material);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.getChannelData(0).set(samples);
      this.buffers.set(key, buffer);
      this.entryPoints.set(key, entryPoints);
    }
    return this.buffers.get(key);
  }

  createVoice(contact) {
    const ctx = this.owner.context;
    // At most fourteen live fingers plus a short material/release crossfade.
    if (this.voices.size >= 28) this.retire(this.voices.values().next().value, true);
    const source = ctx.createBufferSource(), gain = ctx.createGain();
    const panner = ctx.createStereoPanner?.();
    source.buffer = this.buffer(contact.material);
    source.loop = true;
    gain.gain.value = 0;
    source.connect(gain);
    if (panner) {
      panner.pan.value = clamp(contact.pan, -1, 1) * .24;
      gain.connect(panner);
      panner.connect(this.owner.limiter);
    } else gain.connect(this.owner.limiter);
    const entries = contact.material === 'intact'
      ? this.entryPoints.get(`${ctx.sampleRate}:${contact.material}`) || [] : [];
    // Begin just ahead of a creak, so a brief real swipe can hear the material.
    // A new stretch on each stroke prevents repeated stop/start movements from
    // replaying the same small fragment throughout an entire contact.
    const phase = (contact.variation + contact.strokes++ * .38196601125) % 1;
    const cueStart = entries.length ? entries[Math.floor(phase * entries.length)] : null;
    const bufferStart = cueStart === null ? phase * source.buffer.duration : Math.max(0, cueStart - .020);
    const voice = { source, gain, panner, material: contact.material, stopAt: Infinity, contact,
      bufferStart, cueStart };
    source.onended = () => this.cleanup(voice);
    this.voices.add(voice);
    contact.voice = voice;
    source.start(ctx.currentTime, bufferStart);
    return voice;
  }

  move(id, { x, y, popped = false, pan = 0 }, time) {
    const contact = this.contacts.get(id);
    if (!contact || ![x, y, time, pan].every(Number.isFinite) || time <= contact.time) return false;
    this.setMaterial(id, popped);
    const distance = Math.hypot(x - contact.x, y - contact.y);
    // Accumulate tiny travel instead of turning stationary sensor jitter into hiss.
    if (distance < .006) return false;
    const elapsed = time - contact.time;
    const dt = clamp(elapsed, .008, .08);
    if (elapsed > .18) contact.speed = 0;
    // Keep the real travel time: clamping it would amplify slow sensor drift
    // after a pause into an audible stroke. Only smoothing needs a bounded dt.
    const speed = Math.min(distance / Math.max(.008, elapsed), 14);
    contact.speed += (speed - contact.speed) * (1 - Math.exp(-dt / .025));
    contact.x = x; contact.y = y; contact.time = time; contact.pan = pan;
    const ctx = this.owner.context;
    if (!this.owner.enabled || this.owner.disposed || !ctx || ctx.state !== 'running') return false;
    if (contact.speed < .055) return false;
    let now = ctx.currentTime;
    // onended can arrive a task later than the actual scheduled stop.
    if (contact.voice && contact.voice.stopAt <= now + .003) this.retire(contact.voice, true);
    const voice = contact.voice || this.createVoice(contact);
    // A cold buffer may have taken a frame to synthesize. Start the envelope
    // from the fresh audio time, never halfway through its own fade.
    now = ctx.currentTime;
    const energy = 1 - Math.exp(-contact.speed / 2.8);
    const moving = [...this.contacts.values()].filter(c => c.voice && c.voice.stopAt > now).length;
    const level = (.012 + .30 * Math.sqrt(energy)) / Math.sqrt(Math.max(1, moving));
    const param = voice.gain.gain;
    // Retain the current value when replacing the previous movement's fade.
    const value = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
    param.setTargetAtTime(level, now, .012);
    // Bridge an occasional missed pointer frame at 30 Hz without a dip in a
    // continuous stroke; still fade promptly when travel actually stops.
    param.setTargetAtTime(0, now + .070, .026);
    voice.source.playbackRate.setTargetAtTime(.82 + energy * .37 + contact.variation * .055, now, .04);
    voice.panner?.pan.setTargetAtTime(clamp(pan, -1, 1) * .24, now, .04);
    voice.stopAt = now + .32;
    // Repeated stop() calls replace the pending stop until it has occurred.
    voice.source.stop(voice.stopAt);
    return true;
  }

  setMaterial(id, popped) {
    const contact = this.contacts.get(id), material = materialFor(popped);
    if (!contact || contact.material === material) return;
    // Fade taut-film squeak immediately at rupture; future motion is all folds.
    if (contact.voice) this.retire(contact.voice);
    contact.material = material;
  }

  cleanup(voice) {
    voice.source.disconnect(); voice.gain.disconnect(); voice.panner?.disconnect();
    this.voices.delete(voice);
    if (voice.contact.voice === voice) voice.contact.voice = null;
  }

  retire(voice, immediate = false) {
    if (!voice) return;
    if (voice.contact.voice === voice) voice.contact.voice = null;
    const ctx = this.owner.context;
    if (immediate || !ctx || ctx.state !== 'running') {
      try { voice.source.stop(); } catch { /* Already ended. */ }
      this.cleanup(voice);
      return;
    }
    const param = voice.gain.gain, now = ctx.currentTime, value = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
    param.setTargetAtTime(0, now, .010);
    voice.stopAt = now + .08;
    voice.source.stop(voice.stopAt);
  }

  end(id) {
    const contact = this.contacts.get(id);
    if (contact?.voice) this.retire(contact.voice);
    this.contacts.delete(id);
  }

  stopAll() {
    this.contacts.clear();
    for (const voice of this.voices) this.retire(voice);
  }

  dispose() {
    if (this.warmup !== null) this.cancelWarmup(this.warmup);
    this.warmup = null;
    this.contacts.clear();
    for (const voice of this.voices) this.retire(voice, true);
    this.buffers.clear();
    this.entryPoints.clear();
  }
}
