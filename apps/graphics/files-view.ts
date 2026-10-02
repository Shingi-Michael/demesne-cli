import type {
  WorkspaceFileInfo,
  WorkspaceFileText,
  WorkspaceFileStatus,
} from "@demesne/protocol";
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

type Callbacks = {
  request<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  attach(text: string): void;
  insert(path: string): void;
  changed(): void;
  manual(): void;
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

  constructor(private callbacks: Callbacks) {
    this.element.className = "files-view";
    this.element.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>(
        "[data-file-action]",
      );
      if (!target) return;
      event.stopPropagation();
      this.callbacks.manual();
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
  private rows() {
    const list = this.filtered();
    return this.query.trim()
      ? list
      : [...list.filter((f) => f.status?.trim()), ...list];
  }
  private render() {
    if (!this.file) {
      this.element.innerHTML = `<div class="panel-filter file-filter"><input id="file-search" aria-label="Search files" placeholder="Search filename or path…" value="${h(this.query)}">${button("refresh", "↻", {}, Boolean(this.loading))}</div><div class="files-list" tabindex="0" aria-label="Workspace files"></div>`;
      this.renderList();
      const list = this.get(".files-list");
      if (list) list.scrollTop = this.listScroll;
      if (this.loading)
        list!.innerHTML = `<div class="empty">Opening ${h(this.loading)}…</div>`;
      return;
    }
    const file = this.file;
    this.element.innerHTML = `<div class="file-toolbar"><div class="panel-actions">${button("back", "‹ Files")}${button("reload", "↻ Reload")}${button("insert", "Insert @path")}</div><div class="file-path" title="${h(file.path)}">${h(file.path)}</div><div class="file-status" role="status"></div></div>${this.source ? `<div class="source-tools"><div class="source-find"><input id="source-search" aria-label="Find in file" placeholder="Find in file…" value="${h(this.search)}"><span id="source-match-count" class="muted"></span>${button("previous", "↑")}${button("next", "↓")}</div><div class="source-jump"><label for="source-line">Line</label><input id="source-line" aria-label="Go to line" inputmode="numeric" placeholder="1–${this.source.lines.length}">${button("go", "Go")}<span class="muted">${this.source.lines.length.toLocaleString()} lines</span></div></div><div class="source-viewport" tabindex="0" aria-label="Source code"><div class="source-space"><div class="source-window"></div></div></div><div class="source-selection"></div>` : `<div class="empty">${h(file.reason ?? "Text unavailable")}</div>`}`;
    this.renderedRange = "";
    this.renderStatus();
    this.renderSelection();
    this.renderMatches();
    this.renderLines(true);
  }
  private renderList() {
    const list = this.get(".files-list");
    if (!list || this.file || this.loading) return;
    const filtered = this.filtered(),
      changed = filtered.filter((f) => f.status?.trim());
    const rows = this.rows();
    this.index = Math.min(this.index, Math.max(0, rows.length - 1));
    let index = 0;
    const render = (files: WorkspaceFileInfo[]) =>
      files
        .map((file) => {
          const split = file.path.lastIndexOf("/") + 1;
          return `<button type="button" class="panel-row ${index === this.index ? "selected" : ""}" data-file-action="open" data-action="read-file" data-drive="${h(file.path)}" data-args="${h(JSON.stringify({ path: file.path, index: index++ }))}"><span class="${file.status === "M" ? "amber" : file.status === "D" ? "danger" : "success"}">${h(file.status ?? " ")}</span><span class="name"><span class="muted">${h(file.path.slice(0, split))}</span>${h(file.path.slice(split))}</span><span class="right">${file.byteLength == null ? "" : file.byteLength > 1000 ? `${(file.byteLength / 1000).toFixed(1)}k` : file.byteLength}</span></button>`;
        })
        .join("");
    list.innerHTML = `${!this.query.trim() && changed.length ? `<div class="panel-section">CHANGED</div>${render(changed)}` : ""}<div class="panel-section">${this.query.trim() ? `${filtered.length} MATCHING FILE${filtered.length === 1 ? "" : "S"}` : "ALL FILES"}</div>${render(filtered)}${!filtered.length ? '<div class="empty">No matching files.</div>' : ""}`;
    this.notify();
  }
  private renderStatus() {
    const node = this.get(".file-status");
    if (!node || !this.file) return;
    const text = this.loading
      ? "Reloading…"
      : this.stale ||
        this.statusError ||
        `Read from disk${this.file.modifiedAt ? ` · saved ${new Date(this.file.modifiedAt).toLocaleTimeString()}` : ""}`;
    node.textContent = text;
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
    node.innerHTML = `<span class="muted">${this.selected ? `Lines ${start}${end === start ? "" : `–${end}`} · Shift-click to extend` : "Click a line number · Shift-click for a range"}</span>${button("attach", "Attach lines", {}, !this.selected)}`;
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
    const highlight = (text: string, line: number) => {
      if (!needle) return h(text);
      const lower = text.toLowerCase();
      let at = 0,
        html = "",
        count = 0;
      for (
        let found = lower.indexOf(needle);
        found >= 0 && count++ < 500;
        found = lower.indexOf(needle, at)
      ) {
        html +=
          h(text.slice(at, found)) +
          `<mark class="${current?.line === line && current.column === found + 1 ? "current" : ""}">${h(text.slice(found, found + needle.length))}</mark>`;
        at = found + needle.length;
      }
      return html + h(text.slice(at));
    };
    window.innerHTML = this.source.lines
      .slice(start, end)
      .map((text, i) => {
        const line = start + i + 1;
        return `<div class="source-row ${this.selected && line >= low && line <= high ? "selected" : ""}" data-line="${line}"><button class="source-number" type="button" aria-label="Select line ${line}" data-file-action="line" data-args='{"line":${line}}'>${line}</button><code>${highlight(text.replace(/\r$/, ""), line) || " "}</code></div>`;
      })
      .join("");
    this.notify();
  }
  async action(name: string, args: Record<string, any> = {}, shift = false) {
    if (name === "open") {
      this.index = args.index ?? this.index;
      return this.open({ path: args.path, line: 1 });
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
      const file = this.rows()[this.index];
      if (file) void this.open({ path: file.path, line: 1 });
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
      this.callbacks.manual();
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
    };
  }
}
