/// The model ends a final answer with one hidden line, <next>…</next>: the
/// most useful next request. Clients show it as a suggestion in the composer
/// and strip it from the answer everywhere it's displayed or reused.

const COMPLETE = /\s*<next>([\s\S]*?)<\/next>\s*/g;

/// The answer without the tag, and the suggestion. While streaming, an
/// unfinished tag at the end (`<ne`, `<next>Add a`) is hidden too.
export function splitNextPrompt(raw: string): { text: string; next: string | null } {
  let next: string | null = null;
  let text = raw.replace(COMPLETE, (_, value: string) => { next = value.replace(/\s+/g, " ").trim().slice(0, 200) || null; return "\n"; });
  const open = text.lastIndexOf("<next>");
  if (open >= 0) text = text.slice(0, open);
  else {
    // A partial `<next>` opener still arriving.
    const partial = /<n?e?x?t?>?$/.exec(text);
    if (partial && partial[0].length > 0 && "<next>".startsWith(partial[0])) text = text.slice(0, partial.index);
  }
  return { text: text.replace(/\s+$/, ""), next };
}

/// For output written as it streams: emits text that can't be part of the
/// tag, holds back what might be, and drops the tag itself.
export class NextPromptFilter {
  private held = "";
  private inside = false;
  next: string | null = null;
  private captured = "";
  push(delta: string): string {
    let out = "";
    this.held += delta;
    for (;;) {
      if (this.inside) {
        const close = this.held.indexOf("</next>");
        if (close < 0) {
          // Keep back a fragment that could still become `</next>`.
          let keep = 0;
          for (let length = Math.min(6, this.held.length); length > 0; length--) if ("</next>".startsWith(this.held.slice(-length))) { keep = length; break; }
          this.captured += this.held.slice(0, this.held.length - keep);
          this.held = this.held.slice(this.held.length - keep);
          return out;
        }
        this.captured += this.held.slice(0, close);
        this.next = this.captured.replace(/\s+/g, " ").trim().slice(0, 200) || null;
        this.held = this.held.slice(close + "</next>".length);
        this.inside = false;
        continue;
      }
      const open = this.held.indexOf("<next>");
      if (open >= 0) { out += this.held.slice(0, open); this.held = this.held.slice(open + "<next>".length); this.inside = true; continue; }
      // Keep back a trailing fragment that could still become `<next>`.
      let keep = 0;
      for (let length = Math.min(5, this.held.length); length > 0; length--) if ("<next>".startsWith(this.held.slice(-length))) { keep = length; break; }
      out += this.held.slice(0, this.held.length - keep);
      this.held = this.held.slice(this.held.length - keep);
      return out;
    }
  }
  end(): string { const rest = this.inside ? "" : this.held; this.held = ""; return rest; }
}
