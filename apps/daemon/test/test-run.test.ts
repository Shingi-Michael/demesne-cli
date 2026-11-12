import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunner, readResults, runTestsTool, testCommand } from "../src/test-run.ts";

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-run-tests-"));
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
};
const which = (name: string) => `/bin/${name}`;

test("finds the runner nearest the test file", () => {
  const root = project({ "bun.lock": "", "package.json": "{}", "web/package.json": JSON.stringify({ devDependencies: { vitest: "1" } }), "web/a.test.ts": "", "py/pytest.ini": "", "go/go.mod": "", "rs/Cargo.toml": "" });
  expect(findRunner(root, null)!.id).toBe("bun");
  expect(findRunner(root, join(root, "web/a.test.ts"))).toEqual({ id: "vitest", dir: join(root, "web") });
  expect(findRunner(root, join(root, "py"))!.id).toBe("pytest");
  expect(findRunner(root, join(root, "go"))!.id).toBe("go");
  expect(findRunner(root, join(root, "rs"))!.id).toBe("cargo");
  expect(findRunner(project({ "README.md": "" }), null)).toBeNull();
});

test("runs only the files and name asked for", () => {
  const dir = "/p";
  expect(testCommand({ id: "bun", dir }, ["/p/a.test.ts"], "adds", which)).toEqual(["/bin/bun", "test", "./a.test.ts", "-t", "adds"]);
  expect(testCommand({ id: "pytest", dir }, ["/p/tests/test_a.py"], "bad", which)).toEqual(["/bin/python", "-m", "pytest", "-q", "-rf", "--tb=short", "-p", "no:cacheprovider", "tests/test_a.py", "-k", "bad"]);
  expect(testCommand({ id: "go", dir }, ["/p/pkg/a_test.go"], "TestX", which)).toEqual(["/bin/go", "test", "-v", "./pkg", "-run", "TestX"]);
  expect(testCommand({ id: "go", dir }, [], null, which)).toEqual(["/bin/go", "test", "-v", "./..."]);
  expect(testCommand({ id: "cargo", dir }, [], "bad", which)).toEqual(["/bin/cargo", "test", "bad"]);
  expect(() => testCommand({ id: "jest", dir }, [], null, () => null)).toThrow(/isn't installed/);
});

test("reads counts and each failure from each runner's output", () => {
  const bun = readResults("bun", "a.test.ts:\n(pass) ok [0.1ms]\n1 | x\nerror: expect(received).toBe(expected)\nExpected: 5\nReceived: 4\n(fail) bad [0.2ms]\n\n 1 pass\n 1 fail\nRan 2 tests");
  expect(bun).toMatchObject({ passed: 1, failed: 1, failures: [{ name: "bad" }] });
  expect(bun.failures[0]!.message).toContain("Received: 4");
  expect(readResults("jest", "  ● bad\n\n    Expected: 5\n\nTests:       1 failed, 3 passed, 4 total")).toMatchObject({ passed: 3, failed: 1, failures: [{ name: "bad" }] });
  expect(readResults("vitest", " FAIL  a.test.js > bad\nAssertionError: no\n⎯⎯⎯⎯\n Tests  1 failed | 2 passed (3)")).toMatchObject({ passed: 2, failed: 1, failures: [{ name: "a.test.js > bad", message: "AssertionError: no" }] });
  expect(readResults("pytest", "=== FAILURES ===\n____ test_bad ____\nE   assert 4 == 5\n=== short test summary info ===\nFAILED test_a.py::test_bad\n1 failed, 2 passed in 0.1s")).toMatchObject({ passed: 2, failed: 1, failures: [{ name: "test_bad", message: "E   assert 4 == 5" }] });
  expect(readResults("go", "=== RUN   TestBad\n--- FAIL: TestBad (0.00s)\n    a_test.go:4: got 4 want 5\n--- PASS: TestOk (0.00s)\nFAIL")).toMatchObject({ passed: 1, failed: 1, failures: [{ name: "TestBad", message: "    a_test.go:4: got 4 want 5" }] });
  expect(readResults("cargo", "---- tests::bad stdout ----\npanicked: math is off\n\nfailures:\n    tests::bad\ntest result: FAILED. 1 passed; 1 failed; 0 ignored")).toMatchObject({ passed: 1, failed: 1, failures: [{ name: "tests::bad", message: "panicked: math is off" }] });
});

test("a real bun run hands back only the failure", async () => {
  const root = project({ "bun.lock": "", "package.json": "{}", "a.test.ts": 'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\ntest("bad", () => expect(2 + 2).toBe(5));\n' });
  const tool = runTestsTool({ which: () => process.execPath });
  expect(tool.permission({ files: ["a.test.ts"], name: "bad" })).toEqual({ kind: "execute", summary: "Run tests: a.test.ts matching “bad”" });
  const result = JSON.parse(await tool.execute({ files: ["a.test.ts"] }, { workspaceRoot: root, signal: new AbortController().signal }));
  expect(result).toMatchObject({ runner: "bun", ok: false, passed: 1, failed: 1, failures: [{ name: "bad" }] });
  expect(result.failures[0].message).toContain("Received: 4");
  expect(result.tail).toBeUndefined();
}, 30_000);

test("a run that can't be read gives its last lines", async () => {
  const root = project({ "go.mod": "" });
  const tool = runTestsTool({ which, spawn: async () => ({ exitCode: 2, output: "build failed\nx.go:3: undefined: y", timedOut: false }) });
  const result = JSON.parse(await tool.execute({}, { workspaceRoot: root, signal: new AbortController().signal }));
  expect(result).toMatchObject({ runner: "go", ok: false, failed: null, tail: "build failed\nx.go:3: undefined: y" });
});
