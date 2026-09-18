import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const mainPath = join(import.meta.dir, "../src/main.ts");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("daemon configuration", () => {
  test("requires capacity and output limits for configured providers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-main-test-"));
    temporaryDirectories.push(directory);
    const env: Record<string, string | undefined> = { ...process.env, DEMESNE_DATA_DIR: directory, DEMESNE_MODEL: "model" };
    delete env.DEMESNE_CONTEXT_WINDOW;
    delete env.DEMESNE_MAX_OUTPUT_TOKENS;
    delete env.DEMESNE_RUNTIME_PROFILE;
    const child = Bun.spawn([process.execPath, mainPath], { env, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("DEMESNE_CONTEXT_WINDOW is required");
  });
});
