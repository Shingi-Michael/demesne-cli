import { expect, test } from "bun:test";
import { ruleGroups, glassAlphas, GLASS_DEFAULT, homeWords, notifyKinds, parseNumber, ruleWords, settingsNav, settingsPage, settingsSearch, shortNumber, SETTINGS_ORDER, type SettingsInfo, type SettingsView } from "../settings-page.ts";

const info: SettingsInfo = {
  home: "/Users/mike",
  configPath: "/Users/mike/.demesne/config.toml",
  dataDirectory: "/Users/mike/.demesne",
  server: "http://127.0.0.1:4317",
  allow: [{ rule: "run_command:bun test", mine: true }, { rule: "edit_file:apps/desktop", mine: false }],
  trusted: ["/Users/mike/projects/demesne-cli"],
  subagent: { model: null, models: [{ id: "gpt-6.1-sol", provider: "ChatGPT" }] },
  agent: { maxModelRounds: 64, maxToolCalls: 256 },
  drive: { maxActiveMinutes: 240, maxTokens: 2_000_000, maxTasks: 16 },
  images: null,
  heartbeat: true,
  mcp: [{ name: "github", command: "npx server-github", mine: true }],
  restart: [],
};
const view = (patch: Partial<SettingsView> = {}): SettingsView => ({
  section: "general", query: "", mac: true, glass: true, desktop: true, home: info.home, info, error: "", fold: "",
  general: { openOn: "home", awake: true },
  notify: { wait: true, error: true, drive: true, done: false },
  appearance: { theme: "demesne", themes: [{ name: "demesne", label: "Demesne" }, { name: "demesne-light", label: "Demesne Light" }], canUndo: false, zoom: 1, glass: 25, ink: "neutral" },
  archived: [], usage: [], modelWords: (model) => model.id,
  permissions: { mode: "ask", asks: { thisWeek: 12, lastWeek: 31 } },
  drive: { project: "demesne-cli", auto: { on: true, quietMinutes: 20, perDay: 3, usedToday: 1 } },
  model: { words: "GPT-6.1 Sol", provider: "ChatGPT", reasoning: "low", chatgpt: "" },
  providers: { items: [], signingIn: null, message: null },
  connectors: { servers: [{ name: "github", state: "ready", tools: 26 }], heartbeat: true },
  agents: [], chats: { here: 4, all: 9 }, online: true, plans: [],
  ...patch,
});

test("notifications carry over the old single choice", () => {
  expect(notifyKinds(null, null)).toEqual({ wait: true, error: true, drive: true, done: true });
  expect(notifyKinds('{"done":false}', null)).toEqual({ wait: true, error: true, drive: true, done: false });
  expect(notifyKinds('{"wait":false}', null)).toEqual({ wait: false, error: true, drive: true, done: true });
  expect(notifyKinds(null, "always")).toEqual({ wait: true, error: true, drive: true, done: true });
  expect(notifyKinds(null, "never")).toEqual({ wait: false, error: false, drive: false, done: false });
  expect(notifyKinds('{"done":true,"drive":false}', "never")).toEqual({ wait: true, error: true, drive: false, done: true });
  expect(notifyKinds("not json", null).wait).toBe(true);
});

test("notification settings describe native delivery on every desktop platform", () => {
  for (const mac of [true, false]) {
    const html = settingsPage(view({ section: "notifications", mac }));
    expect(html).toContain("Linux, macOS and Windows");
    expect(html).toContain("out of focus");
    expect(html).toContain("A chat waits on you");
    expect(html).toContain("A chat finishes");
    expect(html).not.toContain("Mac banners");
  }
});

test("learned rules read as words", () => {
  expect(ruleWords("run_command:bun test")).toEqual({ what: "bun test", how: "This command, exactly" });
  expect(ruleWords("run_command:git log *")).toEqual({ what: "git log", how: "This command, with any arguments" });
  expect(ruleWords("edit_file:apps/desktop")).toEqual({ what: "apps/desktop", how: "Edits in this folder and below" });
  expect(ruleWords("mcp__github__create_issue").what).toBe("github · create issue");
});

test("numbers are typed as you would say them", () => {
  expect(parseNumber("400k")).toBe(400_000);
  expect(parseNumber("2M")).toBe(2_000_000);
  expect(parseNumber("1,500")).toBe(1_500);
  expect(parseNumber("lots")).toBeNull();
  expect(shortNumber(2_000_000)).toBe("2M");
  expect(shortNumber(64)).toBe("64");
  expect(homeWords("/Users/mike/projects/x", "/Users/mike")).toBe("~/projects/x");
});

test("every section draws, and the list has fourteen with Overview first", () => {
  expect(SETTINGS_ORDER).toHaveLength(14);
  expect(SETTINGS_ORDER[0]).toBe("overview");
  for (const section of SETTINGS_ORDER) expect(settingsPage(view({ section }))).toContain('class="cp-title"');
  const nav = settingsNav({ section: "permissions", query: "", archived: [], info });
  expect(nav).toContain("Back to chats");
  expect(nav).toMatch(/st-nav on"[^>]*>.*Permissions<\/span><span class="st-nav-n">2</);
});

test("permissions list the rules, the trusted folders and the score, kept short", () => {
  const html = settingsPage(view({ section: "permissions" }));
  expect(html).toContain(">bun test</code>");
  expect(html).toContain("in the project&#39;s config");
  // Only your own rule can be taken back; the project's has no ×.
  expect(html.match(/Ask again about/g)).toHaveLength(1);
  expect(html).toContain('pm-mode on" aria-pressed="true"');
  expect(html).toContain("<code title=\"/Users/mike/projects/demesne-cli\">~/projects/demesne-cli</code>");
  expect(html).toContain("asked you 12 times this week");
  // Many rules sit in groups by program, one short line each; a group unfolds its rules.
  const long682 = `grep -rn ${"apps/cli/src/main.ts ".repeat(32)}`.trim();
  const many = { ...info, allow: [
    ...Array.from({ length: 15 }, (_, i) => ({ rule: `run_command:git log -${i}`, mine: true })),
    ...Array.from({ length: 11 }, (_, i) => ({ rule: `run_command:grep -n x${i} apps/cli/src/main.ts`, mine: true })),
    { rule: `run_command:${long682}`, mine: true }, { rule: "run_command:pwd", mine: true },
    { rule: "edit_file:apps/desktop", mine: true }, { rule: "edit_file:.github/workflows", mine: true },
  ], trusted: Array.from({ length: 9 }, (_, i) => `/Users/mike/p${i}`) };
  expect(ruleGroups(many.allow).map((group) => [group.head, group.rules.length])).toEqual([["git", 15], ["grep", 12], ["edits", 2], ["pwd", 1]]);
  const short = settingsPage(view({ section: "permissions", info: many }));
  expect(short.match(/class="pm-chip pm-group/g)).toHaveLength(3);
  expect(short).toContain("<code>git</code><small>15</small>");
  expect(short).toContain(">pwd</code>");
  expect(short).not.toContain("log -14");
  expect(short.match(/class="pm-folder"/g)).toHaveLength(4);
  expect(short).toContain("Show all 9");
  const open = settingsPage(view({ section: "permissions", info: many, fold: "rules:grep" }));
  expect(open.match(/class="pm-rule"/g)).toHaveLength(12);
  expect(open).toContain('aria-expanded="true"');
  // Past three one-offs, they share one "other" group; file rules say what they let it do.
  const oneOffs = [...many.allow, ...["awk NR==FNR", "diff -u a b", "date"].map((command) => ({ rule: `run_command:${command}`, mine: true })), { rule: "delete_path:donkeys.py", mine: true }, { rule: "edit_file:donkeys.py", mine: true }];
  expect(ruleGroups(oneOffs).map((group) => [group.head, group.rules.length])).toEqual([["git", 15], ["grep", 12], ["edits", 3], ["other", 5]]);
  const others = settingsPage(view({ section: "permissions", info: { ...info, allow: oneOffs }, fold: "rules:other" }));
  expect(others).toContain("<em>delete</em><code");
  expect(others.match(/class="pm-rule"/g)).toHaveLength(5);
  // Search still finds a rule.
  expect(settingsSearch(view({ query: "log -14", info: many })).found.map(({ page }) => page.id)).toEqual(["permissions"]);
});

test("a setting the daemon reads at start says so until it restarts", () => {
  expect(settingsPage(view({ section: "models" }))).not.toContain("Restart now");
  expect(settingsPage(view({ section: "models", info: { ...info, restart: ["agent.max_tool_calls"] } }))).toContain("Restart now");
});

test("search looks through every section and marks the words", () => {
  const { found } = settingsSearch(view({ query: "awake tokens" }));
  expect(found.map(({ page }) => page.id)).toEqual(["general", "drive"]);
  const html = settingsPage(view({ query: "palette" }));
  expect(html).toContain("<mark>palette</mark>");
  expect(settingsPage(view({ query: "zzzz" }))).toContain("Nothing matches");
});

test("themes are cards drawn in their own colours, with a live preview above", () => {
  const html = settingsPage(view({ section: "appearance", appearance: { ...view().appearance, themes: [{ name: "demesne", label: "Demesne", colors: { bg: "#111111", surface: "#222222", accent: "#3366ff", text: "#eeeeee" } }, { name: "demesne-light", label: "Demesne Light", light: true }] } }));
  expect(html).toContain("ap-preview");
  expect(html).toContain('ap-card on" aria-pressed="true"');
  expect(html).toContain("--ac:#3366ff");
  expect(html).toContain("Demesne Light");
  expect(html).toContain("Make one…");
});

test("the overview says how it's set up, shows six tiles and what's worth a look", () => {
  const plan = { provider: "ChatGPT", plan: "plus", at: new Date().toISOString(), primary: { usedPercent: 82, windowMinutes: 300, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, secondary: { usedPercent: 18, windowMinutes: 10_080, resetsAt: null } };
  const usage = [{ provider: "ChatGPT", model: "gpt-6.1-sol", local: false, turns: 3, finished: 3, failed: 0, toolCalls: 0, toolErrors: 0, tokensPerSecond: 50, firstTokenMs: 800, checkedTurns: 0, passingTurns: 0, driveRuns: 1, driveLanded: 1, lastUsed: "", daily: [...Array(29).fill(0), 3] }];
  const html = settingsPage(view({ section: "overview", plans: [plan], usage, info: { ...info, restart: ["app.update"] }, connectors: { servers: [{ name: "linear", state: "failed", tools: 0 }], heartbeat: false } }));
  expect(html).toContain("Answers come from");
  expect(html).toContain("on your ChatGPT Plus plan");
  expect(html).toContain("asks before edits and commands");
  expect(html).toContain("Drive starts on its own after 20 quiet minutes");
  expect(html.match(/class="ov-tile[ "]/g)).toHaveLength(6);
  expect(html).toContain("82%");
  expect(html).toContain("A newer daemon came with this app");
  expect(html).toContain("The linear connector didn&#39;t start");
  expect(html).toContain("is 82% used");
  expect(settingsPage(view({ section: "overview" }))).toContain("Nothing needs you");
});

test("usage draws each day stacked by model", () => {
  const usage = [{ provider: "ChatGPT", model: "a", local: false, turns: 2, finished: 2, failed: 0, toolCalls: 0, toolErrors: 0, tokensPerSecond: null, firstTokenMs: null, checkedTurns: 0, passingTurns: 0, driveRuns: 0, driveLanded: 0, lastUsed: "", daily: [1, 0, 1] }];
  const html = settingsPage(view({ section: "usage", usage }));
  expect(html.match(/class="us-day"/g)).toHaveLength(3);
  expect(html).toContain("2 in 3 days");
});

test("glass runs from nearly clear to solid, with text backing only while it is clear", () => {
  expect(glassAlphas(GLASS_DEFAULT)).toEqual({ shell: 0.193, panel: 0.218, back: 0.202 });
  expect(glassAlphas(0)).toEqual({ shell: 0.05, panel: 0.08, back: 0.34 });
  expect(glassAlphas(100)).toEqual({ shell: 1, panel: 1, back: 0 });
  expect(glassAlphas(140)).toEqual(glassAlphas(100));
  expect(glassAlphas(-10)).toEqual(glassAlphas(0));
  for (let glass = 0; glass <= 100; glass++) {
    const { shell, panel } = glassAlphas(glass);
    expect(shell).toBeLessThanOrEqual(panel);
    expect(panel - shell).toBeLessThanOrEqual(0.231);
  }
});

test("Glass shows where the window is glass (the Mac, Hyprland), Ink only for Demesne's own themes", () => {
  const page = settingsPage(view({ section: "appearance", appearance: { ...view().appearance, glass: 40, ink: "warm" } }));
  expect(page).toContain('value="40" data-glass');
  expect(page).toMatch(/class="on"[^>]*title="Warm"/);
  expect(settingsPage(view({ section: "appearance", mac: false, glass: false }))).not.toContain("data-glass");
  expect(settingsPage(view({ section: "appearance", mac: false, glass: true }))).toContain("data-glass");
  expect(settingsPage(view({ section: "appearance", appearance: { ...view().appearance, theme: "custom-sunset" } }))).not.toContain("st-inks");
});

test("Appearance offers an opt-in external System palette and a separate saved path",()=>{
  const html=settingsPage(view({section:"appearance",appearance:{...view().appearance,systemSource:{enabled:false,path:"/home/me/.local/state/kuru/theme/demesne.json"}}}));
  expect(html).toContain("Use an external System palette");
  expect(html).toContain('role="switch" aria-checked="false"');
  expect(html).toContain('data-action="system-theme-toggle"');
  expect(html).toContain('id="system-theme-source"');
  expect(html).toContain('value="/home/me/.local/state/kuru/theme/demesne.json"');
  expect(html).toContain("Save path");
  expect(html).toContain("does not enable it");
});
test("System palette errors and paths are safely escaped in Settings",()=>{
  const html=settingsPage(view({section:"appearance",appearance:{...view().appearance,systemSource:{enabled:true,path:'/tmp/"<palette>.json',error:"<script>bad</script>"}}}));
  expect(html).toContain('role="switch" aria-checked="true"');
  expect(html).toContain("Could not reload");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&quot;&lt;palette&gt;");
});
