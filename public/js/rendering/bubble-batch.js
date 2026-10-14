// Per-cap data stays in a small bounded batch. The permanent wrinkle texture
// is sampled only by vented caps and does not require float colour buffers.
export const BATCH_STRIDE = 14;
export const MEMBRANE_TEXELS = 15;
const MEMBRANE_STRIDE = MEMBRANE_TEXELS * 4;
const EXPANDED_STRIDE = BATCH_STRIDE + 2;
const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
const ATTRIBUTE_SIZES = [4, 4, 3, 2, 1];
const ATTRIBUTE_OFFSETS = [0, 4, 8, 11, 13];

export function bubbleVisible(position, width, height) {
  const extent = position.radius * 1.38;
  return !(position.x + extent < 0 || position.y + extent < 0
    || position.x - extent > width || position.y - extent > height);
}

export function packBubbleRect(target, offset, position, geometry) {
  const extent = position.radius * 1.38, dpr = geometry.dpr;
  // Preserve the old viewport rounding independently for both origin and size.
  // Rounding two endpoints instead would subtly move the cap's local UVs.
  target[offset] = Math.round((position.x - extent) * dpr);
  target[offset + 1] = Math.round((geometry.height - position.y - extent) * dpr);
  target[offset + 2] = Math.round(extent * 2 * dpr);
  target[offset + 3] = target[offset + 2];
  return target;
}

export function packBubbleRecord(target, offset, bubble, position, rects, rectOffset, deformation, index, row) {
  target[offset] = rects[rectOffset];
  target[offset + 1] = rects[rectOffset + 1];
  target[offset + 2] = rects[rectOffset + 2];
  target[offset + 3] = rects[rectOffset + 3];
  target[offset + 4] = bubble.seed;
  target[offset + 5] = bubble.compression;
  target[offset + 6] = bubble.collapse;
  target[offset + 7] = bubble.bulge;
  target[offset + 8] = bubble.x;
  target[offset + 9] = -bubble.y;
  target[offset + 10] = position.radius;
  target[offset + 11] = deformation ? deformation[index * 4] : 0;
  target[offset + 12] = deformation ? deformation[index * 4 + 1] : 0;
  target[offset + 13] = row + .5;
  return target;
}

export function packMembraneRow(target, offset, membrane) {
  if (!membrane) {
    target.fill(0, offset, offset + MEMBRANE_STRIDE);
    return target;
  }
  target[offset] = membrane.air;
  target[offset + 1] = 0; target[offset + 2] = 0; target[offset + 3] = 0;
  target.set(membrane.dent, offset + 4);
  target.set(membrane.folds, offset + 8);
  target.set(membrane.profiles, offset + 28);
  target.set(membrane.pockets, offset + 48);
  return target;
}

export class BubbleBatch {
  constructor(gl) {
    this.gl = gl;
    this.angle = gl.getExtension('ANGLE_instanced_arrays');
    const floatTexture = gl.getExtension('OES_texture_float');
    const maximumTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.available = !!floatTexture && gl.getParameter(gl.MAX_VERTEX_ATTRIBS) >= 6
      && maximumTexture >= MEMBRANE_TEXELS;
    this.mode = this.angle ? 'instanced' : 'expanded';
    this.maximumCapacity = Math.min(256, maximumTexture);
    this.capacity = 0;
    this.layout = null;
    this.indices = new Uint32Array(0);
    this.rects = new Float32Array(0);
    this.records = new Float32Array(0);
    this.expandedRecords = new Float32Array(0);
    this.membraneData = new Float32Array(0);
    this.membranes = [];
    this.chunks = [];
    this.uploadedChunk = null;
    this.uploadedVersion = -1;
    if (!this.available) return;
    this.quadBuffer = gl.createBuffer();
    this.recordBuffer = gl.createBuffer();
    this.expandedBuffer = gl.createBuffer();
    this.texture = gl.createTexture();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  grow(count) {
    const required = Math.min(count, this.maximumCapacity);
    if (required <= this.capacity) return;
    let capacity = Math.max(1, this.capacity);
    while (capacity < required) capacity *= 2;
    this.capacity = Math.min(capacity, this.maximumCapacity);
    this.records = new Float32Array(this.capacity * BATCH_STRIDE);
    this.expandedRecords = new Float32Array(this.capacity * 6 * EXPANDED_STRIDE);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.recordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.records.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.expandedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.expandedRecords.byteLength, gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MEMBRANE_TEXELS, this.capacity, 0, gl.RGBA, gl.FLOAT, null);
    this.uploadedChunk = null;
  }

  cacheLayout(layout, geometry) {
    if (this.layout === layout && this.layoutLength === layout.length
      && this.width === geometry.width && this.height === geometry.height
      && this.dpr === geometry.dpr && this.framebufferWidth === geometry.framebufferWidth
      && this.framebufferHeight === geometry.framebufferHeight) return;
    this.layout = layout; this.layoutLength = layout.length;
    this.width = geometry.width; this.height = geometry.height; this.dpr = geometry.dpr;
    this.framebufferWidth = geometry.framebufferWidth; this.framebufferHeight = geometry.framebufferHeight;
    let count = 0;
    for (let index = 0; index < layout.length; index++) {
      if (bubbleVisible(layout[index], geometry.width, geometry.height)) count++;
    }
    this.indices = new Uint32Array(count);
    this.rects = new Float32Array(count * 4);
    this.membraneData = new Float32Array(count * MEMBRANE_STRIDE);
    this.membranes = new Array(count).fill(null);
    let visible = 0;
    for (let index = 0; index < layout.length; index++) {
      const position = layout[index];
      if (!bubbleVisible(position, geometry.width, geometry.height)) continue;
      this.indices[visible] = index;
      packBubbleRect(this.rects, visible * 4, position, geometry);
      visible++;
    }
    this.grow(count);
    this.chunks = [];
    for (let start = 0; start < count; start += this.capacity) {
      const chunkCount = Math.min(this.capacity, count - start);
      // Cache views on resize; WebGL 1 has no source-offset upload overload.
      this.chunks.push({
        start, count: chunkCount, version: 0,
        records: this.records.subarray(0, chunkCount * BATCH_STRIDE),
        expanded: this.expandedRecords.subarray(0, chunkCount * 6 * EXPANDED_STRIDE),
        membranes: this.membraneData.subarray(start * MEMBRANE_STRIDE, (start + chunkCount) * MEMBRANE_STRIDE),
      });
    }
  }

  bindAttributes(expanded) {
    const gl = this.gl;
    const stride = (expanded ? EXPANDED_STRIDE : BATCH_STRIDE) * 4;
    const prefix = expanded ? 2 : 0;
    if (this.angle) this.angle.vertexAttribDivisorANGLE(0, 0);
    gl.enableVertexAttribArray(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, expanded ? this.expandedBuffer : this.quadBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, expanded ? stride : 0, 0);
    if (!expanded) gl.bindBuffer(gl.ARRAY_BUFFER, this.recordBuffer);
    for (let attribute = 1; attribute <= 5; attribute++) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, ATTRIBUTE_SIZES[attribute - 1], gl.FLOAT, false,
        stride, (ATTRIBUTE_OFFSETS[attribute - 1] + prefix) * 4);
      if (this.angle) this.angle.vertexAttribDivisorANGLE(attribute, expanded ? 0 : 1);
    }
  }

  restoreAttributes() {
    const gl = this.gl;
    if (this.angle) {
      for (let attribute = 0; attribute <= 5; attribute++) this.angle.vertexAttribDivisorANGLE(attribute, 0);
    }
    for (let attribute = 1; attribute <= 5; attribute++) gl.disableVertexAttribArray(attribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  draw(bubbles, layout, deformation, geometry, getMembrane, uniforms) {
    if (!this.available) return false;
    this.cacheLayout(layout, geometry);
    if (!this.indices.length) return true;
    const gl = this.gl, expanded = this.mode === 'expanded' || !this.angle;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(uniforms.membranes, 0);
    gl.uniform1f(uniforms.membrane_rows, this.capacity);
    this.bindAttributes(expanded);
    try {
      for (const chunk of this.chunks) {
        let needsMembranes = false;
        for (let row = 0; row < chunk.count; row++) {
          const visible = chunk.start + row, index = this.indices[visible];
          const bubble = bubbles[index], position = layout[index], recordOffset = row * BATCH_STRIDE;
          packBubbleRecord(this.records, recordOffset, bubble, position, this.rects, visible * 4, deformation, index, row);
          const membrane = bubble.popped || bubble.collapse > .001 ? getMembrane(bubble, index) : null;
          if (membrane !== this.membranes[visible]) {
            packMembraneRow(this.membraneData, visible * MEMBRANE_STRIDE, membrane);
            this.membranes[visible] = membrane;
            chunk.version++;
          }
          // Match heightAt's branch. A popped cap before venting progresses
          // caches its eventual folds without making the GPU upload them yet.
          if (bubble.collapse > .001) needsMembranes = true;
          if (expanded) {
            for (let vertex = 0; vertex < 6; vertex++) {
              const offset = (row * 6 + vertex) * EXPANDED_STRIDE;
              this.expandedRecords[offset] = QUAD[vertex * 2];
              this.expandedRecords[offset + 1] = QUAD[vertex * 2 + 1];
              for (let field = 0; field < BATCH_STRIDE; field++) {
                this.expandedRecords[offset + 2 + field] = this.records[recordOffset + field];
              }
            }
          }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, expanded ? this.expandedBuffer : this.recordBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, expanded ? chunk.expanded : chunk.records);
        if (needsMembranes && (this.uploadedChunk !== chunk || this.uploadedVersion !== chunk.version)) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MEMBRANE_TEXELS, chunk.count, gl.RGBA, gl.FLOAT, chunk.membranes);
          this.uploadedChunk = chunk; this.uploadedVersion = chunk.version;
        }
        if (expanded) gl.drawArrays(gl.TRIANGLES, 0, chunk.count * 6);
        else this.angle.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, chunk.count);
      }
    } finally {
      // The sheet and legacy cap programs share this context and location 0.
      this.restoreAttributes();
    }
    return true;
  }

  dispose() {
    if (!this.available) return;
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuffer); gl.deleteBuffer(this.recordBuffer); gl.deleteBuffer(this.expandedBuffer);
    gl.deleteTexture(this.texture);
    this.available = false;
  }
}
