/// The top bar's tabs (pass 101): the chats you keep open, in your order.
/// Closing a tab only takes it off the bar. The chat keeps working and stays
/// in the sidebar, and reopening puts it back where it was.

type Store = Pick<Storage, "getItem" | "setItem">;

export class OpenTabs {
  ids: string[] = [];
  /// Pinned tabs (the improved top bar): they sit first, as a small square,
  /// and closing them by accident does nothing. Unpin first to close.
  pinned: string[] = [];
  private closed: { id: string; at: number }[] = [];

  constructor(private store: Store | null = null, private key = "demesne.tabs") {
    const read = (name: string) => {
      try {
        const saved = JSON.parse(store?.getItem(name) ?? "[]");
        return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string" && Boolean(id)))] : [];
      } catch { return []; /* a broken save starts empty */ }
    };
    this.ids = read(key);
    this.pinned = read(`${key}.pinned`).filter((id) => this.ids.includes(id));
    this.order();
  }

  has(id: string) { return this.ids.includes(id); }
  isPinned(id: string) { return this.pinned.includes(id); }

  /// Pins or unpins an open tab. A pinned tab moves to the end of the pinned
  /// ones; an unpinned one goes right after them.
  pin(id: string, on: boolean) {
    if (!this.has(id) || this.isPinned(id) === on) return false;
    this.pinned = on ? [...this.pinned, id] : this.pinned.filter((one) => one !== id);
    this.ids = this.ids.filter((one) => one !== id);
    this.ids.splice(this.pinned.length - (on ? 1 : 0), 0, id);
    this.order();
    this.save();
    return true;
  }

  /// Pinned tabs first, in pin order; the rest keep theirs.
  private order() {
    this.ids = [...this.pinned.filter((id) => this.ids.includes(id)), ...this.ids.filter((id) => !this.pinned.includes(id))];
  }

  /// Opens a chat as a tab right after `after` (the tab you were on), or at
  /// the end. False when it was already open.
  open(id: string, after?: string | null) {
    if (this.has(id)) return false;
    const at = after ? this.ids.indexOf(after) : -1;
    this.ids.splice(Math.max(at < 0 ? this.ids.length : at + 1, this.pinned.length), 0, id);
    this.save();
    return true;
  }

  /// Takes a tab off the bar and returns the tab to show in its place: the
  /// one on its right, else the one on its left.
  close(id: string) {
    const at = this.ids.indexOf(id);
    if (at < 0 || this.isPinned(id)) return undefined;
    this.ids.splice(at, 1);
    this.closed.push({ id, at });
    this.save();
    return this.ids[at] ?? this.ids[at - 1];
  }

  /// Puts the tab closed last back where it was and returns it. Chats that
  /// are gone since (`alive` says) are skipped.
  reopen(alive: (id: string) => boolean = () => true) {
    while (this.closed.length) {
      const last = this.closed.pop()!;
      if (this.has(last.id) || !alive(last.id)) continue;
      this.ids.splice(Math.max(this.pinned.length, Math.min(last.at, this.ids.length)), 0, last.id);
      this.save();
      return last.id;
    }
    return undefined;
  }

  /// Moves a tab to `to`, counted among the tabs as they are now. A tab
  /// keeps to its side of the pins.
  move(id: string, to: number) {
    const from = this.ids.indexOf(id);
    if (from < 0) return;
    this.ids.splice(from, 1);
    const pins = this.pinned.length, pinned = this.isPinned(id);
    const lo = pinned ? 0 : pins, hi = pinned ? pins - 1 : this.ids.length;
    this.ids.splice(Math.max(lo, Math.min(to, hi)), 0, id);
    if (pinned) this.pinned = this.ids.filter((one) => this.pinned.includes(one));
    this.save();
  }

  /// Drops the tabs of chats that no longer exist (archived or deleted).
  keep(alive: (id: string) => boolean) {
    const kept = this.ids.filter(alive);
    if (kept.length === this.ids.length) return;
    this.ids = kept;
    this.pinned = this.pinned.filter(alive);
    this.save();
  }

  /// The tab `step` places from `id`, wrapping around.
  step(id: string | undefined, step: number) {
    if (!this.ids.length) return undefined;
    const at = id ? this.ids.indexOf(id) : -1;
    if (at < 0) return this.ids[step > 0 ? 0 : this.ids.length - 1];
    return this.ids[(at + step + this.ids.length * Math.abs(step)) % this.ids.length];
  }

  private save() {
    try {
      this.store?.setItem(this.key, JSON.stringify(this.ids));
      this.store?.setItem(`${this.key}.pinned`, JSON.stringify(this.pinned));
    } catch { /* storage may be off */ }
  }
}
