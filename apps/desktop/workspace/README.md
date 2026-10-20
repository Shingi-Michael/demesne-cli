# Desktop workspace

This folder holds the daemon-connected interface the [desktop app](../README.md) shows in its window. The desktop host runs `host.ts` and `state-wire.ts` from here, and the window loads `live.ts`, `markdown.ts`, `ui.css`, `live.css` and `assets/`. Code shared with the CLI lives in `packages/drive`, `packages/workbench` and `packages/setup`. Non-interactive commands such as `demesne prompt` use the plain streaming CLI instead.

[Documentation index](../../../docs/README.md) · [Desktop app](../../../docs/desktop.md) · [Commands and keyboard](../../../docs/cli-reference.md) · [Interface design](../../../docs/interface-design.md)

## What it covers

The interface uses your existing config, daemon, models, workspace tools, session journal, approvals and Drive controller. It supports live conversation and reasoning, file changes, checks, mentions, model and theme settings, queued follow-ups, questions, provider setup and browser sign-in. Setup backs up the user config. If a daemon is already running, restart it after changing its provider settings, as with `demesne setup`. The keyboard is documented in [Commands and keyboard](../../../docs/cli-reference.md#keyboard-and-focus).

Drive uses direct daemon operations and recorded evidence. It cannot answer permissions or questions; user intervention pauses it. See [Agent Drive](../../../docs/agent-drive.md).

## Host and state

`host.ts` (`WorkspaceHost`) owns authenticated daemon requests, config, filesystem operations and credentials. The page receives public snapshots and sends named actions; it has no daemon token, Node access, network connection or arbitrary shell API. Markdown is sanitized before rendering. Drive operations validate the session and recorded evidence; live corrections also reject stale worker state. The desktop's [process boundary](../README.md#process-boundary) describes how the window, Electron main process and host connect.

`state-wire.ts` sends changed fields, changed turns and appended text. The browser retains unchanged history locally. Revision and text-offset checks reject incomplete updates, buffer updates that overtake a bootstrap response, and request an authoritative snapshot before continuing. `markdown.ts` re-lexes the complete reply for Markdown correctness but only sanitizes, highlights and replaces changed blocks; unchanged blocks retain their DOM nodes. Folded turns release those nodes, and static Markdown caching has a 2 MiB byte budget. Drive reads recorded daemon state, never the page.

## No side panels

The desktop has no side panels. The sidebar’s Drive row turns the main column into Drive’s page (`#drive-page`, `renderDrivePage` in `live.ts`): the mission box, what Drive is working on with its controls, branches ready for review, and ideas. Missions also appear as conversation turns, and ideas can unfold above or under the composer. A turn's edits, commands and checks unfold in place under their steps, and the top bar's **⋯** is the conversation's menu. The host still answers `files`, `changes` and `processes` for Drive and tests.

## Drive completion

`/drive --bounded <mission>` finishes after verification. Plain `/drive <mission>` is continuous by default; `--continuous` makes that explicit. An idea's **Run** starts a bounded mission. The mission's details show stable task IDs, criteria and retained completion evidence. Resume does not restart a completed task; `/drive reopen <task-id> <reason>` is an explicit request to revisit it. Automatic reopen requires relevant changed evidence. See [Agent Drive](../../../docs/agent-drive.md) for the recorded-facts and loop rules.

Live Drive reviews react to completed checks, edit batches and repeated tool calls. They use the selected provider's inference queue and read fresh recorded evidence when a slot becomes available. Stale corrections are refused by the daemon. See [live check-ins](../../../docs/agent-drive.md#live-coder-check-ins).

## Verification

```sh
bun run typecheck
bun test apps/desktop/workspace/test
bun scripts/prepare-desktop.ts && dbus-run-session -- xvfb-run -a bun run desktop:check
```

The unit tests use deterministic or fake providers. The desktop check drives this interface in the real Electron window; see [desktop verification](../README.md#verification) for its coverage.
