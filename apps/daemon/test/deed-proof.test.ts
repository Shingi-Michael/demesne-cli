import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureDetail, readCounts, runTests, testCommand } from "../src/deed-proof.ts";

test("finds the project's own test runner", () => {
  const root = mkdtempSync(join(tmpdir(), "proof-"));
  expect(testCommand(root, [])).toBeNull();
  expect(testCommand(root, ["a_test.py"])).toEqual(["python3", "-m", "pytest", "-q", "a_test.py"]);
  expect(testCommand(root, ["pkg/a_test.go"])).toEqual(["go", "test", "./pkg"]);
  expect(testCommand(root, ["a.test.ts"])).toBeNull();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  expect(testCommand(root, ["a.test.ts"])).toEqual(["npx", "vitest", "run", "a.test.ts"]);
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "bun.lock"), "");
  expect(testCommand(root, ["a.test.ts"])).toEqual(["bun", "test", "./a.test.ts"]);
});

test("reads passed and failed from runner summaries", () => {
  expect(readCounts(" 14 pass\n 0 fail\n")).toEqual({ passed: 14, failed: 0 });
  expect(readCounts("==== 3 passed, 1 failed in 0.2s ====")).toEqual({ passed: 3, failed: 1 });
  expect(readCounts("Tests:       1 failed, 9 passed, 10 total")).toEqual({ passed: 9, failed: 1 });
  expect(readCounts("nothing here")).toBeNull();
  expect(failureDetail("ok\n(fail) waits 20 minutes [2ms]\n 1 fail")).toBe("“waits 20 minutes” fails");
  expect(failureDetail("error: expect(received).toBeLessThan(expected)\n\nExpected: < 30\nReceived: 30\n\n(fail) waits under half an hour [0.21ms]\n(fail) other [1ms]")).toBe("“waits under half an hour” fails: Expected: < 30, Received: 30, and 1 more");
});

test("runs real tests and says what failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "proof-"));
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "good.test.ts"), 'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\ntest("again", () => expect(2).toBe(2));\n');
  writeFileSync(join(root, "bad.test.ts"), 'import { test, expect } from "bun:test";\ntest("waits twenty", () => expect(10).toBe(20));\n');
  expect(await runTests(root, ["good.test.ts"], new AbortController().signal)).toMatchObject({ ok: true, passed: 2, failed: 0 });
  const bad = await runTests(root, ["bad.test.ts"], new AbortController().signal);
  expect(bad).toMatchObject({ ok: false, failed: 1 });
  expect(bad.detail).toContain("waits twenty");
}, 30_000);
