// Hand-drawn emotion clusters inspired by the manga doodle reference. The same
// catalogue gives the wordmark and each pop a shared visual vocabulary.
// Coordinates fit a 32 × 32 square centred at the origin.
const line = d => ({ d, filled: false });
const shape = d => ({ d, filled: true });

export const COMIC_SYMBOLS = Object.freeze([
  { id: 'sparkle-trio', paths: [
    shape('M-2-8 Q0-2 5 0 Q0 2-2 8 Q-4 2-9 0 Q-4-2-2-8Z M8-13 Q9-8 13-6 Q9-5 8 0 Q7-5 3-6 Q7-8 8-13Z M7 4 Q8 8 12 9 Q8 10 7 14 Q6 10 2 9 Q6 8 7 4Z'),
  ] },
  { id: 'triple-exclamation', paths: [
    shape('M-13-8 L-7-10 L-5 2 L-8 7 L-11 3Z M-3-13 L4-14 L3 2 L0 7 L-2 2Z M7-10 L14-8 L10 4 L5 8 L5 3Z'),
    shape('M-8 10 L-5 9 L-4 12 L-7 13Z M-1 10 L2 10 L2 13 L-1 13Z M5 11 L8 10 L9 13 L6 14Z'),
  ] },
  { id: 'question-pair', paths: [
    line('M-12-6 C-12-14 0-15 0-7 C0-2-6-3-5 3 M5-9 C10-14 17-7 12-3 C9-1 6 0 7 5'),
    shape('M-7 8 C-7 5-3 5-3 8 C-3 11-7 11-7 8Z M5 10 C5 7 9 7 9 10 C9 13 5 13 5 10Z'),
    line('M-13 1 L-14 4 M12 6 L14 8'),
  ] },
  { id: 'anger', paths: [
    line('M-12-3 Q-3-3-3-12 M3-12 Q3-3 12-3 M12 3 Q3 3 3 12 M-3 12 Q-3 3-12 3'),
    line('M-14-10 L-12-12 M11 11 L13 13'),
  ] },
  { id: 'sweat-drops', paths: [
    shape('M-5-13 C-6-6-12-3-12 3 C-12 11-2 11-2 4 C-2-2-4-5-5-13Z M6-10 C5-5 1-2 1 2 C1 8 9 8 9 2 C9-2 7-5 6-10Z M11 5 C10 8 8 9 8 11 C8 15 14 15 14 11 C14 9 12 8 11 5Z'),
  ] },
  { id: 'puff', paths: [
    line('M-10-3 C-16-5-11-12-5-9 C-6-16 4-15 4-9 C11-14 16-5 10-2 C17 0 13 9 7 7 C8 14-1 16-3 9 C-10 14-15 6-10 2'),
    line('M-14-10 L-12-13 M12-11 L14-13 M-10 12 L-12 14 M13 9 L15 10'),
  ] },
  { id: 'surprise-fan', paths: [
    line('M-12 7 L-14-2 M-8 6 L-11-10 M-3 5 L-5-14 M2 5 L2-5 M2-9 L2-13 M6 6 L9-13 M10 8 L14-5'),
    shape('M-4 9 L-2 9 L-2 12 L-4 12Z M2 10 L4 10 L4 14 L2 14Z M8 11 L10 11 L9 14 L7 14Z'),
  ] },
  { id: 'speed-marks', paths: [
    line('M-13-5 L0 8 M-9-13 L13 9 M0-14 L14 0 M-14 4 L-5 13'),
  ] },
  { id: 'tension-waves', paths: [
    line('M-9-12 C-16-6-5-3-9 3 C-12 6-8 9-8 13 M1-14 C8-8-5-5 0 1 C5 6-2 8 0 13 M11-10 C8-5 15-3 10 3 C6 8 13 10 11 14'),
    line('M-2-11 L0-11 M8-14 L10-14'),
  ] },
  { id: 'bubble-trail', paths: [
    line('M-1-8 C-1-16 12-16 12-8 C12 0-1 0-1-8Z M-12 6 C-12-1-2-1-2 6 C-2 13-12 13-12 6Z M5 9 C5 4 13 4 13 9 C13 14 5 14 5 9Z'),
    shape('M-11-7 C-11-10-8-10-8-7 C-8-4-11-4-11-7Z M0 2 C0 0 2 0 2 2 C2 4 0 4 0 2Z'),
  ] },
  { id: 'impact-crown', paths: [
    line('M-11 9 Q-7 1-13-3 Q-3-1-4-11 Q3-5 10-10 Q7-2 14 2 Q7 4 9 12'),
    line('M-14-8 L-12-7 M0-15 L1-13 M13-11 L14-12 M13 8 L15 9'),
  ] },
  { id: 'shiver', paths: [
    line('M-3-14 C6-11-9-8-1-5 C8-2-7 2 0 5 C8 8-4 11 1 14'),
    line('M-9-11 L-7-11 M7-7 L10-7 M-10 0 L-7 0 M8 5 L11 5 M-9 10 L-6 10'),
  ] },
  { id: 'moving-puff', paths: [
    line('M-12-8 C-12-14-4-14-4-9 C-1-16 8-12 6-6 C15-11 17-1 10 1 C15 7 6 13 3 6 C0 13-8 12-9 5'),
    line('M-14 2 L-7 9 M-12 8 L-6 14 M0 10 L5 15'),
  ] },
  { id: 'little-sparks', paths: [
    line('M-6-12 L-6-6 M-12-3 L-9-3 M-3-3 L2-3 M-6 0 L-6 6 M8 4 L8 8 M4 10 L6 10 M10 10 L14 10 M8 12 L8 15 M7-10 L11-6 M13-12 L14-13'),
  ] },
  { id: 'attention-arrows', paths: [
    line('M-13-6 L-5 8 L-11 6 M-5 8 L-4 2 M0-14 L0 6 L-4 1 M0 6 L4 1 M13-7 L6 8 L6 2 M6 8 L12 6'),
    line('M-1 11 L1 11 M-1 14 L1 14'),
  ] },
  { id: 'double-lightning', paths: [
    shape('M-3-14 L-12 0 L-5-1 L-8 12 L5-5 L-2-4Z M10-10 L4 2 L9 1 L6 13 L15-2 L10-1Z'),
    line('M-13 7 L-15 10 M12 9 L14 8'),
  ] },
]);

const compiled = new Map();

export function chooseComicSymbol(previous = -1, random = Math.random) {
  const validPrevious = Number.isInteger(previous) && previous >= 0 && previous < COMIC_SYMBOLS.length;
  const count = COMIC_SYMBOLS.length - (validPrevious ? 1 : 0);
  const choice = Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
  return validPrevious && choice >= previous ? choice + 1 : choice;
}

export function sampleComicSymbols(count, random = Math.random) {
  const pool = COMIC_SYMBOLS.map((_, index) => index);
  const selected = [];
  while (selected.length < count && pool.length) {
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}

export function drawComicSymbol(ctx, kind, dark) {
  const index = Number.isInteger(kind) && COMIC_SYMBOLS[kind] ? kind : 0;
  if (!compiled.has(index)) {
    compiled.set(index, COMIC_SYMBOLS[index].paths.map(path => ({
      filled: path.filled, path: new Path2D(path.d),
    })));
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const part of compiled.get(index)) {
    if (part.filled) {
      ctx.fillStyle = dark ? '#f4df9b' : '#f6cd64';
      ctx.strokeStyle = dark ? '#151b20' : '#293c4a';
      ctx.lineWidth = 1.05;
      ctx.fill(part.path);
    } else {
      ctx.strokeStyle = dark ? '#f5e8c0' : '#3f515e';
      ctx.lineWidth = 1.85;
    }
    ctx.stroke(part.path);
  }
}
