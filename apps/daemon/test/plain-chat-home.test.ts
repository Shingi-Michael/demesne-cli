import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { openHomeForChats } from "../src/tools.ts";

const fixtures: { app: DaemonApp; root: string }[] = [];
afterEach(async () => {
  for (const { app, root } of fixtures.splice(0)) {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
  openHomeForChats(null);
});

/// A daemon whose home folder is a fresh temp folder, with its data inside it.
function daemon(stream: TurnProcessor["stream"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-plain-home-")));
  mkdirSync(join(root, ".demesne"));
  const app = createDaemonApp({ databasePath: join(root, ".demesne", "state.sqlite"), heartbeat: { enabled: false }, plainChatsHome: root, processor: {
    providerId: "test", modelId: "plain-test", async listModels() { return []; }, stream,
  } });
  fixtures.push({ app, root });
  const client = new DemesneClient({ server: "http://fixture", fetch: ((url, init) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  return { client, root };
}

async function settled(client: DemesneClient, id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await client.getSessionState(id);
    const status = state.session.turns.at(-1)?.status;
    if (status === "completed" || status === "failed") return state;
    await Bun.sleep(5);
  }
  throw new Error("turn did not finish");
}

test("a chat with no project starts on Auto and changes files in the home folder", async () => {
  const results: string[] = [];
  let offered: string[] = [];
  let prompt = "";
  const { client, root } = daemon(async function* (messages, tools) {
    offered = tools.map((tool) => tool.name);
    prompt = String(messages[0]?.content ?? "");
    const done = messages.filter((message) => message.role === "tool");
    if (done.length === 2) {
      results.push(...done.map((message) => String(message.content ?? "")));
      yield { type: "text_delta", delta: "Saved." };
      yield { type: "finish", reason: "stop" }; return;
    }
    yield { type: "tool_call_delta", index: 0, idDelta: "a", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "Desktop/notes.md", content: "hello" }) };
    yield { type: "tool_call_delta", index: 1, idDelta: "b", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: ".demesne/sneaky.txt", content: "no" }) };
    yield { type: "finish", reason: "tool_calls" };
  });
  const { session } = await client.createSession({ title: "No project", autoApprove: true });
  expect(session.autoApprove).toBe(true);
  expect(session.workspace).toBeFalsy();
  // A window chat sends "ask"; Auto approves without anyone answering.
  await client.submitTurn(session.id, { content: "Save a note on my desktop", permissionMode: "ask" });
  const state = await settled(client, session.id);
  expect(state.session.turns.at(-1)?.status).toBe("completed");
  expect(readFileSync(join(root, "Desktop", "notes.md"), "utf8")).toBe("hello");
  expect(existsSync(join(root, ".demesne", "sneaky.txt"))).toBe(false);
  expect(results.join("\n")).toContain("off limits");
  expect(offered).toContain("run_command");
  expect(offered).not.toContain("start_threads");
  expect(offered).not.toContain("remember");
  expect(prompt).toContain("This chat is not in a project");
});

test("a new session stays on Ask unless it asks for Auto", async () => {
  const { client } = daemon(async function* () { yield { type: "finish", reason: "stop" }; });
  const { session } = await client.createSession({ title: "Plain" });
  expect(session.autoApprove).toBe(false);
});
