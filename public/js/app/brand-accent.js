import { COMIC_SYMBOLS, drawComicSymbol } from '../core/comic-symbols.js';

const BRAND_SIZE = 32;
const STAR_ID = 'legacy-star';

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

export function drawBrandAccent(canvas, kind, dark, dpr = globalThis.devicePixelRatio || 1) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const ratio = Math.min(3, Math.max(1, dpr));
  canvas.width = Math.round(BRAND_SIZE * ratio);
  canvas.height = Math.round(BRAND_SIZE * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.translate(BRAND_SIZE / 2, BRAND_SIZE / 2);
  ctx.scale(0.86, 0.86);
  // A glyph's native +Y is its lower side. Rotate it left so that side faces
  // the wordmark instead of hanging below it.
  ctx.rotate(Math.PI / 2);
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
  const kind = chooseBrandAccent(previous);
  try { sessionStorage.setItem('bubble.brandAccent', String(kind)); } catch { /* Keep the current accent. */ }
  const render = () => drawBrandAccent(canvas, kind, document.documentElement.dataset.theme !== 'light');
  render();
  new MutationObserver(render).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

// This module is preloaded independently of WebGL, audio and physics so the
// wordmark is ready as soon as parsing completes, even on a cold first visit.
if (typeof document !== 'undefined') initializeBrandAccent();
