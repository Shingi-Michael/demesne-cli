# Desktop workspace

This folder holds the daemon-connected interface the [desktop app](../README.md) shows in its window. The desktop host runs `host.ts` and `state-wire.ts` from here, and the window loads `live.ts`, `markdown.ts`, `ui.css`, `live.css` and `assets/`. Code shared with the daemon lives in `packages/drive`, `packages/workbench` and `packages/setup`.

[Documentation index](../../../docs/README.md) · [Desktop app](../../../docs/desktop.md) · [Commands and keyboard](../../../docs/commands.md) · [Interface design](../../../docs/interface-design.md)

## What it covers

The interface uses your existing config, daemon, models, workspace tools, session journal, approvals and Drive controller. It supports live conversation and reasoning, file changes, checks, mentions, model and theme settings, queued follow-ups, questions, provider setup and browser sign-in. Setup backs up the user config. If a daemon is already running, restart it after changing its provider settings. The keyboard is documented in [Commands and keyboard](../../../docs/commands.md#keyboard-and-focus).

Drive uses direct daemon operations and recorded evidence. It cannot answer permissions or questions; user intervention pauses it. See [Agent Drive](../../../docs/agent-drive.md).

## Host and state

`host.ts` (`WorkspaceHost`) owns authenticated daemon requests, config, filesystem operations and credentials. The page receives public snapshots and sends named actions; it has no daemon token, Node access, network connection or arbitrary shell API. Markdown is sanitized before rendering. Drive operations validate the session and recorded evidence; live corrections also reject stale worker state. The desktop's [process boundary](../README.md#process-boundary) describes how the window, Electron main process and host connect.

`state-wire.ts` sends changed fields, changed turns and appended text. The browser retains unchanged history locally. Revision and text-offset checks reject incomplete updates, buffer updates that overtake a bootstrap response, and request an authoritative snapshot before continuing. `markdown.ts` re-lexes the complete reply for Markdown correctness but only sanitizes, highlights and replaces changed blocks; unchanged blocks retain their DOM nodes. Folded turns release those nodes, and static Markdown caching has a 2 MiB byte budget. Drive reads recorded daemon state, never the page.

## No side panels

The desktop has no side panels. The sidebar’s Drive row turns the main column into Drive’s page (`#drive-page`, `renderDrivePage` in `live.ts`): a goal box, then one list of what Drive is working on, branches ready for review and ideas, each row showing its actions on hover. Missions also appear as conversation turns, and ideas can unfold above or under the composer. A turn's edits, commands and checks unfold in place under their steps, and the top bar's **⋯** is the conversation's menu. The host still answers `files`, `changes` and `processes` for Drive and tests.

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
### Accessibility DOM regression checks

```sh
DEMESNE_DOM_TESTS=1 DEMESNE_BROWSER_CHANNEL=chrome bun test apps/desktop/workspace/test/*accessibility.dom.test.ts
```

These opt-in suites use an already installed Chrome through Playwright; they do not download a browser or start a daemon. Omit `DEMESNE_BROWSER_CHANNEL` to use an already installed Playwright Chromium. Composer and tab tests mount production renderers and keyboard handlers in small DOM fixtures, recording or simulating host actions instead of executing them. Math tests bundle the production Markdown renderer and its existing dependencies in memory. They check focus traversal and retention, completion roles and selection, tab shortcuts, and semantic math through static, cached, and streamed rendering. They are not the full Electron check or a screen-reader validation.

Tab completes a command or file only while its suggestions are open; otherwise it moves focus forward. Shift+Tab always moves focus backward. In the composer, Alt+M changes permission mode and Alt+Right accepts a visible suggestion into an empty draft. On macOS, Alt is Option.
On the tab strip, Left/Right wrap focus between tabs and Home/End focus the first/last tab. Enter or Space activates a chat; arrows alone do not load it. Tab leaves the strip. Closing a focused tab keeps focus on a neighbor, or New chat when no tabs remain.
### Google AI Studio

Settings → Providers → Google AI Studio → Add key opens a local password field. It is not a chat input. Get or revoke a key at https://aistudio.google.com/apikey.

- **Check key** reads Google's native and OpenAI-compatible model catalogs, filters to compatible Gemini chat candidates, and reads their token limits. It does not generate text or save a credential.
- **Test & forget** makes two small, potentially billable streaming requests using a synthetic tool and its result. It sends no chats or workspace files, creates no chat turns, writes no config, and clears the password field afterward. Clear / cancel and leaving the page also clear the form and cancel pending checks. This does not remove an already saved connection.
- **Save & connect** requires the unchecked storage-consent box. It repeats the tool round-trip test, then writes the selected provider into the user config (mode 0600, not encrypted) and asks the daemon to reload providers without restarting. Existing non-Google providers are preserved. Only the tested model is enabled; Manage lets you choose a different one. A reload failure is reported separately from a successful save.
- **Remove saved key** removes the active config key and scrubs Google credentials from the config writer's `.bak` copy, then reloads providers. Backup-cleanup failures explicitly warn that a key may remain. This does not revoke the key at Google or remove external filesystem backups; revoke a throwaway key in AI Studio when finished.

The form is a stable DOM island: no key is interpolated into HTML, renderer snapshots, or local storage. Password values and Google request errors are excluded from the inspection helper's diagnostics. Discovery/test replies and errors contain no credentials. JavaScript memory is released normally, not cryptographically wiped.

This desktop-scoped integration uses the existing OpenAI-compatible adapter. It does not add Google-native reasoning/signature handling, image generation, or vision. Models requiring tool metadata the adapter cannot preserve may fail the compatibility test and are not enabled. Live Google behavior and account-specific quota still need verification with a locally entered key; fixture tests are not a claim that every Gemini model works.

Run the Google regression suite without credentials:

```sh
bun test apps/desktop/workspace/test/google-ai.test.ts apps/desktop/workspace/test/provider-host.test.ts apps/desktop/workspace/test/providers.test.ts apps/desktop/workspace/test/settings-page.test.ts
DEMESNE_DOM_TESTS=1 DEMESNE_BROWSER_CHANNEL=chrome bun test apps/desktop/workspace/test/google-ai.dom.test.ts
```
