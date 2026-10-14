import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compare the current renderer with the actual pre-optimization source from
// Git. Both import the SAME current physics, sheet and membrane dependencies.
// Force extension availability to exercise instanced/expanded batching and the
// no-float-texture fallback. No app/main loop or package installs are involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const ref = argument('ref') || 'bac7bd1';
const baseURL = process.env.BUBBLE_URL || 'http://127.0.0.1:4174';
const origin = new URL(baseURL).origin;
const maxChannelError = 2;
const profiles = [
  { name: 'mobile-dpr1', dpr: 1 },
  { name: 'mobile-fractional-dpr', dpr: 1.25 },
  { name: 'mobile-dpr2_5', dpr: 2.5 },
].filter(profile => !argument('profiles') || argument('profiles').split(',').includes(profile.name));
assert.ok(profiles.length, 'At least one known DPR profile must be selected.');
const rendererFile = 'public/js/rendering/renderer.js';
const current = await readFile(path.join(root, rendererFile), 'utf8');
const baseline = execFileSync('git', ['show', `${ref}:${rendererFile}`], { cwd: root, encoding: 'utf8' });
assert.notEqual(current, baseline, 'The pixel oracle requires a distinct reference renderer.');
const dependencies = new Map();
for (const file of ['config.js', 'layout.js', 'physics.js', 'sheet.js', 'membrane.js']) {
  dependencies.set(`/js/core/${file}`, await readFile(path.join(root, 'public/js/core', file), 'utf8'));
}
dependencies.set('/js/rendering/bubble-batch.js', await readFile(path.join(root, 'public/js/rendering/bubble-batch.js'), 'utf8'));
const hash = source => createHash('sha256').update(source).digest('hex');
const sourceHashes = {
  currentRenderer: hash(current), referenceRenderer: hash(baseline),
  sharedDependencies: Object.fromEntries([...dependencies].map(([file, source]) => [file, hash(source)])),
};

function absoluteImports(source) {
  let imports = 0;
  const rewritten = source.replace(/\bfrom\s+(['"])(\.{1,2}\/[^'"]+)\1/g, (match, quote, specifier) => {
    imports++;
    return `from ${quote}${new URL(specifier, `${origin}/js/rendering/renderer.js`).href}${quote}`;
  });
  assert.ok(imports > 0, 'Reference and current renderers must import shared actual dependencies.');
  assert.ok(!/\bfrom\s+['"]\.{1,2}\//.test(rewritten), 'Blob module imports must resolve from the real module URL.');
  return rewritten;
}

async function installedPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  const available = [];
  const npmCache = path.join(homedir(), '.npm/_npx');
  if (existsSync(npmCache)) for (const folder of await readdir(npmCache)) {
    const packagePath = path.join(npmCache, folder, 'node_modules/playwright');
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
  if (!found) throw new Error('Installed Playwright and a matching Chromium cache are required; nothing was installed.');
  return found.path;
}

const playwrightPath = await installedPlaywright();
const { chromium } = await import(pathToFileURL(path.join(playwrightPath, 'index.mjs')));
const browserFlavor = argument('browser') || 'headless-shell';
assert.ok(['headless-shell', 'chrome-metal'].includes(browserFlavor), 'Supported browser modes: headless-shell, chrome-metal');
const browser = await chromium.launch(browserFlavor === 'chrome-metal'
  ? { headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal'] }
  : { headless: true });
const report = {
  generatedAt: new Date().toISOString(), reference: ref, browserFlavor, sourceHashes,
  browser: { chromium: browser.version(), playwright: JSON.parse(await readFile(path.join(playwrightPath, 'package.json'), 'utf8')).version },
  comparison: 'Actual reference Git renderer and current renderer; identical frozen current dependencies, seeds, geometry and state; immediate WebGL readPixels on detached canvases; forced instanced, expanded and no-float legacy paths.',
  tolerance: { maxChannelError }, checks: [], errors: [],
};

try {
  for (const profile of profiles) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: profile.dpr });
    try {
      const url = `${origin}/__shader_oracle__`;
      await context.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chpok shader equivalence</title>' }));
      for (const [file, source] of dependencies) {
        await context.route(`${origin}${file}`, route => route.fulfill({ contentType: 'text/javascript', body: source }));
      }
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ profile: profile.name, message: error.message }));
      await page.goto(url);
      const results = await page.evaluate(async ({ currentSource, baselineSource, dpr, origin, tolerance }) => {
        const [{ BubbleState }, { createBubbleLayout }, { PHYSICS_CONFIG }] = await Promise.all([
          import(`${origin}/js/core/physics.js`), import(`${origin}/js/core/layout.js`), import(`${origin}/js/core/config.js`),
        ]);
        const moduleURLs = [currentSource, baselineSource].map(source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        const renderers = [];
        let finiteInputValues = 0, nonfiniteInputs = 0;
        function checkNumbers(value) {
          if (typeof value === 'number') {
            finiteInputValues++;
            if (!Number.isFinite(value)) nonfiniteInputs++;
          } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
            for (const number of value) checkNumbers(number);
          }
        }
        function canvasFor(forcedMode) {
          const canvas = document.createElement('canvas');
          const getContext = canvas.getContext.bind(canvas);
          const observed = new Set();
          const stats = { capDraws: 0, instancedCapDraws: 0, expandedCapDraws: 0, legacyCapDraws: 0, sheetDraws: 0, capVertices: 0 };
          let renderer;
          canvas.getContext = (name, options) => {
            const gl = getContext(name, options);
            if (!gl || name !== 'webgl' || observed.has(gl)) return gl;
            observed.add(gl);
            const getExtension = gl.getExtension.bind(gl);
            const wrappedExtensions = new Set();
            gl.getExtension = extensionName => {
              if (forcedMode === 'expanded' && extensionName === 'ANGLE_instanced_arrays') return null;
              if (forcedMode === 'legacy' && extensionName === 'OES_texture_float') return null;
              const extension = getExtension(extensionName);
              if (extensionName === 'ANGLE_instanced_arrays' && extension && !wrappedExtensions.has(extension)) {
                wrappedExtensions.add(extension);
                const draw = extension.drawArraysInstancedANGLE.bind(extension);
                extension.drawArraysInstancedANGLE = (...args) => {
                  stats.capDraws++; stats.instancedCapDraws++; stats.capVertices += args[2] * args[3];
                  return draw(...args);
                };
              }
              return extension;
            };
            let activeProgram = null;
            const useProgram = gl.useProgram.bind(gl);
            gl.useProgram = program => { activeProgram = program; return useProgram(program); };
            const drawArrays = gl.drawArrays.bind(gl);
            gl.drawArrays = (...args) => {
              if (renderer && activeProgram === renderer.sheetProgram) stats.sheetDraws++;
              else {
                stats.capDraws++; stats.capVertices += args[2];
                if (args[2] > 6) stats.expandedCapDraws++; else stats.legacyCapDraws++;
              }
              return drawArrays(...args);
            };
            // Batched attributes and membrane textures replace most cap
            // uniforms. Check those uploads as well as the reference uniforms.
            for (const method of ['uniform1f', 'uniform2f', 'uniform4f', 'uniform4fv', 'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D']) {
              const original = gl[method].bind(gl);
              gl[method] = (...args) => {
                for (const value of args) checkNumbers(value);
                return original(...args);
              };
            }
            return gl;
          };
          return { canvas, stats, attach: value => { renderer = value; } };
        }
        try {
          const modules = await Promise.all(moduleURLs.map(url => import(url)));
          const referenceCanvas = canvasFor('reference');
          const reference = new modules[1].FilmRenderer(referenceCanvas.canvas);
          referenceCanvas.attach(reference); renderers.push(reference);
          const candidates = ['instanced', 'expanded', 'legacy'].map(mode => {
            const wrapper = canvasFor(mode);
            const renderer = new modules[0].FilmRenderer(wrapper.canvas);
            wrapper.attach(renderer); renderers.push(renderer);
            return { mode, renderer, stats: wrapper.stats };
          });
          const gl = reference.gl;
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const backend = {
            renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            dpr,
          };
          const scenes = ['intact', 'offset-press', 'partial-collapse', 'fully-collapsed', 'popped-kneading'];
          const lights = [
            { name: 'neutral', x: 0, y: 0, angle: 0 },
            { name: 'rotated', x: .22, y: -.16, angle: .71 },
          ];
          function statesFor(scene, geometry) {
            const states = geometry.layout.map((position, index) => new BubbleState(index));
            for (const [index, state] of states.entries()) {
              let kind = scene;
              if (scene === 'mixed-collapse') kind = ['intact', 'offset-press', 'partial-collapse', 'fully-collapsed', 'popped-kneading'][index % 5];
              if (kind === 'offset-press') {
                if (scene === 'mixed-collapse' || index === 4 || index === 5) Object.assign(state, {
                  active: true, x: index % 2 ? .52 : -.38, y: index % 2 ? -.31 : .21,
                  compression: index % 2 ? .66 : .42, bulge: index % 2 ? .36 : .23, holdProgress: .68,
                });
              } else if (kind !== 'intact') {
                // Different deterministic vent positions test wrinkles across
                // every seed, rather than only one convenient cap normal.
                Object.assign(state, {
                  popped: true, popX: ((index % 3) - 1) * .43, popY: ((index % 4) - 1.5) * .22,
                  collapse: kind === 'partial-collapse' ? .45 : 1,
                  compression: kind === 'partial-collapse' ? .31 : PHYSICS_CONFIG.settledCompression,
                  popAge: kind === 'partial-collapse' ? .045 : 10,
                });
                if (kind === 'popped-kneading' && (scene === 'mixed-collapse' || index % 3 === 1)) Object.assign(state, {
                  active: true, x: -.48, y: .36, compression: .23, holdProgress: 1,
                });
              }
            }
            return states;
          }
          function read(renderer, states, geometry, dark, light, stats) {
            for (const state of states) for (const value of Object.values(state)) {
              if (typeof value === 'number' && !Number.isFinite(value)) nonfiniteInputs++;
            }
            if (stats) for (const key of Object.keys(stats)) stats[key] = 0;
            renderer.render(states, geometry.layout, dark, .137, light);
            for (const value of renderer.sheetState.deformation) if (!Number.isFinite(value)) nonfiniteInputs++;
            const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
            renderer.gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixels);
            const errors = [];
            for (let error = renderer.gl.getError(); error !== renderer.gl.NO_ERROR; error = renderer.gl.getError()) {
              errors.push(error);
              if (errors.length >= 8) break;
            }
            return { pixels, errors, calls: stats ? { ...stats } : null };
          }
          function fitGeometry(count, clipped) {
            const width = 390, height = 344;
            const columns = Math.ceil(Math.sqrt(count * width * Math.sqrt(3) / (2 * height)));
            const rows = Math.ceil(count / columns);
            const radius = Math.min(width / ((columns + .5) * 2.5), height / ((rows - 1) * 2.5 * Math.sqrt(3) / 2 + 3));
            const pitch = radius * 2.5;
            const layout = Array.from({ length: count }, (_, index) => ({
              x: pitch * .5 + (index % columns) * pitch + (Math.floor(index / columns) % 2) * pitch * .5,
              y: radius * 1.5 + Math.floor(index / columns) * pitch * Math.sqrt(3) / 2, radius,
            }));
            if (clipped) {
              // Partial caps at all four edges plus fully culled sites in the
              // middle of the packed IDs expose row/index compaction errors.
              Object.assign(layout[0], { x: -radius * .4, y: radius * .55 });
              Object.assign(layout[count - 1], { x: width + radius * .4, y: height - radius * .5 });
              Object.assign(layout[Math.floor(count / 2)], { x: width * .52, y: -radius * .3 });
              Object.assign(layout[count - 2], { x: width * .5, y: height + radius * .45 });
              Object.assign(layout[Math.floor(count / 3)], { x: -radius * 5 });
              Object.assign(layout[Math.floor(count * 2 / 3)], { y: height + radius * 6 });
            }
            return { width, height, layout };
          }
          const fixtures = [];
          for (const [index, scene] of scenes.entries()) for (const dark of [false, true]) fixtures.push({
            scene, dark, light: lights[(index + Number(dark) + Math.round(dpr * 4)) % lights.length],
            geometry: createBubbleLayout(390), geometryName: 'original-14',
          });
          if (dpr !== 1) for (const count of [100, 500, 1000]) for (const dark of [false, true]) fixtures.push({
            scene: 'mixed-collapse', dark, light: lights[Number(dark)], geometry: fitGeometry(count, false), geometryName: `fit-${count}`,
          });
          if (dpr === 1.25) for (const count of [100, 500, 1000]) fixtures.push({
            scene: 'mixed-collapse', dark: true, light: lights[1], geometry: fitGeometry(count, true), geometryName: `clipped-${count}`,
          });
          const checks = [];
          for (const { scene, dark, light, geometry, geometryName } of fixtures) {
            for (const renderer of renderers) renderer.resize(geometry.width, geometry.height, dpr);
            const referenceStates = statesFor(scene, geometry);
            const beforeReference = nonfiniteInputs;
            const referencePixels = read(reference, referenceStates, geometry, dark, light, referenceCanvas.stats);
            const referenceNonfinite = nonfiniteInputs - beforeReference;
            for (const candidate of candidates) {
              const beforeNonfinite = nonfiniteInputs;
              const currentStates = statesFor(scene, geometry);
              if (JSON.stringify(currentStates) !== JSON.stringify(referenceStates)) throw new Error('Oracle input states differ.');
              const current = read(candidate.renderer, currentStates, geometry, dark, light, candidate.stats);
              let maximum = 0, changedPixels = 0, outsideTolerance = 0, totalDifference = 0, visiblePixels = 0;
              for (let offset = 0; offset < current.pixels.length; offset += 4) {
                let pixelError = 0;
                for (let channel = 0; channel < 4; channel++) {
                  const difference = Math.abs(current.pixels[offset + channel] - referencePixels.pixels[offset + channel]);
                  maximum = Math.max(maximum, difference); pixelError = Math.max(pixelError, difference); totalDifference += difference;
                }
                if (pixelError) changedPixels++;
                if (pixelError > tolerance) outsideTolerance++;
                if (current.pixels[offset + 3] > 0) visiblePixels++;
              }
              const pixels = current.pixels.length / 4;
              const glErrors = [...current.errors, ...referencePixels.errors];
              const nonfinite = nonfiniteInputs - beforeNonfinite + referenceNonfinite;
              const modeExercised = geometry.layout.length < 100 || (candidate.mode === 'instanced'
                ? current.calls.instancedCapDraws > 0 : candidate.mode === 'expanded'
                  ? current.calls.expandedCapDraws > 0 : current.calls.legacyCapDraws > 0 && !current.calls.instancedCapDraws && !current.calls.expandedCapDraws);
              checks.push({
                scene, geometry: geometryName, count: geometry.layout.length, mode: candidate.mode,
                actualBatchMode: current.calls.instancedCapDraws ? 'instanced' : current.calls.expandedCapDraws ? 'expanded' : 'legacy',
                helperMode: candidate.renderer.batch?.mode || null, modeExercised,
                theme: dark ? 'dark' : 'light', light: light.name,
                framebuffer: { width: candidate.renderer.canvas.width, height: candidate.renderer.canvas.height },
                maximumChannelError: maximum, changedPixels, mismatchRatio: changedPixels / pixels,
                pixelsOutsideTolerance: outsideTolerance, meanChannelError: totalDifference / current.pixels.length,
                visiblePixels, glErrors, nonfiniteInputs: nonfinite, calls: current.calls, referenceCalls: referencePixels.calls,
                status: maximum <= tolerance && !glErrors.length && !nonfinite && visiblePixels > pixels * .5 && modeExercised ? 'passed' : 'failed',
              });
            }
          }
          return { backend, finiteInputValues, nonfiniteInputs, expectedChecks: fixtures.length * candidates.length, checks };
        } finally {
          for (const renderer of renderers) {
            for (const program of new Set([renderer.program, renderer.legacyProgram, renderer.batchProgram, renderer.sheetProgram].filter(Boolean))) renderer.gl.deleteProgram(program);
            renderer.batch?.dispose?.();
            renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
            renderer.canvas.remove();
          }
          for (const url of moduleURLs) URL.revokeObjectURL(url);
        }
      }, { currentSource: absoluteImports(current), baselineSource: absoluteImports(baseline), dpr: profile.dpr, origin, tolerance: maxChannelError });
      report.checks.push({ profile: profile.name, ...results });
      const failed = results.checks.filter(check => check.status !== 'passed');
      console.log(`${failed.length ? 'FAIL' : 'PASS'} ${profile.name}: ${results.checks.length - failed.length}/${results.checks.length} scenes; maximum channel error ${Math.max(...results.checks.map(check => check.maximumChannelError))}/255; ${results.nonfiniteInputs} nonfinite inputs`);
    } finally {
      await context.close();
    }
  }
} catch (error) {
  report.errors.push({ message: error.message });
  throw error;
} finally {
  await browser.close();
  report.summary = {
    passed: report.checks.flatMap(profile => profile.checks).filter(check => check.status === 'passed').length,
    failed: report.checks.flatMap(profile => profile.checks).filter(check => check.status !== 'passed').length,
    errors: report.errors.length,
  };
  const output = path.join(root, 'artifacts');
  await mkdir(output, { recursive: true });
  const filename = browserFlavor === 'headless-shell' ? 'shader-equivalence.json' : `shader-equivalence-${browserFlavor}.json`;
  await writeFile(path.join(output, filename), JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.summary.errors, 0, 'Shader oracle must have no browser or harness errors.');
assert.equal(report.summary.failed, 0, 'Shader optimization changed rendered pixels beyond tolerance.');
assert.equal(report.summary.passed, report.checks.reduce((count, profile) => count + profile.expectedChecks, 0), 'All scene/theme/light/DPR/mode combinations must run.');
assert.equal(report.checks.length, profiles.length, 'All DPR profiles must run.');
