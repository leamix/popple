import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
// Measure an active audio graph: recent Chromium silences the analyser too
// when launched with Playwright's default --mute-audio switch.
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'] });
const report = { generatedAt: new Date().toISOString(), url: baseURL, browsers: { chromium: browser.version() }, checks: [], errors: [], limitations: [
  'Audio is measured from a running AudioContext; physical speakers and human listening are not tested.',
  'Touch is emulated. No physical Android or iPhone motor is available; native iOS haptics cannot be verified here.',
  'Current iOS native switch feedback requires a trusted direct click and cannot accompany every held or sliding pop.',
] };
const appSource = await readFile(path.join(root, 'public/js/app/main.js'), 'utf8');
const appInstrumented = appSource.replace('const audio=new PopAudio();', 'const audio=new PopAudio(); globalThis.__interactionAudio=audio;');
assert.notEqual(appSource, appInstrumented);
const physicsSource = await readFile(path.join(root, 'public/js/core/physics.js'), 'utf8');
const physicsInstrumented = physicsSource.replace('this.reset();', 'this.reset(); (globalThis.__bubbleStates ??= []).push(this);');
assert.notEqual(physicsSource, physicsInstrumented);
const contexts = [];
async function context(options = {}, targetBrowser = browser) {
  const { hold = .24, ...browserOptions } = options;
  const ctx = await targetBrowser.newContext({ viewport: { width: 390, height: 844 }, ...browserOptions });
  contexts.push(ctx);
  await ctx.addInitScript(({ hold }) => {
    localStorage.setItem('bubble.hold', String(hold));
    localStorage.setItem('bubble.sound', 'true');
    localStorage.setItem('bubble.tilt', 'false');
    localStorage.setItem('bubble.motion', 'false');
    window.__hapticCalls = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: duration => {
      __hapticCalls.push({ duration, active: (window.__bubbleStates ?? []).filter(b => b.active).map(b => b.index) });
      return true;
    } });
  }, { hold });
  await ctx.route('**/js/app/main.js', route => route.fulfill({ contentType: 'text/javascript', body: appInstrumented }));
  await ctx.route('**/js/core/physics.js', route => route.fulfill({ contentType: 'text/javascript', body: physicsInstrumented }));
  const page = await ctx.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(baseURL);
  await page.waitForFunction(() => window.__bubbleStates?.length === 14 && window.__interactionAudio);
  await page.waitForTimeout(180);
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
async function pocket(page, index = 4) {
  const bounds = await page.locator('.bubble-target').nth(index).boundingBox();
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, radius: bounds.width / 2 };
}
const popped = page => page.evaluate(() => __bubbleStates.filter(b => b.popped).map(b => b.index));
const active = page => page.evaluate(() => __bubbleStates.filter(b => b.active).map(b => b.index));
const haptics = page => page.evaluate(() => __hapticCalls);
const waitPopped = (page, index) => page.waitForFunction(i => __bubbleStates[i].popped, index, { timeout: 1800 });
async function analyse(page) {
  await page.waitForFunction(() => __interactionAudio.context?.state === 'running');
  await page.evaluate(() => {
    const analyser = __interactionAudio.context.createAnalyser();
    analyser.fftSize = 2048;
    __interactionAudio.output.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    window.__audioProbe = { frames: [] };
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      __audioProbe.frames.push(Math.sqrt(energy / samples.length));
    }, 12);
  });
}
const clearProbe = page => page.evaluate(() => { __audioProbe.frames.length = 0; });
const maxRms = page => page.evaluate(() => Math.max(0, ...__audioProbe.frames));
async function stroke(page, point, count = 12) {
  for (let step = 0; step < count; step++) {
    await page.mouse.move(point.x + Math.sin(step * .67) * 15, point.y + Math.cos(step * .67) * 7);
    await page.waitForTimeout(24);
  }
}
async function soundScenario(targetBrowser = browser) {
  const { page } = await context({ hold: 2 }, targetBrowser);
  const point = await pocket(page);
  await page.locator('#sound').click(); await page.locator('#sound').click();
  await analyse(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await clearProbe(page); await stroke(page, point);
  const intact = await maxRms(page);
  assert.ok(intact < 1e-7, `Intact rubbing must be silent, got ${intact}`);
  assert.deepEqual(await popped(page), []);
  await page.mouse.up();
  await page.evaluate(() => __bubbleStates[4].setHoldDuration(.24));
  await clearProbe(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await waitPopped(page, 4); await page.waitForTimeout(160);
  const pop = await maxRms(page);
  assert.ok(pop > .001, `A pop must retain audible output, got ${pop}`);
  await page.waitForTimeout(220); await clearProbe(page); await stroke(page, point);
  const held = await maxRms(page);
  assert.ok(held < 1e-7, `Post-pop held movement must be silent, got ${held}`);
  await page.mouse.up();
  await page.mouse.down(); await clearProbe(page); await stroke(page, point);
  const fresh = await maxRms(page);
  assert.ok(fresh < 1e-7, `Fresh rubbing of popped film must be silent, got ${fresh}`);
  await page.mouse.up();
  assert.deepEqual(await popped(page), [4]);
  return { intactRms: intact, popRms: pop, heldRms: held, freshRms: fresh };
}
let webkitBrowser;
try {
  await check('refill overlaps random starts, preserves intact pockets and survives repeated clicks', async () => {
    const { page } = await context({ viewport: { width: 1000, height: 800 } });
    await page.locator('.bubble-target').evaluateAll(buttons => buttons.slice(1).forEach(button => button.click()));
    await page.waitForFunction(() => __bubbleStates.slice(1).every(b => b.popped));
    await page.waitForTimeout(450);
    const intact = await page.evaluate(() => ({ seed: __bubbleStates[0].seed, collapse: __bubbleStates[0].collapse }));
    await page.screenshot({ path: path.join(output, 'refill-before.png') });
    await page.evaluate(() => {
      window.__refillSamples = [];
      document.querySelector('#reset').addEventListener('click', () => {
        if (__refillSamples.length) return;
        const start = performance.now();
        const sample = () => {
          const states = __bubbleStates.map(b => ({ collapse: b.collapse, refilling: b.refilling, popped: b.popped, seed: b.seed }));
          __refillSamples.push({ time: (performance.now() - start) / 1000, states });
          if (states.some(b => b.refilling)) requestAnimationFrame(sample);
        };
        sample();
      });
    });
    await page.locator('#reset').click();
    await page.waitForTimeout(320);
    assert.ok(await page.locator('[aria-busy="true"]').count() > 0, 'refill must remain visible after the click');
    const progress = await page.evaluate(() => __bubbleStates.map(b => b.collapse));
    await page.locator('#reset').click();
    assert.ok(await page.evaluate(previous => __bubbleStates.every((b, i) => b.collapse <= previous[i]), progress),
      'a repeated click must not rewind any pocket');
    await page.screenshot({ path: path.join(output, 'refill-inflating.png') });
    await page.waitForFunction(() => __bubbleStates.every(b => !b.refilling && !b.popped));
    await page.screenshot({ path: path.join(output, 'refill-after.png') });
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    assert.equal(await page.locator('[aria-disabled="true"]').count(), 0);
    const samples = await page.evaluate(() => __refillSamples);
    assert.ok(samples.at(-1).time >= 1.5 && samples.at(-1).time < 2.25,
      `whole refill took ${samples.at(-1).time}s, including frame delivery`);
    const starts = Array.from({ length: 13 }, (_, i) => samples.find(sample => sample.states[i + 1].collapse < .99).time).sort((a, b) => a - b);
    const firstFinish = samples.find(sample => sample.states.slice(1).some(b => !b.refilling)).time;
    assert.ok(starts.at(-1) - starts[0] > .2);
    assert.ok(starts.at(-1) < firstFinish, 'later pockets start before the first completes');
    assert.ok(samples.every(sample => sample.states[0].seed === intact.seed && sample.states[0].collapse === intact.collapse));
    const a = await pocket(page, 4);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await waitPopped(page, 4); await page.mouse.up();
    assert.deepEqual(await popped(page), [4], 'restored bubbles remain playable');
    return { seconds: samples.at(-1).time, starts, firstFinish };
  });
  await check('refill in reduced motion is immediate and toggling it finishes an animation', async () => {
    const { page } = await context();
    const popOne = async () => {
      await page.locator('.bubble-target').nth(4).evaluate(button => button.click());
      await waitPopped(page, 4);
    };
    await popOne();
    await page.locator('#reset').click();
    await page.locator('#settings-open').click(); await page.locator('#motion').check();
    assert.deepEqual(await popped(page), []);
    assert.ok(await page.evaluate(() => __bubbleStates.every(b => !b.refilling)));
    await page.locator('#settings-close').click();
    await popOne();
    await page.locator('#reset').click();
    assert.deepEqual(await popped(page), []);
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    assert.ok(!(await page.locator('#announcement').textContent()).includes('надуваются'));
  });
  await check('refill ignores late assistive clicks without cancelling the next keyboard hold', async () => {
    const { page } = await context();
    const button = page.locator('.bubble-target').nth(4);
    await button.evaluate(button => button.click()); await waitPopped(page, 4);
    await page.locator('#reset').click();
    await page.waitForFunction(() => {
      const b = __bubbleStates[4];
      return b.refilling && b._refillDuration - b._refillElapsed < .08;
    });
    await button.evaluate(button => button.click());
    await page.waitForFunction(() => !__bubbleStates[4].refilling);
    await button.focus(); await page.keyboard.down('Space');
    await waitPopped(page, 4); await page.keyboard.up('Space');
    assert.deepEqual(await popped(page), [4]);
  });
  await check('intact and popped rubbing are silent while pop remains audible', () => soundScenario());
  await check('background and outside-circle retargeted presses do not pop or vibrate', async () => {
    const { page } = await context();
    const a = await pocket(page, 4), b = await pocket(page, 5);
    await page.mouse.move((a.x + b.x) / 2, a.y); await page.mouse.down();
    await page.waitForTimeout(400); await page.mouse.up();
    assert.deepEqual(await popped(page), []); assert.deepEqual(await haptics(page), []);
    // Mobile hit adjustment can deliver a press to a nearby DOM target.
    await page.mouse.down();
    await page.locator('.bubble-target').nth(4).dispatchEvent('pointerdown', {
      pointerId: 1, pointerType: 'mouse', button: 0, pressure: .5,
      clientX: a.x + a.radius * 1.04, clientY: a.y,
    });
    await page.waitForTimeout(400);
    assert.deepEqual(await active(page), []); assert.deepEqual(await popped(page), []);
    assert.deepEqual(await haptics(page), []);
    await page.mouse.up();
  });
  await check('moving into a gap stops pressure before a delayed pop or pulse', async () => {
    const { page } = await context({ hold: .4 });
    const a = await pocket(page);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.waitForTimeout(60);
    const pulses = (await haptics(page)).length;
    await page.mouse.move(a.x + a.radius * 1.17, a.y);
    assert.deepEqual(await active(page), []);
    await page.waitForTimeout(550);
    assert.deepEqual(await popped(page), []); assert.equal((await haptics(page)).length, pulses);
    await page.mouse.up();
  });
  await check('one held mouse gesture pops adjacent pockets with separate hold times', async () => {
    const { page } = await context();
    const a = await pocket(page, 4), b = await pocket(page, 5);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await waitPopped(page, 4);
    await page.mouse.move(b.x, b.y);
    assert.deepEqual(await active(page), [5]); assert.deepEqual(await popped(page), [4]);
    await waitPopped(page, 5); await page.mouse.up();
    assert.deepEqual(await popped(page), [4, 5]); assert.deepEqual(await active(page), []);
    assert.equal((await haptics(page)).length, 4, 'Each accepted contact and each pop gives one pulse.');
  });
  await check('touch can start on film, cross gaps and pop three pockets without lifting', async () => {
    const { ctx, page } = await context({ isMobile: true, hasTouch: true });
    const cdp = await ctx.newCDPSession(page);
    const a = await pocket(page, 4), b = await pocket(page, 5), c = await pocket(page, 6);
    const move = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1, force: .5, radiusX: 5, radiusY: 5 }] : [] });
    await move('touchStart', { x: (a.x + b.x) / 2, y: a.y });
    await page.waitForTimeout(350); assert.deepEqual(await active(page), []); assert.deepEqual(await haptics(page), []);
    for (const [index, point] of [[4, a], [5, b], [6, c]]) {
      await move('touchMove', point); assert.deepEqual(await active(page), [index]);
      await waitPopped(page, index);
    }
    await move('touchEnd');
    assert.deepEqual(await popped(page), [4, 5, 6]); assert.deepEqual(await active(page), []);
    assert.equal((await haptics(page)).length, 6);
    return { popped: await popped(page) };
  });
  await check('two fingers cannot steal a pocket or cancel each other during a crossing', async () => {
    const { ctx, page } = await context({ hold: .4, isMobile: true, hasTouch: true });
    const cdp = await ctx.newCDPSession(page);
    const a = await pocket(page, 4), b = await pocket(page, 5), c = await pocket(page, 6);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, p]) => ({ id, x: p.x, y: p.y, force: .5 })) });
    await touch('touchStart', [[1, a], [2, b]]);
    assert.deepEqual(await active(page), [4, 5]);
    await touch('touchMove', [[1, b], [2, b]]);
    assert.deepEqual(await active(page), [5]);
    await touch('touchMove', [[1, c], [2, b]]);
    assert.deepEqual(await active(page), [5, 6]);
    await page.waitForFunction(() => __bubbleStates[5].popped && __bubbleStates[6].popped);
    await touch('touchCancel', []); assert.deepEqual(await active(page), []);
    assert.deepEqual(await popped(page), [5, 6]);
  });
  await check('cancelled and reduced-effect contacts never emit a later pop pulse', async () => {
    const { ctx, page } = await context({ isMobile: true, hasTouch: true, hold: .4 });
    const cdp = await ctx.newCDPSession(page), a = await pocket(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1, force: .5 }] });
    await page.waitForTimeout(80);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    const pulses = (await haptics(page)).length;
    await page.waitForTimeout(500); assert.deepEqual(await popped(page), []);
    assert.equal((await haptics(page)).length, pulses);
    await page.locator('#settings-open').tap(); await page.locator('#motion').check(); await page.locator('#settings-close').tap();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 2, force: .5 }] });
    await waitPopped(page, 4);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal((await haptics(page)).length, pulses);
  });
  const webkitPackage = process.env.WEBKIT_MODULE || available.find(item => existsSync(path.join(browserCache, `webkit-${item.webkitRevision}`)))?.path;
  if (webkitPackage) {
    const { webkit } = await import(pathToFileURL(path.join(webkitPackage, 'index.mjs')));
    webkitBrowser = await webkit.launch({ headless: true });
    report.browsers.webkit = webkitBrowser.version();
    await check('WebKit rubbing is silent while the pop remains audible', () => soundScenario(webkitBrowser));
    await check('iOS native haptic target accepts a trusted tap only inside the circle', async () => {
      const { page } = await context({ isMobile: true, hasTouch: true }, webkitBrowser);
      const a = await pocket(page), input = page.locator('.bubble-haptic').nth(4);
      const capability=await page.evaluate(()=>({switch:'switch' in document.createElement('input'),touches:navigator.maxTouchPoints,coarse:matchMedia('(pointer: coarse)').matches}));
      assert.equal(await input.count(), 1, `A native iOS switch must accept the direct tap: ${JSON.stringify(capability)}`);
      await page.evaluate(() => {
        window.__nativeClicks = [];
        window.__tapTrace=[];
        for(const type of ['pointerdown','touchstart','touchend','click'])document.addEventListener(type,e=>{
          const point=e.changedTouches?.[0]??e;
          __tapTrace.push({type,x:point.clientX,y:point.clientY,target:e.target.className,index:e.target.dataset.index,cancelable:e.cancelable,prevented:e.defaultPrevented});
        },{passive:true});
        document.querySelectorAll('.bubble-haptic')[4].addEventListener('click', e => __nativeClicks.push({ trusted: e.isTrusted, checked: e.target.checked }));
      });
      await page.touchscreen.tap(a.x, a.y);
      assert.deepEqual(await page.evaluate(() => __nativeClicks), [{ trusted: true, checked: true }]);
      assert.deepEqual(await popped(page), [], 'A haptic tap cannot skip the existing hold.');
      await page.touchscreen.tap(a.x + a.radius * .85, a.y + a.radius * .85);
      assert.equal(await input.isChecked(), true, `A corner of the rectangular bounds lies outside the bubble: ${JSON.stringify({trace:await page.evaluate(()=>__tapTrace),button:a,input:await input.boundingBox()})}`);
      await page.waitForTimeout(400); assert.deepEqual(await popped(page), []);
      await page.locator('#settings-open').tap(); await page.locator('#motion').check(); await page.locator('#settings-close').tap();
      await page.touchscreen.tap(a.x, a.y);
      assert.equal(await input.isChecked(), true, 'Reduced effects must bypass the native switch.');
    });
    await check('WebKit continuous captured drag reaches a second pocket', async () => {
      const { page } = await context({}, webkitBrowser);
      const a = await pocket(page, 4), b = await pocket(page, 5);
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await waitPopped(page, 4);
      await page.mouse.move(b.x, b.y); await waitPopped(page, 5); await page.mouse.up();
      assert.deepEqual(await popped(page), [4, 5]); assert.deepEqual(await active(page), []);
    });
    await check('iOS native tap preserves accessible bubble focus and keyboard hold', async () => {
      const { page } = await context({ isMobile: true, hasTouch: true }, webkitBrowser);
      const a = await pocket(page);
      await page.locator('.bubble-target').nth(4).focus();
      await page.touchscreen.tap(a.x,a.y);
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelectorAll('.bubble-target')[4]),true);
      await page.keyboard.down('Space'); await waitPopped(page,4); await page.keyboard.up('Space');
      assert.deepEqual(await popped(page),[4]);
    });
  } else report.limitations.push('No matching installed WebKit; its checks were skipped.');
  await check('no application runtime or console errors', async () => assert.deepEqual(report.errors, []));
} finally {
  await Promise.allSettled(contexts.map(ctx => ctx.close()));
  if (webkitBrowser) await webkitBrowser.close();
  await browser.close();
  report.summary = { passed: report.checks.filter(check => check.status === 'passed').length, failed: report.checks.filter(check => check.status === 'failed').length };
  await writeFile(path.join(output, checkFilter ? 'interaction-filtered-report.json' : 'interaction-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report.summary));
if (report.summary.failed) process.exitCode = 1;
