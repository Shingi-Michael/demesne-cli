import { posix } from "node:path";

/// Inspection commands sent through run_command (ls, cat, head, sed -n,
/// grep, rg, find -name) are answered by the built-in read-only tools when the
/// two are equivalent: same answer, no approval prompt, and no host process.
/// tail and wc get a pointer to read_file instead of running. Anything else
/// (regular expressions, pipes, other flags) runs as a normal command.

export type InspectionRoute =
  | { kind: "tool"; name: "list_files" | "read_file" | "read_files" | "search_files"; input: Record<string, unknown>; note: string }
  | { kind: "pointer"; message: string };

const SAFE = /^[^\0]{1,4096}$/;

export function routeInspection(input: unknown): InspectionRoute | null {
  if (!input || typeof input !== "object") return null;
  const value = input as { argv?: unknown; cwd?: unknown; background?: unknown };
  if (!Array.isArray(value.argv) || !value.argv.length || !value.argv.every((word) => typeof word === "string" && SAFE.test(word))) return null;
  if (value.background === true) return null;
  const argv = value.argv as string[];
  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : ".";
  const at = (path: string) => {
    const joined = posix.normalize(posix.join(cwd.replace(/\\/g, "/"), path.replace(/\\/g, "/")));
    return joined === "" ? "." : joined.replace(/\/$/, "") || ".";
  };
  const program = argv[0]!.split("/").at(-1)!;
  const args = argv.slice(1);
  const flags = args.filter((word) => word.startsWith("-"));
  const operands = args.filter((word) => !word.startsWith("-"));
  const via = (tool: string) => `Ran as ${tool} (built in, no approval needed); use ${tool} directly next time.`;

  if (program === "ls") {
    if (!flags.every((flag) => /^-[1aAlhFRtrS]+$/.test(flag)) || operands.length > 1) return null;
    return { kind: "tool", name: "list_files", input: { path: at(operands[0] ?? ".") }, note: via("list_files") };
  }
  if (program === "cat") {
    if (flags.some((flag) => flag !== "-n") || !operands.length || operands.length > 8) return null;
    return operands.length === 1
      ? { kind: "tool", name: "read_file", input: { path: at(operands[0]!) }, note: via("read_file") }
      : { kind: "tool", name: "read_files", input: { files: operands.map((path) => ({ path: at(path) })) }, note: via("read_files") };
  }
  if (program === "head") {
    let lines = 10, index = 0;
    const files: string[] = [];
    while (index < args.length) {
      const word = args[index]!;
      if (word === "-n" && /^\d+$/.test(args[index + 1] ?? "")) { lines = Number(args[index + 1]); index += 2; continue; }
      if (/^-n?\d+$/.test(word)) { lines = Number(word.replace(/^-n?/, "")); index++; continue; }
      if (word.startsWith("-")) return null;
      files.push(word); index++;
    }
    if (files.length !== 1 || lines < 1) return null;
    return { kind: "tool", name: "read_file", input: { path: at(files[0]!), offset: 1, limit: Math.min(500, lines) }, note: via("read_file") };
  }
  if (program === "sed") {
    // sed -n '10,40p' FILE or sed -n '12p' FILE
    if (args.length !== 3 || args[0] !== "-n") return null;
    const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1]!);
    if (!range) return null;
    const start = Number(range[1]), end = Number(range[2] ?? range[1]);
    if (start < 1 || end < start) return null;
    return { kind: "tool", name: "read_file", input: { path: at(args[2]!), offset: start, limit: Math.min(500, end - start + 1) }, note: via("read_file") };
  }
  if (program === "grep" || program === "rg") {
    let pattern: string | undefined, fixed = false, include: string | undefined;
    const paths: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const word = args[index]!;
      if (word === "-e" && pattern === undefined && args[index + 1] !== undefined) { pattern = args[++index]; continue; }
      if (word.startsWith("--include=")) { if (include) return null; include = word.slice("--include=".length); continue; }
      if (program === "rg" && (word === "-g" || word === "--glob") && args[index + 1] !== undefined) { if (include) return null; include = args[++index]; continue; }
      if (["-F", "--fixed-strings"].includes(word)) { fixed = true; continue; }
      if (["--recursive", "--line-number", "--ignore-case", "--with-filename"].includes(word)) continue;
      if (/^-[rRniIHF]+$/.test(word)) { if (word.includes("F")) fixed = true; continue; }
      if (word.startsWith("-")) return null;
      if (pattern === undefined) pattern = word; else paths.push(word);
    }
    // search_files is a literal, case-insensitive search: only equivalent
    // for plain text (a dot is common in names and kept).
    if (!pattern || paths.length > 1 || (!fixed && /[\\^$*+?()[\]{}|]/.test(pattern))) return null;
    return { kind: "tool", name: "search_files", input: { query: pattern, path: at(paths[0] ?? "."), ...(include ? { include } : {}) }, note: `${via("search_files")} It's literal and case-insensitive.` };
  }
  if (program === "find") {
    // find DIR -name PATTERN [-type f]
    const hasDir = args[0] !== undefined && !args[0].startsWith("-");
    const dir = hasDir ? args[0]! : ".", rest = hasDir ? args.slice(1) : args;
    let name: string | undefined;
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index]!;
      if ((word === "-name" || word === "-iname") && rest[index + 1] && !name) { name = rest[++index]; continue; }
      if (word === "-type" && rest[index + 1] === "f") { index++; continue; }
      return null;
    }
    if (!name || name.includes("/")) return null;
    return { kind: "tool", name: "list_files", input: { path: at(dir), pattern: `**/${name}` }, note: via("list_files with a pattern") };
  }
  if (program === "tail")
    return { kind: "pointer", message: "Not run: use read_file instead of tail. It reports the file's totalLines; pass offset to read from near the end." };
  if (program === "wc")
    return { kind: "pointer", message: "Not run: use read_file instead of wc. It reports totalLines for each file it reads (read_files for several)." };
  return null;
}
