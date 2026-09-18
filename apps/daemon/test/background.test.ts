import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorkspace, ToolRegistry } from "../src/tools.ts";

const temporaryDirectories: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "demesne-bg-test-"));
  temporaryDirectories.push(root);
  return canonicalWorkspace(root);
}

describe("background run_command", () => {
  test("runs in background and streams logs until exit", async () => {
    const root = workspace();
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const launched = JSON.parse(await tools.get("run_command")!.execute({
      argv: ["/bin/sh", "-c", "printf abc; sleep 0.2; printf def"],
      background: true,
    }, context));
    expect(launched.running).toBe(true);
    expect(typeof launched.handle).toBe("string");

    let logs: any;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(60);
      logs = JSON.parse(await tools.get("command_logs")!.execute({
        handle: launched.handle,
        outOffset: 0,
        errOffset: 0,
      }, context));
      if (!logs.running) break;
    }
    expect(logs.running).toBe(false);
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout).toBe("abcdef");
    expect(logs.outOffset).toBe(6);
  });

  test("stop terminates a running process", async () => {
    const root = workspace();
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const launched = JSON.parse(await tools.get("run_command")!.execute({
      argv: ["/bin/sleep", "30"],
      background: true,
    }, context));

    await Bun.sleep(100);
    const stopped = JSON.parse(await tools.get("command_stop")!.execute({ handle: launched.handle }, context));
    expect(stopped.stopped).toBe(true);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(100);
      const logs = JSON.parse(await tools.get("command_logs")!.execute({ handle: launched.handle }, context));
      if (!logs.running) {
        expect(logs.running).toBe(false);
        break;
      }
    }
  });

  test("stop terminates background descendants", async () => {
    const root = workspace();
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const pidFile = join(root, "child.pid");
    const launched = JSON.parse(await tools.get("run_command")!.execute({
      argv: ["/bin/sh", "-c", `sleep 30 & child=$!; printf %s "$child" > ${JSON.stringify(pidFile)}; wait`],
      background: true,
    }, context));
    for (let attempt = 0; attempt < 20 && !existsSync(pidFile); attempt += 1) await Bun.sleep(25);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(processExists(childPid)).toBe(true);

    await tools.get("command_stop")!.execute({ handle: launched.handle }, context);
    for (let attempt = 0; attempt < 40 && processExists(childPid); attempt += 1) await Bun.sleep(50);
    expect(processExists(childPid)).toBe(false);
  });

  test("enforces the process cap and rejects unknown handles", async () => {
    const root = workspace();
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    await expect(tools.get("command_logs")!.execute({ handle: "nope" }, context)).rejects.toThrow("NOT_FOUND");

    const handles: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const launched = JSON.parse(await tools.get("run_command")!.execute({
        argv: ["/bin/sleep", "5"],
        background: true,
      }, context));
      handles.push(launched.handle);
    }
    await expect(tools.get("run_command")!.execute({ argv: ["/bin/true"], background: true }, context))
      .rejects.toThrow("TOO_MANY_BACKGROUND");

    for (const handle of handles) await tools.get("command_stop")!.execute({ handle }, context);
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
