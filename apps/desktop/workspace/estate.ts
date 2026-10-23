import type { WorkspaceDistrict } from "@demesne/protocol";

/// The project map drawn as land: one surface, folders as parcels whose
/// areas are their lines, borders as shared hairlines that wander a little,
/// and light where code changed. No boxes and no fills of their own.

export const LAND_W = 880, LAND_H = 400;
const SCALE = 2, WOBBLE = 900;

export interface Parcel {
  district: WorkspaceDistrict;
  /// Seed, then the centre of the parcel as drawn.
  x: number; y: number; cx: number; cy: number;
  /// Bounding size and the radius of a circle of the same area.
  bw: number; bh: number; r: number;
  weight: number; phaseX: number; phaseY: number;
}

export interface Land {
  parcels: Parcel[];
  /// Which parcel owns each drawn pixel (LAND_W*SCALE by LAND_H*SCALE).
  owner: Int16Array;
  /// Border pixels of each parcel.
  borders: Int32Array[];
}

/// Squarified treemap (Bruls, Huizing, van Wijk): the start positions, so a
/// project looks the same each time it is drawn.
export function squarify(values: number[], x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const scaled = values.map((value) => (value / total) * w * h);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  let index = 0;
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0), max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  while (index < scaled.length) {
    const side = Math.min(w, h);
    const row = [scaled[index]!];
    index++;
    while (index < scaled.length && worst([...row, scaled[index]!], side) <= worst(row, side)) row.push(scaled[index++]!);
    const sum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const rw = h ? sum / h : 0;
      let ry = y;
      for (const area of row) { const rh = rw ? area / rw : 0; out.push({ x, y: ry, w: rw, h: rh }); ry += rh; }
      x += rw; w -= rw;
    } else {
      const rh = w ? sum / w : 0;
      let rx = x;
      for (const area of row) { const cw = rh ? area / rh : 0; out.push({ x: rx, y, w: cw, h: rh }); rx += cw; }
      y += rh; h -= rh;
    }
  }
  return out;
}

const distance = (parcel: Parcel, x: number, y: number) => {
  const dx = x - parcel.x, dy = y - parcel.y;
  return dx * dx + dy * dy - parcel.weight + WOBBLE * Math.sin(x * 0.043 + parcel.phaseX) * Math.cos(y * 0.051 + parcel.phaseY);
};
const nearest = (parcels: Parcel[], x: number, y: number) => {
  let best = 0, bestDistance = Infinity;
  for (let index = 0; index < parcels.length; index++) {
    const value = distance(parcels[index]!, x, y);
    if (value < bestDistance) { bestDistance = value; best = index; }
  }
  return best;
};

/// Surveys the land: a power diagram whose weights are solved so each
/// parcel's area matches its share of the lines.
export function survey(districts: WorkspaceDistrict[], width = LAND_W, height = LAND_H): Land {
  const sorted = [...districts].filter((district) => district.lines > 0).sort((a, b) => b.lines - a.lines);
  const boxes = squarify(sorted.map((district) => district.lines), 0, 0, width, height);
  const parcels: Parcel[] = sorted.map((district, index) => ({
    district, x: boxes[index]!.x + boxes[index]!.w / 2, y: boxes[index]!.y + boxes[index]!.h / 2,
    cx: 0, cy: 0, bw: 0, bh: 0, r: 0, weight: 0, phaseX: index * 1.73, phaseY: index * 2.31 + 0.4,
  }));
  const total = sorted.reduce((sum, district) => sum + district.lines, 0) || 1;
  const gridW = 176, gridH = Math.round((176 * height) / width), stepX = width / gridW, stepY = height / gridH;
  for (let round = 0; round < 90 && parcels.length > 1; round++) {
    const area = new Float64Array(parcels.length), sumX = new Float64Array(parcels.length), sumY = new Float64Array(parcels.length);
    for (let j = 0; j < gridH; j++) for (let i = 0; i < gridW; i++) {
      const x = (i + 0.5) * stepX, y = (j + 0.5) * stepY, owner = nearest(parcels, x, y);
      area[owner]++; sumX[owner] += x; sumY[owner] += y;
    }
    parcels.forEach((parcel, index) => {
      const target = (parcel.district.lines / total) * gridW * gridH;
      parcel.weight += 0.55 * (target - Math.max(area[index]!, 0.5)) * stepX * stepY;
      if (area[index]! > 0 && round < 50) {
        parcel.x += 0.25 * (sumX[index]! / area[index]! - parcel.x);
        parcel.y += 0.25 * (sumY[index]! / area[index]! - parcel.y);
      }
    });
  }
  const pw = width * SCALE, ph = height * SCALE, owner = new Int16Array(pw * ph);
  const area = new Float64Array(parcels.length), sumX = new Float64Array(parcels.length), sumY = new Float64Array(parcels.length);
  const minX = new Float64Array(parcels.length).fill(Infinity), maxX = new Float64Array(parcels.length).fill(-Infinity);
  const minY = new Float64Array(parcels.length).fill(Infinity), maxY = new Float64Array(parcels.length).fill(-Infinity);
  for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
    const x = i / SCALE, y = j / SCALE, index = nearest(parcels, x, y);
    owner[j * pw + i] = index;
    area[index]++; sumX[index] += x; sumY[index] += y;
    if (x < minX[index]!) minX[index] = x; if (x > maxX[index]!) maxX[index] = x;
    if (y < minY[index]!) minY[index] = y; if (y > maxY[index]!) maxY[index] = y;
  }
  const borderLists: number[][] = parcels.map(() => []);
  for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
    const at = j * pw + i, index = owner[at]!;
    if ((i + 1 < pw && owner[at + 1] !== index) || (j + 1 < ph && owner[at + pw] !== index) || (i > 0 && owner[at - 1] !== index) || (j > 0 && owner[at - pw] !== index)) borderLists[index]!.push(at);
  }
  parcels.forEach((parcel, index) => {
    const count = area[index]! || 1;
    parcel.cx = sumX[index]! / count; parcel.cy = sumY[index]! / count;
    parcel.bw = Math.max(0, maxX[index]! - minX[index]!); parcel.bh = Math.max(0, maxY[index]! - minY[index]!);
    parcel.r = Math.sqrt(area[index]! / SCALE / SCALE / Math.PI);
  });
  return { parcels, owner, borders: borderLists.map((list) => Int32Array.from(list)) };
}

/// The parcel under a point in land units, or -1 off the land.
export function parcelAt(land: Land, x: number, y: number) {
  const i = Math.floor(x * SCALE), j = Math.floor(y * SCALE);
  if (i < 0 || j < 0 || i >= LAND_W * SCALE || j >= LAND_H * SCALE) return -1;
  return land.owner[j * LAND_W * SCALE + i] ?? -1;
}

export type Recency = "today" | "week" | "quiet";
export function recency(district: WorkspaceDistrict, now = Date.now()): Recency {
  if (!district.changedAt) return "quiet";
  const age = now - district.changedAt;
  return age < 24 * 3600_000 ? "today" : age < 7 * 24 * 3600_000 ? "week" : "quiet";
}

export function parcelName(district: WorkspaceDistrict) {
  return district.path === null ? "other" : district.path === "" ? "top level" : district.path.split("/").at(-1)!;
}

const rgb = (value: string): [number, number, number] => {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [parseInt(hex[1]!.slice(0, 2), 16), parseInt(hex[1]!.slice(2, 4), 16), parseInt(hex[1]!.slice(4, 6), 16)];
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [18, 19, 21];
  return [parts[0] ?? 18, parts[1] ?? 19, parts[2] ?? 21];
};

/// Paints the land onto a canvas sized LAND_W*2 by LAND_H*2. Colours come
/// from the page so light and dark themes both work.
export interface LandLife {
  /// Parcels with work happening this minute: lit blue from inside.
  live?: ReadonlySet<number>;
  /// Parcels with a failing check: a red border.
  failing?: ReadonlySet<number>;
}

export function paintLand(canvas: HTMLCanvasElement, land: Land, hover: number, now = Date.now(), life: LandLife = {}) {
  const pw = LAND_W * SCALE, ph = LAND_H * SCALE;
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const context = canvas.getContext("2d");
  if (!context) return;
  const style = getComputedStyle(canvas);
  // The ground is whatever the land sits on, so its edges fade into the page.
  let ink: [number, number, number] = rgb(style.getPropertyValue("--ink") || "#121315");
  for (let node: Element | null = canvas.parentElement; node; node = node.parentElement) {
    const background = getComputedStyle(node).backgroundColor, parts = background.match(/[\d.]+/g)?.map(Number);
    if (parts && parts.length >= 3 && (parts.length < 4 || parts[3]! > 0.5)) { ink = [parts[0]!, parts[1]!, parts[2]!]; break; }
  }
  const accent = rgb(style.getPropertyValue("--acc") || "#7aa7ff"), warm = rgb(style.getPropertyValue("--warn") || "#e7b65a"), bad = rgb(style.getPropertyValue("--bad") || "#ef8a8a");
  const dark = ink[0] + ink[1] + ink[2] < 384, toward = dark ? 255 : 0;
  const image = context.createImageData(pw, ph), data = image.data;
  const tones = land.parcels.map((_, index) => (dark ? 0.028 : 0.022) + 0.016 * ((((index + 1) * 2654435761) >>> 0) % 1000) / 1000);
  const tints = land.parcels.map((parcel) => { const when = recency(parcel.district, now); return when === "today" ? 0.045 : when === "week" ? 0.025 : 0; });
  const edges = land.parcels.map((_, index): [number[], number] => life.failing?.has(index) ? [bad, 0.8] : index === hover ? [accent, 0.75] : life.live?.has(index) ? [accent, 0.4] : [[toward, toward, toward], dark ? 0.14 : 0.16]);
  for (let at = 0; at < pw * ph; at++) {
    const index = land.owner[at]!, tone = tones[index]!, tint = tints[index]!, p = at * 4;
    let r = ink[0] + (toward - ink[0]) * tone, g = ink[1] + (toward - ink[1]) * tone, b = ink[2] + (toward - ink[2]) * tone;
    if (tint) { r += (warm[0] - r) * tint; g += (warm[1] - g) * tint; b += (warm[2] - b) * tint; }
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  }
  land.parcels.forEach((_, index) => {
    const [colour, alpha] = edges[index]!;
    for (const at of land.borders[index]!) {
      const p = at * 4;
      data[p] = data[p]! + (colour[0]! - data[p]!) * alpha; data[p + 1] = data[p + 1]! + (colour[1]! - data[p + 1]!) * alpha; data[p + 2] = data[p + 2]! + (colour[2]! - data[p + 2]!) * alpha;
    }
  });
  context.putImageData(image, 0, 0);
  context.save();
  context.scale(SCALE, SCALE);
  // Light where code changed: a glow that spills a little over the border.
  for (const parcel of land.parcels) {
    const when = recency(parcel.district, now);
    if (when === "quiet") continue;
    const strength = when === "today" ? 0.09 : 0.045, radius = parcel.r * 1.1;
    const glow = context.createRadialGradient(parcel.cx, parcel.cy, 0, parcel.cx, parcel.cy, radius);
    glow.addColorStop(0, `rgba(${warm.join(",")},${strength})`);
    glow.addColorStop(1, `rgba(${warm.join(",")},0)`);
    context.fillStyle = glow;
    context.fillRect(parcel.cx - radius, parcel.cy - radius, radius * 2, radius * 2);
  }
  // Work happening now lights its parcel blue from inside.
  for (const index of life.live ?? []) {
    const parcel = land.parcels[index];
    if (!parcel) continue;
    const radius = parcel.r * 1.15, glow = context.createRadialGradient(parcel.cx, parcel.cy, 0, parcel.cx, parcel.cy, radius);
    glow.addColorStop(0, `rgba(${accent.join(",")},${dark ? 0.2 : 0.14})`);
    glow.addColorStop(1, `rgba(${accent.join(",")},0)`);
    context.fillStyle = glow;
    context.fillRect(parcel.cx - radius, parcel.cy - radius, radius * 2, radius * 2);
  }
  // Grain, the same every time.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let index = 0; index < 4000; index++) {
    context.fillStyle = `rgba(${toward},${toward},${toward},${0.025 + random() * 0.035})`;
    context.fillRect(random() * LAND_W, random() * LAND_H, 0.7, 0.7);
  }
  // The land fades into the page at its edges.
  const fade = 24, solid = `rgb(${ink.join(",")})`, clear = `rgba(${ink.join(",")},0)`;
  const edge = (x0: number, y0: number, x1: number, y1: number, x: number, y: number, w: number, h: number) => {
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, solid); gradient.addColorStop(1, clear);
    context.fillStyle = gradient; context.fillRect(x, y, w, h);
  };
  edge(0, 0, fade, 0, 0, 0, fade, LAND_H);
  edge(LAND_W, 0, LAND_W - fade, 0, LAND_W - fade, 0, fade, LAND_H);
  edge(0, 0, 0, fade, 0, 0, LAND_W, fade);
  edge(0, LAND_H, 0, LAND_H - fade, 0, LAND_H - fade, LAND_W, fade);
  context.restore();
}

const shortLines = (lines: number) => (lines >= 1000 ? `${(lines / 1000).toFixed(1)}k` : String(lines));
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function when(district: WorkspaceDistrict, now = Date.now()) {
  if (!district.changedAt) return "quiet";
  const age = now - district.changedAt;
  if (age < 24 * 3600_000) return "changed today";
  if (age < 7 * 24 * 3600_000) return `changed ${new Date(district.changedAt).toLocaleDateString(undefined, { weekday: "short" })}`;
  return "quiet";
}

/// Place names, set in the land they name; a parcel too small for its name
/// is named only on hover.
export function placeNames(land: Land, now = Date.now()) {
  return land.parcels.map((parcel, index) => {
    const name = parcelName(parcel.district), wide = name.length * 7.6 + 16;
    if (parcel.bw > wide && parcel.bh > 34) {
      const sub = parcel.bh > 60 ? (parcel.bw > 150 ? `${shortLines(parcel.district.lines)} lines · ${when(parcel.district, now)}` : `${shortLines(parcel.district.lines)} lines`) : "";
      return `<text class="pn" data-parcel="${index}" x="${parcel.cx.toFixed(1)}" y="${(parcel.cy - (sub ? 4 : 0)).toFixed(1)}">${escape(name)}</text>${sub ? `<text class="ps" x="${parcel.cx.toFixed(1)}" y="${(parcel.cy + 13).toFixed(1)}">${escape(sub)}</text>` : ""}`;
    }
    if (parcel.bw > name.length * 6.4 + 8 && parcel.bh > 18) return `<text class="ps" x="${parcel.cx.toFixed(1)}" y="${(parcel.cy + 4).toFixed(1)}">${escape(name)}</text>`;
    return "";
  }).join("");
}

/// The quiet line beside the Map button: the whole project, or the parcel under the pointer.
export function mapCaption(districts: WorkspaceDistrict[], hovered: WorkspaceDistrict | null, now = Date.now()) {
  if (hovered) {
    const place = hovered.path === null ? "the smallest folders" : hovered.path === "" ? "files at the top level" : hovered.path;
    return `${place} · ${shortLines(hovered.lines)} lines · ${hovered.files} file${hovered.files === 1 ? "" : "s"} · ${when(hovered, now)}${hovered.path ? " · click to work here" : ""}`;
  }
  const lines = districts.reduce((sum, district) => sum + district.lines, 0);
  const changed = districts.filter((district) => recency(district, now) !== "quiet").length;
  return `${shortLines(lines)} lines in ${districts.length} place${districts.length === 1 ? "" : "s"}${changed ? ` · ${changed} changed this week` : ""}`;
}

/// The parcel a workspace-relative file belongs to: the deepest folder that
/// holds it, the top level for files at the root, or -1.
export function parcelOf(land: Land, path: string) {
  let best = -1, depth = -1;
  land.parcels.forEach((parcel, index) => {
    const folder = parcel.district.path;
    if (folder === null) return;
    const holds = folder === "" ? !path.includes("/") : path === folder || path.startsWith(`${folder}/`);
    if (holds && folder.length > depth) { best = index; depth = folder.length; }
  });
  return best;
}

export type MarkTone = "work" | "wait" | "fail" | "agent";
export interface LiveMark {
  key: string;
  label: string;
  tone: MarkTone;
  parcel: number;
  /// Where it came from this last minute, when that was another parcel.
  from?: number;
  /// The line beside Map while the mark is hovered.
  detail: string;
  /// The chat a click opens.
  sessionId?: string;
}

/// Places marks inside their parcels, under the place name, one row each;
/// past five, marks are dots without names.
export function placeMarks(land: Land, marks: LiveMark[]) {
  const rows = new Map<number, number>();
  return marks.map((mark, order) => {
    const parcel = land.parcels[mark.parcel];
    if (!parcel) return null;
    const row = rows.get(mark.parcel) ?? 0;
    rows.set(mark.parcel, row + 1);
    const named = order < 5;
    const width = named ? mark.label.length * 6.2 + 14 : 10;
    let x = parcel.cx - Math.min(width, parcel.bw * 0.8) / 2 + 4, y = parcel.cy + 32 + row * 19;
    if (parcelAt(land, x, y) !== mark.parcel) y = parcel.cy - 30 - row * 19;
    if (parcelAt(land, x, y) !== mark.parcel) { x = parcel.cx; y = parcel.cy + 4 + row * 16; }
    // The dot stays clear of the land's faded edge; its name goes to
    // whichever side has room.
    x = Math.max(30, Math.min(LAND_W - 30, x));
    y = Math.max(26, Math.min(LAND_H - 26, y));
    return { mark, x, y, named, left: x + width > LAND_W - 20 };
  }).filter((item): item is { mark: LiveMark; x: number; y: number; named: boolean; left: boolean } => item !== null);
}

/// The marks layer: a dot and a short name per mark, a ring on one that
/// waits for you, and a dotted trail from where it was.
export function markLayer(land: Land, placed: ReturnType<typeof placeMarks>) {
  return placed.map(({ mark, x, y, named, left }, index) => {
    const from = mark.from !== undefined ? land.parcels[mark.from] : undefined;
    const trail = from ? `<path class="trail ${mark.tone}" d="M${from.cx.toFixed(1)} ${from.cy.toFixed(1)} Q ${((from.cx + x) / 2).toFixed(1)} ${(Math.min(from.cy, y) - 40).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}"/>` : "";
    const ring = mark.tone === "wait" ? `<circle class="mk-ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8"/>` : "";
    const action = mark.sessionId ? ` data-action="select-session" data-args="${escape(JSON.stringify({ id: mark.sessionId }))}"` : "";
    return `${trail}<g class="mk-g ${mark.tone}" data-mark="${index}"${action}>${ring}<circle class="mk" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5"/>${named ? `<text class="who${left ? " left" : ""}" x="${(left ? x - 9 : x + 9).toFixed(1)}" y="${(y + 4).toFixed(1)}">${escape(mark.label)}</text>` : ""}<circle class="mk-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10"/></g>`;
  }).join("");
}
