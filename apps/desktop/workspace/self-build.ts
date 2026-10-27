/// Demesne rebuilds its own look (pass 80): when the open project is Demesne
/// itself, a chat that changed the window's files can be tried in this very
/// window, kept as the installed app, or gone back from. This is the part
/// the window shares with the main process: what the window is showing, and
/// which of a turn's files count.

export type LookState =
  /// The installed look, nothing in hand.
  | { kind: "installed" }
  /// Try it here: the window's page is being rebuilt from the project.
  | { kind: "building"; project: string }
  /// The window shows the project's look; Keep or Go back are in the top
  /// bar. `keep` is false where there is no installed app to replace.
  | { kind: "trial"; project: string; keep: boolean }
  /// The page didn't build or didn't start, so the installed look is back.
  | { kind: "broken"; project: string; why: string }
  /// Keep: the app is being built from the project.
  | { kind: "keeping"; project: string }
  /// Built and staged: it replaces the installed app when Demesne quits.
  | { kind: "kept"; project: string }
  /// The app build failed; the window keeps whatever look it had.
  | { kind: "failed"; project: string; why: string };

/** What a turn's changed files mean for the running app: `window` for the
 *  page the window shows (Try it here can reload it), `engine` for the
 *  daemon, the host and the Electron shell (only a new build runs them),
 *  `both`, or null when none of them is touched. Paths may be absolute or
 *  relative to the project root. */
export function lookChange(paths: string[], root = ""): "window" | "engine" | "both" | null {
  const prefix = root.replace(/\/+$/, "") + "/";
  let window = false, engine = false;
  for (const raw of paths) {
    const path = (root && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw).replace(/\\/g, "/").replace(/^\.\//, "");
    if (/^apps\/desktop\/(electron\/|host(-protocol)?\.ts$|workspace\/host\.ts$)/.test(path) || /^(apps\/daemon|packages)\//.test(path) || /^scripts\/(prepare-desktop|build-desktop|build-daemon|prepare-ui)\.ts$/.test(path)) engine = true;
    else if (/^apps\/desktop\//.test(path) && !/\/test\//.test(path) && !/\.test\.ts$/.test(path)) window = true;
  }
  return window && engine ? "both" : window ? "window" : engine ? "engine" : null;
}

/** The look line's words for a state, without its buttons. */
export function lookWords(state: LookState): string {
  switch (state.kind) {
    case "installed": return "";
    case "building": return "Rebuilding the window";
    case "trial": return state.keep ? "You’re looking at it now · Keep or Go back is in the top bar" : "You’re looking at it now · Go back is in the top bar";
    case "broken": return "Your change didn’t load, so Demesne went back";
    case "keeping": return "Building Demesne.app";
    case "kept": return "Kept · it opens the next time Demesne starts";
    case "failed": return "The build failed";
  }
}
