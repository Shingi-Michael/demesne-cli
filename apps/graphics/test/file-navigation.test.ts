import { expect, test } from "bun:test";
import {
  writeFileSync,
  mkdirSync,
  unlinkSync,
  symlinkSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  SourceDocument,
  sourceLocations,
  workspacePath,
} from "../file-navigation.ts";
import { fixture } from "./fixture.ts";
import { GraphicsHost } from "../host.ts";
import { expandMentions, draftMentions } from "../../cli/src/prompt-editor.ts";

test("source locations recognize compiler/stack formats and resolve only known workspace files", () => {
  const files = new Set(["src/a.ts", "src/a b.py"]),
    root = "/work/repo";
  const text =
    'src/a.ts(12,7): error\n at fn (/work/repo/src/a.ts:9:2)\nFile "src/a b.py", line 5\n"src/a b.py":6:2\nfile:///work/repo/src/a.ts:8:1\nhttps://evil/src/a.ts:2:3\n/work/other/src/a.ts:7\n../outside.ts:3\nmissing.ts:1';
  const locations = sourceLocations(text, files, root);
  expect(
    locations.map(({ path, line, column }) => ({ path, line, column })),
  ).toEqual([
    { path: "src/a.ts", line: 12, column: 7 },
    { path: "src/a.ts", line: 9, column: 2 },
    { path: "src/a b.py", line: 5, column: undefined },
    { path: "src/a b.py", line: 6, column: 2 },
    { path: "src/a.ts", line: 8, column: 1 },
  ]);
  expect(
    sourceLocations("a.ts:7:3", files, root, "/work/repo/src")[0]?.path,
  ).toBe("src/a.ts");
  expect(workspacePath("../src/a.ts", root, "tests")).toBe("src/a.ts");
  expect(workspacePath("../../repo-other/a.ts", root)).toBeNull();
  expect(workspacePath("file://remote/work/repo/src/a.ts", root)).toBeNull();
  expect(sourceLocations("src/a.ts:0:2", files, root)).toEqual([]);
});

test("literal search, line clamping and fenced attachments preserve selected source", () => {
  const source = new SourceDocument(
    'first\r\nconst x = "<script>";\n```\nLAST last\n',
  );
  expect(source.search("last")).toEqual([
    { line: 4, column: 1 },
    { line: 4, column: 6 },
  ]);
  expect(source.search("[.*")).toEqual([]);
  expect(source.clamp(999)).toBe(5);
  expect(source.snippet("src/a.ts", 4, 2)).toBe(
    'Source: src/a.ts:2-4\n````\nconst x = "<script>";\n```\nLAST last\n````',
  );
  expect(new SourceDocument("a".repeat(64001)).search("a", 20)).toHaveLength(
    20,
  );
  expect(() =>
    new SourceDocument("a".repeat(64001)).snippet("big", 1, 1),
  ).toThrow("smaller range");
});

test("submission preserves mention-like source inside attachments while expanding real mentions", () => {
  const snippet = new SourceDocument("// @other.ts\n```\n@other.ts").snippet(
    "src/a.ts",
    1,
    3,
  );
  const draft = `Look at @other.ts\n\n${snippet}\nAnd @other.ts`;
  const files = ["src/other.ts"];
  expect(draftMentions(draft, files)).toHaveLength(2);
  expect(expandMentions(draft, files)).toBe(
    `Look at @src/other.ts\n\n${snippet}\nAnd @src/other.ts`,
  );
  expect(expandMentions("~~~\n@other.ts", files)).toBe("~~~\n@other.ts");
  expect(sourceLocations("x".repeat(64000), new Set(files), "/work")).toEqual(
    [],
  );
});

test("file status detects same-size external edits, removal and replacement without transmitting content", async () => {
  const f = await fixture();
  const host = new GraphicsHost({
    workspace: f.workspace,
    settings: f.settings,
    client: f.client,
    changed: () => {},
  });
  try {
    mkdirSync(join(f.workspace, "src"));
    const path = join(f.workspace, "src/a.ts");
    writeFileSync(path, "original");
    await host.connect();
    const sessionId = host.current!.session.id;
    const original = await f.client.readWorkspaceFile(sessionId, "src/a.ts");
    expect(original.revision).toMatch(/^[a-f0-9]{64}$/);
    const status = (await host.handle("file-status", {
      sessionId,
      path: "src/a.ts",
    })) as any;
    expect(status.content).toBeUndefined();
    expect(status.revision).toBe(original.revision);
    const stat = statSync(path);
    writeFileSync(path, "modified");
    utimesSync(path, stat.atime, stat.mtime);
    expect(
      (await f.client.workspaceFileStatus(sessionId, "src/a.ts")).revision,
    ).not.toBe(original.revision);
    unlinkSync(path);
    expect(
      (await f.client.workspaceFileStatus(sessionId, "src/a.ts")).reason,
    ).toContain("not exist");
    symlinkSync(join(f.workspace, "README.md"), path);
    expect(
      (await f.client.workspaceFileStatus(sessionId, "src/a.ts")).revision,
    ).toBeUndefined();
    writeFileSync(join(f.workspace, ".env"), "SECRET=not transmitted");
    expect(
      (await f.client.workspaceFileStatus(sessionId, ".env")).reason,
    ).toContain("protected");
    expect(
      (
        await f.client.workspaceFileStatus(
          sessionId,
          "../home/.demesne/config.toml",
        )
      ).reason,
    ).toContain("traversal");
    await expect(
      host.handle("file-status", { sessionId: "wrong", path: "README.md" }),
    ).rejects.toThrow("session changed");
  } finally {
    host.dispose();
    await f.close();
  }
});
