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
| ↑↓, Enter, Esc | Select, open, close menus |
| y / n | Allow once / deny a pending approval |

Drive uses direct daemon operations and recorded evidence by default. `DEMESNE_DRIVE_CONTROL=ui` selects its compatibility DOM-control path. Drive cannot answer permissions or questions; user intervention pauses it. See [Agent Drive](../../docs/agent-drive.md).

## Host and state

`host.ts` owns authenticated daemon requests, config, filesystem operations, and credentials. The page receives public snapshots and sends named actions; it has no daemon token, Node access, network connection, or arbitrary shell API. Markdown is sanitized before rendering. The compatibility UI-control path uses short-lived capabilities for exact composer text. Direct Drive operations validate the session and recorded evidence; live corrections also reject stale worker state. The desktop's [process boundary](../desktop/README.md#process-boundary) describes how the window, Electron main process and host connect.

`state-wire.ts` sends changed fields, changed turns, and appended text. The browser retains unchanged history locally. Revision and text-offset checks reject incomplete updates, buffer updates that overtake a bootstrap response, and request an authoritative snapshot before continuing. `markdown.ts` re-lexes the complete reply for Markdown correctness but only sanitizes, highlights, and replaces changed blocks; unchanged blocks retain their DOM nodes. Folded turns release those nodes, and static Markdown caching has a 2 MiB byte budget. The compatibility Drive path observes the page only on demand or at a bounded active cadence; the default direct path reads recorded daemon state.

## No side panels

The desktop has no side panels. Drive lives in the conversation: a mission is a turn, and its ideas unfold above or under the composer. A turn's edits, commands and checks unfold in place under their steps in the conversation, and the top bar's **⋯** is the conversation's menu. The host still answers `files`, `changes`, `processes` and `rerun-checks` for other clients and tests; the desktop renderer no longer draws Files, Changes, Verification, Log, Context, History or Preview views.

## Drive completion

`/drive --bounded <mission>` finishes after verification. Plain `/drive <mission>`
is continuous by default; `--continuous` makes that explicit. The mission form
also exposes **Keep choosing improvements**, and an idea's **Run** starts a bounded mission. The mission's details
show stable task IDs, criteria, and retained completion evidence. Resume does not
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
