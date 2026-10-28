/// Settings, as a page in place of the conversation. The sidebar becomes its
/// list (Back to chats, a search over every row, then the sections in four
/// groups) and the page holds the chosen section: a title, one line on what
/// it holds, and groups of rows on a hairline ring. Each row is a title, one
/// quiet line and its control on the right: a switch, words that unfold in
/// place, a number you type, or a link. Nothing opens a menu.
import type { ModelScore, NearbyAgent } from "@demesne/protocol";
import type { ChatsPageChat } from "./chats-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;

/// The config.toml keys Settings may write, what they hold, and whether the
/// daemon reads them only when it starts.
export const SETTINGS_KEYS: Record<string, { kind: "int" | "text" | "bool"; max?: number; clear?: boolean; restart?: boolean }> = {
  "agent.max_model_rounds": { kind: "int", max: 10_000, clear: true, restart: true },
  "agent.max_tool_calls": { kind: "int", max: 100_000, clear: true, restart: true },
  "drive.max_active_minutes": { kind: "int", max: 24 * 60, clear: true },
  "drive.max_tokens": { kind: "int", max: 100_000_000, clear: true },
  "drive.max_tasks": { kind: "int", max: 64, clear: true },
  "images.model": { kind: "text", restart: true },
  "heartbeat.enabled": { kind: "bool", restart: true },
};

/// What the host reads for Settings from config.toml and the daemon.
export interface SettingsInfo {
  home: string;
  configPath: string;
  dataDirectory: string;
  server: string;
  /// Rules it no longer asks about; `mine` when your own config holds it.
  allow: { rule: string; mine: boolean }[];
  /// Folders you trust, or null when the daemon can't say.
  trusted: string[] | null;
  subagent: { model: string | null; models: { id: string; provider: string }[] };
  agent: { maxModelRounds: number; maxToolCalls: number };
  drive: { maxActiveMinutes: number; maxTokens: number; maxTasks: number };
  /// Null when no image service is set up.
  images: { model: string | null } | null;
  heartbeat: boolean;
  mcp: { name: string; command: string; mine: boolean }[];
  /// Keys changed since the daemon started that it reads only then.
  restart: string[];
}

export type SettingsSection = "general" | "notifications" | "appearance" | "keys" | "archived" | "usage" | "permissions" | "drive" | "models" | "providers" | "connectors" | "heartbeat" | "data";
const icon = (path: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${path}</svg>`;
export const SETTINGS_GROUPS: [string, [SettingsSection, string, string][]][] = [
  ["You", [
    ["general", "General", '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'],
    ["notifications", "Notifications", '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>'],
    ["appearance", "Appearance", '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z"/>'],
    ["keys", "Keyboard shortcuts", '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>'],
    ["archived", "Archived chats", '<rect x="3.5" y="5" width="17" height="4" rx="1"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/>'],
    ["usage", "Usage", '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
  ]],
  ["How it works", [
    ["permissions", "Permissions", '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/>'],
    ["drive", "Drive", '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'],
    ["models", "Models", '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 2v4M14 2v4M10 18v4M14 18v4M2 10h4M2 14h4M18 10h4M18 14h4"/>'],
    ["providers", "Providers", '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/>'],
  ]],
  ["Around it", [
    ["connectors", "Connectors", '<path d="M9 7 4 12l5 5M15 7l5 5-5 5"/>'],
    ["heartbeat", "Heartbeat", '<path d="M3 12h4l2-5 4 10 2-5h6"/>'],
  ]],
  ["This computer", [
    ["data", "Data and daemon", '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'],
  ]],
];
export const SETTINGS_ORDER = SETTINGS_GROUPS.flatMap(([, items]) => items.map(([id]) => id));
export const isSettingsSection = (value: unknown): value is SettingsSection => SETTINGS_ORDER.includes(value as SettingsSection);

/// Native desktop notifications, each kind with its own switch.
export type NotifyKind = "wait" | "error" | "drive" | "done";
export const NOTIFY_KINDS: [NotifyKind, string, string][] = [
  ["wait", "A chat waits on you", "An approval or a question"],
  ["error", "A chat stops with an error", "The model or a tool failed and the turn ended"],
  ["drive", "Drive has a branch ready", "A fix or an idea it worked on, waiting for your review"],
  ["done", "A chat finishes", "Every answer that ends while you look elsewhere"],
];
/// Reads the saved switches; the older single choice (When it needs you,
/// Always, Never) carries over.
export function notifyKinds(saved: string | null, old: string | null): Record<NotifyKind, boolean> {
  const needs = { wait: true, error: true, drive: true, done: true };
  try {
    const parsed = saved ? JSON.parse(saved) as Record<string, unknown> : null;
    if (parsed && typeof parsed === "object") return Object.fromEntries(NOTIFY_KINDS.map(([kind]) => [kind, typeof parsed[kind] === "boolean" ? parsed[kind] : needs[kind]])) as Record<NotifyKind, boolean>;
  } catch {}
  if (old === "always") return { wait: true, error: true, drive: true, done: true };
  if (old === "never") return { wait: false, error: false, drive: false, done: false };
  return needs;
}

/// A learned rule in words: what it covers, and how.
export function ruleWords(rule: string): { what: string; how: string } {
  const at = rule.indexOf(":");
  const tool = at < 0 ? rule : rule.slice(0, at), value = at < 0 ? "" : rule.slice(at + 1);
  if (tool.startsWith("mcp__")) {
    const [, server = "", name = ""] = tool.split("__");
    return { what: name ? `${server} · ${name.replace(/_/g, " ")}` : server, how: "A connector's tool, every time" };
  }
  if (tool === "run_command") return value.endsWith(" *") ? { what: value.slice(0, -2), how: "This command, with any arguments" } : { what: value, how: "This command, exactly" };
  const verb = ({ edit_file: "Edits", write_file: "New files", delete_path: "Deletes", move_path: "Moves", apply_patch: "Patches" } as Record<string, string>)[tool] ?? tool.replace(/_/g, " ");
  return value ? { what: value, how: `${verb} in this folder and below` } : { what: tool.replace(/_/g, " "), how: "Every time" };
}

/// Long numbers said short: 2,000,000 tokens is 2M.
export function shortNumber(value: number) {
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 10_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return value.toLocaleString("en-US");
}
/// What you typed into a number field: digits with commas, or 2M / 400k.
export function parseNumber(text: string): number | null {
  const match = text.trim().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!match) return null;
  const scale = match[2] ? (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  return Math.round(Number(match[1]) * scale);
}

/// ~ for your home folder.
export const homeWords = (path: string, home: string) => home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

export interface SettingsView {
  section: SettingsSection;
  query: string;
  mac: boolean;
  /** The window is glass (the desktop blurs behind it). */
  glass: boolean;
  desktop: boolean;
  home: string;
  info: SettingsInfo | null;
  error: string;
  /// The row whose words are unfolded, like "theme" or "subagent".
  fold: string;
  general: { openOn: "home" | "last"; awake: boolean };
  notify: Record<NotifyKind, boolean>;
  appearance: { theme: string; themes: { name: string; label: string }[]; canUndo: boolean; zoom: number | null; glass: number; ink: Ink; systemSource?: {enabled:boolean;path:string;error?:string} | null };
  archived: ChatsPageChat[] | null;
  usage: ModelScore[] | null;
  modelWords: (model: { id: string; displayName?: string }) => string;
  permissions: { mode: "ask" | "edits" | "plan" | "auto" | null; asks: { thisWeek: number; lastWeek: number } | null };
  drive: { project: string; auto: { on: boolean; quietMinutes: number; perDay: number; usedToday: number } | null };
  model: { words: string; provider: string; reasoning: string; chatgpt: string | null };
  providers: { items: { key: string; label: string; detail: string; status: string; active?: boolean }[]; signingIn: string | null; message: string | null };
  connectors: { servers: { name: string; state: "starting" | "ready" | "failed"; tools: number }[]; heartbeat: boolean };
  agents: NearbyAgent[];
  chats: { here: number; all: number };
  online: boolean;
}

/// Settings › Appearance › Ink: the hue every grey is made from (Demesne's own themes).
export const INKS = [["neutral", "Neutral", "#8e8e93"], ["warm", "Warm", "#c58b5c"], ["cool", "Cool", "#6f8fd6"], ["moss", "Moss", "#7da37a"], ["rose", "Rose", "#c47a9b"]] as const;
export type Ink = (typeof INKS)[number][0];
export const isInk = (value: unknown): value is Ink => INKS.some(([id]) => id === value);
/// Glass, 0 (clear) to 100 (solid), as the shell's and the panel's opacity.
export function glassAlphas(glass: number) {
  const g = Math.min(100, Math.max(0, glass)) / 100;
  // Keep navigation readable over wallpaper: a gentler gap than the old
  // quadratic shell curve, while the work panel remains the deeper plane.
  return { shell: Math.round((0.1 + 0.9 * g) * 1000) / 1000, panel: Math.round((0.33 + 0.67 * g) * 1000) / 1000 };
}
export const GLASS_DEFAULT = 25;

export interface SettingsRow { title: string; line?: string; control?: string; keywords?: string; fold?: string }
interface Group { name: string; right?: string; rows: SettingsRow[]; hint?: string }
interface Page { id: SettingsSection; title: string; sub: string; groups: Group[]; note?: string }

const toggle = (on: boolean, action: string, data: Record<string, unknown>, label: string) =>
  `<button type="button" class="settings-toggle${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${h(label)}" data-action="${action}" data-args="${h(JSON.stringify(data))}"><i></i></button>`;
const segments = (options: [string, boolean, string, Record<string, unknown>][], label: string) =>
  `<div class="settings-segments" role="group" aria-label="${h(label)}">${options.map(([text, on, action, data]) => `<button type="button" class="${on ? "on" : ""}" aria-pressed="${on}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${h(text)}</button>`).join("")}</div>`;
const link = (action: string, label: string, data: Record<string, unknown> = {}, extra = "") => btn(action, h(label), data, `st-link${extra}`);
/// A word that unfolds its choices in place, under the row.
const word = (fold: string, label: string, open: boolean) =>
  `<button type="button" class="st-word${open ? " open" : ""}" data-action="settings-fold" data-args="${h(JSON.stringify({ fold }))}" aria-expanded="${open}">${h(label)}<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
const choices = (label: string, items: [string, boolean, string, Record<string, unknown>][], heading = "") =>
  `<div class="st-choices" role="group" aria-label="${h(label)}">${heading ? `<span class="st-choice-head">${h(heading)}</span>` : ""}${items.map(([text, on, action, data]) => `<button type="button" class="st-choice${on ? " on" : ""}" aria-pressed="${on}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${h(text)}</button>`).join("")}</div>`;
/// A number you type; Enter or leaving the field saves it.
const number = (key: string, value: number, unit: string, label: string) =>
  `<label class="st-num"><input type="text" inputmode="numeric" data-key="${h(key)}" data-value="${value}" value="${h(value.toLocaleString("en-US"))}" aria-label="${h(label)}" autocomplete="off" spellcheck="false">${unit ? `<span>${h(unit)}</span>` : ""}</label>`;
const kbd = (keys: string) => keys.split(" ").map((item) => `<kbd>${h(item)}</kbd>`).join("");

function shortcuts(mac: boolean): Group[] {
  const cmd = mac ? "⌘" : "Ctrl+", alt = mac ? "⌥" : "Alt+";
  const row = (title: string, keys: string, line = ""): SettingsRow => ({ title, line, control: `<span class="st-keys">${kbd(keys)}</span>`, keywords: "shortcut key" });
  return [
    { name: "Anywhere", rows: [row("New chat", `${cmd}N`), row("Search chats", `${cmd}K`), row("Open a folder", `${cmd}O`), row("Settings", `${cmd},`), row("Next and previous chat", "Ctrl+Tab Ctrl+⇧Tab"), row("Drive", `${alt}J`, "Its line, or its ideas"), row("Text size", `${cmd}+ ${cmd}− ${cmd}0`), row("Undo a delete", `${cmd}Z`)] },
    { name: "In the composer", rows: [row("Send", "↵"), row("Steer the turn that is running", "↵", "Delivered after its next step"), row("Queue for after it", `${alt}↵`), row("Change mode", "⇧⇥", "Ask, Accept edits, Plan, Auto"), row("Commands", "/"), row("Files", "@"), row("Take Drive's idea", "Tab", "On Home, when its idea shows in the box"), row("Where a new chat lives", `${alt}P`, "On Home")] },
    { name: "Answering", rows: [row("Pick a choice", "1 9", "On a question or an approval"), row("Close a page or a sheet", "Esc")] },
  ];
}

function pages(view: SettingsView): Page[] {
  const info = view.info;
  const out: Page[] = [];
  const restartNote = (prefixes: string[]) => info?.restart.some((key) => prefixes.some((prefix) => key.startsWith(prefix))) ? "Changed here: applies when the daemon restarts." : undefined;
  out.push({ id: "general", title: "General", sub: "Where Demesne opens and what it keeps doing while you work.", groups: [
    { name: "Starting", rows: [
      { title: "Open on", line: "Where the window lands when you open Demesne", control: segments([["Home", view.general.openOn === "home", "settings-local", { key: "openOn", value: "home" }], ["Last chat", view.general.openOn === "last", "settings-local", { key: "openOn", value: "last" }]], "Open on"), keywords: "launch start home last chat" },
    ] },
    { name: "While it works", rows: [
      ...(view.desktop ? [{ title: "Keep this Mac awake while something runs", line: "A chat's turn or a Drive run; the display may still sleep", control: toggle(view.general.awake, "settings-local", { key: "awake", value: !view.general.awake }, "Keep this Mac awake"), keywords: "sleep awake power battery" }] : []),
      { title: "Closing the window", line: "The daemon keeps running, so Drive, routines and mail carry on", keywords: "quit close background daemon" },
    ] },
  ] });
  out.push({ id: "notifications", title: "Notifications", sub: view.desktop ? "System notifications on Linux, macOS and Windows while the app is out of focus. Each kind has its own switch." : "Banners come from the desktop app.", groups: [
    { name: "Tell me when", rows: NOTIFY_KINDS.map(([kind, title, line]) => ({ title, line, control: view.desktop ? toggle(view.notify[kind], "notify-kind", { kind, on: !view.notify[kind] }, title) : "", keywords: "notifications banners alerts notify" })) },
  ] });
  const systemSource=view.appearance.systemSource;
  const themeLabel = view.appearance.themes.find((item) => item.name === view.appearance.theme)?.label ?? view.appearance.theme;
  const themeGroups: [string, { name: string; label: string }[]][] = [["Yours", []], ["Dark", []], ["Light", []]];
  for (const item of view.appearance.themes) themeGroups[item.name.startsWith("custom-") ? 0 : /light|latte/.test(item.name) ? 2 : 1]![1].push(item);
  out.push({ id: "appearance", title: "Appearance", sub: "How the app looks on this computer.", groups: [
    { name: "Look", rows: [
      { title: "Theme", line: "The palette for the whole app", control: (view.appearance.canUndo ? link("settings-set", "Undo", { method: "theme-undo", args: {} }) : "") + word("theme", themeLabel, view.fold === "theme"), keywords: "colour color dark light palette theme",
        fold: view.fold === "theme" ? themeGroups.filter(([, items]) => items.length).map(([heading, items]) => choices(`${heading} themes`, items.map((item) => [item.label, item.name === view.appearance.theme, "settings-set", { method: "theme", args: { name: item.name } }]), heading)).join("") : "" },
      ...(systemSource ? [
        { title: "Use an external System palette", line: "Off uses Demesne’s own colors and follows system light/dark. On reads the palette file below when System is selected.", control: toggle(systemSource.enabled,"system-theme-toggle",{enabled:!systemSource.enabled},"Use an external System palette"), keywords: "system theme palette external kuru switch" },
        { title: "System palette file", line: systemSource.error ? `Could not reload: ${systemSource.error}. Keeping the last valid palette, or Demesne’s default.` : "A JSON file or symlink on the daemon’s computer. Saving a path does not enable it or change the selected theme.", fold: `<form id="system-theme-source" class="st-text" data-kind="system-theme"><input name="path" value="${h(systemSource.path)}" aria-label="System palette file" maxlength="4096" autocomplete="off" spellcheck="false"><button type="submit" class="st-link">Save path</button></form>`, keywords: "system theme file path symlink kuru external json" },
      ] : []),
      { title: "Make a theme", line: "Answer a few questions and Demesne builds a palette from your answers", control: link("settings-command", "Start", { text: "/themefy " }), keywords: "themefy custom palette" },
      ...(view.desktop && view.glass ? [{ title: "Glass", line: "How much of the desktop shows through the window", control: `<label class="st-range">Clear<input type="range" min="0" max="100" step="1" value="${view.appearance.glass}" data-glass aria-label="Glass">Solid</label>`, keywords: "glass transparent translucent blur vibrancy opacity" }] : []),
      ...(/^demesne(-light)?$/.test(view.appearance.theme) ? [{ title: "Ink", line: "The colour every grey is made from, and the accent with it", control: `<span class="st-inks" role="group" aria-label="Ink">${INKS.map(([id, label, swatch]) => `<button type="button" class="${view.appearance.ink === id ? "on" : ""}" style="--swatch:${swatch}" title="${label}" aria-label="${label}" aria-pressed="${view.appearance.ink === id}" data-action="settings-local" data-args="${h(JSON.stringify({ key: "ink", value: id }))}"></button>`).join("")}</span>`, keywords: "ink tint hue colour color accent warm cool" }] : []),
      ...(view.desktop ? [{ title: "Text size", line: "The size of everything in the window", control: segments(([["Small", 0.9], ["Default", 1], ["Large", 1.1]] as [string, number][]).map(([label, zoom]) => [label, view.appearance.zoom === zoom, "settings-set", { method: "desktop-zoom", args: { zoom } }]), "Text size"), keywords: "zoom font scale" }] : []),
    ] },
  ] });
  out.push({ id: "keys", title: "Keyboard shortcuts", sub: "Every shortcut in one list, by where it works.", groups: shortcuts(view.mac) });
  const archived = view.archived;
  out.push({ id: "archived", title: "Archived chats", sub: "Chats you put away. Restore brings one back to its project.", groups: [
    { name: "Archived", right: archived ? String(archived.length) : "", rows: archived === null ? [{ title: "Reading…" }] : archived.length ? archived.map((chat) => ({ title: chat.title, line: `${chat.workspace ? chat.workspace.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) : "Just a chat"} · archived ${new Date(chat.at).toLocaleDateString([], { month: "short", day: "numeric" })}`, control: link("chats-restore", "Restore", { id: chat.id }), keywords: "archive restore" })) : [{ title: "Nothing archived", line: "Archive a chat from its ⋯ and it waits here" }] },
  ] });
  const scores = (view.usage ?? []).filter((score) => score.turns > 0).sort((a, b) => b.turns - a.turns);
  const most = Math.max(1, ...scores.map((score) => score.turns));
  const runs = scores.reduce((sum, score) => sum + score.driveRuns, 0), landed = scores.reduce((sum, score) => sum + score.driveLanded, 0);
  out.push({ id: "usage", title: "Usage", sub: "The last 30 days, by model, counted from your own chats on this computer.", groups: [
    { name: "By model", right: scores.length ? `${scores.reduce((sum, score) => sum + score.turns, 0)} turns` : "", rows: view.usage === null ? [{ title: "Counting…" }] : scores.length ? scores.map((score) => {
      const ended = score.finished + score.failed;
      return { title: view.modelWords({ id: score.model }), line: [`${score.provider}`, `${score.turns} ${score.turns === 1 ? "turn" : "turns"}`, ended ? `${Math.round((score.finished / ended) * 100)}% finished` : "", score.tokensPerSecond ? `${Math.round(score.tokensPerSecond)} tok/s` : ""].filter(Boolean).join(" · "), control: `<span class="st-bar" aria-hidden="true"><i style="width:${Math.max(3, Math.round((score.turns / most) * 100))}%"></i></span><span class="st-count">${score.turns}</span>`, keywords: "usage turns tokens speed model" };
    }) : [{ title: "Nothing yet", line: "Turns show here once a model has answered" }] },
    { name: "Drive", rows: [{ title: "Runs", line: runs ? `${landed} applied or opened as a PR` : "None in the last 30 days", control: `<span class="st-count">${runs}</span>`, keywords: "drive runs branches" }] },
  ] });
  const rules = info?.allow ?? [], mode = view.permissions.mode;
  out.push({ id: "permissions", title: "Permissions", sub: "What it may do without asking, where it may work, and what it learned you always allow.", groups: [
    ...(mode ? [{ name: "This chat", rows: [{ title: "Mode", line: mode === "ask" ? "Asks before edits and commands" : mode === "edits" ? "Edits without asking; asks before commands" : mode === "plan" ? "Reads and proposes; changes nothing" : "Does everything without asking", control: segments(([["Ask", "ask"], ["Accept edits", "edits"], ["Plan", "plan"], ["Auto", "auto"]] as const).map(([label, value]) => [label, mode === value, "permission-mode", { mode: value }]), "Mode"), keywords: "mode ask accept edits plan auto approvals" }], hint: "Each chat keeps its own; ⇧⇥ changes it in the composer." }] : []),
    { name: "It no longer asks about", right: rules.length ? String(rules.length) : "", rows: info === null ? [{ title: "Reading…" }] : rules.length ? rules.map(({ rule, mine }) => {
      const words = ruleWords(rule);
      return { title: `\`${words.what}\``, line: `${words.how}${mine ? "" : " · in the project's config"}`, control: mine ? link("allow-rule-remove", "Ask again", { rule }, " quiet") : "", keywords: "allow rule always learned approvals" };
    }) : [{ title: "Nothing yet", line: "Always on an approval adds a rule here" }] },
    { name: "Trusted folders", right: info?.trusted?.length ? String(info.trusted.length) : "", rows: info === null ? [{ title: "Reading…" }] : info.trusted === null ? [{ title: "The daemon can't list them", line: "Restart the daemon to update it" }] : info.trusted.length ? info.trusted.map((root) => ({ title: `\`${homeWords(root, view.home)}\``, line: "Its chats read its files and run its commands", control: link("trusted-forget", "Untrust", { root }, " quiet"), keywords: "trust folder project untrust" })) : [{ title: "None yet", line: "A folder asks once, the first time you open it" }] },
  ], note: view.permissions.asks && (view.permissions.asks.thisWeek || view.permissions.asks.lastWeek) ? `Asked you ${view.permissions.asks.thisWeek} ${view.permissions.asks.thisWeek === 1 ? "time" : "times"} this week, ${view.permissions.asks.lastWeek} the week before.` : undefined });
  const auto = view.drive.auto;
  out.push({ id: "drive", title: "Drive", sub: "Drive picks work on its own, each run on its own branch. It never pushes and never needs you.", groups: [
    { name: view.drive.project ? `In ${view.drive.project}` : "In a project", rows: [view.drive.project && auto
      ? { title: "Start on its own", line: `After ${auto.quietMinutes} quiet minutes it runs the top idea, at most ${auto.perDay} a day${auto.usedToday ? ` (${auto.usedToday} today)` : ""}`, control: toggle(auto.on, "drive-auto", { on: !auto.on }, "Start on its own"), keywords: "drive auto quiet start own" }
      : { title: "Start on its own", line: "Open a project to set Drive for it", keywords: "drive auto quiet" }] },
    { name: "How far one mission may go", rows: info ? [
      { title: "Active time", line: "It stops and leaves the branch for you", control: number("drive.max_active_minutes", info.drive.maxActiveMinutes, "min", "Active time in minutes"), keywords: "drive limit minutes time" },
      { title: "Tokens", line: "Planning and coding together", control: number("drive.max_tokens", info.drive.maxTokens, "", "Tokens"), keywords: "drive limit tokens budget" },
      { title: "Tasks", line: "Steps it hands to the coder, at most 64", control: number("drive.max_tasks", info.drive.maxTasks, "", "Tasks"), keywords: "drive limit tasks" },
    ] : [{ title: "Reading…" }], hint: "A mission reads these when it starts." },
  ] });
  const subagent = info?.subagent;
  const subagentLabel = subagent?.model ? view.modelWords({ id: subagent.model }) : "Same as the chat";
  out.push({ id: "models", title: "Models", sub: "Which model answers, what helpers run on, and how far one turn may go.", note: restartNote(["agent.", "images."]), groups: [
    { name: "Answers", rows: [
      { title: "Model", line: `${view.model.words}${view.model.provider ? ` from ${view.model.provider}` : ""}${view.model.reasoning ? `, ${view.model.reasoning} thinking` : ""}. This chat uses it`, control: link("overlay", "Change", { name: "models" }), keywords: "model reasoning thinking effort" },
      ...(view.model.chatgpt !== null ? [{ title: "ChatGPT plan", line: `Usage counts against ${view.model.chatgpt || "your"} plan`, control: link("open-link", "Manage ↗", { url: "https://chatgpt.com/settings/usage" }), keywords: "usage billing account chatgpt" }] : []),
      ...(subagent ? [{ title: "Subagents run on", line: "Helpers a turn starts for side work", control: word("subagent", subagentLabel, view.fold === "subagent"), keywords: "subagent helper model",
        fold: view.fold === "subagent" ? choices("Subagent model", [["Same as the chat", !subagent.model, "subagent-model", { model: null }], ...subagent.models.map((model): [string, boolean, string, Record<string, unknown>] => [view.modelWords({ id: model.id }), subagent.model === model.id, "subagent-model", { model: model.id }])]) : "" }] : []),
      ...(info?.images ? [{ title: "Images", line: "The model that makes pictures when you ask for one", control: `<form class="st-text" data-key="images.model"><input value="${h(info.images.model ?? "")}" aria-label="Image model" autocomplete="off" spellcheck="false"></form>`, keywords: "image picture generation" }] : []),
    ] },
    { name: "Limits for one turn", rows: info ? [
      { title: "Model rounds", line: "A turn stops after this many replies from the model", control: number("agent.max_model_rounds", info.agent.maxModelRounds, "", "Model rounds"), keywords: "limit rounds turn" },
      { title: "Tool calls", line: "And after this many tool calls", control: number("agent.max_tool_calls", info.agent.maxToolCalls, "", "Tool calls"), keywords: "limit tools turn" },
    ] : [{ title: "Reading…" }], hint: "The daemon reads these when it starts." },
  ] });
  out.push({ id: "providers", title: "Providers", sub: "Where models come from: accounts, API keys and model servers on this computer.", groups: [
    { name: "Accounts", rows: [
      ...view.providers.items.map((item) => {
        const signing = view.providers.signingIn === item.key;
        const action = signing ? "provider-cancel" : item.status === "signed-in" ? "provider-signout" : item.status === "signed-out" ? "provider-signin" : "";
        return { title: item.label, line: signing ? "Waiting for your browser…" : `${item.active ? "In use. " : ""}${item.detail}`, control: action ? link(action, signing ? "Cancel" : item.status === "signed-in" ? "Sign out" : "Sign in", { key: item.key }) : "", keywords: "sign in account api key local provider" };
      }),
      { title: "Provider setup", line: view.providers.message ?? "Add a local model server, an API key, or an account", control: link("setup", "Open"), keywords: "add provider configure setup" },
    ] },
  ] });
  const running = new Map(view.connectors.servers.map((server) => [server.name, server]));
  const servers = info?.mcp ?? view.connectors.servers.map((server) => ({ name: server.name, command: "", mine: false }));
  out.push({ id: "connectors", title: "Connectors", sub: "Tools from MCP servers, offered to every chat. Each server runs on this computer.", note: restartNote(["mcp."]), groups: [
    { name: "Servers", right: servers.length ? String(servers.length) : "", rows: [
      ...servers.map((server) => {
        const live = running.get(server.name);
        const state = live ? `<span class="st-state ${live.state}">${live.state === "ready" ? "Ready" : live.state === "starting" ? "Starting" : "Failed"}</span>` : `<span class="st-state">After a restart</span>`;
        return { title: server.name, line: [server.command ? `\`${server.command}\`` : "", live ? `${live.tools} ${live.tools === 1 ? "tool" : "tools"}` : ""].filter(Boolean).join(" · "), control: state + (server.mine ? link("mcp-remove", "Remove", { name: server.name }, " quiet") : ""), keywords: "mcp server connector tools" };
      }),
      { title: "Add a server", line: "A name, and the command that starts it", control: "", keywords: "add mcp server connector", fold: `<form class="st-add" id="mcp-new"><input name="name" placeholder="github" aria-label="Server name" autocomplete="off" spellcheck="false"><input name="command" placeholder="npx @modelcontextprotocol/server-github" aria-label="Command" autocomplete="off" spellcheck="false"><button type="submit" class="st-link">Add</button></form>` },
    ] },
  ] });
  out.push({ id: "heartbeat", title: "Heartbeat", sub: "Agents on this computer and paired ones, like Claude Code and Codex, can message your chats.", note: restartNote(["heartbeat."]), groups: [
    { name: "Heartbeat", rows: [
      { title: "Talk to agents nearby", line: view.connectors.heartbeat ? "On: each chat has an address and mail arrives as a turn" : info?.heartbeat ? "On, but the Heartbeat daemon isn't answering" : "Off", control: info ? toggle(info.heartbeat, "settings-config", { key: "heartbeat.enabled", value: !info.heartbeat }, "Talk to agents nearby") : "", keywords: "heartbeat agents mail claude code codex" },
    ] },
    { name: "Nearby now", right: view.agents.length ? String(view.agents.length) : "", rows: view.agents.length ? view.agents.map((agent) => ({ title: agent.name, line: [agent.project, agent.local ? "on this computer" : agent.node].filter(Boolean).join(" · "), keywords: "agent nearby" })) : [{ title: "No agents nearby", line: "They show here while they run" }] },
  ] });
  out.push({ id: "data", title: "Data and daemon", sub: "Where Demesne keeps your chats, and the daemon that runs them.", groups: [
    { name: "Where it keeps things", rows: info ? [
      { title: "Data folder", line: `\`${homeWords(info.dataDirectory, view.home)}\``, keywords: "data folder database" },
      { title: "Settings file", line: `\`${homeWords(info.configPath, view.home)}\``, keywords: "config toml file" },
    ] : [{ title: "Reading…" }] },
    { name: "The daemon", rows: [
      { title: "Address", line: `${info ? `\`${info.server}\` · ` : ""}${view.online ? "running" : "not answering"}`, keywords: "daemon server address" },
      { title: "Keeps running when you close the window", line: "So Drive, routines and mail go on", keywords: "quit close background" },
      { title: "Restart the daemon", line: info?.restart.length ? "Settings you changed wait for a restart" : "It reads its settings again; waits until nothing is working", control: link("restart-daemon", "Restart", {}, info?.restart.length ? " warn" : ""), keywords: "restart daemon reload" },
    ] },
    { name: "Conversations", rows: [
      { title: "All conversations", line: `${view.chats.all} ${view.chats.all === 1 ? "chat" : "chats"}${view.chats.here !== view.chats.all ? `, ${view.chats.here} in this project` : ""}`, control: link("page-open", "Show", { page: "active" }), keywords: "sessions history chats" },
      { title: "Clean up", line: "Delete empty, quick and old chats; you choose which first", control: link("overlay", "Review", { name: "cleanup" }), keywords: "delete clean sessions" },
    ] },
  ] });
  return out;
}

/// Plain words with `code`, escaped, with the searched words marked.
function words(text: string, marks: string[]) {
  return text.split("`").map((piece, index) => {
    let html = h(piece);
    for (const mark of marks) html = html.replace(new RegExp(`(${mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return index % 2 ? `<code>${html}</code>` : html;
  }).join("");
}
const rowHtml = (row: SettingsRow, marks: string[]) =>
  `<div class="st-row${row.fold ? " has-fold" : ""}"><div class="st-tx"><b>${words(row.title, marks)}</b>${row.line ? `<small>${words(row.line, marks)}</small>` : ""}</div>${row.control ? `<div class="st-ctl">${row.control}</div>` : ""}</div>${row.fold ? `<div class="st-fold">${row.fold}</div>` : ""}`;
const groupHtml = (group: Group, marks: string[]) =>
  `<div class="st-head"><span>${h(group.name)}</span>${group.right ? `<span>${h(group.right)}</span>` : ""}</div><div class="st-group">${group.rows.map((row) => rowHtml(row, marks)).join("")}</div>${group.hint ? `<p class="st-hint">${h(group.hint)}</p>` : ""}`;

/// The rows that match a search, by section: a row matches when any word
/// you typed is in its title, line or keywords.
export function settingsSearch(view: SettingsView) {
  const marks = view.query.trim().toLowerCase().split(/\s+/).filter((item) => item.length > 1);
  if (!marks.length) return { marks, found: [] as { page: Page; rows: SettingsRow[] }[] };
  const found = pages(view).map((page) => ({ page, rows: page.groups.flatMap((group) => group.rows).filter((row) => marks.some((mark) => `${page.title} ${row.title} ${row.line ?? ""} ${row.keywords ?? ""}`.toLowerCase().includes(mark))) })).filter((item) => item.rows.length);
  return { marks, found };
}

export function settingsPage(view: SettingsView) {
  const error = view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : "";
  if (view.query.trim()) {
    const { marks, found } = settingsSearch(view);
    const count = found.reduce((sum, item) => sum + item.rows.length, 0);
    return `<h1 class="cp-title">Search</h1><p class="cp-lede">${count ? `${count} ${count === 1 ? "setting matches" : "settings match"} “${h(view.query.trim())}”.` : `Nothing matches “${h(view.query.trim())}”.`}</p>${error}` +
      found.map(({ page, rows }) => `<div class="st-head"><button type="button" class="st-goto" data-action="settings-section" data-args="${h(JSON.stringify({ id: page.id }))}">${h(page.title)} ›</button></div><div class="st-group">${rows.map((row) => rowHtml(row, marks)).join("")}</div>`).join("") +
      (count ? `<p class="st-hint">Esc clears the search.</p>` : "");
  }
  const page = pages(view).find((item) => item.id === view.section) ?? pages(view)[0]!;
  const note = page.note ? `<p class="st-note${page.id === "permissions" ? " foot" : ""}">${h(page.note)}${page.note.startsWith("Changed here") ? ` ${link("restart-daemon", "Restart now")}` : ""}</p>` : "";
  return `<h1 class="cp-title">${h(page.title)}</h1><p class="cp-lede">${h(page.sub)}</p>${error}${page.id === "permissions" ? "" : note}${page.groups.map((group) => groupHtml(group, [])).join("")}${page.id === "permissions" ? note : ""}`;
}

/// The sidebar while Settings is open: Back to chats, the search, the list.
export function settingsNav(view: Pick<SettingsView, "section" | "query" | "archived" | "info">) {
  const counts: Partial<Record<SettingsSection, string>> = {
    ...(view.archived?.length ? { archived: String(view.archived.length) } : {}),
    ...(view.info?.allow.length ? { permissions: String(view.info.allow.length) } : {}),
  };
  const searching = Boolean(view.query.trim());
  return `<button type="button" class="st-back" data-action="page-open" data-args='{"page":""}'>${icon('<path d="m15 6-6 6 6 6"/>')}Back to chats</button>` +
    `<label class="sidebar-search st-search">${icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}<input id="settings-search" type="search" placeholder="Search settings" aria-label="Search settings" value="${h(view.query)}" autocomplete="off" spellcheck="false"></label>` +
    SETTINGS_GROUPS.map(([name, items]) => `<div class="st-nav-group">${h(name)}</div>${items.map(([id, label, path]) => {
      const on = !searching && id === view.section;
      return `<button type="button" class="st-nav${on ? " on" : ""}" data-action="settings-section" data-args="${h(JSON.stringify({ id }))}"${on ? ' aria-current="page"' : ""}>${icon(path)}<span>${h(label)}</span>${counts[id] ? `<span class="st-nav-n">${h(counts[id])}</span>` : ""}</button>`;
    }).join("")}`).join("");
}
