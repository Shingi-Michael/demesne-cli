# Desktop app preview

[Documentation index](README.md) · [Implementation](../apps/desktop/README.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Demesne's interface is a Tauri 2 desktop window that shows its HTML/CSS/TypeScript UI. Conversations, file inspection, diffs, verification, previews, authentication, subagents, and Drive all run in it, backed by the local daemon. `demesne prompt` remains for scripts and headless use.

The desktop window renders directly in the system webview: WKWebView on macOS and WebKitGTK on Linux.

## Prerequisites

For development, install [Bun 1.4.0](https://bun.sh), Rust with Cargo, and the platform tools listed by [Tauri's prerequisite guide](https://v2.tauri.app/start/prerequisites/).

### macOS

Install Xcode command-line tools and a stable Rust toolchain. Full Xcode can also provide the required SDK.

```sh
xcode-select --install
```

### Linux

The initial desktop build targets Ubuntu 22.04 and 24.04, which provide WebKitGTK 4.1 in their standard repositories. Build on the oldest target distribution for compatibility with its libraries. [Tauri's Linux distribution guidance](https://v2.tauri.app/distribute/debian/#limitations)

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

A desktop session is required to show the app. A terminal over headless SSH does not supply a window server; use [headless CLI commands](cli-reference.md#headless-output) there. Native window capture remains macOS-only.

Ubuntu 20.04 is not supported. It lacks WebKitGTK 4.1, which Tauri 2 needs.

Windows is not validated in this first milestone.

## Run from source

From the repository root:

```sh
bun install --frozen-lockfile
bun run desktop
```

The desktop launcher prepares the shared frontend and Bun backend resources, then starts the Tauri development build.

Use **Open project** to choose a workspace through the native folder picker. The first time you open a folder, Demesne asks whether you trust its files, with **Trust folder** and **Quit**; see [workspace trust](../SECURITY.md#workspace-trust). Folder ownership and permissions aren't checked.

Connect a provider through the setup interface or reuse an existing Demesne configuration. ChatGPT browser sign-in, OpenRouter, and local OpenAI-compatible providers use the existing [authentication](authentication.md) and [configuration](configuration.md) implementations.

## Open from the terminal

Run `demesne` in a project folder and the desktop window opens on that folder. `demesne chat "fix the failing test"` opens it and sends the words as the first message. `--model`, `--session`, `--workspace` and `--setup` pass through to the window.

`demesne` looks for the app in this order: `DEMESNE_DESKTOP_BIN`; on macOS, `Demesne.app` in `/Applications` or `~/Applications`; `demesne-desktop` on PATH; a build in this checkout under `apps/desktop/src-tauri/target`. From a checkout with Cargo installed, it falls back to `bun run desktop`. Otherwise it says to build the app with `bun run build:desktop` or use `demesne prompt`.

Without a terminal, such as in a pipe or a script, `demesne chat "message"` runs like `demesne prompt`. See the [command reference](cli-reference.md).

## Build an app

```sh
bun run build:desktop
```

This produces a `.app` bundle on macOS or a `.deb` package on Linux under `apps/desktop/src-tauri/target/release/bundle/`. The bundle includes the compiled desktop-host sidecar, daemon, frontend assets, and native image dependencies. End users of the bundle do not need Bun or Rust installed. Model servers and configured external command/MCP dependencies remain separate software.

This is a source-build/development preview rather than a signed release channel. Developer ID signing, notarization, Windows installers, and automatic updates are not implemented by this milestone. Keep packaged resources together; copying only the executable omits its backend dependencies.

## Closing the app and stopping work

Closing the desktop window ends its host. It does not stop an independent daemon-owned coding turn or background command, and a running Drive mission [keeps working in the background](agent-drive.md#drive-keeps-working-when-you-close-the-window) until it settles. Reopen Demesne to return to the last project and session and inspect recorded progress. This selection is stored in private `desktop-ui.json` preferences, keyed by project and daemon; missing or archived sessions open a new session instead. A mission that was still working is taken back and resumed in the window; a paused one stays paused.

Use the conversation's cancel control to interrupt a coding turn. Use Drive's pause/stop controls for its mission. Stopping the daemon is a separate operation and interrupts daemon-owned work.

The desktop and CLI use the same configured data directory and daemon. Avoid launching two clients that both orchestrate the same Drive mission.

## Verification and current limits

The [desktop workflow](../.github/workflows/desktop.yml) builds platform resources and runs the relevant Rust and desktop integration checks. Linux checks use Xvfb and real WebKitGTK through Tauri's native WebDriver route, with a disposable workspace and deterministic provider. They do not use personal credentials or real model requests. See the [implementation guide](../apps/desktop/README.md#verification) for commands and the exact coverage.

Virtual X11/software rendering does not establish performance on every physical GPU or Wayland compositor. WKWebView and WebKitGTK can render fonts, scrolling, and CSS differently from each other, so a Linux screenshot is not proof of macOS visual fidelity.

No tray-resident mode, automatic updates, or release signing is implied by the app bundle.
