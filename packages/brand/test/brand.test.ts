import { describe, expect, test } from "bun:test";
import {
  buildCard,
  computePromptVisualLines,
  createPainter,
  formatAssistantHeader,
  formatHelpCard,
  formatInfoCard,
  formatModelsTable,
  formatPermissionCard,
  formatRelativeAge,
  formatSessionPickerLine,
  formatDiffPreview,
  formatFooterLine,
  formatSlashCommandMenu,
  formatSessionsTable,
  formatToolPhaseHeader,
  formatToolResultLine,
  formatTokenCount,
  formatTurnSummary,
  formatTurnReceipt,
  formatUserMessage,
  formatWelcomeCard,
  getBeaconSegments,
  humanToolTitle,
  palette,
  resolveTerminalTheme,
  resolveSlashCommand,
  renderBeaconText,
  renderBeacon,
  renderSpinner,
  sanitizeTerminalText,
  sampleBeaconRGB,
  slashCommandMatches,
  slashCommandCompletion,
  slashCommandValidationError,
  SLASH_COMMANDS,
  terminalPalette,
  TerminalMarkdownStream,
  TerminalReasoningStream,
  textIndexAtVisualColumn,
  toolKindBadge,
  truncateText,
  visibleLength,
  wrapDisplayText,
} from "../src/index.ts";

describe("Demesne Brand & Mathematical Alignment", () => {
  test("palette contains the 10 canonical Demesne colors", () => {
    expect(palette.ink).toBe("#111014");
    expect(palette.paper).toBe("#F7F3EA");
    expect(palette.electric).toBe("#3857EB");
    expect(palette.electricBright).toBe("#8CA3FF");
    expect(palette.signal).toBe("#D63D1F");
    expect(palette.citron).toBe("#B8DB47");
  });

  test("terminal rendering keeps neutral text native and tones down accents", () => {
    const painter = createPainter(true);

    expect(terminalPalette.electric).not.toBe(palette.electric);
    expect(painter.text("body", "paper")).toBe("body");
    expect(painter.text("accent", "electric")).toContain("38;2;102;120;200");
  });

  test("selects a higher-contrast palette for light terminals", () => {
    expect(resolveTerminalTheme(undefined, "15;0")).toBe("dark");
    expect(resolveTerminalTheme(undefined, "0;15")).toBe("light");
    expect(resolveTerminalTheme("dark", "0;15")).toBe("dark");
    expect(createPainter(true, "light").text("accent", "electric")).toContain("38;2;64;87;181");
  });

  test("truncates colored text without splitting terminal escapes", () => {
    const value = createPainter(true).text("a deliberately long status", "electric");
    const truncated = truncateText(value, 10);
    expect(visibleLength(truncated)).toBe(10);
    expect(truncated).toContain("\x1b[38;2;");
    expect(truncated.endsWith("\x1b[39m") || truncated.endsWith("\x1b[0m")).toBe(true);
    expect(visibleLength("古古")).toBe(4);
    expect(visibleLength(truncateText("古古", 3))).toBe(3);
  });

  test("keeps the footer stable and within narrow and wide terminal widths", () => {
    const painter = createPainter(true);
    const left = painter.text("◆ VERIFY (12.4s)", "electric");
    const right = painter.text("✓ verified · qwen3.8 · est ~12.4k/32.8k · 38%", "secondary");
    for (const width of [20, 40, 80, 120]) {
      const footer = formatFooterLine(left, right, width);
      expect(visibleLength(footer)).toBe(width);
    }
    expect(formatFooterLine("", "runtime ready", 20)).toBe("       runtime ready");
  });

  test("terminal streams neutralize provider control sequences", () => {
    expect(sanitizeTerminalText("safe\u001b[2J\u202espoof")).toBe("safe\\u001b[2J\\u202espoof");
    const markdown = new TerminalMarkdownStream(createPainter(false));
    const rendered = markdown.write("answer\u001b]0;owned\u0007\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).toContain("\\u001b");
    expect(rendered).toContain("\\u0007");

    const reasoning = new TerminalReasoningStream(createPainter(false));
    const trace = reasoning.write("think\u001b[2J") + reasoning.flush();
    expect(trace).not.toContain("\u001b");
    expect(trace).toContain("\\u001b");
  });

  test("labels responses with a compact, accurate model identity", () => {
    const header = formatAssistantHeader("qwen3:14b", 100, createPainter(true), "ollama");
    const line = header.split("\n")[0]!;

    expect(line).toContain("qwen3:14b");
    expect(line).toContain("ollama");
    expect(line).not.toContain("local");
    expect(line).not.toContain("DEMESNE");
    expect(line.startsWith("  ")).toBe(true);
    expect(visibleLength(line)).toBeLessThan(40);
  });

  test("labels aggregate turn throughput as effective speed", () => {
    const summary = formatTurnSummary(312.4, "qwen3.8", 1_668, 5.61, 100, createPainter(false));

    expect(summary).toContain("✓ complete · 312.4s · 1668 tok · 5.6 effective tok/s");
  });

  test("separates TTFT from decode throughput in the completion summary", () => {
    const summary = formatTurnSummary(
      90.9,
      "qwen3.8",
      84,
      0.92,
      80,
      createPainter(false),
      85_869,
      16.79,
    );
    expect(summary).toContain("85.9s ttft · 16.8 tok/s decode");
    expect(summary).not.toContain("0.9 effective");
  });

  test("wraps user messages and markdown structures to the requested width", () => {
    const painter = createPainter(false);
    const width = 60;
    const user = formatUserMessage(
      "This user prompt is quite long and must wrap instead of overflowing the configured terminal width.",
      "01:00 PM",
      width,
      painter,
    );
    expect(Math.max(...user.split("\n").map(visibleLength))).toBeLessThanOrEqual(width);

    for (const line of [
      "- This is a deliberately long unordered list item that clearly exceeds sixty visible columns and should wrap\n",
      "1. This is a deliberately long ordered list item that clearly exceeds sixty visible columns and should wrap\n",
      "> This is a deliberately long block quote that clearly exceeds sixty visible columns and should wrap\n",
      "## A heading that is deliberately too long to fit inside sixty columns and should wrap cleanly\n",
    ]) {
      const markdown = new TerminalMarkdownStream(painter, width, 2);
      const output = markdown.write(line);
      expect(Math.max(...output.split("\n").map(visibleLength))).toBeLessThanOrEqual(width);
    }
    expect(wrapDisplayText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapDisplayText("古古古", 4)).toEqual(["古古", "古"]);
  });

  test("bounds wide characters, indentation, tabs, and code in streamed text", () => {
    const painter = createPainter(false);
    const markdown = new TerminalMarkdownStream(painter, 40, 2);
    const output = [
      markdown.write(`${" ".repeat(60)}- 古古古古古古古古古古古古\n`),
      markdown.write("```a-very-long-language-label-that-cannot-fit\n"),
      markdown.write(`${"古".repeat(30)}\tvalue\n`),
      markdown.write("```\n"),
      markdown.flush(),
    ].join("");
    expect(Math.max(...output.split("\n").map(visibleLength))).toBeLessThanOrEqual(40);

    const reasoning = new TerminalReasoningStream(painter, 40);
    const trace = reasoning.write(`${"古".repeat(30)}\tvalue\n`) + reasoning.flush();
    expect(Math.max(...trace.split("\n").map(visibleLength))).toBeLessThanOrEqual(40);
  });

  test("renders one compact, state-distinct line per completed tool", () => {
    const painter = createPainter(false);
    expect(formatToolResultLine("done", "read_file", "src/main.ts", 12, false, 80, painter))
      .toContain("├ ✓ [READ] src/main.ts · 12ms");
    expect(formatToolResultLine("failed", "run_command", "$ bun test", 20, true, 80, painter))
      .toContain("└ × [EXEC] $ bun test · 20ms");
    expect(formatToolResultLine("denied", "run_command", "$ rm file", undefined, true, 80, painter))
      .toContain("└ ! [EXEC] $ rm file");
    const injected = formatToolResultLine("done", "read_file", "safe.ts\nspoof\tcolumn", 1, true, 40, painter);
    expect(injected).not.toContain("\n");
    expect(injected).not.toContain("\t");
    expect(visibleLength(injected)).toBeLessThanOrEqual(40);
  });

  test("renders phase groups and an evidence-only completion receipt", () => {
    const painter = createPainter(false);
    expect(formatToolPhaseHeader("inspect", 3, painter)).toContain("◇ INSPECT · 3 calls");
    expect(formatToolPhaseHeader("change", 1, painter)).toContain("◆ CHANGE · 1 call");
    expect(formatToolPhaseHeader("verify", 1, painter)).toContain("● VERIFY · 1 call");

    const receipt = formatTurnReceipt({
      durationSeconds: 12.4,
      rounds: 3,
      tools: 4,
      changes: [{ operation: "M", path: "src/main.ts", state: "done" }],
      validations: [{ command: "bun test", state: "done", exitCode: 0 }],
      tokenCount: 240,
      decodeTokensPerSec: 15.8,
      width: 80,
      painter,
    });
    expect(receipt).toContain("CHANGES 1");
    expect(receipt).toContain("✓ M src/main.ts");
    expect(receipt).toContain("VERIFY 1");
    expect(receipt).toContain("✓ bun test · exit 0");
    expect(receipt).toContain("complete · 12.4s · 3 rounds · 4 tools · 240 tok");

    const safeReceipt = formatTurnReceipt({
      durationSeconds: 1,
      rounds: 1,
      tools: 1,
      changes: [{ operation: "M", path: "safe.ts\nspoof", state: "done" }],
      validations: [{ command: "bun test\tspoof", state: "done" }],
      width: 40,
      painter,
    });
    expect(safeReceipt).toContain("safe.ts spoof");
    expect(safeReceipt).not.toContain("safe.ts\nspoof");
    expect(safeReceipt).not.toContain("\t");
  });

  test("buildCard guarantees identical visual length across all rows and borders", () => {
    const painter = createPainter(true);
    const card = buildCard({
      title: "Test Card",
      badge: "v1.0",
      rows: [
        { kind: "text", content: "Line 1: Short" },
        { kind: "blank" },
        { kind: "text", content: "Line 2: A much longer line of content that occupies more space" },
        { kind: "divider" },
        { kind: "route" },
        { kind: "text", content: "Line 3: Final row" },
      ],
      width: 80,
      borderColor: "rule",
      painter,
    });

    const lines = card.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (let i = 0; i < lines.length; i++) {
      const lineLen = visibleLength(lines[i]!);
      expect(lineLen).toBe(expectedLen);
    }
  });

  test("welcome card rows are mathematically equal and aligned", () => {
    const painter = createPainter(true);
    const card = formatWelcomeCard({
      model: "qwen3:14b",
      provider: "ollama",
      workspace: "/Users/demo/project",
      permissionMode: "ask",
      width: 90,
      painter,
    });

    expect(card).not.toContain("\x1b[48;2;");

    const lines = card.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (const line of lines) {
      expect(visibleLength(line)).toBe(expectedLen);
    }
  });

  test("help card rows are mathematically equal and aligned", () => {
    const painter = createPainter(true);
    const card = formatHelpCard(painter, 84);
    const lines = card.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (const line of lines) {
      expect(visibleLength(line)).toBe(expectedLen);
    }
  });

  test("filters and renders the slash command menu", () => {
    const matches = slashCommandMatches("/st");

    expect(matches.map((command) => command.name)).toEqual(["/status"]);
    const menu = formatSlashCommandMenu(matches, 0, 80, createPainter(false));
    expect(menu).toContain("› /status");
    expect(slashCommandMatches("ordinary prompt")).toEqual([]);
    expect(slashCommandMatches("/cont").map((command) => command.name)).toEqual(["/context"]);
    expect(slashCommandMatches("/theme")).toEqual([]);
    expect(slashCommandMatches("/thinking")).toEqual([]);
  });

  test("uses one grammar for canonical commands, aliases, arguments, and completion", () => {
    const newSession = resolveSlashCommand("/new release hardening");
    expect(newSession?.command.id).toBe("new");
    expect(newSession?.argument).toBe("release hardening");
    expect(newSession && slashCommandValidationError(newSession)).toBeNull();
    expect(newSession && slashCommandCompletion(newSession.command)).toBe("/new ");

    expect(resolveSlashCommand("/switch exact-session-id")?.command.id).toBe("resume");
    expect(resolveSlashCommand("/quit")?.command.id).toBe("exit");
    expect(resolveSlashCommand("/newspaper")).toBeNull();

    const missingId = resolveSlashCommand("/resume")!;
    expect(slashCommandValidationError(missingId)).toBe("Usage: /resume <id>");
    const extraArgument = resolveSlashCommand("/status now")!;
    expect(slashCommandValidationError(extraArgument)).toBe("Usage: /status");
  });

  test("exposes session management commands through the same grammar", () => {
    expect(slashCommandMatches("/ren").map((command) => command.name)).toEqual(["/rename"]);
    expect(slashCommandMatches("/exp").map((command) => command.name)).toEqual(["/export"]);
    expect(resolveSlashCommand("/archive")?.command.id).toBe("delete");

    const rename = resolveSlashCommand("/rename Parser hardening")!;
    expect(slashCommandValidationError(rename)).toBeNull();
    expect(slashCommandValidationError(resolveSlashCommand("/rename")!)).toBe("Usage: /rename <title>");

    const exportJson = resolveSlashCommand("/export json")!;
    expect(slashCommandValidationError(exportJson)).toBeNull();
    const filter = resolveSlashCommand("/sessions parser")!;
    expect(slashCommandValidationError(filter)).toBeNull();
    expect(slashCommandCompletion(filter.command)).toBe("/sessions ");
    expect(slashCommandMatches("/mod").map((command) => command.name)).toEqual(["/model"]);
    expect(slashCommandValidationError(resolveSlashCommand("/model local")!)).toBeNull();
    expect(slashCommandMatches("/di").map((command) => command.name)).toEqual(["/diff"]);
    expect(slashCommandValidationError(resolveSlashCommand("/diff")!)).toBeNull();
    expect(slashCommandValidationError(resolveSlashCommand("/undo src/a.ts")!)).toBeNull();
    expect(slashCommandValidationError(resolveSlashCommand("/undo")!)).toBeNull();
    expect(slashCommandMatches("/pl").map((command) => command.name)).toEqual(["/plan"]);
    expect(slashCommandValidationError(resolveSlashCommand("/plan")!)).toBe("Usage: /plan <prompt>");
    expect(slashCommandValidationError(resolveSlashCommand("/plan tighten the loop")!)).toBeNull();
  });

  test("matches and resolves custom commands from a provided list", () => {
    const custom = {
      id: "custom:review" as const,
      name: "/review" as const,
      aliases: [],
      argument: "optional" as const,
      argumentLabel: "arguments",
      description: "Review the working tree",
      section: "session" as const,
    };
    expect(slashCommandMatches("/rev", [custom]).map((command) => command.name)).toEqual(["/review"]);
    expect(slashCommandMatches("/rev", SLASH_COMMANDS)).toEqual([]);
    expect(resolveSlashCommand("/review src/a.ts", [custom])?.argument).toBe("src/a.ts");
    const menu = formatSlashCommandMenu([custom], 0, 80, createPainter(false));
    expect(menu).toContain("/review");
    expect(menu).toContain("Review the working tree");
  });

  test("help reflects the single-model reasoning-off runtime", () => {
    const help = formatHelpCard(createPainter(false), 84);

    expect(help).toContain("Session Commands");
    expect(help).toContain("/status");
    expect(help).not.toContain("/models");
    expect(help).not.toContain("/thinking");
  });

  test("info card rows are mathematically equal and aligned", () => {
    const painter = createPainter(true);
    const card = formatInfoCard({
      sessionId: "s1-uuid-1234",
      title: "Hardening journal",
      turnCount: 4,
      model: "qwen3:14b",
      provider: "ollama",
      contextWindow: 32_768,
      workspace: "/Users/demo/project",
      width: 80,
      painter,
    });

    const lines = card.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (const line of lines) {
      expect(visibleLength(line)).toBe(expectedLen);
    }
    expect(card).toContain("32.8k tokens");
  });

  test("sessions table rows are mathematically equal and aligned", () => {
    const painter = createPainter(true);
    const table = formatSessionsTable(
      [
        { id: "s1-12345678", title: "Storage Refactor", turnCount: 3, root: "/tmp/workspace" },
        { id: "s2-abcdef12", title: "Daemon Testing", turnCount: 1 },
      ],
      "s1-12345678",
      84,
      painter,
    );

    const lines = table.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (const line of lines) {
      expect(visibleLength(line)).toBe(expectedLen);
    }
  });

  test("renders truthful session age, status, and selector details", () => {
    const now = Date.parse("2026-08-30T12:00:00.000Z");
    const table = formatSessionsTable(
      [{
        id: "exact-session-id-12345678",
        title: "Runtime hardening",
        turnCount: 4,
        root: "/tmp/project",
        updatedAt: "2026-08-30T10:00:00.000Z",
        status: "completed",
      }],
      undefined,
      80,
      createPainter(false),
      now,
    );
    expect(table).toContain("2h ago");
    expect(table).toContain("4 turns");
    expect(table).toContain("completed");
    expect(table).toContain("project");
    expect(formatRelativeAge("2026-08-30T11:58:00.000Z", now)).toBe("2m ago");

    const selector = formatSessionPickerLine({
      id: "exact-session-id-12345678",
      title: "Runtime hardening",
      turnCount: 4,
      status: "completed",
    }, 0, 3, 60, createPainter(false));
    expect(selector).toContain("1/3");
    expect(selector).toContain("exact-se");
  });

  test("keeps core UI surfaces within 40, 80, and 120 columns with and without color", () => {
    for (const width of [40, 80, 120]) {
      for (const enabled of [false, true]) {
        const painter = createPainter(enabled);
        const surfaces = [
          formatWelcomeCard({
            model: "qwen3.8-q4_0-32k-b256-with-a-long-suffix",
            provider: "llama.cpp",
            workspace: "/Users/demo/a/deliberately/long/workspace/path",
            permissionMode: "ask",
            width,
            painter,
          }),
          formatHelpCard(painter, width),
          formatInfoCard({
            sessionId: "long-session-id-1234567890-abcdefghijklmnopqrstuvwxyz",
            title: "A deliberately long session title used to prove responsive rendering",
            turnCount: 42,
            model: "qwen3.8-q4_0-32k-b256",
            provider: "llama.cpp",
            contextWindow: 32_768,
            workspace: "/Users/demo/a/deliberately/long/workspace/path",
            width,
            painter,
          }),
          formatSessionsTable([{
            id: "exact-session-id-12345678",
            title: "A deliberately long recent session title",
            turnCount: 42,
            root: "/Users/demo/a/deliberately/long/workspace/path",
            updatedAt: "2026-08-30T10:00:00.000Z",
            status: "completed",
          }], undefined, width, painter, Date.parse("2026-08-30T12:00:00.000Z")),
          formatPermissionCard(
            "write a deliberately long and potentially dangerous path in the current workspace",
            "write_file",
            width,
            painter,
          ),
          formatAssistantHeader(
            "qwen3.8-q4_0-32k-b256-with-a-deliberately-long-suffix",
            width,
            painter,
            "a-provider-name-that-is-also-deliberately-long",
            "12:34 PM",
          ),
        ];
        for (const surface of surfaces) {
          const lines = surface.split("\n").filter(Boolean);
          expect(Math.max(...lines.map(visibleLength))).toBeLessThanOrEqual(width);
          if (!enabled) expect(surface).not.toContain("\x1b");
        }
      }
    }
    expect(visibleLength(renderBeacon(0, "thinking", 12, createPainter(false)))).toBe(12);
  });

  test("neutralizes control and multiline content in session labels", () => {
    const painter = createPainter(false);
    const table = formatSessionsTable([{
      id: "session-id",
      title: "unsafe\x1b]0;owned\x07\nsecond line",
      turnCount: 0,
      status: "empty",
    }], undefined, 40, painter);
    const picker = formatSessionPickerLine({
      id: "session-id",
      title: "unsafe\x1b[2J\nsecond line",
      turnCount: 0,
      status: "empty",
    }, 0, 1, 40, painter);
    expect(table).not.toContain("\x1b");
    expect(table).not.toContain("\x07");
    expect(table).toContain("\\u00");
    expect(picker).not.toContain("\n");
    expect(visibleLength(picker)).toBeLessThanOrEqual(40);
  });

  test("models table rows are mathematically equal and aligned", () => {
    const painter = createPainter(true);
    const table = formatModelsTable(
      [
        { id: "qwen3:14b", provider: "ollama", contextWindow: 32_768 },
        { id: "llama-3.3-70b", provider: "lm-studio" },
      ],
      80,
      painter,
    );

    const lines = table.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (const line of lines) {
      expect(visibleLength(line)).toBe(expectedLen);
    }
    expect(table).toContain("32.8k ctx");
    expect(table).toContain("context unknown");
    expect(formatTokenCount(128_000)).toBe("128k");
  });

  test("permission card rows are mathematically equal and aligned", () => {
    const painter = createPainter(true);
    const card = formatPermissionCard("Replace answer.txt with 42", "edit_file", 76, painter);
    const lines = card.split("\n").filter((l) => l.trim().length > 0);
    const expectedLen = visibleLength(lines[0]!);

    for (const line of lines) {
      expect(visibleLength(line)).toBe(expectedLen);
    }
  });

  test("maps tool identifiers to human-readable titles", () => {
    expect(humanToolTitle("read_file")).toBe("Host File Read");
    expect(humanToolTitle("edit_file")).toBe("File Edit");
    expect(humanToolTitle("run_command")).toBe("Host Shell Command");
    expect(humanToolTitle("search_files")).toBe("Workspace Search");
  });

  test("streams unboxed terminal markdown cleanly", () => {
    const painter = createPainter(true);
    const stream = new TerminalMarkdownStream(painter, 80);

    const chunk1 = stream.write("# Architecture\nHere is **important** information:\n- first item\n- second item\n");
    expect(chunk1).toContain("Architecture");
    expect(chunk1).toContain("•");

    const chunk2 = stream.write("```typescript\nconst a = 1;\n```\n");
    expect(chunk2).toContain("┌── [typescript]");
    expect(chunk2).toContain("const");
    expect(chunk2).toContain("└──");

    // Strips structural XML wrapper tags outside code blocks
    const tagged = stream.write("<response>\n  Hi there! How can I assist you today?\n</response>\n");
    expect(tagged).not.toContain("<response>");
    expect(tagged).not.toContain("</response>");
    expect(tagged).toContain("Hi there!");

    // Preserves XML tags inside code blocks
    const codeWithTags = stream.write("```xml\n<response>\n  <status>ok</status>\n</response>\n```\n");
    expect(codeWithTags).toContain("<response>");
    expect(codeWithTags).toContain("</response>");
  });

  test("renders streamed markdown tables with wrapped cells", () => {
    const stream = new TerminalMarkdownStream(createPainter(true), 64, 2);
    const output = [
      stream.write("| Path | Contents |\n|---|---|\n| apps/cli | Interactive terminal"),
      stream.write(" client with streaming output and a command palette that must wrap cleanly. |\n"),
      stream.write("| apps/daemon | HTTP server, scheduler, context planning, tools, and benchmark harnesses. |\n\n"),
      stream.flush(),
    ].join("");
    const lines = output.trimEnd().split("\n");

    expect(output).toContain("┌");
    expect(output).toContain("apps/cli");
    expect(output).toContain("command palette");
    expect(output).not.toContain("|---|---|");
    expect(lines.every((line) => visibleLength(line) <= 64)).toBe(true);
    expect(lines.filter((line) => line.includes("streaming") || line.includes("command palette"))
      .every((line) => line.includes("│"))).toBe(true);
  });

  test("uses stacked table records on narrow terminals", () => {
    const stream = new TerminalMarkdownStream(createPainter(false), 30, 2);
    const output = stream.write([
      "| Path | Contents |",
      "|---|---|",
      "| apps/cli | Interactive terminal client with streaming output. |",
    ].join("\n")) + stream.flush();

    expect(output).toContain("Path: apps/cli");
    expect(output).toContain("Contents:");
    expect(output).not.toContain("┌");
    expect(output.split("\n").every((line) => visibleLength(line) <= 30)).toBe(true);
  });

  test("handles table escapes and uses the latest terminal width", () => {
    const stream = new TerminalMarkdownStream(createPainter(false), 80, 2);
    expect(stream.write("| Expression | Meaning |\n|:---|---:|\n")).toBe("");
    stream.setWidth(44);
    const output = stream.write("| `left|right` | escaped\\|pipe |\n\n");

    expect(output).toContain("left|right");
    expect(output).toContain("escaped|pipe");
    expect(output.split("\n").every((line) => visibleLength(line) <= 44)).toBe(true);
  });

  test("allocates more table width to descriptive columns", () => {
    const stream = new TerminalMarkdownStream(createPainter(false), 80, 2);
    const output = stream.write([
      "| Path | Role | Notes |",
      "|---|---|---|",
      "| src/app | Server | A deliberately long explanation that benefits from substantially more horizontal space. |",
      "",
    ].join("\n")) + stream.flush();
    const topRule = output.split("\n").find((line) => line.startsWith("  ┌"));
    const spans = topRule?.slice(3, -1).split("┬").map(visibleLength) ?? [];

    expect(spans).toHaveLength(3);
    expect(spans[2]!).toBeGreaterThan(spans[0]!);
    expect(spans[2]!).toBeGreaterThan(spans[1]!);
  });

  test("keeps non-table pipe prose as ordinary text", () => {
    const stream = new TerminalMarkdownStream(createPainter(false), 60, 2);
    const output = stream.write("Use A | B when comparing alternatives.\nNext line.\n") + stream.flush();
    expect(output).toContain("Use A | B when comparing alternatives.");
    expect(output).toContain("Next line.");
    expect(output).not.toContain("┌");
  });

  test("aligns and wraps model prose within the conversation width", () => {
    const stream = new TerminalMarkdownStream(createPainter(true), 40, 2);
    const output = stream.write("A deliberately long model response that should stay aligned with its heading and reasoning.\n");
    const lines = output.trimEnd().split("\n");

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.startsWith("  "))).toBe(true);
    expect(lines.every((line) => visibleLength(line) <= 40)).toBe(true);
  });

  test("wraps streamed reasoning with a rail on every visual line", () => {
    const painter = createPainter(true);
    const stream = new TerminalReasoningStream(painter, 30);
    const output = [
      stream.write("This reasoning arrives in small"),
      stream.write(" chunks and should wrap neatly.\n\nSecond paragraph."),
      stream.flush(),
    ].join("");
    const lines = output.trimEnd().split("\n");

    expect(lines.map((line) => line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""))).toEqual([
      "  │ This reasoning arrives",
      "  │ in small chunks and",
      "  │ should wrap neatly.",
      "  │",
      "  │ Second paragraph.",
    ]);
    expect(lines.every((line) => visibleLength(line) <= 30)).toBe(true);
  });

  test("adapts buffered response formatting after a terminal resize", () => {
    const reasoning = new TerminalReasoningStream(createPainter(false), 80);
    reasoning.write("A buffered sentence ");
    reasoning.setWidth(26);
    const reasoningOutput = reasoning.write("continues after shrinking the terminal.\n") + reasoning.flush();
    expect(reasoningOutput.trimEnd().split("\n").every((line) => visibleLength(line) <= 26)).toBe(true);

    const markdown = new TerminalMarkdownStream(createPainter(false), 80, 2);
    markdown.setWidth(40);
    const markdownOutput = markdown.write("A response line that must wrap at its new width.\n");
    expect(markdownOutput.trimEnd().split("\n").every((line) => visibleLength(line) <= 40)).toBe(true);
  });

  test("computes dynamic beacon colors and segment structure", () => {
    const rgb = sampleBeaconRGB(0.5, "reasoning");
    expect(rgb).toHaveLength(3);
    expect(rgb.every((c) => c >= 0 && c <= 255)).toBe(true);

    const segments = getBeaconSegments(0.2, "thinking", 10);
    expect(segments).toHaveLength(10);
    expect(segments[0]?.char).toBe("◖");
    expect(segments[segments.length - 1]?.char).toBe("◗");
    expect(segments.every((s) => s.hex.startsWith("#"))).toBe(true);

    const animated = renderBeaconText("qwen3:14b", 0.5, "thinking", createPainter(true));
    expect(visibleLength(animated)).toBe(9);
    expect(animated).toContain("\x1b[38;2;");

    const plain = renderBeaconText("qwen3:14b", 0.5, "thinking", createPainter(false));
    expect(plain).toBe("qwen3:14b");
  });

  test("renders the quiet single-accent activity spinner", () => {
    const painter = createPainter(true);
    const frames = [0, 0.3, 0.6].map((phase) => renderSpinner(phase, "thinking", painter));
    expect(frames.every((frame) => visibleLength(frame) === 1)).toBe(true);
    expect(new Set(frames).size).toBeGreaterThan(1);
    expect(frames[0]).toContain("\x1b[38;2;");

    const accent = renderSpinner(0, "tool", painter, "signal");
    expect(accent).toContain("\x1b[38;2;");
    expect(renderSpinner(0, "tool", createPainter(false))).toBe(renderSpinner(0, "tool", createPainter(false), "signal"));
  });

  test("classifies tool identifiers with badges and beacon activities", () => {
    expect(toolKindBadge("read_file")).toEqual({
      chip: "READ",
      color: "electric",
      title: "Host File Read",
      beaconActivity: "loading",
    });
    expect(toolKindBadge("edit_file")).toEqual({
      chip: "EDIT",
      color: "citron",
      title: "File Edit",
      beaconActivity: "tool",
    });
    expect(toolKindBadge("run_command")).toEqual({
      chip: "EXEC",
      color: "signal",
      title: "Host Shell Command",
      beaconActivity: "tool",
    });
    expect(humanToolTitle("unsafe\x1b[2J_tool")).not.toContain("\x1b");
  });

  test("formats compact unified diff previews", () => {
    const diff = formatDiffPreview("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;", 4, createPainter(false));
    expect(diff).toEqual([
      "  const a = 1;",
      "- const b = 2;",
      "+ const b = 3;",
    ]);
  });

  test("computes multiline visual wrapping and paragraph layout for chat prompt input", () => {
    // 1. Single short line
    const single = computePromptVisualLines("hello", 3, 40);
    expect(single.lines).toEqual(["hello"]);
    expect(single.cursorLine).toBe(0);
    expect(single.cursorCol).toBe(3);

    // 2. Multiline paragraphs separated by \n
    const multiPara = computePromptVisualLines("First paragraph\nSecond paragraph", 18, 40);
    expect(multiPara.lines).toEqual(["First paragraph", "Second paragraph"]);
    expect(multiPara.cursorLine).toBe(1);
    expect(multiPara.cursorCol).toBe(2); // 'S', 'e' -> offset 2

    // 3. Long text wrapping across visual lines without truncation
    const longText = "the chat box seems to not make a new paragraph. dnlasdknaslkdnalskdnasldnalsdknasldknasldknasldkasdnlaskdnalskdnasldknasldlkasdnlaskdnalsdknas";
    const wrapped = computePromptVisualLines(longText, longText.length, 50);
    expect(wrapped.lines.length).toBeGreaterThan(1);
    expect(wrapped.lines.every((line) => line.length <= 50)).toBe(true);
    expect(wrapped.cursorLine).toBe(wrapped.lines.length - 1);
    expect(wrapped.cursorCol).toBe(wrapped.lines[wrapped.lines.length - 1]!.length);

    const wide = computePromptVisualLines("古古古古", "古古古古".length, 4);
    expect(wide.lines).toEqual(["古古", "古古"]);
    expect(wide.cursorCol).toBe(4);
    expect(textIndexAtVisualColumn("古a", 2)).toBe(1);
  });
});
