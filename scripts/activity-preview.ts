import { createPainter, SLASH_COMMANDS, themeNames } from "../packages/brand/src/index.ts";
import { CliContextRail } from "../apps/cli/src/context-rail.ts";
import { Workbench } from "../apps/cli/src/workbench/controller.ts";

// An interactive fixture using the production renderer, without an inference server.
const paint = createPainter(true, process.env.DEMESNE_THEME);
const rail = new CliContextRail({ id: "Activity preview", provider: "demo", contextWindow: 100_000 }, process.cwd());
rail.setBranch("preview");
let queue = "";
const ui = new Workbench({ paint, contextRail: rail, sessionTitle: "A more capable parser", version: "preview", workspaceRoot: process.cwd(),
  onExit: () => { ui.stop(); process.exit(0); }, onInterrupt: () => {},
  queue: { get: () => queue, set: (value) => { queue = value; } },
});
if (!process.stdout.isTTY) throw new Error("Run the activity preview in an interactive terminal.");
// Exercise the optional grouped activity view.
(ui as unknown as { onKeypress(text: string, key: { ctrl: boolean; name: string }): void }).onKeypress("", { ctrl: true, name: "l" });
process.on("SIGTERM", () => { ui.stop(); process.exit(0); });
ui.start();
ui.beginTurn({ userText: "Accept Unicode identifiers without changing ASCII behavior.", at: "14:32" });
ui.assistantDelta("The identifier guard rejects characters above 127.");
for (const [index, path] of ["src/lexer.ts", "src/parser.ts", "tests/parser.test.ts"].entries()) {
  ui.toolRequested({ toolCallId: String(index), name: "read_file", arguments: { path } });
  ui.toolFinished({ toolCallId: String(index), name: "read_file", state: "done", durationMs: 12 });
}
ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/lexer.ts", oldText: "const identifier = /[a-zA-Z_]/;", newText: "const identifier = /[\\p{L}_]/u;" } });
ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done", durationMs: 8 });
ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test"] } });
ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0, durationMs: 1200, message: "42 pass · 0 fail (preview fixture)" });
ui.assistantDelta("Unicode letters are accepted. ASCII behavior is preserved.\n\nOpen the inspector to review the recorded edit and check.");
ui.finishTurn("completed", "Complete · demonstration data");
ui.setFooter("  Activity preview · Ctrl+C exit", "");
while (true) {
  const value = await ui.readPrompt({ history: [], mentions: ["src/parser.ts", "src/theme.ts"], commands: SLASH_COMMANDS });
  if (value === "/theme" || value.startsWith("/theme ")) {
    const names = themeNames();
    const query = value.slice(6).trim();
    if (names.includes(query)) paint.setTheme(query);
    else {
      const index = await ui.choose("Theme", names);
      if (index !== null) paint.setTheme(names[index]!);
    }
  } else if (value === "/model") {
    await ui.choose("Models · preview fixture", ["Activity preview (demo)"]);
  } else if (value === "/sessions") {
    await ui.choose("Sessions · preview fixture", ["A more capable parser"]);
  } else if (value === "/exit") { ui.stop(); break; }
  else {
    ui.beginTurn({ userText: value, at: "now" });
    ui.assistantDelta("This is the interactive activity preview. Run `bun run demesne` to work with your model.");
    ui.finishTurn("completed", "Preview complete");
  }
}
