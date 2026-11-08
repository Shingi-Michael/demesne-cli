import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitPattern } from "../src/background.ts";
import { canonicalWorkspace, ToolRegistry } from "../src/tools.ts";

const root = canonicalWorkspace(mkdtempSync(join(tmpdir(), "demesne-wait-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tools = new ToolRegistry();
const context = { workspaceRoot: root, signal: new AbortController().signal };
const start = async (script: string) => JSON.parse(await tools.get("run_command")!.execute({ argv: [process.execPath, "-e", script], background: true }, context)).handle as string;
const wait = async (input: Record<string, unknown>) => JSON.parse(await tools.get("wait_for")!.execute(input, context));

test("wait_for wakes on the line it waits for, even one already printed", async () => {
  const handle = await start("console.log('\\u001b[32m  ➜  Local:   http://localhost:5173/\\u001b[0m'); setTimeout(()=>{}, 5000)");
  const result = await wait({ handle, pattern: "ready|Local:", timeoutSeconds: 10 });
  expect(result.status).toBe("matched");
  expect(result.line).toBe("➜  Local:   http://localhost:5173/");
  expect(result.running).toBe(true);
  await tools.get("command_stop")!.execute({ handle }, context);
});

test("wait_for ends when the command exits first, with its last lines", async () => {
  const handle = await start("console.error('error: Cannot find module \"vite\"'); process.exit(1)");
  const result = await wait({ handle, pattern: "ready", timeoutSeconds: 10 });
  expect(result.status).toBe("exited");
  expect(result.exitCode).toBe(1);
  expect(result.tail).toContain("Cannot find module");
});

test("wait_for gives up at its time limit", async () => {
  const handle = await start("setTimeout(()=>{}, 5000)");
  const result = await wait({ handle, pattern: "never", timeoutSeconds: 1 });
  expect(result.status).toBe("timeout");
  expect(result.afterMs).toBeGreaterThanOrEqual(1000);
  await tools.get("command_stop")!.execute({ handle }, context);
});

test("wait_for without a pattern waits for the exit; unknown handles fail", async () => {
  const handle = await start("setTimeout(()=>console.log('3 pass'), 200)");
  expect((await wait({ handle })).status).toBe("exited");
  await expect(wait({ handle: "nope" })).rejects.toThrow("NOT_FOUND");
});

test("a pattern that isn't a valid regex is taken as plain words", () => {
  expect(waitPattern("ready (").test("Server READY (port 3000)")).toBe(true);
  expect(waitPattern("\\d+ pass").test("12 pass")).toBe(true);
});
