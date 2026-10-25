/// All chats: every chat in one place, in place of the conversation, with a
/// tab for the archived ones and Restore on each.
const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;

export type ChatsTab = "active" | "archived";
export interface ChatsPageChat {
  id: string;
  title: string;
  /// When it last moved, or when it was archived.
  at: string;
  workspace?: string | null;
  /// Set for a chat in the project this window has open.
  here?: boolean;
}

/// Today, Yesterday, the weekday within a week, then the date.
export function dayWord(date: string, now = new Date()) {
  const then = new Date(date);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString([], { weekday: "short" });
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
}

const projectWords = (path: string | null | undefined) => path ? path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path : "Just a chat";

export function chatsPage(tab: ChatsTab, active: ChatsPageChat[], archived: ChatsPageChat[] | null) {
  const tabButton = (name: ChatsTab, label: string, count: number | null) =>
    btn("chats-page", `${label}${count === null ? "" : ` <span class="cp-count">${count}</span>`}`, { tab: name }, `cp-tab${tab === name ? " on" : ""}`)
      .replace("<button ", `<button role="tab" aria-selected="${tab === name}" `);
  const rows = tab === "active" ? active : archived;
  const list = rows === null
    ? '<p class="cp-empty">Reading the archive…</p>'
    : !rows.length
      ? `<p class="cp-empty">${tab === "archived" ? "Nothing archived. Archive a chat from its row in the sidebar." : "No chats yet."}</p>`
      : rows.map((chat) => {
        const what = `<b>${h(chat.title)}</b><span class="cp-where"> · ${h(projectWords(chat.workspace))}</span>`;
        const open = btn(chat.here || !chat.workspace ? "select-session" : "project-session", what, { id: chat.id, ...(chat.workspace ? { path: chat.workspace } : {}) }, "cp-open");
        const right = tab === "archived" ? btn("chats-restore", "Restore", { id: chat.id }, "cp-restore").replace("<button ", `<button aria-label="${h(`Restore ${chat.title}`)}" `) : "";
        return `<div class="cp-row"><span class="cp-when" title="${h(new Date(chat.at).toLocaleString())}">${h(dayWord(chat.at))}</span>${tab === "archived" ? `<span class="cp-what">${what}</span>` : open}${right}</div>`;
      }).join("");
  return `<h1 class="cp-title">All chats</h1><div class="cp-tabs" role="tablist" aria-label="Which chats">${tabButton("active", "Active", active.length)}${tabButton("archived", "Archived", archived?.length ?? null)}</div><div class="cp-list" role="list">${list}</div>`;
}
