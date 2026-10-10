import { PopSequence, synthesizePop } from './sound.js';

// Short, dry plastic transients and perimeter-only comic accents.
// Everything is generated locally: no audio download or external dependencies.

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function randomFrom(seed) {
  let n = seed >>> 0;
  return () => {
    n += 0x6D2B79F5;
    let v = n;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

export class PopAudio {
  constructor() {
    this.enabled = true;
    this.context = null;
    this.sequence = new PopSequence();
    this.sources = new Set();
    this.output = null;
    this.limiter = null;
    this.disposed = false;
  }

  // Call directly inside pointerdown/keydown; mobile Safari needs this gesture.
  unlock() {
    if (!this.enabled || this.disposed) return Promise.resolve(false);
    if (!this.context) {
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContext) return Promise.resolve(false);
      try {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        this.output = this.context.createGain();
        this.output.gain.value = 0.9;
        this.limiter = this.context.createDynamicsCompressor();
        this.limiter.threshold.value = -4;
        this.limiter.knee.value = 3;
        this.limiter.ratio.value = 16;
        this.limiter.attack.value = 0.001;
        this.limiter.release.value = 0.06;

        // An instantaneous soft ceiling also bounds simultaneous finger pops.
        this.ceiling = this.context.createWaveShaper();
        const curve = new Float32Array(2048);
        for (let i = 0; i < curve.length; i++) {
          const x = (i / (curve.length - 1)) * 2 - 1;
          curve[i] = Math.tanh(x * 1.35) * 0.92;
        }
        this.ceiling.curve = curve;
        this.ceiling.oversample = '2x';
        this.limiter.connect(this.ceiling);
        this.ceiling.connect(this.output);
        this.output.connect(this.context.destination);

        // A silent source primes older WebKit implementations without a beep.
        const silent = this.context.createBufferSource();
        silent.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
        silent.connect(this.output);
        silent.onended = () => silent.disconnect();
        silent.start();
      } catch {
        this.context?.close().catch(() => {});
        this.context = null;
        return Promise.resolve(false);
      }
    }
    if (this.context.state === 'running') return Promise.resolve(true);
    return this.context.resume().then(() => true).catch(() => false);
  }

  makeSnap(seed, family) {
    const { samples } = synthesizePop(this.context.sampleRate, seed, family);
    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  pop(strength = 1) {
    const ctx = this.context;
    if (!this.enabled || !ctx || this.disposed || ctx.state !== 'running') return false;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const next = this.sequence.next();
    // A fresh physical envelope for every pop, not a pitch-shifted sample loop.
    source.buffer = this.makeSnap(next.seed, next.family);
    source.playbackRate.value = 0.985 + Math.random() * 0.03;
    gain.gain.value = clamp(strength, 0.2, 1.15);
    source.connect(gain);
    gain.connect(this.limiter);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      this.sources.delete(source);
    };
    source.start(ctx.currentTime + 0.002);
    return true;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.output && this.context) {
      this.output.gain.setTargetAtTime(this.enabled ? 0.9 : 0, this.context.currentTime, 0.006);
    }
  }

  dispose() {
    this.disposed = true;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* A completed source is already silent. */ }
      source.disconnect();
    }
    this.sources.clear();
    this.context?.close().catch(() => {});
    this.context = null;
  }
}

export class BurstLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    this.bursts = [];
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.serial = 1;
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
  }

  resize(cssWidth, cssHeight, dpr = globalThis.devicePixelRatio || 1) {
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);
    this.dpr = clamp(dpr, 1, 3);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  burst(x, y, radius, { dark = true, reducedMotion = false } = {}) {
    if (!this.context) return;
    const random = randomFrom(++this.serial * 9817);
    const count = reducedMotion ? 5 : 9;
    const rotation = random() * 0.5;
    const rays = Array.from({ length: count }, (_, i) => ({
      angle: rotation + (i / count) * TAU + (random() - 0.5) * 0.22,
      kind: reducedMotion ? 2 : i % 4,
      size: 0.8 + random() * 0.45,
      reach: 0.7 + random() * 0.55,
      delay: reducedMotion ? 0 : random() * 0.022,
      turn: (random() - 0.5) * 0.3,
    }));
    this.bursts.push({ x, y, radius: Math.max(8, radius), dark, reducedMotion, rays,
      start: performance.now() / 1000, duration: reducedMotion ? 0.18 : 0.51 });
    // Multitouch remains bounded even if a caller emits an accidental stream.
    if (this.bursts.length > 20) this.bursts.shift();
  }

  render(timeSeconds = performance.now() / 1000) {
    const ctx = this.context;
    if (!ctx) return false;
    ctx.clearRect(0, 0, this.width, this.height);
    this.bursts = this.bursts.filter((burst) => timeSeconds - burst.start < burst.duration);
    for (const burst of this.bursts) {
      const age = Math.max(0, timeSeconds - burst.start);
      const progress = clamp(age / burst.duration, 0, 1);
      const scale = clamp(burst.radius / 40, 0.65, 1.65);
      ctx.save();
      ctx.translate(burst.x, burst.y);
      // No accent can paint the bubble, including the final rotating stars.
      ctx.beginPath();
      ctx.rect(-this.width * 2, -this.height * 2, this.width * 4, this.height * 4);
      ctx.arc(0, 0, burst.radius * 1.045, 0, TAU);
      ctx.clip('evenodd');
      for (const ray of burst.rays) {
        const local = clamp((age - ray.delay) / (burst.duration - ray.delay), 0, 1);
        if (age < ray.delay) continue;
        const travel = burst.reducedMotion ? 0 : easeOut(local) * 30 * scale * ray.reach;
        const opacity = burst.reducedMotion ? 0.7 * (1 - progress) :
          Math.min(1, local * 30 + 0.15) * Math.pow(1 - local, 0.85);
        const appear = burst.reducedMotion ? 0.6 : 0.78 + Math.sin(local * Math.PI) * 0.25;
        ctx.save();
        ctx.rotate(ray.angle);
        ctx.translate(burst.radius + 7 * scale + travel, 0);
        ctx.rotate(ray.turn * local);
        ctx.scale(scale * ray.size * appear, scale * ray.size * appear);
        ctx.globalAlpha = opacity;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = burst.dark ? '#161b20' : '#293c4a';
        ctx.fillStyle = burst.dark ? '#f4df9b' : '#f6cd64';
        ctx.lineWidth = 1.15;

        if (ray.kind === 0) this.dart(ctx);
        else if (ray.kind === 1) this.lightning(ctx);
        else if (ray.kind === 2) this.strokes(ctx, burst.dark);
        else this.star(ctx, burst.dark, local);
        ctx.restore();
      }
      ctx.restore();
    }
    return this.bursts.length > 0;
  }

  dart(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(18, -5);
    ctx.lineTo(16, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(10, -7);
    ctx.lineTo(21, -12);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  lightning(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, 1);
    ctx.lineTo(10, -5);
    ctx.lineTo(10, -1);
    ctx.lineTo(23, -6);
    ctx.lineTo(14, 5);
    ctx.lineTo(14, 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  strokes(ctx, dark) {
    ctx.strokeStyle = dark ? '#f6edd2' : '#3f515e';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(16, -0.6);
    ctx.moveTo(5, -5);
    ctx.lineTo(14, -7);
    ctx.moveTo(7, 5);
    ctx.lineTo(19, 7);
    ctx.stroke();
  }

  star(ctx, dark, progress) {
    ctx.translate(7, 0);
    ctx.rotate(progress * 0.4);
    ctx.fillStyle = dark ? '#fff1c7' : '#ffdf88';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.quadraticCurveTo(1.7, -1.5, 7, 0);
    ctx.quadraticCurveTo(1.7, 1.5, 0, 7);
    ctx.quadraticCurveTo(-1.7, 1.5, -7, 0);
    ctx.quadraticCurveTo(-1.7, -1.5, 0, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(12, -8, 1.4, 0, TAU);
    ctx.fill();
  }

  clear() {
    this.bursts.length = 0;
    this.context?.clearRect(0, 0, this.width, this.height);
  }
}
