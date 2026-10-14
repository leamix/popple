import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetBatch } from '../../public/js/rendering/sheet-batch.js';
import { SheetState } from '../../public/js/core/sheet.js';

const geometry = (width = 390, height = 844, dpr = 2.5) => ({
  width, height, dpr,
  framebufferWidth: Math.round(width * dpr), framebufferHeight: Math.round(height * dpr),
});
const states = count => Array.from({ length: count }, () => ({ collapse: 0 }));
const tile = (x, y, width, height, indices = []) => ({ x, y, width, height, indices: Uint32Array.from(indices) });
const uniforms = { sheet_sites: 'sites', sheet_links: 'links', sheet_rows: 'rows' };

// WebGL is browser-owned. Record this helper's actual upload/draw boundary,
// retaining both the original typed-array identity and a snapshot of its data.
function mockGL({ float = true, maxTexture = 4096, maxAttributes = 8 } = {}) {
  const calls = [], gl = { calls };
  for (const name of ['ARRAY_BUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'FLOAT', 'TRIANGLES',
    'TEXTURE0', 'TEXTURE1', 'TEXTURE_2D', 'RGBA', 'NEAREST', 'CLAMP_TO_EDGE',
    'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T',
    'MAX_TEXTURE_SIZE', 'MAX_VERTEX_ATTRIBS']) gl[name] = name;
  gl.TEXTURE0 = 33984; gl.TEXTURE1 = 33985;
  let identity = 0, texture = null, buffer = null;
  gl.createBuffer = () => { const result = { kind: 'buffer', id: identity++ }; calls.push({ name: 'createBuffer', result }); return result; };
  gl.createTexture = () => { const result = { kind: 'texture', id: identity++ }; calls.push({ name: 'createTexture', result }); return result; };
  gl.bindBuffer = (...args) => { buffer = args[1]; calls.push({ name: 'bindBuffer', args }); };
  gl.bindTexture = (...args) => { texture = args[1]; calls.push({ name: 'bindTexture', args }); };
  for (const name of ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D']) {
    gl[name] = (...args) => {
      const input = name === 'bufferData' ? args[1] : args.at(-1);
      calls.push({ name, args, texture, buffer, data: ArrayBuffer.isView(input) ? Array.from(input) : null });
    };
  }
  for (const name of ['texParameteri', 'enableVertexAttribArray', 'disableVertexAttribArray',
    'vertexAttribPointer', 'activeTexture', 'uniform1i', 'uniform1f', 'uniform2f',
    'drawArrays', 'deleteBuffer', 'deleteTexture']) gl[name] = (...args) => calls.push({ name, args, texture, buffer });
  gl.getExtension = name => name === 'OES_texture_float' && float ? {} : null;
  gl.getParameter = name => name === gl.MAX_TEXTURE_SIZE ? maxTexture : maxAttributes;
  return gl;
}

const selected = (gl, name) => gl.calls.filter(call => call.name === name);
const uploads = gl => gl.calls.filter(call => (call.name === 'texImage2D' || call.name === 'texSubImage2D') && call.data);
const staticUploads = gl => uploads(gl).filter(upload => upload.name === 'texImage2D');
const dynamicUploads = gl => uploads(gl).filter(upload => upload.name === 'texSubImage2D');
const vertexUploads = gl => gl.calls.filter(call => (call.name === 'bufferData' || call.name === 'bufferSubData') && call.data);
const textureWidth = upload => upload.args[upload.name === 'texImage2D' ? 3 : 4];
const textureHeight = upload => upload.args[upload.name === 'texImage2D' ? 4 : 5];
const render = (batch, bubbles, layout, tiles, view = geometry(), deformation = new Float32Array(layout.length * 4)) =>
  batch.draw(bubbles, layout, deformation, tiles, view, uniforms);

function verticesByTile(gl) {
  return vertexUploads(gl).flatMap(upload => Array.from({ length: upload.data.length / 24 }, (_, index) =>
    Array.from({ length: 6 }, (_, vertex) => upload.data.slice((index * 6 + vertex) * 4, (index * 6 + vertex + 1) * 4))));
}

test('unsupported float textures, site width or attributes fall back without allocating GPU resources', () => {
  const layout = [{ x: 10, y: 10, radius: 3 }], tiles = [tile(0, 0, 20, 20, [0])];
  for (const options of [{ float: false }, { maxTexture: 23 }, { maxAttributes: 1 }]) {
    const gl = mockGL(options), batch = new SheetBatch(gl);
    assert.equal(batch.available, false);
    assert.equal(render(batch, states(1), layout, tiles), false);
    assert.equal(batch.active, false);
    assert.equal(selected(gl, 'createBuffer').length, 0);
    assert.equal(selected(gl, 'createTexture').length, 0);
    assert.equal(selected(gl, 'drawArrays').length, 0);
  }
});

test('fractional DPR tiles retain shared rounded scissor endpoints without gaps or overlap', () => {
  const gl = mockGL(), batch = new SheetBatch(gl), view = geometry(51.4, 43.2, 2.625);
  const tiles = [tile(0, 0, 17.3, 19.7), tile(17.3, 0, 34.1, 19.7),
    tile(0, 19.7, 17.3, 23.5), tile(17.3, 19.7, 34.1, 23.5)];
  assert.equal(render(batch, [], [], tiles, view), true);
  const vertices = verticesByTile(gl);
  assert.equal(vertices.length, 4, 'empty tiles still draw the continuous film background');
  const bounds = vertices.map(group => [Math.min(...group.map(v => v[0])), Math.min(...group.map(v => v[1])),
    Math.max(...group.map(v => v[0])), Math.max(...group.map(v => v[1]))]);
  assert.deepEqual(bounds, [[0, 62, 45, 113], [45, 62, 135, 113], [0, 0, 45, 62], [45, 0, 135, 62]]);
  vertices.forEach((group, index) => assert.ok(group.every(vertex => vertex[2] === index + .5 && vertex[3] === 0)));
  assert.deepEqual(selected(gl, 'drawArrays').map(call => call.args), [['TRIANGLES', 0, 24]]);
});

test('zero framebuffer pixel tiles are omitted while later site rows remain contiguous', () => {
  const gl = mockGL(), batch = new SheetBatch(gl), layout = [{ x: .5, y: .5, radius: .1 }];
  const tiles = [tile(0, 0, .1, 1, [0]), tile(.1, 0, .9, 1, [0]), tile(1, 0, 1, 1)];
  assert.equal(render(batch, states(1), layout, tiles, geometry(2, 1, 1)), true);
  const groups = verticesByTile(gl);
  assert.equal(groups.length, 2);
  assert.ok(groups[0].every(vertex => vertex[2] === .5 && vertex[3] === 1));
  assert.ok(groups[1].every(vertex => vertex[2] === 1.5 && vertex[3] === 0));
  assert.deepEqual(groups[0].map(v => v[0]).sort(), [0, 0, 0, 1, 1, 1]);
  const staticUpload = staticUploads(gl)[0];
  assert.equal(textureHeight(staticUpload), 2);
  assert.deepEqual(staticUpload.data.slice(0, 4), [.5, .5, Math.fround(.1), 0]);
});

test('static sites and duplicated local links preserve matching original identities and per-tile order', () => {
  const gl = mockGL(), batch = new SheetBatch(gl);
  const layout = [{ x: 7, y: 11, radius: 2 }, { x: 19, y: 13, radius: 3 }, { x: 23, y: 17, radius: 4 }];
  const tiles = [tile(0, 0, 20, 20, [2, 0]), tile(20, 0, 20, 20, [1, 2])];
  const bubbles = [{ collapse: .125 }, { collapse: .5 }, { collapse: 1 }];
  const deformation = Float32Array.from([1, 2, .25, 0, 3, 4, .5, 0, 5, 6, .75, 0]);
  render(batch, bubbles, layout, tiles, geometry(40, 20, 2), deformation);
  const staticUpload = staticUploads(gl)[0];
  assert.equal(textureHeight(staticUpload), 2);
  assert.deepEqual(staticUpload.data.slice(0, 8), [23, 17, 4, 2, 7, 11, 2, 0]);
  assert.deepEqual(staticUpload.data.slice(96, 104), [19, 13, 3, 1, 23, 17, 4, 2]);
  const links = dynamicUploads(gl)[0];
  assert.equal(textureWidth(links), 24);
  assert.equal(textureHeight(links), 2);
  assert.deepEqual(links.data.slice(0, 8), [5, 6, .75, 1, 1, 2, .25, .125]);
  assert.deepEqual(links.data.slice(96, 104), [3, 4, .5, .5, 5, 6, .75, 1]);
  assert.ok(links.data.slice(8, 96).every(value => value === 0));
  assert.ok(links.data.slice(104).every(value => value === 0));
  assert.deepEqual(selected(gl, 'uniform1i').map(call => call.args).sort(), [['links', 1], ['sites', 0]]);
  const filters = selected(gl, 'texParameteri').filter(call => call.args[1] === 'TEXTURE_MIN_FILTER' || call.args[1] === 'TEXTURE_MAG_FILTER');
  assert.ok(filters.length >= 4 && filters.every(call => call.args[2] === 'NEAREST'));
});

test('changed collapse and pulse refresh every duplicate; stable frames reuse GPU data and typed arrays', () => {
  const gl = mockGL(), batch = new SheetBatch(gl), layout = [{ x: 5, y: 7, radius: 2 }, { x: 15, y: 7, radius: 2 }];
  const bubbles = states(2), deformation = new Float32Array(8);
  const tiles = [tile(0, 0, 10, 20, [0, 1]), tile(10, 0, 10, 20, [1, 0])], view = geometry(20, 20, 2);
  render(batch, bubbles, layout, tiles, view, deformation);
  const uploadCount = uploads(gl).length, vertexCount = vertexUploads(gl).length;
  const bufferCount = selected(gl, 'createBuffer').length, textureCount = selected(gl, 'createTexture').length;
  render(batch, bubbles, layout, tiles, geometry(20, 20, 2), deformation);
  assert.equal(uploads(gl).length, uploadCount);
  assert.equal(vertexUploads(gl).length, vertexCount);
  bubbles[1].collapse = .75;
  deformation.set([-.25, .125, .5, .085], 4);
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(uploads(gl).length, uploadCount + 1);
  const changedUpload = uploads(gl).at(-1);
  assert.equal(textureWidth(changedUpload), 24);
  assert.deepEqual(changedUpload.data.slice(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(changedUpload.data.slice(4, 6), [-.25, .125]);
  assert.ok(Math.abs(changedUpload.data[6] - .66) < 1e-7, 'pulse contributes the same slope strength as legacy sheet uniforms');
  assert.equal(changedUpload.data[7], .75);
  assert.deepEqual(changedUpload.data.slice(96, 100), changedUpload.data.slice(4, 8), 'the second tile sees the same updated bubble in its first local lane');
  assert.deepEqual(changedUpload.data.slice(100, 104), [0, 0, 0, 0]);
  bubbles[1].collapse = .75 + 1e-10;
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(uploads(gl).length, uploadCount + 1, 'unchanged packed Float32 values need no GPU upload');
  bubbles[1].collapse = .5;
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(uploads(gl).at(-1).args.at(-1), changedUpload.args.at(-1));
  assert.equal(selected(gl, 'createBuffer').length, bufferCount);
  assert.equal(selected(gl, 'createTexture').length, textureCount);
  assert.equal(vertexUploads(gl).length, vertexCount);
});

test('only pages whose referenced local links changed upload; a shared bubble updates both pages', () => {
  const gl = mockGL({ maxTexture: 24 }), batch = new SheetBatch(gl), bubbles = states(26);
  const layout = Array.from({ length: 26 }, (_, index) => ({ x: index + .5, y: .5, radius: .1 }));
  const tiles = Array.from({ length: 25 }, (_, index) => tile(index, 0, 1, 1, index === 24 ? [23, 24] : [index]));
  const view = geometry(25, 1, 1), deformation = new Float32Array(104);
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(dynamicUploads(gl).length, 2, 'each all-zero initial page must become complete on the GPU');
  const firstPage = dynamicUploads(gl)[0].texture, secondPage = dynamicUploads(gl)[1].texture;
  bubbles[25].collapse = 1;
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(dynamicUploads(gl).length, 2, 'an unreferenced source must not dirty any page');
  bubbles[0].collapse = .25;
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(dynamicUploads(gl).length, 3);
  assert.equal(dynamicUploads(gl).at(-1).texture, firstPage);
  assert.equal(dynamicUploads(gl).at(-1).data[3], .25);
  bubbles[23].collapse = .75;
  render(batch, bubbles, layout, tiles, view, deformation);
  const changed = dynamicUploads(gl).slice(3);
  assert.deepEqual(changed.map(upload => upload.texture), [firstPage, secondPage]);
  assert.equal(changed[0].data[23 * 96 + 3], .75);
  assert.equal(changed[1].data[3], .75);
  const uploadCount = dynamicUploads(gl).length;
  render(batch, bubbles, layout, tiles, view, deformation);
  assert.equal(dynamicUploads(gl).length, uploadCount);
});

test('geometry changes rebuild pixel bounds and tile or layout changes rebuild static site data', () => {
  const gl = mockGL(), batch = new SheetBatch(gl), bubbles = states(1);
  let layout = [{ x: 4, y: 6, radius: 2 }], tiles = [tile(0, 0, 10, 10, [0])];
  render(batch, bubbles, layout, tiles, geometry(10, 10, 1));
  const firstVertices = verticesByTile(gl).length;
  render(batch, bubbles, layout, tiles, geometry(10, 10, 2));
  const resized = verticesByTile(gl).slice(firstVertices);
  assert.equal(resized.length, 1);
  assert.equal(Math.max(...resized[0].map(vertex => vertex[0])), 20);
  assert.equal(Math.max(...resized[0].map(vertex => vertex[1])), 20);
  layout = [{ x: 8, y: 6, radius: 2 }];
  render(batch, bubbles, layout, tiles, geometry(10, 10, 2));
  assert.equal(staticUploads(gl).at(-1).data[0], 8);
  tiles = [tile(0, 0, 10, 10)];
  render(batch, bubbles, layout, tiles, geometry(10, 10, 2));
  assert.ok(verticesByTile(gl).at(-1).every(vertex => vertex[3] === 0));
});

test('100, 500 and 1000 sites page mobile tiles into bounded ordinary draws on a small texture device', () => {
  for (const count of [100, 500, 1000]) {
    const gl = mockGL({ maxTexture: 32 }), batch = new SheetBatch(gl), sheet = new SheetState();
    const layout = Array.from({ length: count }, (_, index) => ({
      x: 10 + index % 25 * 13, y: 10 + Math.floor(index / 25) * 13, radius: 3,
    }));
    sheet.resize(layout, 390, 844);
    assert.equal(render(batch, states(count), layout, sheet.tiles, geometry(), sheet.deformation), true);
    const draws = selected(gl, 'drawArrays');
    assert.equal(draws.length, Math.ceil(sheet.tiles.length / 32));
    assert.ok(draws.every((call, page) => call.args[0] === 'TRIANGLES' && call.args[1] === page * 192 && call.args[2] <= 192));
    assert.equal(draws.reduce((sum, call) => sum + call.args[2], 0), sheet.tiles.length * 6);
    const sites = staticUploads(gl), links = dynamicUploads(gl);
    assert.equal(sites.length, draws.length);
    assert.equal(links.length, draws.length);
    sites.forEach((upload, page) => {
      const rowCount = Math.min(32, sheet.tiles.length - page * 32);
      assert.equal(textureHeight(upload), rowCount);
      assert.equal(textureWidth(links[page]), 24);
      assert.equal(textureHeight(links[page]), rowCount);
      for (let row = 0; row < rowCount; row++) {
        const indices = sheet.tiles[page * 32 + row].indices;
        assert.deepEqual(upload.data.slice(row * 96, row * 96 + indices.length * 4).filter((_, offset) => offset % 4 === 3), Array.from(indices));
      }
    });
    const groups = verticesByTile(gl);
    groups.forEach((group, index) => assert.ok(group.every(vertex => vertex[2] === index % 32 + .5 && vertex[3] === sheet.tiles[index].indices.length)));
  }
});

test('oversized link textures return to fallback before allocating layout data and reset active state', () => {
  const gl = mockGL({ maxTexture: 32 }), batch = new SheetBatch(gl);
  const layout = [{ x: 5, y: 5, radius: 2 }], tiles = [tile(0, 0, 10, 10, [0])];
  assert.equal(render(batch, states(1), layout, tiles), true);
  assert.equal(batch.active, true);
  const before = gl.calls.length;
  const largeLayout = Array.from({ length: 1025 }, () => ({ x: 5, y: 5, radius: 2 }));
  assert.equal(render(batch, states(1025), largeLayout, tiles), false);
  assert.equal(batch.active, false);
  assert.ok(gl.calls.slice(before).every(call => !['createBuffer', 'createTexture', 'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'drawArrays'].includes(call.name)));
  assert.equal(render(batch, states(1), layout, tiles), true);
  assert.equal(batch.active, true);
});

test('disposing a successful batch releases its GPU resources and selects fallback afterwards', () => {
  const gl = mockGL(), batch = new SheetBatch(gl), layout = [{ x: 5, y: 5, radius: 2 }], tiles = [tile(0, 0, 10, 10, [0])];
  render(batch, states(1), layout, tiles);
  batch.dispose();
  assert.equal(selected(gl, 'deleteBuffer').length, selected(gl, 'createBuffer').length);
  assert.equal(selected(gl, 'deleteTexture').length, selected(gl, 'createTexture').length);
  assert.equal(batch.available, false);
  assert.equal(batch.active, false);
  assert.equal(render(batch, states(1), layout, tiles), false);
});
