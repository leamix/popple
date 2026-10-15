import { PHYSICS_CONFIG, SHEET_CONFIG } from './config.js';

export const MAX_SHEET_SITES = SHEET_CONFIG.maximumShaderSites;

// The shader's sheet influence ends at 3 radii. Reserve the largest positional
// shift as well, so a shifted support cannot appear across a tile's boundary.
const SUPPORT_RADIUS = SHEET_CONFIG.supportRadius;
const NEIGHBOUR_RADIUS = SHEET_CONFIG.neighbourRadius;
const MAX_OFFSET = SHEET_CONFIG.maximumOffset;
const POP_PULSE_SECONDS = SHEET_CONFIG.popPulseSeconds;

const clamp01 = value => Math.max(0, Math.min(1, value));

function intersects(site, x, y, width, height) {
  const dx = site.x - Math.max(x, Math.min(site.x, x + width));
  const dy = site.y - Math.max(y, Math.min(site.y, y + height));
  const reach = site.radius * SUPPORT_RADIUS;
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * The common weld couples only immediately adjacent pockets. Physics remains
 * owned by BubbleState; this cache is an allocation-free visual response.
 * Rebuild the spatial hash, weld directions and render tiles only on resize.
 */
export class SheetState {
  constructor() {
    this.deformation = new Float32Array(0);
    this.tiles = [];
    this.neighbours = [];
    this.layout = [];
    this._directions = [];
    this._weights = [];
    this._hash = new Map();
    this._cellSize = 1;
    this._maxRadius = 0;
    this._contacts = new Map();
  }

  resize(layout, width, height) {
    this._contacts.clear();
    this.layout = layout;
    this.width = Math.max(0, Number.isFinite(width) ? width : 0);
    this.height = Math.max(0, Number.isFinite(height) ? height : 0);
    this.deformation = new Float32Array(layout.length * 4);
    this.tiles = [];
    this.neighbours = new Array(layout.length);
    this._directions = new Array(layout.length);
    this._weights = new Array(layout.length);
    this._hash = new Map();
    let maxRadius = 0;
    for (const site of layout) {
      if (!Number.isFinite(site.x) || !Number.isFinite(site.y)
        || !Number.isFinite(site.radius) || site.radius <= 0) {
        throw new RangeError('Sheet sites need finite positions and a positive radius');
      }
      maxRadius = Math.max(maxRadius, site.radius);
    }
    this._maxRadius = maxRadius;
    this._cellSize = Math.max(1, maxRadius * NEIGHBOUR_RADIUS);
    for (let index = 0; index < layout.length; index += 1) {
      const site = layout[index];
      const column = Math.floor(site.x / this._cellSize);
      const row = Math.floor(site.y / this._cellSize);
      let rows = this._hash.get(column);
      if (!rows) this._hash.set(column, rows = new Map());
      let bucket = rows.get(row);
      if (!bucket) rows.set(row, bucket = []);
      bucket.push(index);
    }

    // Tile bounds never overlap, including their subdivided replacements.
    // Empty tiles are retained: the renderer must draw the common background.
    const tileSize = Math.max(1, Math.ceil(maxRadius * SHEET_CONFIG.tileRadiusFactor));
    for (let y = 0; y < this.height; y += tileSize) {
      for (let x = 0; x < this.width; x += tileSize) {
        this._addTile(x, y, Math.min(tileSize, this.width - x), Math.min(tileSize, this.height - y), 0);
      }
    }

    // The hash bounds queries to nearby cells; nearest six welds are sufficient
    // for a hex sheet, even if a future layout adds a denser local decoration.
    for (let index = 0; index < layout.length; index += 1) {
      const site = layout[index];
      const reach = NEIGHBOUR_RADIUS * (site.radius + maxRadius) * 0.5;
      const candidates = [];
      this._visit(site.x - reach, site.y - reach, site.x + reach, site.y + reach, candidate => {
        if (candidate === index) return;
        const other = layout[candidate];
        const dx = site.x - other.x;
        const dy = site.y - other.y;
        const distanceSquared = dx * dx + dy * dy;
        const localReach = NEIGHBOUR_RADIUS * (site.radius + other.radius) * 0.5;
        if (distanceSquared > 0 && distanceSquared < localReach * localReach) {
          candidates.push({ index: candidate, distanceSquared });
        }
      });
      candidates.sort((a, b) => a.distanceSquared - b.distanceSquared || a.index - b.index);
      const count = Math.min(6, candidates.length);
      const adjacent = new Uint32Array(count);
      const directions = new Float32Array(count * 2);
      const weights = new Float32Array(count);
      for (let link = 0; link < count; link += 1) {
        const candidate = candidates[link];
        const other = layout[candidate.index];
        const distance = Math.sqrt(candidate.distanceSquared);
        adjacent[link] = candidate.index;
        // Direction from the neighbour back to the pressed source.
        directions[link * 2] = (site.x - other.x) / distance;
        directions[link * 2 + 1] = (site.y - other.y) / distance;
        weights[link] = Math.min(1, (1 - distance / (NEIGHBOUR_RADIUS * (site.radius + other.radius) * 0.5)) * SHEET_CONFIG.coupling.distanceGain);
      }
      this.neighbours[index] = adjacent;
      this._directions[index] = directions;
      this._weights[index] = weights;
    }
  }

  /** Visit a small hash rectangle while building geometry or moving a contact. */
  _visit(minX, minY, maxX, maxY, visit) {
    const firstColumn = Math.floor(minX / this._cellSize);
    const lastColumn = Math.floor(maxX / this._cellSize);
    const firstRow = Math.floor(minY / this._cellSize);
    const lastRow = Math.floor(maxY / this._cellSize);
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const rows = this._hash.get(column);
      if (!rows) continue;
      for (let row = firstRow; row <= lastRow; row += 1) {
        const bucket = rows.get(row);
        if (!bucket) continue;
        for (let index = 0; index < bucket.length; index += 1) visit(bucket[index]);
      }
    }
  }

  _addTile(x, y, width, height, depth) {
    const reach = this._maxRadius * SUPPORT_RADIUS;
    const indices = [];
    this._visit(x - reach, y - reach, x + width + reach, y + height + reach, index => {
      if (intersects(this.layout[index], x, y, width, height)) indices.push(index);
    });
    if (indices.length <= MAX_SHEET_SITES) {
      this.tiles.push({ x, y, width, height, indices: Uint32Array.from(indices) });
      return;
    }
    if (depth >= 8) {
      throw new RangeError(`Sheet overlap is too dense for ${MAX_SHEET_SITES} local shader sites`);
    }
    // Subdivide rather than silently dropping a site's welded rim. Dense
    // coincident supports still fail clearly once subdivision cannot help.
    const halfWidth = width * 0.5;
    const halfHeight = height * 0.5;
    this._addTile(x, y, halfWidth, halfHeight, depth + 1);
    this._addTile(x + halfWidth, y, width - halfWidth, halfHeight, depth + 1);
    this._addTile(x, y + halfHeight, halfWidth, height - halfHeight, depth + 1);
    this._addTile(x + halfWidth, y + halfHeight, width - halfWidth, height - halfHeight, depth + 1);
  }

  /** Cache a gap's nearest supports only on input; frames reuse these arrays. */
  setContact(id, x, y, pressure = PHYSICS_CONFIG.defaultPressure) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > this.width || y > this.height) {
      this.releaseContact(id);
      return;
    }
    let contact = this._contacts.get(id);
    if (!contact) {
      contact = { strength: SHEET_CONFIG.contact.initialStrength, target: 1, indices: [],
        directions: new Float32Array(12), weights: new Float32Array(6) };
      this._contacts.set(id, contact);
    }
    contact.target = SHEET_CONFIG.contact.forceBase + SHEET_CONFIG.contact.forceRange
      * clamp01(Number.isFinite(pressure) ? pressure : PHYSICS_CONFIG.defaultPressure);
    const indices = contact.indices;
    indices.length = 0;
    const reach = this._maxRadius * NEIGHBOUR_RADIUS;
    this._visit(x - reach, y - reach, x + reach, y + reach, index => {
      const site = this.layout[index];
      const dx = x - site.x, dy = y - site.y;
      if (dx * dx + dy * dy < (site.radius * NEIGHBOUR_RADIUS) ** 2) indices.push(index);
    });
    indices.sort((a, b) => {
      const first = this.layout[a], second = this.layout[b];
      return (x - first.x) ** 2 + (y - first.y) ** 2 - (x - second.x) ** 2 - (y - second.y) ** 2;
    });
    indices.length = Math.min(6, indices.length);
    for (let link = 0; link < indices.length; link += 1) {
      const site = this.layout[indices[link]];
      const dx = x - site.x, dy = y - site.y, distance = Math.hypot(dx, dy);
      contact.directions[link * 2] = distance ? dx / distance : 0;
      contact.directions[link * 2 + 1] = distance ? dy / distance : 0;
      contact.weights[link] = Math.min(1, (1 - distance / (site.radius * NEIGHBOUR_RADIUS)) * SHEET_CONFIG.contact.distanceGain);
    }
  }

  releaseContact(id) {
    const contact = this._contacts.get(id);
    if (contact) contact.target = 0;
  }

  get needsAnimation() {
    for (const contact of this._contacts.values()) if (contact.strength !== contact.target) return true;
    return false;
  }

  stepContacts(dt, reduced = false) {
    const delta = Number.isFinite(dt) ? Math.max(0, Math.min(PHYSICS_CONFIG.maximumFrameSeconds, dt)) : 0;
    for (const [id, contact] of this._contacts) {
      const rate = contact.target ? SHEET_CONFIG.contact.attack
        : reduced ? SHEET_CONFIG.contact.reducedRelease : SHEET_CONFIG.contact.release;
      contact.strength += (contact.target - contact.strength) * (1 - Math.exp(-delta * rate));
      if (Math.abs(contact.target - contact.strength) < PHYSICS_CONFIG.settleEpsilon) {
        if (contact.target) contact.strength = contact.target;
        else this._contacts.delete(id);
      }
    }
  }

  update(bubbles, reduced = false) {
    const deformation = this.deformation;
    deformation.fill(0);
    const count = Math.min(this.layout.length, bubbles.length);
    for (let index = 0; index < count; index += 1) {
      const bubble = bubbles[index];
      // Released spring compression still pulls the weld. A popped pocket's
      // 0.06 settled compression is slack plastic, so it contributes nothing.
      const compression = bubble.popped ? Math.max(0, bubble.compression - PHYSICS_CONFIG.settledCompression) : bubble.compression;
      const bulge = bubble.popped ? 0 : bubble.bulge;
      const strain = clamp01(compression * SHEET_CONFIG.strain.compression + bulge * SHEET_CONFIG.strain.bulge);
      const age = bubble.popAge;
      const wave = !reduced && bubble.popped && age >= 0 && age < POP_PULSE_SECONDS
        ? Math.cos(age * SHEET_CONFIG.pulse.frequency) * Math.exp(-age * SHEET_CONFIG.pulse.decay) * (1 - age / POP_PULSE_SECONDS) : 0;
      const offset = index * 4;
      deformation[offset + 2] += strain;
      deformation[offset + 3] += wave * SHEET_CONFIG.pulse.self;
      if (strain === 0 && wave === 0) continue;
      const adjacent = this.neighbours[index];
      const directions = this._directions[index];
      const weights = this._weights[index];
      const pull = compression * SHEET_CONFIG.pull.compression + bulge * SHEET_CONFIG.pull.bulge + wave * SHEET_CONFIG.pull.pulse;
      for (let link = 0; link < adjacent.length; link += 1) {
        const target = adjacent[link] * 4;
        const weight = weights[link];
        deformation[target] += directions[link * 2] * pull * weight;
        deformation[target + 1] += directions[link * 2 + 1] * pull * weight;
        deformation[target + 2] += (strain * SHEET_CONFIG.coupling.strain + Math.abs(wave) * SHEET_CONFIG.coupling.pulseTension) * weight;
        deformation[target + 3] += wave * SHEET_CONFIG.pulse.neighbour * weight;
      }
    }
    for (const contact of this._contacts.values()) {
      const pull = contact.strength * SHEET_CONFIG.contact.pull;
      const strain = contact.strength * SHEET_CONFIG.contact.strain;
      for (let link = 0; link < contact.indices.length; link += 1) {
        const offset = contact.indices[link] * 4;
        const weight = contact.weights[link];
        deformation[offset] += contact.directions[link * 2] * pull * weight;
        deformation[offset + 1] += contact.directions[link * 2 + 1] * pull * weight;
        deformation[offset + 2] += strain * weight;
      }
    }
    for (let index = 0; index < this.layout.length; index += 1) {
      const offset = index * 4;
      const x = deformation[offset], y = deformation[offset + 1];
      const lengthSquared = x * x + y * y;
      if (lengthSquared > MAX_OFFSET * MAX_OFFSET) {
        const scale = MAX_OFFSET / Math.sqrt(lengthSquared);
        deformation[offset] *= scale;
        deformation[offset + 1] *= scale;
      }
      deformation[offset + 2] = Math.min(1, deformation[offset + 2]);
      deformation[offset + 3] = Math.max(-SHEET_CONFIG.pulse.maximum, Math.min(SHEET_CONFIG.pulse.maximum, deformation[offset + 3]));
    }
  }

  reset() {
    this.deformation.fill(0);
    this._contacts.clear();
  }

  /** Pointer hit lookup preserves original layout identity without an N scan. */
  hitIndex(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const reach = this._maxRadius;
    const firstColumn = Math.floor((x - reach) / this._cellSize);
    const lastColumn = Math.floor((x + reach) / this._cellSize);
    const firstRow = Math.floor((y - reach) / this._cellSize);
    const lastRow = Math.floor((y + reach) / this._cellSize);
    let result = -1;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const rows = this._hash.get(column);
      if (!rows) continue;
      for (let row = firstRow; row <= lastRow; row += 1) {
        const bucket = rows.get(row);
        if (!bucket) continue;
        for (let position = 0; position < bucket.length; position += 1) {
          const index = bucket[position];
          if (result !== -1 && index >= result) continue;
          const site = this.layout[index];
          const dx = x - site.x, dy = y - site.y;
          if (dx * dx + dy * dy <= site.radius * site.radius) result = index;
        }
      }
    }
    return result;
  }
}
