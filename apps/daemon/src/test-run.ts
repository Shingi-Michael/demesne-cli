import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isRecord } from "@demesne/protocol";
import { resolveWorkspacePath, toolError, type AgentTool } from "./tools.ts";

/// Run one test, or a few: run_tests finds how the project runs its tests
/// (bun, vitest, jest, pytest, go, cargo), runs only the files or names
/// asked for, and hands back the counts and each failure with its message,
/// not the whole log. A run that can't be read gives its last lines instead.

export type RunnerId = "bun" | "vitest" | "jest" | "pytest" | "go" | "cargo";
export interface Runner { id: RunnerId; dir: string }
export interface TestFailure { name: string; message: string }
export interface TestSummary { passed: number | null; failed: number | null; skipped: number | null; failures: TestFailure[] }

const MAX_FAILURES = 12;
const FAILURE_LINES = 30;
const FAILURE_CHARS = 2_400;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const TAIL_LINES = 60;

const packageJson = (dir: string): Record<string, unknown> | null => {
  try { const value = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown; return isRecord(value) ? value : null; } catch { return null; }
};
const has = (dir: string, ...names: string[]) => names.some((name) => existsSync(join(dir, name)));

/// The runner one folder sets up, or null.
function runnerIn(dir: string): RunnerId | null {
  const pkg = packageJson(dir);
  if (pkg) {
    const deps = { ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}), ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}) };
    const script = isRecord(pkg.scripts) && typeof pkg.scripts.test === "string" ? pkg.scripts.test : "";
    if (/\bvitest\b/.test(script) || "vitest" in deps) return "vitest";
    if (/\bjest\b/.test(script) || "jest" in deps) return "jest";
    if (/\bbun test\b/.test(script) || has(dir, "bun.lock", "bun.lockb", "bunfig.toml")) return "bun";
  }
  if (has(dir, "bun.lock", "bun.lockb", "bunfig.toml")) return "bun";
  if (has(dir, "pytest.ini", "conftest.py", "tox.ini") || (has(dir, "pyproject.toml", "setup.cfg") && /pytest/.test(["pyproject.toml", "setup.cfg"].map((name) => { try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; } }).join("\n")))) return "pytest";
  if (has(dir, "go.mod")) return "go";
  if (has(dir, "Cargo.toml")) return "cargo";
  return null;
}

/// The nearest runner from the first test file up to the project root.
export function findRunner(root: string, first: string | null): Runner | null {
  let dir = first ? (existsSync(first) && statSync(first).isDirectory() ? first : dirname(first)) : root;
  for (;;) {
    const id = runnerIn(dir);
    if (id) return { id, dir };
    if (dir === root || !dir.startsWith(root)) break;
    dir = dirname(dir);
  }
  // A Python project with only a tests folder still runs on pytest.
  if (has(root, "pyproject.toml", "setup.py", "requirements.txt")) return { id: "pytest", dir: root };
  return null;
}

/// A program on the daemon's PATH or where these tools install themselves.
function program(name: string, dir: string): string | null {
  const local = [join(dir, "node_modules", ".bin", name), join(dir, ".venv", "bin", name), join(dir, "venv", "bin", name)].find((path) => existsSync(path));
  if (local) return local;
  const found = Bun.which(name);
  if (found) return found;
  const home = homedir();
  return [join(home, ".bun", "bin", name), join(home, ".cargo", "bin", name), join("/usr/local/go/bin", name), join(home, "go", "bin", name), join("/opt/homebrew/bin", name), join("/usr/local/bin", name), join(home, ".local", "bin", name)].find((path) => existsSync(path)) ?? null;
}

/// The command for these files and this name filter.
export function testCommand(runner: Runner, files: string[], name: string | null, which: (name: string, dir: string) => string | null = program): string[] {
  const at = (path: string) => relative(runner.dir, path) || ".";
  const need = (bin: string) => { const path = which(bin, runner.dir); if (!path) throw toolError("RUNNER_MISSING", `${bin} isn't installed where Demesne can find it`, "run the tests with run_command instead"); return path; };
  switch (runner.id) {
    case "bun": return [need("bun"), "test", ...files.map((file) => `./${at(file)}`), ...(name ? ["-t", name] : [])];
    case "vitest": return [need("vitest"), "run", ...files.map(at), ...(name ? ["-t", name] : [])];
    case "jest": return [need("jest"), "--ci", ...files.map(at), ...(name ? ["-t", name] : [])];
    case "pytest": {
      const python = which("python", runner.dir) ?? which("python3", runner.dir);
      if (!python) throw toolError("RUNNER_MISSING", "python isn't installed where Demesne can find it", "run the tests with run_command instead");
      return [python, "-m", "pytest", "-q", "-rf", "--tb=short", "-p", "no:cacheprovider", ...files.map(at), ...(name ? ["-k", name] : [])];
    }
    case "go": {
      const packages = [...new Set(files.map((file) => { const dir = file.endsWith(".go") ? dirname(file) : file; return `./${relative(runner.dir, dir) || "."}`.replace(/^\.\/\.$/, "."); }))];
      return [need("go"), "test", "-v", ...(packages.length ? packages.map((pkg) => pkg === "." ? "./" : pkg) : ["./..."]), ...(name ? ["-run", name] : [])];
    }
    case "cargo": return [need("cargo"), "test", ...(name ? [name] : [])];
  }
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const count = (text: string, pattern: RegExp) => { const match = pattern.exec(text); return match ? Number(match[1]) : null; };
const cut = (lines: string[]) => {
  const kept = lines.slice(0, FAILURE_LINES).join("\n").replace(/^\n+|\s+$/g, "");
  return (kept.length > FAILURE_CHARS ? `${kept.slice(0, FAILURE_CHARS)}…` : kept) + (lines.length > FAILURE_LINES ? "\n…" : "");
};

/// Counts and failures from a run's output, as far as it can be read.
export function readResults(id: RunnerId, raw: string): TestSummary {
  const text = strip(raw), lines = text.split("\n");
  const failures: TestFailure[] = [];
  if (id === "bun") {
    // Bun prints a failure's error just above its "(fail) name" line.
    let start = 0;
    lines.forEach((line, index) => {
      const fail = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line.trim());
      if (/^\((pass|skip|todo)\)|^\S.*\.(test|spec)\.[cm]?[jt]sx?:$/.test(line.trim())) start = index + 1;
      if (fail) { failures.push({ name: fail[1]!, message: cut(lines.slice(start, index).filter((one) => one.trim())) }); start = index + 1; }
    });
    return { passed: count(text, /^\s*(\d+) pass$/m), failed: count(text, /^\s*(\d+) fail$/m), skipped: count(text, /^\s*(\d+) skip$/m), failures };
  }
  if (id === "jest" || id === "vitest") {
    const head = id === "jest" ? /^\s*● (.+)$/ : /^\s*(?:FAIL|×)\s+(.+?\s>\s.+)$/;
    let current: { name: string; body: string[] } | null = null;
    const close = () => { if (current && !failures.some((one) => one.name === current!.name)) failures.push({ name: current.name, message: cut(current.body) }); current = null; };
    for (const line of lines) {
      const match = head.exec(line);
      if (match) { close(); current = { name: match[1]!.trim(), body: [] }; continue; }
      if (current && (/^\s*(Test Suites|Tests|Test Files):/.test(line) || /^\s*⎯{3,}/.test(line))) { close(); continue; }
      current?.body.push(line);
    }
    close();
    const tests = id === "jest" ? /^Tests:\s+(.+)$/m.exec(text)?.[1] ?? "" : /^\s*Tests\s+(.+)$/m.exec(text)?.[1] ?? "";
    return { passed: count(tests, /(\d+) passed/), failed: count(tests, /(\d+) failed/), skipped: count(tests, /(\d+) skipped/), failures };
  }
  if (id === "pytest") {
    let current: { name: string; body: string[] } | null = null;
    for (const line of lines) {
      const section = /^_{3,} (.+?) _{3,}$/.exec(line);
      if (section) { if (current) failures.push({ name: current.name, message: cut(current.body) }); current = { name: section[1]!, body: [] }; continue; }
      if (current && /^={3,}/.test(line)) { failures.push({ name: current.name, message: cut(current.body) }); current = null; continue; }
      current?.body.push(line);
    }
    if (!failures.length) for (const line of lines) { const match = /^FAILED (\S+)(?: - (.*))?$/.exec(line); if (match) failures.push({ name: match[1]!, message: match[2] ?? "" }); }
    const summary = lines.filter((line) => /\d+ (passed|failed)|no tests ran/.test(line)).at(-1) ?? "";
    const read = (pattern: RegExp) => summary ? count(summary, pattern) ?? 0 : null;
    return { passed: read(/(\d+) passed/), failed: read(/(\d+) failed/), skipped: read(/(\d+) skipped/), failures };
  }
  if (id === "go") {
    lines.forEach((line, index) => {
      const fail = /^\s*--- FAIL: (\S+)/.exec(line);
      if (!fail) return;
      // With -v, what the test logged sits between its "=== RUN" line and this one.
      const ran = lines.findLastIndex((one, at) => at < index && one.trim() === `=== RUN   ${fail[1]}`);
      const body: string[] = ran >= 0 ? lines.slice(ran + 1, index).filter((one) => !/^=== (RUN|PAUSE|CONT)/.test(one.trim())) : [];
      for (let next = index + 1; next < lines.length && /^\s{4,}/.test(lines[next]!) && !/--- (FAIL|PASS)/.test(lines[next]!); next++) body.push(lines[next]!);
      failures.push({ name: fail[1]!, message: cut(body) });
    });
    return { passed: lines.filter((line) => /^\s*--- PASS:/.test(line)).length || null, failed: failures.length || (/^(ok|PASS)\b/m.test(text) ? 0 : null), skipped: lines.filter((line) => /^\s*--- SKIP:/.test(line)).length || null, failures };
  }
  // cargo
  let current: { name: string; body: string[] } | null = null;
  for (const line of lines) {
    const block = /^---- (\S+) stdout ----$/.exec(line);
    if (block) { if (current) failures.push({ name: current.name, message: cut(current.body) }); current = { name: block[1]!, body: [] }; continue; }
    if (current && (/^failures:$/.test(line) || /^test result:/.test(line))) { failures.push({ name: current.name, message: cut(current.body) }); current = null; continue; }
    current?.body.push(line);
  }
  const results = lines.filter((line) => /^test result:/.test(line));
  const sum = (pattern: RegExp) => results.length ? results.reduce((total, line) => total + (count(line, pattern) ?? 0), 0) : null;
  return { passed: sum(/(\d+) passed/), failed: sum(/(\d+) failed/), skipped: sum(/(\d+) ignored/), failures };
}

export type TestSpawn = (argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal) => Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

const spawnTests: TestSpawn = async (argv, cwd, timeoutMs, signal) => {
  const home = join(tmpdir(), `demesne-tool-${process.pid}`);
  const child = Bun.spawn(argv, {
    cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: [dirname(argv[0]!), "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"].join(":"),
      // Go and Cargo keep their module caches under the real home.
      HOME: homedir(), TMPDIR: existsSync(home) ? home : tmpdir(), LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", CI: "1", PAGER: "cat", GIT_TERMINAL_PROMPT: "0",
    },
  });
  let timedOut = false;
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 2_000).unref?.(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  const read = async (stream: ReadableStream<Uint8Array>) => {
    let text = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) { text += new TextDecoder().decode(chunk); if (text.length > OUTPUT_LIMIT) text = text.slice(-OUTPUT_LIMIT); }
    return text;
  };
  try {
    const [out, err, exitCode] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    return { exitCode, output: `${out}\n${err}`, timedOut };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
};

export interface TestToolOptions { spawn?: TestSpawn; which?: (name: string, dir: string) => string | null }

export function runTestsTool(options: TestToolOptions = {}): AgentTool {
  const spawn = options.spawn ?? spawnTests;
  const read = (input: unknown) => {
    const value = isRecord(input) ? input : {};
    const files = Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === "string" && Boolean(file.trim())) : [];
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
    return { files, name, timeoutMs: typeof value.timeoutMs === "number" ? Math.min(600_000, Math.max(5_000, Math.round(value.timeoutMs))) : 180_000 };
  };
  return {
    definition: {
      name: "run_tests",
      description: "Run some of the project's tests and get back only the counts and each failure with its message, not the whole log. Finds the runner itself (bun, vitest, jest, pytest, go test, cargo test). Pass the test files you changed or care about, and/or a test name to match; with neither it runs the whole suite. Prefer this over run_command for tests.",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, maxItems: 20, description: "Test files or folders, relative to the project" },
          name: { type: "string", maxLength: 200, description: "Only tests whose name matches (bun/vitest/jest -t, pytest -k, go -run, cargo filter)" },
          timeoutMs: { type: "integer", minimum: 5000, maximum: 600000 },
        },
        additionalProperties: false,
      },
    },
    permission(input) {
      const { files, name } = read(input);
      return { kind: "execute", summary: `Run tests: ${files.length ? files.join(", ") : "the whole suite"}${name ? ` matching “${name}”` : ""}`.slice(0, 200) };
    },
    async execute(input, context) {
      const { files, name, timeoutMs } = read(input);
      const root = resolve(context.workspaceRoot);
      const paths = files.map((file) => resolveWorkspacePath(root, file, false));
      const runner = findRunner(root, paths[0] ?? null);
      if (!runner) throw toolError("NO_RUNNER", "couldn't tell how this project runs its tests", "run them with run_command");
      const argv = testCommand(runner, paths, name, options.which);
      const observer = context.commands?.begin(argv, runner.dir, false);
      let result: Awaited<ReturnType<TestSpawn>>;
      try { result = await spawn(argv, runner.dir, timeoutMs, context.signal); }
      catch (error) { observer?.finished(null, false, String(error)); throw error; }
      observer?.finished(result.exitCode, result.timedOut);
      if (context.signal.aborted) throw context.signal.reason;
      const summary = readResults(runner.id, result.output);
      const shown = summary.failures.slice(0, MAX_FAILURES);
      const unread = result.exitCode !== 0 && !summary.failures.length;
      const command = [argv[0]!.split("/").at(-1)!, ...argv.slice(1)].join(" ");
      return JSON.stringify({
        runner: runner.id, command, ...(runner.dir !== root ? { cwd: relative(root, runner.dir) } : {}),
        ok: result.exitCode === 0 && !result.timedOut, exitCode: result.exitCode, ...(result.timedOut ? { timedOut: true } : {}),
        passed: summary.passed, failed: summary.failed ?? (unread ? null : summary.failures.length), skipped: summary.skipped,
        ...(shown.length ? { failures: shown } : {}),
        ...(summary.failures.length > shown.length ? { moreFailures: summary.failures.length - shown.length } : {}),
        // Nothing to read (a crash before any test, a compile error): its last lines.
        ...(unread || result.timedOut ? { tail: strip(result.output).trimEnd().split("\n").slice(-TAIL_LINES).join("\n") } : {}),
      });
    },
  };
}
