// Retain a complete bitmap because Electron paint buffers may only initialize
// the dirty rectangle. Never reconstruct unchanged pixels from such a buffer.
class TileFrame {
  reset(width, height, tileWidth, tileHeight, bitmap, epoch) {
    if (bitmap.length !== width * height * 4) throw new Error('Invalid bitmap size');
    this.width = width; this.height = height; this.tileWidth = tileWidth; this.tileHeight = tileHeight; this.epoch = epoch;
    this.bitmap = Buffer.from(bitmap); this.previous = new Map(); this.dirty = new Set(); this.first = true;
    this.columns = Math.ceil(width / tileWidth); this.rows = Math.ceil(height / tileHeight);
    for (let id = 0; id < this.columns * this.rows; id++) this.dirty.add(id);
  }
  update(source, sourceWidth, sourceHeight, rect) {
    if (!this.bitmap) return false;
    const full = sourceWidth === this.width && sourceHeight === this.height;
    const cropped = sourceWidth === rect.width && sourceHeight === rect.height;
    if ((!full && !cropped) || source.length !== sourceWidth * sourceHeight * 4) return false;
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width), bottom = Math.min(this.height, rect.y + rect.height);
    if (right <= x || bottom <= y) return false;
    let changed = false;
    for (let row = y; row < bottom; row++) {
      const from = ((full ? row : row - rect.y) * sourceWidth + (full ? x : x - rect.x)) * 4;
      const to = (row * this.width + x) * 4, length = (right - x) * 4;
      if (!source.subarray(from, from + length).equals(this.bitmap.subarray(to, to + length))) {
        source.copy(this.bitmap, to, from, from + length); changed = true;
        const tileRow = Math.floor(row / this.tileHeight);
        for (let column = Math.floor(x / this.tileWidth); column <= Math.floor((right - 1) / this.tileWidth); column++) this.dirty.add(tileRow * this.columns + column);
      }
    }
    return changed;
  }
  drain(encode) {
    const tiles = [], reset = this.first;
    for (const id of this.dirty) {
      const x = id % this.columns * this.tileWidth, y = Math.floor(id / this.columns) * this.tileHeight;
      const width = Math.min(this.tileWidth, this.width - x), height = Math.min(this.tileHeight, this.height - y);
      const data = Buffer.allocUnsafe(width * height * 4);
      for (let row = 0; row < height; row++) this.bitmap.copy(data, row * width * 4, ((y + row) * this.width + x) * 4, ((y + row) * this.width + x + width) * 4);
      if (!data.equals(this.previous.get(id) ?? Buffer.alloc(0))) {
        tiles.push({ id, x, y, width, height, png: encode(data, width, height) }); this.previous.set(id, data);
      }
    }
    this.dirty.clear(); this.first = false;
    return { reset, tiles, epoch: this.epoch, width: this.width, height: this.height };
  }
}
module.exports = { TileFrame };
