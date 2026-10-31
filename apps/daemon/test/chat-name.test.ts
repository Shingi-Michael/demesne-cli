import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSessionResponse, Session, SubmitTurnResponse } from "@demesne/protocol";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { cleanName, NAME_PROMPT } from "../src/chat-name.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

describe("cleanName", () => {
  test("keeps a short name and strips what models wrap it in", () => {
    expect(cleanName("Tab names")).toBe("Tab names");
    expect(cleanName("Title: \"fixing the reconnect test\".\n\nI picked this because…")).toBe("Fixing the reconnect test");
    expect(cleanName("  **Daemon log rotation**  ")).toBe("Daemon log rotation");
  });

  test("refuses replies that are not a name", () => {
    expect(cleanName("")).toBeNull();
    expect(cleanName("...")).toBeNull();
    expect(cleanName("This chat is about how the daemon rotates its log files when they grow")).toBeNull();
  });
});

describe("naming a chat after its first turn", () => {
  function start(nameChats: boolean, name = "Tab names") {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const asks: string[] = [];
    const processor: TurnProcessor = {
      providerId: "names", modelId: "names-model",
      async listModels() { return [{ id: this.modelId, provider: this.providerId }]; },
      async *stream(messages) {
        const naming = messages[0]?.role === "system" && messages[0].content === NAME_PROMPT;
        asks.push(naming ? "name" : "turn");
        yield { type: "text_delta" as const, delta: naming ? name : "Tabs are named from the first prompt." };
        yield { type: "usage" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    };
    const app: DaemonApp = createDaemonApp({ databasePath: join(directory, "demesne.sqlite"), processor, nameChats });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    cleanup.push(() => app.close(), () => server.stop(true));
    const call = async <T,>(path: string, body?: unknown) => (await (await fetch(new URL(path, server.url), body === undefined ? undefined
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as T;
    const title = async (id: string) => (await call<{ session: Session }>(`/v1/sessions/${id}`)).session.title;
    return { asks, call, title };
  }

  async function settle(check: () => Promise<boolean>) {
    for (let tries = 0; tries < 100 && !(await check()); tries++) await Bun.sleep(20);
  }

  test("names a chat a person is in from what was asked and answered, once", async () => {
    const { asks, call, title } = start(true);
    const { session } = await call<CreateSessionResponse>("/v1/sessions", { title: "why are my tabs called by the first prompt" });
    await call<SubmitTurnResponse>(`/v1/sessions/${session.id}/turns`, { content: "why are my tabs called by the first prompt", permissionMode: "ask" });
    await settle(async () => await title(session.id) === "Tab names");
    expect(await title(session.id)).toBe("Tab names");
    await call<SubmitTurnResponse>(`/v1/sessions/${session.id}/turns`, { content: "and after that?", permissionMode: "ask" });
    await settle(async () => asks.length >= 3);
    await Bun.sleep(50);
    expect(asks).toEqual(["turn", "name", "turn"]);
  });

  test("leaves unattended turns and chats with the option off alone", async () => {
    for (const [nameChats, permissionMode] of [[true, undefined], [false, "ask"]] as const) {
      const { asks, call, title } = start(nameChats);
      const { session } = await call<CreateSessionResponse>("/v1/sessions", { title: "First prompt" });
      await call<SubmitTurnResponse>(`/v1/sessions/${session.id}/turns`, { content: "First prompt", permissionMode });
      await settle(async () => asks.length >= 1);
      await Bun.sleep(80);
      expect(asks).toEqual(["turn"]);
      expect(await title(session.id)).toBe("First prompt");
    }
  });
});
