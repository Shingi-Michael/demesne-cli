import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/// Proving a Deed sentence: running the test files that hold it with the
/// project's own runner, and reading how many passed.

export interface ProofResult { ok: boolean; passed: number; failed: number; ms: number; detail?: string }

/// The command that runs these test files here, or null when no runner is known.
export function testCommand(root: string, files: string[]): string[] | null {
  if (!files.length) return null;
  if (files.every((file) => file.endsWith(".py"))) return ["python3", "-m", "pytest", "-q", ...files];
  if (files.every((file) => file.endsWith("_test.go"))) return ["go", "test", ...[...new Set(files.map((file) => `./${dirname(file)}`))]];
  if (files.every((file) => file.endsWith(".rs")) && existsSync(join(root, "Cargo.toml"))) return ["cargo", "test"];
  let scripts: Record<string, string> = {};
  try { scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { /* no package.json */ }
  const test = scripts.test ?? "";
  if (/\bvitest\b/.test(test)) return ["npx", "vitest", "run", ...files];
  if (/\bjest\b/.test(test)) return ["npx", "jest", ...files];
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) || /\bbun test\b/.test(test)) return ["bun", "test", ...files.map((file) => `./${file}`)];
  if (existsSync(join(root, "package.json"))) return ["node", "--test", ...files];
  return null;
}

/// Passed and failed counts from the common runners' summaries.
export function readCounts(output: string): { passed: number; failed: number } | null {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const pick = (patterns: RegExp[]) => {
    for (const pattern of patterns) { const match = pattern.exec(plain); if (match) return Number(match[1]); }
    return null;
  };
  const passed = pick([/^\s*(\d+) pass\b/m, /Tests:?\s+(?:\d+ failed, )?(\d+) passed/, /(\d+) passed/, /^# pass (\d+)/m, /ok\s+.*\((\d+) tests?\)/]);
  const failed = pick([/^\s*(\d+) fail\b/m, /Tests:?\s+(\d+) failed/, /(\d+) failed/, /^# fail (\d+)/m]);
  return passed === null && failed === null ? null : { passed: passed ?? 0, failed: failed ?? 0 };
}

/// The lines that say what failed, kept short: the failing test's name and
/// what it expected, without the runner's markers and timings.
export function failureDetail(output: string): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const names = lines.filter((line) => /^(\(fail\)|✗|✕|×|FAIL\b|FAILED\b|not ok\b)/.test(line))
    .map((line) => line.replace(/^(\(fail\)|✗|✕|×|FAIL|FAILED|not ok( \d+)?( -)?)\s*/, "").replace(/\s*\[[\d.]+\s*m?s\]$/, "").replace(/\s*\([\d.]+\s*m?s\)$/, ""));
  const expects = lines.filter((line) => /^(Expected|Received)\b/.test(line)).slice(0, 2);
  const named = names.length ? `“${names[0]}” fails${expects.length ? `: ${expects.join(", ")}` : ""}${names.length > 1 ? `, and ${names.length - 1} more` : ""}` : "";
  const text = named || lines.filter((line) => /AssertionError|Error:/.test(line)).slice(0, 2).join(" · ") || lines.slice(-3).join(" · ");
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/// Runs the files' tests; a run past `timeout` is stopped and counts as failed.
export function runTests(root: string, files: string[], signal: AbortSignal, timeout = 180_000): Promise<ProofResult> {
  const command = testCommand(root, files);
  if (!command) return Promise.resolve({ ok: false, passed: 0, failed: 0, ms: 0, detail: "No test runner found for these files." });
  const started = Date.now();
  return (async () => {
    let child: ReturnType<typeof Bun.spawn>;
    try { child = Bun.spawn(command, { cwd: root, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
    catch (error) { return { ok: false, passed: 0, failed: 0, ms: 0, detail: `Couldn't run ${command[0]}: ${error instanceof Error ? error.message : String(error)}` }; }
    let timedOut = false;
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
      const output = (out + "\n" + err).slice(-200_000), counts = readCounts(output), ms = Date.now() - started;
      const ok = code === 0 && (counts?.failed ?? 0) === 0;
      const detail = ok ? undefined : signal.aborted ? "Stopped." : timedOut ? "The tests took too long." : failureDetail(output) || `The tests exited with ${code}.`;
      return { ok, passed: counts?.passed ?? (ok ? files.length : 0), failed: counts?.failed ?? (ok ? 0 : 1), ms, detail };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  })();
}
