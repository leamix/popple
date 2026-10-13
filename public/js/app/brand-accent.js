import { COMIC_SYMBOLS, drawComicSymbol } from '../core/comic-symbols.js';
import { BRAND_CONFIG } from '../core/config.js';

const STAR_ID = 'legacy-star';
let advance = () => {};

// The burst may still use the complete approved catalogue. The small star
// disappears only from the wordmark, where it is too slight to read.
export const BRAND_SYMBOL_INDICES = Object.freeze(COMIC_SYMBOLS
  .map((symbol, index) => symbol.id === STAR_ID ? null : index)
  .filter(Number.isInteger));

const clampChoice = (value, count) => Math.min(count - 1, Math.max(0, Math.floor(value * count)));

export function chooseBrandAccent(previous = -1, random = Math.random) {
  const previousPosition = BRAND_SYMBOL_INDICES.indexOf(previous);
  const count = BRAND_SYMBOL_INDICES.length - (previousPosition >= 0 ? 1 : 0);
  const choice = clampChoice(random(), count);
  return BRAND_SYMBOL_INDICES[previousPosition >= 0 && choice >= previousPosition ? choice + 1 : choice];
}

export function advanceBrandAccent() {
  advance();
}

export function drawBrandAccent(canvas, kind, dark, dpr = globalThis.devicePixelRatio || 1) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const ratio = Math.min(BRAND_CONFIG.maxDevicePixelRatio, Math.max(1, dpr));
  canvas.width = Math.round(BRAND_CONFIG.canvasSize * ratio);
  canvas.height = Math.round(BRAND_CONFIG.canvasSize * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.translate(BRAND_CONFIG.canvasSize / 2, BRAND_CONFIG.canvasSize / 2);
  ctx.scale(BRAND_CONFIG.glyphScale, BRAND_CONFIG.glyphScale);
  drawComicSymbol(ctx, kind, dark);
}

function initializeBrandAccent() {
  const canvas = document.querySelector('#brand-accent');
  if (!canvas) return;
  let previous = -1;
  try {
    const saved = sessionStorage.getItem('bubble.brandAccent');
    if (saved !== null) previous = Number(saved);
  } catch { /* Storage can be unavailable without affecting the logo. */ }
  let kind = chooseBrandAccent(previous);
  const persist = () => {
    try { sessionStorage.setItem('bubble.brandAccent', String(kind)); } catch { /* Keep the current accent. */ }
  };
  persist();
  const render = () => drawBrandAccent(canvas, kind, document.documentElement.dataset.theme !== 'light');
  render();
  advance = () => {
    kind = chooseBrandAccent(kind);
    persist();
    render();
  };
  new MutationObserver(render).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

// This module is preloaded independently of WebGL, audio and physics so the
// wordmark is ready as soon as parsing completes, even on a cold first visit.
if (typeof document !== 'undefined') initializeBrandAccent();
