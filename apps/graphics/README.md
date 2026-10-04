# Graphics terminal UI

This is the daemon-connected HTML/CSS interface for Ghostty. Chromium renders offscreen; changed image tiles are delivered inside the terminal through Kitty graphics. This is the default interactive `demesne` interface; non-interactive commands use the plain streaming CLI.

[Documentation index](../../docs/README.md) · [Commands and keyboard](../../docs/cli-reference.md) · [Design contract](../../docs/terminal-design.md)

## Run

From the repository:

```sh
bun install --frozen-lockfile
bun run graphics  # downloads a missing Electron runtime automatically
```

Linux verifies a real sandboxed renderer before opening the UI. `bun run graphics:setup` runs the check independently; `--download-only` prepares headless builds. For SUID helper errors, use the explicit `bun run graphics:setup --install-sandbox` repair described in the [Linux guide](../../docs/linux.md). Setup only reports readiness after a sandboxed renderer produces pixels.

Or use the CLI entry point:

```sh
bun run demesne graphics --workspace /path/to/project
bun run demesne graphics --session SESSION_ID
bun run demesne graphics --setup
```

`--graphics` is an alias for the `graphics` command. `--server URL` selects a daemon and the UI automatically follows the terminal’s character-cell size, including Retina density and terminal font changes. `--scale auto` selects this default; `--scale 0.5-3` fixes an explicit zoom instead (for example, `bun run graphics --scale=2`). Run directly in Ghostty; the capability probe requires Kitty graphics and terminal cell-size replies.

The interface uses your existing config, daemon, models, workspace tools, session journal, approvals, and Drive controller. It supports live conversation and reasoning, file changes, verification, execution logs and detail, files and mentions, history, context, image preview and pinning, model/theme/settings menus, queued follow-ups, questions, provider setup and browser sign-in. Setup backs up the user config. If a daemon is already running, restart it after changing its provider settings, as with `demesne setup`.

| Input | Action |
| --- | --- |
| Enter | Send; while a turn is running, leave the queued text alone |
| Shift+Enter | New line |
| Esc twice | Stop the current turn (within 1.5 seconds) |
| Ctrl+C | Stop a running turn, or exit when idle |
| Ctrl+Q | Exit the terminal UI; the daemon retains running work |
| Tab on an empty composer / Ctrl+K | Settings |
| Ctrl+B | Execution log |
| Ctrl+G | Follow the current turn |
| Alt+H | History |
| `/` / `@` | Commands / workspace file completion |
| ↑↓, Enter, Esc | Select, open, close menus and panels |
| Alt+Enter | Expand or restore a panel |
| y / n | Allow once / deny a pending approval |

Mouse clicks, scrolling, selection, paste, and resizing are forwarded to the hidden browser. Ctrl+Y copies a browser selection. Drive uses direct daemon operations and recorded evidence by default. `DEMESNE_DRIVE_CONTROL=ui` selects its compatibility DOM-control path. Drive cannot answer permissions or questions; user intervention pauses it. See [Agent Drive](../../docs/agent-drive.md).

## Package

```sh
bun run build
bun run build:graphics
./dist/demesne graphics
```

Keep `dist/graphics` beside `dist/demesne`, and keep the daemon and its image dependencies from the normal build. The graphics directory includes the compiled host, Chromium runtime, fonts, renderer, and local Figma SVG assets. Its macOS framework links must remain relative when copying or archiving it. The optional runtime is large, so the ordinary CLI build does not include it automatically.

## Verification

```sh
bun run typecheck
bun test apps/graphics/test
bun run graphics:check
bun apps/graphics/check-auth-scene.ts
bun apps/graphics/check-display-scale.ts
bun apps/graphics/check-files.ts
bun apps/graphics/check-streaming.ts
bun apps/graphics/benchmark-live.ts
bun apps/graphics/benchmark-live.ts 240 60
```

`graphics:check` runs the real HTTP daemon with a deterministic model in a temporary workspace/home. Through a synthetic PTY it exercises message entry, completions, both approval types, questions, real file writes and verification, all inspector panels, image import/pinning, queue cancellation/restoration, Drive submission and pause, setup/config writing, resize and exit cleanup. It saves rendered screenshots under `/tmp/demesne-graphics-live-check`. Each captured screen is compared with independently decoded terminal tiles; a maximum 2/255 channel tolerance accounts for Chromium's border antialias rounding. Auth has a separate visual fixture, plus credential-handling tests with a fake provider; it does not sign into a real account.

`check-display-scale.ts` verifies standard and Retina-sized cells, both mouse coordinate modes, terminal font changes (including an unchanged physical window size), explicit zoom overrides, and decoded pixel equality.

The checked-in benchmark JSON files measure input to decoded terminal pixels in the connected app, including test-harness PNG decoding. They exclude Ghostty decoding, GPU presentation, and display latency.

`check-streaming.ts` checks partial Markdown against complete parsing at every character boundary, preserves finished block nodes across streaming and tool transitions, checks inactive/active Drive observation scheduling, and profiles short and long conversations. Pass `--baseline=/path/to/earlier/apps/graphics` to compare render timings and screenshots with an earlier checkout. Recorded results are in `streaming-benchmark.json`; these are synthetic frontend measurements, not Ghostty presentation latency.

## Boundaries

`host.ts` owns authenticated daemon requests, config, filesystem operations, and credentials. The sandboxed renderer receives public snapshots through a narrow preload bridge; it has no daemon token, Node access, network connection, or arbitrary shell API. Markdown is sanitized before rendering. The compatibility UI-control path uses short-lived capabilities for exact composer text. Direct Drive operations validate the session and recorded evidence; live corrections also reject stale worker state.

`renderer.cjs`, `tiles.cjs`, and `transport.ts` retain dirty pixels and send only changed tiles. One frame batch waits for terminal-output drain before the next can leave, so a slow terminal does not accumulate obsolete frames.

Scrolling changes every tile, so per-frame cost decides how it feels. Tiles leave as RGBA compressed with fast zlib (Kitty `f=32,o=z`) rather than PNG, encoded in parallel by a small worker pool (`tile-encoder.cjs`). When the terminal confirms at startup that it can read files here (a Kitty `t=t` query, so not over SSH), workers write each tile to a private temporary directory and only its path crosses the terminal, which reads and deletes it; otherwise tiles travel inline. Chromium rasterizes on the GPU. Measured at 3456×2160 (Retina), one scroll step went from ~119 ms and ~718 KB through the terminal to ~38 ms and ~10 KB:

```sh
bun apps/graphics/benchmark-scroll.ts 2 files 216 60   # scale, files|inline, columns, rows
```

`DEMESNE_GRAPHICS_FILES=0` forces inline tiles, `DEMESNE_GRAPHICS_GPU=0` forces software rendering, and `DEMESNE_GRAPHICS_TRACE=<file>` writes one JSON line per frame stage (input, paint, flush, draw) for diagnosing frame cost. Resize starts a new tile generation; exit deletes the UI's images and restores terminal modes. The start-screen prototype is kept separate from this live application.

`state-wire.ts` sends changed fields, changed turns, and appended text. The browser retains unchanged history locally. Revision and text-offset checks reject incomplete updates, buffer updates that overtake a bootstrap response, and request an authoritative snapshot before continuing. `markdown.ts` re-lexes the complete reply for Markdown correctness but only sanitizes, highlights, and replaces changed blocks; unchanged blocks retain their DOM nodes. Folded turns release those nodes, and static Markdown caching has a 2 MiB byte budget. The compatibility Drive path observes the page only on demand or at a bounded active cadence; the default direct path reads recorded daemon state.

## Review panel upgrades

- **Files (`Alt+O`):** filter by filename or path, open a file with line numbers, use `Ctrl+F` to find literal text (Enter/Shift+Enter for next/previous) and `Ctrl+L` to go to a line. Click a line number, then Shift-click another (or Shift+↑/↓) to select a range; **Attach lines** inserts the exact loaded code and path/range into the composer. Fenced code stays literal at submission, including `@` text. Opened text is limited to 2 MiB; only visible lines are rendered. Known workspace `path:line:column` locations in command output and current-side diff line numbers open the source. Paths resolve against the command's working directory; historical diff numbers refer to the current file when opened. Every two seconds while Files is visible, a content revision check reports external edits or deletion without replacing the loaded copy. **Reload** explicitly reads current contents; no file polling runs when the panel is closed. Esc returns to the file list, then closes the panel.
- **Changes:** choose This turn, Session, or Workspace. Turn/session views use recorded tool evidence, including undos; Workspace compares current tracked and untracked files with Git HEAD. Full before/after views and `[` / `]` hunk navigation provide context. Undo file restores the last matching recorded checkpoint and refuses later edits. Workspace-only changes have no automatic undo checkpoint. Diff payloads are bounded and omitted text is labeled.
- **Verification (`Alt+T` or ✓ in the rail):** recorded checks are grouped by command and working directory, with passed, failed, running, outdated, stopped, and unverified states. An empty panel says Not run. Source fingerprints cover Git tracked/non-ignored files excluding protected paths; non-Git workspaces exclude generated and dependency directories. Source scans are bounded to 10,000 files/64 MiB; incomplete scans never claim freshness. Checks can be rerun individually or as a sequential failed-check batch, using the recorded argv and cwd without another model request. Older results without fingerprints remain unverified. Ctrl+C stops a running turn or a foreground check; Ctrl+Q closes the UI while daemon-owned work continues.
- **Log → Commands:** running foreground/background commands expose bounded stdout/stderr tails, PID, working directory, elapsed time, last output, actual model queue position, and Stop command. The UI polls only while inspecting commands/checks and fetches output only for the selected command. Completion records survive daemon restart; old persisted PIDs are never used to stop a process. The list shows the most recent 200 records plus active commands within that bound.
- **Preview:** Fit and 100% zoom, zoom controls and drag-to-pan. At 100%, one image pixel maps to one terminal pixel, including Retina. Choose an existing image as a reference or import a PNG/JPG/WebP export from the workspace. Compare overlays the images with an opacity slider; unequal dimensions are labeled and images are aligned at the top left without stretching. Pixel dimensions and recorded time are shown; optional viewport dimensions can be supplied at import and missing viewport metadata is labeled.
- **Panel navigation:** drag the divider (or focus it and use left/right arrows) to resize. Width persists in the private graphics UI preferences file. Within a session, switching panels remembers selection, opened file and scroll position. New sessions clear that navigation state.

These features require the updated daemon. Build with `bun run build` and `bun run build:graphics`. After existing work finishes, restart the daemon using the newly built binary, then restart the graphics UI:

```sh
bun run demesne daemon stop
DEMESNE_DAEMON_BIN="$PWD/dist/demesned" bun run demesne daemon start
bun run graphics
```

`bun apps/graphics/check-panels.ts` exercises live output, stop, source staleness, reruns, all three diff scopes, full-file review, undo, reference import, image pan/zoom/overlay, and persistent width through the terminal bridge. Add `--retina` after its optional output directory for a 2× run. Content pixels are checked within 2/255 of an independent Chromium capture; outer rounded corners allow 6/255 for compositor alpha rounding on Retina.

`bun apps/graphics/check-files.ts` verifies file search, compiler-location links, line navigation, selected-code submission, external edits/deletion, and a 20,000-line file through the terminal bridge. It also keeps source search and selection open during streamed replies. Add `--retina` after the output directory for a 2× check.

## Drive completion

`/drive --bounded <mission>` finishes after verification. Plain `/drive <mission>`
is continuous by default; `--continuous` makes that explicit. The mission form
also exposes **Keep choosing improvements**, and NEXT’s **Run** starts a bounded mission. The panel
shows stable task IDs, criteria, and retained completion evidence. Resume does not
restart a completed task; `/drive reopen <task-id> <reason>` is an explicit request
to revisit it. Automatic reopen requires relevant changed evidence. See
[Agent Drive](../../docs/agent-drive.md) for the recorded-facts and loop rules.

`bun apps/graphics/check-drive-tasks.ts` exercises bounded completion, exact check
inspection, no automatic repetition, and explicit reopening through the real UI.
Add `--retina` after the output directory to check 2× rendering.

Live Drive reviews now react to completed checks, edit batches, and repeated tool
calls. They use the selected provider’s inference queue and read fresh recorded evidence
when a slot becomes available. The trace shows queue/review time; stale corrections
are refused by the daemon. See [live check-ins](../../docs/agent-drive.md#live-coder-check-ins).


## Shutdown and broken pipes

Closing the terminal or its host can disconnect Electron while a frame is being written. [pipe-writer.cjs](pipe-writer.cjs) handles asynchronous `EPIPE`, stream errors and closure, stops further writes/acknowledgements, and initiates renderer shutdown. Renderer EOF, SIGTERM and early startup shutdown follow the same cleanup path. The host restores terminal modes and removes graphics placements when it can still write to the terminal.

These native-process checks complement unit tests and visual checks:

```sh
bun apps/graphics/check-disconnect.ts
bun apps/graphics/check-subagent-shutdown.ts
```

The first exercises renderer pipe loss and startup/exit races; the second closes a UI while three mock subagents stream. Neither needs a real model. For a packaged renderer, `check-disconnect.ts` accepts renderer and Electron paths as its first two arguments. See [troubleshooting](../../docs/troubleshooting.md#epipe-or-an-electron-error-dialog) for replacing an older running renderer.
