import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLASH_COMMANDS } from "@demesne/brand";
import { expandCustomCommand, loadCustomCommands, mergeSlashCommands } from "../src/custom-commands.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-commands-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadCustomCommands", () => {
  test("parses frontmatter descriptions and command bodies", () => {
    const home = temporaryDirectory();
    const commands = join(home, ".demesne", "commands");
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(commands, "review.md"), "---\ndescription: Review the working tree\n---\nReview $ARGUMENTS carefully.\n");
    writeFileSync(join(commands, "explain.md"), "Explain the last change.\n");

    const loaded = loadCustomCommands(undefined, home);
    expect(loaded.map((entry) => entry.command.name)).toEqual(["/explain", "/review"]);
    expect(loaded[1]!.command.description).toBe("Review the working tree");
    expect(loaded[1]!.body).toBe("Review $ARGUMENTS carefully.");
    expect(loaded[0]!.command.description).toBe("Custom command");
  });

  test("lets the project override a user command and ignores invalid names", () => {
    const home = temporaryDirectory();
    const workspace = temporaryDirectory();
    mkdirSync(join(home, ".demesne", "commands"), { recursive: true });
    writeFileSync(join(home, ".demesne", "commands", "deploy.md"), "user deploy\n");
    mkdirSync(join(workspace, ".demesne", "commands"), { recursive: true });
    writeFileSync(join(workspace, ".demesne", "commands", "deploy.md"), "project deploy\n");
    writeFileSync(join(workspace, ".demesne", "commands", "Bad Name.md"), "ignored\n");
    writeFileSync(join(workspace, ".demesne", "commands", "notes.txt"), "ignored\n");

    const loaded = loadCustomCommands(workspace, home);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.body).toBe("project deploy");
  });

  test("skips empty files and missing directories", () => {
    const home = temporaryDirectory();
    expect(loadCustomCommands(undefined, home)).toEqual([]);
    mkdirSync(join(home, ".demesne", "commands"), { recursive: true });
    writeFileSync(join(home, ".demesne", "commands", "empty.md"), "---\ndescription: x\n---\n\n");
    expect(loadCustomCommands(undefined, home)).toEqual([]);
  });
});

describe("mergeSlashCommands", () => {
  test("keeps built-ins first and drops shadowing names", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".demesne", "commands"), { recursive: true });
    writeFileSync(join(home, ".demesne", "commands", "status.md"), "shadow\n");
    writeFileSync(join(home, ".demesne", "commands", "review.md"), "review\n");

    const merged = mergeSlashCommands(SLASH_COMMANDS, loadCustomCommands(undefined, home));
    expect(merged[0]).toBe(SLASH_COMMANDS[0]);
    expect(merged.filter((command) => command.name === "/status")).toHaveLength(1);
    expect(merged.some((command) => command.name === "/review")).toBe(true);
  });
});

describe("expandCustomCommand", () => {
  function custom(body: string) {
    return {
      command: {
        id: "custom:review" as const,
        name: "/review" as const,
        aliases: [],
        argument: "optional" as const,
        description: "Review",
        section: "session" as const,
      },
      body,
      source: "/commands/review.md",
    };
  }

  test("substitutes $ARGUMENTS", () => {
    expect(expandCustomCommand(custom("Review $ARGUMENTS now."), "src/a.ts")).toBe("Review src/a.ts now.");
    expect(expandCustomCommand(custom("Review $ARGUMENTS now."), "")).toBe("Review  now.");
  });

  test("appends the argument when no placeholder exists", () => {
    expect(expandCustomCommand(custom("Explain the change."), "src/a.ts")).toBe("Explain the change.\n\nsrc/a.ts");
    expect(expandCustomCommand(custom("Explain the change."), "")).toBe("Explain the change.");
  });
});
