# Security policy

[Documentation index](docs/README.md) · [Authentication](docs/authentication.md) · [Configuration](docs/configuration.md)

## Execution boundary

Demesne executes model-authored tools with the operating-system permissions of the daemon’s user. **`run_command` is host execution, not a sandbox.** Approval and scoped grants control when it runs; a granted command may read, write or contact anything its OS account can access. An external MCP server likewise has its own host access.

Native workspace file tools validate paths, reject symlink escapes and exclude protected secret/key paths. Workspaces cannot be `/`, the user’s home directory, or overlap Demesne’s data directory. These guards do not sandbox an approved process or an external tool server.

- Writes and commands use the permission broker unless an applicable explicit grant exists. Session grants and persistent config grants are different lifetimes.
- Command grants match argv in their allowed scope; a trailing wildcard deliberately broadens the allowed arguments.
- Non-interactive approval requests are denied. Existing configured grants can still authorize operations.
- Subagents receive only read/search/Git-inspection tools; they cannot run commands, edit files or spawn further subagents.
- Drive cannot answer approval prompts or user questions on the user’s behalf.

See [permissions](apps/daemon/src/permissions.ts), [workspace tools](apps/daemon/src/tools.ts) and [subagent limits](docs/subagents.md).

## Local service and credentials

The daemon binds to loopback. All routes except `GET /healthz` require the daemon bearer token. The token defaults to `<data_dir>/daemon.token`; private data/credential files use restrictive permissions. The token is separate from provider API keys and ChatGPT credentials.

Provider URLs require HTTPS except loopback or an explicitly permitted exact Tailscale HTTP endpoint. That opt-in does not encrypt traffic and does not expose the local daemon remotely. ChatGPT tokens use fixed official destinations and are not forwarded to a configured custom model URL.

ChatGPT OAuth uses PKCE, state, nonce, a loopback callback and verified identity tokens. Its private credential store is `<data_dir>/auth/chatgpt.json`; refresh uses an interprocess lock and atomic replacement. Demesne does not use another application’s saved login. See [authentication](docs/authentication.md) for logout and setup persistence behavior.

Session journals, command output, memory and image artifacts may contain project content. They are durable local data, not encrypted storage. Treat backups and exported sessions accordingly. Authenticated model requests send the selected conversation/tool evidence to the selected provider; image hydration may also send preview pixels.

## Graphics boundary

The graphics host owns daemon tokens, auth and filesystem operations. The Electron page is sandboxed and receives public state through a narrow preload bridge, without Node access or direct daemon/network access. Rendered Markdown is sanitized. Terminal tile transfer uses private temporary files when supported, with inline transfer as fallback. See [graphics architecture](apps/graphics/README.md#boundaries).

These are defense boundaries, not a promise that untrusted generated code is safe to execute. Review requested actions and keep grants specific to the intended work.

## Reporting a vulnerability

Use the repository’s [private security advisory form](https://github.com/Shingi-Michael/demesne-cli/security/advisories/new), rather than a public issue. Include the impact, minimal reproduction, affected commit/version, platform and configuration. Remove tokens and private project contents from logs before sharing them.

Only the latest maintained code receives security fixes during pre-1.0 development. Coordinate disclosure privately; acknowledgement and release timing depend on investigation and severity.
