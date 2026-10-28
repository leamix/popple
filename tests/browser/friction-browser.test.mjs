import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'tests', '.artifacts');
const baseURL = process.env.POPPLE_URL || 'http://127.0.0.1:4174';
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
const appInstrumented = appSource.replace('const audio=new PopAudio();', 'const audio=new PopAudio(); globalThis.__interactionAudio=audio; globalThis.__bubbleStates=bubbles;');
assert.notEqual(appSource, appInstrumented);
const rendererSource = await readFile(path.join(root, 'public/js/rendering/renderer.js'), 'utf8');
const rendererInstrumented = rendererSource.replace('render(bubbles,layout,dark,time,light) {',
  'render(bubbles,layout,dark,time,light) { globalThis.__interactionRenderer=this;');
assert.notEqual(rendererSource, rendererInstrumented);
const contexts = [];
async function context(options = {}, targetBrowser = browser) {
  const { hold = .24, probeAudioPreparation = false, ...browserOptions } = options;
  const ctx = await targetBrowser.newContext({ viewport: { width: 390, height: 844 }, ...browserOptions });
  contexts.push(ctx);
  await ctx.addInitScript(({ hold, probeAudioPreparation, reduced }) => {
    localStorage.setItem('popple.hold', String(hold));
    localStorage.setItem('popple.sound', 'true');
    localStorage.setItem('popple.tilt', 'false');
    localStorage.setItem('popple.motion', String(reduced));
    window.__hapticCalls = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: duration => {
      __hapticCalls.push({ duration, active: (window.__bubbleStates ?? []).flatMap((b, index) => b.active ? [index] : []) });
      return true;
    } });
    if (probeAudioPreparation) {
      window.__audioSourceStarts = [];
      window.__trustedAudioActivations = [];
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']) {
        window.addEventListener(type, event => { if (event.isTrusted) __trustedAudioActivations.push(type); }, true);
      }
      for (const Source of [window.AudioBufferSourceNode, window.OscillatorNode]) if (Source) {
        const start = Source.prototype.start;
        Source.prototype.start = function(...args) {
          __audioSourceStarts.push({ trustedActivation: __trustedAudioActivations.length > 0,
            time: performance.now(), contextTime: this.context.currentTime, duration: this.buffer?.duration });
          return start.apply(this, args);
        };
      }
    }
  }, { hold, probeAudioPreparation, reduced: browserOptions.reducedMotion === 'reduce' });
  await ctx.route('**/js/app/main.js', route => route.fulfill({ contentType: 'text/javascript', body: appInstrumented }));
  await ctx.route('**/js/rendering/renderer.js', route => route.fulfill({ contentType: 'text/javascript', body: rendererInstrumented }));
  const page = await ctx.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(baseURL);
  await page.waitForFunction(() => window.__bubbleStates?.length > 0 && window.__interactionAudio);
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
async function adjacentPockets(page, count = 2) {
  return page.locator('.bubble-target').evaluateAll((buttons, count) => {
    const rows = [];
    for (const button of buttons) {
      const bounds = button.getBoundingClientRect();
      const point = { index: Number(button.dataset.index), x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, radius: bounds.width / 2 };
      let row = rows.find(row => Math.abs(row[0].y - point.y) < .5);
      if (!row) { row = []; rows.push(row); }
      row.push(point);
    }
    const row = rows.find(row => row.length >= count);
    if (!row) throw new Error(`The fixture requires a row of ${count} adjacent pockets.`);
    return row.sort((a, b) => a.x - b.x).slice(0, count);
  }, count);
}
const popped = page => page.evaluate(() => __bubbleStates.flatMap((b, index) => b.popped ? [index] : []));
const active = page => page.evaluate(() => __bubbleStates.flatMap((b, index) => b.active ? [index] : []));
const haptics = page => page.evaluate(() => __hapticCalls);
const waitPopped = (page, index) => page.waitForFunction(i => __bubbleStates[i].popped, index, { timeout: 1800 });
async function analyse(page, { waitForRunning = true } = {}) {
  if (waitForRunning) await page.waitForFunction(() => __interactionAudio.context?.state === 'running');
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

async function replayControlTouch(page, selector, { retargeted = false, cancel = false, moveAway = false, moveInside = false, blur = false } = {}) {
  return page.evaluate(options => {
    const button = document.querySelector(options.selector), bounds = button.getBoundingClientRect();
    const target = options.retargeted
      ? document.querySelectorAll('.bubble-haptic')[4] ?? document.querySelectorAll('.bubble-target')[4]
      : button.querySelector('span,svg') ?? button;
    const touch = { identifier: 91, target, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, force: .5 };
    const dispatch = (type, point = touch) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        changedTouches: { value: [point] },
        touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [point] },
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const startPrevented = dispatch('touchstart');
    if (options.moveAway) dispatch('touchmove', { ...touch, clientX: touch.clientX - 80 });
    if (options.moveInside) dispatch('touchmove', { ...touch, clientX: touch.clientX + 20 });
    if (options.blur) window.dispatchEvent(new Event('blur'));
    const endPrevented = dispatch(options.cancel ? 'touchcancel' : 'touchend');
    return { startPrevented, endPrevented, refilling: __bubbleStates[4].refilling };
  }, { selector, retargeted, cancel, moveAway, moveInside, blur });
}

async function firstRefillTouchScenario(targetBrowser = browser) {
  const { page } = await context({ isMobile: true, hasTouch: true }, targetBrowser);
  const popOne = async () => {
    await page.locator('.bubble-target').nth(4).evaluate(button => button.click());
    await waitPopped(page, 4);
  };
  const gesture = options => replayControlTouch(page, '#reset', options);

  await popOne();
  const redirected = await gesture({ retargeted: true });
  assert.equal(redirected.refilling, true, 'a first raw touch over «ещё» must not be lost to the native haptic target');
  assert.equal(redirected.startPrevented, true, 'cancel the wrongly targeted native switch');
  assert.equal(redirected.endPrevented, true, 'suppress its compatibility click');
  await page.waitForFunction(() => !__bubbleStates[4].popped);

  await popOne();
  const direct = await gesture();
  assert.equal(direct.refilling, true, 'a direct touch must work without waiting for a synthesized click');
  assert.equal(direct.endPrevented, true, 'one touch must not activate the button twice');
  await page.waitForFunction(() => !__bubbleStates[4].popped);

  await popOne();
  assert.equal((await gesture({ cancel: true })).refilling, false);
  assert.equal((await gesture({ moveAway: true })).refilling, false, 'a dragged-away touch must not become a tap');
  assert.equal((await gesture({ moveInside: true })).refilling, false, 'a swipe staying inside the button must not become a tap');
  assert.equal((await gesture({ blur: true })).refilling, false, 'losing focus must cancel the pending control gesture');
  const native = await page.locator('.bubble-haptic').count();
  await page.locator('.bubble-target').nth(4).focus();
  const point = await pocket(page, 4);
  if (native) await page.touchscreen.tap(point.x, point.y);
  const accent = await page.evaluate(() => sessionStorage.getItem('popple.brandAccent'));
  await page.evaluate(() => {
    window.__resetAccentWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage && key === 'popple.brandAccent') __resetAccentWrites.push(value);
      return setItem.call(this, key, value);
    };
  });
  await page.locator('#reset').tap();
  assert.ok(await page.evaluate(() => __bubbleStates[4].refilling), 'the first trusted tap must start inflation');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'reset');
  const nextAccent = await page.evaluate(() => sessionStorage.getItem('popple.brandAccent'));
  assert.notEqual(nextAccent, accent);
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('popple.brandAccent')), nextAccent);
  assert.equal(await page.evaluate(() => __resetAccentWrites.length), 1, 'one trusted touch must perform only one refill action');
  return { nativeHapticTargets: native, redirected, direct };
}

async function stableResizeHapticsScenario(targetBrowser) {
  const { page } = await context({ isMobile: true, hasTouch: true }, targetBrowser);
  await page.locator('#settings-open').tap();
  await page.locator('#motion').check();
  await page.locator('#settings-close').tap();
  const before = await page.evaluate(() => {
    window.__stableResizeNodes = [...document.querySelectorAll('#targets > *')];
    window.__stableResizeStyles = __stableResizeNodes.map(node => node.style.cssText);
    window.__stableResizeMutations = [];
    window.__stableResizeObserver = new MutationObserver(records => {
      __stableResizeMutations.push(...records.map(record => ({ type: record.type, attribute: record.attributeName })));
    });
    __stableResizeObserver.observe(document.querySelector('#targets'), { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-index', 'aria-label', 'aria-busy', 'aria-disabled', 'disabled'] });
    return { keys: __interactionRenderer.layout.map(p => `${p.row}:${p.column}`),
      haptics: [...document.querySelectorAll('.bubble-haptic')].map(input => input.disabled),
      diameter: document.querySelector('.bubble-target').getBoundingClientRect().width };
  });
  assert.ok(before.haptics.length > 0 && before.haptics.every(Boolean), 'The fixture exercises disabled native haptic targets.');
  await page.setViewportSize({ width: 400, height: 844 });
  await page.waitForFunction(diameter => document.querySelector('.bubble-target').getBoundingClientRect().width > diameter, before.diameter);
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => {
    __stableResizeObserver.disconnect();
    const nodes = [...document.querySelectorAll('#targets > *')];
    return { keys: __interactionRenderer.layout.map(p => `${p.row}:${p.column}`),
      haptics: [...document.querySelectorAll('.bubble-haptic')].map(input => input.disabled),
      sameNodes: nodes.length === __stableResizeNodes.length && nodes.every((node, i) => node === __stableResizeNodes[i]),
      positionsChanged: nodes.some((node, i) => node.style.cssText !== __stableResizeStyles[i]), mutations: __stableResizeMutations };
  });
  assert.deepEqual(after.keys, before.keys, 'The resize preserves the same logical cells.');
  assert.deepEqual(after.haptics, before.haptics, 'Reduced motion keeps every native target disabled.');
  assert.equal(after.sameNodes, true);
  assert.equal(after.positionsChanged, true);
  assert.deepEqual(after.mutations, [], 'Geometry-only resize must preserve native disabled state and target accessibility without attribute writes.');
  return { targetCount: after.keys.length, nativeHapticTargets: after.haptics.length };
}

async function topbarFirstTouchScenario(selector, targetBrowser = browser) {
  const { page } = await context({ isMobile: true, hasTouch: true }, targetBrowser);
  await page.locator('.bubble-target').nth(4).evaluate(button => button.click()); await waitPopped(page, 4);
  await page.locator('.bubble-target').nth(4).focus();
  if (await page.locator('.bubble-haptic').count()) {
    const point = await pocket(page, 4); await page.touchscreen.tap(point.x, point.y);
  }
  await page.evaluate(() => {
    window.__controlWrites = [];
    window.__settingsOpens = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && ['popple.theme', 'popple.sound'].includes(key)) __controlWrites.push({ key, value });
      return setItem.call(this, key, value);
    };
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function() { __settingsOpens++; return showModal.call(this); };
  });
  const snapshot = () => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    sound: __interactionAudio.enabled,
    settings: document.querySelector('#settings').open,
    popped: __bubbleStates.flatMap((b, index) => b.popped ? [index] : []),
    switches: [...document.querySelectorAll('.bubble-haptic')].map(input => input.checked),
  }));
  const clearCounts = () => page.evaluate(() => { __controlWrites = []; __settingsOpens = 0; });
  const assertActivation = async before => {
    const after = await snapshot();
    assert.equal(after.theme, selector === '#theme' ? before.theme === 'dark' ? 'light' : 'dark' : before.theme);
    assert.equal(after.sound, selector === '#sound' ? !before.sound : before.sound);
    assert.equal(after.settings, selector === '#settings-open' ? true : before.settings);
    assert.deepEqual(after.popped, before.popped, 'topbar controls must not restore or pop pockets');
    assert.deepEqual(after.switches, before.switches, 'a topbar touch must not toggle a bubble haptic switch');
    const counts = await page.evaluate(() => ({ writes: __controlWrites, opens: __settingsOpens }));
    if (selector === '#settings-open') assert.equal(counts.opens, 1, 'one touch must open the dialog once');
    else assert.equal(counts.writes.filter(item => item.key === (selector === '#theme' ? 'popple.theme' : 'popple.sound')).length, 1,
      'one touch must toggle the setting once');
    return after;
  };
  const restore = async () => {
    if (selector === '#settings-open') {
      const end = await replayControlTouch(page, '#settings-close');
      assert.equal(end.endPrevented, true);
      assert.equal(await page.locator('#settings').evaluate(dialog => dialog.open), false, 'close must work on the first raw touch too');
    } else await page.locator(selector).evaluate(button => button.click());
    await clearCounts();
  };

  const initial = await snapshot();
  await clearCounts();
  const redirected = await replayControlTouch(page, selector, { retargeted: true });
  await assertActivation(initial);
  assert.equal(redirected.startPrevented, true); assert.equal(redirected.endPrevented, true);
  await restore();
  const direct = await replayControlTouch(page, selector);
  await assertActivation(initial); assert.equal(direct.endPrevented, true);
  await restore();
  for (const options of [{ cancel: true }, { moveInside: true }, { blur: true }]) {
    await replayControlTouch(page, selector, options);
    assert.deepEqual(await snapshot(), initial, 'cancelled gestures must leave controls and pockets unchanged');
  }
  await page.locator(selector).tap();
  const afterTrustedTap = await assertActivation(initial);
  await page.waitForTimeout(350);
  assert.deepEqual(await snapshot(), afterTrustedTap);
  await assertActivation(initial);
  if (selector !== '#settings-open') {
    assert.equal(await page.evaluate(() => document.activeElement.id), selector.slice(1));
    await clearCounts();
    if (selector === '#sound') {
      await page.evaluate(() => __interactionAudio.context.suspend());
      assert.equal(await page.evaluate(() => __interactionAudio.context.state), 'suspended');
    }
    await page.locator(selector).tap();
    await assertActivation(afterTrustedTap);
    if (selector === '#sound') await page.waitForFunction(() => __interactionAudio.context?.state === 'running');
  }
  if (selector === '#settings-open') {
    const before = await snapshot();
    await replayControlTouch(page, '#theme', { retargeted: true });
    assert.deepEqual(await snapshot(), before, 'the modal backdrop must block topbar controls');
    await restore();
  }
  return { selector, nativeHapticTargets: initial.switches.length };
}

try {
  await check('film gap pulls neighbours, follows the mouse and settles after a stationary hold', async () => {
    const { page } = await context({ hold: .5 });
    const [a, b] = await adjacentPockets(page);
    const gap = { x: (a.x + b.x) / 2, y: a.y };
    await page.mouse.move(gap.x, gap.y); await page.mouse.down();
    await page.waitForTimeout(1150);
    await page.waitForFunction(({ a, b }) => {
      const sheet = __interactionRenderer.sheetState;
      return !sheet.needsAnimation && sheet.deformation[a.index * 4] > .025 && sheet.deformation[b.index * 4] < -.025;
    }, { a, b });
    const held = await page.evaluate(({ a, b }) => {
      const sheet = __interactionRenderer.sheetState;
      return { left: Array.from(sheet.deformation.slice(a.index * 4, a.index * 4 + 4)),
        right: Array.from(sheet.deformation.slice(b.index * 4, b.index * 4 + 4)), awake: sheet.needsAnimation };
    }, { a, b });
    assert.ok(held.left[0] > .025 && held.right[0] < -.025);
    assert.equal(held.awake, false, 'the settled held deformation needs no continuous animation');
    assert.deepEqual(await active(page), []); assert.deepEqual(await popped(page), []);
    await page.mouse.move(gap.x, gap.y + 5);
    await page.waitForFunction(index => __interactionRenderer.sheetState.deformation[index * 4 + 1] > 0, a.index);
    await page.mouse.up();
    await page.waitForFunction(() => !__interactionRenderer.sheetState.needsAnimation
      && __interactionRenderer.sheetState.deformation.every(v => v === 0));
    assert.ok(await page.evaluate(() => __interactionRenderer.sheetState.deformation.every(v => v === 0)));
    return held;
  });
  await check('film gap touch can hand off to a bubble and cancellation clears all film tension', async () => {
    const { ctx, page } = await context({ hold: .5, hasTouch: true, isMobile: true });
    const cdp = await ctx.newCDPSession(page);
    const [a, b] = await adjacentPockets(page);
    const gap = { x: (a.x + b.x) / 2, y: a.y, id: 1, force: .5 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [gap] });
    await page.waitForFunction(i => __interactionRenderer.sheetState.deformation[i * 4] > .02, a.index);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x, y: a.y, id: 1, force: .5 }] });
    await waitPopped(page, a.index);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [gap] });
    await page.waitForTimeout(100);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForFunction(() => !__interactionRenderer.sheetState.needsAnimation);
    assert.deepEqual(await popped(page), [a.index]); assert.deepEqual(await active(page), []);
  });
  await check('film gap reduced motion and resize never retain a stale pull', async () => {
    const { page } = await context({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.reduced), 'true');
    const [a, b] = await adjacentPockets(page);
    await page.mouse.move((a.x + b.x) / 2, a.y); await page.mouse.down();
    await page.waitForFunction(i => __interactionRenderer.sheetState.deformation[i * 4] > .02, a.index);
    assert.ok(await page.evaluate(() => __interactionRenderer.sheetState.deformation.every((v, i) => i % 4 !== 3 || v === 0)));
    await page.setViewportSize({ width: 430, height: 844 });
    await page.waitForFunction(() => __interactionRenderer.width === 430 && !__interactionRenderer.sheetState.needsAnimation);
    assert.equal(await page.evaluate(() => __interactionRenderer.sheetState.needsAnimation), false);
    await page.mouse.up(); assert.deepEqual(await popped(page), []);
  });
  await check('film gap fingers keep independent ownership when one finger lifts', async () => {
    const { ctx, page } = await context({ hasTouch: true, isMobile: true });
    const cdp = await ctx.newCDPSession(page), [a, b, c] = await adjacentPockets(page, 3);
    const first = { x: (a.x + b.x) / 2, y: a.y, id: 1, force: .5 };
    const second = { x: (b.x + c.x) / 2, y: b.y, id: 2, force: .5 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
    await page.waitForFunction(({ a, c }) => __interactionRenderer.sheetState.deformation[a.index * 4] > .02
      && __interactionRenderer.sheetState.deformation[c.index * 4] < -.02, { a, c });
    // CDP ends the listed contact; the other finger remains down.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [first] });
    await page.waitForFunction(({ a, c }) => __interactionRenderer.sheetState.deformation[a.index * 4] === 0
      && __interactionRenderer.sheetState.deformation[c.index * 4] < -.02, { a, c });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => __interactionRenderer.sheetState.deformation.every(v => v === 0));
    assert.deepEqual(await popped(page), []); assert.deepEqual(await active(page), []);
  });
  await check('audio prepares silently during startup idle and the first trusted hold still sounds', async () => {
    const { page } = await context({ probeAudioPreparation: true });
    await page.waitForFunction(() => __interactionAudio.context !== null, null, { timeout: 2000 });
    await analyse(page, { waitForRunning: false });
    await page.waitForTimeout(80);
    const before = await page.evaluate(() => {
      return { activated: __trustedAudioActivations.length > 0, sourcesStarted: __audioSourceStarts.length,
        maximumRms: Math.max(0, ...__audioProbe.frames), state: __interactionAudio.context.state };
    });
    assert.equal(before.activated, false, 'Preparation runs before any trusted interaction.');
    assert.equal(before.sourcesStarted, 0, 'Startup preparation must not start an audio source.');
    assert.equal(before.maximumRms, 0, 'Prepared audio stays silent before the first gesture.');
    const point = await pocket(page);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    try {
      await page.waitForFunction(() => __interactionAudio.context.state === 'running');
      await waitPopped(page, 4);
      // The first resumed output device can begin processing after the visual
      // pop; wait for actual analyser data rather than assuming a fixed delay.
      await page.waitForFunction(() => __audioProbe.frames.some(rms => rms > .001), null, { timeout: 2000 });
      const popRms = await maxRms(page);
      const audioState = await page.evaluate(() => ({ sources: __audioSourceStarts, frames: __audioProbe.frames.length,
        state: __interactionAudio.context.state, enabled: __interactionAudio.enabled, outputGain: __interactionAudio.output.gain.value }));
      assert.ok(popRms > .001, `The first trusted hold retains audible pop output, got ${popRms}; ${JSON.stringify(audioState)}`);
      assert.ok(await page.evaluate(() => __audioSourceStarts.length > 0 && __audioSourceStarts.every(source => source.trustedActivation)),
        'Audio sources start only after the first trusted activation.');
      return { before, popRms };
    } finally { await page.mouse.up(); }
  });
  for (const selector of ['#theme', '#sound', '#settings-open']) {
    await check(`topbar ${selector} works on the first touch after popping`, () => topbarFirstTouchScenario(selector));
  }
  await check('first refill touch works even when click is lost or retargeted', () => firstRefillTouchScenario());
  await check('first refill touch at the button edge survives its pressed animation', async () => {
    const { ctx, page } = await context({ isMobile: true, hasTouch: true });
    await page.locator('.bubble-target').nth(4).evaluate(button => button.click()); await waitPopped(page, 4);
    const bounds = await page.locator('#reset').boundingBox();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: bounds.x + 1, y: bounds.y + bounds.height / 2, force: .5 }] });
    await page.waitForTimeout(220);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await page.evaluate(() => __bubbleStates[4].refilling), 'pressed CSS shrink must not invalidate the original tap');
  });
  await check('refill overlaps random starts, preserves intact pockets and survives repeated clicks', async () => {
    const { page } = await context({ viewport: { width: 1000, height: 800 } });
    await page.locator('.bubble-target').evaluateAll(buttons => buttons.slice(1).forEach(button => button.click()));
    await page.waitForFunction(() => __bubbleStates.slice(1).every(b => b.popped));
    await page.waitForTimeout(450);
    const intact = await page.evaluate(() => ({ seed: __bubbleStates[0].seed, collapse: __bubbleStates[0].collapse }));
    await page.screenshot({ path: path.join(output, 'refill-before.png') });
    await page.evaluate(() => {
      window.__refillSamples = [];
      const renderer = __interactionRenderer, gl = renderer.gl;
      window.__refillGpu = { capTextureUploads: 0, bufferAllocations: 0, textureAllocations: 0, draws: 0, frameDraws: [] };
      const upload = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = (...args) => {
        if (gl.getParameter(gl.TEXTURE_BINDING_2D) === renderer.batch.texture) __refillGpu.capTextureUploads++;
        return upload(...args);
      };
      for (const [method, counter] of [['bufferData', 'bufferAllocations'], ['texImage2D', 'textureAllocations'], ['drawArrays', 'draws']]) {
        const original = gl[method].bind(gl);
        gl[method] = (...args) => { __refillGpu[counter]++; return original(...args); };
      }
      const angle = gl.getExtension('ANGLE_instanced_arrays');
      if (angle) {
        const draw = angle.drawArraysInstancedANGLE.bind(angle);
        angle.drawArraysInstancedANGLE = (...args) => { __refillGpu.draws++; return draw(...args); };
      }
      const render = renderer.render.bind(renderer);
      renderer.render = (...args) => {
        const before = __refillGpu.draws;
        const result = render(...args);
        __refillGpu.frameDraws.push(__refillGpu.draws - before);
        return result;
      };
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
    assert.ok(samples.at(-1).time >= 1 && samples.at(-1).time < 1.75,
      `whole refill took ${samples.at(-1).time}s, including frame delivery`);
    const starts = Array.from({ length: 13 }, (_, i) => samples.find(sample => sample.states[i + 1].collapse < .99).time).sort((a, b) => a - b);
    const firstFinish = samples.find(sample => sample.states.slice(1).some(b => !b.refilling)).time;
    assert.ok(starts.at(-1) - starts[0] > .2);
    assert.ok(starts.at(-1) < firstFinish, 'later pockets start before the first completes');
    assert.ok(samples.every(sample => sample.states[0].seed === intact.seed && sample.states[0].collapse === intact.collapse));
    const gpu = await page.evaluate(() => __refillGpu);
    assert.equal(gpu.capTextureUploads, 0, 'inflation and completion reuse existing wrinkle texture data');
    assert.equal(gpu.bufferAllocations, 0); assert.equal(gpu.textureAllocations, 0);
    assert.ok(gpu.frameDraws.length > 1 && gpu.frameDraws.every(draws => draws === 2), 'one sheet draw and one cap draw per frame');
    const a = await pocket(page, 4);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await waitPopped(page, 4); await page.mouse.up();
    assert.deepEqual(await popped(page), [4], 'restored bubbles remain playable');
    return { seconds: samples.at(-1).time, starts, firstFinish, gpu };
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
    assert.ok(!(await page.locator('#announcement').textContent()).includes('inflating'));
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
  await check('refill pauses while hidden and stops drawing after the final frame', async () => {
    const { page } = await context();
    await page.evaluate(() => {
      window.__refillRenderCount = 0;
      const renderer = __interactionRenderer, render = renderer.render.bind(renderer);
      renderer.render = (...args) => { __refillRenderCount++; return render(...args); };
    });
    await page.locator('.bubble-target').evaluateAll(buttons => buttons.forEach(button => button.click()));
    await page.waitForFunction(() => __bubbleStates.every(b => b.popped));
    await page.locator('#reset').click(); await page.waitForTimeout(120);
    const paused = await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return { collapse: __bubbleStates.map(b => b.collapse), frames: __refillRenderCount };
    });
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => ({ collapse: __bubbleStates.map(b => b.collapse), frames: __refillRenderCount })), paused);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => __bubbleStates.every(b => !b.refilling && !b.popped));
    await page.waitForTimeout(1100);
    const finishedFrames = await page.evaluate(() => __refillRenderCount);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => __refillRenderCount), finishedFrames, 'the animation must return to idle');
    return { pausedFrames: paused.frames, finishedFrames };
  });
  await check('intact and popped rubbing are silent while pop remains audible', () => soundScenario());
  await check('background and outside-circle retargeted presses do not pop or vibrate', async () => {
    const { page } = await context();
    const a = await pocket(page, 4);
    await page.mouse.move(a.x + a.radius * 1.17, a.y); await page.mouse.down();
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
    const [a, b] = await adjacentPockets(page);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await waitPopped(page, a.index);
    await page.mouse.move(b.x, b.y);
    assert.deepEqual(await active(page), [b.index]); assert.deepEqual(await popped(page), [a.index]);
    await waitPopped(page, b.index); await page.mouse.up();
    assert.deepEqual(await popped(page), [a.index, b.index]); assert.deepEqual(await active(page), []);
    assert.equal((await haptics(page)).length, 4, 'Each accepted contact and each pop gives one pulse.');
  });
  await check('touch can start on film, cross gaps and pop three pockets without lifting', async () => {
    const { ctx, page } = await context({ isMobile: true, hasTouch: true });
    const cdp = await ctx.newCDPSession(page);
    const [a, b, c] = await adjacentPockets(page, 3);
    const move = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1, force: .5, radiusX: 5, radiusY: 5 }] : [] });
    await move('touchStart', { x: (a.x + b.x) / 2, y: a.y });
    await page.waitForTimeout(350); assert.deepEqual(await active(page), []); assert.deepEqual(await haptics(page), []);
    for (const [index, point] of [[a.index, a], [b.index, b], [c.index, c]]) {
      await move('touchMove', point); assert.deepEqual(await active(page), [index]);
      await waitPopped(page, index);
    }
    await move('touchEnd');
    assert.deepEqual(await popped(page), [a.index, b.index, c.index]); assert.deepEqual(await active(page), []);
    assert.equal((await haptics(page)).length, 6);
    return { popped: await popped(page) };
  });
  await check('two fingers cannot steal a pocket or cancel each other during a crossing', async () => {
    const { ctx, page } = await context({ hold: .4, isMobile: true, hasTouch: true });
    const cdp = await ctx.newCDPSession(page);
    const [a, b, c] = await adjacentPockets(page, 3);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, p]) => ({ id, x: p.x, y: p.y, force: .5 })) });
    await touch('touchStart', [[1, a], [2, b]]);
    assert.deepEqual(await active(page), [a.index, b.index]);
    await touch('touchMove', [[1, b], [2, b]]);
    assert.deepEqual(await active(page), [b.index]);
    await touch('touchMove', [[1, c], [2, b]]);
    assert.deepEqual(await active(page), [b.index, c.index]);
    await page.waitForFunction(indices => indices.every(index => __bubbleStates[index].popped), [b.index, c.index]);
    await touch('touchCancel', []); assert.deepEqual(await active(page), []);
    assert.deepEqual(await popped(page), [b.index, c.index]);
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
    await check('WebKit film gap retains tension while asleep and releases without popping', async () => {
      const { page } = await context({}, webkitBrowser), [a, b] = await adjacentPockets(page);
      await page.mouse.move((a.x + b.x) / 2, a.y); await page.mouse.down();
      await page.waitForFunction(i => __interactionRenderer.sheetState.deformation[i * 4] > .025
        && !__interactionRenderer.sheetState.needsAnimation, a.index);
      await page.mouse.up();
      await page.waitForFunction(() => __interactionRenderer.sheetState.deformation.every(v => v === 0));
      assert.deepEqual(await popped(page), []);
    });
    await check('WebKit same-topology resize preserves native haptic nodes and disabled attributes', () => stableResizeHapticsScenario(webkitBrowser));
    for (const selector of ['#theme', '#sound', '#settings-open']) {
      await check(`WebKit topbar ${selector} works on the first touch after a native haptic tap`, () => topbarFirstTouchScenario(selector, webkitBrowser));
    }
    await check('WebKit first refill touch bypasses the native haptic target', () => firstRefillTouchScenario(webkitBrowser));
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
