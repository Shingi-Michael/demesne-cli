# Demesne desktop

[Desktop user guide](../../docs/desktop.md) · [Architecture](../../docs/architecture.md) · [Contributing](../../CONTRIBUTING.md)

Electron displays the HTML/CSS/TypeScript interface in [`workspace/`](workspace/README.md) in bundled Chromium on macOS, Linux, and Windows. The main process starts the compiled Bun host over private JSON-line pipes. That host retains the authenticated daemon client, project/session preferences, provider setup, and Drive controller. The independent daemon continues to own coding turns.

## Process boundary

The sandboxed renderer has no Node.js integration or credentials. Its context-isolated preload exposes only a named request function and four public event subscriptions. The main process validates IPC senders against the main frame and `demesne://app` origin, bounds requests, and implements folder selection, clipboard, validated external opening, menus, and persisted zoom. Remote navigation, new windows, embedded webviews, downloads, and permission requests are denied. A restrictive CSP applies to packaged local assets; rendered Markdown remains sanitized.

`electron/backend.ts` manages host framing, response correlation, request deadlines, native action replies, failure recovery, and shutdown. Quitting closes the host's input pipe so its existing disposal logic hands a running Drive mission to a detached host. It never stops the daemon. Closing the window on macOS hides it; Dock activation brings it back. Closing on Linux/Windows quits.

## Run and package

Install Bun and Node.js (for packaging tools), then from the repository root:

```sh
bun install --frozen-lockfile
bun run desktop
bun run build:desktop
```

Preparation bundles renderer/main/preload code into `build/app`, compiles the Bun host and daemon into `build/backend`, and copies native image dependencies beside them. Electron Builder packages those backends outside ASAR under `resources/backend`. No Rust toolchain or system webview is required. The normal build packages only the current host platform and architecture, ensuring Bun and sharp match it.

Outputs are under `apps/desktop/release`: `mac-arm64/Demesne.app` (or `mac/Demesne.app` on Intel), a Linux `.deb`, or a Windows NSIS installer. `--dir` builds an unpacked application. Builds are unsigned until release signing credentials are configured.

## Verification

```sh
bun scripts/prepare-desktop.ts
bun test apps/desktop/test apps/desktop/workspace/test apps/cli/test/desktop-launcher.test.ts
DEMESNE_TEST_DESKTOP_HOST="$PWD/apps/desktop/build/backend/demesne-desktop-host" bun test apps/desktop/test/host.test.ts
bun scripts/check-desktop-backend.ts
bun run desktop:check
bun run build:desktop
```

On headless Linux run `dbus-run-session -- xvfb-run -a bun run desktop:check`. The Electron Playwright check creates private fixture configuration and a deterministic daemon; it never stops the user's daemon or uses a paid model. It verifies actual renderer isolation, approvals, edits and commands, Markdown/code/math, inline diffs and the conversation menu, project/session restoration, and daemon work continuing after app exit. Screenshots and logs go to `test-results/desktop`.

Host tests additionally cover Drive handoff/reclaim, native reply correlation, malformed IPC, draft preservation and theme persistence. GitHub CI is manual-only, so run these checks locally before merging; the release workflow builds macOS, Linux and Windows packages on a version tag. Real desktop lifecycle checks run on macOS and Linux. Native window capture remains macOS-only. Windows integration still needs validation beyond packaging/backend checks. Automatic updates, tray mode and release signing are not implemented.
