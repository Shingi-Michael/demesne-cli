# Desktop app

[Documentation index](README.md) · [Implementation](../apps/desktop/README.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Demesne uses Electron and bundled Chromium on macOS, Linux and Windows. Its existing HTML/CSS/TypeScript interface retains conversations, file inspection, diffs, verification, previews, authentication, subagents and Drive. The existing Bun daemon owns coding turns and session data; `demesne prompt` remains available for headless use.

## Prerequisites

For development, install [Bun 1.4.0](https://bun.sh) and Node.js 22 or newer for packaging tools. No Rust or system webview development libraries are needed. Build on the target operating system and architecture so the compiled Bun backends and native image codecs match the package.

On macOS, install Xcode command-line tools for packaging. Linux needs a graphical session and Chromium runtime libraries (GTK 3, NSS, ALSA, GBM); CI checks Ubuntu 22.04 and 24.04. Windows packaging uses NSIS. Native window capture remains macOS-only; Windows end-to-end behavior is not yet verified.

## Run from source

```sh
bun install --frozen-lockfile
bun run desktop
```

Use **Open project** to select a folder. Existing workspace trust, provider setup, authentication and configuration behavior is retained. Your sessions and private `desktop-ui.json` preferences remain in the same daemon data directory.

## Open from the terminal

Run `demesne` in a project directory. `demesne chat "fix the failing test"` opens the app and sends the initial message. `--model`, `--session`, `--workspace` and `--setup` pass through to the host.

The launcher checks `DEMESNE_DESKTOP_BIN`, installed application locations, `demesne-desktop` on PATH, and Electron bundles in `apps/desktop/release`. A source checkout with Electron dependencies installed falls back to `bun run desktop`. Without a terminal, `demesne chat` uses headless output.

## Build an app

```sh
bun run build:desktop
```

Outputs under `apps/desktop/release` are a macOS `.app`, Linux `.deb`, or Windows NSIS `.exe`. Use `bun run build:desktop -- --dir` for an unpacked package. The package includes Chromium, the Bun host and daemon, frontend assets and native image dependencies. End users do not need Bun, Node.js or Rust. Configured external tools and model servers remain separate dependencies.

The release workflow produces platform artifacts and checksums. These source changes do not replace artifacts already published on GitHub. Release signing, notarization and automatic updates still need configuration. Keep the complete application together; copying a single executable loses required resources.

## Closing the app and stopping work

On macOS the window's close button hides it; click the Dock icon to return. Quit exits the app and its UI host. On Linux and Windows, closing the window quits. Daemon-owned turns continue after app exit. A running Drive mission is handed to a detached Bun host; reopening the project reclaims it. Use the session cancel and Drive pause/stop controls to stop work. Stopping the daemon is a separate operation.

The last project and session are restored on launch. Missing or archived sessions open a new session instead. Avoid opening two clients that orchestrate the same Drive mission.

## Verification

See the [implementation guide](../apps/desktop/README.md#verification). Electron lifecycle checks exercise the real Chromium renderer with a disposable workspace and deterministic model, including approvals, edits, persisted sessions and background work. No personal credentials or production test endpoint are used. Tests currently run on macOS and Linux; Windows packaging and backend checks do not establish full UI compatibility. Virtual displays do not establish performance on every physical GPU.

## Compacted conversation

After successful compaction, the conversation shows the saved summary in place of older turns. The retained recent turns and subsequent messages stay visible. Use **Expand full history** on the summary card to restore the complete chronological conversation, then **Collapse older conversation** to return to the summary. Expansion stays in effect during streaming updates; reopening a session or creating a new checkpoint starts collapsed. This changes only the view; the complete transcript remains saved. Failed or cancelled compaction does not create a new collapsed section.

## Workspace layout

The left sidebar opens with the project: its mark, its name and one line of pulse (the branch, then what needs you). Clicking the project opens the switcher, which lists recent projects and **Open a folder…** (⌘O). Beside it sit a magnifier, which unfolds conversation search, and **+**, which starts a new chat (⌘N). Below is one inbox-style list of conversations: a conversation that needs you gets a second line in colour (waiting for your approval, a branch ready to review), a settled one is a single quiet line with its time, and older days are grouped under a heading. Drive, when it has something in hand, is a short footer showing its mission and how far it has got; **Open ›** opens its panel. Settings and the connection sit at the bottom.

The toolbar toggle folds the sidebar into a 60px rail (the mark, **+**, conversations with a dot when one waits, a branch icon when Drive has a branch to review, Drive's progress ring and Settings) and remembers the preference. The top bar shows the conversation's title, its branch, and **⋯**, a small menu for this conversation (rename, compact with the context used, new chat, all conversations, archive, settings). There are no side panels besides Drive: a turn's edits, commands and checks unfold in place under their steps, and `/diff` unfolds the latest turn's edits.

A new chat opens with a greeting ("Thursday evening · project on branch", then "What are we building, Mike?", the name from git's `user.name`) and the composer. Drive's best idea is the composer's ghost text; Tab takes it. One line under the composer says how many ideas Drive has and opens its panel or runs them overnight.

A conversation reads as one column. Your ask is a bubble on the right with its time under it. A turn shows "Thought for 1.2s", then its steps as one quiet line each on a thin guide (an icon, the verb, the target in monospace, and what came of it on the right); an edit's row unfolds its diff in place and a command's row unfolds its output. The answer sits beside a small **d.** mark, and the receipt under it says the model, the time, the speed, how many files changed, whether the checks passed and how many steps there were, with **Copy** and **Undo changes**. A permission is one amber row above the composer: **Allow ↵**, **Always** and **Deny Esc**, with **command** or **diff** to unfold the whole thing; typing in the composer says what to do instead. What Drive is doing shows as a pill above the composer.

The composer's bar holds **+** to mention a file, the **Ask before edits** chip (which opens Settings), the model, a context ring (its numbers in the tooltip) and a square send button that reads Stop while a turn runs. Conversations use a proportional system font for reading and retain monospace for code and diffs. Settings, provider setup, model selection and approvals share the same spacing and theme roles; existing dark, light and custom themes remain available.
