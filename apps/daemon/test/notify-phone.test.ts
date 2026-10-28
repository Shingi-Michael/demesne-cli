import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "@demesne/config";
import { notifyPhoneTool, ntfy, routineMessage, type Phone } from "../src/notify-phone.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const context = { workspaceRoot: "/nonexistent", signal: new AbortController().signal };

describe("ntfy", () => {
  test("posts the text, with the title, priority and token as ntfy expects", async () => {
    const received: { headers: Headers; body: string; path: string }[] = [];
    const server = Bun.serve({ port: 0, async fetch(request) {
      received.push({ headers: request.headers, body: await request.text(), path: new URL(request.url).pathname });
      return Response.json({ id: "1" });
    } });
    servers.push(server);
    await ntfy(`http://127.0.0.1:${server.port}/mike-assistant-7f3k2p9q`, "tk_1").send({ title: "Dentist — Thursday", text: "3pm, bring the form", urgent: true });
    expect(received[0]!.path).toBe("/mike-assistant-7f3k2p9q");
    expect(received[0]!.body).toBe("3pm, bring the form");
    expect(received[0]!.headers.get("priority")).toBe("high");
    expect(received[0]!.headers.get("authorization")).toBe("Bearer tk_1");
    const title = received[0]!.headers.get("title")!.match(/^=\?UTF-8\?B\?(.*)\?=$/)![1]!;
    expect(Buffer.from(title, "base64").toString()).toBe("Dentist — Thursday");
  });

  test("says why a send failed", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("unauthorized", { status: 401 }) });
    servers.push(server);
    await expect(ntfy(`http://127.0.0.1:${server.port}/topic-aaaaaaaaaaaaaaaa`).send({ text: "x" })).rejects.toThrow("HTTP 401");
    await expect(ntfy("http://127.0.0.1:9/topic-aaaaaaaaaaaaaaaa").send({ text: "x" })).rejects.toThrow("Can't reach ntfy");
  });
});

describe("notify_phone", () => {
  test("asks first in a chat you're at, and says what it would send", () => {
    const tool = notifyPhoneTool({ async send() {} });
    expect(tool.permission({ title: "Dentist", text: "3pm" })).toEqual({ kind: "execute", summary: "Send to your phone: Dentist" });
  });

  test("sends, then stops after the hourly limit", async () => {
    const sent: string[] = [];
    const phone: Phone = { async send(message) { sent.push(message.text); } };
    let clock = 0;
    const tool = notifyPhoneTool(phone, 2, () => clock);
    await tool.execute({ text: "one" }, context);
    await tool.execute({ text: "two" }, context);
    await expect(tool.execute({ text: "three" }, context)).rejects.toThrow("TOO_MANY");
    clock = 3_600_001;
    await tool.execute({ text: "four" }, context);
    await expect(tool.execute({ text: " " }, context)).rejects.toThrow("MISSING_TEXT");
    expect(sent).toEqual(["one", "two", "four"]);
  });
});

describe("a routine's message", () => {
  test("is its answer, or a note that it didn't finish; nothing when you stopped it", () => {
    expect(routineMessage("Morning brief", "completed", "Dentist at 3pm.\n")).toEqual({ title: "Morning brief", text: "Dentist at 3pm." });
    expect(routineMessage("Morning brief", "failed", "")?.text).toContain("didn't finish");
    expect(routineMessage("Morning brief", "cancelled", "")).toBeNull();
    expect(routineMessage("Morning brief", "interrupted", "")).toBeNull();
  });
});

describe("[assistant] ntfy config", () => {
  const load = (text: string) => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-ntfy-config-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "config.toml"), text);
    return loadConfig({ userConfigPath: join(directory, "config.toml"), includeProject: false, env: {} }).config;
  };

  test("reads the topic and its token", () => {
    expect(load('[assistant]\nntfy = "https://ntfy.sh/mike-assistant-7f3k2p9q"\nntfy_token = "tk_1"\n').assistant)
      .toEqual({ ntfy: "https://ntfy.sh/mike-assistant-7f3k2p9q", ntfyToken: "tk_1" });
    expect(load('[assistant]\nntfy = "http://100.64.0.2/mike-assistant-7f3k2p9q"\n').assistant?.ntfy).toBe("http://100.64.0.2/mike-assistant-7f3k2p9q");
  });

  test("refuses a guessable topic or plain http over the internet", () => {
    expect(() => load('[assistant]\nntfy = "https://ntfy.sh/mike"\n')).toThrow(ConfigError);
    expect(() => load('[assistant]\nntfy = "http://ntfy.sh/mike-assistant-7f3k2p9q"\n')).toThrow(ConfigError);
  });
});
