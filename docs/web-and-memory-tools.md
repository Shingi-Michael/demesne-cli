# Web, search and remember tools

Tools added so chats work more like Claude Code and Codex.

- **`web_search`** searches the web (DuckDuckGo's HTML results, no key needed) and returns up to 10 results with title, url and snippet. It never asks, because it only reads.
- **`web_fetch`** reads one page as text. Headings, lists, code and links are kept, and scripts, navigation and styling are dropped. Long pages come back in slices: pass `nextOffset` to read on. Redirects are followed one hop at a time, and every hop is checked: addresses on this machine or its local network (localhost, 10/8, 192.168/16, link-local and so on) are refused, so a page can't point the model at the daemon or a router. Both web tools work in projectless chats, in plan and orchestrate mode, and for sub-agents.
- **`search_files`** takes `regex: true`, `caseSensitive: true` and `context: N` (lines before and after each match, joined into blocks). It uses ripgrep when it's there. A pattern ripgrep can't run, such as a lookahead, falls back to the built-in walk with JavaScript's regex.
- **`remember`** saves a standing rule ("always…", "never…", "from now on…") as a bullet under `## Remembered` in the project's `DEMESNE.md`, or `AGENTS.md` when that's the file the project has. Instruction files are read on every turn, so the rule holds from the next turn on and in every later chat in the project. It asks like an edit does, and Accept edits covers it.

Changes that span several files are made as several `edit_file` calls in one round. The system prompt asks for this, and calls run in parallel.

[web.ts](../apps/daemon/src/web.ts) · [remember.ts](../apps/daemon/src/remember.ts) · tests: [web](../apps/daemon/test/web.test.ts), [remember](../apps/daemon/test/remember.test.ts)
