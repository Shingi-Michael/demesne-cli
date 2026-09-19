#!/usr/bin/env bun
/// A scripted OpenAI-compatible provider for exercising the CLI without a model.
///
/// The harness is easiest to judge against a turn that actually runs tools, but
/// pointing a real model at it is slow and nondeterministic. This serves a fixed
/// scenario over the chat-completions API so `bun run ui:preview` style work and
/// PTY smoke tests get the same turn every time.
///
///   bun scripts/fake-provider.ts [scenario] [port]
///
/// Scenarios:
///   edit   reasoning, one read, prose, an approved edit, a test run  (default)
///   trace  six reads, an edit, then a test run — a long turn
///   fail   a turn whose command fails, to check the failure row
///   sweep  six reads in one round, then an edit and a run — tests collapsing
///
/// Point the CLI at it with a config that names this URL:
///   [provider]
///   url = "http://127.0.0.1:11437/v1"
///   model = "qwen3.8-27b"
///   context_window = 100000
///
/// Steps are derived from the conversation rather than a call counter, so a
/// retried request replays the same step instead of skipping ahead.

const SCENARIOS = ["edit", "trace", "fail", "sweep"] as const;
type Scenario = (typeof SCENARIOS)[number];

const scenario = (process.argv[2] ?? "edit") as Scenario;
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown scenario "${scenario}" — expected one of ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const port = Number(process.argv[3] ?? 11437);

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface Step {
  reasoning?: string[];
  content?: string;
  /// One or more calls issued in the same round. Several here means the model
  /// is calling tools in parallel, which is the shape that exercises the
  /// transcript's inspection collapsing.
  tools?: ToolCall[];
}

/// One step per assistant round. The step index is the number of assistant
/// messages already in the conversation, which is what the client has replayed
/// back to us.
function stepsFor(s: Scenario): Step[] {
  switch (s) {
    case "edit":
      return [
        {
          reasoning: ["the guard ", "rejects ", "high bytes "],
          tools: [{ id: "t1", name: "read_file", arguments: { path: "src/lexer.ts" } }],
        },
        {
          content: "I read the guard. It rejects everything above 127, so I will narrow it to a unicode check.",
          tools: [{
            id: "t2",
            name: "edit_file",
            arguments: {
              path: "src/lexer.ts",
              oldText: 'if (c > 127) throw new Error("bad byte");',
              newText: "if (c > 0x7f) continue;",
            },
          }],
        },
        { tools: [{ id: "t3", name: "run_command", arguments: { argv: ["bun", "test"] } }] },
        { content: "I changed the guard and the tests pass." },
      ];
    case "trace": {
      const reads = [
        "src/lexer.ts",
        "src/parser.ts",
        "src/token.ts",
        "src/ast.ts",
        "src/emitter.ts",
        "src/checker.ts",
      ];
      return [
        ...reads.map((path, index): Step => ({
          content: `Reading ${path} to trace the guard. `,
          tools: [{ id: `r${index}`, name: "read_file", arguments: { path } }],
        })),
        {
          content: "I traced every caller. ",
          tools: [{
            id: "e1",
            name: "edit_file",
            arguments: {
              path: "src/lexer.ts",
              oldText: "export const lexer = () => 1;",
              newText: "export const lexer = () => 2;",
            },
          }],
        },
        { tools: [{ id: "v1", name: "run_command", arguments: { argv: ["bun", "test"] } }] },
        { content: "I narrowed the guard; the suite passes." },
      ];
    }
    case "fail":
      return [
        { tools: [{ id: "f1", name: "run_command", arguments: { argv: ["bun", "test"] } }] },
        { content: "The suite failed, so I will not claim success." },
      ];
    case "sweep": {
      // Six reads issued in a single round: the parallel-call shape that the
      // transcript collapses into one summary row.
      const files = [
        "src/lexer.ts",
        "src/parser.ts",
        "src/token.ts",
        "src/ast.ts",
        "src/emitter.ts",
        "src/checker.ts",
      ];
      return [
        {
          content: "I'll sweep the whole pipeline before touching anything. ",
          tools: files.map((path, index) => ({
            id: `s${index}`,
            name: "read_file",
            arguments: { path },
          })),
        },
        {
          content: "Every caller normalizes first, so the guard only needs to hold for ASCII.",
          tools: [{
            id: "se",
            name: "edit_file",
            arguments: {
              path: "src/lexer.ts",
              oldText: 'if (c > 127) throw new Error("bad byte");',
              newText: "if (c > 0x7f) continue;",
            },
          }],
        },
        { tools: [{ id: "sv", name: "run_command", arguments: { argv: ["bun", "test"] } }] },
        { content: "The sweep is done and the guard is unchanged." },
      ];
    }
  }
}

const steps = stepsFor(scenario);

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(patch: Record<string, unknown>): string {
  return sse({ choices: [{ delta: patch }] });
}

/// Streams one assistant round, then a usage trailer and [DONE].
function roundStream(step: Step): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const push = (text: string) => controller.enqueue(encoder.encode(text));
      for (const chunk of step.reasoning ?? []) {
        push(delta({ reasoning: chunk }));
        await Bun.sleep(140);
      }
      if (step.content) {
        push(delta({ content: step.content }));
        await Bun.sleep(120);
      }
      if (step.tools) {
        push(delta({
          tool_calls: step.tools.map((tool, index) => ({
            index,
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          })),
        }));
        await Bun.sleep(20);
      }
      push(sse({ choices: [], usage: { prompt_tokens: 4200, completion_tokens: 96, total_tokens: 4296 } }));
      push("data: [DONE]\n\n");
      controller.close();
    },
  });
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "qwen3.8-27b", context_length: 100_000 }] });
    }
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    const body = await request.json().catch(() => ({})) as { messages?: Array<{ role?: string }> };
    const assistantRounds = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    const step = steps[Math.min(assistantRounds, steps.length - 1)]!;
    return new Response(roundStream(step), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  },
});

console.error(`fake provider · scenario=${scenario} · http://127.0.0.1:${port}/v1`);
