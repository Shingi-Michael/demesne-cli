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

The left sidebar is a list of one-line rows at the same height. The project comes first, as text: its mark and name, with its folder and branch under it. Then search, which finds conversations and switches projects: while it has focus, your other projects that match show under the chats with **Open a folder…** (⌘O) last, and Escape clears it. Then three fixed rows: **New chat** (⌘N), **Drive** (a dot when it has something for you, amber when it needs you; the row takes you to the mission or unfolds its ideas) and **Branches** (shown with a count when Drive has work waiting for review). Under a **Chats** label come the conversations, titles only. Each state has its own mark: an amber ring when one waits for your approval or answer (in the background too), a spinner while one works, a blue dot when one has a new reply you haven't opened, and a red cross when its last turn failed; a settled one has no mark, only its time. A chat Drive runs on its own branch shows a branch mark, with the branch in its tooltip; every tooltip has the full time and the state in words. The list shows six, and a quiet **N more** row under them opens search. Pointing at a row, or moving the keyboard onto it, swaps its time for a delete icon, and deleting it (no menu, no dialog) moves the next one up. Another conversation is archived a few seconds later, so ⌘Z brings back the one you just deleted. Double-click a title to rename it in place: Enter or clicking away keeps it, Escape puts it back. The arrow keys, Home and End move through the list, Delete or Backspace deletes the focused row, and Ctrl+Tab and Ctrl+Shift+Tab step through the chats. Settings (⌘,) sits at the foot.

The toolbar toggle folds the sidebar into a 60px rail (the mark, **+**, conversations with an amber ring when one needs you, a branch icon when Drive has a branch to review, Drive's progress ring and Settings) and remembers the preference. The Dock icon counts the chats that need you, so it shows from any app. The top bar shows the conversation's title, its branch, and **⋯**. When the branch has changes since the last commit, its chip shows the lines added and removed, and clicking it asks for a commit, a push and a pull request as the next turn. **⋯** is a small menu for this conversation (rename, compact with the context used, new chat, all conversations, archive, settings). There are no side panels, Drive included: a turn's edits, commands and checks unfold in place under their steps, and `/diff` unfolds the latest turn's edits.

A new chat opens with a greeting ("Thursday evening · project on branch", then "What are we building, Mike?", the name from git's `user.name`) and the composer. Drive's best idea is the composer's ghost text; Tab takes it. One line under the composer says how many ideas Drive has; **show ›** unfolds them there as rows (Run, Plan, Not now on hover), and **Run all overnight ›** runs the top three.

A conversation reads as one column. Your ask is a bubble on the right with its time under it. A turn shows "Thought for 1.2s", then its steps as one quiet line each on a thin guide (an icon, the verb, the target in monospace, and what came of it on the right); an edit's row unfolds its diff in place and a command's row unfolds its output. The answer sits beside a small **d.** mark, and the receipt under it says the model, the time, the speed, how many files changed, whether the checks passed and how many steps there were, with **Copy** and **Undo changes**. A permission is one amber row above the composer: **Allow ↵**, **Always** and **Deny Esc**, with **command** or **diff** to unfold the whole thing; typing in the composer says what to do instead. What Drive is doing shows as a pill above the composer.

Settings (⌘,) is one sheet. A search sits at the top left, over the sections (**General**, **Appearance**, **Models**, **Providers**, **Conversations**); the arrow keys step through them, and typing searches every setting at once. Each row on the right says what it changes and carries its own control: a switch, a few segments or a dropdown, or a button that opens the one thing it names. General holds the mode (Build or Plan) and auto-approve for this conversation; Appearance the theme (with Undo after a change), **Make a theme** and the text size; Models the conversation's model; Providers a row per provider with Sign in or Sign out, and provider setup; Conversations the full list and cleanup. A change applies at once and the sheet stays open.

The composer is one box for what you type, with a faint ↵ in its right corner that brightens once there is something to send and becomes a stop square while a turn runs. Under the box, as plain words, sit **+** to mention a file, **Ask before edits** (which opens Settings), and on the right the model with its thinking level and a context ring. Clicking the ring unfolds its breakdown above it (conversation, tools, what is kept free for replies, and free space, with **Compact now**); Esc or a click away folds it. Conversations use a proportional system font for reading and retain monospace for code and diffs. Settings, provider setup, model selection and approvals share the same spacing and theme roles; existing dark, light and custom themes remain available.
