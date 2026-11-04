import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCli, agentArgs, agentIdOf, agentPrompt, parseAgentLine } from "../src/agent-cli.ts";
import { claudeRun, fakeProcess } from "./agent-cli-fakes.ts";

async function collect(stream: AsyncIterable<{ type: string; delta?: string }>) {
  let text = "", reasoning = "";
  for await (const event of stream) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "reasoning_delta") reasoning += event.delta;
  }
  return { text, reasoning };
}

describe("agent tools", () => {
  test("a chat is an agent's by its model", () => {
    expect(agentIdOf("agent:claude")).toBe("claude");
    expect(agentIdOf("agent:nope")).toBeNull();
    expect(agentIdOf("gpt-6.1-sol")).toBeNull();
  });

  test("reads Claude Code, Codex and Gemini lines as steps and answers", () => {
    expect(parseAgentLine("claude", JSON.stringify(claudeRun("s1", "Done")[1]), "/w")).toEqual([{ said: "Looking at the file." }, { step: "Read src/a.ts" }]);
    expect(parseAgentLine("claude", JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }), "/w")).toEqual([{ error: "Not logged in" }]);
    expect(parseAgentLine("codex", JSON.stringify({ type: "thread.started", thread_id: "t9" }), "/w")).toEqual([{ session: "t9" }]);
    expect(parseAgentLine("codex", JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bash -lc ls" } }), "/w")).toEqual([{ step: "Ran bash -lc ls" }]);
    expect(parseAgentLine("codex", JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "/w/b.ts" }] } }), "/w")).toEqual([{ step: "Edited b.ts" }]);
    expect(parseAgentLine("gemini", JSON.stringify({ type: "tool_use", tool_name: "read_file", parameters: { absolute_path: "/w/c.ts" } }), "/w")).toEqual([{ step: "Read c.ts" }]);
    expect(parseAgentLine("claude", "not json", "/w")).toEqual([]);
  });

  test("starts a session it can resume, and gives the chat so far only the first time", () => {
    expect(agentArgs("claude", "hi", { id: "u1", fresh: true })).toContain("--session-id");
    expect(agentArgs("claude", "hi", { id: "u1", fresh: false })).toContain("--resume");
    expect(agentArgs("codex", "hi", { id: "t9", fresh: false }).slice(-3)).toEqual(["resume", "t9", "hi"]);
    const messages = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "first" }, { role: "assistant" as const, content: "answer one" }, { role: "user" as const, content: "second" }];
    expect(agentPrompt(messages, false)).toBe("second");
    expect(agentPrompt(messages, true)).toBe("Earlier in this chat:\n\nPerson: first\n\nAssistant: answer one\n\nNow:\nsecond");
  });

  test("passes the model you picked to each tool, and nothing else when you picked none", () => {
    expect(agentArgs("claude", "hi", null)).not.toContain("--model");
    const claude = agentArgs("claude", "hi", { id: "u1", fresh: false }, { model: "opus" });
    expect(claude.slice(claude.indexOf("--model"), claude.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
    expect(claude.at(-1)).toBe("hi");
    const codex = agentArgs("codex", "hi", { id: "t9", fresh: false }, { model: "gpt-6.1-sol", effort: "high" });
    expect(codex).toEqual(["exec", "--json", "--full-auto", "--skip-git-repo-check", "-c", 'model="gpt-6.1-sol"', "-c", 'model_reasoning_effort="high"', "resume", "t9", "hi"]);
    expect(agentArgs("gemini", "hi", null, { model: "flash" }).slice(-2)).toEqual(["-m", "flash"]);
    // A name that could be read as a flag never reaches the command line.
    expect(agentArgs("claude", "hi", null, { model: "--dangerously-skip-permissions" })).not.toContain("--dangerously-skip-permissions");
  });

  test("keeps each agent's pick, shows what it runs on, and reads the tool's own default", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-models-"));
    try {
      const home = join(directory, "home");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
      writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n\n[profiles.x]\nmodel = "other"\n');
      const cli = new AgentCli(join(directory, "data"), { which: () => "/bin/x", home });
      expect(cli.runsOn("claude").label).toBe("Sonnet");
      expect(cli.runsOn("claude").options[0]).toEqual({ id: "", label: "Tool default", note: "Sonnet, from your Claude Code settings" });
      const codex = cli.runsOn("codex", ["gpt-6.1-sol", "gpt-6-astra"]);
      expect(codex.label).toBe("gpt-6-astra · Medium");
      expect(codex.options.map((option) => option.id)).toEqual(["", "gpt-6.1-sol", "gpt-6-astra"]);
      expect(codex.efforts).toEqual(["low", "medium", "high"]);
      expect(cli.runsOn("gemini").label).toBe("Tool default");

      cli.choose("codex", "gpt-6.1-sol", "high");
      cli.choose("claude", "opus");
      expect(new AgentCli(join(directory, "data"), { home }).runsOn("codex").label).toBe("gpt-6.1-sol · High");
      expect(cli.runsOn("claude")).toMatchObject({ model: "opus", label: "Opus", efforts: null });
      expect(() => cli.choose("claude", "opus", "high")).toThrow();
      expect(() => cli.choose("gemini", "-x")).toThrow();
      cli.choose("claude", null);
      expect(cli.runsOn("claude").model).toBeNull();
      expect(JSON.parse(readFileSync(join(directory, "data", "agent-models.json"), "utf8"))).toEqual({ codex: { model: "gpt-6.1-sol", effort: "high" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("runs the tool in the chat's folder and keeps its session for the next turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-cli-"));
    try {
      const runs: { argv: string[]; cwd: string }[] = [];
      const cli = new AgentCli(directory, {
        which: (command) => command === "claude" ? "/bin/claude" : null,
        spawn: (argv, cwd) => { runs.push({ argv, cwd }); return fakeProcess(claudeRun(argv[argv.indexOf("--session-id") + 1] ?? argv[argv.indexOf("--resume") + 1]!, "All tests pass.")); },
      });
      expect(cli.agents().map((agent) => agent.name)).toEqual(["Claude Code"]);
      const first = await collect(cli.inference("claude", "chat1", "/w").stream([{ role: "user", content: "check it" }], [], new AbortController().signal));
      expect(first.text).toBe("All tests pass.");
      expect(first.reasoning).toContain("Read src/a.ts\n");
      expect(first.reasoning).toContain("Ran bun test\n");
      expect(first.reasoning).toContain("Looking at the file.");
      expect(runs[0]!.cwd).toBe("/w");
      const session = cli.sessionFor("chat1", "claude");
      expect(session).toBe(runs[0]!.argv[runs[0]!.argv.indexOf("--session-id") + 1]!);
      await collect(cli.inference("claude", "chat1", "/w").stream([{ role: "user", content: "again" }], [], new AbortController().signal));
      expect(runs[1]!.argv).toContain("--resume");
      expect(runs[1]!.argv).toContain(session!);
      expect(runs[1]!.argv.at(-1)).toBe("again");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("a tool that fails says why", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-cli-"));
    try {
      const cli = new AgentCli(directory, { which: () => "/bin/codex", spawn: () => fakeProcess([], 1, "codex: not signed in") });
      await expect(collect(cli.inference("codex", "c", "/w").stream([{ role: "user", content: "x" }], [], new AbortController().signal))).rejects.toThrow("Codex stopped (exit 1): codex: not signed in");
      const missing = new AgentCli(directory, { which: () => null });
      await expect(collect(missing.inference("gemini", "c", "/w").stream([], [], new AbortController().signal))).rejects.toThrow("isn't installed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
