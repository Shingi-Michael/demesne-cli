/// Terminal mouse decoding.
///
/// The workbench enables SGR mouse mode (`?1003` motion tracking plus
/// `?1006` SGR encoding) so hover, wheel scrolling and clicks land on
/// interactive rows. The keypress emitter cannot decode these sequences — it
/// splits them into garbage characters — so the controller listens on the raw
/// `data` event (registered before the emitter), extracts the sequences here,
/// and suppresses the keypress events of that chunk.

export const MOUSE_ENABLE = "\x1b[?1003;1006h";
export const MOUSE_DISABLE = "\x1b[?1000;1002;1003;1006l";

export interface MouseEvent {
  /// `press` for a left click and `release` for its counterpart, `drag` for
  /// motion with a button held, `move` for hover, and `wheel` for
  /// the scroll wheel.
  kind: "press" | "release" | "drag" | "move" | "wheel";
  button: number;
  /// Zero-based terminal cells.
  col: number;
  row: number;
  /// The scroll direction, present only on `wheel` events.
  direction?: "up" | "down" | "left" | "right";
}

export interface MouseChunk {
  events: MouseEvent[];
  /// An incomplete sequence tail waiting for its next chunk, or the leftover
  /// text of a chunk that mixed mouse and ordinary bytes.
  rest: string;
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const X10_MOUSE = /\x1b\[M([\x20-\xff]{3})/g;
/// An SGR sequence that has not yet received its final byte or coordinate.
const SGR_TAIL = /\x1b\[<\d*(?:;\d*)?;?\d*$/;

/// Decodes one SGR (`\x1b[<b;col;rowM|m`) or X10 (`\x1b[M` + 3 bytes) mouse
/// sequence into zero-based cells. Returns null for anything else.
export function parseMouseSequence(sequence: string): MouseEvent | null {
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (sgr) {
    return decodeMouseButton(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === "M");
  }
  const x10 = /^\x1b\[M([\x20-\xff]{3})$/.exec(sequence);
  if (x10) {
    const bytes = [...x10[1]!].map((char) => char.charCodeAt(0));
    return decodeMouseButton(bytes[0]! - 32, bytes[1]! - 32, bytes[2]! - 32, true);
  }
  return null;
}

function decodeMouseButton(code: number, col: number, row: number, press: boolean): MouseEvent {
  const button = code & 0b11;
  const col0 = col - 1;
  const row0 = row - 1;
  // Bit 64 marks the wheel (64 up, 65 down, 66 left, 67 right,
  // plus modifier bits). Preserve both axis bits: trackpads emit diagonal
  // gestures, and treating button 66 as up makes bottom-edge scrolling jump.
  // bit 32 marks drag motion.
  if (code & 0b1000000) {
    const direction = (["up", "down", "left", "right"] as const)[button]!;
    return { kind: "wheel", button, col: col0, row: row0, direction };
  }
  if (code & 0b100000) return { kind: button === 3 ? "move" : "drag", button, col: col0, row: row0 };
  return { kind: press ? "press" : "release", button, col: col0, row: row0 };
}

/// Cheap check for stdin chunks that carry mouse bytes, so the controller can
/// skip extraction entirely for ordinary typing.
export function chunkMayContainMouse(chunk: string): boolean {
  return chunk.includes("\x1b[<") || chunk.includes("\x1b[M");
}

/// Pulls every complete mouse sequence out of a stdin chunk. Complete
/// sequences are removed; a trailing partial SGR sequence is returned in
/// `rest` to carry into the next chunk. Modifiers on the wheel add to the
/// direction bit, so a shift-click's scroll is still decoded.
export function extractMouseEvents(chunk: string, carry = ""): MouseChunk {
  const source = `${carry}${chunk}`;
  const spans: Array<{ event: MouseEvent; start: number; end: number }> = [];
  SGR_MOUSE.lastIndex = 0;
  for (const match of source.matchAll(SGR_MOUSE)) {
    const event = parseMouseSequence(match[0]);
    if (event) spans.push({ event, start: match.index, end: match.index + match[0].length });
  }
  X10_MOUSE.lastIndex = 0;
  for (const match of source.matchAll(X10_MOUSE)) {
    const event = parseMouseSequence(match[0]);
    if (event) spans.push({ event, start: match.index, end: match.index + match[0].length });
  }
  spans.sort((a, b) => a.start - b.start);
  let rest = "";
  let cursor = 0;
  const events: MouseEvent[] = [];
  for (const span of spans) {
    rest += source.slice(cursor, span.start);
    cursor = span.end;
    events.push(span.event);
  }
  rest += source.slice(cursor);
  const tail = SGR_TAIL.exec(rest);
  if (tail && tail.index > 0) {
    return { events, rest: rest.slice(tail.index) };
  }
  // A chunk that is nothing but an incomplete prefix stays pending; a chunk
  // with text plus a partial prefix is treated as garbage and dropped, so a
  // torn sequence can never swallow later typing.
  if (tail) return { events, rest: chunkMayContainMouse(rest) ? rest : "" };
  return { events, rest: "" };
}
