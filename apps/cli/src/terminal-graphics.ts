/// Kitty graphics commands are returned to the workbench's single output owner.
/// This module never writes to stdout or changes transcript state.
export interface ImagePlacement {
  row: number; column: number; columns: number; rows: number;
}
export interface TerminalImage {
  key: string;
  png: Uint8Array;
  placement: ImagePlacement;
}

const command = (header: string, data = "") => `\x1b_G${header}${data ? `;${data}` : ""}\x1b\\`;

export function graphicsProbe(id: number): string {
  return command(`a=q,t=d,f=24,s=1,v=1,i=${id}`, "AAAA") + "\x1b[16t";
}

/// Fit in physical pixels: terminal cells are generally taller than wide.
export function fitImage(width: number, height: number, slot: ImagePlacement,
  cell: { width: number; height: number }): ImagePlacement | null {
  if (![width, height, slot.columns, slot.rows, cell.width, cell.height].every((n) => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(slot.columns * cell.width / width, slot.rows * cell.height / height);
  const columns = Math.max(1, Math.min(slot.columns, Math.floor(width * scale / cell.width)));
  const rows = Math.max(1, Math.min(slot.rows, Math.floor(height * scale / cell.height)));
  return { row: slot.row + Math.floor((slot.rows - rows) / 2), column: slot.column + Math.floor((slot.columns - columns) / 2), columns, rows };
}

export class TerminalGraphics {
  private current: TerminalImage | null = null;
  constructor(readonly imageId: number) {
    if (!Number.isInteger(imageId) || imageId <= 0 || imageId > 0xffffffff) throw new Error("Invalid terminal image ID");
  }

  update(image: TerminalImage | null): string {
    if (!image) return this.clear();
    const p = image.placement;
    if (![p.row, p.column, p.columns, p.rows].every(Number.isInteger) || p.row < 0 || p.column < 0 || p.columns < 1 || p.rows < 1) throw new Error("Invalid image placement");
    const changed = this.current?.key !== image.key;
    if (!changed && JSON.stringify(this.current?.placement) === JSON.stringify(p)) return "";
    let output = this.current ? command(`a=d,d=${changed ? "I" : "i"},i=${this.imageId},q=2`) : "";
    if (changed) {
      const data = Buffer.from(image.png).toString("base64");
      for (let offset = 0; offset < data.length; offset += 4096) {
        const chunk = data.slice(offset, offset + 4096);
        output += command(`${offset === 0 ? `a=t,t=d,f=100,i=${this.imageId},q=2,` : ""}m=${offset + chunk.length < data.length ? 1 : 0}`, chunk);
      }
    }
    output += `\x1b[${p.row + 1};${p.column + 1}H` + command(`a=p,i=${this.imageId},p=1,c=${p.columns},r=${p.rows},C=1,q=2`);
    this.current = { ...image, placement: { ...p } };
    return output;
  }

  clear(): string {
    if (!this.current) return "";
    this.current = null;
    return command(`a=d,d=I,i=${this.imageId},q=2`);
  }
}
