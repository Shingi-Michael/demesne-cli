# Desktop app

[Documentation index](README.md) · [Implementation](../apps/desktop/README.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Demesne uses Electron and bundled Chromium on macOS, Linux and Windows. Its HTML/CSS/TypeScript interface covers conversations, diffs, checks, authentication, subagents and Drive. The existing Bun daemon owns coding turns and session data; `demesne prompt` remains available for headless use.

## Prerequisites

For development, install [Bun 1.4.0](https://bun.sh) and Node.js 22 or newer for packaging tools. No Rust or system webview development libraries are needed. Build on the target operating system and architecture so the compiled Bun backends and native image codecs match the package.

On macOS, install Xcode command-line tools for packaging. Linux needs a graphical session and Chromium runtime libraries (GTK 3, NSS, ALSA, GBM). Windows packaging uses NSIS. Native window capture remains macOS-only; Windows end-to-end behavior is not yet verified.

## Run from source

```sh
bun install --frozen-lockfile
bun run desktop
```

Use **Open project** to select a folder. Workspace trust, provider setup, authentication and configuration work as on the command line. Your sessions and private `desktop-ui.json` preferences remain in the same daemon data directory.

## Open from the terminal

Run `demesne` in a project directory. `demesne chat "fix the failing test"` opens the app and sends the initial message. `--model`, `--session`, `--workspace` and `--setup` pass through to the host.

The launcher checks `DEMESNE_DESKTOP_BIN`, installed application locations, `demesne-desktop` on PATH, and Electron bundles in `apps/desktop/release`. A source checkout with Electron dependencies installed falls back to `bun run desktop`. Without a terminal, `demesne chat` uses headless output.

## Build an app

```sh
bun run build:desktop
```

Outputs under `apps/desktop/release` are a macOS `.app`, Linux `.deb`, or Windows NSIS `.exe`. Use `bun run build:desktop -- --dir` for an unpacked package. The package includes Chromium, the Bun host and daemon, frontend assets and native image dependencies. End users do not need Bun, Node.js or Rust. Configured external tools and model servers remain separate dependencies.

The release workflow (run on a version tag) produces platform artifacts and checksums. Release signing, notarization and automatic updates still need configuration. Keep the complete application together; copying a single executable loses required resources.

## Closing the app and stopping work

On macOS the window's close button hides it; click the Dock icon to return. Quit exits the app and its UI host. On Linux and Windows, closing the window quits. Daemon-owned turns continue after app exit. A running Drive mission is handed to a detached Bun host; reopening the project reclaims it. Use Esc twice or the stop square to cancel a turn, and Pause or Stop on a Drive mission's turn. Stopping the daemon is a separate operation.

The last project and session are restored on launch. Missing or archived sessions open a new session instead. Avoid opening two clients that orchestrate the same Drive mission.

## Verification

See the [implementation guide](../apps/desktop/README.md#verification). Electron lifecycle checks exercise the real Chromium renderer with a disposable workspace and deterministic model, including approvals, edits, persisted sessions and background work. No personal credentials or production test endpoint are used. Tests currently run on macOS and Linux; Windows packaging and backend checks do not establish full UI compatibility. Virtual displays do not establish performance on every physical GPU.

## Compacted conversation

After successful compaction, the conversation shows the saved summary in place of older turns. The retained recent turns and subsequent messages stay visible. Use **Expand full history** on the summary card to restore the complete chronological conversation, then **Collapse older conversation** to return to the summary. Expansion stays in effect during streaming updates; reopening a session or creating a new checkpoint starts collapsed. This changes only the view; the complete transcript remains saved. Failed or cancelled compaction does not create a new collapsed section.

## Workspace layout

The left sidebar puts **Projects** first, with chats nested beneath each project. Initially, the active project appears first, followed by recent projects. Drag a project name above or below another project to set your own order; the insertion line shows where it will land. The saved order persists when you switch projects or reopen the app, and newly opened projects join the end. With a project name focused, Alt+↑ and Alt+↓ move it one position. Use a project's chevron to expand or collapse its chats; this choice survives reopening the app. Click a project name to open it, or a chat to switch directly to that conversation. Each project initially shows six chats; **Show more** reveals the rest. **Search projects and chats** filters the groups and reveals matching conversations, and Escape clears the search. The **+** beside Projects and **Open a folder…** (⌘O) open another project.

**New chat** (⌘N), **Drive**, and **Branches** remain above the project list, and **Settings** (⌘,) stays at the foot. Chat state markers indicate waiting for approval or an answer, work in progress, a new reply, or failure. Drive worktree chats stay under their parent project with a branch mark. In the active project, hover a chat to delete it, use ⌘Z to undo a recent deletion, or double-click its title to rename it. Arrow keys, Home, and End move among visible chats; Delete or Backspace removes the focused chat in the active project. Ctrl+Tab and Ctrl+Shift+Tab step through the active project's visible chats.

The toolbar toggle folds the sidebar into a 60px rail (the mark, **+**, conversations with an amber ring when one needs you, a branch icon when Drive has a branch to review, Drive's progress ring and Settings) and remembers the preference. The Dock icon counts the chats that need you, so it shows from any app. The top bar shows the conversation's title, its branch, and **⋯**. When the branch has changes since the last commit, its chip shows the lines added and removed, and clicking it asks for a commit, a push and a pull request as the next turn. **⋯** is a small menu for this conversation (rename, compact with the context used, new chat, settings). There are no side panels: Drive is a page that takes the main column when you pick it in the sidebar, and a turn's edits, commands and checks unfold in place under their steps, and `/diff` unfolds the latest turn's edits.

A new chat opens with a greeting ("Thursday evening · project on branch", then "What are we building, Mike?", the name from git's `user.name`) and the composer. Drive's best idea is the composer's ghost text; Tab takes it. One line under the composer says how many ideas Drive has; **show ›** unfolds them there as rows (Run, Plan, Not now on hover), and **Run all overnight ›** runs the top three.

A conversation reads as one column. Your ask is a bubble on the right with its time under it. A turn shows "Thought for 1.2s", then its steps as one quiet line each on a thin guide (an icon, the verb, the target in monospace, and what came of it on the right); an edit's row unfolds its diff in place and a command's row unfolds its output. The answer sits beside a small **d.** mark, and the receipt under it says the model, the time, the speed, how many files changed, whether the checks passed and how many steps there were, with **Copy** and **Undo changes**. Click **N files changed** in the receipt to unfold every file the turn changed under the answer. Click any line to leave a note under it (Enter keeps it, Esc drops it); the composer shows how many notes are waiting, and your next message sends them first, one line per note, followed by anything you typed. A message can be only notes. A permission is one amber row above the composer: **Allow ↵**, **Always** and **Deny Esc**, with **command** or **diff** to unfold the whole thing; typing in the composer says what to do instead. What Drive is doing shows as a small chip centred above the composer: click it and a card grows out of it with Drive's ideas or the running mission (Esc or a click elsewhere puts it away), and a hairline under the chip fills while Drive works.

Settings (⌘,) is one sheet. A search sits at the top left, over the sections (**General**, **Appearance**, **Models**, **Providers**, **Conversations**); the arrow keys step through them, and typing searches every setting at once. Each row on the right says what it changes and carries its own control: a switch, a few segments or a dropdown, or a button that opens the one thing it names. General holds the mode (Build or Plan) and auto-approve for this conversation; Appearance the theme (with Undo after a change), **Make a theme** and the text size; Models the conversation's model; Providers a row per provider with Sign in or Sign out, and provider setup; Conversations the full list and cleanup. A change applies at once and the sheet stays open.

The composer is one box for what you type, with a faint ↵ in its right corner that brightens once there is something to send and becomes a stop square while a turn runs. Under the box, as plain words, sit **+** to attach images, the chat's mode, and on the right the model with its thinking level and a context ring. The mode is one word: **Ask** (every edit and command asks first), **Accept edits** in green (file edits, new files and moves run without asking; deletes and commands still ask), **Plan** in blue (reads and proposes, changes nothing; the box's edge turns blue too) or **Auto** in amber (everything runs without asking). Click the word or press ⇧⇥ in the composer to step to the next one; the four names show above the box for a moment. Each chat keeps its own mode, and a new chat starts in Ask. Images (PNG, JPEG or WebP, up to six per message) attach by **+**, by pasting into the composer, or by dropping them anywhere on the window. They sit as small thumbnails inside the box above your text; hover one for × to remove it. Sent images show above your message, and the model receives them with it: as pixels when the provider takes images (ChatGPT, or `provider.vision = true`), otherwise as their names and sizes. Mention files with `@`. Clicking the ring unfolds its breakdown above it (conversation, tools, what is kept free for replies, and free space, with **Compact now**); Esc or a click away folds it. Surfaces are tones over the background with hairlines where an edge is needed, not outlines: three corner radii (6, 10, 14) and one shadow ramp, and anything that appears, folds or moves eases in over 140–220ms (none of it under `prefers-reduced-motion`). Inter and JetBrains Mono ship with the app. Conversations use Inter for reading and retain monospace for code and diffs. Settings, provider setup, model selection and approvals share the same spacing and theme roles; existing dark, light and custom themes remain available.
