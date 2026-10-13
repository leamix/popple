import { PopSequence, synthesizePop } from './sound.js';
import { drawComicSymbol, sampleComicSymbols } from '../core/comic-symbols.js';

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

        // Keep single pops linear. Only overlapping peaks meet the soft knee;
        // saturating the entire signal adds a gritty edge to headphone playback.
        this.ceiling = this.context.createWaveShaper();
        const curve = new Float32Array(2048);
        for (let i = 0; i < curve.length; i++) {
          const x = (i / (curve.length - 1)) * 2 - 1;
          const magnitude = Math.abs(x);
          const knee = 0.8;
          curve[i] = Math.sign(x) * (magnitude <= knee ? magnitude :
            knee + 0.16 * Math.tanh((magnitude - knee) / 0.16));
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
    return this.context.resume().then(() => {
      if (this.disposed || !this.enabled) return false;
      return true;
    }).catch(() => false);
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
    this.serial = Math.floor(Math.random() * 4294967296);
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
    const count = reducedMotion ? 3 + Math.floor(random() * 3) : 7 + Math.floor(random() * 5);
    // Irregular gaps keep accents apart without creating the same radial stamp.
    const gaps = Array.from({ length: count }, () => 0.65 + random() * 0.8);
    const totalGap = gaps.reduce((sum, gap) => sum + gap, 0);
    let angle = random() * TAU;
    const kinds = sampleComicSymbols(count, random);
    const rays = gaps.map((gap, index) => {
      const ray = {
        angle,
        kind: kinds[index],
        size: 0.66 + random() * 0.32,
        aspect: 0.88 + random() * 0.24,
        flip: random() < 0.5 ? -1 : 1,
        tilt: (random() - 0.5) * 0.55,
        reach: 0.65 + random() * 0.65,
        offset: 5 + random() * 5,
        delay: reducedMotion ? 0 : random() * 0.028,
        turn: reducedMotion ? 0 : (random() - 0.5) * 0.65,
      };
      angle += (gap / totalGap) * TAU;
      return ray;
    });
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
      // Keep even a rotating doodle outside the popped pocket.
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
        ctx.translate(burst.radius + (ray.offset + 12) * scale + travel, 0);
        ctx.rotate(ray.tilt + ray.turn * local);
        ctx.scale(scale * ray.size * appear * ray.aspect, scale * ray.size * appear * ray.flip);
        ctx.globalAlpha = opacity;
        drawComicSymbol(ctx, ray.kind, burst.dark);
        ctx.restore();
      }
      ctx.restore();
    }
    return this.bursts.length > 0;
  }

  drawBrandAccent(canvas, kind, dark) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 3);
    canvas.width = Math.round(32 * dpr);
    canvas.height = Math.round(32 * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(16, 16);
    ctx.scale(0.86, 0.86);
    drawComicSymbol(ctx, kind, dark);
  }

  clear() {
    this.bursts.length = 0;
    this.context?.clearRect(0, 0, this.width, this.height);
  }
}
