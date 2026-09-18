import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "../src/permissions.ts";

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
