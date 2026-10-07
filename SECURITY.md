# Security policy

[Documentation index](docs/README.md) · [Authentication](docs/authentication.md) · [Configuration](docs/configuration.md)

## Execution boundary

Demesne executes model-authored tools with the operating-system permissions of the daemon’s user. **`run_command` is host execution, not a sandbox.** Approval and scoped grants control when it runs; a granted command may read, write or contact anything its OS account can access. An external MCP server likewise has its own host access.

Native workspace file tools validate paths, reject symlink escapes and exclude protected secret/key paths. Workspaces cannot be `/`, the user’s home directory, or overlap Demesne’s data directory. These guards do not sandbox an approved process or an external tool server.

### Workspace trust

A workspace's `DEMESNE.md`/`AGENTS.md`, `.demesne/commands/` and `.demesne/config.toml` can steer the agent, so the daemon refuses to create a session in a folder you haven't trusted (`403 workspace_untrusted`). The desktop window and an interactive CLI ask "Do you trust the files in this folder?"; a headless run must pass `--trust-workspace`. Trust is stored in `<data_dir>/trusted-workspaces.json` (mode `0600`), applies to the folder and its subfolders, and is removed by editing that file. Directory ownership and mode bits are not checked; trust is your decision about the content, not about the filesystem.

- Writes and commands use the permission broker unless an applicable explicit grant exists. Session grants and persistent config grants are different lifetimes.
- Command grants match argv in their allowed scope; a trailing wildcard deliberately broadens the allowed arguments.
- Non-interactive approval requests are denied. Existing configured grants can still authorize operations.
- **Agent Drive's coding turns use permission mode `allow`:** writes and host commands run without approval, so a Drive mission can do anything the daemon's OS account can, unattended. Only commands that publish beyond the machine (pushes, pull request/release/repo changes, `gh api` writes, package publishes) still ask. Run Drive only in workspaces where that is acceptable.
- Inspection commands sent through `run_command` that a built-in read tool answers identically (`ls`, `cat`, `head`, `sed -n 'X,Yp'`, plain-text `grep`/`rg`, `find DIR -name PATTERN`) run as that tool instead: no host process and no approval. `tail` and `wc` are pointed at `read_file` instead of running. Other commands run normally.
- Session tools (`session_tools`, see [docs/session-tools.md](docs/session-tools.md)) can't widen access: a preset runs as its base tool through that tool's own approval, and compositions may only chain read-only tools. They last for one session.
- `git_history` (log, show, blame, diffs between revisions) is read-only: revisions are validated, protected paths are refused, and git runs without hooks, external diff drivers or the user's config.
- Subagents receive only read/search/Git-inspection tools; they cannot run commands, edit files or spawn further subagents.
- Drive cannot answer approval prompts or user questions on the user’s behalf.

See [permissions](apps/daemon/src/permissions.ts), [workspace tools](apps/daemon/src/tools.ts) and [subagent limits](docs/subagents.md).

## Local service and credentials

The daemon binds to loopback. All routes except `GET /healthz` require the daemon bearer token. The token defaults to `<data_dir>/daemon.token`; private data/credential files use restrictive permissions. The token is separate from provider API keys and ChatGPT credentials.

Provider URLs require HTTPS except loopback or an explicitly permitted exact Tailscale HTTP endpoint. That opt-in does not encrypt traffic and does not expose the local daemon remotely. ChatGPT tokens use fixed official destinations and are not forwarded to a configured custom model URL.

ChatGPT OAuth uses PKCE, state, nonce, a loopback callback and verified identity tokens. Its private credential store is `<data_dir>/auth/chatgpt.json`; refresh uses an interprocess lock and atomic replacement. Demesne does not use another application’s saved login. See [authentication](docs/authentication.md) for logout and setup persistence behavior.

Session journals, command output, memory and image artifacts may contain project content. They are durable local data, not encrypted storage. Treat backups and exported sessions accordingly. Authenticated model requests send the selected conversation/tool evidence to the selected provider; image hydration may also send preview pixels.

## Desktop boundary

The [Tauri desktop client](apps/desktop/README.md#process-boundary) is Demesne's interface. It loads local authored assets in the system webview and uses a restricted native bridge. Commands require the main-window label and local application origin; remote navigation and creation of new webviews are denied. The page only has backend event-subscription capabilities, without general shell/filesystem plugin permissions. Its compiled Bun host owns daemon credentials, configuration and Drive; the page receives public snapshots and named actions. It has no general shell/filesystem bridge or direct authenticated daemon HTTP access. External links open in the system browser, and rendered Markdown is sanitized.

Native project selection validates the canonical directory and existing workspace ownership/write-permission rules. Choosing a project does not authorize commands or relax daemon tool approval. Closing the window ends its host without killing daemon-owned work. A running Drive mission carries on in a detached host process with the same permissions until it settles; pause or stop it first if it should not keep working unattended. Linux WebKit/WebDriver integration tests use private fixture data and ordinary browser automation; no production test endpoint or renderer-side privileged testing API is added.

System webviews receive platform security updates separately from Demesne. The desktop bundle does not yet provide signing/notarization or automatic updates. See [desktop prerequisites and limits](docs/desktop.md).

These are defense boundaries, not a promise that untrusted generated code is safe to execute. Review requested actions and keep grants specific to the intended work.

## Reporting a vulnerability

Use the repository’s [private security advisory form](https://github.com/Shingi-Michael/demesne-cli/security/advisories/new), rather than a public issue. Include the impact, minimal reproduction, affected commit/version, platform and configuration. Remove tokens and private project contents from logs before sharing them.

Only the latest maintained code receives security fixes during pre-1.0 development. Coordinate disclosure privately; acknowledgement and release timing depend on investigation and severity.
