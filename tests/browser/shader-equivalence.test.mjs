import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compare the current renderer with the actual pre-optimization source from
// Git. Both import the SAME current physics, sheet and membrane dependencies:
// the intended stronger coupling is therefore excluded from this regression.
// There is no app/main loop, renderer instrumentation or runtime dependency.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const ref = argument('ref') || '5ed0f93';
const baseURL = process.env.BUBBLE_URL || 'http://127.0.0.1:4174';
const origin = new URL(baseURL).origin;
const maxChannelError = 2;
const profiles = [
  { name: 'mobile-dpr1', dpr: 1 },
  { name: 'mobile-fractional-dpr', dpr: 1.25 },
  { name: 'mobile-dpr2_5', dpr: 2.5 },
];
const rendererFile = 'public/js/rendering/renderer.js';
const current = await readFile(path.join(root, rendererFile), 'utf8');
const baseline = execFileSync('git', ['show', `${ref}:${rendererFile}`], { cwd: root, encoding: 'utf8' });
assert.notEqual(current, baseline, 'The pixel oracle requires a distinct reference renderer.');
const dependencies = new Map();
for (const file of ['config.js', 'layout.js', 'physics.js', 'sheet.js', 'membrane.js']) {
  dependencies.set(`/js/core/${file}`, await readFile(path.join(root, 'public/js/core', file), 'utf8'));
}
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
const browser = await chromium.launch({ headless: true });
const report = {
  generatedAt: new Date().toISOString(), reference: ref, sourceHashes,
  browser: { chromium: browser.version(), playwright: JSON.parse(await readFile(path.join(playwrightPath, 'package.json'), 'utf8')).version },
  comparison: 'Actual reference Git renderer and current renderer; identical frozen current dependencies, seeds, geometry and state; immediate WebGL readPixels on detached canvases.',
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
        try {
          const modules = await Promise.all(moduleURLs.map(url => import(url)));
          for (const module of modules) renderers.push(new module.FilmRenderer(document.createElement('canvas')));
          const geometry = createBubbleLayout(390);
          for (const renderer of renderers) renderer.resize(geometry.width, geometry.height, dpr);
          const gl = renderers[0].gl;
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const backend = {
            renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            width: renderers[0].canvas.width, height: renderers[0].canvas.height, dpr,
          };
          const scenes = ['intact', 'offset-press', 'partial-collapse', 'fully-collapsed', 'popped-kneading'];
          const lights = [
            { name: 'neutral', x: 0, y: 0, angle: 0 },
            { name: 'rotated', x: .22, y: -.16, angle: .71 },
          ];
          let finiteUniformValues = 0, nonfiniteInputs = 0;
          for (const renderer of renderers) {
            for (const name of ['uniform1f', 'uniform2f', 'uniform4f', 'uniform4fv']) {
              const original = renderer.gl[name];
              renderer.gl[name] = function (location, ...values) {
                for (const value of values) {
                  for (const number of typeof value === 'number' ? [value] : value) {
                    finiteUniformValues++;
                    if (!Number.isFinite(number)) nonfiniteInputs++;
                  }
                }
                return original.call(this, location, ...values);
              };
            }
          }
          function statesFor(scene) {
            const states = geometry.layout.map((position, index) => new BubbleState(index));
            for (const [index, state] of states.entries()) {
              if (scene === 'offset-press') {
                if (index === 4 || index === 5) Object.assign(state, {
                  active: true, x: index === 4 ? .52 : -.38, y: index === 4 ? -.31 : .21,
                  compression: index === 4 ? .66 : .42, bulge: index === 4 ? .36 : .23, holdProgress: .68,
                });
              } else if (scene !== 'intact') {
                // Different deterministic vent positions test wrinkles across
                // every seed, rather than only one convenient cap normal.
                Object.assign(state, {
                  popped: true, popX: ((index % 3) - 1) * .43, popY: ((index % 4) - 1.5) * .22,
                  collapse: scene === 'partial-collapse' ? .45 : 1,
                  compression: scene === 'partial-collapse' ? .31 : PHYSICS_CONFIG.settledCompression,
                  popAge: scene === 'partial-collapse' ? .045 : 10,
                });
                if (scene === 'popped-kneading' && index % 3 === 1) Object.assign(state, {
                  active: true, x: -.48, y: .36, compression: .23, holdProgress: 1,
                });
              }
            }
            return states;
          }
          function read(renderer, states, dark, light) {
            for (const state of states) for (const value of Object.values(state)) {
              if (typeof value === 'number' && !Number.isFinite(value)) nonfiniteInputs++;
            }
            renderer.render(states, geometry.layout, dark, .137, light);
            for (const value of renderer.sheetState.deformation) if (!Number.isFinite(value)) nonfiniteInputs++;
            const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
            renderer.gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixels);
            const errors = [];
            for (let error = renderer.gl.getError(); error !== renderer.gl.NO_ERROR; error = renderer.gl.getError()) {
              errors.push(error);
              if (errors.length >= 8) break;
            }
            return { pixels, errors };
          }
          const checks = [];
          for (const scene of scenes) for (const dark of [false, true]) for (const light of lights) {
            const beforeNonfinite = nonfiniteInputs;
            const currentStates = statesFor(scene), referenceStates = statesFor(scene);
            if (JSON.stringify(currentStates) !== JSON.stringify(referenceStates)) throw new Error('Oracle input states differ.');
            const current = read(renderers[0], currentStates, dark, light);
            const reference = read(renderers[1], referenceStates, dark, light);
            let maximum = 0, changedPixels = 0, outsideTolerance = 0, totalDifference = 0, visiblePixels = 0;
            for (let offset = 0; offset < current.pixels.length; offset += 4) {
              let pixelError = 0;
              for (let channel = 0; channel < 4; channel++) {
                const difference = Math.abs(current.pixels[offset + channel] - reference.pixels[offset + channel]);
                maximum = Math.max(maximum, difference); pixelError = Math.max(pixelError, difference); totalDifference += difference;
              }
              if (pixelError) changedPixels++;
              if (pixelError > tolerance) outsideTolerance++;
              if (current.pixels[offset + 3] > 0) visiblePixels++;
            }
            const pixels = current.pixels.length / 4;
            const glErrors = [...current.errors, ...reference.errors];
            const nonfinite = nonfiniteInputs - beforeNonfinite;
            checks.push({
              scene, theme: dark ? 'dark' : 'light', light: light.name,
              maximumChannelError: maximum, changedPixels, mismatchRatio: changedPixels / pixels,
              pixelsOutsideTolerance: outsideTolerance, meanChannelError: totalDifference / current.pixels.length,
              visiblePixels, glErrors, nonfiniteInputs: nonfinite,
              status: maximum <= tolerance && !glErrors.length && !nonfinite && visiblePixels > pixels * .5 ? 'passed' : 'failed',
            });
          }
          return { backend, finiteUniformValues, nonfiniteInputs, checks };
        } finally {
          for (const renderer of renderers) {
            renderer.gl.deleteProgram(renderer.program);
            renderer.gl.deleteProgram(renderer.sheetProgram);
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
  await writeFile(path.join(output, 'shader-equivalence.json'), JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.summary.errors, 0, 'Shader oracle must have no browser or harness errors.');
assert.equal(report.summary.failed, 0, 'Shader optimization changed rendered pixels beyond tolerance.');
assert.equal(report.summary.passed, profiles.length * 5 * 2 * 2, 'All scene/theme/light/DPR combinations must run.');
