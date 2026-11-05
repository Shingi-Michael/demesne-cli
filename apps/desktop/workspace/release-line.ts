/// The pink line above your name (pass 153 A): the release's name, or where
/// an update stands. A thin bar while it downloads, then Restart.
export type AppUpdate =
  | { state: "off"; why: string }
  | { state: "idle"; version: string; enabled: boolean }
  | { state: "downloading"; version: string; to: string; progress: number }
  | { state: "ready"; version: string; to: string; waiting?: boolean }
  | { state: "failed"; version: string; to?: string; error: string };

export const RELEASE_NAME = "Demesne · Cherry Blossom";
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function releaseLine(update: AppUpdate | null): { html: string; title: string; state: string } {
  if (!update || update.state === "off" || update.state === "idle") {
    const title = update && update.state === "idle" ? `Demesne ${update.version}${update.enabled ? "" : " · updates are off in Settings"}` : "";
    return { html: RELEASE_NAME, title, state: "name" };
  }
  if (update.state === "downloading") {
    const percent = Math.round(Math.max(0, Math.min(1, update.progress)) * 100);
    return { html: `<span class="rl-text">Updating to ${esc(update.to)}</span><span class="rl-bar" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" aria-label="Downloading ${esc(update.to)}"><b style="width:${percent}%"></b></span>`, title: `Downloading ${update.to} in the background`, state: "downloading" };
  }
  if (update.state === "ready") {
    if (update.waiting) return { html: `<span class="rl-text">${esc(update.to)} restarts when this finishes</span>`, title: "It won't restart while a chat or Drive works", state: "waiting" };
    return { html: `<span class="rl-text">${esc(update.to)} is ready</span><button type="button" class="rl-restart" data-update-restart title="Restart into ${esc(update.to)}. If you just quit, it updates the next time it opens.">Restart</button>`, title: `Demesne ${update.version} · ${update.to} is downloaded and checked`, state: "ready" };
  }
  return { html: RELEASE_NAME, title: update.error, state: "name" };
}
