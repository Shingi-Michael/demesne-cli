// Image transport only; the visible UI and all hit testing live in Chromium.
export function viewport(columns: number, rows: number, cell: { width: number; height: number }) {
  return { width: Math.max(1, columns * cell.width), height: Math.max(1, rows * cell.height) };
}
const kitty = (header: string, payload = "") => `\x1b_G${header}${payload ? ";" + payload : ""}\x1b\\`;
export const removeImage = (id: number) => kitty(`a=d,d=I,i=${id},q=2`);
export function encodeFrame(png: Uint8Array, columns: number, rows: number, id: number, previous?: number): string {
  if (![columns, rows, id].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid image geometry or ID");
  const data = Buffer.from(png).toString("base64");
  let output = "\x1b[?2026h";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const payload = data.slice(offset, offset + 4096);
    output += kitty(`${offset ? "" : `a=t,t=d,f=100,i=${id},q=2,`}m=${offset + payload.length < data.length ? 1 : 0}`, payload);
  }
  output += "\x1b[1;1H" + kitty(`a=p,i=${id},p=1,c=${columns},r=${rows},C=1,z=1,q=2`);
  // Upload and place first, then retire the old image. A changing frame never becomes a blank screen.
  if (previous) output += removeImage(previous);
  return output + "\x1b[?2026l";
}

export interface TilePatch { id: number; x: number; y: number; width: number; height: number; png: string }
export interface TileBatch { kind: "tiles"; serial: number; epoch: number; width: number; height: number; reset: boolean; tiles: TilePatch[]; metrics?: Record<string, number> }
interface Placement { ids: [number, number]; front: number }

/// Two IDs per live tile are reused, so repeated typing cannot grow the
/// terminal's image cache. A resize replaces the grid atomically.
export class TileTransport {
  private epoch = -1;
  private nextId = 140001;
  private placements = new Map<number, Placement>();
  apply(batch: TileBatch, cell: { width: number; height: number }): string {
    const reset = batch.epoch !== this.epoch;
    if (reset && !batch.reset) throw new Error("A new viewport needs a complete tile set");
    for (const tile of batch.tiles) {
      if (![tile.x, tile.y, tile.width, tile.height].every(Number.isSafeInteger) || tile.x < 0 || tile.y < 0 || tile.width <= 0 || tile.height <= 0 ||
        tile.x + tile.width > batch.width || tile.y + tile.height > batch.height ||
        tile.x % cell.width || tile.y % cell.height || tile.width % cell.width || tile.height % cell.height) throw new Error("Invalid tile placement");
    }
    const retired = reset ? [...this.placements.values()].map(item => item.front) : [];
    if (reset) { this.placements.clear(); this.epoch = batch.epoch; }
    let output = "\x1b[?2026h";
    for (const tile of batch.tiles) {
      let placement = this.placements.get(tile.id);
      if (!placement) {
        if (this.nextId + 1 > 0xffffffff) throw new Error("Terminal image ID space exhausted");
        placement = { ids: [this.nextId++, this.nextId++], front: 0 }; this.placements.set(tile.id, placement);
      }
      const id = placement.front === placement.ids[0] ? placement.ids[1] : placement.ids[0];
      for (let offset = 0; offset < tile.png.length; offset += 4096) {
        const payload = tile.png.slice(offset, offset + 4096);
        output += kitty(`${offset ? "" : `a=t,t=d,f=100,i=${id},q=2,`}m=${offset + payload.length < tile.png.length ? 1 : 0}`, payload);
      }
      output += `\x1b[${tile.y / cell.height + 1};${tile.x / cell.width + 1}H` + kitty(`a=p,i=${id},p=1,c=${tile.width / cell.width},r=${tile.height / cell.height},C=1,z=1,q=2`);
      if (placement.front) output += removeImage(placement.front);
      placement.front = id;
    }
    for (const id of retired) if (id) output += removeImage(id);
    return output + "\x1b[?2026l";
  }
  clear(): string {
    const output = [...this.placements.values()].map(item => removeImage(item.front)).join("");
    this.placements.clear(); this.epoch = -1; return output;
  }
  get size() { return this.placements.size; }
}
