import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_STRIDE, MEMBRANE_TEXELS, BubbleBatch,
  bubbleVisible, packBubbleRect, packBubbleRecord, packMembraneRow,
} from '../../public/js/rendering/bubble-batch.js';

const geometry = (width = 390, height = 844, dpr = 2.5) => ({
  width, height, dpr,
  framebufferWidth: Math.round(width * dpr), framebufferHeight: Math.round(height * dpr),
});
const bubble = seed => ({ seed, compression: .31, collapse: 0, bulge: .12, x: -.4, y: .7, popped: false });
const lattice = count => Array.from({ length: count }, (_, index) => ({
  x: 10 + index % 40 * 8, y: 10 + Math.floor(index / 40) * 8, radius: 3,
}));
const membrane = value => ({
  air: value,
  dent: new Float32Array([1, 2, 3, 4]),
  folds: Float32Array.from({ length: 20 }, (_, index) => index + 5),
  profiles: Float32Array.from({ length: 20 }, (_, index) => index + 25),
  pockets: Float32Array.from({ length: 12 }, (_, index) => index + 45),
});

function mockGL({ float = true, instanced = true, maxTexture = 4096, maxAttributes = 8 } = {}) {
  const calls = [];
  const gl = { calls };
  for (const name of ['ARRAY_BUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'FLOAT', 'TRIANGLES',
    'TEXTURE0', 'TEXTURE_2D', 'RGBA', 'NEAREST', 'CLAMP_TO_EDGE', 'TEXTURE_MIN_FILTER',
    'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'MAX_TEXTURE_SIZE', 'MAX_VERTEX_ATTRIBS']) gl[name] = name;
  for (const name of ['bindBuffer', 'bufferData', 'bindTexture', 'texParameteri', 'texImage2D',
    'enableVertexAttribArray', 'disableVertexAttribArray', 'vertexAttribPointer',
    'activeTexture', 'uniform1i', 'uniform1f', 'drawArrays', 'deleteBuffer', 'deleteTexture']) {
    gl[name] = (...args) => calls.push({ name, args });
  }
  for (const name of ['bufferSubData', 'texSubImage2D']) {
    gl[name] = (...args) => calls.push({ name, args, data: Array.from(args.at(-1)) });
  }
  let identity = 0;
  gl.createBuffer = () => ({ kind: 'buffer', id: identity++ });
  gl.createTexture = () => ({ kind: 'texture', id: identity++ });
  gl.getParameter = parameter => parameter === gl.MAX_TEXTURE_SIZE ? maxTexture : maxAttributes;
  const angle = {
    drawArraysInstancedANGLE: (...args) => calls.push({ name: 'drawArraysInstancedANGLE', args }),
    vertexAttribDivisorANGLE: (...args) => calls.push({ name: 'vertexAttribDivisorANGLE', args }),
  };
  gl.getExtension = name => name === 'OES_texture_float' ? (float ? {} : null)
    : name === 'ANGLE_instanced_arrays' ? (instanced ? angle : null) : null;
  return gl;
}

const selectedCalls = (gl, name) => gl.calls.filter(call => call.name === name);
const uniforms = { membranes: 'sampler', membrane_rows: 'rows' };
const render = (batch, bubbles, layout, view = geometry(), deformation = new Float32Array(layout.length * 4), getMembrane = () => membrane(.1)) =>
  batch.draw(bubbles, layout, deformation, view, getMembrane, uniforms);

test('batch rects exactly retain legacy rounded viewports at fractional DPR and negative edges', () => {
  const view = geometry(51, 43, 2.625);
  const output = new Float32Array(12);
  const positions = [
    { x: -1.7, y: 4.91, radius: 5.3 },
    { x: 26.142, y: 19.777, radius: 7.15 },
    { x: 51, y: 43, radius: 10 },
  ];
  positions.forEach((position, index) => packBubbleRect(output, index * 4, position, view));
  assert.deepEqual(Array.from(output), [-24, 81, 38, 38, 43, 35, 52, 52, 98, -36, 72, 72]);
  const extent = 5 * 1.38;
  assert.equal(bubbleVisible({ x: -extent, y: 20, radius: 5 }, 51, 43), true, 'an exactly tangent quad is retained');
  assert.equal(bubbleVisible({ x: -extent - .0001, y: 20, radius: 5 }, 51, 43), false);
  assert.equal(bubbleVisible({ x: 51 + extent, y: 20, radius: 5 }, 51, 43), true);
  assert.equal(bubbleVisible({ x: 20, y: 43 + extent + .0001, radius: 5 }, 51, 43), false);
});

test('bubble records retain independent state, touch orientation, CSS radius and original deformation identity', () => {
  assert.equal(BATCH_STRIDE, 14);
  const record = new Float32Array(BATCH_STRIDE * 2).fill(-99);
  const state = { ...bubble(.625), compression: .5, collapse: 1, bulge: .125 };
  const deformation = Float32Array.from([9, 8, 7, 6, -.125, .25, .75, 1]);
  packBubbleRecord(record, 14, state, { radius: 7 }, Float32Array.from([2, 3, 4, 5]), 0, deformation, 1, 3);
  assert.deepEqual(Array.from(record.slice(0, 14)), Array(14).fill(-99));
  assert.deepEqual(Array.from(record.slice(14, 22)), [2, 3, 4, 5, .625, .5, 1, .125]);
  assert.ok(Math.abs(record[22] + .4) < 1e-7);
  assert.ok(Math.abs(record[23] + .7) < 1e-7);
  assert.deepEqual(Array.from(record.slice(24)), [7, -.125, .25, 3.5]);
});

test('one membrane row lays out all shape channels and clears unavailable permanent film data', () => {
  assert.equal(MEMBRANE_TEXELS, 15);
  const row = new Float32Array(120).fill(-1);
  packMembraneRow(row, 60, membrane(.125));
  assert.deepEqual(Array.from(row.slice(0, 60)), Array(60).fill(-1));
  assert.deepEqual(Array.from(row.slice(60)), [.125, 0, 0, 0, ...Array.from({ length: 56 }, (_, index) => index + 1)]);
  packMembraneRow(row, 60, null);
  assert.ok(row.slice(60).every(value => value === 0));
});

test('optional extensions select instanced, expanded or legacy paths without unsupported resource creation', () => {
  assert.equal(new BubbleBatch(mockGL()).mode, 'instanced');
  assert.equal(new BubbleBatch(mockGL({ instanced: false })).mode, 'expanded');
  for (const gl of [mockGL({ float: false }), mockGL({ maxAttributes: 5 }), mockGL({ maxTexture: 14 })]) {
    const batch = new BubbleBatch(gl);
    assert.equal(batch.available, false);
    assert.equal(render(batch, [bubble(1)], [{ x: 20, y: 20, radius: 10 }]), false);
    assert.equal(selectedCalls(gl, 'bufferData').length, 0);
    assert.equal(selectedCalls(gl, 'texImage2D').length, 0);
  }
});

test('100, 500 and 1000 caps keep original order and use bounded chunks with one draw per chunk', () => {
  for (const count of [100, 500, 1000]) {
    const gl = mockGL(), batch = new BubbleBatch(gl);
    const states = Array.from({ length: count }, (_, index) => bubble(index));
    assert.equal(render(batch, states, lattice(count)), true);
    const draws = selectedCalls(gl, 'drawArraysInstancedANGLE');
    assert.deepEqual(draws.map(call => call.args), Array.from({ length: Math.ceil(count / 256) }, (_, index) =>
      ['TRIANGLES', 0, 6, Math.min(256, count - index * 256)]));
    const uploads = selectedCalls(gl, 'bufferSubData');
    assert.deepEqual(uploads.flatMap(call => call.data.filter((_, index) => index % BATCH_STRIDE === 4)), states.map(state => state.seed));
    for (const upload of uploads) {
      assert.ok(upload.data.length <= 256 * BATCH_STRIDE);
      assert.equal(upload.data[13], .5, 'texture rows restart within each chunk');
      assert.equal(upload.data.at(-1), upload.data.length / BATCH_STRIDE - .5);
    }
    assert.equal(selectedCalls(gl, 'texSubImage2D').length, 0, 'intact caps never sample or upload the wrinkle texture');
  }
});

test('offscreen culling preserves source indices for membrane and deformation rows; layout geometry changes refresh cache', () => {
  const gl = mockGL(), batch = new BubbleBatch(gl);
  const layout = [{ x: -20, y: 20, radius: 5 }, { x: -3, y: 20, radius: 5 },
    { x: 30, y: 50, radius: 5 }, { x: 80, y: 20, radius: 5 }];
  const states = Array.from({ length: 4 }, (_, index) => ({ ...bubble(index), popped: true, collapse: 1 }));
  const deformation = Float32Array.from({ length: 16 }, (_, index) => index);
  const seen = [];
  const getMembrane = (state, index) => { seen.push(index); return membrane(index / 8); };
  render(batch, states, layout, geometry(51, 43, 1.5), deformation, getMembrane);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(selectedCalls(gl, 'bufferSubData').at(-1).data.slice(11), [4, 5, .5]);
  const cachedIndices = batch.indices, cachedRects = batch.rects;
  render(batch, states, layout, geometry(51, 43, 1.5), deformation, getMembrane);
  assert.equal(batch.indices, cachedIndices); assert.equal(batch.rects, cachedRects);
  render(batch, states, layout, geometry(51, 60, 1.5), deformation, getMembrane);
  assert.notEqual(batch.indices, cachedIndices);
  assert.deepEqual(seen, [1, 1, 1, 2]);
  assert.deepEqual(selectedCalls(gl, 'bufferSubData').at(-1).data.filter((_, index) => index % 14 === 4), [1, 2]);
});

test('cached arrays and upload views survive frames; fold data is repacked only after membrane identity changes', () => {
  const gl = mockGL(), batch = new BubbleBatch(gl);
  const states = [bubble(.1), { ...bubble(.2), popped: true, collapse: 1 }];
  const layout = lattice(2), shapes = [null, membrane(.125)];
  let fetched = 0;
  const getMembrane = (_, index) => { fetched++; return shapes[index]; };
  render(batch, states, layout, geometry(), undefined, getMembrane);
  const records = batch.records, film = batch.membraneData;
  const upload = selectedCalls(gl, 'bufferSubData').at(-1).args[2];
  const textureUpload = selectedCalls(gl, 'texSubImage2D').at(-1).args.at(-1);
  shapes[1].dent[0] = 88;
  states[0].compression = .875;
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.equal(batch.records, records); assert.equal(batch.membraneData, film);
  assert.equal(selectedCalls(gl, 'bufferSubData').at(-1).args[2], upload);
  assert.equal(selectedCalls(gl, 'texSubImage2D').at(-1).args.at(-1), textureUpload);
  assert.equal(selectedCalls(gl, 'bufferSubData').at(-1).data[5], .875);
  assert.equal(selectedCalls(gl, 'texSubImage2D').at(-1).data[64], 1, 'stable permanent membrane identity skips repacking');
  shapes[1] = membrane(.25);
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').at(-1).data[60], .25);
  assert.equal(fetched, 3, 'intact caps never request fold construction');
  states[1].popped = false; states[1].collapse = 0;
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.ok(batch.membraneData.slice(60).every(value => value === 0));
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 2, 'an intact reset clears the CPU cache without uploading unread rows');
  states[1].popped = true; states[1].collapse = 1;
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 3);
  assert.equal(selectedCalls(gl, 'texSubImage2D').at(-1).data[60], .25);
});

test('multiple popped chunks upload their own wrinkle rows before every draw and intact chunks preserve the current texture cache', () => {
  const gl = mockGL(), batch = new BubbleBatch(gl), count = 500;
  const states = Array.from({ length: count }, (_, index) => ({ ...bubble(index), popped: true, collapse: 1 }));
  const layout = lattice(count), shapes = states.map((_, index) => membrane(index / 1024));
  const getMembrane = (_, index) => shapes[index];
  for (let frame = 0; frame < 2; frame++) render(batch, states, layout, geometry(), undefined, getMembrane);
  const uploads = selectedCalls(gl, 'texSubImage2D');
  assert.deepEqual(uploads.map(call => call.args[5]), [256, 244, 256, 244]);
  assert.deepEqual(uploads.map(call => call.data[0]), [0, .25, 0, .25]);
  assert.deepEqual(uploads[1].data.filter((_, index) => index % 60 === 0),
    Array.from({ length: 244 }, (_, index) => (index + 256) / 1024));
  assert.equal(uploads[0].args.at(-1), uploads[2].args.at(-1), 'each chunk reuses its own CPU upload view');
  assert.equal(uploads[1].args.at(-1), uploads[3].args.at(-1));
  for (let index = 256; index < count; index++) { states[index].popped = false; states[index].collapse = 0; }
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 5, 'the first chunk replaces the last frame\'s second chunk');
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 5, 'an intact second chunk leaves the first chunk texture available next frame');
  shapes[0] = membrane(.875);
  render(batch, states, layout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 6);
  assert.equal(selectedCalls(gl, 'texSubImage2D').at(-1).data[0], .875);
});

test('empty and completely culled layouts skip uploads and draws, while first venting uploads cached folds at the shader threshold', () => {
  const gl = mockGL(), batch = new BubbleBatch(gl);
  assert.equal(render(batch, [], []), true);
  const states = [{ ...bubble(.125), popped: true }], layout = [{ x: -100, y: -100, radius: 3 }];
  assert.equal(render(batch, states, layout), true);
  assert.equal(batch.capacity, 0);
  assert.equal(selectedCalls(gl, 'bufferSubData').length, 0);
  assert.equal(selectedCalls(gl, 'drawArraysInstancedANGLE').length, 0);
  const visibleLayout = lattice(1), shape = membrane(.5);
  let fetched = 0;
  const getMembrane = () => { fetched++; return shape; };
  render(batch, states, visibleLayout, geometry(), undefined, getMembrane);
  states[0].collapse = .001;
  render(batch, states, visibleLayout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 0);
  assert.equal(fetched, 2, 'the popped state preserves the permanent-data callback contract before visible venting');
  states[0].collapse = .002;
  render(batch, states, visibleLayout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 1);
  assert.equal(selectedCalls(gl, 'texSubImage2D').at(-1).data[0], .5);
  render(batch, states, visibleLayout, geometry(), undefined, getMembrane);
  assert.equal(selectedCalls(gl, 'texSubImage2D').length, 1, 'stable single-chunk data remains resident');
});

test('expanded fallback emits the same six local corners and records with bounded draws', () => {
  for (const options of [{ instanced: false }, { instanced: true }]) {
    const gl = mockGL(options), batch = new BubbleBatch(gl);
    batch.mode = 'expanded';
    const count = 500, layout = lattice(count), states = Array.from({ length: count }, (_, index) => bubble(index));
    render(batch, states, layout);
    assert.deepEqual(selectedCalls(gl, 'drawArrays').map(call => call.args), [['TRIANGLES', 0, 256 * 6], ['TRIANGLES', 0, 244 * 6]]);
    assert.equal(selectedCalls(gl, 'drawArraysInstancedANGLE').length, 0);
    const data = selectedCalls(gl, 'bufferSubData')[0].data;
    assert.deepEqual(Array.from({ length: 6 }, (_, vertex) => data.slice(vertex * 16, vertex * 16 + 2)),
      [[-1, -1], [1, -1], [-1, 1], [-1, 1], [1, -1], [1, 1]]);
    for (let vertex = 1; vertex < 6; vertex++) assert.deepEqual(data.slice(vertex * 16 + 2, vertex * 16 + 16), data.slice(2, 16));
  }
});

test('growth is cached, capped by device texture limits, and full state is restored for subsequent sheet draws', () => {
  const gl = mockGL({ maxTexture: 128 }), batch = new BubbleBatch(gl);
  for (const count of [3, 3, 60, 500, 2]) render(batch, Array.from({ length: count }, (_, index) => bubble(index)), lattice(count));
  assert.equal(batch.capacity, 128);
  assert.deepEqual(selectedCalls(gl, 'texImage2D').map(call => call.args[4]), [4, 64, 128]);
  const parameters = selectedCalls(gl, 'texParameteri').map(call => call.args.slice(1));
  assert.deepEqual(parameters, [['TEXTURE_MIN_FILTER', 'NEAREST'], ['TEXTURE_MAG_FILTER', 'NEAREST'],
    ['TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'], ['TEXTURE_WRAP_T', 'CLAMP_TO_EDGE']]);
  const divisors = selectedCalls(gl, 'vertexAttribDivisorANGLE');
  assert.deepEqual(divisors.slice(-6).map(call => call.args), Array.from({ length: 6 }, (_, index) => [index, 0]));
  assert.deepEqual(selectedCalls(gl, 'disableVertexAttribArray').slice(-5).map(call => call.args[0]), [1, 2, 3, 4, 5]);
  assert.deepEqual(selectedCalls(gl, 'vertexAttribPointer').at(-1).args, [0, 2, 'FLOAT', false, 0, 0]);
  assert.deepEqual(selectedCalls(gl, 'uniform1i').at(-1).args, ['sampler', 0]);
  assert.deepEqual(selectedCalls(gl, 'uniform1f').at(-1).args, ['rows', 128]);
  batch.dispose();
  assert.equal(selectedCalls(gl, 'deleteBuffer').length, 3);
  assert.equal(selectedCalls(gl, 'deleteTexture').length, 1);
  assert.equal(batch.available, false);
});
