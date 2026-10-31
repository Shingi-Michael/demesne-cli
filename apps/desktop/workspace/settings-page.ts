/// Settings, as a page in place of the conversation. The sidebar becomes its
/// list (Back to chats, a search over every row, then the sections in four
/// groups) and the page holds the chosen section: a title, one line on what
/// it holds, and groups of rows on a hairline ring. Each row is a title, one
/// quiet line and its control on the right: a switch, words that unfold in
/// place, a number you type, or a link. Nothing opens a menu.
import { PLAN_LIMIT_AMBER, PLAN_LIMIT_DRIVE_PAUSE, planWindows, type ModelScore, type NearbyAgent, type PlanLimits } from "@demesne/protocol";
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

export type SettingsSection = "overview" | "general" | "notifications" | "appearance" | "keys" | "archived" | "usage" | "permissions" | "drive" | "models" | "providers" | "connectors" | "heartbeat" | "data";
const icon = (path: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${path}</svg>`;
export const SETTINGS_GROUPS: [string, [SettingsSection, string, string][]][] = [
  ["", [["overview", "Overview", '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>']]],
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
  appearance: { theme: string; themes: SettingsTheme[]; canUndo: boolean; zoom: number | null; glass: number; ink: Ink; systemSource?: {enabled:boolean;path:string;error?:string} | null };
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
  /// What each plan has left, for the model's provider first.
  plans: PlanLimits[];
}

/// A theme as Settings draws its card: the background, the panel, the accent and the text.
export interface SettingsTheme { name: string; label: string; light?: boolean; colors?: { bg: string; surface: string; accent: string; text: string } }

/// Settings › Appearance › Ink: the hue every grey is made from (Demesne's own themes).
export const INKS = [["neutral", "Neutral", "#8e8e93"], ["warm", "Warm", "#c58b5c"], ["cool", "Cool", "#6f8fd6"], ["moss", "Moss", "#7da37a"], ["rose", "Rose", "#c47a9b"]] as const;
export type Ink = (typeof INKS)[number][0];
export const isInk = (value: unknown): value is Ink => INKS.some(([id]) => id === value);
/// Glass, 0 (clear) to 100 (solid), as the shell's and the panel's opacity.
export function glassAlphas(glass: number) {
  const g = Math.min(100, Math.max(0, glass)) / 100;
  // Clear is nearly see-through, so full screen still reads as glass; the
  // work panel stays a touch deeper than the shell. Below about 40% panel,
  // answers and code get a soft backing (back) so text never sits on bare
  // wallpaper.
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const shell = round(0.05 + 0.95 * g), panel = round(0.08 + 0.92 * g);
  return { shell, panel, back: round(Math.max(0, 0.42 - panel)) };
}
export const GLASS_DEFAULT = 15;
/// Where the desktop doesn't blur behind the window (GNOME, KDE), the glass
/// starts more solid so words stay readable over a sharp wallpaper.
export const GLASS_SHARP_DEFAULT = 70;

export interface SettingsRow { title: string; line?: string; control?: string; keywords?: string; fold?: string }
/// A hidden group is only for search: its page draws the same things its own way.
interface Group { name: string; right?: string; rows: SettingsRow[]; hint?: string; hidden?: boolean }
interface Page { id: SettingsSection; title: string; sub: string; groups: Group[]; note?: string; html?: string }

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
  out.push({ id: "overview", title: "Settings", sub: "", html: overview(view), groups: [] });
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
  const themeGroups: [string, SettingsTheme[]][] = [["Yours", []], ["Dark", []], ["Light", []]];
  for (const item of view.appearance.themes) themeGroups[item.name.startsWith("custom-") ? 0 : (item.light ?? /light|latte/.test(item.name)) ? 2 : 1]![1].push(item);
  out.push({ id: "appearance", title: "Appearance", sub: "How the app looks on this computer. The window below is drawn with your choices.", html: appearanceTop(view, themeLabel, themeGroups), groups: [
    { name: "Look", rows: [
      ...(systemSource ? [
        { title: "Use an external System palette", line: "Off uses Demesne’s own colors and follows system light/dark. On reads the palette file below when System is selected.", control: toggle(systemSource.enabled,"system-theme-toggle",{enabled:!systemSource.enabled},"Use an external System palette"), keywords: "system theme palette external kuru switch" },
        { title: "System palette file", line: systemSource.error ? `Could not reload: ${systemSource.error}. Keeping the last valid palette, or Demesne’s default.` : "A JSON file or symlink on the daemon’s computer. Saving a path does not enable it or change the selected theme.", fold: `<form id="system-theme-source" class="st-text" data-kind="system-theme"><input name="path" value="${h(systemSource.path)}" aria-label="System palette file" maxlength="4096" autocomplete="off" spellcheck="false"><button type="submit" class="st-link">Save path</button></form>`, keywords: "system theme file path symlink kuru external json" },
      ] : []),
      { title: "Theme", line: `${themeLabel}. The palette for the whole app, picked from the cards above`, keywords: "colour color dark light palette theme" },
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
  out.push({ id: "usage", title: "Usage", sub: "The last 30 days, counted from your own chats on this computer, and what your plan has left.", html: usageTop(view, scores), groups: [
    { name: "By model", right: scores.length ? `${scores.reduce((sum, score) => sum + score.turns, 0)} turns` : "", rows: view.usage === null ? [{ title: "Counting…" }] : scores.length ? scores.map((score) => {
      const ended = score.finished + score.failed;
      return { title: view.modelWords({ id: score.model }), line: [`${score.provider}`, `${score.turns} ${score.turns === 1 ? "turn" : "turns"}`, ended ? `${Math.round((score.finished / ended) * 100)}% finished` : "", score.tokensPerSecond ? `${Math.round(score.tokensPerSecond)} tok/s` : ""].filter(Boolean).join(" · "), control: `<span class="st-bar" aria-hidden="true"><i style="width:${Math.max(3, Math.round((score.turns / most) * 100))}%"></i></span><span class="st-count">${score.turns}</span>`, keywords: "usage turns tokens speed model" };
    }) : [{ title: "Nothing yet", line: "Turns show here once a model has answered" }] },
    { name: "Drive", rows: [{ title: "Runs", line: runs ? `${landed} applied or opened as a PR` : "None in the last 30 days", control: `<span class="st-count">${runs}</span>`, keywords: "drive runs branches" }] },
  ] });
  const rules = info?.allow ?? [], mode = view.permissions.mode;
  out.push({ id: "permissions", title: "Permissions", sub: "What it may do without asking, and where.", html: permissionsTop(view), groups: [
    { name: "Mode", hidden: true, rows: [{ title: "Mode", line: "Ask, Accept edits, Plan or Auto for this chat", keywords: "mode ask accept edits plan auto approvals" }] },
    { name: "It no longer asks about", hidden: true, rows: rules.map(({ rule }) => ({ title: `\`${ruleWords(rule).what}\``, line: ruleWords(rule).how, keywords: "allow rule always learned approvals" })) },
    { name: "Trusted folders", hidden: true, rows: (info?.trusted ?? []).map((root) => ({ title: `\`${homeWords(root, view.home)}\``, line: "A trusted folder", keywords: "trust folder project untrust" })) },
  ] });
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
      { title: "Restart the daemon", line: info?.restart.includes("app.update") ? "A newer daemon came with this app; it restarts by itself once nothing is working" : info?.restart.length ? "Settings you changed wait for a restart" : "It reads its settings again; waits until nothing is working", control: link("restart-daemon", "Restart", {}, info?.restart.length ? " warn" : ""), keywords: "restart daemon reload" },
    ] },
    { name: "Conversations", rows: [
      { title: "All conversations", line: `${view.chats.all} ${view.chats.all === 1 ? "chat" : "chats"}${view.chats.here !== view.chats.all ? `, ${view.chats.here} in this project` : ""}`, control: link("page-open", "Show", { page: "active" }), keywords: "sessions history chats" },
      { title: "Clean up", line: "Delete empty, quick and old chats; you choose which first", control: link("overlay", "Review", { name: "cleanup" }), keywords: "delete clean sessions" },
    ] },
  ] });
  return out;
}

const ov = (id: SettingsSection) => `data-action="settings-section" data-args="${h(JSON.stringify({ id }))}"`;
const pct = (value: number) => `${Math.round(value)}%`;
/// A ring for one share, 0 to 100.
const ring = (used: number, size = 30) => {
  const r = size / 2 - 3, c = 2 * Math.PI * r, warn = used >= PLAN_LIMIT_AMBER;
  return `<svg class="ov-ring${warn ? " warn" : ""}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${(c * Math.min(100, used) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
};
const windowWords = (name: string) => name === "weekly" ? "this week" : name.replace("-hour", " hours").replace("-day", " days").replace("-minute", " minutes");
const resetAt = (at: string | null) => {
  if (!at) return "";
  const date = new Date(at), ms = date.getTime() - Date.now();
  if (ms <= 0) return "";
  if (ms < 86_400_000) { const hours = Math.floor(ms / 3_600_000), minutes = Math.round((ms % 3_600_000) / 60_000); return `resets in ${hours ? `${hours} h ` : ""}${minutes} min`; }
  return `resets ${date.toLocaleDateString([], { weekday: "long" })}`;
};
const planTitle = (plan: PlanLimits) => `${plan.provider[0]!.toUpperCase()}${plan.provider.slice(1)}${plan.plan ? ` ${plan.plan[0]!.toUpperCase()}${plan.plan.slice(1)}` : ""}`;
const MODES = [["ask", "Ask", "Asks before edits and commands", ["read"]], ["edits", "Accept edits", "Edits freely, asks before commands", ["read", "edit"]], ["plan", "Plan", "Reads and proposes, changes nothing", ["read"]], ["auto", "Auto", "Does everything without asking", ["read", "edit", "run"]]] as const;
const modeWords = (mode: SettingsView["permissions"]["mode"]) => mode === "edits" ? "edits freely and asks before commands" : mode === "plan" ? "only reads and proposes" : mode === "auto" ? "does everything without asking" : mode === "ask" ? "asks before edits and commands" : "lets each chat choose what it asks about";
/// Turns a day over the window, all models together.
const dailyTotal = (scores: ModelScore[]) => scores.reduce<number[]>((sum, score) => (score.daily ?? []).map((n, i) => n + (sum[i] ?? 0)), []);

/// Settings › Overview: one sentence on how it's set up, six tiles, and what's worth a look.
function overview(view: SettingsView): string {
  const info = view.info, own = view.plans.find((item) => item.provider === view.model.provider), plan = own ?? view.plans[0], auto = view.drive.auto, mode = view.permissions.mode;
  const linkTo = (id: SettingsSection, text: string) => `<button type="button" class="ov-link" ${ov(id)}>${h(text)}</button>`;
  const source = own ? ` on your ${h(planTitle(own))} plan` : view.model.provider ? ` from ${h(view.model.provider)}` : "";
  const drive = !view.drive.project ? "Drive works in a project you open" : auto?.on ? `Drive starts on its own after ${auto.quietMinutes} quiet minutes` : "Drive waits until you start it";
  const sentence = `<p class="ov-say">Answers come from ${linkTo("models", view.model.words || "your model")}${source}, it ${linkTo("permissions", modeWords(mode))}, and ${linkTo("drive", drive)}.</p>`;

  const tile = (id: SettingsSection, label: string, right: string, body: string, extra = "") =>
    `<div class="ov-tile${extra}" ${ov(id)}><div class="ov-top"><button type="button" class="ov-label" ${ov(id)}>${h(label)}</button>${right ? `<span>${right}</span>` : ""}</div>${body}</div>`;
  const subagent = info?.subagent.model ? view.modelWords({ id: info.subagent.model }) : "";
  const model = tile("models", "Model", view.model.reasoning ? `${h(view.model.reasoning)} thinking` : "",
    `<b class="ov-big">${h(view.model.words || "No model yet")}</b><small>${view.model.provider ? `<i class="ov-dot${view.online ? "" : " off"}"></i>${h(view.model.provider)}${view.model.chatgpt ? ", signed in" : ""}` : "Pick one in Models"}${subagent ? `<br>Subagents on ${h(subagent)}` : ""}</small>` +
    `<button type="button" class="st-link ov-act" data-action="overlay" data-args='{"name":"models"}'>Change</button>`);
  const windows = plan ? planWindows(plan) : [];
  const fullest = windows.reduce<number>((top, item) => Math.max(top, item.window.usedPercent), 0);
  const planTile = tile("usage", "Your plan", plan?.plan ? h(plan.plan[0]!.toUpperCase() + plan.plan.slice(1)) : "",
    windows.length
      ? `<div class="ov-rings">${windows.map(({ name, window }) => `<div>${ring(window.usedPercent)}<span><b>${pct(window.usedPercent)}</b><small>${h(windowWords(name))}</small></span></div>`).join("")}</div><small>${h(resetAt(windows[0]!.window.resetsAt).replace(/^r/, "R"))}${resetAt(windows[0]!.window.resetsAt) ? ". " : ""}${fullest >= PLAN_LIMIT_DRIVE_PAUSE ? "Drive has paused its own runs." : `Drive waits at ${PLAN_LIMIT_DRIVE_PAUSE}%.`}</small>`
      : `<b class="ov-big">No limits reported</b><small>${view.model.provider ? `${h(view.model.provider)} doesn't say what's left` : "Sign in to a provider to see what's left"}</small>`);
  const scores = (view.usage ?? []).filter((score) => score.turns > 0);
  const turns = scores.reduce((sum, score) => sum + score.turns, 0), ended = scores.reduce((sum, score) => sum + score.finished + score.failed, 0), finished = scores.reduce((sum, score) => sum + score.finished, 0);
  const speeds = scores.filter((score) => score.tokensPerSecond).map((score) => score.tokensPerSecond!), runs = scores.reduce((sum, score) => sum + score.driveRuns, 0);
  const daily = dailyTotal(scores), top = Math.max(1, ...daily);
  const usageTile = tile("usage", "Last 30 days", turns ? `${turns} ${turns === 1 ? "turn" : "turns"}` : "",
    view.usage === null ? `<small>Counting…</small>` : turns
      ? `<div class="ov-spark" aria-hidden="true">${daily.map((n) => `<i style="height:${n ? Math.max(8, Math.round((n / top) * 100)) : 4}%"${n ? "" : ' class="none"'}></i>`).join("")}</div><small>${[ended ? `${Math.round((finished / ended) * 100)}% finished` : "", speeds.length ? `${Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length)} tok/s` : "", `${runs} Drive ${runs === 1 ? "run" : "runs"}`].filter(Boolean).join(" · ")}</small>`
      : `<b class="ov-big">Nothing yet</b><small>Turns show here once a model has answered</small>`);
  const modeIndex = MODES.findIndex(([id]) => id === mode);
  const permissionsTile = tile("permissions", "Permissions", mode ? "this chat" : "",
    `<b class="ov-big">${mode ? h(MODES[modeIndex]![1]) : "Each chat chooses"}</b><div class="ov-steps" aria-hidden="true">${MODES.map((_, i) => `<i${i === modeIndex ? ' class="on"' : ""}></i>`).join("")}</div><small>${info ? `${info.allow.length} ${info.allow.length === 1 ? "rule" : "rules"} it no longer asks about${info.trusted ? `<br>${info.trusted.length} trusted ${info.trusted.length === 1 ? "folder" : "folders"}` : ""}` : "Reading…"}</small>`);
  const driveTile = tile("drive", "Drive", view.drive.project ? h(view.drive.project) : "",
    !view.drive.project || !auto ? `<b class="ov-big">In a project</b><small>Open a project to set Drive for it</small>`
      : `<b class="ov-big">${auto.on ? "On its own" : "Waits for you"}</b><small>${auto.usedToday} of ${auto.perDay} ${auto.perDay === 1 ? "run" : "runs"} today${info ? ` · up to ${info.drive.maxActiveMinutes} min each` : ""}</small><div class="ov-meter" aria-hidden="true"><i style="width:${Math.min(100, Math.round((auto.usedToday / Math.max(1, auto.perDay)) * 100))}%"></i></div>`);
  const waiting = info?.restart.includes("app.update") ? "update waiting" : info?.restart.length ? "restart waiting" : "";
  const computer = tile("data", "This computer", waiting ? `<em class="ov-warn">${waiting}</em>` : "",
    `<b class="ov-big"><i class="ov-dot${view.online ? "" : " off"}"></i>${view.online ? "Daemon running" : "Daemon not answering"}</b><small>${info ? `Chats in <code>${h(homeWords(info.dataDirectory, view.home))}</code>` : ""}${view.chats.all ? `${info ? " · " : ""}${view.chats.all} ${view.chats.all === 1 ? "chat" : "chats"}` : ""}</small>` +
    (waiting ? `<button type="button" class="st-link ov-act" data-action="restart-daemon" data-args="{}">Restart when idle</button>` : ""));

  const looks: { icon: string; title: string; line: string; action: string }[] = [];
  if (info?.restart.includes("app.update")) looks.push({ icon: "↻", title: "A newer daemon came with this app", line: "It restarts by itself once nothing is working, or now", action: link("restart-daemon", "Restart") });
  else if (info?.restart.length) looks.push({ icon: "↻", title: "Settings you changed wait for a restart", line: info.restart.join(", "), action: link("restart-daemon", "Restart") });
  for (const server of view.connectors.servers.filter((item) => item.state === "failed"))
    looks.push({ icon: "⌁", title: `The ${server.name} connector didn't start`, line: info?.mcp.find((item) => item.name === server.name)?.command ? `\`${info.mcp.find((item) => item.name === server.name)!.command}\` exits on start` : "Its server exits on start", action: link("settings-section", "Look", { id: "connectors" }) });
  if (plan && fullest >= PLAN_LIMIT_AMBER) looks.push({ icon: "◔", title: `Your ${planTitle(plan)} plan is ${pct(fullest)} used`, line: fullest >= PLAN_LIMIT_DRIVE_PAUSE ? "Drive has paused its own runs until it resets" : `Drive pauses its own runs at ${PLAN_LIMIT_DRIVE_PAUSE}%`, action: link("settings-section", "Usage", { id: "usage" }) });
  const asks = view.permissions.asks;
  if (asks && asks.thisWeek >= 10 && asks.thisWeek > asks.lastWeek) looks.push({ icon: "✓", title: `It asked you ${asks.thisWeek} times this week`, line: "Always on an approval, or Accept edits, asks less", action: link("settings-section", "Permissions", { id: "permissions" }) });
  if (!view.online) looks.push({ icon: "!", title: "The daemon isn't answering", line: "Chats and Drive wait until it's back", action: link("restart-daemon", "Restart") });
  const look = `<div class="st-head"><span>Worth a look</span></div><div class="st-group">${looks.length
    ? looks.map((item) => `<div class="st-row"><span class="ov-icon" aria-hidden="true">${h(item.icon)}</span><div class="st-tx"><b>${h(item.title)}</b><small>${words(item.line, [])}</small></div><div class="st-ctl">${item.action}</div></div>`).join("")
    : `<div class="st-row"><span class="ov-icon" aria-hidden="true">✓</span><div class="st-tx"><b>Nothing needs you</b><small>Restarts, failing connectors and a filling plan show here</small></div></div>`}</div>`;
  return `${sentence}<div class="ov-tiles">${model}${planTile}${usageTile}${permissionsTile}${driveTile}${computer}</div>${look}`;
}

/// Appearance: a small window drawn with the app's own colours, then the themes as cards.
function appearanceTop(view: SettingsView, themeLabel: string, groups: [string, SettingsTheme[]][]): string {
  const preview = `<div class="ap-preview" aria-label="Preview of ${h(themeLabel)}"><div class="ap-win"><div class="ap-side"><span class="ap-mark">d.</span><i class="on">Settings page</i><i>Top bar tabs</i><i>Still blossom</i></div><div class="ap-main"><span class="ap-me">Make settings look good</span><p>Here’s an overview of your setup, with what’s <em>worth a look</em> first.</p><div class="ap-box"><span>Ask anything</span><em>${h(view.model.words)}</em></div></div></div></div>`;
  const card = (theme: SettingsTheme) => {
    const c = theme.colors, on = theme.name === view.appearance.theme;
    const art = c ? `<span class="ap-art" style="--bg:${h(c.bg)};--sf:${h(c.surface)};--ac:${h(c.accent)};--tx:${h(c.text)}"><i></i><b></b></span>` : `<span class="ap-art plain"><i></i><b></b></span>`;
    return `<button type="button" class="ap-card${on ? " on" : ""}" aria-pressed="${on}" data-action="settings-set" data-args="${h(JSON.stringify({ method: "theme", args: { name: theme.name } }))}">${art}<span class="ap-name">${h(theme.label)}</span></button>`;
  };
  const make = `<button type="button" class="ap-card make" data-action="settings-command" data-args='{"text":"/themefy "}'><span class="ap-art plain">+</span><span class="ap-name">Make one…</span></button>`;
  const all = groups.flatMap(([, items]) => items);
  return preview + `<div class="st-head"><span>Theme</span>${view.appearance.canUndo ? link("settings-set", "Undo", { method: "theme-undo", args: {} }, " quiet") : ""}</div><div class="ap-cards">${all.map(card).join("")}${make}</div>`;
}

const SERIES = ["var(--acc)", "var(--blossom, #f2b6c8)", "var(--ok, #6cc68e)", "var(--t4)"];
/// Usage: each plan's windows, then turns a day stacked by model.
function usageTop(view: SettingsView, scores: ModelScore[]): string {
  const plans = view.plans.filter((plan) => planWindows(plan).length);
  const planCards = plans.length ? `<div class="us-plans">${plans.map((plan) => `<div class="us-plan"><div class="ov-top"><span>${h(planTitle(plan))}</span>${plan.provider.toLowerCase() === "chatgpt" ? link("open-link", "Manage ↗", { url: "https://chatgpt.com/settings/usage" }, " quiet") : ""}</div><div class="ov-rings">${planWindows(plan).map(({ name, window }) => `<div>${ring(window.usedPercent, 34)}<span><b>${pct(window.usedPercent)} of ${h(windowWords(name))}</b><small>${h(resetAt(window.resetsAt) || "no reset reported")}</small></span></div>`).join("")}</div></div>`).join("")}</div>` : "";
  const counted = scores.filter((score) => score.daily?.length);
  if (!counted.length) return planCards;
  const series = [...counted.slice(0, 3).map((score, i) => ({ name: view.modelWords({ id: score.model }), daily: score.daily!, color: SERIES[i]! }))];
  if (counted.length > 3) series.push({ name: "Other models", daily: dailyTotal(counted.slice(3)), color: SERIES[3]! });
  const days = series[0]!.daily.length, totals = Array.from({ length: days }, (_, i) => series.reduce((sum, item) => sum + (item.daily[i] ?? 0), 0));
  const top = Math.max(1, ...totals), all = totals.reduce((a, b) => a + b, 0);
  const label = (back: number) => new Date(Date.now() - back * 86_400_000).toLocaleDateString([], { month: "short", day: "numeric" });
  const bars = totals.map((total, i) => `<div class="us-day" title="${h(label(days - 1 - i))}: ${total} ${total === 1 ? "turn" : "turns"}">${series.map((item) => item.daily[i] ? `<i style="height:${((item.daily[i]! / top) * 100).toFixed(1)}%;background:${item.color}"></i>` : "").join("")}</div>`).join("");
  return planCards + `<div class="st-head"><span>Turns a day</span><span>${all} in ${days} days</span></div><div class="us-chart" aria-hidden="true">${bars}</div><div class="us-axis"><span>${h(label(days - 1))}</span><span>${h(label(Math.floor(days / 2)))}</span><span>today</span></div><div class="us-legend">${series.map((item) => `<span><u style="background:${item.color}"></u>${h(item.name)}</span>`).join("")}</div>`;
}

/// Permissions, kept short: the modes in one row, the rules as chips and the
/// trusted folders as one-line rows, each list folded after a few.
const RULES_SHOWN = 12, TRUSTED_SHOWN = 4;
function permissionsTop(view: SettingsView): string {
  const mode = view.permissions.mode, info = view.info, rules = info?.allow ?? [], asks = view.permissions.asks;
  const current = MODES.find(([id]) => id === mode);
  const modes = mode ? `<div class="st-head"><span>This chat</span><span>${asks && (asks.thisWeek || asks.lastWeek) ? `asked you ${asks.thisWeek} ${asks.thisWeek === 1 ? "time" : "times"} this week · ` : ""}⇧⇥ changes it</span></div><div class="pm-modes">${MODES.map(([id, label, line, free]) => `<button type="button" class="pm-mode${mode === id ? " on" : ""}" aria-pressed="${mode === id}" title="${h(line)}" data-action="permission-mode" data-args="${h(JSON.stringify({ mode: id }))}"><b>${h(label)}</b><span class="pm-can">${(["read", "edit", "run"] as const).map((can) => `<em${(free as readonly string[]).includes(can) ? ' class="free"' : ""}>${can}</em>`).join("")}</span></button>`).join("")}</div>${current ? `<p class="st-hint">${h(current[2])}. Green is what it does without asking.</p>` : ""}` : "";
  const allRules = view.fold === "rules";
  const chips = info === null ? "" : `<div class="st-head"><span>It no longer asks about</span><span>${rules.length ? `${rules.length} · × asks again` : ""}</span></div>` + (rules.length
    ? `<div class="pm-chips">${(allRules ? rules : rules.slice(0, RULES_SHOWN)).map(({ rule, mine }) => {
      const said = ruleWords(rule);
      return `<span class="pm-chip" title="${h(`${said.how}${mine ? "" : " · in the project's config"}`)}"><code>${h(said.what)}</code>${mine ? `<button type="button" aria-label="Ask again about ${h(said.what)}" data-action="allow-rule-remove" data-args="${h(JSON.stringify({ rule }))}">×</button>` : "<small>project</small>"}</span>`;
    }).join("")}${rules.length > RULES_SHOWN ? `<button type="button" class="pm-more" data-action="settings-fold" data-args='{"fold":"rules"}'>${allRules ? "Fewer" : `+${rules.length - RULES_SHOWN} more`}</button>` : ""}</div>`
    : `<p class="st-hint pm-empty">Nothing yet. Always on an approval adds one here.</p>`);
  const trusted = info?.trusted, allTrusted = view.fold === "trusted";
  const folders = info === null ? "" : `<div class="st-head"><span>Trusted folders</span><span>${trusted?.length ? `${trusted.length} · their chats read files and run commands` : ""}</span></div>` + (trusted === null || trusted === undefined
    ? `<p class="st-hint pm-empty">The daemon can't list them until it restarts.</p>`
    : trusted.length
      ? `<div class="st-group pm-folders">${(allTrusted ? trusted : trusted.slice(0, TRUSTED_SHOWN)).map((root) => `<div class="pm-folder"><code title="${h(root)}">${h(homeWords(root, view.home))}</code>${link("trusted-forget", "Untrust", { root }, " quiet")}</div>`).join("")}${trusted.length > TRUSTED_SHOWN ? `<button type="button" class="pm-folder pm-more-row" data-action="settings-fold" data-args='{"fold":"trusted"}'>${allTrusted ? "Show fewer" : `Show all ${trusted.length}`}</button>` : ""}</div>`
      : `<p class="st-hint pm-empty">None yet. A folder asks once, the first time you open it.</p>`);
  return modes + chips + folders;
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
  return `<h1 class="cp-title">${h(page.title)}</h1>${page.sub ? `<p class="cp-lede">${h(page.sub)}</p>` : ""}${error}${note}${page.html ?? ""}${page.groups.filter((group) => !group.hidden).map((group) => groupHtml(group, [])).join("")}`;
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
    SETTINGS_GROUPS.map(([name, items]) => `${name ? `<div class="st-nav-group">${h(name)}</div>` : ""}${items.map(([id, label, path]) => {
      const on = !searching && id === view.section;
      return `<button type="button" class="st-nav${on ? " on" : ""}" data-action="settings-section" data-args="${h(JSON.stringify({ id }))}"${on ? ' aria-current="page"' : ""}>${icon(path)}<span>${h(label)}</span>${counts[id] ? `<span class="st-nav-n">${h(counts[id])}</span>` : ""}</button>`;
    }).join("")}`).join("");
}
