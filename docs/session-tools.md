# Session tools

The coding agent can adapt the built-in tools to the job in front of it, for the rest of a session, without changing them. It does this through one tool, `session_tools`, with four actions: `define`, `run`, `list` and `remove`.

## Two kinds

**Preset**: a built-in tool with saved default arguments. Running it merges the defaults with that call's arguments; the call's arguments win.

```json
{ "action": "define", "name": "ts_search", "base": "search_files", "defaults": { "include": "*.ts", "limit": 30 } }
{ "action": "run", "name": "ts_search", "args": { "query": "createDaemonApp" } }
```

**Composition**: up to six read-only steps run as one call. Step arguments can use the call's parameters (`{{name}}`) and earlier steps' results. A search step's hits are available as `steps[N].hits`, with the first as `steps[N].first` (`path`, `line`, `text`); numbers take `+` or `-` a constant.

```json
{ "action": "define", "name": "find_definition", "params": { "name": { "type": "string" } }, "steps": [
  { "tool": "search_files", "args": { "query": "function {{name}}", "include": "*.ts" } },
  { "tool": "read_file", "args": { "path": "{{steps[0].first.path}}", "offset": "{{steps[0].first.line - 20}}", "limit": 60 } } ] }
{ "action": "run", "name": "find_definition", "args": { "name": "serve" } }
```

One call replaces several rounds, which matters most for models that spend many rounds searching and reading.

## Boundaries

- **Session only.** Variants are saved with the session (`<data_dir>/session-tools/<session>.json`), survive a daemon restart, and never change the built-in tools or other sessions.
- **No escalation.** A preset runs as its base tool, through that tool's own checks and approval: a preset of `write_file` or `run_command` still asks. Compositions may only use read-only tools (`list_files`, `read_file`, `read_files`, `search_files`, `git_status`, `git_diff`, `git_history`), never edits, commands or sub-agents.
- **Bounded.** At most 20 variants per session, 6 steps per composition, 4–8 KB of definition, and 64 KB of composition output.
- **Cache-friendly.** Variants are arguments to the one `session_tools` tool, not new tool definitions, so the tool list (and the provider's prompt cache) stays the same for the whole session.

In the conversation a session tool's row reads **Tool**, followed by its action and name (`run find_definition`).
