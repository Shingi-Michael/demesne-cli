# Plan: hot reloading of daemon and UI on updates (implemented)

## Goal

When Demesne is updated to a new version, the running daemon and desktop UI pick up the change without the user quitting and relaunching.

## What was implemented

### Daemon — `apps/daemon/src`

1. **`DaemonApp.reload()`** (app.ts): re-reads the user config with `loadConfig({ includeProject: false })`, then re-applies what can change without a restart:
   - providers → existing `reloadProviders()`;
   - theme → `themes.select()` when the configured concrete theme differs from the selection (`"auto"` is skipped: it is a startup policy, not a stored selection).
   - Returns `{ providers, theme: { changed, selected }, binaryUpdated, reloadedAt }`.
   - `systemPrompt`, provider timeouts and inference slots are captured at construction and require a restart; `reload()` only reports what it actually applies.

2. **`POST /v1/daemon/reload`** (app.ts fetch handler): calls `app.reload()` and returns the report; `409` on failure.

3. **Config-file watcher** (main.ts): `fs.watch` on the user config path, debounced (~1 s), auto-calls `app.reload()` on change and logs the result. Closed on shutdown.

4. **Binary-update detection** (main.ts): `stat(process.execPath)` at startup; `reload()` compares mtime/size and sets `binaryUpdated: true` when the daemon binary on disk changed since startup, so an updater (install.sh) knows a restart is required to run the new code.

### Desktop UI — `apps/desktop/electron/main.ts`

1. **`desktop-reload` IPC method**: calls `window.webContents.reload()`, reachable through the existing `desktop_request` channel, so an updater or the renderer can request a UI reload.

2. **Update-triggered UI reload**: persists `app.getVersion()` to `<userData>/version.json`; on startup, if the persisted version differs from the current one, sets `updatePending` and reloads the renderer once after `loadURL`. The host process (and its daemon-owned turns) survives the renderer reload.

### Out of scope (owner's domain)

- `.github/workflows` and versioning.
- Self re-exec of the daemon binary from within itself (data-directory lock makes safe self re-exec non-trivial; `install.sh` restarts the daemon externally).
- Cross-process daemon→UI reload signal.

## Tests

- `apps/daemon/test/daemon-reload.test.ts`: reload report shape, provider reloader invocation, theme re-selection from config, and the `/v1/daemon/reload` HTTP endpoint.
- All 454 existing daemon tests pass; `bun run typecheck` is clean.
