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

  test("a command allowed for the session covers only that exact argv in that directory", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const waiter = broker.wait("p2", "t", "s", "run_command", JSON.stringify({ argv: ["bun", "test", "apps/x.test.ts"], cwd: "./" }), controller.signal);
    broker.resolve("p2", "allow_session");
    await waiter;

    // The same command, however the directory is spelled, and with a different timeout.
    expect(broker.preapproved("s", "run_command", { argv: ["bun", "test", "apps/x.test.ts"] })).toBe(true);
    expect(broker.preapproved("s", "run_command", { argv: ["bun", "test", "apps/x.test.ts"], cwd: ".", timeoutMs: 5000 })).toBe(true);
    // Never a longer, shorter or different command, another directory, or another session.
    expect(broker.preapproved("s", "run_command", { argv: ["bun", "test", "apps/x.test.ts", "--update-snapshots"] })).toBe(false);
    expect(broker.preapproved("s", "run_command", { argv: ["bun", "test"] })).toBe(false);
    expect(broker.preapproved("s", "run_command", { argv: ["bun", "test", "apps/y.test.ts"] })).toBe(false);
    expect(broker.preapproved("s", "run_command", { argv: ["bun", "test", "apps/x.test.ts"], cwd: "apps" })).toBe(false);
    expect(broker.preapproved("other", "run_command", { argv: ["bun", "test", "apps/x.test.ts"] })).toBe(false);
    expect(broker.preapproved("s", "run_command", { argv: "bun test apps/x.test.ts" })).toBe(false);
    // It is not a grant for other tools either.
    expect(broker.preapproved("s", "delete_path", { path: "x" })).toBe(false);
    expect(broker.listGrants("s")).toEqual([{ tool: "run_command", pathPrefix: "", argv: ["bun", "test", "apps/x.test.ts"], cwd: "." }]);
  });

  test("malformed command arguments grant nothing", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    for (const [id, args] of [["m1", "{not json"], ["m2", JSON.stringify({ argv: [] })], ["m3", JSON.stringify({ argv: ["ls", 3] })]] as const) {
      const waiter = broker.wait(id, "t", "s", "run_command", args, controller.signal);
      broker.resolve(id, "allow_session");
      await waiter;
    }
    expect(broker.listGrants("s")).toEqual([]);
    expect(broker.preapproved("s", "run_command", { argv: ["ls"] })).toBe(false);
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

describe("PermissionBroker session auto-approve", () => {
  test("reads current policy for all tools and releases only that session without grants", async () => {
    const enabled = new Set<string>();
    const broker = new PermissionBroker(undefined, id => enabled.has(id));
    const controller = new AbortController();
    const first = broker.wait("first", "turn", "one", "write_file", "{}", controller.signal);
    const publish = broker.wait("publish", "turn", "one", "run_command", '{"argv":["git","push"]}', controller.signal);
    const other = broker.wait("other", "other-turn", "two", "write_file", "{}", controller.signal);
    expect(broker.approvePendingSession("one")).toBe(0);
    enabled.add("one");
    expect(broker.preapproved("one", "run_command", { argv: ["npm", "publish"] })).toBe(true);
    expect(broker.preapproved("two", "run_command", { argv: ["npm", "publish"] })).toBe(false);
    expect(broker.approvePendingSession("one")).toBe(2);
    expect(await Promise.all([first, publish])).toEqual(["allow_once", "allow_once"]);
    expect(broker.listGrants("one")).toEqual([]);
    enabled.delete("one");
    expect(broker.preapproved("one", "write_file", { path: "x" })).toBe(false);
    expect(broker.preapproved("one", "run_command", { argv: ["git", "push"] })).toBe(false);
    expect(broker.resolve("other", "deny")).toBe(true);
    expect(await other).toBe("deny");
  });

  test("enabling before wait registration allows once, but cancellation always wins", async () => {
    const broker = new PermissionBroker(undefined, () => true);
    const controller = new AbortController();
    expect(await broker.wait("race", "turn", "one", "write_file", "{}", controller.signal)).toBe("allow_once");
    expect(broker.resolve("race", "allow_session")).toBe(false);
    expect(broker.listGrants("one")).toEqual([]);
    controller.abort(new Error("cancelled"));
    await expect(broker.wait("aborted", "turn", "one", "write_file", "{}", controller.signal)).rejects.toThrow("cancelled");
  });

  test("cancelled pending work cannot be resumed by enabling the policy", async () => {
    let enabled = false;
    const broker = new PermissionBroker(undefined, () => enabled);
    const controller = new AbortController();
    const waiter = broker.wait("pending", "turn", "one", "write_file", "{}", controller.signal);
    const rejected = waiter.catch(error => error);
    broker.cancelTurn("turn", new Error("cancelled"));
    enabled = true;
    expect(broker.approvePendingSession("one")).toBe(0);
    expect(broker.resolve("pending", "allow_once")).toBe(false);
    expect(await rejected).toMatchObject({ message: "cancelled" });
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
    expect(broker.preapproved("session", "run_command", { argv: ["git", "status"] })).toBe(true);
    expect(broker.preapproved("session", "run_command", { argv: ["git", "status", "--short"] })).toBe(false);
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
