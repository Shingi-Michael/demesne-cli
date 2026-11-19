import { describe, expect, test } from "bun:test";
import type { ProviderMessage, ProviderToolDefinition } from "@demesne/providers";
import { comparePrefix, PrefixMeter, requestShape } from "../src/cache-prefix.ts";
import { runPrefixCheck } from "../../../scripts/check-cache-prefix.ts";

const tool = (name: string, description = "Does a thing."): ProviderToolDefinition => ({ name, description, inputSchema: { type: "object", properties: {} } });
const chat = (system: string, ...rest: ProviderMessage[]): ProviderMessage[] => [{ role: "system", content: system }, ...rest];
const user = (content: string): ProviderMessage => ({ role: "user", content });
const answer = (content: string): ProviderMessage => ({ role: "assistant", content });

describe("cache meter", () => {
  test("a request that only adds to the end keeps all of the one before", () => {
    const meter = new PrefixMeter();
    const tools = [tool("read_file"), tool("run_command")];
    const first = meter.measure("chat", chat("Be careful.", user("Hello")), tools, 1_000);
    expect(first).toEqual({ sentChars: first.sentChars, previousChars: null, keptChars: null, brokeAt: null, idleMs: null });
    const second = meter.measure("chat", chat("Be careful.", user("Hello"), answer("Hi."), user("And now?")), tools, 61_000);
    expect(second.brokeAt).toBeNull();
    expect(second.keptChars).toBe(first.sentChars);
    expect(second.previousChars).toBe(first.sentChars);
    expect(second.idleMs).toBe(60_000);
    expect(second.cause).toBeUndefined();
  });

  test("a line added to the instructions is named, and only what came before it is kept", () => {
    const before = requestShape(chat("Line one.\nLine three.", user("Hello")), [tool("read_file")], 0);
    const after = requestShape(chat("Line one.\nPlan mode: read only.\nLine three.", user("Hello")), [tool("read_file")], 5);
    const report = comparePrefix(before, after);
    expect(report.brokeAt).toBe("instructions");
    expect(report.keptChars).toBe("Line one.\n".length);
    expect(report.cause).toBe('The instructions changed, now reading "Plan mode: read only."');
    // Taking the line away again is a break too, and says which line went.
    expect(comparePrefix(after, before).cause).toBe('The instructions changed, no longer reading "Plan mode: read only."');
  });

  test("a tool put into the list is named", () => {
    const messages = chat("Be careful.", user("Hello"));
    const before = requestShape(messages, [tool("edit_file"), tool("read_file")], 0);
    const added = comparePrefix(before, requestShape(messages, [tool("edit_file"), tool("git_history"), tool("read_file")], 0));
    expect(added.brokeAt).toBe("tools");
    expect(added.cause).toBe("The tool list changed: added git_history");
    expect(added.keptChars).toBeLessThan(before.instructions.length + before.tools.reduce((total, entry) => total + entry.text.length, 0));
    expect(comparePrefix(before, requestShape(messages, [tool("edit_file")], 0)).cause).toBe("The tool list changed: removed read_file");
    expect(comparePrefix(before, requestShape(messages, [tool("edit_file"), tool("read_file", "Reads.")], 0)).cause).toBe("The tool list changed: the definition of read_file changed");
    expect(comparePrefix(before, requestShape(messages, [tool("read_file"), tool("edit_file")], 0)).cause).toBe("The tool list changed: the order changed");
  });

  test("a rewritten earlier message breaks the history from there on", () => {
    const long: ProviderMessage = { role: "tool", toolCallId: "c1", content: "x".repeat(4000) };
    const call: ProviderMessage = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] };
    const before = requestShape(chat("Be careful.", user("Read it"), call, long, answer("Read.")), [tool("read_file")], 0);
    const after = requestShape(chat("Be careful.", user("Read it"), call, { ...long, content: "[cut]" }, answer("Read."), user("Next")), [tool("read_file")], 0);
    const report = comparePrefix(before, after);
    expect(report.brokeAt).toBe("history");
    expect(report.messageIndex).toBe(2);
    expect(report.cause).toBe("Earlier history was rewritten: a tool result, message 3 of 4");
    expect(report.keptChars).toBeLessThan(report.previousChars! - 4000);
    const shorter = comparePrefix(before, requestShape(chat("Be careful.", user("Read it")), [tool("read_file")], 0));
    expect(shorter.cause).toBe("The history got shorter");
  });

  test("a picture that stops being sent counts as a rewrite", () => {
    const shot: ProviderMessage = { role: "tool", toolCallId: "c1", content: "{}", imageInputs: [{ artifactId: "a1", url: "data:image/png;base64,AAAA" }] };
    const before = requestShape(chat("Be careful.", shot), [], 0);
    expect(comparePrefix(before, requestShape(chat("Be careful.", shot, user("Next")), [], 0)).brokeAt).toBeNull();
    expect(comparePrefix(before, requestShape(chat("Be careful.", { ...shot, imageInputs: undefined }, user("Next")), [], 0)).brokeAt).toBe("history");
  });

  test("each chat is measured against its own last request", () => {
    const meter = new PrefixMeter(2);
    meter.measure("a", chat("One.", user("Hello")), [], 0);
    meter.measure("b", chat("Two.", user("Hello")), [], 0);
    expect(meter.measure("a", chat("One.", user("Hello"), user("More")), [], 0).brokeAt).toBeNull();
    // Only the latest chats are kept; an older one starts over, which is not a break.
    meter.measure("c", chat("Three.", user("Hello")), [], 0);
    expect(meter.measure("b", chat("Two.", user("Hello"), user("More")), [], 0).previousChars).toBeNull();
  });
});

describe("prefix check", () => {
  test("a scripted chat through the engine breaks its prefix only where KNOWN says", async () => {
    const check = await runPrefixCheck();
    expect(check.problems).toEqual([]);
    expect(check.requests.length).toBe(22);
    // What a cache can reuse today; it should only ever go up.
    expect(check.keptChars / check.sentChars).toBeGreaterThan(0.5);
  }, 60_000);
});
