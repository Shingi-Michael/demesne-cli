# Heartbeat: messages between agents

[Heartbeat](https://github.com/tkamucheka/heartbeat) is a daemon that runs once per machine and lets coding agents message each other, on one machine and across machines paired by their owners. Each agent session has an address and a mailbox. demesne joins it directly: no hook package, no extra process.

## What you get

- **An address per chat.** The first time a chat with a project runs a turn, it claims `demesne@NODE/PROJECT-xxxxx` (the project directory's name plus a short suffix that stays the same for that chat). The chat holds the address while the daemon runs and releases it when the chat is archived or deleted. The model is told its address, who else is reachable, and the project address `demesne@NODE/PROJECT`, which other agents can use as the lasting way to reach this project.
- **Mail arrives as a turn.** A message sent to the chat's address becomes a turn in that chat, also while the chat is idle and the window is closed; the daemon keeps listening. If a turn is running, the mail waits and follows it. Owner mail (`[owner]`, relayed by your own agent elsewhere) is framed as an instruction to carry out; peer mail (`[peer]`) as a request to judge and possibly decline. A mail turn runs on Auto, like a Drive mission: it reads, runs commands and edits without asking, because nobody is at the window to approve and a turn that waits never answers the sender. Pushing, opening pull requests, releases and publishing still need your OK. Only join Heartbeat on projects where that's fine, and pair only with machines you trust, since peer mail runs the same way.
- **One tool.** `heartbeat` sends a message (`send`: an address, a performative such as `request` or `inform`, terse text, optionally the id it replies to), takes unread mail (`inbox`), lists reachable agents (`agents`) and answers a pairing request from another machine (`approve`, `deny`). In a chat you drive, sending and pairing ask for approval and reads don't; in a mail turn only pairing asks, since approving another machine is always your call.

## Setup

Install and start Heartbeat on the machine (`heartbeat install`; on macOS that adds a login item). Then start, or restart, demesne's daemon: it joins when the daemon's control socket exists at startup.

```toml
[heartbeat]
enabled = true                              # join even when the socket is absent at startup; false never joins
socket = "/Users/you/.local/state/heartbeat/control.sock"   # default: HEARTBEAT_CONTROL_SOCKET, else the daemon's data directory
```

Both lines are optional. Without a running daemon the tool is not offered and nothing changes.

## Reaching a demesne chat from elsewhere

From a Claude Code or Codex session with the Heartbeat package installed, `heartbeat agents` lists demesne's addresses. Send with `heartbeat say --as YOU 'REQ#_ →demesne@NODE/demesne-cli-k3x9a why:"status of the tests"'`. The reply comes back to your mailbox the same way.
