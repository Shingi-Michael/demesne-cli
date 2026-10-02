import { resolve } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { inflateSync } from "node:zlib";
import sharp from "sharp";

export class TerminalHarness {
  readonly child: ReturnType<typeof Bun.spawn>;
  columns = 150;
  rows = 40;
  cell = { width: 8, height: 18 };
  pixelMouse = true;
  batches = 0;
  bytes = 0;
  images = new Map<number, Buffer>();
  /// How each image was sent: Kitty f/o/s/v fields, and whether by file (t=t).
  formats = new Map<number, { f: string; o?: string; s: number; v: number }>();
  fileTransfers = 0;
  private transferFormat = { f: "100", s: 0, v: 0 } as { f: string; o?: string; s: number; v: number };
  placements = new Map<number, { x: number; y: number; width: number; height: number; z: number }>();
  maxImages = 0;
  restored = false;
  error = "";
  private carry = "";
  private chunks = "";
  private transfer = 0;
  private cursor = { row: 0, column: 0 };
  private changes = false;
  private listeners = new Set<() => void>();
  private decoding = new Map<number, Promise<{ data: Buffer; width: number; height: number }>>();
  constructor(options: { entry?: string; columns?: number; rows?: number; args?: string[]; pixelMouse?: boolean; cell?: {width:number;height:number}; readDelayMs?: number; env?:Record<string,string> } = {}) {
    this.columns = options.columns ?? this.columns; this.rows = options.rows ?? this.rows;
    this.pixelMouse = options.pixelMouse ?? true;
    this.cell = options.cell ?? this.cell;
    this.child = Bun.spawn([process.execPath, options.entry ?? resolve(import.meta.dir, "../terminal.ts"), ...(options.args ?? [])], {
      cwd: resolve(import.meta.dir, "../../.."),
      ...(options.env?{env:options.env}:{}),
      terminal: { cols: this.columns, rows: this.rows, data: (terminal, bytes) => {
        const handle = () => this.consume(Buffer.from(bytes).toString(), text => terminal.write(text));
        if (options.readDelayMs) setTimeout(handle, options.readDelayMs); else handle();
      } },
    });
  }
  private consume(text: string, reply: (value: string) => void) {
    this.bytes += Buffer.byteLength(text); this.carry += text;
    while (this.carry) {
      const start = this.carry.indexOf("\x1b");
      if (start < 0) { this.error = (this.error + this.carry).slice(-1000); this.carry = ""; break; }
      if (start) { this.error = (this.error + this.carry.slice(0, start)).slice(-1000); this.carry = this.carry.slice(start); }
      if (this.carry.startsWith("\x1b_G")) {
        const end = this.carry.indexOf("\x1b\\", 3); if (end < 0) break;
        const command = this.carry.slice(3, end); this.carry = this.carry.slice(end + 2);
        const [header, payload = ""] = command.split(";");
        const fields = Object.fromEntries(header!.split(",").map(pair => pair.split("=")));
        const id = Number(fields.i);
        if (fields.a === "q") {
          // Like Ghostty: a file transfer is OK only if the file is readable.
          const ok = fields.t !== "t" || existsSync(Buffer.from(payload, "base64").toString());
          reply(`\x1b_Gi=${id};${ok ? "OK" : "EINVAL: invalid data"}\x1b\\`); continue;
        }
        if (fields.a === "t") {
          this.transfer = id; this.chunks = "";
          this.transferFormat = { f: fields.f ?? "32", ...(fields.o ? { o: fields.o } : {}), s: Number(fields.s ?? 0), v: Number(fields.v ?? 0) };
          this.formats.set(id, this.transferFormat);
        }
        if (fields.a === "t" && fields.t === "t") {
          // A temporary file: read it, then delete it as the terminal would.
          const path = Buffer.from(payload, "base64").toString();
          this.images.set(id, readFileSync(path)); rmSync(path, { force: true }); this.decoding.delete(id); this.fileTransfers++;
        } else if (fields.m !== undefined) {
          this.chunks += payload;
          if (fields.m === "0") { this.images.set(this.transfer, Buffer.from(this.chunks, "base64")); this.decoding.delete(this.transfer); }
        }
        if (fields.a === "p") {
          this.placements.set(id, { x: this.cursor.column * this.cell.width + Number(fields.X ?? 0), y: this.cursor.row * this.cell.height + Number(fields.Y ?? 0),
            width: Number(fields.c) * this.cell.width, height: Number(fields.r) * this.cell.height, z: Number(fields.z ?? 0) });
          this.changes = true;
        }
        this.maxImages = Math.max(this.maxImages, this.images.size);
        if (fields.a === "d") { this.images.delete(id); this.placements.delete(id); this.decoding.delete(id); }
      } else if (this.carry.startsWith("\x1b[")) {
        const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.carry); if (!match) break;
        const sequence = match[0]; this.carry = this.carry.slice(sequence.length);
        if (sequence === "\x1b[16t") reply(`\x1b[6;${this.cell.height};${this.cell.width}t`);
        if (sequence === "\x1b[?1016$p") reply(`\x1b[?1016;${this.pixelMouse ? 2 : 0}$y`);
        if (sequence === "\x1b[?1049l") this.restored = true;
        const position = /^\x1b\[(\d+);(\d+)H$/.exec(sequence);
        if (position) this.cursor = { row: Number(position[1]) - 1, column: Number(position[2]) - 1 };
        if (sequence === "\x1b[?2026l" && this.changes) {
          this.batches++; this.changes = false; for (const listener of this.listeners) listener();
        }
      } else if (this.carry.length < 3) break;
      else this.carry = this.carry.slice(1);
    }
  }
  write(value: string) { this.child.terminal!.write(value); }
  click(x: number, y: number) {
    const column = this.pixelMouse ? x : Math.floor(x / this.cell.width);
    const row = this.pixelMouse ? y : Math.floor(y / this.cell.height);
    this.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
  }
  paste(value: string) { this.write(`\x1b[200~${value}\x1b[201~`); }
  resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.child.terminal!.resize(columns, rows); }
  async after(count: number, timeoutMs = 5000) {
    if (this.batches > count) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`No frame after ${count}: ${this.error}`)); }, timeoutMs);
      const check = () => { if (this.batches > count) { clearTimeout(timer); this.listeners.delete(check); resolve(); } };
      this.listeners.add(check); check();
    });
  }
  private decoded(id: number) {
    let item = this.decoding.get(id);
    if (!item) {
      const format = this.formats.get(id), bytes = this.images.get(id)!;
      item = format?.f === "24" || format?.f === "32"
        ? Promise.resolve((() => {
          const pixels = format.o === "z" ? inflateSync(bytes) : bytes, channels = format.f === "24" ? 3 : 4;
          if (pixels.length !== format.s * format.v * channels) throw new Error(`Image ${id} has ${pixels.length} bytes for ${format.s}x${format.v}`);
          const data = Buffer.alloc(format.s * format.v * 4);
          for (let from = 0, to = 0; from < pixels.length; from += channels, to += 4) {
            data[to] = pixels[from]!; data[to + 1] = pixels[from + 1]!; data[to + 2] = pixels[from + 2]!; data[to + 3] = channels === 4 ? pixels[from + 3]! : 255;
          }
          return { data, width: format.s, height: format.v };
        })())
        : sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          .then(({ data, info }) => ({ data, width: info.width, height: info.height }));
      this.decoding.set(id, item);
    }
    return item;
  }
  async raw() {
    const width = this.columns * this.cell.width, height = this.rows * this.cell.height;
    const pixels = Buffer.alloc(width * height * 4);
    const snapshots = [...this.placements].sort((a,b) => a[1].z-b[1].z || a[0]-b[0]).map(([id,p]) => ({id,p,image:this.decoded(id)}));
    for (const snapshot of snapshots) {
      const {p,id}=snapshot, image = await snapshot.image;
      if (image.width !== p.width || image.height !== p.height) throw new Error(`Image scaling mismatch: ${id}`);
      const copyWidth = Math.min(image.width, width-p.x), copyHeight = Math.min(image.height, height-p.y);
      for (let y = 0; y < copyHeight; y++) image.data.copy(pixels, ((p.y+y)*width+p.x)*4, y*image.width*4, (y*image.width+copyWidth)*4);
    }
    return { data:pixels,width,height };
  }
  async png(path?: string) {
    const { data, width, height } = await this.raw();
    const png = await sharp(data, { raw: { width,height,channels:4 } }).png().toBuffer();
    if (path) await Bun.write(path,png); return png;
  }
  async brightPixels(x: number, y: number, width: number, height: number) {
    const image = await this.raw(); let count = 0;
    for (let row = y; row < y+height; row++) for (let column = x; column < x+width; column++) {
      const offset = (row*image.width+column)*4;
      if (image.data[offset]! > 120 && image.data[offset+1]! > 120 && image.data[offset+2]! > 120) count++;
    }
    return count;
  }
  async stop() { this.write("\x03"); return await this.child.exited; }
  kill() { this.child.kill(); this.child.terminal?.close(); }
}
