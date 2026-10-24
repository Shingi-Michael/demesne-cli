/// The Customize page: the project's instructions, commands, workflows and
/// connectors, each a row with Edit (unfolding the file in place) or Run.
import type { CustomizeFile, CustomizeView } from "./customize.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;
const projectWords = (path: string | null | undefined) => path ? path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path : "";

export interface CustomizeUi {
  /// The file unfolded for editing, and its text once read.
  editing: { path: string; text: string | null } | null;
  error: string;
}
export interface Connectors { servers: { name: string; state: "starting" | "ready" | "failed"; tools: number }[]; heartbeat: boolean }

export function customizePage(view: CustomizeView | null, ui: CustomizeUi, connectors: Connectors, mac: boolean) {
  if (!view) return '<h1 class="cp-title">Customize</h1><p class="cp-empty">Reading the project…</p>';
  // Where the file is, said short: from the project's folder, or from your home.
  const shortPath = (path: string) => view.root && path.startsWith(view.root) ? path.slice(view.root.length).replace(/^[\\/]/, "") : path.replace(/^.*?([\\/]\.demesne[\\/])/, "~$1");
  const editor = (path: string) => ui.editing?.path !== path ? ""
    : ui.editing.text === null ? '<p class="cp-empty">Opening…</p>'
    : `<form class="cz-edit" data-path="${h(path)}"><textarea name="text" spellcheck="false" aria-label="${h(`Edit ${path}`)}">${h(ui.editing.text)}</textarea><div class="cz-edit-bar"><span class="cz-path" title="${h(path)}">${h(shortPath(path))}</span><button type="submit" class="cz-save">Save <kbd>${mac ? "⌘↵" : "Ctrl+↵"}</kbd></button>${btn("cz-cancel", "Cancel", {}, "cz-cancel")}</div></form>`;
  const head = (label: string, right: string) => `<div class="cp-head"><span>${h(label)}</span><span>${right}</span></div>`;
  const fileRow = (file: CustomizeFile, about: string) =>
    `<div class="sp-row cz-row${ui.editing?.path === file.path ? " on" : ""}"><span class="cz-name">/${h(file.name)}</span><span class="sp-what"><span class="cz-about">${h(about)}</span></span>${btn("cz-edit", "Edit", { path: file.path }, "sp-open cz-edit-button")}${btn("cz-run", "Run", { name: file.name }, "sp-open")}</div>${editor(file.path)}`;
  const newRow = (kind: "command" | "workflow") =>
    `<form class="cz-new" data-kind="${kind}"><input name="name" placeholder="${kind === "command" ? "New command, like ship-it" : "New workflow, like release"}" aria-label="${h(`Name a new ${kind}`)}" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">↵</kbd></form>`;
  const where = view.root ? `<b>${h(projectWords(view.root))}</b>` : "your plain chats";
  const out = [`<h1 class="cp-title">Customize</h1><p class="cp-lede">Everything that shapes how Demesne works in ${where}, in one place. The files stay where they are; this page reads and edits them.</p>`];
  if (ui.error) out.push(`<p class="sp-error" role="alert">${h(ui.error)}</p>`);
  const instructions = view.instructions;
  if (instructions) {
    out.push(head("Instructions", h(instructions.name)));
    out.push(`<div class="cp-list"><div class="sp-row cz-row${ui.editing?.path === instructions.path ? " on" : ""}"><span class="cz-name">${h(instructions.name)}</span><span class="sp-what"><span class="cz-about">${instructions.exists ? `${h(instructions.first || "Empty")}${instructions.lines ? ` · ${instructions.lines} lines` : ""}` : "None yet. The model reads it at the start of every chat here."}</span></span>${btn("cz-edit", instructions.exists ? "Edit" : "Write it", { path: instructions.path }, "sp-open cz-edit-button")}</div>${editor(instructions.path)}</div>`);
  }
  const mine = (file: CustomizeFile) => file.mine ? " · yours, every project" : "";
  out.push(head("Commands", `${view.root ? ".demesne/commands" : "~/.demesne/commands"} · ${view.commands.length}`));
  out.push(`<div class="cp-list">${view.commands.map((file) => fileRow(file, `${file.description || "No description"}${mine(file)}`)).join("")}${newRow("command")}</div>`);
  out.push(head("Workflows", `${view.root ? ".demesne/workflows" : "~/.demesne/workflows"} · ${view.workflows.length}`));
  out.push(`<div class="cp-list">${view.workflows.map((file) => fileRow(file, `${file.description || `${file.steps} steps`}${file.description ? ` · ${file.steps} ${file.steps === 1 ? "step" : "steps"}` : ""}${file.checks ? `, ${file.checks} checked` : ""}${mine(file)}`)).join("")}${newRow("workflow")}</div>`);
  const servers = connectors.servers.map((server) => `<div class="sp-row"><span class="cz-name">${h(server.name)}</span><span class="sp-what"><span class="cz-about">${server.tools} ${server.tools === 1 ? "tool" : "tools"}</span></span><span class="cz-state ${server.state}">${server.state === "ready" ? "On" : server.state === "starting" ? "Starting" : "Failed"}</span></div>`);
  out.push(head("Connectors", String(connectors.servers.length + 1)));
  out.push(`<div class="cp-list"><div class="sp-row"><span class="cz-name">Heartbeat</span><span class="sp-what"><span class="cz-about">Agents on this computer and paired ones</span></span><span class="cz-state${connectors.heartbeat ? " ready" : ""}">${connectors.heartbeat ? "On" : "Off"}</span></div>${servers.join("")}</div><p class="sp-hint">Add a connector as <code>[mcp.servers.name]</code> in <code>~/.demesne/config.toml</code>.</p>`);
  return out.join("");
}
