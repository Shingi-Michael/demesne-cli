# Demesne CLI

Demesne CLI is a durable, provider-neutral coding agent. A local daemon owns model requests, workspace tools, approvals, SQLite state, and resumable event streams; the command-line client can disconnect and reconnect without losing a turn.

## Run

```sh
bun install --frozen-lockfile
bun run daemon
```

In another terminal:

```sh
bun run demesne
```

On a fresh machine, run the setup wizard first instead of hand-writing environment variables:

```sh
bun run demesne setup   # probes Ollama, LM Studio, and llama.cpp; writes ~/.demesne/config.toml
bun run demesne doctor  # verifies config, daemon, provider, runtime profile, workspace, and memory
```

`demesne` and `demesne prompt` start the daemon automatically. With the default
`auto_start = "prompt"` policy the CLI asks once and remembers a yes as
`auto_start = "always"`; `demesne daemon start|stop|status|logs` manages it
explicitly. `demesne doctor --json` emits machine-readable checks for scripts.

This launches the interactive streaming CLI directly in your terminal. A compact masthead shows the active model, workspace, and approval policy. While output is silent, a phase-aware beacon occupies the fixed footer; it is cleared before permanent reasoning, tool, or response output is written. Interactive TTY responses pass through an ANSI- and grapheme-safe jitter buffer that turns speculative decoding bursts into a smooth typing cadence. The cadence adapts to visible text arrival and catches up within a bounded 1.5-second backlog; tools, errors, cancellation, and completion always drain or flush it before rendering. Scripted `prompt` output, pipes, event JSON, and persisted response text remain immediate and byte-for-byte unchanged.

Interactive terminals open the Demesne harness: one clean column on a strict alignment grid, with a header, a rule, the transcript, the composer, and the fixed footer. `Ctrl+T` toggles the telemetry sidebar, `PgUp`/`PgDn` scroll, `Ctrl+G` returns to the bottom, `Ctrl+X` expands the last thought, and double-Escape or Ctrl+C interrupts. Non-interactive use, `--no-tui`, and `DEMESNE_NO_TUI=1` keep the streaming scrollback output byte-for-byte, so pipes and scripts are unaffected.

The harness follows five rules. **One grid**: a turn rail at column 2 binds every line of a turn, and marks, verbs, targets, and durations sit on fixed columns, so order comes from alignment rather than boxes. **Color means something**: tool verbs are colored by phase (inspection is quiet, changes take the accent, verification is bright), status glyphs are citron for done and signal for failed, denied, or waiting, and prose stays monochrome. **Inspection collapses**: three or more contiguous reads or searches in one round become `✓ read src/lexer.ts +5`, because six files is one act of homework rather than six lines; changes and verification are never collapsed, since they are the evidence of what happened. The run must be contiguous — narration between two calls ends it, so the agent never appears to have said less than it did. **Motion is confined**: only the footer animates, and only while a turn is live, so settled scrollback never flickers and nothing travels across the screen. The model's reply carries no mark at all — it is plain text on the content column, and the footer is the single place the turn's state is shown. **Status, not narration**: the harness's own text names the state and nothing more — the footer reads `thinking`, `writing`, `checking`, `needs approval`, `done`, a pending action reports `needs approval: <tool>`, and a turn closes with `└─ ✓ done — 7.4s · 3 tools`. Nothing in the interface speaks in the first person; the only voice in the transcript is the model's own prose.

Identity and state are separated so nothing repeats: the header carries the brand, session, workspace, branch, model, and runtime verification, dropping whole items as it narrows (runtime, then branch, then model, with the workspace anchoring the row); the footer carries live state only — the turn's status on the left and the context window on the right.

```text
  ◆ demesne · parser hardening    …/projects/demesne-cli · main · qwen3.8-27b
──────────────────────────────────────────────────────────────────────────────
  ┌ you ────────────────────────────────────────────────────────────── 21:03
      fix the parser
  │ ⋯ thought 4.2s · ctrl+x
  │ ✓ read    src/lexer.ts                                            12ms
  │   I read the guard. It rejects everything above 127, so I will
  │   narrow it to a proper unicode check.
  │ ✓ edit    src/lexer.ts                                             8ms
              - if (c > 127) throw new Error("bad byte")
              + if (c > 0x7f) continue
  │ ✓ run     $ bun test                                              1.2s
              610 pass · 0 fail
  │   I changed the guard and the tests pass.
  └─ ✓ done — 7.4s · 4 rounds · 3 tools · 384 tok · 18.2 tok/s
──────────────────────────────────────────────────────────────────────────────
  ◇ ask anything · / for commands                       ⏎ send · ^O editor
  ◍ writing · 0:06 · 18.2 tok/s                                    ▰▰▱▱▱ 4%
```

Run `bun run ui:preview` to watch this design animate through its states. Reduced motion and `NO_COLOR` keep every glyph static and byte-stable.

To exercise a real turn without a model, run `bun run fake:provider [edit|trace|fail|sweep]` and point a `[provider]` block at `http://127.0.0.1:11437/v1`. The scenarios cover a single edit, a narrated read-heavy turn, a failing command, and six reads issued in parallel so the inspection collapsing is visible.

The footer's left side reports the active phase and elapsed time while its right side prioritizes runtime verification, model identity, the workspace git branch, and a five-cell context meter with an estimated percentage. The footer preserves the cursor during resize, degrades to inline status on very short terminals, and avoids rewriting unchanged content.

Completion receipts separate prompt latency from generation: `ttft` is the summed time to first token across model rounds, and `tok/s decode` excludes that prefill interval. If a provider omits TTFT, the CLI falls back to the broader effective rate rather than inventing decode speed. Receipts also list paths changed and validation commands run using only recorded tool evidence. `/context` explicitly separates the pre-request **estimated context plan** from the last provider-reported token usage, cached input, and request timing; it does not present last-call usage as remaining conversation capacity.

Tool activity is transient in the beacon while running and permanent once in scrollback under `INSPECT`, `CHANGE`, and `VERIFY` phase headers. Each completed call has a compact `✓`, `×`, or `!` result line that remains meaningful under `NO_COLOR`. Host `run_command` approval defaults to **Deny** when Enter is pressed because execution is not sandboxed; file edits retain the faster Allow once default. Cards, prompts, approvals, CJK text, code, lists, headings, quotes, and prose are cell-width aware and tested at 40, 80, and 120 columns. The palette preserves Demesne's electric/signal/citron roles and automatically chooses higher-contrast accents when `COLORFGBG` indicates a light terminal; set `DEMESNE_THEME=dark` or `DEMESNE_THEME=light` to override detection. Set `NO_COLOR=1` for plain output or `DEMESNE_REDUCED_MOTION=1` to disable continuous beacon animation and response pacing.

### Interactive Commands

Type `/` in the CLI to open the `SESSION`, `INSPECT`, and `CONTROL` command palette. Continue typing to filter it, use the up and down arrow keys to select an option, and press Enter to run it. One shared command grammar drives matching, completion, help, aliases, argument validation, and execution. Commands that need a title or session ID keep the selected command in the input so you can finish its argument.

| Command | Action |
| --- | --- |
| `/new [title]` | Start a fresh session |
| `/sessions [filter]` | Browse recent sessions, or search titles and transcripts |
| `/resume <id>` | Switch to an existing session |
| `/rename <title>` | Rename the current session |
| `/delete` | Archive the current session after confirmation |
| `/model [id]` | Switch the active model with a picker or an exact id/prefix |
| `/export [md\|json]` | Write the visible transcript to the current directory |
| `/status` | Show the active session, model, context window, and workspace |
| `/context` | Show the estimated context plan, provider-reported usage, and run evidence |
| `/plan <prompt>` | Draft a read-only plan with inspection tools before changing anything |
| `/diff` | Review the last turn's changes with plain diffs |
| `/undo [path]` | Revert conflict-free changes from the last undoable turn, or one file |
| `/clear` | Clear terminal and reprint masthead |
| `/help` | Show the command reference |
| `/exit` | Exit the CLI |

### Prompt Editing

The prompt supports readline-style editing: `Up`/`Down` walk history (or the
slash menu when it is open), `Ctrl+P`/`Ctrl+N` do the same for multi-line
drafts, `Ctrl+R` starts an incremental reverse search, `Ctrl+A`/`Ctrl+E` move
to the line edges, `Ctrl+U`/`Ctrl+K`/`Ctrl+W` kill text and `Ctrl+Y` yanks it,
`Ctrl+_` undoes, `Alt+B`/`Alt+F` (or `Ctrl+Left`/`Ctrl+Right`) move by word,
and `Ctrl+O` composes the prompt in `$VISUAL`/`$EDITOR`. `Shift+Enter` inserts
a new line.

History is stored privately at `<data-dir>/history.jsonl` (mode `0600`),
tagged with the workspace, and capped at 500 entries. A malformed or unreadable
history never blocks startup.

### Custom Commands

Markdown files in `~/.demesne/commands/` and
`<workspace>/.demesne/commands/` become slash commands named after the file
(`review.md` becomes `/review`). An optional `---` frontmatter block supplies
the palette description, and the body is submitted as the prompt:

```markdown
---
description: Review a path with fresh eyes
---
Review $ARGUMENTS carefully and list concrete findings.
```

`$ARGUMENTS` is substituted when present; otherwise the argument is appended as
a final paragraph. Project files override user files on a name collision, and
built-in command names cannot be shadowed.

Typing while a turn is running queues the text instead of interrupting it. The
composer clears when a prompt is sent and then draws the queue, so the next
message is visible where you are typing it; the queue submits automatically when
the turn finishes, and slash commands queue the same way. The scrollback
renderer, which has no composer, previews the queue in its footer instead.
Control keys and the approval selector keep their normal behavior.

Type `@` to open a workspace file menu for prompt mentions; `Tab` or `Enter`
inserts the selected path. The listing excludes sensitive paths, dependency and
build directories, and paths containing whitespace.

Code fences are syntax-highlighted for TypeScript/JavaScript, JSON, Bash, YAML,
Python, Go, Rust, and diffs; unknown languages fall back to a common keyword
set, and `NO_COLOR` output is unchanged. Completed `edit_file` calls render a
compact inline diff in scrollback, failed tools print their error message, and
path-like tool details are OSC 8 hyperlinks in terminals that support them.
Disable links with `[ui] hyperlinks = false` or `DEMESNE_NO_HYPERLINKS=1`.

For one-off scriptable queries or Unix piping:

```sh
bun run demesne prompt "Inspect this repository"
bun run demesne session list
bun run demesne doctor --json
bun run demesne daemon status
bun run demesne ps
bun run demesne prompt --output json "Summarize the test suite"
echo "Explain this failure" | bun run demesne prompt --output stream-json
```

`demesne ps` lists sessions with queued or running turns alongside inference
counts; `--watch` refreshes every two seconds and `--json` emits the raw
status. `demesne --version` checks for a newer release once a day when stdout
is a terminal (`--check` forces it, `--no-check` or
`DEMESNE_NO_UPDATE_CHECK=1` disables it).

`--output json` prints one result object with the response, usage, metrics, and
recorded changes and validations; `--output stream-json` prints every event
envelope and then a final `{"type":"result",…}` line. Prompts can be piped on
stdin (or passed as `-`), permission requests are denied with a note on stderr,
and the exit code is 0 for a completed turn, 1 for a failure, and 130 for a
cancelled or interrupted turn.

The daemon listens on `127.0.0.1:7337` and stores data in `~/.demesne/demesne.sqlite` by default. Override these values with `DEMESNE_HOST`, `DEMESNE_PORT`, `DEMESNE_DATA_DIR`, or `DEMESNE_SERVER`. A custom data directory must already be private to the current user. Token authentication protects non-health routes, and `DEMESNE_HOST` remains loopback-only until paired-device authentication is implemented.

Without model configuration, the daemon uses a deterministic placeholder processor. To connect LM Studio or another OpenAI-compatible loopback endpoint:

```sh
DEMESNE_MODEL='your-model-id' \
DEMESNE_PROVIDER_URL='http://127.0.0.1:1234/v1' \
DEMESNE_CONTEXT_WINDOW='32768' \
DEMESNE_MAX_OUTPUT_TOKENS='4096' \
bun run daemon
```

Set the context window to the provider's loaded limit, not merely the model architecture's maximum. A configured provider must have a known context window and output reserve before the daemon accepts turns; named strict runtime profiles supply their measured defaults.

The preferred local profile serves the Qwen3.8 27B Q4_0 candidate with llama.cpp at a verified 100K context. It is text-only to reserve unified memory for f16 KV and expects `~/.demesne/models/qwen3.8-27b-q4_0.gguf`. The retained 32K vision profile additionally uses `~/.demesne/models/qwen3.8-mmproj.gguf`:

```sh
brew install llama.cpp
bun run model:llama
```

In another terminal, start Demesne against that endpoint:

```sh
bun run daemon:llama
```

This profile uses one inference slot, batch 256, f16 KV caches, mmap loading, Flash Attention, no weight repacking, llama.cpp `ngram-mod` speculation, a requested 100,000-token context (served as 100,096 by llama.cpp), and a 1,536-token output reserve. It retains short-context speed at 70.71 post-first-output tokens per second. At 93,129 unpredictable retrieval tokens it measured 71.40 prefill and 9.60 decode tokens per second; an exact 169-token passage copied from 93,274-token context reached 16.30 tokens per second cold and 20.37 warm with zero swap growth. MTP, DFlash2 on this Metal runtime, and the older `ngram-cache` remain rejected.

The Q4_0 file was requantized from the retained Q4_K_M GGUF while preserving its output tensor. Recreate it with the model path reported by `ollama show --modelfile qwen3.8-8k-b256:latest`:

```sh
mkdir -p ~/.demesne/models
/opt/homebrew/opt/llama.cpp/bin/llama-quantize \
  --allow-requantize \
  --leave-output-tensor \
  /path/to/qwen3.8-q4_k_m.gguf \
  ~/.demesne/models/qwen3.8-27b-q4_0.gguf \
  Q4_0 8
```

The prior Ollama profile remains the capability baseline and fallback. Create its measured alias, remove the temporary base manifest, and launch the Ollama-backed daemon with:

```sh
brew services start ollama
ollama pull qwen3.8
ollama create qwen3.8-8k-b256 -f experiments/ollama/qwen3.8-8k-b256.Modelfile
ollama rm qwen3.8
bun run daemon:ollama
```

The Ollama command selects and exposes only `qwen3.8-8k-b256:latest`, with an 8K context and 1,536-token output reserve. This Q4_K_M profile remains available as the known-good baseline. Local Q3_K_M and IQ4_XS requantizations were smaller but decoded approximately 19% and 27% more slowly, so they were rejected and removed. `DEMESNE_ALLOWED_MODELS` accepts a comma-separated allowlist when a deployment intentionally needs more than one model. The measured local profiles disable reasoning for responsiveness; custom deployments can set `DEMESNE_REASONING_EFFORT` before starting the daemon.

Use `DEMESNE_API_KEY` when the endpoint requires bearer authentication. HTTPS provider URLs may target remote hosts; cleartext HTTP is restricted to loopback. Optional settings are `DEMESNE_PROVIDER_ID`, `DEMESNE_SYSTEM_PROMPT`, `DEMESNE_REASONING_EFFORT` (`none`, `low`, `medium`, `high`, or `max`), `DEMESNE_RUNTIME_PROFILE`, `DEMESNE_INFERENCE_SLOTS`, `DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS` (180000 without a larger profile-derived cold-prefill floor), `DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS` (default 900000), and `DEMESNE_INCLUDE_USAGE=false` for servers that reject OpenAI's streamed usage option.

The experimental `balanced-32gb` runtime profile is an opt-in strict verifier for the measured 27B Ollama setup. It does not configure Ollama. Create the explicit model alias and separately configure the local Ollama service with Flash Attention and q8_0 KV caches before starting Demesne:

```sh
ollama create qwen3.8-8k-b512 -f experiments/ollama/qwen3.8-8k-b512.Modelfile

DEMESNE_MODEL='qwen3.8-8k-b512:latest' \
DEMESNE_PROVIDER_URL='http://127.0.0.1:11434/v1' \
DEMESNE_PROVIDER_ID='ollama' \
DEMESNE_RUNTIME_PROFILE='balanced-32gb' \
bun run daemon
```

After each provider request starts, Demesne checks the loaded model and local `llama-server` flags before exposing the first model event. The profile requires 8K context, batch and micro-batch 512, one parallel sequence, q8_0 K/V caches, Flash Attention on, one loaded model, and one runner owned by the Ollama process listening on the configured port. A mismatch, runner replacement during verification, or unavailable inspection fails the request rather than silently using another runtime. Authenticated clients can inspect the sanitized state at `GET /v1/runtime`. The verifier accepts any model alias whose observed runtime matches; it does not rely on the requested alias as proof of configuration.

`experimental-q4-kv-32gb` verifies the same 8K, batch-512, one-sequence setup with q4_0 K/V caches. `experimental-q4-kv-b256-32gb` additionally requires batch and micro-batch 256 and uses the alias created from `experiments/ollama/qwen3.8-8k-b256.Modelfile`. Both retain the one-slot and 1,536-token output defaults and exist only for controlled memory testing. Every comparison that selected these K/V precisions was made at short prompt lengths, where K/V precision is nearly unobservable; see the llama.cpp study below before treating quantized K/V as a memory optimization.

`llama-ngram-mod-f16-kv-100k-b256-32gb` verifies the directly served llama.cpp profile requested by `bun run daemon:llama`. It requires requested context 100,000, mmap loading, batch and micro-batch 256, one slot, **f16 K/V caches**, Flash Attention on, `ngram-mod`, one loaded model, and no vision projector. The verifier treats load mode, context, modality, speculation, K/V precision, and batching as configuration. `model:llama:64k` / `daemon:llama:64k` retain the lower-memory text fallback; `model:llama:32k` / `daemon:llama:32k` retain vision; the baseline pair remains non-speculative.

The matched speculation sweep used cold process isolation, unique aliases, AC power, f16 K/V, 32K allocation, one slot, and bracketed non-speculative baselines. `ngram-mod` measured 70.56 post-first-output tokens per second against 15.89-15.92 baselines, with zero swap growth. At 491, 4,051, 8,174, and 16,556 prompt tokens it decoded at 57.38, 64.18, 53.37, and 23.27 tokens per second, versus 15.42, 15.03, 14.95, and 14.23 without speculation. The gain is workload-dependent: the complete six-round multi-file coding fixture improved from a matched 49.39 to 43.80 seconds, 11.3%, rather than 4.4x. It nevertheless passed 3/3 multi-file runs plus read-only diagnosis, single-file repair, and repository-inspection quality gates with exact tools and workspace outcomes.

f16 K/V is a measured requirement, not a default. On build `b10621`, q8_0 K/V decoded 11.95 tokens per second at 4,051 prompt tokens and 7.17 at 16,556, against 15.03 and 14.23 for f16: a 20.5% regression at agent-scale context and 49.6% at long context. It also produced 246.66 MiB of swap-out growth where f16 produced none, so it did not deliver the memory benefit that motivated testing it. Raising batch and micro-batch to 512 was neutral. `experimental-llama-f16-kv-32k-b512-32gb` retains that variant for controlled comparison only.

Cold prefill still dominates a near-capacity first turn and remains near 105 tokens per second; `ngram-mod` accelerates decode, not prefill. Warm append-only turns are different because llama.cpp can reuse nearly the entire prefix. For strict llama.cpp profiles, production therefore keeps the raw transcript through the soft-hard band and compacts only above the hard input limit. When compaction is unavoidable, duplicate reads and tool output are rewritten newest-first to preserve the longest cached prefix; oldest complete-turn dropping remains the final fallback because persisted session trimming represents a contiguous retained suffix.

`bench:llama:longctx` is the gated harness for these questions, and exists because `bench:provider` uses a roughly forty-token prompt at which K/V precision is nearly invisible. It sweeps 512, 4,096, 8,192, and 16,384-token fixtures, records server-measured prefill and decode separately from llama.cpp's own streamed timings, pins the fixture set with a SHA-256 prompt digest, and fails closed on battery power, a non-exclusive or replaced server, any swap-out growth, missing build provenance, or an unstable prompt length. Opt-in fixtures are `capacity-31k`, `capacity-61k`, and `capacity-96k`. `bench:llama:retrieval` places one exact deterministic needle at a configurable depth and independently gates retrieval quality, reported usage, power, runner identity, swap growth, and runtime provenance.

### 32K Context

The 32,768-token window is supported and reachable. A cold 31,149-token request measured 97.11 tokens per second of prefill and 13.08 of decode with wired memory at 19.67 GiB and no swap-out growth. Decode degrades only 15.2% from 491 to 31,149 prompt tokens, so there is no cliff at capacity.

Cold prefill deadlines are derived from the profile rather than fixed. `DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS` defaults to 180,000 ms, which was chosen for 8K contexts and permits a cold prefill of only about 18,900 tokens; a cold 31,149-token request emits its first provider event at 320.8 seconds and was therefore always aborted. A strict profile now supplies a minimum first-event deadline computed from its verified context capacity and a conservative measured prefill floor, so the 32K profile requires at least 502,000 ms while the 8K profiles keep the existing default. An explicit environment value still wins, and starting below a profile's measured budget logs a warning. llama.cpp does send keep-alive bytes during prefill, but they do not decode into provider events and do not satisfy the deadline.

Prefix reuse is what makes long contexts practical, and reduction is what destroys it. llama.cpp reports `prompt_tokens_details.cached_tokens`. On an append-only transcript a 9,145-token request took 83.40 seconds cold, 0.25 seconds warm at 100% cached, and 0.78 seconds at 99.8% cached after appending another round. Rewriting the oldest turn dropped reuse to zero: the reduced 6,475-token request took 58.50 seconds against 0.78 seconds for the larger unreduced request. Cache-aware delayed-hard planning is now enabled only by strict llama.cpp profiles, not by arbitrary provider IDs. A production-path near-capacity continuation completed in one second with 29,317 of 29,338 input tokens cached (99.93%) and no context actions.

### 64K And 100K Context

The GGUF declares a native 262,144-token context, so neither 64K nor 100K uses RoPE extrapolation. The promoted text-only 64K profile passed exact retrieval at 58,426 reported tokens with a 695.32-second cold TTFT, zero swap growth, and unchanged runtime provenance. At 65,075 tokens it sustained 81.33 prefill and 10.96 decode tokens per second. Startup retained 22-27% system memory availability and did not grow swap. Short-context provider throughput remained 70.57 tokens per second, so increasing allocated capacity did not regress normal coding turns.

The first 102,400-token profile failed memory gates, but the exact-100,000 follow-up changed two controlled variables: llama.cpp's served allocation fell to 100,096 and model loading changed from anonymous `none` to file-backed `mmap`. Startup availability improved from 12% to 18-20%. Exact 93,129-token retrieval then passed with zero swap growth, 71.40 prefill tokens per second, and 9.60 decode tokens per second. A deterministic 128-word copy payload at 93,274 tokens proved the 15-token target for reusable coding output: 16.30 native tokens per second cold with 73.4% ngram acceptance and mean draft length 48, then 20.37 tokens per second warm with 85.4% acceptance, 0.43-second TTFT, exact output, and zero swap growth. Unpredictable output remains near 9.6 tokens per second; 15 is a workload-dependent target, not a universal 100K decode claim.

Rejected alternatives remain recorded. Disabling RAM cache/checkpoints saved only approximately 0.2 GiB. q8 keys collapsed prefill to 6.6 tokens per second by 35K. Offline Metal tuning selected the existing kernels in every tested bucket. A generic Qwen3.5 0.8B draft was MRoPE-incompatible, built-in MTP reduced short decode to 12.67 tokens per second, and target-specific DFlash2 required a custom llama.cpp build but started at 6% availability, decoded at 6.11 tokens per second, and grew swap by 1.2 GiB. Decision: exact 100K mmap with f16 KV and `ngram-mod` is the default; 64K remains the lower-memory fallback.

### Inference Scheduling

The daemon uses one active inference slot by default. Provider rounds from concurrent sessions enter a process-local FIFO queue, while tool execution and permission waits happen without holding the slot. This prevents large local generations from competing unpredictably for unified memory while still allowing another session to infer during file reads, edits, tests, or approval waits. Set `DEMESNE_INFERENCE_SLOTS` to a larger positive integer only for a backend that safely supports parallel requests. Every named strict 32 GB profile requires exactly one slot. The scheduler has an injectable, one-slot-only quiescent-boundary hook for controlled benchmarks; production does not configure it or manage model residency.

`bench:scheduling-recycle` tests that hook against an isolated strict Ollama service with two distinct concurrent sessions. Two forced-recycle repetitions preserved exact session markers, tool paths, complete provider events, FIFO order, runtime provenance, and zero swap growth. In the matched control, recycling increased two-session makespan from 65.05 to 93.51 seconds. The 28.47-second cost comprised approximately 13.74 seconds of unload/reload/verification and 14.62 seconds of lost prefix reuse on the next cold request. This proves the concurrency mechanism is safe but rejects unconditional or eager recycling.

A sustained matched run used ten nonce-separated concurrent pairs, 40 provider rounds, and 138,380 aggregate input tokens. Without recycling, availability fell from 35% to 14% and the workload produced 5.12 GiB of swap-out traffic. Requiring at least 12 completed rounds and at most 20% availability triggered once after round 19, restored availability from 19% to 33%, and reduced swap-outs to 130.81 MiB. All 20 turns retained exact quality and event integrity. Total makespan increased by 40.59 seconds across the approximately 17.8-minute control, or 3.8%, while median pair makespan improved by 1.2%.

Replication showed that coarse available-memory percentage is not a stable trigger by itself. Equivalent pressure-gated runs fired after rounds 17, 19, and 21 and produced 1.13 GiB, 130.81 MiB, and zero swap-outs respectively. A deterministic two-recycle follow-up instead bounded each runner to 12 completed requests. Because each benchmark pair has four requests, transitions at rounds 12 and 24 preserved pair boundaries. Two unchanged repetitions retained all 10/10 pairs and complete event integrity, produced zero swap-outs with no swap-use growth, and added 1.70-1.71% aggregate pair makespan while improving median pair makespan by 1.22-1.26%. This is the preferred benchmark policy for this exact workload, but the alignment is fixture-specific. Production recycling remains disabled until a session-aware boundary can provide the same result for variable real workloads; all strict 32 GB profiles remain opt-in.

The scheduler now tracks whether a released provider lease belongs to a turn that requires another model round. Benchmark maintenance is deferred while any such continuation exists, and a skipped boundary remains pending until all affected turns settle. A variable-length live fixture used one-read/two-round and two-read/three-round turns across eight concurrent pairs, totaling 40 provider rounds and 141,223 input tokens. Its control produced 2.55 GiB of swap-outs. A 12-request policy was safely deferred to complete-turn boundaries at rounds 15 and 30; two unchanged repetitions preserved all 8/8 pairs and exact round counts, produced zero swap-outs with falling swap use, and added 2.76-2.80% aggregate pair makespan. Every recycle snapshot recorded zero pending continuations. This validates the turn-aware benchmark mechanism across asymmetric turns, but production still supplies no recycle hook pending broader full-agent and continuously arriving workload evidence.

Continuous admission requires bounded deferral because fresh turns can otherwise prevent the continuation set from reaching zero. The benchmark controller can now request a continuation drain once its gates pass: the scheduler temporarily holds fresh first rounds, preserves FIFO among already-started continuations, and recycles only after those turns settle. A configurable deadline abandons recycling, resumes fresh FIFO, disables further maintenance for that scheduler lifetime, and invalidates the report rather than risking starvation. With six asymmetric pairs admitted together, the 30-round control produced 749.31 MiB of swap-outs and a median pair completion time of 853.74 seconds. A four-request trigger requested drains with four pending turns at rounds 4 and 14, recycled at zero-pending boundaries 10 and 20, and divided the workload into three ten-request runner epochs. Two unchanged repetitions retained all 6/6 pairs, produced zero swap-outs and no drain timeouts, and reduced median pair completion time by 51.52%. The unusually large speedup reflects severe queueing and swap in this continuous-load control and must not be generalized beyond this fixture. Production remains strict FIFO and installs no drain or recycle hook.

Deterministic mixed-lifecycle coverage now extends the drain mechanism beyond read-only turns. One shared daemon test continuously queues an approved edit, a permission wait cancelled before execution, an unknown-tool failure that recovers on its next model round, a queued cancellation, and fresh work. It proves that recovery and approved continuations bypass fresh first rounds during drain, cancelled permission state is removed, late permission resolution fails, maintenance blocks fresh inference, and FIFO resumes afterward. A separate unresolved-permission test proves that the drain deadline resumes fresh work, records one timeout, performs no recycle, and disables further maintenance. Cancelling a permission wait now transactionally changes its persisted permission state to `cancelled`; it no longer appears as a stale pending permission. These are deterministic lifecycle guarantees, not live-model memory evidence.

`bench:mixed-agent-recycle` is the corresponding scenario-aware live harness. It uses one shared daemon, rolling admission, isolated workspaces, and explicit expected outcomes for read-only completion, approved editing, recoverable tool failure, permission-wait cancellation, and cancellation before provider entry. The strict wrapper owns an isolated Ollama runner lifecycle and fails closed on runtime provenance, AC power mode, exclusive runner ownership, scenario scoring, provider events, drain timeouts, transition continuity, and swap-out growth. In two matched 15-task q4/b256 repetitions, both disabled controls and both two-recycle policy arms completed 15/15 scenarios with zero swap-out growth. Because the controls were already memory-eligible, recycling provided no memory benefit and increased workload makespan by 27.9% and 31.9%. A final maximum control then completed 50/50 tasks and 100 provider rounds with 182,270 input tokens, zero swap-out growth, and availability changing only from 34% to 33%. Representative mixed work therefore provides neither a memory need nor a defensible trigger for recycling. The recycling study is closed with production remaining strict FIFO and no recycle hook; reconsideration requires independent production telemetry showing sustained runner-induced pressure.

Each turn snapshots its provider, model, runtime profile, and thinking selection when submitted. A later model switch affects future turns but cannot change the model used by a multi-round turn already in progress. Waiting turns can be cancelled before they enter the provider, and shutdown waits for active provider cleanup before closing persistence.

Queue duration is stored and displayed separately from provider request duration and TTFT. This keeps backend latency measurements meaningful when another session was ahead in the queue.

### Context And KV Cache

KV cache memory belongs to the inference server, not Demesne's SQLite database. Demesne keeps requests cache-friendly by persisting an append-only provider transcript containing user messages, visible assistant messages, tool calls, and tool results. Successful turns are reconstructed with the same message structure after a daemon restart; hidden reasoning is journaled for live display but is deliberately excluded from future model context.

Before every provider call, Demesne records a deterministic context plan containing the effective known capacity, enforced output reserve, future tool-result and safety reserves, conservative input estimate, tool-definition estimate, and context-reduction actions. Estimator version 2 uses serialized OpenAI-compatible request JSON, a UTF-8 byte heuristic, and a measured 1.20 safety factor; it remains an estimate rather than an exact tokenizer. Historical reduction begins only when the selected policy crosses its boundary. Once required, the planner replaces exact duplicate reads, compacts multiline historical output while preserving valid JSON, and finally removes complete oldest turns until budget is met. System instructions, tool definitions, the current user request, and the newest current-turn tool-result batch remain protected. If a multi-round tool loop still exceeds the hard limit after historical reduction, older current-turn tool results are compacted newest-first before the newest batch is touched; this prevents a large sequence of reads from failing the turn outright. `DEMESNE_MAX_OUTPUT_TOKENS` configures and enforces the output reserve. Named strict 32 GB profiles default it to 1536 tokens.

Model-authored summary checkpoints are not enabled in production. The measurement-only `bench:summary-checkpoint` harness compares raw history, dropped-prefix history, and a strict structured checkpoint while recording fidelity, injection resistance, token usage, latency, compression, runtime provenance, and paired latency break-even. Current evidence rejects production adoption; deterministic schema-3 reduction remains the active policy.

`bench:context-reduction` directly compares an unreduced near-capacity provider request with its exact schema-3 projection. The pinned 12-pair experiment reduced provider-reported input from a median 5,824.5 to 3,189.5 tokens and reduced median time to first output from 63.10 to 35.00 seconds with exact probe quality in both arms. Pair-specific system nonces prevent exact-request prefix-cache reuse, order is balanced, and the report fails closed on usage, runtime, runner, power, and fidelity gates. This result supports deterministic reduction for the controlled fixture and measured 27B runtime under observed swap pressure; it is not a general quality or performance claim, and `balanced-32gb` remains opt-in.

`bench:repository-context` extends that comparison to pinned inspection, single-file repair, and multi-file feature transcripts. Its clean-start smoke run preserved exact facts in all 6/6 raw and 6/6 reduced measurements with zero reduced-only failures. Depending on the fixture, schema-3 removed 951-1,405 provider-reported input tokens and saved 10.2-15.0 seconds to first output. This is positive synthetic-repository evidence, but the run still accumulated approximately 3.04 GiB of swap-out traffic and uses only two measured pairs per fixture, so it does not promote `balanced-32gb` to a default.

`bench:full-agent-context` runs the same task classes through the complete daemon, permission, tool, persistence, workspace-edit, and focused-test loop. The corrected six-pair run completed every raw and schema-3 task with valid final workspaces and zero schema-3-only failures. Inspection and single-file repair remained below the soft limit, so schema 3 preserved their raw requests and matched latency within noise. The multi-file task crossed the soft limit and saved a median 2,867.5 aggregate input tokens, but changing the historical prefix added a median 8.49 seconds of summed TTFT. That run began with only 27% memory available and recorded approximately 2.32 GiB of swap-out traffic. Schema 3 therefore remains a capacity-safety policy rather than a universal latency optimization.

The same harness has a measurement-only `soft-delayed-hard` comparison that preserves append-only history above the soft limit and invokes the exact production reducer only above the hard input limit. Two unchanged expanded runs completed all 24/24 pairs with exact task quality. Delaying reduction carried a median 2,862.5-2,871.5 additional input tokens on the multi-file fixture while lowering aggregate TTFT by 5.80-6.41 seconds, and carried 895 additional tokens on the long-session fixture while lowering aggregate TTFT by 11.77-11.84 seconds. In all four hard-boundary pairs, estimate 7,100 triggered the production deduplicate, truncate, and complete-turn-drop actions and produced estimate 5,155, below the 6,656 hard limit. This validates delayed intervention for the measured local runtime, but it is not the provider-neutral default: Ollama returned no cached-token counters, providers without prefix reuse would pay only the extra input cost, and the two runs recorded approximately 6.42 and 4.73 GiB of swap-out traffic. Production therefore retains the soft-boundary schema-3 planner pending an explicit cache-capability or opt-in policy backed by broader low-pressure measurements.

`bench:staged-memory` requires an explicit isolated Ollama endpoint and separates unloaded baseline, model loading, idle residency, full-agent workload, and post-unload recovery. Schema 2 also samples runner RSS without reading process environments and records observed per-PID peaks. Set `DEMESNE_MEMORY_RELOAD_BETWEEN_BLOCKS=true` to run the two balanced-order fixture blocks in separate, strictly verified runner epochs. That experiment mode requires exactly two pairs per fixture and fails unless the boundary reaches zero runners, loads a new PID, restores the strict profile, and preserves model, backend, power, and ownership provenance.

The first matched `experimental-q4-kv-32gb` run retained 100% full-agent task success, ended with 17% memory available, and recorded zero workload swap-outs. That result did not replicate after adding historical recall and inferred two-file repair gates. Across the expanded ten-pair suite, q8/b512, q4/b512, and q4/b256 all retained 100% task success but swapped out approximately 1.96, 1.68, and 1.13 GiB respectively. Batch 256 was approximately 9% faster than q8/b512.

Two q4/b256 follow-ups recycled the runner once between the two five-fixture blocks. Both completed all 10/10 pairs with 100% raw and schema-3 quality and zero swap-outs. Midpoint availability recovered from 34% to 35%; workload page-outs were 8.14 and 14.03 MiB, and observed runner RSS peaks were 21.71-22.39 GiB. The recycle took approximately 14.12 seconds and total workload duration was 822.13 and 824.75 seconds, about 3% above the 797.63-second no-recycle run. This reproducibly identifies bounded runner lifetime as the first configuration to pass the expanded memory gate, but recycling exists only in the benchmark and a safe production trigger has not been established. All profiles therefore remain opt-in.

If a provider explicitly rejects a request because it exceeds the context window, Demesne retries after dropping only complete oldest turns and persists that new context boundary. It never trims the current request, active tool calls, or matching tool results. Providers that truncate requests internally should be configured to reject over-limit input if that behavior is available.

The CLI records exact request duration and time-to-first-token. It displays cached input tokens only when the provider returns an explicit `cached_tokens` counter. Ollama and LM Studio otherwise control model residency, KV precision, Flash Attention, TTL, and cache-slot eviction. Keeping the selected model loaded preserves reuse between prompts; the measured recycle experiment shows that an indefinitely retained runner can eventually trade that benefit for memory pressure. The optional strict Ollama profile verifies a measured configuration but still does not manage backend residency or recycling.

Discover models and submit a prompt with:

```sh
bun run demesne models
bun run demesne session list
bun run demesne prompt "Explain the current architecture"
```

New sessions are bound to the current directory. Select another workspace explicitly with:

```sh
bun run demesne session create --workspace /absolute/project/path "Project session"
```

Workspace roots cannot be `/` or the user's home directory. Legacy sessions without a workspace remain usable as chat sessions but receive no coding tools.

## Coding Tools

The model can use these bounded tools:

| Tool | Behavior | Permission |
| --- | --- | --- |
| `list_files` | Recursive workspace listing with optional glob patterns (`**`, `*`, `?`) | Automatic |
| `read_file` | Bounded UTF-8 line ranges with `totalLines`/`remainingLines` metadata for precise paging | Automatic |
| `read_files` | Batch up to 8 file reads in one call; fails soft per entry | Automatic |
| `search_files` | Ripgrep-backed (fallback walk) case-insensitive literal search with glob includes; deterministic `path:line:text` output | Automatic |
| `edit_file` | Create, append, or batch-edit files; matching falls back from exact text to trimmed lines to whitespace-insensitive comparison, with ambiguity guards | Per-call approval |
| `write_file` | Full-content create or atomic overwrite (≤96 KiB), creating parent directories | Per-call approval |
| `git_status` / `git_diff` | Read-only branch/status and unified diff (staged or unstaged) for self-verification | Automatic |
| `move_path` | Rename/move files or directories inside the workspace, with overwrite guards | Per-call approval |
| `delete_path` | Delete a file, or a directory with `recursive: true`; protected paths refused | Per-call approval |
| `run_command` | Executes an argv array with a minimal environment; `background: true` returns a handle instead of blocking | Per-call approval |
| `command_logs` / `command_stop` | Read incremental output from, or terminate, a backgrounded command | Automatic |

Write prompts offer **Allow once**, **Always this session** scoped to the file's directory, and **Deny**. When a rule can be expressed safely, a fourth option, **Always allow (save)**, appends a persistent entry to `[permissions] allow` in the user config; the daemon re-reads the file, so the rule applies immediately and survives restarts. `run_command` prompts persist the exact argv (never a bare `run_command`) and otherwise offer only **Allow once** and **Deny**; every unlisted command still requires approval. In-memory write grants remain attached to their session until the daemon exits and are listed under `/context`. Redirected or otherwise non-interactive CLI use denies these operations by default. Override the turn policy explicitly with `--permission ask` or `--permission deny`.

`run_command` is host execution, not an OS sandbox. It starts in the workspace with filtered environment variables and process limits, but an approved executable still has the access of the daemon's operating-system user.

Sensitive paths such as `.env`, `.git`, `.ssh`, `.aws`, `.docker`, common credential files, and private-key formats are excluded from automatic reads and searches.

## Configuration

Demesne reads two TOML files and merges them over built-in defaults:
`~/.demesne/config.toml` (user) and `<workspace>/.demesne/config.toml`
(project). Environment variables override both, and an explicit CLI flag such
as `--server` overrides everything. Unknown keys are rejected with the file
path so a typo cannot silently disable a setting.

```toml
server = "http://127.0.0.1:7337"
theme = "auto"

[daemon]
auto_start = "prompt"   # prompt, always, or never
port = 7337

[provider]
url = "http://127.0.0.1:11436/v1"
id = "llama.cpp"
model = "qwen3.8-q4_0-100k-b256"
context_window = 100000
max_output_tokens = 1536
runtime_profile = "llama-ngram-mod-f16-kv-100k-b256-32gb"
reasoning_effort = "none"

[permissions]
# Persistent approvals: "edit_file:src", "write_file:README.md",
# "run_command:git status", or a bare tool name for non-execution tools.
allow = []

[notifications]
enabled = true
minimum_duration_ms = 30000

[ui]
intro = true
hyperlinks = true
```

The daemon uses the user file and environment only: provider settings are
machine-wide, so a workspace cannot reconfigure the shared runtime. The CLI
merges the project file for workspace-specific defaults. `DEMESNE_CONFIG_FILE`
points the loader at a different user config for testing or nonstandard homes.

Interactive terminals emit a desktop notification (OSC 9) when a turn finishes
after at least `minimum_duration_ms` or when an approval is waiting.
`DEMESNE_NO_NOTIFICATIONS=1` disables them, and terminals without OSC 9 support
ignore the sequence.

A workspace can also provide instructions for the model. `DEMESNE.md` is
preferred, and `AGENTS.md` is accepted so repositories that already target
other agents work unchanged. The file is read per turn (capped at 32 KiB),
appended to the system prompt, and framed as taking precedence over general
guidance when the two conflict.

Run `demesne setup` to create the user config interactively, or
non-interactively for automation:

```sh
bun run demesne setup --yes \
  --provider-url http://127.0.0.1:11436/v1 \
  --model qwen3.8-q4_0-100k-b256 \
  --context-window 100000 --max-output-tokens 1536
```

Setup preserves unrelated settings, backs up an existing file to
`config.toml.bak`, validates the merged result, and writes atomically with mode
`0600`.

### MCP Servers

Model Context Protocol servers extend the tool set. Each server is declared in
the user config:

```toml
[mcp.servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
env = { TOKEN = "secret" }   # optional
timeout_ms = 15000           # optional, default 30000
```

The daemon spawns each server over stdio, performs the MCP handshake, and
registers its tools as `mcp__<server>__<tool>`. Every MCP tool requires
per-call approval; a bare allowlist entry such as
`allow = ["mcp__files__read_file"]` persists approval for that tool. A server
that fails to start is skipped without stopping the daemon, and a crashed
server is restarted lazily on its next call. MCP servers are read from the user
config only, not project files.

## Authentication

On first launch, `demesned` creates `~/.demesne/daemon.token` with mode `0600`. The CLI reads the selected data directory's token automatically for loopback connections and authenticates every non-health request. Set `DEMESNE_DAEMON_TOKEN` explicitly for other deployments. Non-loopback CLI connections require HTTPS.

The daemon remains loopback-only. Remote control is intentionally unavailable until paired-device authentication is implemented.

## Build Executables

```sh
bun run build
./dist/demesned
./dist/demesne prompt "Run the tests and fix failures"
```

The local build command targets the current machine. Public macOS distribution additionally requires explicit arm64 and x86_64 artifacts, Developer ID signing, notarization, and published checksums; the repository does not yet automate those release steps.

## Development

```sh
bun --version # 1.4.0
bun run typecheck
bun test
```

## Structure

```text
apps/daemon/       HTTP daemon and turn runner
apps/cli/          Streaming command-line client
packages/client/   Typed REST and SSE client used by the CLI
packages/protocol/ Shared API and event contracts
packages/providers/OpenAI-compatible provider adapters
packages/storage/  SQLite state and event journal
packages/config/   User and project configuration loading
packages/brand/    Palette, command grammar, and terminal rendering
```

The typed client can be used directly by scripts and editor integrations:

```ts
import { DemesneClient } from "@demesne/client";

const client = new DemesneClient({ server: "http://127.0.0.1:7337", token });
const { turn } = await client.submitTurn(sessionId, { content: "Run the tests" });
for await (const event of client.streamEvents(sessionId, turn.id)) {
  if (event.type === "message.delta") process.stdout.write(String(event.payload.delta));
}
```

It reconnects with exponential backoff, resumes from the last event ID, and
throws `ApiRequestError` with the daemon's error code for failed requests.

Sessions, structured model transcripts, reasoning, model requests, token usage, tool calls and results, permissions, cancellation, and file undo snapshots are persisted in the event journal. Active model and tool work is marked interrupted after a crash and is never replayed automatically. One daemon holds an exclusive data-directory lock; another process using the same directory fails before opening SQLite.
