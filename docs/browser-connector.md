# Browser connector smoke check

Run `scripts/check-browser-connector.ts` explicitly to test a **new standalone**
Playwright MCP process through Demesne's public `McpStdioClient`. It does not read
or write live configuration, contact/restart the daemon, attach to an existing
browser, or install packages/browsers. A previous `failed / tools=0` report is not
evidence of current failure; likewise, successful discovery alone does not prove
that a browser can launch.

## Prerequisites and use

- Bun and this checkout's existing dependencies.
- Node on PATH (or `--node /absolute/path/to/node`).
- An **already installed** `@playwright/mcp` JavaScript CLI entry point. This is
  not a repository dependency. An existing npm cache entry is usable directly;
  do not run `npx -y` to obtain one as part of this check.
- Installed Google Chrome, or an existing compatible Chrome/Chromium executable
  selected with `--browser-executable /absolute/path/to/browser`.
- Permission to spawn a headless browser and bind an ephemeral loopback port.

```sh
bun scripts/check-browser-connector.ts --help
bun scripts/check-browser-connector.ts --self-test
bun scripts/check-browser-connector.ts --run \
  --cli /absolute/path/to/node_modules/@playwright/mcp/cli.js
```

`--run` is mandatory. Without `--cli`, resolution is attempted from this checkout,
not from live configuration or npm's cache. `--timeout-ms 60000` is the default
per-request limit; allowed range is 1000–120000 ms. The package help/version probe
has a separate maximum of 15 seconds. Exit 0 means success (also help/self-test);
exit 1 means the requested check failed. This is opt-in, not part of `bun test`.

The script probes the installed CLI, initializes MCP, requires navigate/snapshot/
click/close tools, serves one harmless HTML fixture on `127.0.0.1`, reads a DOM
snapshot, clicks its button by the returned reference, and checks a second snapshot
for the changed status. It then calls `browser_close`, calls `stop`, stops its
fixture server, and removes its temporary profile/output. The public client's
`stop()` requests process termination but has no process-exit await API: the script
does **not** claim an OS-level process-tree leak audit. Normal exceptions and
SIGINT/SIGTERM go through cleanup; SIGKILL cannot run cleanup.

Only fixed diagnostic categories and tool counts are printed—not configuration,
credentials, raw errors, or snapshots. The child receives an OS/browser-lookup
environment allowlist, not provider credentials or Node injection settings. It
uses `--headless --browser chrome --user-data-dir TEMP/profile --output-dir TEMP/output`:
a fresh private on-disk profile, never the configured profile/output directory.
This deliberately replaces the configured connector's `--isolated` context with
an explicit disposable profile. No storage state, extension, CDP endpoint, or
personal site is used. The fixture has no external assets and denies network
connections through CSP; this is not an OS network sandbox for Chrome itself.

## Troubleshooting

- **`EXECUTABLE_UNAVAILABLE`**: Node is missing, non-executable, or unavailable on
  this process's PATH. Use `--node`; GUI/daemon and shell PATHs may differ.
- **`PACKAGE_UNAVAILABLE` / `PACKAGE_PROBE_FAILED`**: the supplied CLI is missing,
  its dependencies are incomplete, or it cannot run. This is a package prerequisite
  failure, not zero discovered tools. Repair/provision dependencies separately
  with the owner's approval; the check never installs or upgrades anything.
- **`INITIALIZATION_TIMEOUT` / `INITIALIZATION_FAILED`**: the child did not complete
  initialize + tools/list. Demesne's public `start()` combines both stages and
  suppresses server stderr, so not every early-exit cause can be identified here.
  A longer timeout cannot fix an absent executable/package.
- **`REQUIRED_TOOLS_MISSING`**: MCP initialized, but this CLI did not expose the
  required browser tools. Check the selected package/version, not browser cookies.
- **`BROWSER_NOT_INSTALLED`**: tool discovery may have passed, but the expected
  browser binary is absent. Point to an already installed browser; arrange any
  browser installation separately. The script never calls `browser_install`.
- **`BROWSER_LAUNCH_FAILED`**: initialization succeeded, but launch failed (for
  example OS dependencies or process restrictions). Check browser compatibility
  and sandbox permissions; do not attach to a personal browser as a workaround.
- **`SOCKET_PATH_TOO_LONG`**: Playwright's internal socket path exceeded the OS
  limit. The script uses a short private `/tmp` directory on macOS for this reason.
- **`TOOL_TIMEOUT`, `TOOL_FAILED`, snapshot/click mismatch**: the named stage did
  not complete or prove the expected DOM change. Unknown failures remain unknown;
  sanitized categories are intentionally not a replacement for privately reviewing
  server diagnostics in a credential-free reproduction.
- **`CLEANUP_CLOSE_FAILED` / `TEMP_REMOVE_FAILED`**: cleanup was incomplete. The
  script still requests MCP stop and fixture shutdown; do not call this a pass.

## Recorded verification

Verified on macOS with Bun 1.4.0, `/opt/homebrew/bin/node`, the already-cached
`@playwright/mcp` **0.0.82**, and installed Chrome. From a shell whose `HOME` is the
real user home (not a tool's temporary HOME), the exact successful invocation was:

```sh
bun scripts/check-browser-connector.ts --run \
  --cli "$HOME/.npm/_npx/53b5ca06f5b71ebd/node_modules/@playwright/mcp/cli.js" \
  --node /opt/homebrew/bin/node
```

Exit **0**, empty stderr; stdout:

```text
PASS package: installed CLI responds; version=0.0.82
PASS initialize: real MCP initialize + tools/list completed
PASS discovery: tools=25; navigate, snapshot, click, close present
PASS navigate: opened loopback fixture in temporary profile
PASS snapshot: fixture heading, pending status, and button reference found
PASS click: DOM snapshot confirms click changed status
PASS close: browser_close completed
PASS cleanup: MCP stop requested; fixture stopped; temporary profile/output removed
PASS browser connector end-to-end (standalone; not active-daemon health)
```

An initial harness run initialized/discovered 25 tools but could not navigate or
close: a credential-free diagnostic identified `Socket directory path is too long
(113 bytes)`. Shortening this script's macOS temporary path resolved it; no runtime
or live configuration change was needed. Default `--run` without the cached CLI
reported `PACKAGE_UNAVAILABLE` (exit 1), not a broken installed connector. Missing
Node and missing opt-in checks reported `EXECUTABLE_UNAVAILABLE` and
`OPT_IN_REQUIRED` respectively (exit 1).

The script's 12 classifier/reference self-checks and the existing four
`apps/daemon/test/mcp.test.ts` tests passed. Scripts are excluded by the repository's
`tsconfig.json`; explicitly typecheck this file using the installed compiler:

```sh
bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict \
  --skipLibCheck --target ES2024 --module ESNext --moduleResolution Bundler \
  --allowImportingTsExtensions --types bun scripts/check-browser-connector.ts
bun test apps/daemon/test/mcp.test.ts
```
