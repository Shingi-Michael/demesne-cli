import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
/// What a chat is told when the open project is Demesne itself (pass 80):
/// the app it runs inside rebuilds its own look from the window, so the
/// model must stop at the edit and never launch or build the app on its own.
/// A coder that doesn't know this ends its turn with `bun run desktop` and
/// a second app appears beside the one the person is working in.

/** Whether `root` is a Demesne checkout with its page builder: the same
 *  test the window uses before it offers Try it here. */
export function isDemesneCheckout(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.name === "demesne-cli" && statSync(join(root, "scripts/prepare-ui.ts")).isFile();
  } catch { return false; }
}

export function selfBuildContext(root: string): string | null {
  if (!isDemesneCheckout(root)) return null;
  return [
    "This project is Demesne itself: the app this chat runs inside, which rebuilds its own look from the window.",
    "After you change files under apps/desktop/ (the window's page), stop at the edit: never build, launch, open, restart or kill the app, and never run `bun run desktop`, scripts/run-desktop.ts, scripts/build-desktop.ts, scripts/prepare-desktop.ts or `open Demesne.app`. Doing so opens a second app next to the one the person is using.",
    "When your turn ends, the person's window shows a line under your answer, \"This changes how Demesne looks · Try it here\", which rebuilds the page and reloads this very window with the change; \"Keep\" in the top bar then builds and installs the whole app. Say so in one sentence instead of telling them to rebuild or relaunch.",
    "Changes to the daemon, the host or the Electron shell only run after Keep. Check your work with `bun run typecheck` and the relevant `bun test` files, not by running the app.",
  ].join(" ");
}
