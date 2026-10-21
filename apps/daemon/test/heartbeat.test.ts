import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidStateError } from "@demesne/storage";
import { readServerSentEvents, type CreateSessionResponse, type EventEnvelope, type Session, type SubmitTurnResponse } from "@demesne/protocol";
import {
  formatMail, HeartbeatBridge, HeartbeatClient, heartbeatLabel, heartbeatSocketPath, heartbeatTool, isMailTurn, splitAddress, type Envelope,
} from "../src/heartbeat.ts";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";

/// A stand-in for the Heartbeat daemon's control socket: one JSON line per
/// connection, except `listen`, which stays open and receives what the test
/// pushes to it.
class FakeHeartbeat {
  readonly requests: Record<string, unknown>[] = [];
  readonly mailbox = new Map<string, Envelope[]>();
  readonly listeners = new Map<string, Bun.Socket<unknown>[]>();
  readonly server: Bun.UnixSocketListener<unknown>;
  nextId = 1;
  /// Other agents the daemon lists (hook clients such as Claude Code).
  others = ["claude@testnode/heartbeat-k3x9a"];
  constructor(readonly path: string, readonly nodeId = "testnode") {
    const self = this;
    this.server = Bun.listen({
      unix: path,
      socket: {
        data(socket, chunk) {
          const line = Buffer.from(chunk).toString("utf8").split("\n")[0]!.trim();
          if (!line) return;
          const request = JSON.parse(line) as Record<string, unknown>;
          self.requests.push(request);
          const reply = (body: Record<string, unknown>) => { socket.write(`${JSON.stringify(body)}\n`); socket.end(); };
          switch (request.command) {
            case "status": return reply({ status: "ok", node_id: self.nodeId, active_links: [] });
            case "agents": return reply({ status: "ok", node_id: self.nodeId, agents: [
              ...self.others.map((agent_id) => ({ agent_id, node: self.nodeId, transport: "hooks" })),
              ...[...self.listeners.keys()].map((agent_id) => ({ agent_id, node: self.nodeId, transport: "control_listen" })),
            ] });
            case "read": {
              const messages = self.mailbox.get(String(request.as)) ?? [];
              self.mailbox.set(String(request.as), []);
              return reply({ status: "ok", address: request.as, messages });
            }
            case "say": {
              const line = String(request.line);
              if (!/^(REQ|OFFER|AGREE|REFUSE|INFORM|DONE|FAIL|CANCEL|LEASE|RELEASE)#/.test(line)) return reply({ status: "error", error: "unexpected text at column 1", offset: 0 });
              const id = String(self.nextId++);
              const unread = self.mailbox.get(String(request.as)) ?? [];
              self.mailbox.set(String(request.as), []);
              return reply({ status: "ok", id, from: request.as, performative: "request", compact: line.replace("#_", `#${id}`), english: `${request.as} sent ${line}`, result: "sent", unread });
            }
            case "approve": return reply({ status: "ok", node_id: request.node_id, capabilities: ["may_message"] });
            case "deny": return reply({ status: "ok", node_id: request.node_id });
            case "listen": {
              const as = String(request.as);
              if (self.listeners.has(as)) return reply({ status: "error", error: `${as} is held by a live session` });
              self.listeners.set(as, [socket]);
              socket.write(`${JSON.stringify({ status: "ok", agent_id: as })}\n`);
              for (const message of self.mailbox.get(as) ?? []) socket.write(`${JSON.stringify({ event: "message", ...message })}\n`);
              return;
            }
            default: return reply({ status: "error", error: "unknown_command" });
          }
        },
        close(socket) {
          for (const [as, sockets] of self.listeners) if (sockets.includes(socket)) self.listeners.delete(as);
        },
      },
    });
  }
  /// Mail for `to`, waking its listener as the daemon would.
  send(to: string, from: string, payload: string, authority: "owner" | "peer" = "peer"): Envelope {
    const id = String(this.nextId++);
    const message: Envelope = { id, in_reply_to: null, from, to, performative: "request", payload, authority,
      compact: `REQ#${id} ←${from} why:"${payload}"`, english: `${from} asked ${to}: ${payload}` };
    this.mailbox.set(to, [...(this.mailbox.get(to) ?? []), message]);
    for (const socket of this.listeners.get(to) ?? []) socket.write(`${JSON.stringify({ event: "message", ...message })}\n`);
    return message;
  }
  pairRequest(to: string, node: string) {
    for (const socket of this.listeners.get(to) ?? []) socket.write(`${JSON.stringify({ event: "pair_request", node_id: node, requester: `codex@${node}/x-abcde`, capabilities: ["may_message"], note: "hi" })}\n`);
  }
  stop() { for (const sockets of this.listeners.values()) for (const socket of sockets) socket.end(); this.server.stop(true); }
}

const directories: string[] = [];
const daemons: FakeHeartbeat[] = [];
const apps: DaemonApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const daemon of daemons.splice(0)) daemon.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeDaemon(): FakeHeartbeat {
  // Unix socket paths are short-lived and length-limited; keep them in tmp.
  const directory = mkdtempSync(join(tmpdir(), "hb-"));
  directories.push(directory);
  const daemon = new FakeHeartbeat(join(directory, "control.sock"));
  daemons.push(daemon);
  return daemon;
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("Heartbeat paths and addresses", () => {
  test("finds the control socket by the daemon's rule", () => {
    const home = mkdtempSync(join(tmpdir(), "hb-home-"));
    directories.push(home);
    expect(heartbeatSocketPath({ HEARTBEAT_CONTROL_SOCKET: "/run/hb.sock" }, home)).toBe("/run/hb.sock");
    expect(heartbeatSocketPath({ HEARTBEAT_DATA_DIR: "/var/hb" }, home)).toBe("/var/hb/control.sock");
    expect(heartbeatSocketPath({ XDG_STATE_HOME: "/xdg" }, home)).toBe("/xdg/heartbeat/control.sock");
    expect(heartbeatSocketPath({}, home)).toBe(join(home, ".local/state/heartbeat/control.sock"));
    // A legacy ~/.heartbeat with an identity wins while the new directory has none.
    mkdirSync(join(home, ".heartbeat/identity"), { recursive: true });
    expect(heartbeatSocketPath({}, home)).toBe(join(home, ".heartbeat/control.sock"));
    mkdirSync(join(home, ".local/state/heartbeat/identity"), { recursive: true });
    expect(heartbeatSocketPath({}, home)).toBe(join(home, ".local/state/heartbeat/control.sock"));
  });

  test("labels follow the CLI convention and stay stable per chat", () => {
    const label = heartbeatLabel("/Users/mike/projects/Demesne CLI!", "session-1");
    expect(label).toMatch(/^demesne-cli-[a-z2-7]{5}$/);
    expect(heartbeatLabel("/Users/mike/projects/Demesne CLI!", "session-1")).toBe(label);
    expect(heartbeatLabel("/Users/mike/projects/Demesne CLI!", "session-2")).not.toBe(label);
    expect(heartbeatLabel("/", "s")).toMatch(/^session-[a-z2-7]{5}$/);
    expect(splitAddress("demesne@mac/demesne-cli-abcde")).toEqual({ provider: "demesne", node: "mac", label: "demesne-cli-abcde" });
    expect(splitAddress("nonsense")).toBeNull();
  });

  test("mail turns carry the compact line, the English and the authority", () => {
    const text = formatMail("demesne@mac/x-abcde", [{ id: "4", in_reply_to: null, from: "claude@mac/y-fghij", to: "demesne@mac/x-abcde", performative: "request",
      payload: "status of job 17", authority: "owner", compact: "REQ#4 ←claude@mac/y-fghij why:\"status of job 17\"", english: "claude asked: status of job 17" }],
      [{ node_id: "beta", requester: "codex@beta/z-klmno", capabilities: ["may_message", "may_lease"], note: "pair us" }]);
    expect(isMailTurn(text)).toBe(true);
    expect(text).toBe("Heartbeat mail for demesne@mac/x-abcde:\n[owner] REQ#4 ←claude@mac/y-fghij why:\"status of job 17\"\n  = claude asked: status of job 17\n"
      + "[pair-request] codex@beta/z-klmno on beta asks to connect, with may_message, may_lease (note: pair us). Ask your owner one yes-or-no question; on yes use the heartbeat tool's approve action for beta, on no its deny action.");
    expect(isMailTurn("Heartbeat is a daemon, explain it")).toBe(false);
  });
});

describe("HeartbeatClient", () => {
  test("exchanges one JSON line per connection and surfaces daemon errors", async () => {
    const daemon = fakeDaemon();
    const client = new HeartbeatClient(daemon.path);
    expect(client.available()).toBe(true);
    expect(await client.call({ command: "status" })).toMatchObject({ node_id: "testnode" });
    await expect(client.call({ command: "nope" })).rejects.toThrow("unknown_command");
    expect(new HeartbeatClient(join(daemon.path, "missing")).available()).toBe(false);
  });
});

describe("HeartbeatBridge", () => {
  function bridgeFor(daemon: FakeHeartbeat, options: { busy?: () => boolean } = {}) {
    const turns: Array<{ sessionId: string; content: string }> = [];
    const idleWaiters: Array<() => void> = [];
    const bridge = new HeartbeatBridge({
      client: new HeartbeatClient(daemon.path),
      startTurn: (sessionId, content) => {
        if (options.busy?.()) throw new InvalidStateError("Session already has an active turn");
        turns.push({ sessionId, content });
      },
      waitForIdle: () => options.busy?.() ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve(),
    });
    return { bridge, turns, release: () => idleWaiters.splice(0).forEach((resolve) => resolve()) };
  }

  test("claims an address, delivers mail as a turn and releases on detach", async () => {
    const daemon = fakeDaemon();
    const { bridge, turns } = bridgeFor(daemon);
    const address = await bridge.attach("session-1", "/tmp/My Project");
    expect(address).toMatch(/^demesne@testnode\/my-project-[a-z2-7]{5}$/);
    expect(await bridge.attach("session-1", "/tmp/My Project")).toBe(address);
    await until(() => daemon.listeners.has(address!));

    daemon.send(address!, "claude@testnode/heartbeat-k3x9a", "run the tests", "owner");
    await until(() => turns.length === 1);
    expect(turns[0]!.sessionId).toBe("session-1");
    expect(turns[0]!.content).toBe(`Heartbeat mail for ${address}:\n[owner] REQ#1 ←claude@testnode/heartbeat-k3x9a why:"run the tests"\n  = claude@testnode/heartbeat-k3x9a asked ${address}: run the tests`);
    // Delivered mail is taken from the mailbox, so it is never shown twice.
    expect(daemon.mailbox.get(address!)).toEqual([]);

    daemon.pairRequest(address!, "beta");
    await until(() => turns.length === 2);
    expect(turns[1]!.content).toContain("[pair-request] codex@beta/x-abcde on beta asks to connect, with may_message (note: hi)");

    bridge.detach("session-1");
    await until(() => !daemon.listeners.has(address!));
    expect(bridge.address("session-1")).toBeNull();
    expect(bridge.context("session-1")).toBeNull();
  });

  test("holds mail until the chat's running turn ends", async () => {
    const daemon = fakeDaemon();
    let busy = true;
    const { bridge, turns, release } = bridgeFor(daemon, { busy: () => busy });
    const address = (await bridge.attach("session-1", "/tmp/p"))!;
    await until(() => daemon.listeners.has(address));
    daemon.send(address, "codex@testnode/a-bcdef", "first");
    await Bun.sleep(50);
    expect(turns).toHaveLength(0);
    daemon.send(address, "codex@testnode/a-bcdef", "second");
    busy = false;
    release();
    await until(() => turns.length === 1);
    expect(turns[0]!.content).toContain("why:\"first\"");
    expect(turns[0]!.content).toContain("why:\"second\"");
  });

  test("tells the model its address and who is reachable", async () => {
    const daemon = fakeDaemon();
    const { bridge } = bridgeFor(daemon);
    const address = (await bridge.attach("session-1", "/tmp/demesne-cli"))!;
    await until(() => bridge.reachableAgents().length > 0);
    const context = bridge.context("session-1")!;
    expect(context).toContain(`you are ${address}`);
    expect(context).toContain("Agents reachable now: claude@testnode/heartbeat-k3x9a");
    expect(context).not.toContain(`now: ${address}`);
    expect(context).toContain(`Mail to demesne@testnode/demesne-cli, this project's address`);
    expect(context).toContain("[owner]");
  });

  test("reconnects after the daemon restarts", async () => {
    const daemon = fakeDaemon();
    const { bridge, turns } = bridgeFor(daemon);
    const address = (await bridge.attach("session-1", "/tmp/p"))!;
    await until(() => daemon.listeners.has(address));
    for (const sockets of daemon.listeners.values()) for (const socket of sockets) socket.end();
    await until(() => !daemon.listeners.has(address));
    await until(() => daemon.listeners.has(address), 5_000);
    daemon.send(address, "codex@testnode/a-bcdef", "back");
    await until(() => turns.length === 1);
    bridge.stop();
  });

  test("stays quiet without a daemon", async () => {
    const { bridge, turns } = bridgeFor({ path: "/nonexistent/control.sock" } as FakeHeartbeat);
    expect(await bridge.attach("session-1", "/tmp/p")).toBeNull();
    expect(bridge.context("session-1")).toBeNull();
    expect(turns).toHaveLength(0);
  });
});

describe("heartbeat tool", () => {
  test("sends compact lines, reads the inbox and answers pairing, asking first for outward actions", async () => {
    const daemon = fakeDaemon();
    const bridge = new HeartbeatBridge({ client: new HeartbeatClient(daemon.path), startTurn: () => {}, waitForIdle: () => Promise.resolve() });
    const tool = heartbeatTool(bridge);
    const context = { workspaceRoot: "/tmp/demesne-cli", sessionId: "session-1", signal: new AbortController().signal };

    expect(tool.permission({ action: "inbox" })).toBeNull();
    expect(tool.permission({ action: "agents" })).toBeNull();
    expect(tool.permission({ action: "send", to: "claude@testnode/heartbeat-k3x9a", text: "hi" })).toEqual({ kind: "execute", summary: "Send a Heartbeat request to claude@testnode/heartbeat-k3x9a" });
    expect(tool.permission({ action: "approve", node_id: "beta" })).toEqual({ kind: "execute", summary: "Approve Heartbeat pairing with beta" });
    expect(() => tool.permission({ action: "send", text: "no recipient" })).toThrow("send needs to");
    expect(() => tool.permission({ action: "send", to: "x", performative: "shout" })).toThrow("performative must be");

    const sent = JSON.parse(await tool.execute({ action: "send", to: "claude@testnode/heartbeat-k3x9a", performative: "inform", text: "tests \"pass\"\nnow", reply_to: "41" }, context));
    expect(sent).toMatchObject({ id: "1", result: "sent" });
    const say = daemon.requests.find((request) => request.command === "say")!;
    expect(say.line).toBe("INFORM#_ ^41 →claude@testnode/heartbeat-k3x9a why:\"tests pass now\"");
    // The default performative is a request, spelled REQ in the daemon's grammar.
    await tool.execute({ action: "send", to: "claude@testnode/heartbeat-k3x9a", text: "status?" }, context);
    expect(daemon.requests.findLast((request) => request.command === "say")!.line).toBe("REQ#_ →claude@testnode/heartbeat-k3x9a why:\"status?\"");
    expect(say.as).toMatch(/^demesne@testnode\/demesne-cli-[a-z2-7]{5}$/);
    expect(say.owner).toBe(false);

    const address = bridge.address("session-1")!;
    daemon.mailbox.set(address, [{ id: "9", in_reply_to: "1", from: "claude@testnode/heartbeat-k3x9a", to: address, performative: "done", payload: "ok", authority: "peer", compact: "DONE#9 ^1 why:\"ok\"", english: "claude: done" }]);
    expect(await tool.execute({ action: "inbox" }, context)).toBe("[peer] DONE#9 ^1 why:\"ok\"\n  = claude: done");
    expect(await tool.execute({ action: "inbox" }, context)).toBe("No unread mail.");

    const agents = JSON.parse(await tool.execute({ action: "agents" }, context));
    expect(agents.you).toBe(address);
    expect(agents.agents.map((agent: { agent_id: string }) => agent.agent_id)).toContain("claude@testnode/heartbeat-k3x9a");

    expect(JSON.parse(await tool.execute({ action: "deny", node_id: "beta" }, context))).toEqual({ node_id: "beta", denied: true });
    expect(JSON.parse(await tool.execute({ action: "approve", node_id: "beta" }, context))).toMatchObject({ node_id: "beta", approved: true });
    bridge.stop();
  });
});

describe("daemon with Heartbeat", () => {
  test("a chat claims an address on its first turn and mail wakes it with a turn", async () => {
    const daemon = fakeDaemon();
    const directory = mkdtempSync(join(tmpdir(), "demesne-hb-"));
    directories.push(directory);
    // A workspace may not sit inside the daemon's data directory.
    const workspace = join(mkdtempSync(join(tmpdir(), "demesne-hb-ws-")), "demesne-cli");
    directories.push(join(workspace, ".."));
    mkdirSync(workspace);
    const app = createDaemonApp({ databasePath: join(directory, "demesne.sqlite"), heartbeat: { socket: daemon.path } });
    apps.push(app);
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const created = await (await fetch(new URL("/v1/sessions", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "hb", workspacePath: workspace, trustWorkspace: true }) })).json() as CreateSessionResponse;
      const submitted = await (await fetch(new URL(`/v1/sessions/${created.session.id}/turns`, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "hello", permissionMode: "ask" }) })).json() as SubmitTurnResponse;
      await waitForTurn(server.url, created.session.id, submitted.eventId);
      const address = [...daemon.listeners.keys()][0];
      expect(address).toMatch(/^demesne@testnode\/demesne-cli-[a-z2-7]{5}$/);

      daemon.send(address!, "claude@testnode/heartbeat-k3x9a", "what changed today", "peer");
      const turns = await pollTurns(server.url, created.session.id, (list) => list.some((turn) => isMailTurn(turn.content) && turn.status === "completed"));
      const mail = turns.find((turn) => isMailTurn(turn.content))!;
      expect(mail.permissionMode).toBe("allow"); // mail runs on Auto whatever the chat's mode
      expect(mail.content).toContain("[peer] REQ#");
      expect(mail.content).toContain("what changed today");
      expect(mail.responseText).toContain("Request accepted: Heartbeat mail for");
      expect(turns).toHaveLength(2);

      // Archiving releases the address.
      await fetch(new URL(`/v1/sessions/${created.session.id}`, server.url), { method: "DELETE" });
      await until(() => !daemon.listeners.has(address!));
    } finally {
      await server.stop(true);
    }
  });
});

describe("agents nearby", () => {
  test("lists other agents by project and asks before changing a file one of them changed", async () => {
    const daemon = fakeDaemon();
    daemon.others = ["claude@testnode/demesne-cli-k3x7a", "codex@air/heartbeat-q2m7c"];
    const directory = mkdtempSync(join(tmpdir(), "demesne-hb-"));
    directories.push(directory);
    const workspace = join(mkdtempSync(join(tmpdir(), "demesne-hb-ws-")), "demesne-cli");
    directories.push(join(workspace, ".."));
    mkdirSync(workspace);
    writeFileSync(join(workspace, "search.ts"), "export const match = 1;\n");
    let round = 0, lastResult = "";
    const app = createDaemonApp({
      databasePath: join(directory, "demesne.sqlite"), heartbeat: { socket: daemon.path },
      processor: {
        providerId: "scripted", modelId: "overlap", contextCapacity: 32_768,
        async listModels() { return [{ id: "overlap", provider: "scripted" }]; },
        async *stream(messages) {
          const last = messages.at(-1);
          if (last?.role === "tool") lastResult = String(last.content);
          round += 1;
          if (round === 1) {
            yield { type: "tool_call_delta" as const, index: 0, idDelta: "read", nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: "search.ts" }) };
            yield { type: "finish" as const, reason: "tool_calls" };
          } else if (round === 2) {
            // Another agent saves the file between this chat's read and its edit.
            writeFileSync(join(workspace, "search.ts"), "export const match = 2;\n");
            utimesSync(join(workspace, "search.ts"), new Date(), new Date(Date.now() + 5_000));
            yield { type: "tool_call_delta" as const, index: 0, idDelta: "edit", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "search.ts", content: "export const match = 3;\n" }) };
            yield { type: "finish" as const, reason: "tool_calls" };
          } else {
            yield { type: "text_delta" as const, delta: "Asked first." };
            yield { type: "finish" as const, reason: "stop" };
          }
        },
      },
    });
    apps.push(app);
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const nearby = await (await fetch(new URL("/v1/heartbeat/agents", server.url))).json() as { agents: Array<{ address: string; project: string; local: boolean }> };
      expect(nearby.agents.map((agent) => [agent.address, agent.project, agent.local])).toEqual([
        ["claude@testnode/demesne-cli-k3x7a", "demesne-cli", true],
        ["codex@air/heartbeat-q2m7c", "heartbeat", false],
      ]);

      const created = await (await fetch(new URL("/v1/sessions", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "overlap", workspacePath: workspace, trustWorkspace: true }) })).json() as CreateSessionResponse;
      const submitted = await (await fetch(new URL(`/v1/sessions/${created.session.id}/turns`, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "make search match", permissionMode: "ask" }) })).json() as SubmitTurnResponse;
      const eventsUrl = new URL("/v1/events", server.url);
      eventsUrl.searchParams.set("session_id", created.session.id);
      eventsUrl.searchParams.set("after", String(submitted.eventId));
      for await (const event of readServerSentEvents(await fetch(eventsUrl)) as AsyncIterable<EventEnvelope>) {
        if (event.type === "permission.requested") {
          expect(event.payload.summary).toBe("Claude Code changed search.ts");
          expect((event.payload.overlap as { path: string; agents: Array<{ address: string }> }).agents.map((agent) => agent.address)).toEqual(["claude@testnode/demesne-cli-k3x7a"]);
          await fetch(new URL(`/v1/permissions/${String(event.payload.permissionId)}`, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }) });
        }
        if (event.type === "turn.completed") break;
      }
      expect(lastResult).toContain("Not changed: search.ts changed since you last read it");
      expect(lastResult).toContain("claude@testnode/demesne-cli-k3x7a");
      expect(await Bun.file(join(workspace, "search.ts")).text()).toBe("export const match = 2;\n");
    } finally {
      await server.stop(true);
    }
  });
});

async function waitForTurn(url: URL, sessionId: string, after: number): Promise<void> {
  const eventsUrl = new URL("/v1/events", url);
  eventsUrl.searchParams.set("session_id", sessionId);
  eventsUrl.searchParams.set("after", String(after));
  for await (const event of readServerSentEvents(await fetch(eventsUrl)) as AsyncIterable<EventEnvelope>) if (event.type === "turn.completed") break;
}

async function turnsOf(url: URL, sessionId: string) {
  return ((await (await fetch(new URL(`/v1/sessions/${sessionId}`, url))).json()) as { session: Session }).session.turns;
}

async function pollTurns(url: URL, sessionId: string, done: (turns: Session["turns"]) => boolean): Promise<Session["turns"]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const turns = await turnsOf(url, sessionId);
    if (done(turns)) return turns;
    if (Date.now() > deadline) throw new Error(`timed out; turns: ${JSON.stringify(turns.map((turn) => [turn.content.slice(0, 40), turn.status]))}`);
    await Bun.sleep(25);
  }
}
