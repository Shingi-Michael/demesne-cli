import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import type { ImageArtifact } from "@demesne/protocol";
import { fitImage, type TerminalImage } from "../terminal-graphics.ts";

export interface PreviewServices {
  content(artifact: ImageArtifact, variant: "preview" | "original", signal?: AbortSignal): Promise<Uint8Array>;
  open(artifact: ImageArtifact): Promise<void>;
  preferences?: string;
}
export class ArtifactPreview {
  artifacts: ImageArtifact[] = [];
  selectedId: string | null = null;
  mode: "follow" | "manual" | "pinned" = "follow";
  open = false;
  dismissed = false;
  expanded = false;
  focused = false;
  history = false;
  error: string | null = null;
  loading = false;
  private sessionId = "";
  private bytes: Uint8Array | null = null;
  private pending: AbortController | null = null;
  private pendingId: string | null = null;
  private generation = 0;
  private controls: (() => void)[] = [];
  private controlIndex = 0;
  constructor(private services: PreviewServices, private changed: () => void) {}
  get selected(): ImageArtifact | undefined { return this.artifacts.find((a) => a.id === this.selectedId); }
  reset(sessionId: string): void {
    this.cancel(); this.sessionId = sessionId; this.artifacts = []; this.bytes = null;
    this.selectedId = null; this.mode = "follow"; this.open = false; this.expanded = false; this.focused = false; this.dismissed = false; this.history = false;
    try {
      const saved = JSON.parse(readFileSync(this.services.preferences!, "utf8"))[sessionId];
      if (saved && ["follow", "manual", "pinned"].includes(saved.mode)) {
        this.mode = saved.mode; this.selectedId = typeof saved.selectedId === "string" ? saved.selectedId : null; this.dismissed = saved.dismissed === true;
      }
    } catch {}
  }
  private save(): void {
    const path = this.services.preferences;
    if (!path || !this.sessionId) return;
    try {
      let all: Record<string, unknown> = {};
      try { const value = JSON.parse(readFileSync(path, "utf8")); if (value && typeof value === "object" && !Array.isArray(value)) all = value; } catch {}
      all[this.sessionId] = { selectedId: this.selectedId, mode: this.mode, dismissed: this.dismissed };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(all), { mode: 0o600 }); renameSync(temp, path);
    } catch { /* Preferences never prevent inspection. */ }
  }
  add(artifact: ImageArtifact, autoOpen = false): void {
    if (artifact.sessionId !== this.sessionId || this.artifacts.some((a) => a.id === artifact.id)) return;
    this.artifacts.push(artifact);
    this.artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (this.mode === "follow") this.selectedId = this.artifacts.at(-1)!.id;
    if (!this.dismissed && autoOpen) this.open = true;
    if (this.open) void this.load();
    this.save(); this.changed();
  }
  toggle(): void {
    if (this.open) { this.close(); return; }
    this.open = true; this.dismissed = false; this.focused = true;
    if (!this.selectedId) this.selectedId = this.artifacts.at(-1)?.id ?? null;
    void this.load(); this.save(); this.changed();
  }
  close(): void { this.open = false; this.focused = false; this.expanded = false; this.dismissed = true; this.cancel(); this.save(); this.changed(); }
  cancel(): void { this.pending?.abort(); this.pending = null; this.pendingId = null; this.generation++; this.loading = false; }
  private loadedId: string | null = null;
  async load(): Promise<void> {
    const artifact = this.selected;
    if (!artifact || this.loadedId === artifact.id && this.bytes || this.pendingId === artifact.id) return;
    this.cancel(); const version = this.generation;
    this.bytes = null; this.error = null; this.loading = true;
    const controller = this.pending = new AbortController(); this.changed();
    this.pendingId = artifact.id;
    try {
      const bytes = await this.services.content(artifact, "preview", controller.signal);
      if (version !== this.generation) return;
      this.bytes = bytes; this.loadedId = artifact.id;
    } catch (error) { if (version === this.generation) this.error = error instanceof Error ? error.message : "Image unavailable"; }
    finally { if (version === this.generation) { this.pendingId = null; this.loading = false; this.changed(); } }
  }
  select(delta: number): void {
    const at = this.artifacts.findIndex((a) => a.id === this.selectedId);
    const artifact = this.artifacts[Math.max(0, Math.min(this.artifacts.length - 1, at + delta))];
    if (!artifact) return;
    if (this.mode !== "pinned") this.mode = "manual";
    this.selectedId = artifact.id; void this.load(); this.save(); this.changed();
  }
  key(name: string, shift = false): boolean {
    if (!this.open || !this.focused) return false;
    if (name === "escape") { if (this.history) { this.history = false; this.changed(); } else if (this.expanded) { this.expanded = false; this.changed(); } else this.close(); return true; }
    if (name === "left" || name === "right") { this.select(name === "left" ? -1 : 1); return true; }
    if (name === "h") { this.history = !this.history; this.controlIndex = 0; this.changed(); return true; }
    if (name === "f") { this.mode = "follow"; this.selectedId = this.artifacts.at(-1)?.id ?? null; void this.load(); this.save(); this.changed(); return true; }
    if (name === "tab") { this.controlIndex = (this.controlIndex + (shift ? -1 : 1) + this.controls.length) % this.controls.length; this.changed(); return true; }
    if (name === "return") { this.controls[this.controlIndex]?.(); return true; }
    return false;
  }
  render(width: number, height: number, column: number, paint: Painter, cell: { width: number; height: number } | null): {
    rows: string[]; zones: { row: number; column: number; width: number; run: () => void }[]; image: TerminalImage | null;
  } {
    const canvas = new Canvas(width, height, paint);
    for (let row = 0; row < height; row++) canvas.put(row, 0, "", width, "surface");
    const rows = canvas.rows;
    const zones: { row: number; column: number; width: number; run: () => void }[] = [];
    this.controls = [];
    let compactLabel = "";
    const put = (row: number, text: string) => { if (row >= 0 && row < height) canvas.put(row, 1, text, Math.max(1, width - 2), "surface"); };
    const rule = (row: number) => canvas.put(row, 0, paint.text("─".repeat(width), "rule"), width, "surface");
    const button = (row: number, label: string, run: () => void, x = 1) => {
      const index = this.controls.length; this.controls.push(run);
      if (height < 14 && index !== this.controlIndex) return;
      if (height < 14) { row = height - 1; compactLabel = label; }
      if (height < 14) x = 1;
      const size = Math.min(visibleLength(label), width - x);
      canvas.put(row, x, paint.text(label, this.focused && this.controlIndex === index ? "electric" : "muted"), size, "surface");
      zones.push({ row, column: column + x, width: size, run: () => { this.focused = true; this.controlIndex = index; run(); } });
    };
    const artifact = this.selected;
    put(0, paint.text("PREVIEW", "secondary"));
    button(0, "×", () => this.close(), width - 3);
    rule(1);
    put(2, paint.text(sanitizeTerminalLine(artifact?.filename ?? "No image selected"), "muted"));
    rule(3);
    const status = this.error ?? (this.loading ? "Loading preview…" : !artifact ? "Images appear here when available." : !cell ? "Inline graphics unavailable" : "");
    let image: TerminalImage | null = null;
    const secondaryControls = this.artifacts.length > 1 || this.history || this.mode === "manual";
    const wellRows = Math.max(0, Math.min(height - (secondaryControls ? 12 : 10), Math.max(6, Math.min(18, Math.ceil((width - 4) * (cell ? cell.width / cell.height : 0.5) * (artifact ? artifact.height / artifact.width : 0.5625))))));
    const slot = { row: 5, column: column + 2, columns: Math.max(1, width - 4), rows: Math.max(0, wellRows - 2) };
    for (let row = 4; row < 4 + wellRows; row++) canvas.put(row, 1, "", width - 2, "ink");
    if (status && wellRows > 0) canvas.put(4 + Math.floor(wellRows / 2), 2, paint.text(sanitizeTerminalLine(status), this.error ? "signal" : "muted"), width - 4, "ink");
    if (artifact && this.bytes && cell && slot.rows > 0 && !this.history) {
      const placement = fitImage(artifact.width, artifact.height, slot, cell);
      if (placement) image = { key: artifact.sha256, png: this.bytes, placement };
    }
    const base = 4 + wellRows;
    rule(base);
    if (this.history) {
      const selected = this.artifacts.findIndex((a) => a.id === this.selectedId);
      const capacity = Math.max(1, wellRows);
      const start = Math.max(0, selected - Math.floor(capacity / 2));
      this.artifacts.slice(start, start + capacity).forEach((item, index) => {
        button(4 + index, `${item.id === this.selectedId ? "● " : ""}${sanitizeTerminalLine(item.filename)}`, () => {
          this.selectedId = item.id; if (this.mode !== "pinned") this.mode = "manual";
          this.history = false; void this.load(); this.save(); this.changed();
        });
      });
    }
    if (artifact) {
      const count = `${this.artifacts.indexOf(artifact) + 1} of ${this.artifacts.length}`;
      const label = truncateText(sanitizeTerminalLine(`${artifact.mimeType} · ${artifact.source.name.replace(/^mcp__[^_]+__/, "")}`), Math.max(1, width - count.length - 5));
      put(base + 1, paint.text(`${label} · ${count}`, "muted"));
    }
    rule(base + 2);
    // Shared columns keep both rows aligned as labels and selection state change.
    const columns = width >= 31 ? [1, 8, 17] : [1, 7, 15];
    const actionRow = base + 3;
    button(actionRow, this.mode === "pinned" ? "Unpin" : "Pin", () => { this.mode = this.mode === "pinned" ? "manual" : "pinned"; this.save(); this.changed(); }, columns[0]);
    button(actionRow, this.expanded ? "Restore" : "Expand", () => { this.expanded = !this.expanded; this.changed(); }, columns[1]);
    button(actionRow, this.error ? "Retry" : width >= 31 ? "Open original" : "Open", () => {
      if (this.error) { this.loadedId = null; void this.load(); return; }
      if (artifact) void this.services.open(artifact).catch((error) => { this.error = String(error); this.changed(); });
    }, columns[2]);
    if (secondaryControls) {
      button(actionRow + 1, "←", () => this.select(-1), columns[0]);
      button(actionRow + 1, "→", () => this.select(1), columns[0]! + 3);
      button(actionRow + 1, this.history ? "Back" : "History", () => { this.history = !this.history; this.controlIndex = 0; this.changed(); }, columns[1]);
      button(actionRow + 1, "Follow", () => { this.mode = "follow"; this.selectedId = this.artifacts.at(-1)?.id ?? null; void this.load(); this.save(); this.changed(); }, columns[2]);
    }
    if (height < 14) put(height - 1, paint.text(`› ${compactLabel} · Tab`, "electric"));
    return { rows, zones: zones.filter((z) => z.row < height), image };
  }
}
