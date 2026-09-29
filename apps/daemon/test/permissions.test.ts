import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker } from "../src/permissions.ts";
import { ConfigAllowlist } from "../src/allowlist.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-permissions-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PermissionBroker session grants", () => {
  test("allow_session stores a scoped rule that preapproves matching calls", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const waiter = broker.wait("p1", "turn", "session", "edit_file", JSON.stringify({ path: "src/util/a.ts" }), controller.signal);
    expect(broker.resolve("p1", "allow_session")).toBe(true);
    expect(await waiter).toBe("allow_session");

    expect(broker.preapproved("session", "edit_file", { path: "src/util/deep/b.ts" })).toBe(true);
    expect(broker.preapproved("session", "edit_file", { path: "src/util" })).toBe(true);
    expect(broker.preapproved("session", "edit_file", { path: "docs/x.md" })).toBe(false);
    expect(broker.preapproved("other-session", "edit_file", { path: "src/util/c.ts" })).toBe(false);
    expect(broker.listGrants("session")).toEqual([{ tool: "edit_file", pathPrefix: "src/util" }]);
  });

  test("host commands never receive persistent session grants", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const waiter = broker.wait("p2", "t", "s", "run_command", JSON.stringify({ argv: ["echo"] }), controller.signal);
    broker.resolve("p2", "allow_session");
    await waiter;

    expect(broker.preapproved("s", "run_command", { argv: ["git", "status"] })).toBe(false);
    expect(broker.listGrants("s")).toEqual([]);
    expect(broker.preapproved("s", "delete_path", { path: "x" })).toBe(false);
  });

  test("root-level files grant workspace-wide scope for that tool", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const waiter = broker.wait("p3", "t", "s", "write_file", JSON.stringify({ path: "README.md" }), controller.signal);
    broker.resolve("p3", "allow_session");
    await waiter;

    expect(broker.preapproved("s", "write_file", { path: "anything/here.txt" })).toBe(true);
  });

  test("move_path session grants do not preapprove an unapproved destination", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    // The user approves one move with "always this session". The grant must
    // cover both endpoints of that operation, nothing else.
    const waiter = broker.wait("pm1", "t", "s", "move_path", JSON.stringify({ from: "src/a.txt", to: "backup/a.txt" }), controller.signal);
    broker.resolve("pm1", "allow_session");
    await waiter;

    // Same source and destination directories as approved: preapproved.
    expect(broker.preapproved("s", "move_path", { from: "src/c.txt", to: "backup/c.txt", overwrite: true })).toBe(true);
    // Source covered but the destination directory was never approved: a
    // fresh approval is required (this was the over-grant bug).
    expect(broker.preapproved("s", "move_path", { from: "src/b.txt", to: "release/b.txt", overwrite: true })).toBe(false);
    // Destination covered but the source directory was never approved.
    expect(broker.preapproved("s", "move_path", { from: "other/b.txt", to: "backup/b.txt" })).toBe(false);
  });

  test("allow_once and deny never create grants", async () => {
    const broker = new PermissionBroker();
    const c1 = new AbortController();
    const w1 = broker.wait("a", "t", "s", "edit_file", "{}", c1.signal);
    broker.resolve("a", "allow_once");
    await w1;
    const c2 = new AbortController();
    const w2 = broker.wait("d", "t", "s", "edit_file", "{}", c2.signal);
    broker.resolve("d", "deny");
    await w2;
    expect(broker.listGrants("s")).toEqual([]);
  });
});

describe("PermissionBroker persisted allowlist", () => {
  test("preapproves matching calls from the user config", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "config.toml");
    writeFileSync(path, `
[permissions]
allow = ["edit_file:src", "run_command:git status"]
`);
    const broker = new PermissionBroker(new ConfigAllowlist(path));
    expect(broker.preapproved("session", "edit_file", { path: "src/a.ts" })).toBe(true);
    expect(broker.preapproved("session", "edit_file", { path: "docs/a.md" })).toBe(false);
    expect(broker.preapproved("session", "run_command", { argv: ["git", "status", "--short"] })).toBe(true);
    expect(broker.preapproved("session", "run_command", { argv: ["git", "push"] })).toBe(false);
  });

  test("picks up a rule saved while the daemon is running", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "config.toml");
    writeFileSync(path, `[permissions]\nallow = []\n`);
    const broker = new PermissionBroker(new ConfigAllowlist(path));
    expect(broker.preapproved("session", "edit_file", { path: "src/a.ts" })).toBe(false);

    writeFileSync(path, `[permissions]\nallow = ["edit_file:src"]\n`);
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);
    expect(broker.preapproved("session", "edit_file", { path: "src/a.ts" })).toBe(true);
  });

  test("allow_always also grants the session immediately", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const waiter = broker.wait("p", "t", "s", "edit_file", JSON.stringify({ path: "src/util/a.ts" }), controller.signal);
    broker.resolve("p", "allow_always");
    await waiter;
    expect(broker.preapproved("s", "edit_file", { path: "src/util/b.ts" })).toBe(true);
  });
});
