import assert from 'node:assert/strict';
import { readRuntimeAt } from './git-runtime.mjs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

// A render-only scaling probe. It imports a frozen snapshot of the actual
// production modules through browser routes; no benchmark code ships to users.
// Installed Playwright/browser caches only: this script never installs packages.
// Example: BUBBLE_URL=http://127.0.0.1:4175 node tests/browser/performance.test.mjs --browser=chrome-metal
// Focused shader comparison: add --paired --label=hardware-paired.
// Frozen production baseline: add --ref=46ae88a --label=batching-baseline.
// Full batching comparison: --paired --paired-ref=46ae88a --paired-deps=reference --label=batching-paired.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseURL = process.env.BUBBLE_URL || 'http://127.0.0.1:4174';
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const ref = argument('ref');
const paired = process.argv.includes('--paired');
const pairedRef = argument('paired-ref') || '46ae88a';
const pairedDependencies = argument('paired-deps') || 'current';
assert.ok(['current', 'reference'].includes(pairedDependencies), 'Paired dependencies: current or reference');
const label = argument('label') || (ref ? `baseline-${ref.slice(0, 12)}` : 'current');
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Report labels must contain letters, digits, underscores or hyphens.');
const requestedProfiles = argument('profiles')?.split(',');
const profiles = [
  { name: 'desktop', width: 1365, height: 900, dpr: 1 },
  { name: 'mobile', width: 390, height: 844, dpr: 2.5 },
  { name: 'narrow-mobile', width: 320, height: 700, dpr: 2 },
].filter(profile => requestedProfiles ? requestedProfiles.includes(profile.name) : (!paired || profile.name === 'mobile'));
const counts = argument('counts') ? argument('counts').split(',').map(Number) : [100, 500, 1000];
assert.ok(profiles.length > 0 && counts.every(count => Number.isInteger(count) && count > 0 && count <= 10000));
const entryModules = ['js/rendering/renderer.js', 'js/core/physics.js', 'js/core/sheet.js', 'js/core/config.js', 'js/core/membrane.js'];
async function captureModules(reference, entries = entryModules) {
  const captured = new Map();
  for (let index = 0; index < entries.length; index++) {
    const name = entries[index];
    if (captured.has(name)) continue;
    const source = reference
      ? readRuntimeAt(root, reference, `public/${name}`).toString('utf8')
      : await readFile(path.join(root, `public/${name}`), 'utf8');
    captured.set(name, source);
    // Resolve the actual frozen ES module graph. Optional new helpers are
    // captured only when their owning renderer imports them; old refs work.
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      if (dependency.endsWith('.js') && !captured.has(dependency)) entries.push(dependency);
    }
  }
  return captured;
}
// Each graph is read once before launch; concurrent edits cannot alter a run.
const captured = await captureModules(ref, [...entryModules]);
const sources = new Map([...captured].map(([name, source]) => [`/${name}`, source]));
if (paired) {
  const baseline = pairedDependencies === 'reference'
    ? await captureModules(pairedRef, [...entryModules])
    : new Map(captured);
  if (pairedDependencies === 'current') baseline.set('js/rendering/renderer.js',
    readRuntimeAt(root, pairedRef, 'public/js/rendering/renderer.js').toString('utf8'));
  for (const [name, source] of baseline) sources.set(`/__baseline__/${name}`, source);
}
const sourceHashes = Object.fromEntries([...sources].map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')]));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });

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
  if (!found) throw new Error('Installed Playwright and a matching Chromium headless shell are required; nothing was installed.');
  return found.path;
}

function benchmarkDocument() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Popple renderer performance</title>
<style>html,body{margin:0;overflow:hidden;background:#0b0d14}canvas{display:block;width:100vw;height:100vh}</style><canvas id="film"></canvas>
<script type="module">
import { FilmRenderer } from '/js/rendering/renderer.js';
${paired ? "import { FilmRenderer as BaselineFilmRenderer } from '/__baseline__/js/rendering/renderer.js';" : ''}
import { BubbleState } from '/js/core/physics.js';
import { SHEET_CONFIG, PHYSICS_CONFIG } from '/js/core/config.js';
const rendererStart=performance.now();
let renderer=new FilmRenderer(document.querySelector('canvas'));
const initializeMs=performance.now()-rendererStart;
const gl=renderer.gl;
const debug=gl.getExtension('WEBGL_debug_renderer_info');
const timer=gl.getExtension('EXT_disjoint_timer_query');
const backend={ vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),
  unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,
  unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
  version:gl.getParameter(gl.VERSION),shadingLanguage:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
  maxFragmentUniformVectors:gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
  timerAvailable:!!timer,instancingAvailable:!!gl.getExtension('ANGLE_instanced_arrays'),floatTexturesAvailable:!!gl.getExtension('OES_texture_float'),userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,
  actualDevicePixelRatio:devicePixelRatio,crossOriginIsolated:globalThis.crossOriginIsolated,initializeMs };
const renderers=${paired ? "{current:renderer,baseline:new BaselineFilmRenderer(renderer.canvas)}" : "{current:renderer}"};
const yieldTask=()=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve()};channel.port2.postMessage(0)});
const percentile=(values,p)=>{const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.floor((a.length-1)*p))]:null;};
const stats=values=>({samples:values.length,p50:percentile(values,.5),p95:percentile(values,.95),minimum:values.length?Math.min(...values):null,maximum:values.length?Math.max(...values):null});
const raf=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const syncPixel=new Uint8Array(4);
const angle=gl.getExtension('ANGLE_instanced_arrays');
const batchFor=()=>renderer.bubbleBatch||renderer.batch||renderer.capBatch;
const sheetBatchFor=()=>renderer.sheetBatchingEnabled&&renderer.sheetBatchProgram&&renderer.sheetBatch?.active?renderer.sheetBatch:null;
const isSheetProgram=program=>program===renderer.sheetProgram||program===renderer.sheetBatchProgram;
const legacyQuad=${paired ? "gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)" : "null"};
const prepareVersion=version=>{renderer=renderers[version];if(version==='baseline'&&legacyQuad){gl.bindBuffer(gl.ARRAY_BUFFER,legacyQuad);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);if(angle)for(let i=0;i<6;i++)angle.vertexAttribDivisorANGLE(i,0);for(let i=1;i<6;i++)gl.disableVertexAttribArray(i)}};
const syncRead=()=>gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,syncPixel);
const layoutFor=(count,mode,width,height)=>{
  const pitchFactor=2.5,rowFactor=Math.sqrt(3)/2;
  let radius,columns;
  if(mode==='fit'){
    columns=Math.max(1,Math.ceil(Math.sqrt(count*width*rowFactor/height)));
    const rows=Math.ceil(count/columns);
    radius=Math.min(width/((columns+.5)*pitchFactor),height/((rows-1)*pitchFactor*rowFactor+3));
  } else {radius=42;columns=Math.max(1,Math.floor(width/(radius*pitchFactor)))}
  const pitch=radius*pitchFactor,rowPitch=pitch*rowFactor;
  const sheetWidth=(columns+.5)*pitch;
  const left=(width-sheetWidth)/2+pitch*.5;
  return Array.from({length:count},(_,i)=>({x:left+(i%columns)*pitch+(Math.floor(i/columns)%2)*pitch*.5,y:radius*1.5+Math.floor(i/columns)*rowPitch,radius}));
};
function geometryDetails(layout){
  const tiles=renderer.sheetState.tiles;
  const support=SHEET_CONFIG.supportRadius;
  let badTiles=0,coveredArea=0;
  const used=new Set();
  for(const tile of tiles){
    coveredArea+=tile.width*tile.height;
    if(tile.indices.length>SHEET_CONFIG.maximumShaderSites)throw new Error('Local shader site limit exceeded');
    const expected=[];
    layout.forEach((site,index)=>{const dx=site.x-Math.max(tile.x,Math.min(site.x,tile.x+tile.width)),dy=site.y-Math.max(tile.y,Math.min(site.y,tile.y+tile.height));if(dx*dx+dy*dy<=(site.radius*support)**2)expected.push(index)});
    const actual=[...tile.indices].sort((a,b)=>a-b);
    if(actual.length!==expected.length||actual.some((index,i)=>index!==expected[i]))badTiles++;
    actual.forEach(index=>used.add(index));
  }
  if(badTiles||Math.abs(coveredArea-renderer.width*renderer.height)>.1)throw new Error('Sheet tiling dropped sites or pixel area');
  const visible=layout.filter(pos=>{const extent=pos.radius*1.38;return !(pos.x+extent<0||pos.y+extent<0||pos.x-extent>renderer.width||pos.y-extent>renderer.height)}).length;
  const batch=batchFor();
  if(batch?.available){const actual=[...batch.indices];const expected=layout.map((site,index)=>({site,index})).filter(({site})=>{const extent=site.radius*1.38;return !(site.x+extent<0||site.y+extent<0||site.x-extent>renderer.width||site.y-extent>renderer.height)}).map(value=>value.index);if(actual.length!==expected.length||actual.some((value,index)=>value!==expected[index]))throw new Error('Batch dropped or reordered visible cap identities')}
  const sheetBatch=sheetBatchFor();
  return {batchMode:batch?.available?batch.mode:'legacy',batchCapacity:batch?.available?batch.capacity:0,batchChunks:batch?.available?batch.chunks.length:visible,sheetBatchMode:sheetBatch?'batched':'legacy',sheetBatchPages:sheetBatch?sheetBatch.pages.length:0,expectedSheetDraws:sheetBatch?sheetBatch.pages.length:tiles.length,tileCount:tiles.length,maxLocalSites:Math.max(...tiles.map(t=>t.indices.length)),visibleDomes:visible,sitesTouchingSheet:used.size,coveredArea,noDroppedSites:true,radius:layout[0].radius};
}
function countCalls(draw){
  const counts={drawArrays:0,drawArraysInstancedANGLE:0,totalDrawCalls:0,sheetDraws:0,capDraws:0,capInstances:0,viewport:0,scissor:0,uniforms:0,bufferData:0,bufferSubData:0,bufferUploadBytes:0,texImage2D:0,texSubImage2D:0,textureUploadBytes:0};
  const saved=new Map();let program=null;
  const recordDraw=(name,args)=>{counts[name]++;counts.totalDrawCalls++;if(isSheetProgram(program))counts.sheetDraws++;else{counts.capDraws++;counts.capInstances+=name==='drawArraysInstancedANGLE'?args[3]:args[2]/6}};
  for(const name of ['drawArrays','viewport','scissor','useProgram','uniform1f','uniform1i','uniform2f','uniform4f','uniform4fv','bufferData','bufferSubData','texImage2D','texSubImage2D']){
    const original=gl[name];saved.set(name,original);
    gl[name]=function(...args){
      if(name==='useProgram')program=args[0];else if(name==='drawArrays')recordDraw(name,args);
      else if(name.startsWith('uniform'))counts.uniforms++;
      else if(name==='bufferData'||name==='bufferSubData'){counts[name]++;const value=args[name==='bufferData'?1:2];counts.bufferUploadBytes+=typeof value==='number'?value:value?.byteLength||0}
      else if(name==='texImage2D'||name==='texSubImage2D'){counts[name]++;counts.textureUploadBytes+=args[args.length-1]?.byteLength||0}
      else counts[name]++;
      return original.apply(gl,args);
    };
  }
  const instanced=angle?.drawArraysInstancedANGLE;
  if(angle)angle.drawArraysInstancedANGLE=function(...args){recordDraw('drawArraysInstancedANGLE',args);return instanced.apply(angle,args)};
  try{draw();gl.finish()}finally{for(const[name,original]of saved)gl[name]=original;if(angle)angle.drawArraysInstancedANGLE=instanced}
  return counts;
}
function setPass(pass){
  const originalDraw=gl.drawArrays,originalUse=gl.useProgram,originalInstanced=angle?.drawArraysInstancedANGLE;let program=null;
  if(pass==='both')return()=>{};
  const allowed=()=>pass==='sheet'?isSheetProgram(program):!isSheetProgram(program);
  gl.useProgram=function(programValue){program=programValue;return originalUse.call(gl,programValue)};
  gl.drawArrays=function(...args){if(allowed())return originalDraw.apply(gl,args)};
  if(angle)angle.drawArraysInstancedANGLE=function(...args){if(allowed())return originalInstanced.apply(angle,args)};
  return()=>{gl.drawArrays=originalDraw;gl.useProgram=originalUse;if(angle)angle.drawArraysInstancedANGLE=originalInstanced};
}
async function measure(draw){
  const submission=[],intervals=[],completed=[],syncSubmission=[],gpu=[];
  const frameStart=performance.now();let previous=null;
  // Natural browser rAF scheduling, no readback or gl.finish in this phase.
  for(let i=0;i<18;i++){
    const time=await raf();if(previous!==null)intervals.push(time-previous);previous=time;
    const start=performance.now();draw();submission.push(performance.now()-start);gl.flush();
    if(performance.now()-frameStart>=750)break;
  }
  syncRead(); // Drain queued work outside natural frame timing.
  const noDrawReadback=[];for(let i=0;i<5;i++){const start=performance.now();syncRead();noDrawReadback.push(performance.now()-start)}
  const syncStart=performance.now();
  // Chromium's gl.finish JavaScript return may not acknowledge GPU completion.
  // A SEPARATE 1px readback probe measures render + driver + readback latency.
  // Natural frame timing above remains readback-free; neither is pure GPU time.
  for(let i=0;i<10;i++){
    const query=timer?timer.createQueryEXT():null;
    const start=performance.now();if(query)timer.beginQueryEXT(timer.TIME_ELAPSED_EXT,query);
    draw();if(query)timer.endQueryEXT(timer.TIME_ELAPSED_EXT);
    syncSubmission.push(performance.now()-start);syncRead();completed.push(performance.now()-start);
    if(query){await raf();if(timer.getQueryObjectEXT(query,timer.QUERY_RESULT_AVAILABLE_EXT)&&!gl.getParameter(timer.GPU_DISJOINT_EXT))gpu.push(timer.getQueryObjectEXT(query,timer.QUERY_RESULT_EXT)/1e6);timer.deleteQueryEXT(query)}
    if(performance.now()-syncStart>=800)break;
  }
  return {cpuSubmissionMs:stats(submission),rafIntervalsMs:stats(intervals),completedRenderMs:stats(completed),synchronizedSubmissionMs:stats(syncSubmission),gpuTimerMs:stats(gpu),noDrawReadbackMs:stats(noDrawReadback),
    lowSampleCount:submission.length<6||completed.length<3,wallMs:performance.now()-frameStart,
    completedTimingMethod:'Separate diagnostic: renderer.render + 1px readPixels (render + submission + driver + readback; not pure GPU); gl.finish return is not reliable completion evidence on this backend',rafTimingMethod:'natural requestAnimationFrame; render + gl.flush, no finish/readback'};
}
function cpuUpdates(bubbles){
  const measureLoop=callback=>{const samples=[];for(let batch=0;batch<12;batch++){const start=performance.now();for(let i=0;i<30;i++)callback();samples.push((performance.now()-start)/30)}return stats(samples)};
  const coupling=measureLoop(()=>renderer.sheetState.update(bubbles,false));
  // The production tick currently calls step for every bubble on active frames.
  const states=bubbles.map((bubble,index)=>{const value=new BubbleState(index,2);if(bubble.popped){value.popped=true;value.collapse=1;value.compression=PHYSICS_CONFIG.settledCompression;value.popAge=10}return value});
  let time=0;
  const mainPhysics=measureLoop(()=>{time+=1/60;for(let i=0;i<states.length;i++)states[i].step(1/60,time)});
  return {couplingMs:coupling,mainLikePhysicsStepMs:mainPhysics,note:'CPU microbenchmarks exclude rendering, DOM, audio and effects; production-like loop visits all settled states.'};
}
async function runPaired(options){
  if(!renderers.baseline)throw new Error('Paired source not loaded');
  if(!timer)throw new Error('Paired probe requires a hardware GPU timer');
  const {count,state,width,height,dpr}=options;
  const layout=layoutFor(count,'fit',width,height);
  const bubbles=Array.from({length:count},(_,index)=>new BubbleState(index,2));
  if(state==='popped')for(const b of bubbles){b.popped=true;b.popX=(b.seed-.5)*.8;b.popY=(.5-b.seed)*.6;b.collapse=1;b.popAge=10;b.compression=PHYSICS_CONFIG.settledCompression}
  else {const b=bubbles[0];b.press(.4,-.25);b.compression=.55;b.bulge=.12;b.holdProgress=.55}
  const draw=()=>renderer.render(bubbles,layout,true,1,{x:.025,y:-.025,angle:.05});
  const initialization={};
  for(const version of ['baseline','current']){prepareVersion(version);renderer.resize(width,height,dpr);const start=performance.now();draw();syncRead();initialization[version]=performance.now()-start;geometryDetails(layout)}
  // Warm both shaders, then alternate AB/BA inside one WebGL context. GPU
  // queries are read only after an asynchronous browser task. MessageChannel
  // yields without inserting a vSync idle period between paired samples.
  for(let i=0;i<8;i++)for(const version of ['baseline','current']){prepareVersion(version);draw();syncRead()}
  const pairedCalls={},pairedGeometry={};for(const version of ['baseline','current']){prepareVersion(version);pairedCalls[version]=countCalls(draw);const geometry=geometryDetails(layout);pairedGeometry[version]=geometry;if(pairedCalls[version].capInstances!==geometry.visibleDomes)throw new Error('Paired cap submission mismatch');if(pairedCalls[version].sheetDraws!==geometry.expectedSheetDraws)throw new Error('Paired sheet submission mismatch')}
  const pairs=[],values={baseline:[],current:[]},submission={baseline:[],current:[]},diagnostic={baseline:[],current:[]};
  const started=performance.now();let disjointPairs=0;
  for(let sample=0;sample<20;sample++){
    const order=sample%2?['current','baseline']:['baseline','current'];
    const pending=[];
    for(const version of order){prepareVersion(version);const query=timer.createQueryEXT();timer.beginQueryEXT(timer.TIME_ELAPSED_EXT,query);const start=performance.now();draw();const cpu=performance.now()-start;timer.endQueryEXT(timer.TIME_ELAPSED_EXT);syncRead();const complete=performance.now()-start;pending.push({version,query,cpu,complete})}
    await yieldTask();
    const disjoint=gl.getParameter(timer.GPU_DISJOINT_EXT),pair={sample,order};
    let valid=!disjoint;
    for(const entry of pending){if(timer.getQueryObjectEXT(entry.query,timer.QUERY_RESULT_AVAILABLE_EXT)&&!disjoint){const gpu=timer.getQueryObjectEXT(entry.query,timer.QUERY_RESULT_EXT)/1e6;pair[entry.version]={gpuMs:gpu,cpuMs:entry.cpu,renderReadbackMs:entry.complete}}else valid=false;timer.deleteQueryEXT(entry.query)}
    if(valid){for(const version of ['baseline','current']){values[version].push(pair[version].gpuMs);submission[version].push(pair[version].cpuMs);diagnostic[version].push(pair[version].renderReadbackMs)}pair.currentToBaselineGpuRatio=pair.current.gpuMs/pair.baseline.gpuMs;pair.currentToBaselineCpuRatio=pair.current.cpuMs/pair.baseline.cpuMs;pairs.push(pair)}else disjointPairs++;
    if(performance.now()-started>2000)break;
  }
  if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw new Error('Paired render WebGL error');
  const ratios=pairs.map(pair=>pair.currentToBaselineGpuRatio),cpuRatios=pairs.map(pair=>pair.currentToBaselineCpuRatio).filter(Number.isFinite);
  const versions=Object.fromEntries(['baseline','current'].map(version=>[version,{gpuMs:stats(values[version]),cpuSubmissionMs:stats(submission[version]),renderPlusReadbackMs:stats(diagnostic[version])}]));
  return {count,state,mode:'fit',dpr,geometry:pairedGeometry.current,geometryByVersion:pairedGeometry,versions,calls:pairedCalls,pairedGpuRatio:stats(ratios),pairedCpuRatio:stats(cpuRatios),ratioP10:percentile(ratios,.1),ratioP90:percentile(ratios,.9),currentFasterPairs:ratios.filter(value=>value<1).length,
    pairs,disjointPairs,initialization,wallMs:performance.now()-started,error:0,limits:'Baseline renderer from ${pairedRef} with ${pairedDependencies} dependencies; fixed seeds/layout/coupling. Both programs share one WebGL context; legacy quad state is restored before its samples outside measured windows. Stable buffer/texture upload counts are captured after warmup. Alternating AB/BA query samples yield withMessageChannel, not vSync. Ratios may contain clock/driver noise.'};
}
window.__benchmark={backend,runPaired,run:async options=>{
  const {count,mode,state,width,height,dpr,pass='both',capture=false}=options;
  renderer.resize(width,height,dpr);
  const layout=layoutFor(count,mode,width,height);
  const bubbles=Array.from({length:count},(_,index)=>new BubbleState(index,2));
  if(state==='popped')for(const b of bubbles){b.popped=true;b.popX=(b.seed-.5)*.8;b.popY=(.5-b.seed)*.6;b.collapse=1;b.popAge=10;b.compression=PHYSICS_CONFIG.settledCompression}
  else {const b=bubbles[0];b.press(.4,-.25);b.compression=.55;b.bulge=.12;b.holdProgress=.55}
  const draw=()=>renderer.render(bubbles,layout,true,1,{x:.025,y:-.025,angle:.05});
  const setupStart=performance.now();draw();syncRead();const firstCompletedRenderMs=performance.now()-setupStart;
  const geometry=geometryDetails(layout),calls=countCalls(draw);
  if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw new Error('WebGL rendering failed');
  const pixel=new Uint8Array(4);gl.readPixels(Math.floor(gl.drawingBufferWidth/2),Math.floor(gl.drawingBufferHeight/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  if(gl.getError()!==gl.NO_ERROR)throw new Error('Sanity readback failed');
  const restore=setPass(pass);let timing;
  try {draw();gl.finish();timing=await measure(draw)}finally{restore()}
  const updates=cpuUpdates(bubbles);
  if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw new Error('WebGL error after timed rendering');
  if(capture){draw();gl.finish()}
  return {count,mode,state,dpr,pass,canvasPixels:renderer.canvas.width*renderer.canvas.height,canvasWidth:renderer.canvas.width,canvasHeight:renderer.canvas.height,firstCompletedRenderMs,
    firstRenderNote:'Includes sheet cache construction, new membranes, driver lazy compile, completed drawing and 1px synchronization readback; initialization recorded separately per profile.',geometry,calls,callsTimingNote:'Call counts describe the complete production render; diagnostic draw suppression is applied only during timing.',timing,updates,sanityPixel:[...pixel],error:0};
}};
</script>`;
}

const playwrightPath = await installedPlaywright();
const { chromium } = await import(pathToFileURL(path.join(playwrightPath, 'index.mjs')));
const browserFlavor=argument('browser')||'headless-shell';
if(!['headless-shell','chrome-metal'].includes(browserFlavor))throw new Error('Supported browser modes: headless-shell, chrome-metal');
const browser = await chromium.launch(browserFlavor==='chrome-metal'
  ? { headless: true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--use-angle=metal'] }
  : { headless: true });
const report = {
  label, browserFlavor, paired, pairedRef:paired?pairedRef:null, pairedDependencies:paired?pairedDependencies:null, ref: ref || null, generatedAt: new Date().toISOString(), baseURL,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes, browser: { chromium: browser.version(), playwright: JSON.parse(await readFile(path.join(playwrightPath, 'package.json'), 'utf8')).version },
  profiles: [], cases: [], diagnostics: [], pairedCases: [], errors: [],
  limits: [
    'Mobile profiles emulate viewport and DPR on this host. They do not measure a physical phone or establish mobile FPS.',
    'This is the production FilmRenderer and BubbleState with synthetic layout/state. Main app DOM, audio, effects and input are excluded.',
    'Fit packs every bubble into a fixed viewport and reduces radius. Window keeps radius 42 CSS px and extends the sheet below the viewport.',
    'Warm rAF and separate readback diagnostic phases stop at 750/800 ms respectively after each frame; a single slow frame can exceed that budget. Low sample counts are flagged.',
    'gl.finish JavaScript return does not reliably acknowledge completed drawing on this Chromium backend. A separate renderer.render + 1px readPixels diagnostic includes driver/submission/readback cost. Only a valid GPU timer measures pure GPU time.',
    'First render includes geometry caches and lazy driver compilation. Natural rAF and CPU frame timings exclude readPixels, integrity checks and screenshots. Separate completed-render diagnostics explicitly include a 1px readback.',
    'Isolated pass diagnostics suppress only draws; full CPU preparation and uploads remain. GPU clock/driver variation can make separate-pass or DPR comparisons unreliable; paired ratios are stronger evidence.',
    'Collapsed settled state exercises the expensive permanent fold shader. Intact includes one stationary partially compressed pocket.',
  ],
};
const jsonPath = path.join(output, `performance-${label}.json`);
try {
  for (const profile of profiles) {
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr });
    try {
      await context.route('**/js/**', route => {
        const source = sources.get(new URL(route.request().url()).pathname);
        return source ? route.fulfill({ contentType: 'text/javascript', body: source }) : route.abort();
      });
      await context.route('**/__performance__', route => route.fulfill({ contentType: 'text/html', body: benchmarkDocument(), headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'} }));
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ profile: profile.name, message: error.message }));
      await page.goto(`${baseURL}/__performance__`);
      await page.waitForFunction(() => !!window.__benchmark, null, { timeout: 60000 });
      const backend = await page.evaluate(() => __benchmark.backend);
      report.profiles.push({ ...profile, backend });
      console.log(`BACKEND ${profile.name}: ${backend.unmaskedRenderer || backend.renderer}; GPU timer=${backend.timerAvailable}`);
      if(paired){
        for(const count of counts)for(const state of ['intact','popped']){
          const value=await page.evaluate(options=>__benchmark.runPaired(options),{...profile,count,state});
          assert.equal(value.geometry.noDroppedSites,true);assert.equal(value.error,0);assert.ok(value.pairs.length>=10,'At least10valid paired GPU samples');
          report.pairedCases.push({profile:profile.name,...value});
          await writeFile(jsonPath,`${JSON.stringify(report,null,2)}\n`);
          console.log(`PAIRED ${count} ${state}: GPU baseline=${value.versions.baseline.gpuMs.p50.toFixed(3)}ms current=${value.versions.current.gpuMs.p50.toFixed(3)}ms CPU baseline=${value.versions.baseline.cpuSubmissionMs.p50.toFixed(3)}ms current=${value.versions.current.cpuSubmissionMs.p50.toFixed(3)}ms ratio=${value.pairedGpuRatio.p50.toFixed(3)} p10/p90=${value.ratioP10.toFixed(3)}/${value.ratioP90.toFixed(3)} pairs=${value.pairs.length}`);
        }
        continue;
      }
      for (const count of counts) for (const mode of ['fit', 'window']) for (const state of ['intact', 'popped']) {
        const value = await page.evaluate(options => __benchmark.run(options), { ...profile, count, mode, state });
        assert.equal(value.geometry.noDroppedSites, true);
        assert.equal(value.calls.sheetDraws, value.geometry.expectedSheetDraws);
        assert.equal(value.calls.capInstances, value.geometry.visibleDomes);
        assert.equal(value.calls.capDraws, value.geometry.batchChunks);
        assert.equal(value.error, 0);
        const result = { profile: profile.name, ...value };
        report.cases.push(result);
        await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`CASE ${profile.name} ${count} ${mode} ${state}: CPU=${value.timing.cpuSubmissionMs.p50?.toFixed(2)}ms completed=${value.timing.completedRenderMs.p50?.toFixed(2)}ms rAF-p95=${value.timing.rafIntervalsMs.p95?.toFixed(2)}ms draws=${value.calls.totalDrawCalls} visible=${value.geometry.visibleDomes} samples=${value.timing.completedRenderMs.samples}`);
      }
      if (profile.name === 'mobile' && !process.argv.includes('--no-diagnostics')) {
        const count = Math.max(...counts);
        for (const diagnostic of [
          { name: 'sheet-only-popped', state: 'popped', pass: 'sheet', dpr: profile.dpr },
          { name: 'caps-only-popped', state: 'popped', pass: 'caps', dpr: profile.dpr },
          { name: 'half-dpr-popped', state: 'popped', pass: 'both', dpr: profile.dpr / 2 },
        ]) {
          const value = await page.evaluate(options => __benchmark.run(options), { ...profile, ...diagnostic, count, mode: 'fit' });
          report.diagnostics.push({ profile: profile.name, diagnostic: diagnostic.name, ...value });
          console.log(`DIAGNOSTIC ${diagnostic.name}: completed=${value.timing.completedRenderMs.p50?.toFixed(2)}ms CPU=${value.timing.cpuSubmissionMs.p50?.toFixed(2)}ms`);
        }
        await page.evaluate(options => __benchmark.run(options), { ...profile, count: 100, mode: 'fit', state: 'popped', capture: true });
        await page.screenshot({ path: path.join(output, `performance-${label}-mobile.png`) });
      }
    } finally { await context.close(); }
  }
} catch (error) {
  report.errors.push({ message: error.stack || error.message });
  throw error;
} finally {
  await browser.close();
  try {
    const paths=Object.keys(report.sourceHashes).filter(name=>!name.startsWith('/__baseline__/')).map(name=>`public${name}`);
    const candidate=report.ref||execFileSync('git',['log','-1','--format=%H','--',...paths],{cwd:root,encoding:'utf8'}).trim();
    const matching=paths.every(name=>createHash('sha256').update(readRuntimeAt(root,candidate,name)).digest('hex')===report.sourceHashes[name.slice(6)]);
    report.verifiedRuntimeCommit=matching?execFileSync('git',['rev-parse',candidate],{cwd:root,encoding:'utf8'}).trim():null;
  } catch { report.verifiedRuntimeCommit=null; }
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const sourceDescription=`<p>Measured Git HEAD: <code>${escape(report.head.slice(0,12))}</code>; verified runtime source commit: <code>${escape(report.verifiedRuntimeCommit?.slice(0,12)||'uncommitted snapshot')}</code>; source snapshot: ${escape(report.ref||'working tree')}; baseline reference: <code>${escape(report.pairedRef||report.ref||'none')}</code>. Renderer SHA256: <code>${escape(report.sourceHashes['/js/rendering/renderer.js']?.slice(0,16)||'unknown')}</code>; bubble-batch SHA256: <code>${escape(report.sourceHashes['/js/rendering/bubble-batch.js']?.slice(0,16)||'absent (legacy reference)')}</code>; sheet-batch SHA256: <code>${escape(report.sourceHashes['/js/rendering/sheet-batch.js']?.slice(0,16)||'absent (legacy reference)')}</code>.</p>`;
  const ms = value => value == null ? '—' : value.toFixed(2);
  const pairedRows=report.pairedCases.map(value=>`<tr><td>${escape(value.profile)}</td><td>${value.count}</td><td>${value.state}</td><td>${value.versions.baseline.cpuSubmissionMs.p50.toFixed(3)}</td><td>${value.versions.current.cpuSubmissionMs.p50.toFixed(3)}</td><td>${(100*(1-value.pairedCpuRatio.p50)).toFixed(1)}%</td><td>${ms(value.versions.baseline.gpuMs.p50)}</td><td>${ms(value.versions.current.gpuMs.p50)}</td><td>${(100*(1-value.pairedGpuRatio.p50)).toFixed(1)}%</td><td>${value.calls.baseline.sheetDraws} → ${value.calls.current.sheetDraws}</td><td>${value.calls.baseline.capDraws} → ${value.calls.current.capDraws}</td><td>${value.calls.baseline.totalDrawCalls} → ${value.calls.current.totalDrawCalls}</td><td>${value.ratioP10.toFixed(3)} / ${value.ratioP90.toFixed(3)}</td><td>${value.currentFasterPairs}/${value.pairs.length}</td></tr>`).join('');
  const pairedTable=report.pairedCases.length?`<h2>Paired renderer probe</h2><p>${escape(report.pairedCases[0].limits)}</p><p>Warm current texture upload: ${report.pairedCases.every(value=>value.calls.current.textureUploadBytes===0)?'0 bytes per frame in every paired case':'see JSON for each case'}; see JSON for dynamic texture and buffer updates.</p><table><thead><tr><th>Host viewport</th><th>Bubbles</th><th>State</th><th>Baseline CPU p50 ms</th><th>Current CPU p50 ms</th><th>Median CPU reduction</th><th>Baseline GPU p50 ms</th><th>Current GPU p50 ms</th><th>Median GPU reduction</th><th>Sheet draws</th><th>Cap draws</th><th>Total draws</th><th>GPU ratio p10 / p90</th><th>GPU faster pairs</th></tr></thead><tbody>${pairedRows}</tbody></table>`:'';
  const rows = report.cases.map(value => `<tr><td>${escape(value.profile)}</td><td>${value.count}</td><td>${value.mode}</td><td>${value.state}</td><td>${value.geometry.visibleDomes}/${value.count}</td><td>${value.calls.totalDrawCalls}</td><td>${ms(value.timing.cpuSubmissionMs.p50)}</td><td>${ms(value.timing.completedRenderMs.p50)}</td><td>${ms(value.timing.gpuTimerMs.p50)}</td><td>${ms(value.timing.gpuTimerMs.p95)}</td><td>${ms(value.timing.rafIntervalsMs.p95)}</td><td>${value.timing.completedRenderMs.samples}${value.timing.lowSampleCount?' *':''}</td></tr>`).join('');
  await writeFile(path.join(output, `performance-${label}.html`), `<!doctype html><meta charset="utf-8"><title>Popple rendering — ${escape(label)}</title><style>body{font:15px system-ui;margin:32px;color:#222}table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 12px;border-bottom:1px solid #ddd;text-align:right}th:first-child,td:first-child{text-align:left}li{max-width:100ch;margin:8px 0}</style><h1>Popple rendering — ${escape(label)}</h1><p>${escape(report.generatedAt)} · Chromium ${escape(report.browser.chromium)}</p>${sourceDescription}<p>${escape(report.profiles.map(profile=>`${profile.name} ${profile.width}×${profile.height} DPR${profile.dpr}: ${profile.backend.unmaskedRenderer||profile.backend.renderer}`).join(' · '))}</p><ul>${report.limits.map(value=>`<li>${escape(value)}</li>`).join('')}</ul><table><thead><tr><th>Host viewport</th><th>Bubbles</th><th>Layout</th><th>State</th><th>Visible</th><th>Draws</th><th>CPU p50 ms</th><th>Render + readback p50 ms</th><th>GPU p50 ms</th><th>GPU p95 ms</th><th>rAF p95 ms</th><th>Sync samples</th></tr></thead><tbody>${rows}</tbody></table><p>* Low sample count; inspect JSON for all p50/p95 samples and diagnostic pass/DPR ablations.</p>${pairedTable}`);
}
assert.equal(report.errors.length, 0, 'No benchmark browser or WebGL errors');
console.log(`REPORT ${jsonPath}`);
