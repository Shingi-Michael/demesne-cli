/** Browser-safe source navigation. Never evaluates output or resolves outside the workspace. */
export type SourceLocation = { path: string; line: number; column?: number };
export type LocationSpan = SourceLocation & { start: number; end: number };
export const escapeHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function workspacePath(
  raw: string,
  workspace: string,
  cwd = workspace,
): string | null {
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== "localhost") return null;
      raw = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  if (/[\0\r\n]/.test(raw)) return null;
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const root = normalize(workspace),
    base = cwd.startsWith("/") ? cwd : `${root}/${cwd}`;
  const absolute = normalize(raw.startsWith("/") ? raw : `${base}/${raw}`);
  return absolute.startsWith(root + "/")
    ? absolute.slice(root.length + 1)
    : null;
}

export function sourceLocations(
  text: string,
  files: ReadonlySet<string>,
  workspace: string,
  cwd?: string,
): LocationSpan[] {
  const result: LocationSpan[] = [];
  // TypeScript (both formats), Rust, Go, JS stacks and Python tracebacks.
  const pattern =
    /(?:File ["']([^"'\n]+)["'], line (\d+))|(?:(["'])([^"'\n]+)\3:(\d+)(?::(\d+))?)|(?:(?<![^\s"'<>()[\],])([^\s"'<>()[\],]+?)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\)))/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? match[4] ?? match[7]!,
      path = workspacePath(raw, workspace, cwd);
    const line = Number(match[2] ?? match[5] ?? match[8] ?? match[10]),
      column = Number(match[6] ?? match[9] ?? match[11]) || undefined;
    if (
      !path ||
      !files.has(path) ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (column && !Number.isSafeInteger(column))
    )
      continue;
    result.push({
      path,
      line,
      column,
      start: match.index!,
      end: match.index! + match[0].length,
    });
    if (result.length >= 200) break;
  }
  return result;
}

export class SourceDocument {
  readonly lines: string[];
  constructor(readonly text: string) {
    this.lines = text.split("\n");
  }
  clamp(line: number) {
    return Math.max(1, Math.min(this.lines.length, Math.trunc(line) || 1));
  }
  search(query: string, limit = 10000) {
    const matches: { line: number; column: number }[] = [];
    if (!query) return matches;
    const needle = query.toLowerCase();
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!.toLowerCase();
      for (
        let at = line.indexOf(needle);
        at >= 0;
        at = line.indexOf(needle, at + Math.max(1, needle.length))
      ) {
        matches.push({ line: i + 1, column: at + 1 });
        if (matches.length >= limit) return matches;
      }
    }
    return matches;
  }
  snippet(path: string, first: number, last: number) {
    const start = this.clamp(Math.min(first, last)),
      end = this.clamp(Math.max(first, last));
    const text = this.lines.slice(start - 1, end).join("\n");
    if (text.length > 64000)
      throw new Error("Select a smaller range (up to 64,000 characters).");
    // A source file may itself contain Markdown fences. Keep the snippet intact.
    const fence = "`".repeat(
      Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    return `Source: ${path}:${start}${end === start ? "" : `-${end}`}\n${fence}\n${text}\n${fence}`;
  }
}
