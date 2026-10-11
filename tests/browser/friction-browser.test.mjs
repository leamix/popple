import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'artifacts');
const baseURL = process.env.BUBBLE_URL || 'http://127.0.0.1:4174';
const checkFilter = process.argv.find(arg => arg.startsWith('--check='))?.slice('--check='.length);
await mkdir(output, { recursive: true });

// Reuse packages and browser binaries already present; never install anything.
const available = [];
async function candidate(packagePath) {
  const ownRegistry = path.join(packagePath, 'browsers.json');
  const registry = existsSync(ownRegistry) ? ownRegistry : path.join(packagePath, '../playwright-core/browsers.json');
  if (!existsSync(registry)) return;
  const { version } = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
  const { browsers } = JSON.parse(await readFile(registry, 'utf8'));
  available.push({ path: packagePath, version,
    chromiumRevision: browsers.find(item => item.name === 'chromium').revision,
    webkitRevision: browsers.find(item => item.name === 'webkit').revision });
}
const npmCache = path.join(homedir(), '.npm/_npx');
if (existsSync(npmCache)) for (const directory of await readdir(npmCache)) {
  const packagePath = path.join(npmCache, directory, 'node_modules/playwright');
  if (existsSync(path.join(packagePath, 'package.json'))) await candidate(packagePath);
}
const browserCache = path.join(homedir(), 'Library/Caches/ms-playwright');
const links = path.join(browserCache, '.links');
if (existsSync(links)) for (const link of await readdir(links)) {
  const packagePath = (await readFile(path.join(links, link), 'utf8')).trim();
  if (existsSync(path.join(packagePath, 'package.json'))) await candidate(packagePath);
}
available.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
const chromiumPackage = process.env.PLAYWRIGHT_MODULE || available.find(item =>
  existsSync(path.join(browserCache, `chromium_headless_shell-${item.chromiumRevision}`)))?.path;
if (!chromiumPackage) throw new Error('Matching installed Playwright and Chromium are required. Nothing was installed.');
const { chromium } = await import(pathToFileURL(path.join(chromiumPackage, 'index.mjs')));
const browser = await chromium.launch({ headless: true });
const report = { generatedAt: new Date().toISOString(), url: baseURL, browsers: { chromium: browser.version() }, checks: [], errors: [], limitations: [
  'Audio was measured from a running browser AudioContext and an offline waveform, not assessed by human listening.',
  'Touch uses Chromium device emulation; physical iOS/Android speakers, headphones and latency have not been validated.',
] };
const appSource = await readFile(path.join(root, 'app.js'), 'utf8');
const appInstrumented = appSource.replace('const audio=new PopAudio();', 'const audio=new PopAudio(); globalThis.__rubAudio=audio;');
assert.notEqual(appSource, appInstrumented, 'App instrumentation must match.');
const physicsSource = await readFile(path.join(root, 'physics.js'), 'utf8');
const physicsInstrumented = physicsSource.replace('this.reset();', 'this.reset(); (globalThis.__bubbleStates ??= []).push(this);');
assert.notEqual(physicsSource, physicsInstrumented, 'Physics instrumentation must match.');
const contexts = [];

async function context(options = {}, targetBrowser = browser) {
  const { hold = 2, ...browserOptions } = options;
  const ctx = await targetBrowser.newContext({ viewport: { width: 900, height: 900 }, ...browserOptions });
  contexts.push(ctx);
  await ctx.addInitScript(({ hold }) => {
    localStorage.setItem('bubble.hold', String(hold));
    localStorage.setItem('bubble.sound', 'true');
    localStorage.setItem('bubble.tilt', 'false');
  }, { hold });
  await ctx.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: appInstrumented }));
  await ctx.route('**/physics.js', route => route.fulfill({ contentType: 'text/javascript', body: physicsInstrumented }));
  const page = await ctx.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(baseURL);
  await page.waitForFunction(() => globalThis.__bubbleStates?.length === 14 && globalThis.__rubAudio?.rubbing);
  return { ctx, page };
}
async function check(name, action) {
  if (checkFilter && !name.includes(checkFilter)) return;
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', ...(details === undefined ? {} : { details }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', message: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
async function center(page, index = 4) {
  const bounds = await page.locator('.bubble-target').nth(index).boundingBox();
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
const state = page => page.evaluate(() => ({
  context: __rubAudio.context?.state ?? null,
  contacts: __rubAudio.rubbing.contacts.size,
  voices: __rubAudio.rubbing.voices.size,
  materials: [...__rubAudio.rubbing.contacts.values()].map(contact => contact.material),
  voiceMaterials: [...__rubAudio.rubbing.voices].map(voice => voice.material),
  popped: __bubbleStates.filter(bubble => bubble.popped).length,
}));
async function analyse(page) {
  await page.waitForFunction(() => __rubAudio.context?.state === 'running');
  await page.evaluate(() => {
    if (globalThis.__rubProbe) return;
    const analyser = __rubAudio.context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .2;
    // A passive tap, with no additional connection to destination or gain change.
    __rubAudio.output.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    globalThis.__rubProbe = { analyser, frames: [] };
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      analyser.getFloatFrequencyData(spectrum);
      let energy = 0, peak = 0;
      for (const sample of samples) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const binHz = __rubAudio.context.sampleRate / analyser.fftSize;
      const low = Math.ceil(600 / binHz), high = Math.floor(4200 / binHz);
      let bandEnergy = 0, strongestBand = 0;
      for (let i = low; i <= high; i++) {
        bandEnergy += 10 ** (spectrum[i] / 10);
        let localEnergy = 0;
        for (let j = Math.max(low, i - 2); j <= Math.min(high, i + 2); j++) localEnergy += 10 ** (spectrum[j] / 10);
        strongestBand = Math.max(strongestBand, localEnergy);
      }
      __rubProbe.frames.push({ rms: Math.sqrt(energy / samples.length), peak, time: __rubAudio.context.currentTime,
        spectralPeakShare: bandEnergy > 1e-12 ? strongestBand / bandEnergy : 0 });
      if (__rubProbe.frames.length > 5000) __rubProbe.frames.shift();
    }, 12);
  });
}
const clearProbe = page => page.evaluate(() => { if (globalThis.__rubProbe) __rubProbe.frames.length = 0; });
const measurement = page => page.evaluate(() => {
  const frames = globalThis.__rubProbe?.frames ?? [];
  return { frames: frames.length, maxRms: Math.max(0, ...frames.map(frame => frame.rms)),
    peak: Math.max(0, ...frames.map(frame => frame.peak)), lastRms: frames.at(-1)?.rms ?? 0,
    maxSpectralPeakShare: Math.max(0, ...frames.filter(frame => frame.rms > .0001).map(frame => frame.spectralPeakShare)) };
});
async function begin(page, index = 4) {
  const point = await center(page, index);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await analyse(page);
  return point;
}
async function stroke(page, point, count = 10) {
  for (let step = 0; step < count; step++) {
    const phase = step * .67;
    await page.mouse.move(point.x + Math.sin(phase) * 19, point.y + Math.cos(phase) * 9);
    await page.waitForTimeout(23);
  }
}
function assertAudible(stats, label) {
  assert.ok(stats.frames > 1, `${label}: no analyser frames`);
  assert.ok(stats.maxRms > .00002, `${label}: expected measurable sound, got RMS ${stats.maxRms}`);
  assert.ok(stats.maxRms < .075, `${label}: friction should stay quiet (RMS ${stats.maxRms})`);
  assert.ok(stats.peak < .38, `${label}: friction peak should remain bounded (${stats.peak})`);
}
async function settled(page, contacts = 0) {
  await page.waitForTimeout(390);
  const current = await state(page);
  assert.equal(current.voices, 0, 'Friction sources must stop after input ends or stops moving.');
  assert.equal(current.contacts, contacts);
  await clearProbe(page);
  await page.waitForTimeout(80);
  assert.ok((await measurement(page)).maxRms < 1e-7, 'No residual friction sound after settling.');
}
async function saveWave(filename, { base64, channels, sampleRate }) {
  const pcm = Buffer.from(base64, 'base64'), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  await writeFile(path.join(output, filename), Buffer.concat([header, pcm]));
}
async function ruptureScenario(initialMotion, targetBrowser = browser) {
  const { page: transition } = await context({ hold: .35 }, targetBrowser);
  await transition.evaluate(() => {
    const player = __rubAudio.rubbing, createVoice = player.createVoice;
    globalThis.__rubVoiceStarts = [];
    player.createVoice = function(contact) {
      __rubVoiceStarts.push({ material: contact.material, time: __rubAudio.context.currentTime });
      return createVoice.call(this, contact);
    };
  });
  const point = await begin(transition);
  if (initialMotion === 'moving') await stroke(transition, point, 16);
  await transition.waitForFunction(() => __bubbleStates[4].popped);
  // A held finger can report pressure changes and tiny position jitter after
  // the haptic pulse. It still belongs to the gesture which caused the pop.
  for (const [offset, pressure] of [[.35, .49], [-.35, .51], [.5, .5]]) {
    await transition.locator('.bubble-target').nth(4).dispatchEvent('pointermove', {
      pointerId: 1, pointerType: 'mouse', buttons: 1, pressure,
      clientX: point.x + offset, clientY: point.y,
    });
    await transition.waitForTimeout(18);
  }
  const earlyPoppedVoices = await transition.evaluate(() => __rubVoiceStarts.filter(voice => voice.material === 'popped').length);
  // Exclude the intentionally retained pop transient before asking the output
  // analyser to establish silence for further movement of the same pointer.
  await transition.waitForFunction(() => __rubAudio.sources.size === 0);
  await transition.waitForTimeout(390);
  await clearProbe(transition);
  await stroke(transition, point, 8);
  const sameGesture = await measurement(transition);
  const postPopVoices = await transition.evaluate(() => __rubVoiceStarts.filter(voice => voice.material === 'popped').length);
  await transition.mouse.up();
  await settled(transition);
  const nextPoint = await begin(transition);
  await clearProbe(transition);
  await stroke(transition, nextPoint, 8);
  const newGesture = await measurement(transition);
  assertAudible(newGesture, 'fresh press on collapsed film');
  assert.deepEqual([...new Set((await state(transition)).voiceMaterials)], ['popped']);
  assert.equal((await state(transition)).popped, 1);
  await transition.mouse.up();
  await settled(transition);
  assert.equal(earlyPoppedVoices, 0, `${initialMotion}: held post-pop pointer must not start collapsed-film voices, including pressure/position jitter`);
  assert.equal(postPopVoices, 0, `${initialMotion}: further movement needs release and a fresh press before rustling`);
  assert.ok(sameGesture.maxRms < 1e-7, `${initialMotion}: same post-pop gesture should be silent after the pop tail, RMS ${sameGesture.maxRms}`);
  return { initialMotion, earlyPoppedVoices, postPopVoices, sameGesture, newGesture };
}

try {
  const { page } = await context();
  await check('hover, stationary press and keyboard create no rubbing sound', async () => {
    const point = await center(page);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(100);
    assert.equal((await state(page)).contacts, 0);
    assert.equal((await state(page)).voices, 0);
    await page.locator('.bubble-target').nth(4).focus();
    await page.keyboard.down('Space');
    await analyse(page);
    await page.waitForTimeout(100);
    assert.equal((await state(page)).voices, 0);
    assert.equal((await state(page)).contacts, 0);
    await page.keyboard.up('Space');
    await begin(page);
    await clearProbe(page);
    await page.waitForTimeout(130);
    assert.equal((await state(page)).voices, 0);
    assert.equal((await measurement(page)).maxRms, 0);
    await page.mouse.up();
  });
  await check('real intact drag emits low-level audio, stationary contact returns to silence', async () => {
    const point = await begin(page);
    await clearProbe(page);
    await stroke(page, point);
    const stats = await measurement(page);
    assertAudible(stats, 'intact');
    assert.ok((await state(page)).voices > 0);
    assert.equal((await state(page)).popped, 0);
    assert.deepEqual((await state(page)).materials, ['intact']);
    await settled(page, 1);
    await page.mouse.up();
    await settled(page);
    return stats;
  });
  await check('subpixel drift after a stationary pause stays silent, then deliberate motion sounds', async () => {
    const point = await begin(page);
    await clearProbe(page);
    await page.waitForTimeout(450);
    // Slightly above the travel deadband, but far below the speed threshold:
    // measuring only a capped frame delta would incorrectly amplify this drift.
    await page.locator('.bubble-target').nth(4).dispatchEvent('pointermove', {
      pointerId: 1, pointerType: 'mouse', buttons: 1, pressure: .5,
      clientX: point.x + .29, clientY: point.y,
    });
    await page.waitForTimeout(65);
    assert.equal((await state(page)).voices, 0);
    assert.equal((await state(page)).contacts, 1);
    assert.ok((await measurement(page)).maxRms < 1e-7);
    await clearProbe(page);
    await stroke(page, point);
    const stats = await measurement(page);
    assertAudible(stats, 'deliberate movement after drift');
    await page.mouse.up();
    await settled(page);
    return stats;
  });
  for (const initialMotion of ['stationary', 'moving']) {
    await check(`rupture ends ${initialMotion} pointer sound until a fresh press`, () => ruptureScenario(initialMotion));
  }
  await check('default-hold short strokes begin at creak cues and generate a live unnormalized preview', async () => {
    const { page: short } = await context({ hold: .78 });
    await begin(short, 8);
    await short.waitForFunction(() => __bubbleStates[8].popped);
    await short.mouse.up();
    await settled(short);
    // Test-only PCM tap of the generated output. Its output remains zero and is
    // routed through an additional zero gain, so this never doubles playback.
    await short.evaluate(() => {
      const ctx = __rubAudio.context, processor = ctx.createScriptProcessor(1024, 2, 2), silent = ctx.createGain();
      silent.gain.value = 0;
      const capture = { processor, silent, chunks: [], firstTime: null, sampleRate: ctx.sampleRate };
      processor.onaudioprocess = event => {
        const left = event.inputBuffer.getChannelData(0), right = event.inputBuffer.getChannelData(1);
        if (capture.firstTime === null) capture.firstTime = event.playbackTime - event.inputBuffer.duration;
        capture.chunks.push([Float32Array.from(left), Float32Array.from(right)]);
      };
      __rubAudio.output.connect(processor); processor.connect(silent); silent.connect(ctx.destination);
      globalThis.__rubCapture = capture;
    });
    await short.waitForTimeout(250);
    const strokes = [];
    for (const [material, index] of [['intact', 1], ['intact', 2], ['intact', 3], ['popped', 8], ['popped', 8], ['popped', 8]]) {
      const point = await begin(short, index);
      await clearProbe(short);
      const start = await short.evaluate(() => __rubAudio.context.currentTime);
      await stroke(short, point, 3);
      const source = await short.evaluate(index => {
        const rubbing = __rubAudio.rubbing, contact = rubbing.contacts.get(index), voice = contact?.voice;
        return { bufferStart: voice?.bufferStart, cueStart: voice?.cueStart,
          entryPoints: rubbing.entryPoints.get(`${__rubAudio.context.sampleRate}:${contact?.material}`),
          material: contact?.material };
      }, index);
      const end = await short.evaluate(() => __rubAudio.context.currentTime);
      await short.mouse.up();
      const stats = await measurement(short);
      assertAudible(stats, `${material} short stroke`);
      assert.ok(end - start < .3, `Expected a 100–300ms stroke, got ${end - start}s`);
      assert.equal(source.material, material);
      if (material === 'intact') {
        assert.ok(source.entryPoints?.some(cue => Math.abs(cue - source.cueStart) < 1e-9), 'Intact short stroke must start from an authored creak cue.');
        assert.ok(Math.abs(source.bufferStart - Math.max(0, source.cueStart - .020)) < 1e-9, 'Creak onset must have a 20ms lead.');
      } else assert.equal(source.cueStart, null);
      assert.equal((await state(short)).popped, 1, 'Short strokes must not pop any intact pocket or pop a collapsed pocket again.');
      strokes.push({ material, index, start, end, ...source, ...stats });
      await short.waitForTimeout(480);
    }
    await short.waitForTimeout(220);
    const capture = await short.evaluate(() => {
      const capture = __rubCapture;
      __rubAudio.output.disconnect(capture.processor); capture.processor.disconnect(); capture.silent.disconnect();
      capture.processor.onaudioprocess = null;
      const count = capture.chunks.reduce((sum, chunk) => sum + chunk[0].length, 0);
      const pcm = new Int16Array(count * 2);
      let offset = 0, peak = 0, energy = 0;
      for (const channels of capture.chunks) for (let i = 0; i < channels[0].length; i++) {
        for (let channel = 0; channel < 2; channel++) {
          const value = channels[channel][i];
          peak = Math.max(peak, Math.abs(value)); energy += value * value;
          pcm[offset++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
        }
      }
      let binary = ''; const bytes = new Uint8Array(pcm.buffer);
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { base64: btoa(binary), sampleRate: capture.sampleRate, channels: 2, seconds: count / capture.sampleRate,
        firstTime: capture.firstTime, peak, rms: Math.sqrt(energy / pcm.length), normalization: false };
    });
    assert.ok(capture.peak > .001 && capture.peak < .95);
    await saveWave('friction-short-strokes.wav', capture);
    const { base64, firstTime, ...metadata } = capture;
    metadata.strokes = strokes.map(stroke => ({ ...stroke, start: stroke.start - firstTime, end: stroke.end - firstTime }));
    metadata.description = 'Live Chromium generated-output recording: three short strokes over intact pockets, then three over the same collapsed pocket, with the default 0.78-second hold. Original playback levels retained.';
    metadata.limitations = 'Recorded through a test-only ScriptProcessor tap; event timestamps approximate buffer positions. No microphone or external media. Waveform/spectral measurements do not establish human perception or physical-device latency.';
    await writeFile(path.join(output, 'friction-short-strokes.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
  });
  await check('release, pointer lifecycle, visibility, resize, pagehide, reset, blur and mute clean up audible sources', async () => {
    const details = [];
    for (const kind of ['release', 'cancel', 'lost-capture', 'outside', 'hidden', 'resize', 'pagehide', 'reset', 'blur', 'mute']) {
      const point = await begin(page);
      await clearProbe(page);
      await stroke(page, point, 4);
      assertAudible(await measurement(page), kind);
      if (kind === 'release') await page.mouse.up();
      if (kind === 'cancel') await page.locator('.bubble-target').nth(4).dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
      if (kind === 'lost-capture') await page.locator('.bubble-target').nth(4).dispatchEvent('lostpointercapture', { pointerId: 1, pointerType: 'mouse' });
      if (kind === 'outside') await page.mouse.move(point.x + 100, point.y);
      if (kind === 'hidden') await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      if (kind === 'resize') await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      if (kind === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      if (kind === 'reset') await page.locator('#reset').evaluate(button => button.click());
      if (kind === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (kind === 'mute') await page.locator('#sound').evaluate(button => button.click());
      await settled(page);
      await page.mouse.up();
      details.push(kind);
      if (kind === 'hidden') await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      if (kind === 'mute') await page.locator('#sound').click();
      await page.locator('#reset').click();
    }
    return details;
  });
  await check('two real touch contacts rub independently and cancel together', async () => {
    const { ctx, page: mobile } = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const cdp = await ctx.newCDPSession(mobile);
    const a = await center(mobile, 4), b = await center(mobile, 5);
    const points = (offsetA = 0, offsetB = 0) => [
      { x: a.x + offsetA, y: a.y, id: 1, radiusX: 7, radiusY: 7, force: .5 },
      { x: b.x + offsetB, y: b.y, id: 2, radiusX: 7, radiusY: 7, force: .5 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points() });
    await analyse(mobile);
    for (let step = 0; step < 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(Math.sin(step) * 15, -Math.sin(step) * 15) });
      await mobile.waitForTimeout(30);
    }
    assert.equal((await state(mobile)).contacts, 2);
    assert.ok((await state(mobile)).voices >= 2);
    assertAudible(await measurement(mobile), 'multitouch');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [points()[1]] });
    assert.equal((await state(mobile)).contacts, 1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await settled(mobile);
  });
  await check('reduced motion preserves tactile audio', async () => {
    const { page: reduced } = await context({ reducedMotion: 'reduce' });
    const point = await begin(reduced);
    await clearProbe(reduced);
    await stroke(reduced, point);
    const stats = await measurement(reduced);
    assertAudible(stats, 'reduced motion');
    assert.equal(await reduced.locator('html').getAttribute('data-reduced'), 'true');
    await reduced.mouse.up();
    await settled(reduced);
    return stats;
  });

  await check('offline audio preview renders intact and popped gestures without clipping', async () => {
    const preview = await page.evaluate(async () => {
      const { synthesizeFriction } = await import('./friction.js');
      const sampleRate = 48000, seconds = 8;
      const ctx = new OfflineAudioContext(2, sampleRate * seconds, sampleRate);
      const segments = [{ material: 'intact', start: .45, end: 3.45, seed: 841 }, { material: 'popped', start: 4.25, end: 7.25, seed: 1919 }];
      for (const { material, start, end, seed } of segments) {
        const texture = synthesizeFriction(sampleRate, seed, material);
        const buffer = ctx.createBuffer(1, texture.samples.length, sampleRate);
        buffer.getChannelData(0).set(texture.samples);
        const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
        const gain = ctx.createGain(); gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        source.connect(gain); gain.connect(pan); pan.connect(ctx.destination);
        gain.gain.setValueAtTime(0, start);
        for (let i = 0; i < 4; i++) {
          const at = start + i * .71;
          gain.gain.linearRampToValueAtTime(.11 + i * .035, at + .11);
          gain.gain.linearRampToValueAtTime(.065, at + .43);
          gain.gain.linearRampToValueAtTime(.018, at + .59);
        }
        gain.gain.linearRampToValueAtTime(0, end);
        pan.pan.setValueAtTime(-.17, start);
        pan.pan.linearRampToValueAtTime(.17, end);
        source.start(start); source.stop(end + .04);
      }
      const rendered = await ctx.startRendering();
      const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
      let peak = 0, energy = 0, finite = true;
      const pcm = new Int16Array(left.length * 2);
      for (let i = 0; i < left.length; i++) for (let channel = 0; channel < 2; channel++) {
        const value = channel ? right[i] : left[i];
        finite &&= Number.isFinite(value); peak = Math.max(peak, Math.abs(value)); energy += value * value;
        pcm[i * 2 + channel] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { base64: btoa(binary), sampleRate, channels: 2, seconds, segments, peak, rms: Math.sqrt(energy / pcm.length), finite };
    });
    assert.equal(preview.finite, true);
    assert.ok(preview.peak < .38 && preview.peak > .0001);
    await saveWave('friction-preview.wav', preview);
    const { base64, ...metadata } = preview;
    metadata.description = 'Representative synthesis preview: intact taut film at 0.45–3.45 s, collapsed rough film at 4.25–7.25 s. Four gentle strokes per material with a small stereo sweep.';
    metadata.limitations = 'Offline texture and gain-envelope demonstration; does not record live pointer latency, include pop transients, or establish perceived realism. No human listening claim.';
    await writeFile(path.join(output, 'friction-preview.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
  });

  const webkitPackage = process.env.WEBKIT_MODULE || available.find(item => existsSync(path.join(browserCache, `webkit-${item.webkitRevision}`)))?.path;
  if (webkitPackage) {
    let webkitBrowser;
    await check('WebKit real drag emits audio and stops after release', async () => {
      const modulePath = webkitPackage.endsWith('.mjs') ? webkitPackage : path.join(webkitPackage, 'index.mjs');
      const { webkit } = await import(pathToFileURL(modulePath));
      webkitBrowser = await webkit.launch({ headless: true });
      report.browsers.webkit = webkitBrowser.version();
      const { page: safari } = await context({}, webkitBrowser);
      const point = await begin(safari);
      await clearProbe(safari);
      await stroke(safari, point);
      const stats = await measurement(safari);
      assertAudible(stats, 'WebKit');
      await safari.mouse.up();
      await settled(safari);
      const rupture = [];
      for (const initialMotion of ['stationary', 'moving']) rupture.push(await ruptureScenario(initialMotion, webkitBrowser));
      return { ...stats, rupture };
    });
    if (webkitBrowser) await webkitBrowser.close();
  } else report.limitations.push('No installed matching WebKit package was found; WebKit was skipped.');
  await check('no application runtime or console errors', async () => assert.deepEqual(report.errors, []));
} finally {
  await Promise.allSettled(contexts.map(ctx => ctx.close()));
  await browser.close();
  report.summary = { passed: report.checks.filter(check => check.status === 'passed').length, failed: report.checks.filter(check => check.status === 'failed').length };
  await writeFile(path.join(output, checkFilter ? 'friction-browser-filtered-report.json' : 'friction-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report.summary));
if (report.summary.failed) process.exitCode = 1;
