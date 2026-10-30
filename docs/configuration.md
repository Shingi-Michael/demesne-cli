# Configuration

[Documentation index](README.md) · [Authentication](authentication.md) · [Subagents](subagents.md)

## Files, precedence and ownership

The [config loader](../packages/config/src/index.ts) merges defaults, user TOML, project TOML, then explicit environment overrides. Unknown keys and invalid values are errors.

| Consumer | Configuration it uses |
| --- | --- |
| Desktop host | User + project + environment |
| Production daemon | User + environment (`includeProject: false`) |
| Drive controller | Client-loaded `[drive]` limits when starting a new mission |
| Workspace instructions | `DEMESNE.md` or `AGENTS.md`, read for the coding turn |

The user file is `~/.demesne/config.toml`, or `DEMESNE_CONFIG_FILE`. The project file is `<workspace>/.demesne/config.toml`. The loader can parse provider fields in project config, but the daemon does **not** apply them to its machine-wide runtime. Put provider, MCP, image, agent-execution and daemon settings in the user file. Additional CLI settings may still be displayed from client configuration; the daemon's health/status is authoritative for active model capacity.

`data_dir` defaults to `~/.demesne`. Config files and credentials are private; do not commit real keys or account registrations. Programmatic setup updates back up the previous config.

## Minimal local provider

Replace the URL/model with values from your server; **Settings › Models** lists what the daemon discovered.

```toml
theme = "auto"
inference_slots = 1

[daemon]
auto_start = "prompt"
host = "127.0.0.1"
port = 7337

[provider]
id = "local"
url = "http://127.0.0.1:1234/v1"
model = "your-local-model"
context_window = 32768
max_output_tokens = 8192

[agent]
max_model_rounds = 64
max_tool_calls = 256

[permissions]
allow = []
```

A configured model needs a context capacity and output allowance, either explicitly or through a supported runtime profile. The output allowance must be smaller than the context. These are operational limits, not a claim about the model's theoretical maximum.

`daemon.auto_start` is `prompt`, `always`, or `never`. The desktop app starts its bundled daemon when it can't reach one, unless this is `never` (`prompt` and `always` both start it); if the daemon stops later, the app starts it once more. With `never`, the window offers **Start daemon** when offline. A `daemon.managed` file in the data directory (the assistant's Windows installer writes one naming its scheduled task) overrides all three: the window waits for that daemon and says who runs it, and **Start daemon** points there too. The daemon binds only to loopback. A client `server` override does not make the daemon a remotely exposed service. To use a daemon on another computer, publish it over a private network (Tailscale Serve) and give the window its `https://` address as `server`, with that daemon's token in `<data_dir>/remote-daemons/<host>_<port>.token`; see [use it from anywhere](assistant.md#step-5-use-it-from-anywhere).

## Provider fields

The same fields are supported under `[provider]` and `[additional_providers.NAME]`.

| Field | Meaning |
| --- | --- |
| `id`, `url`, `model` | Provider identity, base URL, default model ID |
| `allowed_models` | Optional model allowlist; include the default model |
| `api_key` | Bearer key for OpenAI-compatible endpoints |
| `auth`, `auth_profile` | `api-key`, `chatgpt` or `codex`; `auth_profile` belongs only to ChatGPT registration, and a Codex entry carries no `url`, `api_key` or `auth_profile` |
| `context_window` | Usable context **per request/slot**, including reserved output |
| `max_output_tokens` | Chat Completions output cap and planning reserve; local reserve on the ChatGPT and Codex routes |
| `inference_slots` | Provider-specific concurrency; otherwise inherits the top-level value |
| `vision` | Opt-in image hydration for the daemon's configured vision path |
| `reasoning_effort` | Config default: `none`, `low`, `medium`, `high`, or `max`; actual support depends on the provider |
| `include_usage` | Request streamed usage when supported |
| `system_prompt` | Base coding-agent instructions; workspace guidance is appended |
| `runtime_profile` | Named, verified runtime expectations; profile restrictions still apply |
| `openrouter_ignore` | OpenRouter routing exclusions |
| `allow_http_endpoint` | Exact opt-in HTTP URL on the Tailscale `100.64.0.0/10` range |
| `first_event_timeout_ms`, `request_timeout_ms` | Optional positive request deadlines |

The default stream first-event deadline is at least 180 seconds, with profile-specific floors. The default overall deadline scales with the output allowance; it is at least 15 minutes. See [provider limits](../apps/daemon/src/provider-limits.ts). These deadlines are not reasoning budgets.

HTTP is accepted on loopback. Other endpoints require HTTPS unless the exact Tailscale URL is explicitly allowed. ChatGPT and Codex credentials always go to the fixed official API/auth destinations; a custom `url` cannot redirect those tokens.

## Codex provider

[Sign in first](authentication.md#codex-your-codex-plan) under **Settings › Providers**. The entry names only the plan route; its models are `codex/<slug>` from the live catalog:

```toml
[provider]
id = "Codex"
auth = "codex"
model = "codex/gpt-6.1-sol"
context_window = 272000
max_output_tokens = 16384
```

Tokens come from `<data_dir>/auth/codex.json`, never from the config. A `url`, `api_key` or `auth_profile` on a Codex entry is a configuration error, and so is a model without the `codex/` prefix.

## ChatGPT provider

[Sign in first](authentication.md#continue-with-chatgpt) under **Settings › Providers**. Signing in writes an account-bound provider entry while preserving existing local providers. A typical entry has this shape; use the issued account ID from login rather than inventing one:

```toml
[additional_providers.chatgpt]
id = "ChatGPT"
url = "https://api.openai.com/v1"
auth = "chatgpt"
auth_profile = "ACCOUNT_ID"
model = "gpt-6.1-sol"
context_window = 1050000
max_output_tokens = 16384
```

The signed-in account must have model access. Model choices come from the account's catalog. Tokens are loaded from Demesne's private ChatGPT registration, not from `api_key`. The adapter uses fixed official destinations even if `url` is changed.

Login uses the catalog's context capacity or Sol's documented capacity; other models without capacity metadata use a conservative 32,768-token planning budget. The output reserve is one quarter of that budget, capped at 16,384. `max_output_tokens` is omitted from plan-usage requests, so this field is a context reserve, not a server output cap. Supported reasoning choices come from model metadata, with documented defaults for a verified Sol entry.

Older `auth = "codex"` sections are retired during configuration loading. See [upgrade guidance](authentication.md#upgrading-from-the-retired-codex-provider) for provider recovery and credential ownership.

## Multiple providers and concurrency

```toml
inference_slots = 1

[provider]
id = "qwen"
url = "http://127.0.0.1:8081/v1"
model = "qwen3.8-27b"
context_window = 32768
max_output_tokens = 8192
inference_slots = 3

[additional_providers.hosted]
id = "hosted"
url = "https://provider.example/v1"
model = "your-hosted-model"
context_window = 131072
max_output_tokens = 8192
# api_key belongs in your private config or provider environment.

[agent]
subagent_model = "qwen3.8-27b"
```

Additional providers require model, context and output settings, plus a URL for HTTP providers. Model IDs must be unambiguous across providers. `/model` changes the main selection; `/subagent` changes and saves the subagent default independently.

The example grants Qwen three slots and leaves the hosted provider at one. It does not reconfigure the server: the server must actually support three simultaneous requests and 32K per slot. Runtime profiles that require one slot reject an incompatible override. The daemon's `GET /v1/status` reports `providerInferenceSlots`; `inferenceSlots` describes the currently selected provider. See [the concurrency guide](subagents.md#three-slot-qwen-example).

### Model scoreboard

Benchmarks say little about how a model does on your projects, so demesne keeps score from your own work. The model picker shows a line under each model you've used in the last 30 days:

- **Turns and finished:** the turns it answered, and the share that completed rather than failed or were interrupted. Turns you stopped count in neither.
- **Tool calls ok:** its tool calls that didn't end in an error.
- **Speed:** median tokens per second after the first token, and median wait for the first token. Replies under 16 tokens aren't timed.
- **Checks passing:** of the turns that ran a check (tests, typecheck, lint), how many ended on a passing one.
- **Drive runs kept:** of the Drive proposals it ran, how many you applied or opened as a PR.

A turn belongs to the model that answered its first request. Models on providers at loopback, private or Tailscale addresses are marked local. Everything comes from the daemon's own records; nothing is sent anywhere.

## Agent and Drive limits

`[agent] max_model_rounds` and `max_tool_calls` default to 64 and 256. A final status round reports incomplete work when the allowance is spent. Subagents have separate fixed research limits documented in [subagents](subagents.md#limits).

`[drive]` controls new missions. See [Drive limits](agent-drive.md#mission-limits) for all fields and defaults. Existing saved missions keep their original limits. A provider output limit, a Drive token budget, and a server reasoning budget are separate controls.

## Assistant folders

`[assistant] folders` names folders outside any project that the assistant's read-only `personal_files` tool may list and read, as `name = 'absolute path'`. Names are one word. See [the assistant guide](assistant.md#one-tool-personal_files). The daemon reads this when it starts.

`[assistant] home` is the assistant's own folder (its `DEMESNE.md`, notes and todo), where its one chat lives; it must be absolute and trusted. Without it the daemon uses `~/Assistant` when that folder exists. See [the assistant guide](assistant.md#its-own-chat).

`[assistant] model` is the model the assistant's chat always runs on, by the id a provider lists it under (`qwen3-4b`, say). Without it, the `[provider]` model. The window's model picker switches the daemon's model for every other chat; the assistant's chat and its routines stay on this one, and a turn there that loses its provider fails instead of carrying on elsewhere, so what it reads of your files never goes to another provider. A model no provider serves fails the assistant's turns with a message that says so.

`[assistant] ntfy` is an [ntfy](https://ntfy.sh) topic URL your phone subscribes to; with it, routines push their answers to your phone and chats get a `notify_phone` tool. The topic must be at least 16 characters, and the URL https (plain http only on this computer or a Tailscale `100.x` address). `ntfy_token` is sent as a bearer token for a server that needs one. See [the assistant guide](assistant.md#step-4-push-to-your-phone).

## Images and MCP

Image generation is configured independently from the chat model:

```toml
[images]
url = "https://image-provider.example/v1"
model = "your-image-model"
request_timeout_ms = 300000
# api_key = "..."  # private configuration only
```

Set `vision = true` under `[provider]` to enable the configured daemon vision path. Generation uses `/images/generations` or `/images/edits`; viewing an image is not generation. ChatGPT sign-in does not supply credentials for this separate image backend. See [images](images.md).

```toml
[mcp.servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
timeout_ms = 15000
```

Each MCP server may also supply an `env` table. Tools are named `mcp__SERVER__TOOL` and pass through approval policy. External servers have their own OS access; the example path is illustrative, not a sandbox.

When [Heartbeat](heartbeat.md) runs on the machine, demesne joins it at startup. `[heartbeat]` takes `enabled` (true joins even if the socket is absent at startup, false never joins) and `socket` (the daemon's control socket; default `HEARTBEAT_CONTROL_SOCKET`, else its data directory).

## Preferences and grants

- `theme`: `auto`, `demesne`, `demesne-light`, `dracula`, `tokyo-night`, `tokyo-night-storm`, `nord`, `gruvbox-dark`, `catppuccin-mocha`, `catppuccin-latte`, `github-light`. This supplies the initial palette. `/theme` persists a live selection in the daemon's `themes.json`; that selection takes precedence on subsequent launches. [`/themefy`](themes.md) creates custom palettes through an interview and adds them to the picker.
- `[permissions] allow`: scoped rules such as `edit_file:src` or `run_command:git status`. Command rules match exact argv; a terminal ` *` explicitly permits additional arguments. Avoid broad execution grants.
- `[notifications] enabled` and `minimum_duration_ms` configure supported notification paths (default true / 30000 ms).
- `[ui] intro` and `hyperlinks` remain parsed client settings; they are not switches back to the removed text workbench. Interface motion uses `prefers-reduced-motion` in the webview.

## Environment overrides

The exported [environment map](../packages/config/src/index.ts) is authoritative.

| Area | Variables |
| --- | --- |
| Files/client | `DEMESNE_CONFIG_FILE`, `DEMESNE_DATA_DIR`, `DEMESNE_SERVER`, `DEMESNE_THEME` |
| Daemon | `DEMESNE_HOST`, `DEMESNE_PORT`, `DEMESNE_DAEMON_TOKEN`, `DEMESNE_DAEMON_BIN` |
| Scheduling | `DEMESNE_INFERENCE_SLOTS` (global default; provider TOML overrides remain specific) |
| Primary provider | `DEMESNE_PROVIDER_URL`, `DEMESNE_PROVIDER_ID`, `DEMESNE_MODEL`, `DEMESNE_ALLOWED_MODELS`, `DEMESNE_API_KEY` |
| Capacity/reasoning | `DEMESNE_CONTEXT_WINDOW`, `DEMESNE_MAX_OUTPUT_TOKENS`, `DEMESNE_REASONING_EFFORT`, `DEMESNE_INCLUDE_USAGE` |
| Provider behavior | `DEMESNE_PROVIDER_VISION`, `DEMESNE_RUNTIME_PROFILE`, `DEMESNE_SYSTEM_PROMPT`, `DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS`, `DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS` |
| Agent | `DEMESNE_MAX_MODEL_ROUNDS`, `DEMESNE_MAX_TOOL_CALLS`, `DEMESNE_SUBAGENT_MODEL` |
| Images | `DEMESNE_IMAGE_URL`, `DEMESNE_IMAGE_MODEL`, `DEMESNE_IMAGE_API_KEY`, `DEMESNE_IMAGE_REQUEST_TIMEOUT_MS` |
| OpenRouter login | `OPENROUTER_API_KEY` |

## Apply changes

Provider config edits require a daemon restart: when no work is running, stop the `demesned` process and the app starts it again. `/model`, reasoning selection, and `/subagent` have runtime routes. Reopen the desktop window after replacing its build. [Troubleshooting](troubleshooting.md#rebuilds-and-running-processes) explains binary resolution and background-service caveats.
