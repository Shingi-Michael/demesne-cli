import type {
  WorkspaceFileInfo,
  WorkspaceFileText,
  WorkspaceFileStatus,
} from "@demesne/protocol";
import hljs from "highlight.js/lib/common";
import {
  escapeHTML as h,
  SourceDocument,
  type SourceLocation,
} from "./file-navigation.ts";

const ROW_HEIGHT = 20;
const button = (
  name: string,
  text: string,
  args: Record<string, unknown> = {},
  disabled = false,
) =>
  `<button type="button" data-file-action="${name}" ${name === "back" ? 'data-action="file-back" data-drive="file-back"' : ""} data-args="${h(JSON.stringify(args))}" ${disabled ? "disabled" : ""}>${text}</button>`;

/// A row in the file list: a file, or a folder that opens and closes.
type Row =
  | { kind: "file"; key: string; file: WorkspaceFileInfo; depth: number; prefix: string; name: string; right: string; tone: string }
  | { kind: "dir"; key: string; path: string; depth: number; name: string; open: boolean; right: string; tone: string; changed: boolean }
  | { kind: "label"; key: string; text: string; right?: string };

const LANGUAGES: Record<string, [string, string]> = {
  ts: ["TypeScript", "typescript"], tsx: ["TypeScript", "typescript"], mts: ["TypeScript", "typescript"], cts: ["TypeScript", "typescript"],
  js: ["JavaScript", "javascript"], jsx: ["JavaScript", "javascript"], mjs: ["JavaScript", "javascript"], cjs: ["JavaScript", "javascript"],
  json: ["JSON", "json"], md: ["Markdown", "markdown"], css: ["CSS", "css"], html: ["HTML", "xml"], svg: ["SVG", "xml"], xml: ["XML", "xml"],
  rs: ["Rust", "rust"], py: ["Python", "python"], sh: ["Shell", "bash"], bash: ["Shell", "bash"], zsh: ["Shell", "bash"],
  toml: ["TOML", "ini"], yml: ["YAML", "yaml"], yaml: ["YAML", "yaml"], swift: ["Swift", "swift"], go: ["Go", "go"],
  java: ["Java", "java"], kt: ["Kotlin", "kotlin"], c: ["C", "c"], h: ["C", "c"], cpp: ["C++", "cpp"], rb: ["Ruby", "ruby"], sql: ["SQL", "sql"],
};
const language = (path: string) => LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""];
/// Highlighted HTML split into lines: spans open across a newline are
/// closed at its end and reopened on the next line.
function splitHighlighted(html: string) {
  const lines: string[] = [], open: string[] = [];
  let line = "";
  for (const [, start, end, newline, text] of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (start) { open.push(start); line += start; }
    else if (end) { open.pop(); line += end; }
    else if (newline) { lines.push(line + "</span>".repeat(open.length)); line = open.join(""); }
    else line += text!.replace(/\r/g, "");
  }
  lines.push(line);
  return lines;
}
const ago = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : new Date(iso).toLocaleDateString();
};

type Callbacks = {
  request<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  attach(text: string): void;
  insert(path: string): void;
  changed(): void;
  error(message: string): void;
};

/** Owns its DOM so streamed turns never reset file search, selection or scrolling. */
export class FilesView {
  readonly element = document.createElement("div");
  private files: WorkspaceFileInfo[] = [];
  private filesKey = "";
  private query = "";
  private index = 0;
  private file: WorkspaceFileText | null = null;
  private source: SourceDocument | null = null;
  private search = "";
  private matches: { line: number; column: number }[] = [];
  private match = -1;
  private anchor = 1;
  private cursor = 1;
  private selected = false;
  private stale = "";
  private statusError = "";
  private loading = "";
  private generation = 0;
  private checking = false;
  private active = false;
  private timer?: ReturnType<typeof setInterval>;
  private observer: ResizeObserver;
  private renderedRange = "";
  private frame = 0;
  private listScroll = 0;
  /// Folders opened in the tree (`tree:apps/graphics`) and new-file groups
  /// opened under Changed (`changed:experiments`).
  private openFolders = new Set<string>();
  private visible: Row[] = [];
  private highlighted: string[] | null = null;
  private marks = new Map<number, string>();

  constructor(private callbacks: Callbacks) {
    this.element.className = "files-view";
    this.element.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>(
        "[data-file-action]",
      );
      if (!target) return;
      event.stopPropagation();
      void this.action(
        target.dataset.fileAction!,
        JSON.parse(target.dataset.args ?? "{}"),
        event.shiftKey,
      ).catch((error) => this.callbacks.error(String(error)));
    });
    this.element.addEventListener("input", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.id === "file-search") {
        this.query = input.value;
        this.index = 0;
        this.renderList();
      }
      if (input.id === "source-search") {
        this.search = input.value;
        this.find();
      }
    });
    this.element.addEventListener(
      "scroll",
      (event) => {
        if (
          (event.target as HTMLElement).classList.contains("source-viewport") &&
          !this.frame
        )
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.renderLines();
          });
      },
      true,
    );
    this.observer = new ResizeObserver(() => this.renderLines());
    this.observer.observe(this.element);
    this.render();
  }
  private get<T extends HTMLElement = HTMLElement>(selector: string) {
    return this.element.querySelector<T>(selector);
  }
  private notify() {
    if (this.active) this.callbacks.changed();
  }
  update(files: WorkspaceFileInfo[]) {
    const key = JSON.stringify(files);
    if (key === this.filesKey) return;
    this.filesKey = key;
    this.files = files;
    this.get<HTMLInputElement>("#file-search")?.setAttribute("placeholder", `Search ${files.length.toLocaleString()} files`);
    if (!this.file && !this.loading) this.renderList();
  }
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    clearInterval(this.timer);
    if (active) {
      void this.checkStatus();
      this.timer = setInterval(() => void this.checkStatus(), 2000);
      requestAnimationFrame(() => this.renderLines());
    }
  }
  reset() {
    this.setActive(false);
    this.generation++;
    this.file = this.source = null;
    this.query =
      this.search =
      this.loading =
      this.stale =
      this.statusError =
        "";
    this.index = this.listScroll = 0;
    this.selected = false;
    this.render();
  }
  async open(location: SourceLocation, reload = false) {
    const generation = ++this.generation;
    if (!this.file)
      this.listScroll = this.get(".files-list")?.scrollTop ?? this.listScroll;
    const previous = {
      anchor: this.anchor,
      cursor: this.cursor,
      selected: this.selected,
      scroll: this.get(".source-viewport")?.scrollTop ?? 0,
    };
    this.loading = location.path;
    if (!reload) {
      this.file = this.source = null;
      this.render();
    } else this.renderStatus();
    try {
      const file = await this.callbacks.request<WorkspaceFileText>(
        "read-file",
        { path: location.path },
      );
      if (generation !== this.generation) return;
      this.file = file;
      this.source =
        file.content === null ? null : new SourceDocument(file.content);
      this.highlighted = null;
      const lang = language(file.path)?.[1];
      if (this.source && lang && file.content!.length <= 400_000 && hljs.getLanguage(lang)) {
        try {
          const lines = splitHighlighted(hljs.highlight(file.content!, { language: lang, ignoreIllegals: true }).value);
          if (lines.length === this.source.lines.length) this.highlighted = lines;
        } catch { /* shown as plain text */ }
      }
      // The margin: lines added, changed, or with something removed after them.
      this.marks = new Map();
      for (const [first, last] of file.changes?.added ?? []) for (let line = first; line <= last && line - first < 50_000; line++) this.marks.set(line, "add");
      for (const [first, last] of file.changes?.modified ?? []) for (let line = first; line <= last && line - first < 50_000; line++) this.marks.set(line, "mod");
      for (const line of file.changes?.removed ?? []) if (!this.marks.has(Math.max(1, line))) this.marks.set(Math.max(1, line), "del");
      this.search = reload ? this.search : "";
      this.matches = this.source?.search(this.search) ?? [];
      this.match = this.matches.length ? 0 : -1;
      this.cursor = this.source?.clamp(location.line) ?? 1;
      this.anchor = reload
        ? (this.source?.clamp(previous.anchor) ?? 1)
        : this.cursor;
      this.selected = reload ? previous.selected : true;
      this.stale = this.statusError = this.loading = "";
      this.render();
      if (reload) {
        const viewport = this.get(".source-viewport");
        if (viewport) viewport.scrollTop = previous.scroll;
        this.renderLines(true);
      } else this.reveal(this.cursor, location.column);
    } catch (error) {
      if (generation !== this.generation) return;
      this.loading = "";
      if (reload) {
        this.statusError = String(error);
        this.renderStatus();
      } else {
        this.render();
        this.callbacks.error(String(error));
      }
    }
    this.notify();
  }
  private filtered() {
    const terms = this.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.files.filter((file) =>
      terms.every((term) => file.path.toLowerCase().includes(term)),
    );
  }
  /// Rows you can move to with the arrow keys (labels are skipped).
  private rows() {
    return this.visible.filter((row) => row.kind !== "label");
  }
  /// The list as rows: changes first (whole new folders grouped), then the
  /// folder tree; while searching, matches grouped under their folder.
  private model(): Row[] {
    const rows: Row[] = [];
    const fileRow = (file: WorkspaceFileInfo, depth: number, withPrefix: boolean, key: string): Row => {
      const split = file.path.lastIndexOf("/") + 1, status = file.status?.trim() ?? "";
      const right = file.additions !== undefined || file.deletions !== undefined
        ? `<span class="add">+${file.additions ?? 0}</span> <span class="del">−${file.deletions ?? 0}</span>`
        : status === "?" || status === "A" ? "new" : status === "D" ? "deleted" : "";
      return { kind: "file", key, file, depth, prefix: withPrefix ? file.path.slice(0, split) : "", name: file.path.slice(split), right, tone: status === "?" || status === "A" ? "add" : status === "D" ? "del" : status ? "mod" : "" };
    };
    if (this.query.trim()) {
      const groups = new Map<string, WorkspaceFileInfo[]>();
      for (const file of this.filtered().slice(0, 500)) {
        const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        groups.set(folder, [...(groups.get(folder) ?? []), file]);
      }
      for (const [folder, files] of groups) {
        rows.push({ kind: "label", key: `group:${folder}`, text: folder || "top level" });
        for (const file of files) rows.push(fileRow(file, 1, false, `search:${file.path}`));
      }
      return rows;
    }
    // Folders: how many files each holds, and how many of them are new.
    const total = new Map<string, number>(), untracked = new Map<string, number>(), changed = new Set<string>();
    for (const file of this.files) {
      const parts = file.path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join("/");
        total.set(folder, (total.get(folder) ?? 0) + 1);
        if (file.status?.trim() === "?") untracked.set(folder, (untracked.get(folder) ?? 0) + 1);
        if (file.status?.trim()) changed.add(folder);
      }
    }
    const allNew = (folder: string) => (total.get(folder) ?? 0) >= 2 && untracked.get(folder) === total.get(folder);
    const edited = this.files.filter((file) => file.status?.trim() && file.status.trim() !== "?");
    const fresh = this.files.filter((file) => file.status?.trim() === "?");
    if (edited.length || fresh.length) {
      rows.push({ kind: "label", key: "label:changed", text: "Changed", right: [edited.length ? `${edited.length} edited` : "", fresh.length ? `${fresh.length} new` : ""].filter(Boolean).join(" · ") });
      for (const file of edited) rows.push(fileRow(file, 0, true, `changed:${file.path}`));
      // A folder of nothing but new files is one row, not one per file.
      const grouped = new Set<string>();
      for (const file of fresh) {
        const parts = file.path.split("/");
        const folder = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).find(allNew);
        if (folder) {
          if (grouped.has(folder)) continue;
          grouped.add(folder);
          const key = `changed:${folder}`, open = this.openFolders.has(key);
          rows.push({ kind: "dir", key, path: folder, depth: 0, name: `${folder}/`, open, right: `${total.get(folder)} new files`, tone: "add", changed: false });
          if (open) for (const inner of fresh.filter((item) => item.path.startsWith(`${folder}/`))) rows.push(fileRow(inner, 1, false, `changed:${inner.path}`));
        } else rows.push(fileRow(file, 0, true, `changed:${file.path}`));
      }
    }
    rows.push({ kind: "label", key: "label:all", text: "All files", right: this.files.length.toLocaleString() });
    const walk = (folder: string, depth: number) => {
      const prefix = folder ? `${folder}/` : "";
      const folders = new Set<string>(), files: WorkspaceFileInfo[] = [];
      for (const file of this.files) {
        if (!file.path.startsWith(prefix)) continue;
        const rest = file.path.slice(prefix.length), slash = rest.indexOf("/");
        if (slash >= 0) folders.add(rest.slice(0, slash));
        else files.push(file);
      }
      for (const name of [...folders].sort((a, b) => a.localeCompare(b))) {
        const path = prefix + name, key = `tree:${path}`, open = this.openFolders.has(key);
        const wholeNew = allNew(path);
        rows.push({ kind: "dir", key, path, depth, name, open, right: wholeNew ? `${total.get(path)} new` : String(total.get(path) ?? 0), tone: wholeNew ? "add" : "", changed: !wholeNew && changed.has(path) });
        if (open) walk(path, depth + 1);
      }
      for (const file of files) rows.push(fileRow(file, depth, false, `tree:${file.path}`));
    };
    walk("", 0);
    return rows;
  }
  private render() {
    if (!this.file) {
      this.element.innerHTML = `<div class="panel-filter file-filter"><label class="file-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="file-search" aria-label="Search files" placeholder="Search ${this.files.length.toLocaleString()} files" value="${h(this.query)}" autocomplete="off"></label>${button("refresh", "↻", {}, Boolean(this.loading)).replace("<button ", '<button aria-label="Refresh the file list" ')}</div><div class="files-list" tabindex="0" aria-label="Workspace files"></div><div class="files-keys">↑↓ move · → open folder · ↵ open · type to search</div>`;
      this.renderList();
      const list = this.get(".files-list");
      if (list) list.scrollTop = this.listScroll;
      if (this.loading)
        list!.innerHTML = `<div class="empty">Opening ${h(this.loading)}…</div>`;
      return;
    }
    const file = this.file, parts = file.path.split("/");
    this.element.innerHTML = `<div class="file-head"><div class="file-title">${button("back", "‹").replace("<button ", '<button aria-label="Back to files" class="file-icon" ')}<span class="file-path" title="${h(file.path)}">${parts.slice(0, -1).map((part) => `<span class="muted">${h(part)} / </span>`).join("")}<b>${h(parts.at(-1)!)}</b></span>${button("reload", "↻").replace("<button ", '<button aria-label="Reload from disk" class="file-icon" ')}${button("insert", "@").replace("<button ", '<button aria-label="Mention in your message" class="file-icon" ')}</div><div class="file-status" role="status"></div></div>${this.source ? `<div class="source-tools"><label class="source-find"><input id="source-search" aria-label="Find in file" placeholder="Find in file" value="${h(this.search)}" autocomplete="off"><span id="source-match-count" class="muted"></span>${button("previous", "↑").replace("<button ", '<button aria-label="Previous match" ')}${button("next", "↓").replace("<button ", '<button aria-label="Next match" ')}</label><label class="source-jump"><span class="muted">Line</span><input id="source-line" aria-label="Go to line" inputmode="numeric" placeholder="1–${this.source.lines.length}" autocomplete="off"></label></div><div class="source-viewport" tabindex="0" aria-label="Source code"><div class="source-space"><div class="source-window"></div></div></div><div class="source-selection"></div>` : `<div class="empty">${h(file.reason ?? "Text unavailable")}</div>`}`;
    this.renderedRange = "";
    this.renderStatus();
    this.renderSelection();
    this.renderMatches();
    this.renderLines(true);
  }
  private renderList() {
    const list = this.get(".files-list");
    if (!list || this.file || this.loading) return;
    this.visible = this.model();
    const rows = this.rows();
    this.index = Math.min(this.index, Math.max(0, rows.length - 1));
    const selected = rows[this.index]?.key;
    const terms = this.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const mark = (text: string) => {
      if (!terms.length) return h(text);
      const lower = text.toLowerCase(), hit = new Array<boolean>(text.length).fill(false);
      for (const term of terms) for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) hit.fill(true, at, at + term.length);
      let html = "";
      for (let i = 0; i < text.length; ) {
        let j = i;
        while (j < text.length && hit[j] === hit[i]) j++;
        html += hit[i] ? `<mark>${h(text.slice(i, j))}</mark>` : h(text.slice(i, j));
        i = j;
      }
      return html;
    };
    let index = 0;
    list.innerHTML = this.visible.map((row) => {
      if (row.kind === "label") return `<div class="panel-section files-section"><span>${h(row.text)}</span>${row.right ? `<span>${h(row.right)}</span>` : ""}</div>`;
      const at = index++, chosen = row.key === selected ? "selected" : "";
      const indent = `style="--depth:${row.depth}"`;
      if (row.kind === "dir")
        return `<button type="button" class="panel-row file-row dir ${chosen}" ${indent} data-file-action="toggle" data-drive="${h(row.key)}" data-args="${h(JSON.stringify({ key: row.key, index: at }))}" aria-expanded="${row.open}"><span class="twisty">${row.open ? "▾" : "▸"}</span><span class="name ${row.tone}">${h(row.name)}</span>${row.changed ? '<span class="dot" aria-label="has changes">•</span>' : ""}<span class="right ${row.tone}">${h(row.right)}</span></button>`;
      const status = row.file.status?.trim() ?? "";
      return `<button type="button" class="panel-row file-row ${chosen}" ${indent} data-file-action="open" data-action="read-file" data-drive="${h(row.file.path)}" data-args="${h(JSON.stringify({ path: row.file.path, index: at }))}"><span class="file-mark ${row.tone}">${h(status === "?" ? "+" : status)}</span><span class="name">${row.prefix ? `<span class="muted">${h(row.prefix)}</span>` : ""}${mark(row.name)}</span><span class="right">${row.right}</span></button>`;
    }).join("") + (this.query.trim() && !rows.length ? '<div class="empty">No matching files.</div>' : "");
    this.notify();
  }
  private renderStatus() {
    const node = this.get(".file-status");
    if (!node || !this.file) return;
    const file = this.file, changes = file.changes;
    const facts = [
      language(file.path)?.[0],
      this.source ? `${this.source.lines.length.toLocaleString()} lines` : "",
      changes?.untracked ? '<span class="add">new file</span>' : changes ? `<span class="add">+${changes.additions}</span> <span class="del">−${changes.deletions}</span> since last commit` : "",
      file.modifiedAt ? `saved ${ago(file.modifiedAt)}` : "",
    ].filter(Boolean);
    const warning = this.loading ? "Reloading…" : this.stale || this.statusError;
    node.innerHTML = warning ? h(warning) : facts.join(" · ");
    node.classList.toggle("amber", Boolean(this.stale || this.statusError));
  }
  private async checkStatus() {
    if (!this.active || !this.file || this.loading || this.checking) return;
    const file = this.file,
      generation = this.generation;
    this.checking = true;
    try {
      const status = await this.callbacks.request<WorkspaceFileStatus>(
        "file-status",
        { path: file.path },
      );
      if (generation !== this.generation || !this.active) return;
      this.stale = status.reason
        ? `Unavailable on disk: ${status.reason}. Showing the loaded copy.`
        : file.revision && status.revision && file.revision !== status.revision
          ? "Changed on disk · Reload to see the latest contents."
          : "";
      this.statusError =
        !status.reason && (!file.revision || !status.revision)
          ? "File-change detection unavailable · reload to refresh."
          : "";
      this.renderStatus();
      this.notify();
    } catch {
      if (generation === this.generation && this.active) {
        this.statusError = "Could not check the file · Reload to retry.";
        this.renderStatus();
        this.notify();
      }
    } finally {
      this.checking = false;
    }
  }
  private renderSelection() {
    const node = this.get(".source-selection");
    if (!node) return;
    const start = Math.min(this.anchor, this.cursor),
      end = Math.max(this.anchor, this.cursor);
    node.innerHTML = `<span class="muted">${this.selected ? `${end === start ? `Line ${start}` : `Lines ${start}–${end}`} selected · Shift-click to extend` : "Click a line number · Shift-click for a range"}</span>${button("attach", "Add to message", {}, !this.selected)}`;
  }
  private renderMatches() {
    const node = this.get("#source-match-count");
    if (node)
      node.textContent = !this.search
        ? ""
        : !this.matches.length
          ? "No matches"
          : `${this.match + 1}/${this.matches.length}${this.matches.length === 10000 ? "+" : ""}`;
  }
  private find() {
    this.matches = this.source?.search(this.search) ?? [];
    this.match = this.matches.length ? 0 : -1;
    this.renderMatches();
    const match = this.matches[this.match];
    if (match) this.reveal(match.line, match.column);
    this.renderLines(true);
    this.notify();
  }
  private reveal(line: number, column = 1) {
    const viewport = this.get(".source-viewport");
    if (!viewport) return;
    viewport.scrollTop = Math.max(
      0,
      (line - 1) * ROW_HEIGHT - viewport.clientHeight / 3,
    );
    this.renderLines(true);
    viewport.scrollLeft = Math.max(
      0,
      (column - 1) * 7.23 - (viewport.clientWidth - 70) / 2,
    );
  }
  private renderLines(force = false) {
    const viewport = this.get(".source-viewport"),
      space = this.get(".source-space"),
      window = this.get(".source-window");
    if (!viewport || !space || !window || !this.source) return;
    const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 8),
      end = Math.min(
        this.source.lines.length,
        start + Math.ceil(viewport.clientHeight / ROW_HEIGHT) + 20,
      );
    const key = `${start}:${end}`;
    if (!force && key === this.renderedRange) return;
    this.renderedRange = key;
    space.style.height = `${this.source.lines.length * ROW_HEIGHT}px`;
    window.style.top = `${start * ROW_HEIGHT}px`;
    const low = Math.min(this.anchor, this.cursor),
      high = Math.max(this.anchor, this.cursor),
      needle = this.search.toLowerCase();
    const current = this.matches[this.match];
    window.innerHTML = this.source.lines
      .slice(start, end)
      .map((text, i) => {
        const line = start + i + 1, mark = this.marks.get(line);
        return `<div class="source-row ${this.selected && line >= low && line <= high ? "selected" : ""} ${mark ? `change-${mark}` : ""}" data-line="${line}"><button class="source-number" type="button" aria-label="Select line ${line}" data-file-action="line" data-args='{"line":${line}}'>${line}</button><code>${this.highlighted?.[line - 1] ?? h(text.replace(/\r$/, ""))}</code></div>`;
      })
      .join("");
    // Find matches, marked inside the highlighted text without disturbing it.
    if (needle)
      for (const row of window.querySelectorAll<HTMLElement>(".source-row")) {
        const line = Number(row.dataset.line);
        if (!this.source.lines[line - 1]!.toLowerCase().includes(needle)) continue;
        const walker = document.createTreeWalker(row.querySelector("code")!, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        let offset = 0;
        for (const node of nodes) {
          const text = node.data, lower = text.toLowerCase(), base = offset;
          offset += text.length;
          const parts: Node[] = [];
          let at = 0;
          for (let found = lower.indexOf(needle); found >= 0; found = lower.indexOf(needle, found + needle.length)) {
            parts.push(document.createTextNode(text.slice(at, found)));
            const markNode = document.createElement("mark");
            if (current?.line === line && current.column === base + found + 1) markNode.className = "current";
            markNode.textContent = text.slice(found, found + needle.length);
            parts.push(markNode);
            at = found + needle.length;
          }
          if (!parts.length) continue;
          parts.push(document.createTextNode(text.slice(at)));
          node.replaceWith(...parts);
        }
      }
    this.notify();
  }
  async action(name: string, args: Record<string, any> = {}, shift = false) {
    if (name === "open") {
      this.index = args.index ?? this.index;
      return this.open({ path: args.path, line: 1 });
    }
    if (name === "toggle") {
      const key = String(args.key);
      this.index = args.index ?? this.index;
      if (this.openFolders.has(key)) this.openFolders.delete(key);
      else this.openFolders.add(key);
      this.renderList();
      return;
    }
    if (name === "refresh") {
      await this.callbacks.request("files");
      return;
    }
    if (name === "back") {
      this.generation++;
      this.file = this.source = null;
      this.loading = "";
      this.render();
      this.get<HTMLInputElement>("#file-search")?.focus();
    }
    if (name === "reload" && this.file)
      return this.open({ path: this.file.path, line: this.cursor }, true);
    if (name === "insert" && this.file) this.callbacks.insert(this.file.path);
    if (name === "line" && this.source) {
      this.cursor = this.source.clamp(Number(args.line));
      if (!shift || !this.selected) this.anchor = this.cursor;
      this.selected = true;
      this.renderSelection();
      this.renderLines(true);
      this.get(".source-viewport")?.focus({ preventScroll: true });
    }
    if (name === "go" && this.source) {
      const input = this.get<HTMLInputElement>("#source-line")!;
      if (
        !/^\d+$/.test(input.value) ||
        Number(input.value) < 1 ||
        Number(input.value) > this.source.lines.length
      ) {
        this.callbacks.error(
          `Enter a line from 1 to ${this.source.lines.length}.`,
        );
        return;
      }
      await this.action("line", { line: Number(input.value) });
      this.reveal(this.cursor);
    }
    if ((name === "next" || name === "previous") && this.matches.length) {
      this.match =
        (this.match + (name === "next" ? 1 : -1) + this.matches.length) %
        this.matches.length;
      const match = this.matches[this.match]!;
      this.renderMatches();
      this.reveal(match.line, match.column);
    }
    if (name === "attach" && this.file && this.source && this.selected) {
      this.callbacks.attach(
        this.source.snippet(this.file.path, this.anchor, this.cursor),
      );
    }
    this.notify();
  }
  handleKey(event: KeyboardEvent) {
    const key = event.key.toLowerCase(),
      ctrl = event.ctrlKey || event.metaKey,
      target = event.target as HTMLElement;
    const input = target instanceof HTMLInputElement;
    let handled = true;
    if ((ctrl && key === "f") || (ctrl && key === "l" && this.source)) {
      const field = this.get<HTMLInputElement>(
        key === "l"
          ? "#source-line"
          : this.file
            ? "#source-search"
            : "#file-search",
      );
      field?.focus();
      field?.select();
    } else if (key === "escape" && this.file) void this.action("back");
    else if (key === "enter" && target.id === "source-line")
      void this.action("go");
    else if (key === "enter" && target.id === "source-search")
      void this.action(event.shiftKey ? "previous" : "next");
    else if (
      key === "enter" &&
      !this.file &&
      (target.id === "file-search" ||
        target.id === "panel" ||
        target.classList.contains("files-list"))
    ) {
      const row = this.rows()[this.index];
      if (row?.kind === "file") void this.open({ path: row.file.path, line: 1 });
      else if (row?.kind === "dir") void this.action("toggle", { key: row.key, index: this.index });
    } else if (
      ["arrowright", "arrowleft"].includes(key) &&
      !this.file &&
      !input
    ) {
      const row = this.rows()[this.index];
      if (row?.kind === "dir" && row.open !== (key === "arrowright")) void this.action("toggle", { key: row.key, index: this.index });
    } else if (
      ["arrowdown", "arrowup"].includes(key) &&
      !this.file &&
      (target.id === "file-search" || !input)
    ) {
      const rows = this.rows();
      this.index =
        (this.index + (key === "arrowdown" ? 1 : -1) + rows.length) %
        Math.max(1, rows.length);
      this.renderList();
      this.get(".panel-row.selected")?.scrollIntoView({ block: "nearest" });
    } else if (
      !input &&
      this.source &&
      ["arrowdown", "arrowup"].includes(key) &&
      event.shiftKey
    ) {
      void this.action(
        "line",
        { line: this.cursor + (key === "arrowdown" ? 1 : -1) },
        true,
      );
      this.reveal(this.cursor);
    } else if (
      !input &&
      !ctrl &&
      !event.altKey &&
      key.length === 1 &&
      !this.file
    ) {
      const search = this.get<HTMLInputElement>("#file-search")!;
      search.focus();
      search.value += event.key;
      this.query = search.value;
      this.index = 0;
      this.renderList();
    } else handled = false;
    if (handled) {
      event.preventDefault();
    }
    return handled;
  }
  scrollElement() {
    return this.get(".source-viewport") ?? this.get(".files-list");
  }
  inspect() {
    return {
      path: this.file?.path,
      query: this.query,
      search: this.search,
      matches: this.matches.length,
      match: this.match,
      line: this.cursor,
      anchor: this.anchor,
      stale: this.stale,
      statusError: this.statusError,
      loading: this.loading,
      renderedLines: this.element.querySelectorAll(".source-row").length,
      lines: this.source?.lines.length,
      scroll: this.get(".source-viewport")?.scrollTop,
      listCount: this.filtered().length,
      rows: this.visible.slice(0, 60).map((row) => row.kind === "label" ? `# ${row.text}` : row.kind === "dir" ? `${row.open ? "▾" : "▸"} ${row.name} (${row.right})` : `${row.file.path}${row.right ? ` ${row.right.replace(/<[^>]+>/g, "")}` : ""}`),
      changeMarks: Object.fromEntries(this.marks),
      highlighted: Boolean(this.highlighted),
    };
  }
}
