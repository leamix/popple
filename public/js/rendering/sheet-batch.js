import { MAX_SHEET_SITES } from '../core/sheet.js';

const VERTEX_STRIDE = 4;
const CORNERS = [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1];

// Keep the existing local site lists and their order. Only submission changes:
// rounded, disjoint tile rectangles share a draw and a static site texture.
// Both textures use the same coordinates, avoiding a dependent texture lookup
// on mobile GPUs. Changing weld data is packed once per bubble on the CPU and
// copied only when needed to the affected cached tile pages.
export class SheetBatch {
  constructor(gl) {
    this.gl = gl;
    this.maximumTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.available = !!gl.getExtension('OES_texture_float')
      && this.maximumTexture >= MAX_SHEET_SITES && gl.getParameter(gl.MAX_VERTEX_ATTRIBS) >= 2;
    this.active = false;
    this.pages = [];
    this.layout = null;
    this.tiles = null;
    this.links = new Float32Array(0);
    if (!this.available) return;
    this.vertexBuffer = gl.createBuffer();
  }

  supports(count) {
    return this.available && count <= this.maximumTexture * this.maximumTexture;
  }

  createTexture() {
    const gl = this.gl, texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  cacheLayout(layout, tiles, geometry) {
    if (this.layout === layout && this.layoutLength === layout.length && this.tiles === tiles
      && this.width === geometry.width && this.height === geometry.height && this.dpr === geometry.dpr
      && this.framebufferWidth === geometry.framebufferWidth && this.framebufferHeight === geometry.framebufferHeight) return;
    this.layout = layout; this.layoutLength = layout.length; this.tiles = tiles;
    this.width = geometry.width; this.height = geometry.height; this.dpr = geometry.dpr;
    this.framebufferWidth = geometry.framebufferWidth; this.framebufferHeight = geometry.framebufferHeight;
    const gl = this.gl;
    const previousPages = this.pages;
    this.pages = [];
    const rectangles = [];
    for (const tile of tiles) {
      const left = Math.round(tile.x * geometry.dpr), right = Math.round((tile.x + tile.width) * geometry.dpr);
      const bottom = Math.round((geometry.height - tile.y - tile.height) * geometry.dpr);
      const top = Math.round((geometry.height - tile.y) * geometry.dpr);
      // A legacy scissor with no pixels produces nothing. Omit its geometry,
      // retaining empty site lists for every tile that does cover pixels.
      if (right > left && top > bottom) rectangles.push({ left, right, bottom, top, tile });
    }
    const vertexLength = rectangles.length * 6 * VERTEX_STRIDE;
    const reuseVertices = this.vertices?.length === vertexLength;
    const vertices = reuseVertices ? this.vertices : new Float32Array(vertexLength);
    for (let start = 0; start < rectangles.length; start += this.maximumTexture) {
      const count = Math.min(this.maximumTexture, rectangles.length - start);
      const previous = previousPages[this.pages.length];
      const reusePage = previous?.count === count;
      const sites = reusePage ? previous.sites : new Float32Array(count * MAX_SHEET_SITES * 4);
      const sources = reusePage ? previous.sources : new Int32Array(count * MAX_SHEET_SITES).fill(-1);
      let sitesChanged = false, mappingChanged = !reusePage;
      for (let row = 0; row < count; row++) {
        const { left, right, bottom, top, tile } = rectangles[start + row];
        for (let vertex = 0; vertex < 6; vertex++) {
          const offset = ((start + row) * 6 + vertex) * VERTEX_STRIDE;
          vertices[offset] = CORNERS[vertex * 2] ? right : left;
          vertices[offset + 1] = CORNERS[vertex * 2 + 1] ? top : bottom;
          vertices[offset + 2] = row + .5;
          vertices[offset + 3] = tile.indices.length;
        }
        for (let site = 0; site < MAX_SHEET_SITES; site++) {
          const index = site < tile.indices.length ? tile.indices[site] : -1;
          const position = index < 0 ? null : layout[index];
          const offset = (row * MAX_SHEET_SITES + site) * 4;
          const x = position ? Math.fround(position.x) : 0, y = position ? Math.fround(position.y) : 0;
          const radius = position ? Math.fround(position.radius) : 0, identity = position ? index : 0;
          if (sites[offset] !== x || sites[offset + 1] !== y
            || sites[offset + 2] !== radius || sites[offset + 3] !== identity) sitesChanged = true;
          sites[offset] = x; sites[offset + 1] = y;
          sites[offset + 2] = radius; sites[offset + 3] = identity;
          const source = position ? index * 4 : -1, sourceOffset = row * MAX_SHEET_SITES + site;
          if (sources[sourceOffset] !== source) mappingChanged = true;
          sources[sourceOffset] = source;
        }
      }
      if (reusePage) {
        if (sitesChanged) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, previous.texture);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_SHEET_SITES, count, gl.RGBA, gl.FLOAT, sites);
        }
        if (mappingChanged) { previous.links.fill(0); previous.uploaded = false; }
        this.pages.push(previous);
      } else {
        if (previous) { gl.deleteTexture(previous.texture); gl.deleteTexture(previous.linkTexture); }
        const texture = this.createTexture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MAX_SHEET_SITES, count, 0, gl.RGBA, gl.FLOAT, sites);
        const linkTexture = this.createTexture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MAX_SHEET_SITES, count, 0, gl.RGBA, gl.FLOAT, null);
        this.pages.push({ start, count, texture, linkTexture, sites, sources,
          links: new Float32Array(sites.length), uploaded: false });
      }
    }
    for (let page = this.pages.length; page < previousPages.length; page++) {
      gl.deleteTexture(previousPages[page].texture); gl.deleteTexture(previousPages[page].linkTexture);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (reuseVertices) gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    else gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.vertices = vertices;
    if (this.links.length !== layout.length * 4) {
      this.links = new Float32Array(layout.length * 4);
      this.linksUploaded = false;
    }
  }

  draw(bubbles, layout, deformation, tiles, geometry, uniforms) {
    this.active = false;
    if (!this.supports(layout.length)) return false;
    this.cacheLayout(layout, tiles, geometry);
    this.active = true;
    if (!this.pages.length) return true;
    const gl = this.gl;
    let dirty = !this.linksUploaded;
    for (let index = 0; index < layout.length; index++) {
      const offset = index * 4;
      const x = deformation[offset], y = deformation[offset + 1];
      const strength = Math.fround(deformation[offset + 2] + deformation[offset + 3] * (.16 / .085));
      const collapse = Math.fround(bubbles[index].collapse);
      if (this.links[offset] !== x || this.links[offset + 1] !== y
        || this.links[offset + 2] !== strength || this.links[offset + 3] !== collapse) dirty = true;
      this.links[offset] = x; this.links[offset + 1] = y;
      this.links[offset + 2] = strength; this.links[offset + 3] = collapse;
    }
    gl.uniform1i(uniforms.sheet_links, 1);
    gl.uniform1i(uniforms.sheet_sites, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_STRIDE * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_STRIDE * 4, 8);
    try {
      for (const page of this.pages) {
        let pageDirty = !page.uploaded;
        if (dirty || pageDirty) for (let record = 0; record < page.sources.length; record++) {
          const source = page.sources[record];
          if (source < 0) continue;
          const offset = record * 4;
          for (let lane = 0; lane < 4; lane++) {
            const value = this.links[source + lane];
            if (page.links[offset + lane] !== value) pageDirty = true;
            page.links[offset + lane] = value;
          }
        }
        gl.activeTexture(gl.TEXTURE0 + 1);
        gl.bindTexture(gl.TEXTURE_2D, page.linkTexture);
        if (pageDirty) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_SHEET_SITES, page.count, gl.RGBA, gl.FLOAT, page.links);
          page.uploaded = true;
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, page.texture);
        gl.uniform1f(uniforms.sheet_rows, page.count);
        gl.drawArrays(gl.TRIANGLES, page.start * 6, page.count * 6);
      }
    } finally {
      gl.disableVertexAttribArray(1);
    }
    this.linksUploaded = true;
    return true;
  }

  dispose() {
    if (!this.available) return;
    const gl = this.gl;
    for (const page of this.pages) {
      gl.deleteTexture(page.texture); gl.deleteTexture(page.linkTexture);
    }
    gl.deleteBuffer(this.vertexBuffer);
    this.pages = [];
    this.available = false; this.active = false;
  }
}
