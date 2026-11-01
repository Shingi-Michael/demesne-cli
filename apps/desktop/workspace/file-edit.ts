import type { ToolFileChange } from "@demesne/protocol";
import { codeDiff, type CodeDiffRow } from "@demesne/workbench/change-diff.ts";

export type EditMode = "before" | "diff" | "after";
export interface EditRegion { rows: CodeDiffRow[]; label: string; gap?: string }
export function editRegions(rows: CodeDiffRow[]): EditRegion[] {
  const regions: EditRegion[] = [];
  let block: CodeDiffRow[] = [];
  const flush = () => {
    if (!block.length) return;
    const first = block.find(row => row.kind === "added" || row.kind === "removed") ?? block[0]!;
    regions.push({ rows: block, label: `Line ${first.next ?? first.old ?? 1}` });
    block = [];
  };
  for (const row of rows) {
    if (row.kind === "gap") { flush(); regions.push({ rows: [], label: row.text, gap: row.text }); }
    else block.push(row);
  }
  flush();
  return regions;
}
export function fileEditModel(change: ToolFileChange) {
  const beforeAvailable = typeof change.before === "string" || !change.beforeExists;
  const afterAvailable = typeof change.after === "string" || !change.afterExists;
  const diff = beforeAvailable && afterAvailable ? codeDiff(change.before ?? "", change.after ?? "") : null;
  return { change, beforeAvailable, afterAvailable, diff, regions: diff ? editRegions(diff.rows) : [] };
}
export function fileSourceRows(text: string, mode: "before" | "after"): CodeDiffRow[] {
  if (!text) return [];
  const rows: CodeDiffRow[] = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").map((line, i) => ({ kind: "context", text: line, ...(mode === "before" ? { old: i + 1 } : { next: i + 1 }) }));
  if (!text.endsWith("\n")) rows.push({ kind: "gap", text: "No newline at end of file" });
  return rows;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string, parent: Element) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

/// One immutable tool result. View selection and replay survive chat repaints.
export class FileEditView {
  readonly element = document.createElement("section");
  private readonly models;
  private selected = 0;
  private mode: EditMode = "diff";
  private played = false;
  private animations: Animation[] = [];
  private generation = 0;
  private limit = 250;
  constructor(changes: ToolFileChange[], private readonly success: boolean) {
    this.models = changes.map(fileEditModel);
    this.element.className = "file-edit";
    this.element.setAttribute("aria-label", "Recorded file edits");
  }
  render(live: boolean) {
    if (this.element.childElementCount) return;
    this.draw(live && this.success && !this.played);
  }
  suspend() {
    if (this.element.dataset.playing === "true") this.draw(false);
  }
  dispose() { this.stop(); this.element.remove(); }
  private stop() {
    this.generation++;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.element.dataset.playing = "false";
  }
  private draw(requestPlay: boolean) {
    const refocus = this.element.querySelector(".fe-replay") === document.activeElement;
    this.stop();
    const model = this.models[this.selected];
    if (!model) return;
    const { change, diff, regions } = model;
    const playing = requestPlay && this.success && this.mode === "diff" && Boolean(diff?.rows.length) && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (requestPlay) this.played = true;
    this.element.dataset.playing = String(playing);
    this.element.dataset.mode = this.mode;
    this.element.dataset.path = change.path;
    this.element.replaceChildren();
    const head = node("div", "fe-head", "", this.element);
    node("div", "fe-path", change.path, head);
    node("span", "fe-kind", !change.beforeExists ? "Created" : !change.afterExists ? "Deleted" : "Edited", head);
    if (this.models.length > 1) {
      const label = node("label", "fe-file-picker", "File ", head);
      const select = node("select", "", "", label);
      select.setAttribute("aria-label", "Choose edited file");
      this.models.forEach((item, index) => { const option = node("option", "", item.change.path, select); option.value = String(index); });
      select.value = String(this.selected);
      select.addEventListener("change", () => { this.selected = Number(select.value); this.limit = 250; this.draw(false); this.element.querySelector<HTMLSelectElement>("select")?.focus(); });
    }
    const controls = node("div", "fe-controls", "", this.element);
    const choices = node("div", "fe-modes", "", controls);
    choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "File version");
    for (const mode of ["before", "diff", "after"] as const) {
      const button = node("button", "fe-mode", mode[0]!.toUpperCase() + mode.slice(1), choices);
      button.type = "button"; button.dataset.mode = mode;
      button.setAttribute("aria-pressed", String(mode === this.mode));
      button.addEventListener("click", () => { this.mode = mode; this.limit = 250; this.draw(false); this.element.querySelector<HTMLButtonElement>(`.fe-mode[data-mode="${mode}"]`)?.focus(); });
    }
    node("span", "fe-counts", diff ? `${regions.filter(region => !region.gap).length} regions · +${diff.added} −${diff.removed}` : "Text preview unavailable", controls);
    const body = node("div", "fe-body", "", this.element);
    const available = this.mode === "diff" ? Boolean(diff) : this.mode === "before" ? model.beforeAvailable : model.afterAvailable;
    const exists = this.mode === "before" ? change.beforeExists : change.afterExists;
    const source = this.mode === "before" ? change.before : change.after;
    let blocks: EditRegion[] = [];
    if (!available) {
      node("div", "fe-notice", change.unavailable || "Text was not recorded for this version (binary or beyond the preview limit).", body);
    } else if (this.mode !== "diff" && !exists) {
      node("div", "fe-notice", `File did not exist ${this.mode === "before" ? "before" : "after"} this edit.`, body);
    } else if (this.mode === "diff") {
      blocks = regions;
      if (!diff!.rows.length) node("div", "fe-notice", "No content changes.", body);
    } else {
      const rows = fileSourceRows(source ?? "", this.mode);
      if (!rows.length) node("div", "fe-notice", "Empty file.", body);
      blocks = [{ label: this.mode === "before" ? "Original file" : "Updated file", rows }];
    }
    let shown = 0;
    const animated: { section: HTMLElement; added: HTMLElement[] }[] = [];
    const total = blocks.reduce((n, block) => n + (block.gap ? 1 : block.rows.length), 0);
    for (const block of blocks) {
      if (shown >= this.limit) break;
      if (block.gap) { node("div", "fe-gap", block.gap, body); shown++; continue; }
      const section = node("section", "fe-region", "", body);
      node("div", "fe-region-label", block.label, section);
      const lines = node("div", "fe-lines", "", section);
      const added: HTMLElement[] = [];
      for (const row of block.rows) {
        if (shown++ >= this.limit) { shown--; break; }
        if (row.kind === "gap") { node("div", "fe-gap", row.text, lines); continue; }
        const line = node("div", `fe-line${this.mode === "diff" ? ` ${row.kind}` : ""}`, "", lines);
        line.dataset.kind = row.kind;
        if (row.old !== undefined) line.dataset.old = String(row.old);
        if (row.next !== undefined) line.dataset.next = String(row.next);
        node("span", "fe-line-number", String(row.old ?? row.next ?? ""), line).setAttribute("aria-hidden", "true");
        node("span", "fe-mark", this.mode !== "diff" ? "" : row.kind === "added" ? "+" : row.kind === "removed" ? "−" : "", line).setAttribute("aria-hidden", "true");
        node("code", "fe-code", row.text, line);
        if (row.kind === "added") added.push(line);
      }
      animated.push({ section, added });
    }
    if (shown < total) {
      const more = node("button", "fe-more", `Show more lines (${total - shown} remaining)`, body);
      more.type = "button";
      more.addEventListener("click", () => { this.limit += 250; this.draw(false); this.element.querySelector<HTMLButtonElement>(".fe-more")?.focus(); });
    }
    const footer = node("div", "fe-footer", "", this.element);
    const status = node("span", "fe-status", this.success ? "Edit applied · recorded diff" : "Recorded changes · step did not complete", footer);
    status.setAttribute("aria-live", "polite");
    const replay = node("button", "fe-replay", "Replay edit", footer);
    replay.type = "button";
    replay.disabled = !this.success || !diff?.rows.length || playing;
    replay.addEventListener("click", () => { this.mode = "diff"; this.draw(true); this.element.querySelector<HTMLButtonElement>(".fe-replay")?.focus(); });
    if (!playing) { if (refocus && !replay.disabled) replay.focus({ preventScroll: true }); return; }
    status.textContent = "Replaying recorded changes";
    const generation = this.generation;
    const gap = Math.min(420, 1800 / Math.max(1, animated.length));
    for (const [index, { section, added }] of animated.entries()) {
      this.animations.push(section.animate([
        { clipPath: "inset(0 0 100% 0)", transform: "translateY(5px)" },
        { clipPath: "inset(0)", transform: "translateY(0)" },
      ], { duration: 500, delay: index * gap, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }));
      for (const [line, element] of added.entries()) {
        this.animations.push(element.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], {
          duration: 350, delay: index * gap + 220 + Math.min(line, 6) * 35, easing: "ease-out", fill: "both",
        }));
      }
    }
    Promise.all(this.animations.map(animation => animation.finished.catch(() => {}))).then(() => {
      if (generation !== this.generation) return;
      this.stop(); replay.disabled = false; status.textContent = "Edit applied · recorded diff";
      if (refocus) replay.focus({ preventScroll: true });
    });
  }
}
