# Desktop app preview

[Documentation index](README.md) · [Implementation](../apps/desktop/README.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Demesne's desktop client uses Tauri 2 to display the existing HTML/CSS/TypeScript interface in a native window. Conversations, file inspection, diffs, verification, previews, authentication, subagents, and Drive use the same daemon and shared UI as the terminal client.

The desktop window renders directly in the system webview: WKWebView on macOS and WebKitGTK on Linux. It does not need Ghostty, Electron, Kitty image support, or terminal pixel encoding. This change alone does not establish a particular RAM, startup-time, or GPU-performance improvement; comparisons need measurements of the whole application.

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

Ubuntu 20.04 is still covered by the [Electron terminal setup](linux.md). It is not a supported source-build baseline for this Tauri 2 desktop preview. The Electron SUID-helper repair is specific to that terminal path and is not desktop installation guidance.

Windows is not validated in this first milestone.

## Run from source

From the repository root:

```sh
bun install --frozen-lockfile
bun run desktop
```

The desktop launcher prepares the shared frontend and Bun backend resources, then starts the Tauri development build. It does not need a separate Electron download.

Use **Open project** to choose a workspace through the native folder picker. The first time you open a folder, Demesne asks whether you trust its files, with **Trust folder** and **Quit**; see [workspace trust](../SECURITY.md#workspace-trust). Folder ownership and permissions aren't checked.

Connect a provider through the setup interface or reuse an existing Demesne configuration. ChatGPT browser sign-in, OpenRouter, and local OpenAI-compatible providers use the existing [authentication](authentication.md) and [configuration](configuration.md) implementations.

## Build an app

```sh
bun run build:desktop
```

This produces a `.app` bundle on macOS or a `.deb` package on Linux under `apps/desktop/src-tauri/target/release/bundle/`. The bundle includes the compiled desktop-host sidecar, daemon, frontend assets, and native image dependencies. End users of the bundle do not need Bun or Rust installed. Model servers and configured external command/MCP dependencies remain separate software.

This is a source-build/development preview rather than a signed release channel. Developer ID signing, notarization, Windows installers, and automatic updates are not implemented by this milestone. Keep packaged resources together; copying only the executable omits its backend dependencies.

## Closing the app and stopping work

Closing the desktop window ends its host and Drive orchestration. It does not stop an independent daemon-owned coding turn or background command. Reopen Demesne to return to the last project and session and inspect recorded progress. This selection is stored in private `desktop-ui.json` preferences, keyed by project and daemon; missing or archived sessions open a new session instead. An unfinished Drive mission returns paused; resume it deliberately.

Use the conversation's cancel control to interrupt a coding turn. Use Drive's pause/stop controls for its mission. Stopping the daemon is a separate operation and interrupts daemon-owned work.

The desktop and CLI use the same configured data directory and daemon. Avoid launching two clients that both orchestrate the same Drive mission.

## Verification and current limits

The [desktop workflow](../.github/workflows/desktop.yml) builds platform resources and runs the relevant Rust and desktop integration checks. Linux checks use Xvfb and real WebKitGTK through Tauri's native WebDriver route, with a disposable workspace and deterministic provider. They do not use personal credentials or real model requests. See the [implementation guide](../apps/desktop/README.md#verification) for commands and the exact coverage.

Virtual X11/software rendering does not establish performance on every physical GPU or Wayland compositor. The system webview can render fonts, scrolling, and CSS differently from Chromium, so terminal screenshots are not proof of desktop visual fidelity. Shared controls need their own native-webview verification.

No tray-resident mode, automatic updates, or release signing is implied by the app bundle.
