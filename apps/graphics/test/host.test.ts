import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GraphicsHost, daemonAddress, daemonCredential } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

function hostFor(f: Awaited<ReturnType<typeof fixture>>) {
  return new GraphicsHost({
    workspace: f.workspace,
    settings: f.settings,
    client: f.client,
    changed: () => {},
  });
}
test("live edits wait for approval and replay matches the finished UI", async () => {
  let round = 0;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    contextCapacity: 262144,
    async listModels() {
      return [];
    },
    async *stream() {
      if (++round === 1) {
        yield { type: "reasoning_delta", delta: "Check the file first." };
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "write",
          nameDelta: "write_file",
          argumentsDelta: JSON.stringify({
            path: "hello.ts",
            content: "export const hello = 1;\n",
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Created **hello.ts**.\n" };
        yield { type: "text_delta", delta: "Ready to review." };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  const host = hostFor(f);
  try {
    await host.connect();
    expect(host.connection).toBe("online");
    await host.submit("Create hello.ts");
    await eventually(() => host.current!.approvals.size === 1);
    expect(existsSync(join(f.workspace, "hello.ts"))).toBe(false);
    const approval = [...host.current!.approvals.values()][0]!;
    expect(approval.name).toBe("write_file");
    await host.handle("permission", {
      sessionId: host.current!.session.id,
      id: approval.id,
      decision: "allow_once",
    });
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    expect(readFileSync(join(f.workspace, "hello.ts"), "utf8")).toBe(
      "export const hello = 1;\n",
    );
    const runs = structuredClone(host.snapshot().runs),
      id = host.current!.session.id;
    expect(host.current!.changes(runs[0]!.id)).toMatchObject([
      { path: "hello.ts", state: "applied", added: 1 },
    ]);
    await host.select(id);
    expect(host.snapshot().runs).toEqual(runs);
    await expect(
      host.handle("permission", {
        sessionId: id,
        id: approval.id,
        decision: "allow_once",
      }),
    ).rejects.toThrow("no longer pending");
  } finally {
    host.dispose();
    await f.close();
  }
});
test("a queued follow-up is sent only on success and restored on cancellation", async () => {
  let gates: ReturnType<typeof Promise.withResolvers<void>>[] = [],
    calls = 0;
  const f = await fixture({
      providerId: "test",
      modelId: "test",
      async listModels() {
        return [];
      },
      async *stream(_messages, _tools, signal) {
        calls++;
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        await Promise.race([
          gate.promise,
          new Promise<void>((r) =>
            signal.addEventListener("abort", () => r(), { once: true }),
          ),
        ]);
        signal.throwIfAborted();
        yield { type: "text_delta", delta: "Finished." };
        yield { type: "finish", reason: "stop" };
      },
    }),
    host = hostFor(f);
  try {
    await host.connect();
    await host.submit("First request");
    await eventually(() => gates.length === 1);
    await host.handle("draft", {
      sessionId: host.current!.session.id,
      text: "Follow-up",
    });
    gates[0]!.resolve();
    await eventually(() => calls === 2);
    expect(host.current!.session.turns[1]?.content).toBe("Follow-up");
    await host.handle("draft", {
      sessionId: host.current!.session.id,
      text: "Keep this unsent",
    });
    await host.interrupt();
    await eventually(() => host.restored);
    expect(host.draft).toBe("Keep this unsent");
    expect(host.queue).toBe("");
    expect(calls).toBe(2);
  } finally {
    gates.forEach((g) => g.resolve());
    host.dispose();
    await f.close();
  }
});
test("session switch failure preserves the event stream and stale actions cannot change another session", async () => {
  const f = await fixture(),
    host = hostFor(f);
  try {
    await host.connect();
    const first = host.current!.session.id;
    await expect(host.select("missing-session")).rejects.toThrow();
    expect(host.busy).toBe(false);
    await host.submit("Still connected");
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    await host.newSession();
    await expect(
      host.handle("submit", { sessionId: first, text: "wrong session" }),
    ).rejects.toThrow("session changed");
    expect(host.current!.session.turns).toHaveLength(0);
    expect(JSON.stringify(host.snapshot())).not.toContain(
      "graphics-test-token",
    );
  } finally {
    host.dispose();
    await f.close();
  }
});
test("remote addresses do not receive local daemon credentials", () => {
  expect(() => daemonAddress("http://remote.example")).toThrow("HTTPS");
  expect(() => daemonAddress("https://user:secret@example.com")).toThrow();
  expect(
    daemonCredential("https://remote.example", "/missing", {}),
  ).toBeUndefined();
});
test("clicking around the graphics UI never pauses Drive; writing or sending does", async () => {
  const f = await fixture();
  const host = hostFor(f);
  let takeovers = 0;
  host.drive = { authorize: () => false, agent: { intervene: () => takeovers++ }, handle: async () => {}, dispose() {} } as unknown as typeof host.drive;
  const send = async (method: string, args: Record<string, unknown> = {}) => { try { await host.handle(method, args); } catch { /* only the takeover matters here */ } };
  try {
    for (const method of ["panel-width", "panel-watch", "processes", "copy", "files", "read-file", "changes", "open-artifact", "theme", "select-session", "rerun-checks"])
      await send(method);
    expect(takeovers).toBe(0);
    await send("manual");
    expect(takeovers).toBe(1);
    await send("submit", { text: "Do it" });
    expect(takeovers).toBe(2);
  } finally {
    host.drive = undefined;
    host.dispose();
    await f.close();
  }
});

test("the displayed context follows the active daemon model, not the primary provider's config", async () => {
  const f = await fixture({ providerId: "cloud", modelId: "cloud-model", contextCapacity: 272000,
    async listModels() { return []; }, async *stream() { yield { type: "text_delta", delta: "Ready" }; yield { type: "finish", reason: "stop" }; } });
  const h = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {} });
  try { await h.connect(); expect(h.snapshot().model.contextWindow).toBe(272000); }
  finally { h.dispose(); await f.close(); }
});
