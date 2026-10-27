import { expect, test } from "bun:test";
import { chatChanges, chatServers, contextInUse } from "../cards";

test("Changes counts only the files this chat edited", () => {
  const files = [{ path: "hello.ts" }, { path: "notes.md" }, { path: "src/a.ts" }];
  expect(chatChanges(files, ["/work/app/hello.ts", "./src/a.ts"], "/work/app").map((file) => file.path)).toEqual(["hello.ts", "src/a.ts"]);
  expect(chatChanges(files, [], "/work/app")).toEqual([]);
  expect(chatChanges(files, ["gone.ts"], "/work/app")).toEqual([]);
});

test("Context shows from half full", () => {
  expect(contextInUse(null)).toBe(false);
  expect(contextInUse(49)).toBe(false);
  expect(contextInUse(50)).toBe(true);
});

test("Connectors shows only the servers this chat called", () => {
  const servers = [{ name: "github" }, { name: "linear" }];
  expect(chatServers(servers, ["read_files", "mcp__linear__list_issues"]).map((server) => server.name)).toEqual(["linear"]);
  expect(chatServers(servers, ["run_command"])).toEqual([]);
});
