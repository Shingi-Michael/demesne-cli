# Agents that live in Demesne

Demesne finds the agent tools installed on this machine (Claude Code `claude`,
Codex `codex`, Gemini `gemini`) and lists them under the open project's chats,
in the sidebar's **Agents** list. Clicking one opens its chat in that project.
You never start them in a terminal.

- **A chat that runs the tool.** Each message runs the tool headless in the
  project's folder (`claude -p --output-format stream-json`, `codex exec --json`,
  `gemini -p --output-format stream-json`). What it does shows as the turn's
  working lines (Read, Edited, Ran…), and its last message is the answer.
- **It keeps its own session.** Claude Code and Codex carry on their own session
  from turn to turn (`--resume`, `codex exec resume`); the ids are kept in
  `<data dir>/agent-sessions.json`. Gemini gets the chat so far each time.
- **Its own rules.** The tool runs its tools under its own permission settings:
  Claude Code in `acceptEdits`, Codex `--sandbox workspace-write` (its workspace sandbox; `--full-auto` is gone since Codex CLI 0.166),
  Gemini `--approval-mode auto_edit`. Commands those modes don't allow are
  refused by the tool, not asked about in Demesne.
- **Reachable over Heartbeat.** An agent's chat claims its Heartbeat address when
  it is opened and whenever the daemon starts. Mail starts its next turn, and when
  the turn ends Demesne sends the answer back to the sender (`DONE` for a request,
  `INFORM` otherwise, `FAIL` when it didn't finish).

Daemon: `apps/daemon/src/agent-cli.ts`; `GET /v1/agents?workspace=`, `POST /v1/agents/open`.
A chat is an agent's when its model is `agent:<id>`.
Check against the real app: `bun scripts/check-agents.ts` (after `bun scripts/prepare-desktop.ts`).
