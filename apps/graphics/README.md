# Shared interface code

This folder holds the daemon-connected HTML/CSS/TypeScript interface that the [desktop app](../desktop/README.md) shows in its window. The desktop host imports `host.ts` and `state-wire.ts` from here, and the window loads `live.ts`, `markdown.ts`, `ui.css`, `live.css` and `assets/`. Non-interactive commands such as `demesne prompt` use the plain streaming CLI instead.

[Documentation index](../../docs/README.md) · [Desktop app](../../docs/desktop.md) · [Commands and keyboard](../../docs/cli-reference.md) · [Design contract](../../docs/terminal-design.md)

## What it covers

The interface uses your existing config, daemon, models, workspace tools, session journal, approvals, and Drive controller. It supports live conversation and reasoning, file changes, verification, execution logs and detail, files and mentions, history, context, image preview and pinning, model/theme/settings menus, queued follow-ups, questions, provider setup and browser sign-in. Setup backs up the user config. If a daemon is already running, restart it after changing its provider settings, as with `demesne setup`.

| Input | Action |
| --- | --- |
| Enter | Send; while a turn is running, leave the queued text alone |
| Shift+Enter | New line |
| Esc twice | Stop the current turn (within 1.5 seconds) |
| Tab on an empty composer / Ctrl+K | Settings |
| Ctrl+B | Execution log |
| Ctrl+G | Follow the current turn |
| Alt+H | History |
| `/` / `@` | Commands / workspace file completion |
| ↑↓, Enter, Esc | Select, open, close menus and panels |
| Alt+Enter | Expand or restore a panel |
| y / n | Allow once / deny a pending approval |

Drive uses direct daemon operations and recorded evidence by default. `DEMESNE_DRIVE_CONTROL=ui` selects its compatibility DOM-control path. Drive cannot answer permissions or questions; user intervention pauses it. See [Agent Drive](../../docs/agent-drive.md).

## Host and state

`host.ts` owns authenticated daemon requests, config, filesystem operations, and credentials. The page receives public snapshots and sends named actions; it has no daemon token, Node access, network connection, or arbitrary shell API. Markdown is sanitized before rendering. The compatibility UI-control path uses short-lived capabilities for exact composer text. Direct Drive operations validate the session and recorded evidence; live corrections also reject stale worker state. The desktop's [process boundary](../desktop/README.md#process-boundary) describes how the window, Rust core and host connect.

`state-wire.ts` sends changed fields, changed turns, and appended text. The browser retains unchanged history locally. Revision and text-offset checks reject incomplete updates, buffer updates that overtake a bootstrap response, and request an authoritative snapshot before continuing. `markdown.ts` re-lexes the complete reply for Markdown correctness but only sanitizes, highlights, and replaces changed blocks; unchanged blocks retain their DOM nodes. Folded turns release those nodes, and static Markdown caching has a 2 MiB byte budget. The compatibility Drive path observes the page only on demand or at a bounded active cadence; the default direct path reads recorded daemon state.

## Review panel upgrades

- **Files (`Alt+O`):** filter by filename or path, open a file with line numbers, use `Ctrl+F` to find literal text (Enter/Shift+Enter for next/previous) and `Ctrl+L` to go to a line. Click a line number, then Shift-click another (or Shift+↑/↓) to select a range; **Attach lines** inserts the exact loaded code and path/range into the composer. Fenced code stays literal at submission, including `@` text. Opened text is limited to 2 MiB; only visible lines are rendered. Known workspace `path:line:column` locations in command output and current-side diff line numbers open the source. Paths resolve against the command's working directory; historical diff numbers refer to the current file when opened. Every two seconds while Files is visible, a content revision check reports external edits or deletion without replacing the loaded copy. **Reload** explicitly reads current contents; no file polling runs when the panel is closed. Esc returns to the file list, then closes the panel.
- **Changes:** choose This turn, Session, or Workspace. Turn/session views use recorded tool evidence, including undos; Workspace compares current tracked and untracked files with Git HEAD. Full before/after views and `[` / `]` hunk navigation provide context. Undo file restores the last matching recorded checkpoint and refuses later edits. Workspace-only changes have no automatic undo checkpoint. Diff payloads are bounded and omitted text is labeled.
- **Verification (`Alt+T` or ✓ in the rail):** recorded checks are grouped by command and working directory, with passed, failed, running, outdated, stopped, and unverified states. An empty panel says Not run. Source fingerprints cover Git tracked/non-ignored files excluding protected paths; non-Git workspaces exclude generated and dependency directories. Source scans are bounded to 10,000 files/64 MiB; incomplete scans never claim freshness. Checks can be rerun individually or as a sequential failed-check batch, using the recorded argv and cwd without another model request. Older results without fingerprints remain unverified. Ctrl+Q closes the window while daemon-owned work continues.
- **Log → Commands:** running foreground/background commands expose bounded stdout/stderr tails, PID, working directory, elapsed time, last output, actual model queue position, and Stop command. The UI polls only while inspecting commands/checks and fetches output only for the selected command. Completion records survive daemon restart; old persisted PIDs are never used to stop a process. The list shows the most recent 200 records plus active commands within that bound.
- **Preview:** Fit and 100% zoom, zoom controls and drag-to-pan. Choose an existing image as a reference or import a PNG/JPG/WebP export from the workspace. Compare overlays the images with an opacity slider; unequal dimensions are labeled and images are aligned at the top left without stretching. Pixel dimensions and recorded time are shown; optional viewport dimensions can be supplied at import and missing viewport metadata is labeled.
- **Panel navigation:** drag the divider (or focus it and use left/right arrows) to resize. Width persists in the private `graphics-ui.json` preferences file. Within a session, switching panels remembers selection, opened file and scroll position. New sessions clear that navigation state.

## Drive completion

`/drive --bounded <mission>` finishes after verification. Plain `/drive <mission>`
is continuous by default; `--continuous` makes that explicit. The mission form
also exposes **Keep choosing improvements**, and NEXT’s **Run** starts a bounded mission. The panel
shows stable task IDs, criteria, and retained completion evidence. Resume does not
restart a completed task; `/drive reopen <task-id> <reason>` is an explicit request
to revisit it. Automatic reopen requires relevant changed evidence. See
[Agent Drive](../../docs/agent-drive.md) for the recorded-facts and loop rules.

Live Drive reviews now react to completed checks, edit batches, and repeated tool
calls. They use the selected provider’s inference queue and read fresh recorded evidence
when a slot becomes available. The trace shows queue/review time; stale corrections
are refused by the daemon. See [live check-ins](../../docs/agent-drive.md#live-coder-check-ins).

## Verification

```sh
bun run typecheck
bun test apps/graphics/test
dbus-run-session -- xvfb-run -a bun run desktop:check
```

The unit tests use deterministic or fake providers. The Linux desktop check drives this interface in the real desktop window; see [desktop verification](../desktop/README.md#verification) for its coverage.
