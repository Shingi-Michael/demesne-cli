/// The pink line above your name (pass 153 A): the release's name, or where
/// an update stands. A thin bar while it downloads, then Restart. Clicking
/// the name checks for an update now (pass 193 A).
export type AppUpdate =
  | { state: "off"; why: string }
  | { state: "idle"; version: string; enabled: boolean; checked?: number; checking?: boolean; problem?: string }
  | { state: "downloading"; version: string; to: string; progress: number }
  | { state: "ready"; version: string; to: string; waiting?: boolean }
  | { state: "failed"; version: string; to?: string; error: string };

export const RELEASE_NAME = "Demesne · Cherry Blossom";
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// What an asked-for check found, said on the line for a few seconds:
/// "Up to date · 0.8.8", or why it couldn't look.
export function checkResult(update: AppUpdate): { text: string; ok: boolean } | null {
  if (update.state !== "idle" || update.checking) return null;
  return update.problem ? { text: update.problem, ok: false } : { text: `Up to date · ${update.version}`, ok: true };
}

export function releaseLine(update: AppUpdate | null, said: { text: string; ok: boolean } | null = null): { html: string; title: string; state: string } {
  if (!update || update.state === "off") return { html: RELEASE_NAME, title: "", state: "name" };
  if (update.state === "idle" || update.state === "failed") {
    if (update.state === "idle" && update.checking) return { html: `<span class="rl-spin" aria-hidden="true"></span><span class="rl-text">Checking for updates…</span>`, title: `Demesne ${update.version}`, state: "checking" };
    const off = update.state === "idle" && !update.enabled ? " · updates are off in Settings" : "";
    const words = said ? `<span class="rl-text${said.ok ? "" : " rl-dim"}" role="status">${esc(said.text)}</span>` : RELEASE_NAME;
    const title = update.state === "failed" ? `${update.error} · click to check for updates` : `Demesne ${update.version}${off} · click to check for updates`;
    return { html: `<button type="button" class="rl-check" data-update-check title="${esc(title)}">${words}</button>`, title: "", state: said ? "said" : "name" };
  }
  if (update.state === "downloading") {
    const percent = Math.round(Math.max(0, Math.min(1, update.progress)) * 100);
    return { html: `<span class="rl-text">Updating to ${esc(update.to)}</span><span class="rl-bar" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" aria-label="Downloading ${esc(update.to)}"><b style="width:${percent}%"></b></span>`, title: `Downloading ${update.to} in the background`, state: "downloading" };
  }
  if (update.state === "ready") {
    if (update.waiting) return { html: `<span class="rl-text">${esc(update.to)} restarts when this finishes</span>`, title: "It won't restart while a chat or Drive works", state: "waiting" };
    return { html: `<span class="rl-text">${esc(update.to)} is ready</span><button type="button" class="rl-restart" data-update-restart title="Restart into ${esc(update.to)}. If you just quit, it updates the next time it opens.">Restart</button>`, title: `Demesne ${update.version} · ${update.to} is downloaded and checked`, state: "ready" };
  }
  return { html: RELEASE_NAME, title: "", state: "name" };
}

/// Settings › Updates: the version, when it last looked and what it found,
/// and whether Check now can run. Words for a time, not a clock.
export function updateCheckLine(update: AppUpdate, now = Date.now()): { title: string; line: string; tone: "" | "bad"; can: boolean } | null {
  if (update.state === "off") return null;
  const title = `Demesne ${update.version}`;
  if (update.state === "downloading") return { title, line: `Downloading ${update.to}`, tone: "", can: false };
  if (update.state === "ready") return { title, line: `${update.to} is downloaded and goes in when you restart`, tone: "", can: false };
  if (update.state === "failed") return { title, line: update.error, tone: "bad", can: true };
  if (update.checking) return { title, line: "Checking for updates…", tone: "", can: false };
  if (update.problem) return { title, line: update.problem, tone: "bad", can: true };
  if (!update.checked) return { title, line: "Not checked since Demesne opened", tone: "", can: true };
  const ms = now - update.checked;
  const ago = ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`;
  return { title, line: `Checked ${ago} · this is the newest`, tone: "", can: true };
}
