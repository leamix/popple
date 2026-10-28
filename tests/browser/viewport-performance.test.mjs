import assert from 'node:assert/strict';
import { listRuntimeAt, readRuntimeAt } from './git-runtime.mjs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Full production app, with test-only source wrappers. No runtime files or
// packages are installed/modified. Run before/after sequentially on an idle host:
// node tests/browser/viewport-performance.test.mjs --phase=before --ref=fae604f
// node tests/browser/viewport-performance.test.mjs --phase=after
// Optional: --profiles=desktop,mobile,mobile-cpu4,large-desktop --browser=chrome-metal
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseURL = process.env.POPPLE_URL || 'http://127.0.0.1:4174';
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const phase = argument('phase') || 'after';
const baselinePhase = argument('baseline') || 'before';
const compareBaseline = !!argument('baseline') || phase === 'after';
const ref = argument('ref');
const browserFlavor = argument('browser') || 'chrome-metal';
assert.ok(/^[a-zA-Z0-9_-]+$/.test(phase));
assert.ok(/^[a-zA-Z0-9_-]+$/.test(baselinePhase));
assert.ok(['chrome-metal', 'headless-shell'].includes(browserFlavor));
const requestedProfiles = argument('profiles')?.split(',');
const profiles = [
  { name: 'desktop', width: 1365, height: 900, dpr: 1, cpuRate: 1 },
  { name: 'mobile', width: 390, height: 844, dpr: 2.5, cpuRate: 1, touch: true },
  { name: 'mobile-cpu4', width: 390, height: 844, dpr: 2.5, cpuRate: 4, touch: true },
  { name: 'large-desktop', width: 1920, height: 1080, dpr: 1, cpuRate: 1 },
].filter(profile => !requestedProfiles || requestedProfiles.includes(profile.name));
assert.ok(profiles.length);
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });

// Freeze EVERY public file at invocation, including HTML/CSS/audio helpers.
// --ref is entirely independent of later edits to the production working tree.
async function runtimeFiles(folder = 'public') {
  const entries = await readdir(path.join(root, folder), { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => entry.isDirectory()
    ? runtimeFiles(`${folder}/${entry.name}`) : [`${folder}/${entry.name}`]));
  return groups.flat().sort();
}
const names = ref
  ? listRuntimeAt(root, ref)
  : await runtimeFiles();
const sources = new Map();
for (const name of names) sources.set('/' + name.slice(7), ref
  ? readRuntimeAt(root, ref, name)
  : await readFile(path.join(root, name)));
const sourceHashes = Object.fromEntries([...sources].map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')]));

async function installedPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  const available = [];
  const cache = path.join(homedir(), '.npm/_npx');
  if (existsSync(cache)) for (const folder of await readdir(cache)) {
    const packagePath = path.join(cache, folder, 'node_modules/playwright');
    if (!existsSync(path.join(packagePath, 'package.json'))) continue;
    const pkg = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
    const revisions = JSON.parse(await readFile(path.join(packagePath, '../playwright-core/browsers.json'), 'utf8')).browsers;
    available.push({ path: packagePath, version: pkg.version, revision: revisions.find(item => item.name === 'chromium').revision });
  }
  const links = path.join(homedir(), 'Library/Caches/ms-playwright/.links');
  if (existsSync(links)) for (const link of await readdir(links)) {
    const packagePath = (await readFile(path.join(links, link), 'utf8')).trim();
    if (!existsSync(path.join(packagePath, 'browsers.json'))) continue;
    const pkg = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
    const revisions = JSON.parse(await readFile(path.join(packagePath, 'browsers.json'), 'utf8')).browsers;
    available.push({ path: packagePath, version: pkg.version, revision: revisions.find(item => item.name === 'chromium').revision });
  }
  available.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const found = available.find(item => existsSync(path.join(homedir(), 'Library/Caches/ms-playwright', `chromium_headless_shell-${item.revision}`)));
  if (!found) throw new Error('Installed Playwright and a matching Chromium browser are required. Nothing was installed.');
  return found.path;
}

function instrumentedApp(source) {
  assert.ok(source.includes('function resize() {'), 'App resize instrumentation anchor exists');
  return source.replace('function resize() {', `function resize() {
  const started=performance.now(); const previous=layout;
  try { return __viewportResize(); }
  finally { globalThis.__viewportPerf.resize(performance.now()-started,previous!==layout,bubbles.length,bubbleCells.size); }
}
function __viewportResize() {`) + `
globalThis.__viewportScene=()=>({
  count:bubbles.length,cachedCount:bubbleCells.size,popped:bubbles.filter(b=>b.popped).length,
  refilling:bubbles.filter(b=>b.refilling).length,active:bubbles.filter(b=>b.active).length,
  unsettled:bubbles.filter(b=>b.needsAnimation).length,
  framePending:!!frame,renderDirty,diameter,layout:layout.map(p=>({...p})),
  filmAnimating:!!renderer.sheetState.needsAnimation,
  filmOffset:Math.max(0,...Array.from({length:layout.length},(_,i)=>Math.hypot(renderer.sheetState.deformation[i*4],renderer.sheetState.deformation[i*4+1]))),
  canvas:{width:renderer.canvas.width,height:renderer.canvas.height},
  bounds:playground.getBoundingClientRect().toJSON(),
});
`;
}

function instrumentedRenderer(source) {
  assert.ok(source.includes('render(bubbles,layout,dark,time,light)'), 'Renderer instrumentation anchor exists');
  return source + `
const __viewportOriginalRender=FilmRenderer.prototype.render;
FilmRenderer.prototype.render=function(...args){
  return globalThis.__viewportPerf.render(this,args,()=>__viewportOriginalRender.apply(this,args));
};
`;
}

function instrumentedEffects(source) {
  assert.ok(source.includes('class PopAudio'), 'Audio instrumentation anchor exists');
  return source + `
const __viewportOriginalUnlock=PopAudio.prototype.unlock;
PopAudio.prototype.unlock=function(...args){
  const cold=!this.context,started=performance.now();
  try{return __viewportOriginalUnlock.apply(this,args);}
  finally{globalThis.__viewportPerf.audioUnlock(performance.now()-started,cold,!!this.context);}
};
`;
}

// Runs before any page script. Timings deliberately avoid readback/gl.finish.
function installProbe() {
  const data = { phase: null, phases: {}, backend: null, pendingPointers: [], pendingQueries: [], longTasks: [], audioContexts: [], disjointGpuQueries: 0, frame: 0 };
  for (const key of ['AudioContext', 'webkitAudioContext']) if (globalThis[key]) {
    globalThis[key] = new Proxy(globalThis[key], { construct(target, args, newTarget) {
      const started = performance.now();
      try { return Reflect.construct(target, args, newTarget); }
      finally { data.audioContexts.push({ ms: performance.now() - started, at: started, phase: data.phase }); }
    } });
  }
  const createPhase = name => data.phases[name] = { frames: [], renders: [], resizes: [], pointers: [], gpu: [], audioUnlocks: [], longTasks: [], started: performance.now(), ended: null };
  const active = () => data.phases[data.phase];
  let previousFrame = null;
  function observeFrame(time) {
    data.frame++;
    if (active() && previousFrame !== null) active().frames.push(time - previousFrame);
    previousFrame = time;
    requestAnimationFrame(observeFrame);
  }
  requestAnimationFrame(observeFrame);
  try { new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (active()) active().longTasks.push(entry.duration);
  }).observe({ type: 'longtask', buffered: false }); } catch { /* Optional browser API. */ }
  addEventListener('pointerdown', event => {
    if (active() && event.target.closest('.playground')) data.pendingPointers.push({ phase: data.phase, at: performance.now(), pointerType: event.pointerType });
  }, { capture: true, passive: true });
  let gl, timer;
  function collectQueries() {
    if (!timer) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    if (disjoint) {
      data.disjointGpuQueries += data.pendingQueries.length;
      for (const entry of data.pendingQueries) timer.deleteQueryEXT(entry.query);
      data.pendingQueries = [];
      return;
    }
    data.pendingQueries = data.pendingQueries.filter(entry => {
      if (!timer.getQueryObjectEXT(entry.query, timer.QUERY_RESULT_AVAILABLE_EXT)) return true;
      if (!disjoint) data.phases[entry.phase].gpu.push(timer.getQueryObjectEXT(entry.query, timer.QUERY_RESULT_EXT) / 1e6);
      timer.deleteQueryEXT(entry.query);
      return false;
    });
  }
  globalThis.__viewportPerf = {
    start(name) { if (active()) active().ended = performance.now(); data.phase = name; previousFrame = null; createPhase(name); },
    end() { if (active()) active().ended = performance.now(); data.phase = null; previousFrame = null; },
    audioUnlock(ms, cold, contextCreated) { if (active()) active().audioUnlocks.push({ ms, cold, contextCreated }); },
    resize(ms, changed, count, cachedCount) { if (active()) active().resizes.push({ ms, changed, count, cachedCount }); },
    render(renderer, args, draw) {
      if (!gl) {
        gl = renderer.gl;
        timer = gl.getExtension('EXT_disjoint_timer_query');
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        data.backend = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
          unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
          timerAvailable: !!timer, actualDpr: devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency,
          userAgent: navigator.userAgent };
      }
      collectQueries();
      const current = active();
      if (!current) return draw();
      const query = timer ? timer.createQueryEXT() : null;
      if (query) timer.beginQueryEXT(timer.TIME_ELAPSED_EXT, query);
      const started = performance.now();
      try { return draw(); }
      finally {
        const ended = performance.now();
        if (query) { timer.endQueryEXT(timer.TIME_ELAPSED_EXT); data.pendingQueries.push({ query, phase: data.phase }); }
        const bubbles = args[0];
        current.renders.push({ ms: ended - started, count: bubbles.length, active: bubbles.filter(b => b.active).length,
          popped: bubbles.filter(b => b.popped).length, refilling: bubbles.filter(b => b.refilling).length,
          canvasPixels: renderer.canvas.width * renderer.canvas.height });
        data.pendingPointers = data.pendingPointers.filter(pointer => {
          if (pointer.phase === data.phase) { current.pointers.push({ ms: ended - pointer.at, pointerType: pointer.pointerType }); return false; }
          return true;
        });
      }
    },
    async results() { this.end(); for (let i = 0; i < 10 && data.pendingQueries.length; i++) { await new Promise(requestAnimationFrame); collectQueries(); }
      return { backend: data.backend, phases: data.phases, audioContexts: data.audioContexts, pendingGpuQueries: data.pendingQueries.length, disjointGpuQueries: data.disjointGpuQueries }; },
  };
}

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null; };
const stats = values => ({ samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null });
function summarizePhase(value) {
  const changedResizes = value.resizes.filter(entry => entry.changed);
  const resizeByBubbleCount = Object.fromEntries([...new Set(changedResizes.map(entry => entry.count))].sort((a, b) => a - b).map(count => {
    const entries = changedResizes.filter(entry => entry.count === count);
    return [count, { cpuMs: stats(entries.map(entry => entry.ms)), cachedCounts: [...new Set(entries.map(entry => entry.cachedCount))] }];
  }));
  return {
    wallMs: value.ended - value.started,
    cpuRenderMs: stats(value.renders.map(entry => entry.ms)),
    gpuMs: stats(value.gpu),
    resizeMs: stats(changedResizes.map(entry => entry.ms)),
    resizeCalls: value.resizes.length,
    changedResizes: changedResizes.length,
    resizeByBubbleCount,
    cachedCellCounts: [...new Set(changedResizes.map(entry => entry.cachedCount))],
    rafMs: stats(value.frames),
    longFrames: { over25ms: value.frames.filter(ms => ms > 25).length, over33ms: value.frames.filter(ms => ms > 33).length, over50ms: value.frames.filter(ms => ms > 50).length },
    pointerToRenderMs: stats(value.pointers.map(entry => entry.ms)),
    audioUnlockMs: stats(value.audioUnlocks.map(entry => entry.ms)),
    coldAudioUnlockMs: stats(value.audioUnlocks.filter(entry => entry.cold).map(entry => entry.ms)),
    longTasksMs: stats(value.longTasks),
    bubbleCounts: [...new Set(value.renders.map(entry => entry.count))],
    canvasPixelCounts: [...new Set(value.renders.map(entry => entry.canvasPixels))],
  };
}

const playwrightPath = await installedPlaywright();
const { chromium } = await import(pathToFileURL(path.join(playwrightPath, 'index.mjs')));
const browser = await chromium.launch(browserFlavor === 'chrome-metal'
  ? { headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal'] }
  : { headless: true });
const report = { phase, ref: ref || null, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  generatedAt: new Date().toISOString(), browserFlavor, browserVersion: browser.version(), sourceHashes, profiles: [], errors: [],
  limits: [
    'Full production HTML/CSS/module snapshot; actual animation, DOM targets, audio/bursts, pointer events and adaptive field. No simulation loop is replaced.',
    'Mobile viewport/DPR/touch and CDP CPU throttling are host emulation. These results do not establish physical phone FPS.',
    'CPU render is FilmRenderer.render submission wall time. Resize is the main app resize function, including layout, target reconciliation, renderer/burst canvas resize. First post-resize render is also present in CPU render samples.',
    'rAF is an independent continuous browser observer. Idle observer callbacks do not wake or render the app. Long frames include GPU/browser/host scheduling; these timings do not prove physical display presentation.',
    'Pointer-to-render measures trusted pointerdown delivery until the first subsequent app render returns. It excludes automation transport and physical display presentation.',
    'Test-only wrappers record synchronous PopAudio.unlock and native AudioContext construction durations. Rendering warms for 2.2 seconds before the first interaction. The baseline leaves audio cold until that contact; the final app prepares audio during startup/warmup and records that construction cost separately from gesture unlock.',
    'GPU values are valid asynchronous EXT_disjoint_timer_query samples only. No readPixels or gl.finish occurs inside or between measured phases. GPU timers are optional.',
    'Live viewport changes use sequential Playwright setViewportSize calls, approximately one per frame; protocol and browser scheduling affect cadence. Before/after use the identical path.',
    'Browser compilation/startup excluded by warmup. Samples remain serial; run on an otherwise idle host and compare tail latencies with care.',
  ] };
const jsonPath = path.join(output, `performance-viewport-${phase}.json`);
async function save() { await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n'); }

try {
  for (const profile of profiles) {
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr,
      isMobile: !!profile.touch, hasTouch: !!profile.touch, reducedMotion: 'no-preference' });
    try {
      await context.addInitScript(installProbe);
      await context.addInitScript(() => { for (const prefix of ['bubble.', 'popple.']) { localStorage.setItem(prefix + 'sound', 'true'); localStorage.setItem(prefix + 'tilt', 'false'); } });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseURL).origin) return route.abort();
        const name = url.pathname === '/' ? '/index.html' : url.pathname;
        let body = sources.get(name);
        if (!body) return route.abort();
        if (name === '/js/app/main.js') body = instrumentedApp(body.toString());
        if (name === '/js/rendering/renderer.js') body = instrumentedRenderer(body.toString());
        if (name === '/js/audio/effects.js') body = instrumentedEffects(body.toString());
        const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream';
        return route.fulfill({ contentType: type, body });
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ profile: profile.name, message: error.message }));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
      await page.goto(baseURL);
      await page.waitForFunction(() => globalThis.__viewportScene?.().count > 0, null, { timeout: 60000 });
      await page.waitForTimeout(2200);
      const initialScene = await page.evaluate(() => __viewportScene());
      console.log(`START ${profile.name}: bubbles=${initialScene.count} canvas=${initialScene.canvas.width}x${initialScene.canvas.height}`);
      await page.evaluate(() => __viewportPerf.start('idle'));
      await page.waitForTimeout(800);
      const idleScene = await page.evaluate(() => __viewportScene());
      const first = initialScene.layout[0];
      const second = initialScene.layout.find(p => p.row === first.row && p.column !== first.column);
      assert.ok(second, 'Film probe needs two pockets in one row');
      const gap = { x: initialScene.bounds.x + (first.x + second.x) / 2, y: initialScene.bounds.y + first.y };
      await page.evaluate(() => __viewportPerf.start('film-hold'));
      if (profile.touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...gap, id: 1, force: .5 }] });
      else { await page.mouse.move(gap.x, gap.y); await page.mouse.down(); }
      await page.waitForTimeout(1300);
      const heldFilmScene = await page.evaluate(() => __viewportScene());
      assert.equal(heldFilmScene.popped, 0, 'A film hold cannot pop adjacent air pockets');
      if (!ref) {
        assert.ok(heldFilmScene.filmOffset > .025, 'The film retains tension beyond the normal wake timeout');
        assert.equal(heldFilmScene.framePending, false, 'A stationary settled hold needs no continuous rendering');
      }
      await page.evaluate(() => __viewportPerf.start('film-drag-release'));
      for (let step = 0; step < 18; step++) {
        const point = { x: gap.x, y: gap.y + Math.sin(step * .55) * 5 };
        if (profile.touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1, force: .5 }] });
        else await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(20);
      }
      if (profile.touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else await page.mouse.up();
      await page.waitForTimeout(1100);
      const releasedFilmScene = await page.evaluate(() => __viewportScene());
      assert.equal(releasedFilmScene.popped, 0);
      assert.equal(releasedFilmScene.filmAnimating, false);
      await page.evaluate(() => __viewportPerf.start('popping'));
      const expectedPops = Math.min(8, initialScene.count);
      for (let i = 0; i < expectedPops; i++) {
        // Spread contacts across the full field, away from already popped cells.
        const index = Math.floor(i * initialScene.count / expectedPops);
        const target = await page.locator('.bubble-target').nth(index).boundingBox();
        assert.ok(target);
        const x = target.x + target.width / 2, y = target.y + target.height / 2;
        if (profile.touch) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, force: .5 }] });
          await page.waitForTimeout(370);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.waitForTimeout(370);
          await page.mouse.up();
        }
        await page.waitForTimeout(35);
      }
      await page.waitForTimeout(350);
      const poppedScene = await page.evaluate(() => __viewportScene());
      assert.equal(poppedScene.popped, expectedPops, `${profile.name}: all sustained held contacts pop`);
      await page.evaluate(() => __viewportPerf.start('refill'));
      await page.locator('#reset').click();
      await page.waitForFunction(() => __viewportScene().popped === 0 && __viewportScene().refilling === 0, null, { timeout: 10000 });
      await page.waitForTimeout(700);
      const refillScene = await page.evaluate(() => __viewportScene());
      await page.evaluate(() => __viewportPerf.start('resize'));
      const pathSteps = 20;
      const minimumWidth = profile.touch ? 320 : 640;
      const minimumHeight = profile.touch ? 620 : 600;
      for (let step = 1; step <= pathSteps * 2; step++) {
        const t = step <= pathSteps ? step / pathSteps : (pathSteps * 2 - step) / pathSteps;
        await page.setViewportSize({ width: Math.round(profile.width + (minimumWidth - profile.width) * t), height: Math.round(profile.height + (minimumHeight - profile.height) * t) });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(500);
      const finalScene = await page.evaluate(() => __viewportScene());
      assert.equal(finalScene.count, initialScene.count, 'Resize returns to original active field');
      await page.evaluate(() => __viewportPerf.start('settle'));
      await page.waitForTimeout(2200);
      const settledScene = await page.evaluate(() => __viewportScene());
      await page.evaluate(() => __viewportPerf.start('settled-idle'));
      await page.waitForTimeout(600);
      const raw = await page.evaluate(() => __viewportPerf.results());
      const result = { ...profile, backend: raw.backend, initialScene, idleScene, heldFilmScene, releasedFilmScene, poppedScene, refillScene, finalScene, settledScene,
        expectedPops, audioContexts: raw.audioContexts, disjointGpuQueries: raw.disjointGpuQueries, pendingGpuQueries: raw.pendingGpuQueries,
        phases: Object.fromEntries(Object.entries(raw.phases).map(([name, value]) => [name, summarizePhase(value)])), raw: raw.phases };
      assert.equal(settledScene.active, 0);
      assert.equal(settledScene.unsettled, 0, 'Released springs settle before the app stops');
      assert.equal(settledScene.refilling, 0);
      assert.equal(settledScene.framePending, false, 'App animation loop stops when settled');
      assert.equal(result.phases['settled-idle'].cpuRenderMs.samples, 0, 'Settled app submits no renders');
      assert.equal(await page.locator('#render-error').isVisible(), false);
      await page.screenshot({ path: path.join(output, `performance-viewport-${phase}-${profile.name}.png`) });
      report.profiles.push(result);
      await save();
      for (const [name, value] of Object.entries(result.phases)) console.log(`RESULT ${profile.name}/${name}: CPU p50/p95=${value.cpuRenderMs.p50?.toFixed(2)}/${value.cpuRenderMs.p95?.toFixed(2)} GPU=${value.gpuMs.p50?.toFixed(2)} resize=${value.resizeMs.p50?.toFixed(2)}/${value.resizeMs.p95?.toFixed(2)} rAF-p95=${value.rafMs.p95?.toFixed(2)} long>33ms=${value.longFrames.over33ms}/${value.rafMs.samples} coldAudio=${value.coldAudioUnlockMs.p50?.toFixed(2)}ms`);
    } finally { await context.close(); }
  }
} catch (error) {
  report.errors.push({ message: error.stack || error.message });
  throw error;
} finally {
  await browser.close();
  await save();
  let before;
  try { before = JSON.parse(await readFile(path.join(output, `performance-viewport-${baselinePhase}.json`), 'utf8')); } catch { /* First run. */ }
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const ms = value => value == null ? '—' : value.toFixed(2);
  const rows = report.profiles.flatMap(profile => Object.entries(profile.phases).map(([name, value]) => {
    const baseline = compareBaseline ? before?.profiles.find(item => item.name === profile.name)?.phases[name] : null;
    return `<tr><td>${esc(profile.name)}</td><td>${name}</td><td>${value.bubbleCounts.length ? `${Math.min(...value.bubbleCounts)}–${Math.max(...value.bubbleCounts)}` : profile.initialScene.count}</td><td>${ms(baseline?.cpuRenderMs.p50)} → ${ms(value.cpuRenderMs.p50)}</td><td>${ms(baseline?.cpuRenderMs.p95)} → ${ms(value.cpuRenderMs.p95)}</td><td>${ms(value.gpuMs.p50)} / ${ms(value.gpuMs.p95)}</td><td>${ms(baseline?.resizeMs.p50)} → ${ms(value.resizeMs.p50)}</td><td>${ms(baseline?.resizeMs.p95)} → ${ms(value.resizeMs.p95)}</td><td>${ms(baseline?.rafMs.p95)} → ${ms(value.rafMs.p95)}</td><td>${value.longFrames.over25ms} / ${value.longFrames.over33ms} / ${value.longFrames.over50ms} of ${value.rafMs.samples}</td><td>${ms(value.pointerToRenderMs.p50)} / ${ms(value.pointerToRenderMs.p95)}</td></tr>`;
  })).join('');
  const success = report.profiles.map(profile => {
    const baseline = compareBaseline ? before?.profiles.find(item => item.name === profile.name) : null;
    const pointerMaximum = `${baseline ? `${ms(baseline.phases.popping.pointerToRenderMs.max)} → ` : ''}${ms(profile.phases.popping.pointerToRenderMs.max)}`;
    const bubbleCount = baseline ? `${baseline.initialScene.count} → ${profile.initialScene.count} active bubbles (baseline → final)` : `${profile.initialScene.count} initial/final bubbles`;
    const audioUnlock = profile.phases.popping.coldAudioUnlockMs?.samples
      ? `cold ${ms(profile.phases.popping.coldAudioUnlockMs.p50)} ms`
      : `already prepared; synchronous unlock p95 ${ms(profile.phases.popping.audioUnlockMs?.p95)} ms`;
    return `<li>${esc(profile.name)}: ${bubbleCount}; ${profile.poppedScene.popped}/${profile.expectedPops} held contacts popped; refill completed; animation stopped; ${profile.phases['settled-idle'].cpuRenderMs.samples} settled idle renders. Resize callbacks: ${profile.phases.resize.resizeCalls}, including ${profile.phases.resize.changedResizes} geometry changes; cached-cell counts during resize: ${profile.phases.resize.cachedCellCounts.join(', ')}. ${esc(profile.backend.unmaskedRenderer || profile.backend.renderer)}; GPU timer ${profile.backend.timerAvailable ? 'available' : 'unavailable'}. Audio: ${audioUnlock}; maximum pointer→render delay: ${pointerMaximum} ms. Native AudioContext construction: ${(profile.audioContexts || []).map(entry => `${ms(entry.ms)} ms during ${esc(entry.phase || 'startup/warmup before interaction')}`).join(', ') || 'none'}.</li>`;
  }).join('');
  await writeFile(path.join(output, `performance-viewport-${phase}.html`), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Popple full viewport performance — ${esc(phase)}</title><style>body{font:15px system-ui;margin:32px;color:#222;line-height:1.45}table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 10px;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap}td:first-child,th:first-child{text-align:left}li{max-width:110ch;margin:8px 0}.table{overflow:auto}code{font-size:.9em}</style><h1>Full adaptive bubble field: ${esc(phase)}</h1><p>${esc(report.generatedAt)} · ${esc(report.browserFlavor)} · Chromium ${esc(report.browserVersion)} · runtime ${esc(ref || 'working-tree snapshot')} · HEAD ${esc(report.head.slice(0, 12))}</p><p>All durations in milliseconds. Arrows show baseline → this run; a dash means no samples/baseline. No physical phone FPS claim.</p><ul>${success}</ul><div class="table"><table><thead><tr><th>Viewport</th><th>Action</th><th>Bubbles</th><th>CPU p50</th><th>CPU p95</th><th>GPU p50 / p95</th><th>Resize p50</th><th>Resize p95</th><th>rAF p95</th><th>Frames &gt;25 / &gt;33 / &gt;50 ms</th><th>Pointer→render p50 / p95</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Measurement limits</h2><ul>${report.limits.map(value => `<li>${esc(value)}</li>`).join('')}</ul><p>Full source SHA256 hashes, raw frames, renders, resizes, asynchronous GPU samples and state evidence are in <a href="performance-viewport-${esc(phase)}.json">JSON</a>.</p>${report.errors.length ? `<pre>${esc(JSON.stringify(report.errors, null, 2))}</pre>` : ''}</html>`);
}
assert.equal(report.errors.length, 0, 'No benchmark errors');
console.log(`REPORT ${jsonPath}`);
