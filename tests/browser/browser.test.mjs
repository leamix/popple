import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'artifacts');
const baseURL = process.env.BUBBLE_URL || 'http://127.0.0.1:4174';
const screenshotsOnly = process.argv.includes('--screenshots-only');
await mkdir(output, { recursive: true });
if (process.argv.includes('--webkit-only')) {
  const result = await runWebKitSmoke();
  process.exit(result.summary.failed ? 1 : 0);
}
const cache = path.join(homedir(), '.npm/_npx');
let playwrightPath = process.env.PLAYWRIGHT_MODULE;
const available = [];
if (!playwrightPath) {
  for (const folder of await readdir(cache)) {
    const packagePath = path.join(cache, folder, 'node_modules/playwright');
    if (!existsSync(path.join(packagePath, 'package.json'))) continue;
    const pkg = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
    const revisions = JSON.parse(await readFile(path.join(packagePath, '../playwright-core/browsers.json'), 'utf8')).browsers;
    const chromiumRevision = revisions.find(item => item.name === 'chromium').revision;
    const webkitRevision = revisions.find(item => item.name === 'webkit').revision;
    available.push({ path: packagePath, version: pkg.version, chromiumRevision, webkitRevision });
  }
  // Browser-cache registry may point to a matching existing playwright-core
  // outside npm's command cache. Read it without modifying that project.
  const links = path.join(homedir(), 'Library/Caches/ms-playwright/.links');
  if (existsSync(links)) {
    for (const link of await readdir(links)) {
      const packagePath = (await readFile(path.join(links, link), 'utf8')).trim();
      if (!existsSync(path.join(packagePath, 'browsers.json'))) continue;
      const pkg = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
      const revisions = JSON.parse(await readFile(path.join(packagePath, 'browsers.json'), 'utf8')).browsers;
      available.push({ path: packagePath, version: pkg.version,
        chromiumRevision: revisions.find(item => item.name === 'chromium').revision,
        webkitRevision: revisions.find(item => item.name === 'webkit').revision });
    }
  }
  available.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  playwrightPath = available.find(item => existsSync(path.join(homedir(), 'Library/Caches/ms-playwright', `chromium_headless_shell-${item.chromiumRevision}`)))?.path;
}
if (!playwrightPath) throw new Error('An installed Playwright package and matching Chromium cache are required. Nothing was installed.');
const { chromium } = await import(pathToFileURL(path.join(playwrightPath, 'index.mjs')));
const report = { url: baseURL, generatedAt: new Date().toISOString(), browser: {}, checks: [], errors: [], screenshots: [], limitations: [] };
const browser = await chromium.launch({ headless: true });
report.browser.chromium = browser.version();
report.browser.playwright = JSON.parse(await readFile(path.join(playwrightPath, 'package.json'), 'utf8')).version;
const physics = await readFile(path.join(root, 'public/js/core/physics.js'), 'utf8');
const instrumentedPhysics = physics.replace('this.reset();', 'this.reset(); (globalThis.__bubbleStates ??= []).push(this);');
const rendererSource = await readFile(path.join(root, 'public/js/rendering/renderer.js'), 'utf8');
const instrumentedRenderer = rendererSource.replace('render(bubbles,layout,dark,time,light) {', `render(bubbles,layout,dark,time,light) {
    globalThis.__lastLight={...light}; globalThis.__filmRenderer=this;
    globalThis.__filmLayout=layout; globalThis.__filmDark=dark; globalThis.__filmTime=time;`);
assert.notEqual(instrumentedRenderer,rendererSource,'Renderer test instrumentation must match the current render method.');
const activeContexts = [];

async function context(options = {}) {
  const {initScript,...browserOptions}=options;
  const ctx = await browser.newContext(browserOptions);
  activeContexts.push(ctx);
  if(initScript) await ctx.addInitScript(initScript);
  await ctx.route('**/js/core/physics.js', route => route.fulfill({ contentType: 'text/javascript', body: instrumentedPhysics }));
  await ctx.route('**/js/rendering/renderer.js', route => route.fulfill({ contentType: 'text/javascript', body: instrumentedRenderer }));
  const page = await ctx.newPage();
  page.on('pageerror', error => report.errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push({ type: 'console', message: message.text() });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => window.__bubbleStates?.length === 14);
  await page.waitForTimeout(180);
  return { ctx, page };
}
async function check(name, fn) {
  if (screenshotsOnly && !name.startsWith('final reloaded') && !name.startsWith('no application')) return;
  try {
    const details = await fn();
    report.checks.push({ name, status: 'passed', ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', message: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
const count = page => page.locator('.bubble-target[data-popped="true"]').count();
async function reset(page) {
  await page.locator('#reset').click();
  await page.waitForTimeout(100);
  assert.equal(await count(page), 0);
}
async function center(page, index = 4, offsetX = 0, offsetY = 0) {
  const rect = await page.locator('.bubble-target').nth(index).boundingBox();
  return { x: rect.x + rect.width * (0.5 + offsetX), y: rect.y + rect.height * (0.5 + offsetY) };
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  report.screenshots.push(name);
}
async function waitPopped(page, index = 4, timeout = 2000) {
  await page.waitForFunction(index => document.querySelectorAll('.bubble-target')[index].dataset.popped === 'true', index, { timeout });
}

async function inspectStaggeredLayout(page) {
  const geometry = await page.locator('.bubble-target').evaluateAll(buttons => buttons.map(button => {
    const bounds = button.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, radius: bounds.width / 2 };
  }));
  assert.equal(geometry.length, 14);
  const rows = [];
  for (const bubble of geometry) {
    let row = rows.find(items => Math.abs(items[0].y - bubble.y) < 0.5);
    if (!row) { row = []; rows.push(row); }
    row.push(bubble);
  }
  rows.sort((a, b) => a[0].y - b[0].y);
  rows.forEach(row => row.sort((a, b) => a.x - b.x));
  assert.deepEqual(rows.map(row => row.length), [3, 4, 3, 4]);
  const pitch = rows[1][1].x - rows[1][0].x;
  assert.ok(Math.abs((rows[0][0].x - rows[1][0].x) - pitch / 2) < 0.75, 'Short rows must be offset by half a pocket pitch.');
  assert.ok(Math.abs(rows[0][0].x - rows[2][0].x) < 0.5);
  assert.ok(Math.abs(rows[1][0].x - rows[3][0].x) < 0.5);
  // Include the sealed lip and the stretched footprint, rather than only the
  // smaller circular DOM hit targets. Leave room for finger deformation.
  let minimumGap = Infinity;
  for (let i = 0; i < geometry.length; i++) for (let j = i + 1; j < geometry.length; j++) {
    const a = geometry[i], b = geometry[j];
    const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.radius + b.radius) * 1.14;
    minimumGap = Math.min(minimumGap, gap);
    assert.ok(gap >= -0.2, `Visible pockets ${i + 1} and ${j + 1} overlap by ${-gap}px.`);
  }
  const viewportWidth = await page.evaluate(() => innerWidth);
  for (const bubble of geometry) {
    assert.ok(bubble.x - bubble.radius * 1.14 >= -0.5);
    assert.ok(bubble.x + bubble.radius * 1.14 <= viewportWidth + 0.5);
  }
  return { rowCounts: rows.map(row => row.length), pitch, minimumVisibleGapPx: minimumGap, viewportWidth };
}

async function captureFilmReflections(page, label, referenceLabel = null) {
  // WebGL clears its drawing buffer after presentation. Render once and read
  // immediately in the same browser task; production frames incur no readback.
  return page.evaluate(({ label, referenceLabel }) => {
    const renderer=window.__filmRenderer,layout=window.__filmLayout;
    renderer.render(window.__bubbleStates,layout,window.__filmDark,window.__filmTime,window.__lastLight);
    const gl=renderer.gl,width=renderer.canvas.width,height=renderer.canvas.height,dpr=renderer.dpr;
    const pixels=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    if(gl.getError()!==gl.NO_ERROR) throw new Error('Reflection snapshot WebGL readback failed.');
    const snapshots=window.__filmPixelSnapshots??=new Map();
    const reference=referenceLabel?snapshots.get(referenceLabel):null;
    if(referenceLabel&&(!reference||reference.width!==width||reference.height!==height)) throw new Error('Reflection snapshots must use the same canvas geometry.');
    const pockets=layout.map((p,index)=>{
      let whitePixels=0,sumX=0,sumY=0,surfacePixels=0,changedPixels=0,totalDifference=0;
      const reach=p.radius*.9;
      for(let y=Math.max(0,Math.floor((p.y-reach)*dpr));y<Math.min(height,Math.ceil((p.y+reach)*dpr));y++) {
        for(let x=Math.max(0,Math.floor((p.x-reach)*dpr));x<Math.min(width,Math.ceil((p.x+reach)*dpr));x++) {
          const cssX=(x+.5)/dpr,cssY=(y+.5)/dpr;
          if(Math.hypot(cssX-p.x,cssY-p.y)>reach) continue;
          const offset=((height-1-y)*width+x)*4;
          surfacePixels++;
          // The broad white source core clips near white. The shoulder and lip
          // sit outside this crop, so their thin arcs cannot dominate its centre.
          if(Math.min(pixels[offset],pixels[offset+1],pixels[offset+2],pixels[offset+3])>=245) {
            whitePixels++;sumX+=cssX;sumY+=cssY;
          }
          if(reference) {
            const difference=(Math.abs(pixels[offset]-reference.pixels[offset])+Math.abs(pixels[offset+1]-reference.pixels[offset+1])+Math.abs(pixels[offset+2]-reference.pixels[offset+2]))/3;
            totalDifference+=difference;if(difference>5) changedPixels++;
          }
        }
      }
      const b=window.__bubbleStates[index];
      const highlight=whitePixels?{x:sumX/whitePixels-p.x,y:sumY/whitePixels-p.y}:null;
      return {index,popped:b.popped,whitePixels,highlight,surfacePixels,
        ...(reference?{changedFraction:changedPixels/surfacePixels,meanDifference:totalDifference/surfacePixels}:{}),
        state:{seed:b.seed,popped:b.popped,popX:b.popX,popY:b.popY,x:b.x,y:b.y,compression:b.compression,bulge:b.bulge,collapse:b.collapse}};
    });
    snapshots.set(label,{width,height,pixels});
    const geometry=[...document.querySelectorAll('.bubble-target')].map(button=>{
      const rect=button.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
    });
    return {light:{...window.__lastLight},width,height,dpr,geometry,pockets};
  },{label,referenceLabel});
}

function assertReflectionOrbit(neutral, tilted) {
  assert.deepEqual(tilted.geometry,neutral.geometry,'Sensor lighting must preserve every pocket hit area.');
  const movements=neutral.pockets.map((before,index)=>{
    const after=tilted.pockets[index];
    for(const key of ['seed','popped','popX','popY']) assert.equal(after.state[key],before.state[key],`Lighting must preserve pocket ${index+1} ${key}.`);
    for(const key of ['x','y','compression','bulge','collapse']) assert.ok(Math.abs(after.state[key]-before.state[key])<.002,`Lighting must preserve pocket ${index+1} ${key}.`);
    assert.ok(after.changedFraction>.06&&after.meanDifference>1.5,`Pocket ${index+1} must visibly change its reflected light, including collapsed film.`);
    if(before.popped) return {index,popped:true,changedFraction:after.changedFraction,meanDifference:after.meanDifference};
    assert.ok(before.whitePixels>20&&after.whitePixels>20,`Pocket ${index+1} must retain a measurable broad white core.`);
    const displacementPx=Math.hypot(after.highlight.x-before.highlight.x,after.highlight.y-before.highlight.y);
    const a=Math.atan2(before.highlight.y,before.highlight.x),b=Math.atan2(after.highlight.y,after.highlight.x);
    const orbitDegrees=Math.abs(Math.atan2(Math.sin(b-a),Math.cos(b-a)))*180/Math.PI;
    assert.ok(displacementPx>=7||orbitDegrees>=15,`Pocket ${index+1} reflection barely moved: ${displacementPx.toFixed(2)}px / ${orbitDegrees.toFixed(2)}°.`);
    return {index,popped:false,displacementPx,orbitDegrees,changedFraction:after.changedFraction};
  });
  assert.ok(movements.some(p=>p.popped)&&movements.some(p=>!p.popped),'The rendered regression must exercise both intact and popped film.');
  return movements;
}

try {
  const { page } = await context({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  await check('desktop renders fourteen pockets without the WebGL error state', async () => {
    assert.equal(await page.locator('.bubble-target').count(), 14);
    assert.equal(await page.locator('#render-error').isVisible(), false);
    const fieldPadding = await page.evaluate(() => {
      const stage = document.querySelector('.playground').getBoundingClientRect();
      const pockets = __filmLayout;
      return {
        horizontal: Math.min(...pockets.map(p => p.x - p.radius)),
        vertical: Math.min(...pockets.map(p => p.y - p.radius)),
        width: stage.width,
        height: stage.height,
      };
    });
    const filmMask = await page.evaluate(() => {
      const sheet = document.querySelector('#sheet');
      return {
        filmIsInsideSheet: sheet.contains(document.querySelector('#film')),
        targetsAreInsideSheet: sheet.contains(document.querySelector('#targets')),
        burstsAreInsideSheet: sheet.contains(document.querySelector('#bursts')),
        overflow: getComputedStyle(sheet).overflow,
        transform: getComputedStyle(sheet).transform,
      };
    });
    assert.deepEqual(filmMask, {
      filmIsInsideSheet: true,
      targetsAreInsideSheet: true,
      burstsAreInsideSheet: true,
      overflow: 'hidden',
      transform: 'none',
    }, 'The unrotated film field is the clipping parent for every visual layer.');
    assert.ok(fieldPadding.horizontal >= 48 && fieldPadding.horizontal < 52, 'Desktop keeps a compact horizontal margin around the bubbles.');
    assert.ok(fieldPadding.vertical >= 48 && fieldPadding.vertical < 52, 'Desktop keeps a compact vertical margin around the bubbles.');
    await screenshot(page, 'desktop-dark.png');
    return { fieldPadding, ...await inspectStaggeredLayout(page) };
  });
  await check('film keeps progress announcements for assistive technology without visual status copy', async () => {
    assert.equal(await page.locator('.below-film').count(), 0);
    assert.equal(await page.locator('#announcement').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('#announcement').getAttribute('class'), 'sr-only');
    const box = await page.locator('#announcement').boundingBox();
    assert.ok(box.width <= 1 && box.height <= 1);
  });
  await check('short real mouse click does not pop later', async () => {
    const p = await center(page);
    await page.mouse.click(p.x, p.y, { delay: 75 });
    await page.waitForTimeout(950);
    assert.equal(await count(page), 0);
    assert.equal(await page.evaluate(() => __bubbleStates[4].compression), 0);
  });
  await check('off-center press deforms then restores on early release', async () => {
    await page.evaluate(() => __bubbleStates[4].setHoldDuration(0.8));
    const p = await center(page, 4, -0.32, 0.16);
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    await page.waitForTimeout(220);
    const state = await page.evaluate(() => ({ x: __bubbleStates[4].x, y: __bubbleStates[4].y, bulge: __bubbleStates[4].bulge, compression: __bubbleStates[4].compression }));
    assert.ok(state.x < -0.5 && state.y > 0.25 && state.compression > 0.2 && state.bulge > 0.08);
    await screenshot(page, 'desktop-edge-press.png');
    await page.mouse.up();
    await page.waitForTimeout(900);
    assert.equal(await count(page), 0);
    assert.equal(await page.evaluate(() => __bubbleStates[4].compression), 0);
    await page.evaluate(() => __bubbleStates[4].setHoldDuration(0.3));
    return state;
  });
  await check('continuous mouse hold pops once and leaves a collapsed pocket', async () => {
    const p = await center(page);
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    const start = Date.now();
    await waitPopped(page);
    const elapsedMs = Date.now() - start;
    await screenshot(page, 'desktop-burst.png');
    await page.waitForTimeout(500);
    await page.mouse.up();
    assert.equal(await count(page), 1);
    assert.ok(await page.evaluate(() => __bubbleStates[4].collapse > 0.99));
    await screenshot(page, 'desktop-popped.png');
    await page.mouse.click(p.x, p.y, { delay: 850 });
    assert.equal(await count(page), 1);
    return { elapsedMs };
  });
  await check('popped film yields under dragging, settles, and never bursts again', async () => {
    const read=()=>page.evaluate(()=>{
      const b=__bubbleStates[4];return {active:b.active,x:b.x,y:b.y,compression:b.compression,bulge:b.bulge,popX:b.popX,popY:b.popY,collapse:b.collapse};
    });
    const before=await read(),announcement=await page.locator('#announcement').textContent();
    const p=await center(page,4,-.24,.1);
    await page.mouse.move(p.x,p.y);await page.mouse.down();await page.waitForTimeout(200);
    const held=await read();
    assert.ok(held.active&&held.compression>.12&&held.compression<.2&&held.bulge===0);
    await page.mouse.move(p.x+25,p.y-12);await page.waitForTimeout(950);
    const moved=await read();assert.ok(moved.x>held.x+.4&&moved.y<held.y-.2);
    assert.deepEqual([moved.popX,moved.popY],[before.popX,before.popY]);
    assert.equal(await count(page),1);assert.equal(await page.locator('#announcement').textContent(),announcement);
    assert.equal(await page.locator('.bubble-target').nth(4).getAttribute('aria-disabled'),null);
    await screenshot(page,'desktop-popped-kneading.png');
    await page.mouse.up();await page.waitForTimeout(850);
    const released=await read();assert.ok(!released.active&&Math.abs(released.compression-.06)<.001&&released.bulge===0);
    assert.ok(Math.hypot(released.x,released.y)<.001);assert.ok(released.collapse>.99);
    return {held,moved,released};
  });
  await check('reset restores all fourteen pockets', () => reset(page));
  await check('three icon controls and modal support focus, escape, backdrop and saved timing', async () => {
    assert.equal(await page.locator('.topbar-actions > button').count(),3);
    assert.equal((await page.locator('#theme').textContent()).trim(),'');
    await page.locator('#settings-open').click();assert.equal(await page.locator('#settings').isVisible(),true);
    assert.equal(await page.locator('#hold').inputValue(),'0.3');
    await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'motion');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-close');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#settings').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-open');
    await page.locator('#settings-open').click();await page.locator('#hold').fill('1.4');
    await page.mouse.click(3,3);assert.equal(await page.locator('#settings').isVisible(),false);
    const p=await center(page);await page.mouse.move(p.x,p.y);await page.mouse.down();
    await page.waitForTimeout(1000);assert.equal(await count(page),0);await page.mouse.up();
    await page.locator('#settings-open').click();await page.locator('#hold').fill('0.24');await page.locator('#settings-close').click();
    await page.reload();await page.waitForFunction(()=>__bubbleStates?.length===14);
    assert.ok(await page.evaluate(()=>__bubbleStates.every(b=>b.holdDuration===.24)));
    const q=await center(page);await page.mouse.move(q.x,q.y);await page.mouse.down();await waitPopped(page,4,1200);await page.mouse.up();
    await page.locator('#settings-open').click();await page.locator('#hold').fill('0.3');await page.locator('#settings-close').click();
    await reset(page);
  });
  await check('edge rupture contact stays fixed after release, theme toggle and resize', async () => {
    const originalViewport = page.viewportSize();
    const originalTheme = await page.locator('html').getAttribute('data-theme');
    const readContact = () => page.evaluate(() => ({ popX: __bubbleStates[4].popX, popY: __bubbleStates[4].popY }));
    try {
      const p = await center(page, 4, 0.34, -0.13);
      await page.mouse.move(p.x, p.y); await page.mouse.down();
      await waitPopped(page);
      const contact = await readContact();
      assert.ok(Math.abs(contact.popX - 0.68) < 0.025 && Math.abs(contact.popY + 0.26) < 0.025,
        'The rupture must preserve the actual off-centre mouse contact.');
      await page.mouse.up(); await page.waitForTimeout(500);
      assert.deepEqual(await readContact(), contact, 'Release and settling must not recenter the rupture.');

      await page.locator('#theme').click();
      assert.notEqual(await page.locator('html').getAttribute('data-theme'), originalTheme);
      assert.deepEqual(await readContact(), contact, 'Changing the lighting theme must preserve the rupture.');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      assert.deepEqual(await readContact(), contact, 'Resizing the film must preserve normalized rupture coordinates.');
      assert.equal(await page.locator('.bubble-target').nth(4).getAttribute('data-popped'), 'true');
      if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.locator('#theme').click();
      await screenshot(page, 'edge-pop-light.png');
      return { ...contact, resizedViewport: { width: 390, height: 844 } };
    } finally {
      await page.mouse.up();
      await page.setViewportSize(originalViewport);
      if (await page.locator('html').getAttribute('data-theme') !== originalTheme) await page.locator('#theme').click();
      await reset(page);
    }
  });
  for (const cancellation of ['pointercancel', 'lostpointercapture', 'move-away']) {
    await check(`${cancellation} cancels an incomplete hold`, async () => {
      await reset(page);
      await page.evaluate(() => __bubbleStates[4].setHoldDuration(1));
      try {
        const p = await center(page);
        await page.mouse.move(p.x, p.y); await page.mouse.down();
        await page.waitForTimeout(200);
        // First flush the initial pending capture so there is an actual capture
        // to lose; releasing before gotpointercapture produces no lost event.
        if (cancellation === 'lostpointercapture') await page.mouse.move(p.x + 1, p.y);
        if (cancellation === 'move-away') {
          const next=await center(page,5);
          await page.mouse.move((p.x+next.x)/2,p.y);
        }
        else await page.locator('.bubble-target').nth(4).evaluate((button, type) => {
          if (type === 'lostpointercapture') button.releasePointerCapture(1);
          else button.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
        }, cancellation);
        // Pointer capture changes are delivered when the next pointer event is
        // processed. A real movement flushes that pending browser transition.
        if (cancellation === 'lostpointercapture') await page.mouse.move(p.x + 2, p.y);
        await page.waitForTimeout(950); await page.mouse.up();
        assert.equal(await count(page), 0);
        assert.equal(await page.evaluate(() => __bubbleStates[4].active), false);
      } finally {
        await page.evaluate(() => __bubbleStates[4].setHoldDuration(.3));
      }
    });
  }
  for (const key of ['Space', 'Enter']) {
    await check(`short ${key} does not trigger a synthetic-click delayed pop`, async () => {
      await reset(page);
      await page.locator('.bubble-target').nth(4).focus();
      await page.keyboard.press(key, { delay: 80 });
      await page.waitForTimeout(950);
      assert.equal(await count(page), 0);
      assert.equal(await page.evaluate(() => __bubbleStates[4].active), false);
    });
  }
  await check('keyboard hold is usable and reset still works', async () => {
    await page.locator('.bubble-target').nth(4).focus();
    await page.keyboard.down('Space'); await waitPopped(page); await page.keyboard.up('Space');
    assert.equal(await count(page), 1);
    await reset(page);
  });
  await check('light theme persists after reload', async () => {
    await page.locator('#theme').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.reload(); await page.waitForFunction(() => __bubbleStates?.length === 14);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.waitForTimeout(200); await screenshot(page, 'desktop-light.png');
  });
  await check('sound mute persists and can be enabled again', async () => {
    await page.locator('#sound').click();
    assert.equal(await page.locator('#sound').getAttribute('aria-pressed'), 'false');
    await page.reload(); await page.waitForFunction(() => __bubbleStates?.length === 14);
    assert.equal(await page.locator('#sound').getAttribute('aria-pressed'), 'false');
    await page.locator('#sound').click();
    assert.equal(await page.locator('#sound').getAttribute('aria-pressed'), 'true');
  });
  await check('synthesized audio waveform is finite, brief and below clipping', async () => {
    const waveform = await page.evaluate(async () => {
      const { PopAudio } = await import('./js/audio/effects.js');
      const audio = new PopAudio();
      audio.context = new OfflineAudioContext(1, 6615, 49000);
      return [1089, 4207, 9817, 26131].map(seed => {
        const buffer = audio.makeSnap(seed); const data = buffer.getChannelData(0);
        let peak = 0, energy = 0, finite = true, tailPeak = 0;
        for (let i = 0; i < data.length; i++) {
          finite &&= Number.isFinite(data[i]); peak = Math.max(peak, Math.abs(data[i])); energy += data[i] * data[i];
          if (i > data.length * .9) tailPeak = Math.max(tailPeak, Math.abs(data[i]));
        }
        return { seed, duration: buffer.duration, finite, peak, rms: Math.sqrt(energy / data.length), tailPeak };
      });
    });
    for (const item of waveform) assert.ok(item.finite && item.peak <= 0.961 && item.rms > 0.025 && item.duration < 0.15 && item.tailPeak < 0.01);
    return waveform;
  });

  const { ctx: mobileContext, page: mobile } = await context({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cdp = await mobileContext.newCDPSession(mobile);
  await check('mobile touch tap does not pop after release', async () => {
    const p = await center(mobile); await mobile.touchscreen.tap(p.x, p.y);
    await mobile.waitForTimeout(950); assert.equal(await count(mobile), 0);
  });
  await check('moving a touch from the film suppresses the browser default gesture', async () => {
    const prevented = await mobile.locator('.bubble-target').nth(4).evaluate(target => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, true);
  });
  await check('two simultaneous touches independently pop two pockets', async () => {
    const a = await center(mobile, 3), b = await center(mobile, 5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1, radiusX: 7, radiusY: 7, force: .5 }, { ...b, id: 2, radiusX: 7, radiusY: 7, force: .5 }] });
    await waitPopped(mobile, 3); await waitPopped(mobile, 5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await count(mobile), 2); await mobile.waitForTimeout(300);
    await screenshot(mobile, 'mobile-dark-popped.png');
  });
  await check('two fingers can knead popped film without selecting page text', async () => {
    const a=await center(mobile,3),b=await center(mobile,5);
    const announcement=await mobile.locator('#announcement').textContent();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1,force:.5},{...b,id:2,force:.5}]});
    await mobile.waitForTimeout(250);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+12,y:a.y+8,id:1,force:.5},{x:b.x-12,y:b.y-8,id:2,force:.5}]});
    await mobile.waitForTimeout(200);
    const states=await mobile.evaluate(()=>[3,5].map(i=>({compression:__bubbleStates[i].compression,active:__bubbleStates[i].active,bulge:__bubbleStates[i].bulge})));
    assert.ok(states.every(b=>b.active&&b.compression>.12&&b.bulge===0));
    assert.equal(await mobile.evaluate(()=>String(getSelection())), '');
    assert.equal(await mobile.locator('#announcement').textContent(),announcement);assert.equal(await count(mobile),2);
    assert.equal(await mobile.evaluate(()=>{const event=new Event('selectstart',{bubbles:true,cancelable:true});document.querySelector('h1').dispatchEvent(event);return event.defaultPrevented;}),true);
    assert.equal(await mobile.locator('h1').evaluate(el=>getComputedStyle(el).userSelect),'none');
    await screenshot(mobile,'mobile-popped-kneading.png');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await reset(mobile);
  });
  await check('touch cancellation stops a hold', async () => {
    await mobile.evaluate(() => __bubbleStates[4].setHoldDuration(1));
    try {
      const p = await center(mobile);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1, force: .5 }] });
      await mobile.waitForTimeout(200);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await mobile.waitForTimeout(900); assert.equal(await count(mobile), 0);
    } finally {
      await mobile.evaluate(() => __bubbleStates[4].setHoldDuration(.3));
    }
  });
  await check('390px mobile layout fits and can switch to light', async () => {
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const presentation = await mobile.evaluate(() => {
      const motion = document.querySelector('#motion');
      const stage = document.querySelector('.playground').getBoundingClientRect();
      return {
        motionUsesTiltSwitch: motion.getAttribute('role') === 'switch'
          && motion.closest('.ios-switch')?.querySelector('.switch-track') !== null,
        stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    assert.equal(presentation.motionUsesTiltSwitch, true);
    assert.deepEqual(presentation.stage, { x: 0, y: 0, ...presentation.viewport });
    assert.equal(await mobile.locator('.sheet').evaluate(sheet => getComputedStyle(sheet).boxShadow), 'none');
    await mobile.locator('#theme').tap(); await mobile.waitForTimeout(200);
    await screenshot(mobile, 'mobile-light.png');
    return inspectStaggeredLayout(mobile);
  });
  await check('320px mobile layout and maximum size stay within viewport', async () => {
    await mobile.setViewportSize({ width: 320, height: 680 });
    await mobile.locator('#settings-open').tap();
    await mobile.locator('#size').fill('100');
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const bounds = await mobile.locator('.playground').boundingBox();
    assert.equal(bounds.x, 0);
    assert.equal(bounds.y, 0);
    assert.equal(bounds.width, await mobile.evaluate(() => innerWidth));
    assert.equal(bounds.height, await mobile.evaluate(() => innerHeight));
    await screenshot(mobile, 'mobile-320-light.png');
    await mobile.locator('#settings-close').tap();
    return { bounds, ...await inspectStaggeredLayout(mobile) };
  });

  const { page: reduced } = await context({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
  await check('system reduced motion is selected by default and popping still works', async () => {
    assert.equal(await reduced.locator('#motion').isChecked(), true);
    const p = await center(reduced); await reduced.mouse.move(p.x, p.y); await reduced.mouse.down();
    await waitPopped(reduced); await reduced.mouse.up();
    assert.equal(await count(reduced), 1);
  });
  const {page:tilt}=await context({viewport:{width:390,height:844},initScript:()=>{
    window.__permissionCalls=0;
    Object.defineProperty(window,'DeviceOrientationEvent',{configurable:true,value:class extends Event {static async requestPermission(){window.__permissionCalls++;return 'granted';}}});
  }});
  await check('orientation permission is explicit; bounded light moves intact and popped film',async()=>{
    assert.equal(await tilt.evaluate(()=>__permissionCalls),0);
    const p=await center(tilt);await tilt.mouse.move(p.x,p.y);await tilt.mouse.down();await waitPopped(tilt);await tilt.mouse.up();
    assert.equal(await tilt.evaluate(()=>__permissionCalls),0);
    await tilt.locator('#settings-open').click();
    assert.equal(await tilt.locator('#tilt').isChecked(),true);
    await tilt.locator('#tilt-permission').click();
    assert.equal(await tilt.evaluate(()=>__permissionCalls),1);await tilt.locator('#settings-close').click();
    await tilt.evaluate(()=>{const event=new Event('deviceorientation');Object.assign(event,{alpha:355,beta:40,gamma:0});window.dispatchEvent(event);});
    await tilt.waitForTimeout(400);
    const initial=await tilt.evaluate(()=>({...__lastLight}));
    const neutral=await captureFilmReflections(tilt,'sensor-neutral');
    for(let i=0;i<12;i++){
      await tilt.evaluate(()=>{const event=new Event('deviceorientation');Object.assign(event,{alpha:25,beta:72,gamma:28});window.dispatchEvent(event);});
      await tilt.waitForTimeout(35);
    }
    await tilt.waitForTimeout(450);
    const shifted=await tilt.evaluate(()=>({...__lastLight}));
    assert.ok(Math.hypot(shifted.x,shifted.y)>.03&&Math.hypot(shifted.x,shifted.y)<=.17);
    assert.ok(Math.abs(shifted.angle)>.25&&Math.abs(shifted.angle)<=.95,'An ordinary phone tilt must noticeably rotate the reflected source.');
    assert.ok(Math.hypot(shifted.x-initial.x,shifted.y-initial.y)>.03);assert.equal(await count(tilt),1);
    const tilted=await captureFilmReflections(tilt,'sensor-tilted','sensor-neutral');
    const reflectionMovements=assertReflectionOrbit(neutral,tilted);
    await screenshot(tilt,'mobile-tilt-dark.png');await tilt.locator('#theme').click();await tilt.waitForTimeout(150);await screenshot(tilt,'mobile-tilt-light.png');
    await tilt.locator('#settings-open').click();await tilt.locator('#motion').check();await tilt.waitForTimeout(120);
    assert.deepEqual(await tilt.evaluate(()=>({...__lastLight})),{x:0,y:0,angle:0});
    assert.equal(await tilt.locator('#tilt').isChecked(),true);
    assert.equal(await tilt.locator('#tilt').isDisabled(),false);
    await tilt.locator('#motion').uncheck();
    await tilt.locator('#settings-close').click();
    return {initial,shifted,permissionCalls:1,reflectionMovements};
  });
  await check('tilt switch preserves both choices on reload and reuses granted sensor events without a prompt',async()=>{
    await tilt.reload();await tilt.waitForFunction(()=>__bubbleStates?.length===14);
    await tilt.locator('#settings-open').click();
    assert.equal(await tilt.locator('#tilt').getAttribute('role'),'switch');
    assert.equal(await tilt.locator('#tilt').isChecked(),true);
    assert.equal(await tilt.evaluate(()=>__permissionCalls),0);
    assert.equal(await tilt.locator('#tilt-permission').isVisible(),true);
    await tilt.evaluate(()=>{const event=new Event('deviceorientation');Object.assign(event,{alpha:0,beta:30,gamma:0});window.dispatchEvent(event);});
    assert.equal(await tilt.locator('#tilt-permission').isVisible(),false);
    for(let i=0;i<12;i++){
      await tilt.evaluate(()=>{const event=new Event('deviceorientation');Object.assign(event,{alpha:20,beta:58,gamma:26});window.dispatchEvent(event);});
      await tilt.waitForTimeout(35);
    }
    await tilt.waitForTimeout(350);
    assert.ok(await tilt.evaluate(()=>Math.hypot(__lastLight.x,__lastLight.y)>.035));
    assert.ok(await tilt.evaluate(()=>Math.abs(__lastLight.angle)>.25&&Math.abs(__lastLight.angle)<=.95),'Reloaded sensor events must still orbit the reflections.');
    assert.equal(await tilt.evaluate(()=>__permissionCalls),0);
    await tilt.locator('#tilt').uncheck();
    assert.equal(await tilt.evaluate(()=>localStorage.getItem('bubble.tilt')),'false');
    await tilt.reload();await tilt.waitForFunction(()=>__bubbleStates?.length===14);
    await tilt.locator('#settings-open').click();
    assert.equal(await tilt.locator('#tilt').isChecked(),false);
    assert.equal(await tilt.locator('#tilt-permission').isVisible(),false);
    assert.equal(await tilt.evaluate(()=>__permissionCalls),0);
    await tilt.locator('#tilt').check();
    assert.equal(await tilt.evaluate(()=>localStorage.getItem('bubble.tilt')),'true');
    assert.equal(await tilt.evaluate(()=>__permissionCalls),1);
    await tilt.waitForTimeout(250);
    await screenshot(tilt,'mobile-settings-tilt-on.png');
    await tilt.locator('#settings-close').click();
  });
  await check('native permission blur keeps switch pending and a denial restores its retry action',async()=>{
    const {page:prompt}=await context({viewport:{width:390,height:844},initScript:()=>{
      Object.defineProperty(window,'DeviceOrientationEvent',{configurable:true,value:class extends Event {
        static requestPermission(){return new Promise(resolve=>window.__resolvePermission=resolve);}
      }});
    }});
    await prompt.locator('#settings-open').click();await prompt.locator('#tilt-permission').click();
    await prompt.evaluate(()=>window.dispatchEvent(new Event('blur')));
    assert.equal(await prompt.locator('#tilt').isChecked(),true);
    assert.equal(await prompt.locator('#tilt').isDisabled(),true);
    assert.match(await prompt.locator('#tilt-status').textContent(),/Ждём разрешения/);
    await prompt.evaluate(()=>__resolvePermission('denied'));
    assert.equal(await prompt.locator('#tilt').isDisabled(),false);
    assert.equal(await prompt.locator('#tilt-permission').isVisible(),true);
    assert.match(await prompt.locator('#tilt-status').textContent(),/Доступ к движению закрыт/);
    await prompt.locator('#tilt-permission').click();
    await prompt.evaluate(()=>__resolvePermission('granted'));
    assert.equal(await prompt.locator('#tilt').isDisabled(),false);
    assert.equal(await prompt.locator('#tilt-permission').isVisible(),false);
  });
  await check('final reloaded renderer screenshots and all-popped frame sample', async () => {
    await page.reload(); await page.waitForFunction(() => __bubbleStates?.length === 14);
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.locator('#theme').click();
    await page.waitForTimeout(250); await screenshot(page, 'desktop-dark.png');
    await page.evaluate(() => __bubbleStates[4].setHoldDuration(0.8));
    const edge = await center(page, 4, -0.32, 0.16);
    await page.mouse.move(edge.x, edge.y); await page.mouse.down(); await page.waitForTimeout(220);
    await screenshot(page, 'desktop-edge-press.png'); await page.mouse.up(); await page.waitForTimeout(500);
    await page.evaluate(() => __bubbleStates[4].setHoldDuration(0.3));
    const p = await center(page, 13);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await waitPopped(page, 13);
    await screenshot(page, 'desktop-burst.png'); await page.mouse.up(); await page.waitForTimeout(500);
    await page.locator('.bubble-target').evaluateAll(buttons => [1, 5, 8].forEach(index => buttons[index].click()));
    await page.waitForFunction(() => document.querySelectorAll('.bubble-target[data-popped="true"]').length === 4);
    await page.waitForTimeout(400);
    await screenshot(page, 'desktop-popped.png');
    await page.locator('#theme').click(); await page.waitForTimeout(200); await screenshot(page, 'desktop-light.png');
    await page.locator('#theme').click();
    // Use the same public interaction events, with assistive activation, to
    // keep all fourteen pockets animating at once for the inexpensive frame sample.
    await page.locator('.bubble-target').evaluateAll(buttons => buttons.forEach(button => button.click()));
    await page.waitForFunction(() => document.querySelectorAll('.bubble-target[data-popped="true"]').length === 14);
    const frameSample = await page.evaluate(async () => {
      const samples = [];
      let previous = performance.now();
      for (let i = 0; i < 40; i++) {
        const now = await new Promise(resolve => requestAnimationFrame(resolve));
        samples.push(now - previous); previous = now;
        document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 100 + i, clientY: 100 }));
      }
      samples.shift(); samples.sort((a, b) => a - b);
      return { count: samples.length, medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1), note: 'Headless Chromium timing, not a mobile-device performance claim.' };
    });
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.reload(); await mobile.waitForFunction(() => __bubbleStates?.length === 14);
    await mobile.evaluate(() => { localStorage.setItem('bubble.size', '84'); localStorage.setItem('bubble.theme', 'light'); });
    await mobile.reload(); await mobile.waitForFunction(() => __bubbleStates?.length === 14);
    await mobile.waitForTimeout(250); await screenshot(mobile, 'mobile-light.png');
    await mobile.evaluate(() => __bubbleStates[4].setHoldDuration(0.8));
    const pressPoint = await center(mobile, 4, -0.32, 0.16);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pressPoint, id: 1, force: .5 }] });
    await mobile.waitForTimeout(220); await screenshot(mobile, 'mobile-mid-press.png');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await mobile.waitForTimeout(500);
    await mobile.evaluate(() => __bubbleStates[4].setHoldDuration(0.3));
    await mobile.locator('#theme').tap();
    const mp = await center(mobile);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...mp, id: 1, force: .5 }] });
    await waitPopped(mobile);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await mobile.locator('.bubble-target').evaluateAll(buttons => [1, 8, 12].forEach(index => buttons[index].click()));
    await mobile.waitForFunction(() => document.querySelectorAll('.bubble-target[data-popped="true"]').length === 4);
    await mobile.waitForTimeout(300); await screenshot(mobile, 'mobile-dark-popped.png');
    await mobile.locator('main').screenshot({ path: path.join(output, 'mobile-dark-preview.png') });
    report.screenshots.push('mobile-dark-preview.png');
    await mobile.locator('#theme').tap(); await mobile.waitForTimeout(250);
    await screenshot(mobile, 'mobile-light-popped.png');
    await mobile.locator('main').screenshot({ path: path.join(output, 'mobile-light-preview.png') });
    report.screenshots.push('mobile-light-preview.png');
    await writeFile(path.join(output, 'comparison.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Bubble — сравнение тем</title><style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#d5dde2;font-family:system-ui;color:#25333d}h1{font-size:21px;font-weight:500;margin:0 0 8px}p{font-size:13px;margin:0 0 22px}section{display:flex;gap:24px;align-items:flex-start}figure{margin:0;width:390px}figcaption{font-size:12px;margin-bottom:10px}img{display:block;width:390px;height:auto;border-radius:12px}</style><h1>Пупырчатая плёнка · 3–4–3–4</h1><p>Одинаковые 14 пузырьков. Четыре лопнувших сохраняют форму в обеих темах.</p><section><figure><figcaption>Тёмная тема</figcaption><img src="mobile-dark-preview.png" alt="Тёмная тема с четырьмя лопнувшими пузырьками"></figure><figure><figcaption>Светлая тема</figcaption><img src="mobile-light-preview.png" alt="Светлая тема с теми же четырьмя лопнувшими пузырьками"></figure></section></html>`);
    const comparison = await page.context().newPage();
    await comparison.setViewportSize({ width: 860, height: 1100 });
    await comparison.goto(pathToFileURL(path.join(output, 'comparison.html')).href);
    await comparison.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
    const comparisonHeight = await comparison.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await comparison.setViewportSize({ width: 860, height: comparisonHeight });
    await screenshot(comparison, 'comparison.png');
    await comparison.close();
    return frameSample;
  });
  await check('no application console or runtime errors', async () => assert.deepEqual(report.errors, []));

  const matchedWebkit = available.find(item => existsSync(path.join(homedir(), 'Library/Caches/ms-playwright', `webkit-${item.webkitRevision}`)));
  if (!matchedWebkit) report.limitations.push('Installed WebKit revision 2272 has no matching discovered Playwright package; WebKit was not launched. No browser/package was installed.');
  report.limitations.push('Mobile results use Chromium touch emulation, not physical iOS/Android devices. Audio was checked as generated waveform data; no listening claim is made.');
} finally {
  for (const ctx of activeContexts) await ctx.close();
  await browser.close();
  report.summary = { passed: report.checks.filter(item => item.status === 'passed').length, failed: report.checks.filter(item => item.status === 'failed').length };
  await writeFile(path.join(output, screenshotsOnly ? 'visual-report.json' : 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
}
process.exitCode = report.summary.failed ? 1 : 0;

async function runWebKitSmoke() {
  const modulePath = process.env.WEBKIT_MODULE || 'playwright-core/index.mjs';
  const { webkit } = await import(pathToFileURL(modulePath));
  const results = { browser: 'WebKit', checks: [], errors: [], limitations: ['Mobile viewport and touch tap are emulated; continuous hold uses real mouse input in the WebKit engine. This is not physical iOS validation.'] };
  const webkitBrowser = await webkit.launch({ headless: true });
  const ctx = await webkitBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', error => results.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') results.errors.push(message.text()); });
  const check = async (name, fn) => {
    try { await fn(); results.checks.push({ name, status: 'passed' }); console.log(`PASS WebKit ${name}`); }
    catch (error) { results.checks.push({ name, status: 'failed', message: error.message }); console.log(`FAIL WebKit ${name}: ${error.message}`); }
  };
  try {
    results.version = webkitBrowser.version();
    await page.goto(baseURL); await page.waitForSelector('.bubble-target');
    await check('shader compiles and mobile layout fits', async () => {
      assert.equal(await page.locator('#render-error').isVisible(), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await inspectStaggeredLayout(page);
    });
    const rect = await page.locator('.bubble-target').nth(4).boundingBox();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await check('short touch tap never pops after release', async () => {
      await page.touchscreen.tap(x, y); await page.waitForTimeout(950);
      assert.equal(await page.locator('[data-popped="true"]').count(), 0);
    });
    await check('continuous hold pops exactly one pocket', async () => {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.waitForFunction(() => document.querySelectorAll('[data-popped="true"]').length === 1, null, { timeout: 2200 });
      await page.mouse.up(); await page.waitForTimeout(350);
      assert.equal(await page.locator('[data-popped="true"]').count(), 1);
      await page.locator('.bubble-target').evaluateAll(buttons => [1, 8, 12].forEach(index => buttons[index].click()));
      await page.waitForFunction(() => document.querySelectorAll('[data-popped="true"]').length === 4);
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(output, 'webkit-mobile-dark-popped.png'), fullPage: true });
    });
    await check('theme persists and reset restores all pockets', async () => {
      await page.locator('#theme').tap(); await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(output, 'webkit-mobile-light-popped.png'), fullPage: true });
      await page.locator('#reset').tap();
      assert.equal(await page.locator('[data-popped="true"]').count(), 0);
      await page.reload(); await page.waitForSelector('.bubble-target');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      assert.equal(await page.locator('#render-error').isVisible(), false);
    });
    await check('320px staggered rows fit without overlapping visible film', async () => {
      await page.setViewportSize({ width: 320, height: 680 });
      await page.locator('#settings-open').tap(); await page.locator('#size').fill('100');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await inspectStaggeredLayout(page);
    });
    await check('native tilt switch saves on and off without automatic permission prompts', async () => {
      await page.locator('#settings-close').tap();
      await page.addInitScript(()=>{
        window.__permissionCalls=0;
        Object.defineProperty(window,'DeviceOrientationEvent',{configurable:true,value:class extends Event {static async requestPermission(){window.__permissionCalls++;return 'granted';}}});
      });
      await page.reload();await page.locator('#settings-open').tap();
      assert.equal(await page.locator('#tilt').isChecked(),true);
      assert.equal(await page.evaluate(()=>__permissionCalls),0);
      await page.locator('#tilt-permission').tap();
      assert.equal(await page.evaluate(()=>__permissionCalls),1);
      await page.reload();await page.locator('#settings-open').tap();
      assert.equal(await page.locator('#tilt').isChecked(),true);
      assert.equal(await page.evaluate(()=>__permissionCalls),0);
      await page.evaluate(()=>{const event=new Event('deviceorientation');Object.assign(event,{alpha:0,beta:30,gamma:0});window.dispatchEvent(event);});
      assert.equal(await page.locator('#tilt-permission').isVisible(),false);
      await page.locator('#tilt').uncheck();
      await page.reload();await page.locator('#settings-open').tap();
      assert.equal(await page.locator('#tilt').isChecked(),false);
      assert.equal(await page.evaluate(()=>localStorage.getItem('bubble.tilt')),'false');
      assert.equal(await page.evaluate(()=>__permissionCalls),0);
    });
    await check('no runtime or console errors', async () => assert.deepEqual(results.errors, []));
  } finally {
    await ctx.close(); await webkitBrowser.close();
    results.summary = { passed: results.checks.filter(item => item.status === 'passed').length, failed: results.checks.filter(item => item.status === 'failed').length };
    await writeFile(path.join(output, 'webkit-report.json'), JSON.stringify(results, null, 2));
  }
  return results;
}
