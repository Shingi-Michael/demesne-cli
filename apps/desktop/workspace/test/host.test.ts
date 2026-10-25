import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceHost, daemonAddress, daemonCredential } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

function hostFor(f: Awaited<ReturnType<typeof fixture>>) {
  return new WorkspaceHost({
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
    // Typing alone is a draft; ⌥↵ (submit with wait) queues it.
    await host.handle("draft", {
      sessionId: host.current!.session.id,
      text: "Follow-up",
    });
    expect(host.queue).toBe("");
    await host.handle("submit", {
      sessionId: host.current!.session.id,
      text: "Follow-up",
      wait: true,
    });
    expect(host.queue).toBe("Follow-up");
    expect(host.draft).toBe("");
    gates[0]!.resolve();
    // The daemon can start the second turn before the host has the submit
    // response that records it locally; wait for both.
    await eventually(() => calls === 2 && host.current!.session.turns.length === 2);
    expect(host.current!.session.turns[1]?.content).toBe("Follow-up");
    await host.handle("submit", {
      sessionId: host.current!.session.id,
      text: "Keep this unsent",
      wait: true,
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
test("a queued follow-up can be edited, dropped or sent now", async () => {
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
    const sessionId = host.current!.session.id;
    await host.submit("First request");
    await eventually(() => gates.length === 1);
    await host.handle("submit", { sessionId, text: "Edit me", wait: true });
    await host.handle("draft", { sessionId, text: "typed since" });
    await host.handle("queue-action", { sessionId, action: "edit" });
    expect(host.queue).toBe("");
    expect(host.draft).toBe("Edit me\n\ntyped since");
    await host.handle("submit", { sessionId, text: "Drop me", wait: true });
    await host.handle("queue-action", { sessionId, action: "drop" });
    expect(host.queue).toBe("");
    await host.handle("submit", { sessionId, text: "Right away", wait: true });
    await host.handle("queue-action", { sessionId, action: "now" });
    await eventually(() => calls === 2 && host.current!.session.turns.length === 2);
    expect(host.current!.session.turns[1]?.content).toBe("Right away");
    expect(host.current!.session.turns[0]?.status).not.toBe("completed");
  } finally {
    gates.forEach((g) => g.resolve());
    host.dispose();
    await f.close();
  }
});
test("Enter during a turn steers it, and words it never read go out next", async () => {
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [],
    seen: string[][] = [];
  const f = await fixture({
      providerId: "test",
      modelId: "test",
      async listModels() {
        return [];
      },
      async *stream(messages, _tools, signal) {
        seen.push(messages.filter((message) => message.role === "user").map((message) => String(message.content)));
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        await Promise.race([gate.promise, new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]);
        signal.throwIfAborted();
        yield { type: "text_delta", delta: `Answer ${gates.length}.` };
        yield { type: "finish", reason: "stop" };
      },
    }),
    host = hostFor(f);
  try {
    await host.connect();
    const sessionId = host.current!.session.id;
    await host.submit("First request");
    await eventually(() => gates.length === 1);
    await host.handle("submit", { sessionId, text: "Use parser.ts" });
    expect(host.queue).toBe("");
    expect(host.snapshot().steers).toMatchObject([{ text: "Use parser.ts" }]);
    gates[0]!.resolve();
    // It reads the words and carries on in the same turn.
    await eventually(() => gates.length === 2);
    expect(seen[1]!.at(-1)).toContain("Use parser.ts");
    await eventually(() => host.steers.length === 0);
    expect(host.current!.session.turns).toHaveLength(1);
    expect(host.snapshot().runs[0]!.entries.some((entry) => entry.type === "notice" && entry.steer && entry.text === "Use parser.ts")).toBe(true);
    gates[1]!.resolve();
    await eventually(() => host.current!.session.turns[0]?.status === "completed");
    // Nothing running: Enter sends a message as usual.
    await host.handle("submit", { sessionId, text: "Next one" });
    await eventually(() => host.current!.session.turns.length === 2);
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
    // A draft for the old session is dropped quietly, not reported.
    await host.handle("draft", { sessionId: first, text: "stale draft" });
    expect(host.snapshot().draft).toBe("");
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
test("clicking around the desktop never pauses Drive; writing or sending does", async () => {
  const f = await fixture();
  const host = hostFor(f);
  let takeovers = 0;
  host.drive = { authorize: () => false, agent: { intervene: () => takeovers++ }, handle: async () => {}, dispose() {} } as unknown as typeof host.drive;
  const send = async (method: string, args: Record<string, unknown> = {}) => { try { await host.handle(method, args); } catch { /* only the takeover matters here */ } };
  try {
    for (const method of ["panel-watch", "processes", "copy", "files", "changes", "theme", "select-session"])
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
  const h = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {} });
  try { await h.connect(); expect(h.snapshot().model.contextWindow).toBe(272000); }
  finally { h.dispose(); await f.close(); }
});

test("an untrusted workspace waits for Trust folder before creating a session", async () => {
  const f = await fixture(undefined, { trusted: false });
  const host = hostFor(f);
  try {
    await host.connect();
    expect(host.connection).toBe("online");
    expect(host.current).toBeNull();
    expect(host.snapshot().untrustedWorkspace).toBe(f.workspace);
    expect((await f.client.listSessions()).length).toBe(0);
    await host.handle("trust-workspace", {});
    expect(host.snapshot().untrustedWorkspace).toBeNull();
    expect(host.current?.session.workspace?.root).toBe(f.workspace);
  } finally {
    host.dispose();
    await f.close();
  }
});

test("/drive works the mission in its own worktree session while you stay in your chat", async () => {
  const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 262144, async listModels() { return []; },
    async *stream() { yield { type: "text_delta", delta: "Thinking it over." }; yield { type: "finish", reason: "stop" }; } });
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=a@b", "commit", "-qm", "init"]])
    Bun.spawnSync(["git", ...args], { cwd: f.workspace });
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, drive: true });
  try {
    await host.connect();
    await eventually(() => Boolean(host.current), 5000);
    const home = host.current!.session.id;
    await host.drive!.handle("drive", { text: "--bounded Make the README friendlier" });
    const fix = host.breakage.state.fix!;
    expect(fix).toMatchObject({ mission: "Make the README friendlier", status: "running" });
    // You stay where you were; Drive follows the mission's chat behind you.
    expect(host.current!.session.id).toBe(home);
    expect(host.driveSession?.session.id).toBe(fix.sessionId!);
    expect(host.driveSession!.session.workspace?.root.startsWith(fix.path)).toBe(true);
    expect(host.driveState?.homeSessionId).toBe(fix.sessionId!);
    // Talking in your own chat doesn't pause it.
    await host.handle("submit", { text: "What's in the README?", sessionId: home });
    expect(host.driveState?.status).not.toBe("paused");

    // Stopping settles the mission: the worktree is committed for review (nothing changed here).
    await host.drive!.handle("drive-control", { control: "stop" });
    await eventually(() => host.breakage.state.fix?.status === "failed", 5000);
    expect(host.breakage.state.fix?.unchanged).toBe(true);
    // The receipt comes from the task ledger: one task, not finished, no checks.
    expect(host.breakage.state.fix?.headline).toBe("0 of 1 task verified · no checks recorded");
    expect(host.breakage.state.fix?.receipt).toContain("#### ○ Make the README friendlier");

    await host.handle("breakage-discard", { id: fix.id, sessionId: home });
    await eventually(() => host.breakage.state.fix === null, 5000);
    expect(host.current?.session.id).toBe(home);
    expect(host.driveSession).toBeNull();
  } finally { host.dispose(); await f.close(); }
});

test("the window picks up an away run Drive started and leaves each one to review", async () => {
  Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
  const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 262144, async listModels() { return []; },
    async *stream(messages) {
      const last = messages.at(-1)!, task = String(messages.find((message) => message.role === "user")?.content ?? "");
      const name = /Task: Tidy (\w)/.exec(task)?.[1];
      if (last.role === "user" && name) {
        yield { type: "tool_call_delta", index: 0, idDelta: "w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: `${name}.txt`, content: "tidied\n" }) };
        yield { type: "finish", reason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: "Done." }; yield { type: "finish", reason: "stop" };
    } });
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "init"]]) Bun.spawnSync(["git", ...args], { cwd: f.workspace, env: process.env });
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, drive: true });
  try {
    await host.connect();
    await eventually(() => Boolean(host.current), 5000);
    await host.breakageStarted;
    const sessionId = host.current!.session.id;
    // The daemon starts these on its own once the project goes quiet.
    const tidy = (id: string) => ({ proposal: { id, kind: "tidy" as const, title: `Tidy ${id}`, why: "It's untidy." }, signals: [] });
    await f.client.startDriveAway({ workspace: f.workspace, items: [tidy("A"), tidy("B"), tidy("C")] });
    await host.breakage.refreshAuto();
    expect(host.breakage.state.auto?.on).toBe(true);
    expect(host.breakage.state.away?.items.map((item) => item.proposal.title)).toEqual(["Tidy A", "Tidy B", "Tidy C"]);
    // Ideas Drive already has in hand leave its list, so Plan or Run can't start them twice.
    await eventually(() => !host.nextQueue.loading, 5000);
    const idea = (id: string) => ({ ...tidy(id).proposal, evidence: [], minutes: 5, confidence: "high" as const, coders: 1, urgent: false, value: 1, cost: 1 });
    host.nextQueue = { ...host.nextQueue, proposals: [idea("A"), idea("D")] as never };
    expect(host.snapshot().driveNext.proposals.map((item) => item.id)).toEqual(["D"]);
    await expect(host.handle("next-plan", { sessionId, id: "A" })).rejects.toThrow("Drive is already working on that one.");
    await eventually(() => host.breakage.state.away?.status === "finished", 15000);
    await eventually(() => host.breakage.state.fix?.status === "ready" && host.breakage.state.inbox.length === 2, 5000);
    expect(host.breakage.state.away?.items.map((item) => item.state)).toEqual(["ready", "ready", "ready"]);
    // One on the card, the rest below it; each acts on its own branch. Which
    // one the card keeps depends on what was running when the window looked.
    const open = () => [host.breakage.state.fix, ...host.breakage.state.inbox].map((fix) => fix!);
    const titled = (title: string) => open().find((fix) => fix.title === title)!;
    expect(open().map((fix) => fix.title).sort()).toEqual(["Tidy A", "Tidy B", "Tidy C"]);
    await host.handle("breakage-apply", { sessionId, id: titled("Tidy B").id });
    expect(readFileSync(join(f.workspace, "B.txt"), "utf8")).toBe("tidied\n");
    expect(existsSync(join(f.workspace, "A.txt"))).toBe(false);
    expect(open().map((fix) => fix.title).sort()).toEqual(["Tidy A", "Tidy C"]);
    await host.handle("breakage-discard", { sessionId, id: titled("Tidy C").id });
    expect(host.breakage.state.fix?.title).toBe("Tidy A");
    expect(host.breakage.state.inbox).toEqual([]);
    // The summary stays while any of its work waits for review.
    expect(host.breakage.state.away?.status).toBe("finished");
    await host.handle("breakage-discard", { sessionId, id: host.breakage.state.fix!.id });
    expect(host.breakage.state.fix).toBeNull();
    expect(host.breakage.state.away).toBeNull();
  } finally { host.dispose(); await f.close(); }
});
