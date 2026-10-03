# Configuration

[Documentation index](README.md) · [Authentication](authentication.md) · [Subagents](subagents.md)

## Files, precedence and ownership

The [config loader](../packages/config/src/index.ts) merges defaults, user TOML, project TOML, then explicit environment overrides. Unknown keys and invalid values are errors.

| Consumer | Configuration it uses |
| --- | --- |
| CLI/graphics host | User + project + environment; explicit `--server` wins for the client |
| Production daemon | User + environment (`includeProject: false`) |
| Drive controller | Client-loaded `[drive]` limits when starting a new mission |
| Workspace instructions | `DEMESNE.md` or `AGENTS.md`, read for the coding turn |

The user file is `~/.demesne/config.toml`, or `DEMESNE_CONFIG_FILE`. The project file is `<workspace>/.demesne/config.toml`. The loader can parse provider fields in project config, but the daemon does **not** apply them to its machine-wide runtime. Put provider, MCP, image, agent-execution and daemon settings in the user file. Additional CLI settings may still be displayed from client configuration; the daemon's health/status is authoritative for active model capacity.

`data_dir` defaults to `~/.demesne`. Config files and credentials are private; do not commit real keys or account registrations. Programmatic setup updates back up the previous config.

## Minimal local provider

Replace the URL/model with values from your server and `demesne models`.

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

`daemon.auto_start` is `prompt`, `always`, or `never`. The graphics UI offers **Start daemon** when offline; `always` attempts an automatic start. The daemon binds only to loopback. A client `server` override does not make the daemon a remotely exposed service.

## Provider fields

The same fields are supported under `[provider]` and `[additional_providers.NAME]`.

| Field | Meaning |
| --- | --- |
| `id`, `url`, `model` | Provider identity, base URL, default model ID |
| `allowed_models` | Optional model allowlist; include the default model |
| `api_key` | Bearer key for OpenAI-compatible endpoints |
| `auth`, `auth_profile` | `api-key` or `chatgpt`; ChatGPT profile reference written by login |
| `context_window` | Usable context **per request/slot**, including reserved output |
| `max_output_tokens` | Chat Completions output cap and planning reserve; reserve only on the ChatGPT plan route |
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

HTTP is accepted on loopback. Other endpoints require HTTPS unless the exact Tailscale URL is explicitly allowed. ChatGPT credentials always go to the fixed official API/auth destinations; a custom `url` cannot redirect those tokens.

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

Additional providers require URL, model, context and output settings. Model IDs must be unambiguous across providers. `/model` changes the main selection; `/subagent` changes and saves the subagent default independently.

The example grants Qwen three slots and leaves the hosted provider at one. It does not reconfigure the server: the server must actually support three simultaneous requests and 32K per slot. Runtime profiles that require one slot reject an incompatible override. `demesne ps --json` reports `providerInferenceSlots`; `inferenceSlots` describes the currently selected provider. See [the concurrency guide](subagents.md#three-slot-qwen-example).

## Agent and Drive limits

`[agent] max_model_rounds` and `max_tool_calls` default to 64 and 256. A final status round reports incomplete work when the allowance is spent. Subagents have separate fixed research limits documented in [subagents](subagents.md#limits).

`[drive]` controls new missions. See [Drive limits](agent-drive.md#mission-limits) for all fields and defaults. Existing saved missions keep their original limits. A provider output limit, a Drive token budget, and a server reasoning budget are separate controls.

## Images and MCP

Image generation is configured independently from the chat model:

```toml
[images]
url = "https://image-provider.example/v1"
model = "your-image-model"
request_timeout_ms = 300000
# api_key = "..."  # private configuration only
```

Set `vision = true` under `[provider]` to enable the configured daemon vision path. Generation uses `/images/generations` or `/images/edits`; viewing an image is not generation. ChatGPT sign-in does not supply credentials for this separate image backend. See [preview](artifact-preview-plan.md).

```toml
[mcp.servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
timeout_ms = 15000
```

Each MCP server may also supply an `env` table. Tools are named `mcp__SERVER__TOOL` and pass through approval policy. External servers have their own OS access; the example path is illustrative, not a sandbox.

## Preferences and grants

- `theme`: `auto`, `demesne`, `demesne-light`, `dracula`, `tokyo-night`, `tokyo-night-storm`, `nord`, `gruvbox-dark`, `catppuccin-mocha`, `catppuccin-latte`, `github-light`. `/theme` changes it live.
- `[permissions] allow`: scoped rules such as `edit_file:src` or `run_command:git status`. Command rules match exact argv; a terminal ` *` explicitly permits additional arguments. Avoid broad execution grants.
- `[notifications] enabled` and `minimum_duration_ms` configure supported notification paths (default true / 30000 ms).
- `[ui] intro` and `hyperlinks` remain parsed client settings; they are not switches back to the removed text workbench. Graphics motion uses `prefers-reduced-motion` in the browser.

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
| Graphics diagnostics | `DEMESNE_GRAPHICS_FILES`, `DEMESNE_GRAPHICS_GPU`, `DEMESNE_GRAPHICS_TRACE` |
| Drive transport | `DEMESNE_DRIVE_CONTROL=ui` selects the compatibility UI-control path |

`DEMESNE_NO_INTRO` and `DEMESNE_NO_HYPERLINKS` are also read by the config loader. `NO_COLOR` and `DEMESNE_REDUCED_MOTION` affect the plain terminal output utilities; they are not general CSS feature switches.

## Apply changes

```sh
demesne ps --json
demesne daemon stop
demesne daemon start
```

Stop only when active work can be interrupted. Provider config edits require daemon restart; `/model`, reasoning selection, and `/subagent` have runtime routes. Reopen the graphics UI after replacing its build. [Troubleshooting](troubleshooting.md#rebuilds-and-running-processes) explains binary resolution and background-service caveats.
