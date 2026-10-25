# Troubleshooting

[Documentation index](README.md) · [Configuration](configuration.md) · [Desktop app](desktop.md)

## Start with the running state

`/status` and `/context` show the active provider, model, context and output limits; **Settings › Models** lists what the daemon discovered. Configuration on disk is not proof that an existing process loaded it. Avoid sharing bearer tokens, credential files or unsanitized project logs.

## Rebuilds and running processes

```sh
bun install --frozen-lockfile
bun run build:desktop
```

`bun run build:desktop` builds the app with its own daemon and desktop host. Close the window and reopen it to load a rebuilt interface. A daemon restart alone does not refresh the UI. Conversely, closing the window does not stop daemon-owned work. A system service/launch agent may relaunch its configured binary; inspect that service’s executable path if the old version immediately returns.

## The app doesn't open

On macOS, move `Demesne.app` to `/Applications` or `~/Applications` and clear the unsigned-download flag (`xattr -dr com.apple.quarantine`). From a checkout, `bun run desktop` builds and opens it. On Linux the window needs a desktop session; see [desktop prerequisites](desktop.md#prerequisites).

## ChatGPT sign-in or incomplete tool calls

Sign in under **Settings › Providers** and check the account's model catalog. In-app sign-in reloads providers automatically; restart the daemon after manually changing provider configuration. Model availability and supported reasoning levels come from the signed-in account. A separate image backend is still required for generation.

The Responses adapter retains completed output items from streaming events when the terminal response contains an empty output array. It requires a completed response before executing tool calls. Actual truncation, malformed arguments or a failed/incomplete response remain failures; silently executing partial JSON would be incorrect. Update an older daemon before diagnosing repeated incomplete-call errors. Inspect the recorded failure and output allowance; do not assume every incomplete response is an auth error.

## Retired provider after an upgrade

The old Codex runtime provider is no longer offered. Its configuration sections are ignored, and a retired primary is replaced by the first remaining additional provider or an empty setup state. [Upgrade guidance](authentication.md#upgrading-from-the-retired-codex-provider) explains the config backup and separate ChatGPT registration. Choose `gpt-6.1-sol` under **ChatGPT**, without the old `codex/` prefix. Historical session labels are retained.

If the picker stays stale after signing in, reopen it and check **Settings › Models** to distinguish daemon discovery from UI state. An older daemon may require restarting after active work finishes. Build mode offers edit tools under Demesne's approval policy; Plan mode remains read only. Switching provider does not change filesystem permissions.

## Qwen thinking for too long or subagents waiting

Three agent tasks do not imply three simultaneous GPU executions. Check `providerInferenceSlots` and the server’s actual parallel capacity. Both sides must agree; see [subagents and concurrency](subagents.md).

Lower reasoning effort when supported, and inspect whether time is spent queued, generating reasoning, running tools or awaiting approval. Output capacity, server reasoning budget, context capacity and Drive mission budgets are distinct. Raising all of them increases resource pressure and is not a general performance fix.

Do not load a second model process just to review a busy worker. The scheduler supports sharing one model server; live Drive review waits for capacity and rereads fresh evidence. The documented three-slot Qwen measurements cover a specific profile and short tests, not arbitrary long-context concurrency. If the PC becomes unresponsive, stop adding load and recover the host before further profiling.

## Drive repeats completed work

Plain `/drive MISSION` is continuous. Use `/drive --bounded MISSION` for a finite mission, or choose NEXT’s **Run**. Check the stable task ledger and completion evidence before reopening work. Explicit reopen requires a task ID and reason; automatic reopen requires relevant changed evidence. [Drive memory and loop rules](agent-drive.md) explain how completed tasks and vetoes persist.

“Not now” hides a proposal for 24 hours; it is not a permanent veto. “Never” records a veto. Refreshing proposals gathers current signals and may still produce distinct new work.

## Checks or file views seem stale

Historical changes are immutable evidence; Files shows the current workspace. Use the Files **Reload** action after its external-change notice. Verification fingerprints determine freshness; a formerly passing result may become outdated, and incomplete scans cannot certify freshness. Rerun the relevant check from Verification when appropriate.

## Images missing from Preview or model context

Supported inputs are static PNG, JPEG and WebP within ingestion limits. Check whether the image was ingested into this session and whether its content files still exist. Merely writing a path in prose does not create an artifact. A stored image does not mean the selected model can see it: vision hydration must be enabled. The desktop window does not display images yet. See [images](images.md).
