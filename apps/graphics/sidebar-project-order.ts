const STORAGE_KEY = "demesne-project-order";

/** Keep the saved order; newly opened projects join the end. */
export function orderedProjects(available: string[], saved: unknown): string[] {
  const known = new Set(available);
  const preferred = Array.isArray(saved) ? saved.filter((path): path is string => typeof path === "string" && known.has(path)) : [];
  return [...new Set([...preferred, ...available])];
}

export function moveProject(paths: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !paths.includes(source) || !paths.includes(target)) return paths;
  const next = paths.filter(path => path !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

/** Delegated handlers survive sidebar redraws. Only project names initiate drags. */
export class SidebarProjectOrder {
  private saved: unknown = [];
  private source: string | null = null;
  private destination: { path: string; after: boolean } | null = null;

  constructor(
    private list: HTMLElement | null,
    private available: () => string[],
    private render: () => void,
  ) {
    try { this.saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch {}
    if (!list) return;
    list.addEventListener("dragstart", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>(".sidebar-project-name");
      const path = button?.closest<HTMLElement>("[data-project]")?.dataset.project;
      if (!button || button.disabled || !path || !event.dataTransfer) { event.preventDefault(); return; }
      this.source = path;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", path);
      button.closest(".sidebar-project")?.classList.add("dragging");
    });
    list.addEventListener("dragover", event => {
      if (!this.source) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this.markDestination(event);
    });
    list.addEventListener("dragleave", event => {
      if (!(event.relatedTarget instanceof Node) || !list.contains(event.relatedTarget)) this.clearDestination();
    });
    list.addEventListener("drop", event => {
      if (!this.source) return;
      event.preventDefault();
      event.stopPropagation();
      this.markDestination(event);
      const source = this.source, destination = this.destination;
      this.clearDrag();
      if (destination) this.commit(source, destination.path, destination.after);
      else this.render();
    });
    list.addEventListener("dragend", () => { this.clearDrag(); this.render(); });
    list.addEventListener("keydown", event => {
      const button = (event.target as Element).closest(".sidebar-project-name");
      if (!button || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const source = button.closest<HTMLElement>("[data-project]")!.dataset.project!;
      const paths = this.paths(), index = paths.indexOf(source), after = event.key === "ArrowDown";
      const target = paths[index + (after ? 1 : -1)];
      if (target) this.commit(source, target, after);
    });
  }

  get dragging() { return this.source !== null; }
  paths() { return orderedProjects(this.available(), this.saved); }

  private markDestination(event: DragEvent) {
    this.clearDestination();
    const group = (event.target as Element).closest<HTMLElement>(".sidebar-project");
    if (!group || !this.list?.contains(group) || group.dataset.project === this.source) return;
    const bounds = group.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    this.destination = { path: group.dataset.project!, after };
    group.classList.add(after ? "drop-after" : "drop-before");
  }

  private clearDestination() {
    this.destination = null;
    this.list?.querySelectorAll(".drop-before, .drop-after").forEach(node => node.classList.remove("drop-before", "drop-after"));
  }

  private clearDrag() {
    this.source = null;
    this.clearDestination();
    this.list?.querySelectorAll(".dragging").forEach(node => node.classList.remove("dragging"));
  }

  private commit(source: string, target: string, after: boolean) {
    const paths = this.paths(), next = moveProject(paths, source, target, after);
    this.saved = next;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
    this.render();
    const group = [...this.list!.querySelectorAll<HTMLElement>("[data-project]")].find(node => node.dataset.project === source);
    const button = group?.querySelector<HTMLButtonElement>(".sidebar-project-name");
    button?.focus({ preventScroll: true });
    group?.scrollIntoView({ block: "nearest" });
    const status = document.getElementById("sidebar-order-status");
    if (status) status.textContent = `${button?.textContent ?? "Project"} moved to position ${next.indexOf(source) + 1} of ${next.length}.`;
  }
}
