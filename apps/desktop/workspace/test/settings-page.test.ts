import { expect, test } from "bun:test";
import { glassAlphas, GLASS_DEFAULT, homeWords, notifyKinds, parseNumber, ruleWords, settingsNav, settingsPage, settingsSearch, shortNumber, SETTINGS_ORDER, type SettingsInfo, type SettingsView } from "../settings-page.ts";

const info: SettingsInfo = {
  home: "/Users/mike",
  configPath: "/Users/mike/.demesne/config.toml",
  dataDirectory: "/Users/mike/.demesne",
  server: "http://127.0.0.1:4317",
  allow: [{ rule: "run_command:bun test", mine: true }, { rule: "edit_file:apps/desktop", mine: false }],
  trusted: ["/Users/mike/projects/demesne-cli"],
  subagent: { model: null, models: [{ id: "gpt-6.1-sol", provider: "ChatGPT" }] },
  agent: { maxModelRounds: 64, maxToolCalls: 256, proofMarks: true },
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
  agents: [], chats: { here: 4, all: 9 }, online: true,
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

test("every section draws, and the list has thirteen", () => {
  expect(SETTINGS_ORDER).toHaveLength(13);
  for (const section of SETTINGS_ORDER) expect(settingsPage(view({ section }))).toContain('class="cp-title"');
  const nav = settingsNav({ section: "permissions", query: "", archived: [], info });
  expect(nav).toContain("Back to chats");
  expect(nav).toMatch(/st-nav on"[^>]*>.*Permissions<\/span><span class="st-nav-n">2</);
});

test("permissions list the rules, the trusted folders and the score", () => {
  const html = settingsPage(view({ section: "permissions" }));
  expect(html).toContain("<code>bun test</code>");
  expect(html).toContain("in the project&#39;s config");
  expect(html.match(/Ask again/g)).toHaveLength(1);
  expect(html).toContain("<code>~/projects/demesne-cli</code>");
  expect(html).toContain("Asked you 12 times this week, 31 the week before.");
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

test("the theme word unfolds its choices in place", () => {
  expect(settingsPage(view({ section: "appearance" }))).not.toContain("st-choice");
  const open = settingsPage(view({ section: "appearance", fold: "theme" }));
  expect(open).toContain("Demesne Light");
  expect(open).toContain('st-choice on');
});

test("glass runs from clear to solid, and the default is the built look", () => {
  expect(glassAlphas(GLASS_DEFAULT)).toEqual({ shell: 0.325, panel: 0.498 });
  expect(glassAlphas(0)).toEqual({ shell: 0.1, panel: 0.33 });
  expect(glassAlphas(100)).toEqual({ shell: 1, panel: 1 });
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
