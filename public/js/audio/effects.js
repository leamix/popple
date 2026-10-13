import { PopSequence, synthesizePop } from './sound.js';
import { COMIC_SYMBOLS, drawComicSymbol, sampleComicSymbols } from '../core/comic-symbols.js';
import { BURST_CONFIG } from '../core/config.js';

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
    const random = randomFrom(++this.serial * BURST_CONFIG.randomSeedMultiplier);
    const count = Math.min(COMIC_SYMBOLS.length,
      reducedMotion
        ? BURST_CONFIG.reduced.minSymbols + Math.floor(random() * BURST_CONFIG.reduced.symbolCountRange)
        : BURST_CONFIG.normal.minSymbols + Math.floor(random() * BURST_CONFIG.normal.symbolCountRange));
    // Every burst can begin at a different angle, while its symbols stay evenly
    // spaced around the pocket so the ring remains breathable and deliberate.
    const startAngle = random() * TAU;
    const angularStep = TAU / count;
    const kinds = sampleComicSymbols(count, random);
    const rays = Array.from({ length: count }, (_, index) => {
      const ray = {
        angle: startAngle + angularStep * index,
        kind: kinds[index],
        size: BURST_CONFIG.glyph.size + random() * BURST_CONFIG.glyph.sizeRange,
        aspect: BURST_CONFIG.glyph.aspect + random() * BURST_CONFIG.glyph.aspectRange,
        reach: BURST_CONFIG.glyph.reach + random() * BURST_CONFIG.glyph.reachRange,
        offset: BURST_CONFIG.glyph.offset + random() * BURST_CONFIG.glyph.offsetRange,
        delay: reducedMotion ? 0 : random() * BURST_CONFIG.glyph.delayRange,
      };
      return ray;
    });
    this.bursts.push({ x, y, radius: Math.max(BURST_CONFIG.glyph.minimumRadius, radius), dark, reducedMotion, rays,
      start: performance.now() / 1000, duration: reducedMotion ? BURST_CONFIG.reduced.duration : BURST_CONFIG.normal.duration });
    // Multitouch remains bounded even if a caller emits an accidental stream.
    if (this.bursts.length > BURST_CONFIG.maximumConcurrentBursts) this.bursts.shift();
  }

  render(timeSeconds = performance.now() / 1000) {
    const ctx = this.context;
    if (!ctx) return false;
    ctx.clearRect(0, 0, this.width, this.height);
    this.bursts = this.bursts.filter((burst) => timeSeconds - burst.start < burst.duration);
    for (const burst of this.bursts) {
      const age = Math.max(0, timeSeconds - burst.start);
      const progress = clamp(age / burst.duration, 0, 1);
      const scale = clamp(burst.radius / BURST_CONFIG.animation.radiusReference,
        BURST_CONFIG.animation.minimumScale, BURST_CONFIG.animation.maximumScale);
      ctx.save();
      ctx.translate(burst.x, burst.y);
      // Keep every doodle outside the popped pocket.
      ctx.beginPath();
      ctx.rect(-this.width * 2, -this.height * 2, this.width * 4, this.height * 4);
      ctx.arc(0, 0, burst.radius * BURST_CONFIG.glyph.clipRadiusScale, 0, TAU);
      ctx.clip('evenodd');
      for (const ray of burst.rays) {
        const local = clamp((age - ray.delay) / (burst.duration - ray.delay), 0, 1);
        if (age < ray.delay) continue;
        const travel = burst.reducedMotion ? 0 : easeOut(local) * BURST_CONFIG.glyph.travelDistance * scale * ray.reach;
        const opacity = burst.reducedMotion ? BURST_CONFIG.animation.reducedOpacity * (1 - progress) :
          Math.min(1, local * BURST_CONFIG.animation.opacityRamp + BURST_CONFIG.animation.opacityStart) *
          Math.pow(1 - local, BURST_CONFIG.animation.opacityFalloff);
        const appear = burst.reducedMotion ? BURST_CONFIG.animation.reducedAppear :
          BURST_CONFIG.animation.appearBase + Math.sin(local * Math.PI) * BURST_CONFIG.animation.appearPulse;
        ctx.save();
        ctx.rotate(ray.angle);
        ctx.translate(burst.radius + (ray.offset + BURST_CONFIG.glyph.baseDistance) * scale + travel, 0);
        // Each glyph's native +Y points back at the pocket. It keeps this
        // radial facing throughout flight, without random birth tilt or flips.
        ctx.rotate(BURST_CONFIG.glyph.inwardRotation);
        ctx.scale(scale * ray.size * appear * ray.aspect, scale * ray.size * appear);
        ctx.globalAlpha = opacity;
        drawComicSymbol(ctx, ray.kind, burst.dark);
        ctx.restore();
      }
      ctx.restore();
    }
    return this.bursts.length > 0;
  }

  clear() {
    this.bursts.length = 0;
    this.context?.clearRect(0, 0, this.width, this.height);
  }
}
