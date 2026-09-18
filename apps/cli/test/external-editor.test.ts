import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeInEditor, resolveEditor, type EditorSpawn } from "../src/external-editor.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-editor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("resolveEditor", () => {
  test("prefers VISUAL over EDITOR and defaults to vi", () => {
    expect(resolveEditor({ VISUAL: "code --wait", EDITOR: "nano" })).toEqual(["code", "--wait"]);
    expect(resolveEditor({ EDITOR: "nano" })).toEqual(["nano"]);
    expect(resolveEditor({})).toEqual(["vi"]);
    expect(resolveEditor({ EDITOR: "   " })).toEqual(["vi"]);
  });
});

describe("composeInEditor", () => {
  test("writes the draft, returns the edited text, and removes the temporary directory", async () => {
    const root = temporaryDirectory();
    let sawInitial = "";
    const spawn: EditorSpawn = (command) => {
      const path = command.at(-1)!;
      sawInitial = readFileSync(path, "utf8");
      writeFileSync(path, "edited by the user\n\n");
      return { exited: Promise.resolve(0) };
    };
    const result = await composeInEditor("original draft", { spawn, temporaryRoot: root, env: { EDITOR: "fake" } });
    expect(sawInitial).toBe("original draft");
    expect(result).toBe("edited by the user");
    expect(readdirSync(root)).toEqual([]);
  });

  test("keeps the original draft when the editor exits non-zero", async () => {
    const root = temporaryDirectory();
    const spawn: EditorSpawn = (command) => {
      writeFileSync(command.at(-1)!, "abandoned edit");
      return { exited: Promise.resolve(1) };
    };
    const result = await composeInEditor("keep me", { spawn, temporaryRoot: root, env: { EDITOR: "fake" } });
    expect(result).toBe("keep me");
    expect(readdirSync(root)).toEqual([]);
  });

  test("passes editor arguments before the file path", async () => {
    const root = temporaryDirectory();
    let received: string[] = [];
    const spawn: EditorSpawn = (command) => {
      received = command;
      return { exited: Promise.resolve(0) };
    };
    await composeInEditor("draft", {
      spawn,
      temporaryRoot: root,
      env: { VISUAL: "code --wait" },
    });
    expect(received[0]).toBe("code");
    expect(received[1]).toBe("--wait");
    expect(received[2]).toEndWith("PROMPT.md");
  });
});
