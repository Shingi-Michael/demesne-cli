# Demesne Local-Model Research and Implementation Plan

## Document Purpose

This is the living plan for developing Demesne into a local-first coding agent that makes effective use of large quantized models on memory-constrained personal computers, beginning with a 32 GB Apple Silicon system and a model with an approximately 15-20 GB loaded weight footprint.

The project will be completed in explicit phases. We will not jump directly to advanced optimizations such as speculative decoding. Each phase will establish the knowledge, measurements, and implementation foundations needed by the next phase.

This project is also a teaching collaboration. The assistant will perform the coding, testing, and experiments while explaining the engineering and research process. The student will primarily observe, ask questions, challenge assumptions, and help interpret results.

Conceptual review is optional and never blocks engineering progress. The assistant may explain decisions or offer short review questions when useful, but the user and assistant can continue implementation, experiments, and later phases without completing them.

## Collaboration Agreement

### Assistant Responsibilities

The assistant will:

- Perform all code changes and experiments unless the student explicitly asks to participate in an implementation task.
- Explain the purpose of a change before implementing substantial behavior.
- Identify the files, functions, data flow, and system boundary involved in each change.
- Separate observed facts, engineering assumptions, predictions, and measured results.
- Introduce new concepts using both a plain-language explanation and a concrete Demesne example.
- Keep changes small enough to review and understand.
- Run relevant tests and benchmarks after implementation.
- Report failures and negative experimental results instead of hiding them.
- Preserve raw benchmark results and enough configuration metadata to reproduce them.
- Offer optional review questions when they are useful.
- Re-explain unclear concepts when requested without blocking implementation or experiments.
- Maintain this document as the project plan changes.

### Student Responsibilities

The student will:

- Observe the implementation and ask questions whenever an explanation is unclear.
- Use optional conceptual review when it is useful.
- Help challenge assumptions and interpret unexpected results.
- Distinguish between not knowing something yet and disagreeing with a design decision.
- Say when the pace is too fast or when additional examples are needed.
- Help decide product and research priorities when several valid paths are available.
- Avoid treating predicted performance as established fact before experiments are complete.

### Progression Rule

Each phase follows this sequence:

1. State the phase question and hypothesis.
2. Teach the relevant concepts.
3. Inspect the existing implementation together.
4. Describe the proposed change and expected effects.
5. Implement the smallest useful change.
6. Run tests and controlled experiments.
7. Compare results with the prediction.
8. Explain discrepancies and limitations.
9. Offer optional conceptual review when useful.
10. Continue engineering independently of whether that review occurs.

Conceptual review is never a progression gate. Questions and alternative explanations remain available, but implementation, verification, and later phases continue unless the user explicitly pauses or redirects the work.

## Research Discipline

Every optimization will be treated as a testable hypothesis.

We will use these labels consistently:

| Label | Meaning |
| --- | --- |
| Fact | Directly observed in code, documentation, hardware metadata, or measurements |
| Assumption | Something currently treated as true so work can proceed |
| Prediction | A result expected before an experiment is run |
| Measurement | Data produced by a controlled experiment |
| Interpretation | Our explanation of why a measurement occurred |
| Decision | A design choice supported by the available evidence |

An optimization will not become a default merely because it sounds theoretically correct. It must demonstrate a useful improvement without unacceptable regressions in memory safety, reliability, or coding-task quality.

Negative results are valid research results. For example, discovering that a draft model makes speculative decoding slower is useful because it prevents an ineffective design from becoming part of the product.

## Project Mission

Demesne will maximize the useful coding capability of local models on memory-constrained hardware. It will optimize the complete agent loop: model inference, request scheduling, context construction, cache stability, tool execution, persistence, and task completion.

The project is not solely trying to maximize tokens per second. Its primary question is:

> How much correct coding work can a local model complete per unit of time and memory on hardware a person already owns?

## Initial System Target

The first supported target will be deliberately conservative:

| Property | Initial target |
| --- | --- |
| Hardware | 32 GB Apple Silicon Mac |
| Model footprint | Approximately 15-20 GB of loaded weights |
| Model class | Dense 27B-32B initially; MoE models measured separately |
| Loaded models | One primary model at a time |
| Inference concurrency | One active generation request |
| Initial context | 8K tokens |
| Experimental context | 16K tokens |
| KV cache | q8_0 initially, q4_0 as an experiment |
| Attention | Flash Attention when supported and verified |
| Residency | Keep the primary model loaded between turns |
| Agent behavior | Stable prompts, bounded outputs, durable sessions, and efficient tool use |

We will not initially promise 32K context, 35 tokens per second, or a 2-3x speculative-decoding improvement. Those may become experimental goals, but they must first be demonstrated on the exact hardware, model, and backend.

## Success Metrics

### North-Star Metric

The primary metric is:

```text
successful coding tasks completed per hour
```

This metric includes model inference, context processing, tools, validation, and recovery from errors.

### Supporting Metrics

| Area | Metrics |
| --- | --- |
| Inference | Cold TTFT, warm TTFT, prefill tokens/sec, decode tokens/sec, request duration |
| Scheduling | Queue duration, active inference slots, cancellation delay |
| Memory | Loaded weight size, peak process memory, memory pressure, swap delta |
| Context | Planned input, actual input, output reserve, cached input, compacted tokens |
| Agent | Model rounds, tool calls, parallel tool groups, failed tool calls, total task time |
| Quality | Task completion, tests passing, unnecessary changes, tool-call validity |
| Reproducibility | Hardware, backend, model, profile, fixture version, and source revision |

### Initial Acceptance Targets

| Area | Target |
| --- | --- |
| Memory | No sustained swap growth during the standard coding benchmark |
| Memory | macOS memory pressure remains normal during supported workloads |
| Context | Stable operation at 8K |
| Context | No context-overflow failures in standard fixtures |
| Scheduling | One local inference slot by default |
| Reliability | Existing tests continue to pass |
| Quality | No reduction in baseline coding-task completion rate |
| Performance | At least 20% lower median task completion time after the first optimization cycle |
| Observability | Every measured run includes a reproducible configuration fingerprint |

## Initial Predictions

Predictions are written before experiments so we can later compare expectation with evidence.

### Dense-Model Decode Prediction

For an approximately 17 GB dense model, a rough bandwidth ceiling is:

```text
theoretical tokens/sec ~= memory bandwidth / loaded weight bytes
```

| Memory bandwidth | Approximate theoretical ceiling | Initial practical prediction |
| ---: | ---: | ---: |
| 200 GB/s | 11.8 tok/s | 7-11 tok/s |
| 273 GB/s | 16.1 tok/s | 9-15 tok/s |
| 400 GB/s | 23.5 tok/s | 13-21 tok/s |

These estimates are not valid for every architecture. In particular, a mixture-of-experts model may activate only part of its parameter set for each token.

### Optimization Predictions

| Optimization | Initial prediction | Confidence |
| --- | --- | --- |
| Flash Attention | Better prefill and long-context behavior; smaller decode benefit | Medium |
| q8_0 KV cache | Roughly 40-50% lower KV memory than FP16 with low quality risk | Medium |
| q4_0 KV cache | Roughly 65-75% lower KV memory than FP16 with greater quality risk | Medium |
| One inference slot | Better stability and total throughput under concurrent session load | High |
| Proactive context planning | 20-50% fewer input tokens in long sessions | Medium |
| Bounded tool output | Fewer context overflows and repeated model calls | High |
| Tool-loop optimization | 10-30% fewer model rounds on inspection-heavy tasks | Medium |
| Delta batching | Small daemon improvement unless output rate becomes high | Medium |
| Speculative decoding | 1.2-1.8x decode gain with a compatible draft; possible regression otherwise | Low |

## Existing Foundation

Demesne already provides several pieces needed by this plan:

- Provider-neutral streamed model requests in `packages/providers/src/index.ts`.
- A durable multi-round agent loop in `apps/daemon/src/engine.ts`.
- Exact provider request duration and TTFT recording.
- Provider-reported token and cached-token recording.
- Persisted model transcripts and context boundaries in `packages/storage/src/index.ts`.
- Bounded file tools and batch file reads in `apps/daemon/src/tools.ts`.
- Stable tool-definition ordering for KV-prefix consistency.
- CLI context and run reporting in `apps/cli/src/context-rail.ts`.
- Reactive complete-turn context trimming after a provider overflow.

The plan extends these foundations rather than replacing the project architecture.

# Phase 0: Environment Characterization

## Research Question

What exact hardware, model, and backend are we optimizing?

## Concepts To Learn

- Unified memory on Apple Silicon.
- Model file size versus loaded weight size.
- Dense models versus mixture-of-experts models.
- Memory bandwidth and the approximate bandwidth-bound decode model.
- Model weights, compute buffers, and KV-cache memory.
- Cold versus warm inference.

## Work

- Record the Apple chip, memory capacity, macOS version, and known memory bandwidth.
- Record the inference backend and version.
- Record the exact model identifier, architecture, quantization, and file size.
- Measure loaded model memory rather than relying only on disk size.
- Record runtime context, KV-cache type, Flash Attention state, loaded-model count, and inference concurrency.
- Observe memory pressure and swap before, during, and after generation.
- Define a reproducible machine and runtime fingerprint.

## Planned Product Work

Create a future `demesne doctor` command that reports the environment and distinguishes detected values from unknown values.

## Prediction

The loaded system footprint will be meaningfully larger than the model file alone because the backend also needs runtime buffers, KV cache, metadata, and operating-system memory.

## Deliverable

A checked-in description of the test environment and a machine-readable runtime fingerprint stored with benchmark results.

## Optional Review Questions

Optional topics to review:

1. Why a 17 GB model file does not imply that only 17 GB of unified memory will be used.
2. Why dividing memory bandwidth by model weight size is useful but not an exact prediction of token speed.

# Phase 1: Measurement Foundation

## Research Question

How do we measure local inference and full-agent performance reproducibly?

## Concepts To Learn

- Independent and dependent variables.
- Controlled experiments and reproducibility.
- Cold TTFT versus warm TTFT.
- Prompt prefill versus autoregressive decode.
- Median, variance, and percentile latency.
- Microbenchmarks versus end-to-end benchmarks.
- Why a benchmark must include configuration metadata.

## Work

- Extend provider requests with fixed output limits and deterministic controls where supported.
- Add a direct provider benchmark that bypasses tools and the agent loop.
- Add full-agent coding fixtures with known expected outcomes.
- Record queue, prefill, decode, memory, context, and task-level metrics.
- Persist a backend, model, profile, fixture, and source-revision fingerprint.
- Separate cold and warm measurements.
- Run a warm-up before measured trials.
- Report median results and variance rather than the best observed run.
- Add a future `demesne bench` command and a readable benchmark report.

## Initial Benchmark Fixtures

| Fixture | Purpose |
| --- | --- |
| Repository inspection | Measure search and read behavior |
| Single-file repair | Measure edit and validation behavior |
| Multi-file feature | Measure planning and context growth |
| Failed-test repair | Measure error recovery |
| Long-session continuation | Measure history and cache behavior |
| Parallel inspection | Measure batched tool use |
| Ambiguous-edit recovery | Measure tool reliability |

## Experiment Protocol

```text
1 warm-up run
5 measured provider runs
at least 3 measured agent runs
fixed prompt
fixed output-token limit
thinking disabled for throughput comparisons
temperature zero when supported
same model, context, backend, and machine state
```

## Prediction

The first benchmark will show that total task time is affected by both model inference and the number of model/tool rounds. Raw decode speed alone will not explain agent performance.

## Deliverable

A reproducible baseline report for the unoptimized system.

## Optional Review Questions

Optional topics to review:

1. Why we must separate cold and warm TTFT.
2. Why the fastest tokens/sec result might not produce the fastest completed coding task.

# Phase 2: The 32 GB Runtime Profile

## Research Question

Which runtime configuration provides the safest useful baseline for a large local model on 32 GB?

## Concepts To Learn

- Memory headroom and macOS memory pressure.
- KV-cache growth with context length.
- KV-cache quantization and its quality tradeoff.
- Flash Attention and why its largest effect may be on prompt processing.
- Model residency and backend process configuration.
- Why environment variables on Demesne do not reconfigure an already-running Ollama process.

## Work

- Define `safe-32gb`, `balanced-32gb`, and experimental long-context profiles.
- Distinguish settings enforced by Demesne from settings owned by the backend.
- Detect and report profile mismatches.
- Benchmark Flash Attention off and on.
- Benchmark FP16, q8_0, and q4_0 KV caches where supported.
- Benchmark 8K and 16K context allocations.
- Test 32K only as an experiment after safe configurations are understood.
- Record memory pressure, swap, speed, and quality for every configuration.

## Initial Experiment Matrix

| Experiment | Context | KV cache | Flash Attention |
| --- | ---: | --- | --- |
| Baseline | 8K | FP16 | Off |
| A | 8K | FP16 | On |
| B | 8K | q8_0 | On |
| C | 8K | q4_0 | On |
| D | 16K | q8_0 | On |
| E | 16K | q4_0 | On |
| F | 32K | q4_0 | On |

## Prediction

The most likely first default is 8K context, q8_0 KV cache, Flash Attention enabled, one loaded model, and one inference request. The 16K profile may be viable depending on model architecture. The 32K profile is expected to have a higher risk of memory pressure.

## Deliverable

A measured `balanced-32gb` profile with documented backend requirements and known limitations.

## Optional Review Questions

Optional topics to review:

1. Why KV-cache quantization is primarily a memory-capacity optimization rather than a guaranteed decode-speed multiplier.
2. Why increasing context from 8K to 16K changes more than the number displayed in the CLI.

# Phase 3: Inference Scheduling

## Research Question

How should Demesne coordinate multiple sessions when only one large-model request safely fits the target hardware profile?

## Concepts To Learn

- Concurrency versus parallelism.
- Queues, fairness, and backpressure.
- Throughput versus per-request latency.
- Cancellation and resource ownership.
- Race conditions caused by shared mutable configuration.
- Why tools can run while the inference slot is released.

## Work

- Add a fair inference scheduler around provider streams.
- Default local profiles to one active inference slot.
- Record queue time separately from provider time.
- Support cancellation while waiting in the queue.
- Release the inference slot while tools execute.
- Snapshot the provider, model, profile, and thinking configuration at turn start.
- Prevent model changes from altering an active multi-round turn.
- Add concurrency, cancellation, and model-switch tests.

## Prediction

Single-user performance will remain similar. Concurrent-session stability and total throughput will improve because large requests will no longer compete unpredictably for unified memory.

## Deliverable

A tested scheduler with clear queue metrics and immutable per-turn inference configuration.

## Optional Review Questions

Optional topics to review:

1. Why two simultaneous generations can be slower overall than two queued generations on a memory-constrained machine.
2. Why the scheduler should release its model slot while Demesne is reading files or running tests.

# Phase 4: Proactive Context Planning

## Research Question

How can Demesne fit the most useful information into a limited context while preserving correctness and cache stability?

## Concepts To Learn

- Context capacity and output reservation.
- Exact token counting versus estimation.
- Stable prefixes and KV-cache reuse.
- Lossless reduction, deterministic compaction, summarization, and dropping history.
- Referential integrity between assistant tool calls and tool results.
- Soft, hard, and emergency context thresholds.

## Work

- Create a dedicated context planner called before every provider request.
- Determine capacity from discovered backend context and configured profile limits.
- Reserve space for model output, the next tool-result burst, and a safety margin.
- Include tool definitions in input estimates.
- Prefer backend-native token counting when available.
- Calibrate conservative estimates when exact counting is unavailable.
- Preserve the system prompt, tool definitions, current request, active tool calls, and matching results.
- Compact old tool output before removing conversational decisions.
- Remove duplicate historical file content.
- Persist structured summary checkpoints only when deterministic compaction is insufficient.
- Drop only complete old turns as a final planned reduction.
- Keep provider-overflow recovery as a final safety mechanism.

## Initial Budget Example

```text
Total context capacity:       8192
Reserved model output:       -1536
Reserved tool-result burst:   -768
Safety margin:                -512
Maximum planned input:        5376
```

The values are hypotheses and will be revised using measurements.

## Prediction

Long-session input should decrease by 20-50%, long-session TTFT should improve, and supported benchmark sessions should stop encountering provider context-overflow errors.

## Deliverable

A context plan for every request that records planned input, reserves, compaction actions, and actual provider usage.

## Optional Review Questions

Optional topics to review:

1. Why an 8K model cannot safely receive an 8K input prompt when it must still generate output and process tool results.
2. Why repeatedly rewriting old summaries can reduce KV-cache reuse even if the rewritten summary is shorter.

# Phase 5: Tool-Loop Efficiency

## Research Question

How can Demesne reduce expensive model rounds by making tool calls more informative, bounded, and safely parallel?

## Concepts To Learn

- Agent round trips and their cost.
- Tool side effects and concurrency safety.
- Byte limits versus token budgets.
- Structured outputs and continuation handles.
- Why permission requirements are not the same as read-only behavior.
- End-to-end optimization versus local micro-optimization.

## Work

- Give each tool an explicit effect category and concurrency policy.
- Run independent reads and searches through a bounded parallel pool.
- Keep edits, deletes, moves, commands, and process control appropriately serialized.
- Add model-facing token budgets distinct from durable storage limits.
- Return compact metadata that lets the model request more information deliberately.
- Preserve complete tool output in storage when useful without repeatedly sending it to the model.
- Measure duplicate reads, repeated searches, failed edits, and model rounds.
- Improve the system prompt only when evidence shows that tool behavior needs guidance.

## Prediction

Inspection-heavy tasks should use 10-30% fewer model rounds. Context growth from tools should fall substantially, while tool execution time itself will remain a relatively small part of most tasks.

## Deliverable

A typed tool-effect system, bounded concurrency, token-aware results, and task-level tool-efficiency metrics.

## Optional Review Questions

Optional topics to review:

1. Why two tools that require no approval are not necessarily safe to execute concurrently.
2. Why reducing one entire model round can matter more than making a filesystem check a few milliseconds faster.

# Phase 6: Daemon and Streaming Overhead

## Research Question

At what point does Demesne's own persistence and event streaming become a measurable bottleneck?

## Concepts To Learn

- Profiling before optimization.
- Event frequency and transaction overhead.
- Batching, buffering, and latency tradeoffs.
- Durability windows and crash recovery.
- Why an optimization can be correct but too small to justify its complexity.

## Work

- Measure SQLite transactions, SSE events, CPU use, and output-fragment sizes.
- Determine how much provider time is spent in persistence and rendering.
- Add bounded delta batching only if profiling shows a meaningful cost.
- Flush on a short time limit, byte limit, stream completion, or tool transition.
- Preserve separation between reasoning and visible output.
- Verify resumability and crash behavior after batching.

## Prediction

This phase will probably produce a small improvement at ordinary 8-15 tok/s generation rates. It may become more important if later decoding methods substantially increase event frequency.

## Deliverable

A profiling report and, only if justified, a tested bounded batching implementation.

## Optional Review Questions

Optional topics to review:

1. Why we measure SQLite and SSE overhead before changing their behavior.
2. What tradeoff exists between batching output and preserving immediate durability.

# Phase 7: Speculative Decoding

## Research Question

Can a compatible draft model increase effective target-model throughput on the available hardware without increasing memory risk or reducing agent quality?

## Concepts To Learn

- Autoregressive generation.
- Draft generation and target-model verification.
- Tokenizer and vocabulary compatibility.
- Acceptance rate.
- Why draft tokens are generated sequentially even when verification is batched.
- Why target verification is not necessarily equal in cost to one ordinary decode step.
- Extra model memory and its effect on a 32 GB system.

## Work

- Select a backend that exposes correct speculative decoding.
- Avoid implementing token verification through ordinary independent HTTP completions.
- Test same-family draft models where possible.
- Test several draft sizes and draft lengths.
- Measure acceptance rate, draft time, verification time, memory, and effective output rate.
- Test natural language, code, reasoning, and tool-call JSON separately.
- Compare task success and tool-call validity with the non-speculative baseline.
- Reject configurations that are faster only on synthetic text but worse on coding tasks.

## Initial Experiment Matrix

| Variable | Candidates |
| --- | --- |
| Draft size | Approximately 0.5B, 1.5B, and backend-recommended candidates |
| Draft length | 2, 4, 6, and 8 tokens |
| Output type | Natural language, source code, tool JSON, reasoning |
| Context | Short and long supported contexts |
| Thinking | Disabled and enabled where supported |

## Adoption Gate

Speculative decoding becomes part of a supported profile only if:

- Median effective decode throughput improves by at least 20%.
- Peak memory remains within the safe profile.
- No sustained swapping occurs.
- Coding-task success does not regress.
- Tool-call validity does not regress.
- P95 latency remains acceptable.

## Prediction

A compatible draft may produce a 1.2-1.8x decode improvement. A poorly matched draft may produce no improvement or make generation slower. A 2-3x result is an experimental possibility, not a project assumption.

## Deliverable

A reproducible speculative-decoding report and either a supported configuration or a documented negative result.

## Optional Review Questions

Optional topics to review:

1. Why the smallest and fastest available draft model is not automatically the best draft model.
2. Why acceptance rate and additional memory must be considered alongside tokens per second.

# Phase 8: Validation and Default Promotion

## Research Question

Which measured configurations are reliable enough to become product defaults?

## Concepts To Learn

- Statistical versus practical significance.
- Median behavior versus tail latency.
- Performance regressions and quality regressions.
- Reproducible release claims.
- Scope and external validity: what a result does and does not generalize to.

## Work

- Run the complete benchmark suite for every candidate default.
- Compare performance, memory, reliability, and quality with the original baseline.
- Repeat key experiments after backend or model upgrades.
- Document supported hardware, model, backend, context, and profile combinations.
- Publish exact limitations and unknowns.
- Promote only profiles that satisfy the predefined acceptance gates.
- Preserve benchmark artifacts used to support release claims.

## Prediction

The largest end-to-end improvement will likely come from combining several moderate improvements: stable runtime settings, one-slot scheduling, context reduction, and fewer agent rounds. No single optimization is expected to explain the entire gain.

## Deliverable

A defensible release profile and a report such as:

> On the tested 32 GB Apple Silicon system, Demesne's balanced profile runs the selected approximately 17 GB quantized model at an 8K context without sustained swap during the benchmark suite and reduces median coding-task completion time by a measured amount relative to the recorded baseline.

The measured amount will replace general claims only after experiments are complete.

## Optional Review Questions

Optional topics to review:

1. Why a result measured on one model and one Mac cannot automatically be claimed for every 32 GB computer.
2. Why a configuration with the highest decode speed may still be rejected as the default.

# Implementation Map

The likely code organization is:

| Location | Planned responsibility |
| --- | --- |
| `packages/protocol/` | Capability, profile, benchmark, and expanded metric contracts |
| `packages/providers/` | Capability discovery, request controls, token counting, and native timings |
| `apps/daemon/src/config.ts` | Validated runtime-profile configuration |
| `apps/daemon/src/inference-scheduler.ts` | Local inference queue, fairness, and cancellation |
| `apps/daemon/src/context-planner.ts` | Token budgets, compaction, and context plans |
| `apps/daemon/src/engine.ts` | Integration of scheduling, planning, tools, and metrics |
| `packages/storage/` | Benchmark, profile, metric, and checkpoint persistence |
| `apps/cli/` | `doctor`, `bench`, profile diagnostics, and expanded `/context` output |

Names may change if implementation evidence suggests a smaller or clearer design. We will prefer the smallest correct change rather than creating abstractions in advance.

# First Milestone Backlog

The first implementation milestone is measurement, not optimization.

| ID | Task | Status | Completion evidence |
| --- | --- | --- | --- |
| M0-01 | Capture exact hardware and backend environment | Complete | Phase 0 environment record |
| M0-02 | Identify exact model architecture and loaded footprint | Complete | Phase 0 model fingerprint |
| M0-03 | Define provider microbenchmark fixtures | Complete | `provider-throughput-v1` and benchmark tests |
| M0-04 | Define coding-agent benchmark fixtures | Complete | Versioned read-only diagnosis fixture and scoring |
| M0-05 | Add deterministic request controls | Complete | Output limit, temperature, and seed provider tests |
| M0-06 | Add expanded provider metrics | Not started | Storage and protocol tests |
| M0-07 | Add runtime fingerprints | Complete | Schema v3 machine, provider, model, context, memory, backend, and power metadata |
| M0-08 | Implement `demesne doctor` | Not started | CLI test and real output |
| M0-09 | Implement `demesne bench` | In progress | Direct `bench:ollama` runner exists; CLI integration remains |
| M0-10 | Record the unoptimized baseline | In progress | Provider baseline recorded; native timing and agent baseline remain |
| M0-11 | Record Phase 0 conceptual review | Complete | Student explanation recorded in Phase 0 working record |
| M0-12 | Record Phase 1 conceptual review | Complete | Student explanation recorded in Phase 1 working record |

# Decision Rules

We will use these rules throughout the project:

1. Do not optimize an unmeasured bottleneck.
2. Change one major experimental variable at a time.
3. Keep cold and warm inference results separate.
4. Do not report the best run as typical performance.
5. Record exact backend, model, context, and profile configuration.
6. Treat provider-reported values as exact only when their meaning is documented.
7. Label estimates as estimates.
8. Preserve agent quality while improving speed.
9. Prefer end-to-end task improvement over isolated microbenchmark gains.
10. Do not progress past a phase while its core concept remains unclear.

# Research Log Template

Each experiment will use a short record:

```markdown
## Experiment ID and Title

### Question
What are we trying to learn?

### Hypothesis
What do we predict before running the experiment?

### Configuration
Hardware, backend, model, profile, context, and source revision.

### Controlled Variables
What remains unchanged?

### Independent Variable
What are we changing?

### Measurements
Raw and summarized results.

### Interpretation
Why do we think the result occurred?

### Limitations
What does the experiment not prove?

### Decision
Adopt, reject, repeat, or redesign.

### Learning Check
The one or two concepts that should now be explainable.
```

# Phase 0 Working Record

## Record Date

2026-08-26

## Sanitized Hardware Profile

Sensitive machine identifiers were observed by the operating-system command but are deliberately excluded from this record.

| Property | Observed value | Evidence |
| --- | --- | --- |
| Machine | MacBook Pro, `MacBookPro18,2` | `system_profiler SPHardwareDataType` |
| Chip | Apple M1 Max | `system_profiler SPHardwareDataType` |
| CPU | 10 cores: 8 performance and 2 efficiency | `system_profiler SPHardwareDataType` |
| GPU | 24 cores, Metal 4 support | `system_profiler SPDisplaysDataType` |
| Unified memory | 32 GiB, 34,359,738,368 bytes | `system_profiler` and `sysctl -n hw.memsize` |
| Published chip bandwidth | 400 GB/s | M1 Max hardware specification; not measured by this experiment |
| Operating system | macOS 26.5.2, build 25F84 | `sw_vers` |

## Backend Profile

| Property | Observed value | Evidence |
| --- | --- | --- |
| Backend | Ollama 0.32.15 | `ollama --version` |
| Service | Homebrew user service | `brew services info ollama` |
| Model placement | 100% GPU | `ollama ps` |
| Runtime context | 8,192 tokens | `ollama ps` and active runner arguments |
| Parallel sequences | 1 | active runner argument `-np 1` |
| Flash Attention | Enabled | active runner argument `--flash-attn on` |
| Key cache | q8_0 | active runner argument `--cache-type-k q8_0` |
| Value cache | q8_0 | active runner argument `--cache-type-v q8_0` |
| Speculation | MTP draft, maximum 4 draft tokens | active runner arguments and model parameter |
| Batch sizes | 512 logical and 512 physical | active runner arguments `-b 512 -ub 512` |

The relevant Ollama variables were not present in the user's `launchctl` environment. The active runner arguments are therefore the stronger evidence for the settings actually used by this model process.

## Target Model Fingerprint

The student selected `qwen3.8:latest` as the primary boundary model.

| Property | Observed value |
| --- | --- |
| Ollama model ID | `22130167c4c2` |
| Reported architecture | `qwen35` |
| Language-model parameters | 27.3B |
| Maximum declared context | 262,144 tokens |
| Embedding length | 5,120 |
| Weight quantization | Q4_K_M |
| Vision projector | CLIP, 460.73M parameters |
| Disk size reported by `ollama list` | 17 GB |
| Loaded size reported by `ollama ps` | 18 GB |
| Runner resident set after load | 19,010,576 KiB, approximately 18.13 GiB |
| Capabilities | Completion, vision, tools, and thinking |
| Required Ollama version | 0.32.12 or later |
| Model draft setting | `draft_num_predict 4` |

The 17 GB disk size, 18 GB loaded size, and approximately 18.13 GiB process resident set demonstrate why model file size and runtime memory use must not be treated as identical quantities.

## Residency Observation

This was an environment-characterization observation, not the formal Phase 1 benchmark.

### Initial Idle State

| Measurement | Observed value |
| --- | ---: |
| Loaded Ollama models | 0 |
| Memory free percentage reported by `memory_pressure -Q` | 90% |
| Swap allocated | 5,120.00 MiB |
| Swap used | 3,674.44 MiB |
| `vm_stat` page-outs | 833,712 pages |
| `vm_stat` swap-outs | 942,129 pages |

Existing swap use is historical system state. It does not by itself prove that the model experiment is currently swapping. Deltas in swap use and the cumulative swap-out counter are more useful for this experiment.

### Cold Load Request

The request used an 8,192-token runtime context, disabled thinking, limited output to 16 tokens, requested temperature zero, and retained the model for ten minutes.

| Measurement | Observed value |
| --- | ---: |
| Total request duration | 14.550 s |
| Model load duration | 13.440 s |
| Prompt tokens | 17 |
| Prompt evaluation duration | 0.798 s |
| Output tokens | 2 |
| Output evaluation duration | 0.311 s |

The two-token output is too short for a trustworthy decode-throughput measurement.

After the cold load:

| Measurement | Observed value |
| --- | ---: |
| Loaded model size | 18 GB |
| Processor placement | 100% GPU |
| Memory free percentage | 24% |
| Swap used | 3,674.44 MiB |
| Swap-use delta | 0 MiB |
| Swap-out counter delta | 0 pages |
| Ordinary page-out delta | 185 pages, approximately 2.89 MiB |

### Warm Generation Observation

The second request reused the resident model, retained the same 8,192-token context, disabled thinking, limited output to 128 tokens, and requested temperature zero.

| Measurement | Observed value |
| --- | ---: |
| Total request duration | 12.110 s |
| Load duration | 0.0027 s |
| Prompt tokens | 30 |
| Prompt evaluation duration | 0.712 s |
| Output tokens | 96 |
| Output evaluation duration | 11.335 s |
| Single-observation decode rate | Approximately 8.47 tok/s |
| Memory free percentage after request | 24% |
| Swap-use delta from idle observation | 0 MiB |
| Swap-out counter delta from idle observation | 0 pages |
| Total ordinary page-out delta from idle observation | 350 pages, approximately 5.47 MiB |

The decode calculation is:

```text
96 output tokens / 11.334785 seconds = 8.47 tokens/second
```

This value is an observation from one short run, not a baseline distribution. Phase 1 will repeat controlled runs and report their median and variability.

## Initial Interpretation

### Facts

- The target model fits at an 8K runtime context and remains fully GPU-resident.
- The loaded model consumes more memory than its reported 17 GB disk size.
- Loading the model reduces reported available memory from 90% to 24%.
- No swap-use or swap-out increase was observed during these two requests.
- Ollama already enables q8_0 KV caches, Flash Attention, one parallel sequence, and MTP speculation for this model.
- The first warm decode observation is approximately 8.47 tok/s.

### Interpretations

- The 8K configuration appears tight but stable during a short observation.
- Existing swap allocation came from earlier system activity and must not be attributed to this experiment.
- The large cold-versus-warm difference is dominated by the 13.44-second model load.
- Because speculation is already enabled, later speculative-decoding research needs a controlled on/off comparison.
- The target model's declared 262K context is not evidence that a 262K runtime allocation is safe on this 32 GiB machine.

### Unknowns

- Peak memory during generation was not sampled continuously.
- The q8_0 KV footprint at 8K has not yet been isolated from weights and other buffers.
- Formal warm TTFT, prefill rate, decode rate, variance, and tail latency are not yet measured.
- MTP draft acceptance rate was not exposed by the observed API response.
- Coding-task quality and tool-call validity have not yet been benchmarked.
- The current `daemon:ollama` script still selects `qwen3:14b`; it is not yet aligned with the chosen boundary target.

## Phase 0 Decision So Far

Keep the primary target at an 8,192-token runtime context for the initial benchmark. Do not change KV precision, Flash Attention, inference concurrency, or speculation before recording a repeatable baseline, because the active runtime already applies all four behaviors.

## Phase 0 Review Result

Completed on 2026-08-26.

The student explained that the runtime requires memory beyond the stored model size and that the bandwidth-to-weight calculation estimates an upper bound rather than observed throughput. The discussion added that the difference is caused not only by competing bandwidth consumers, but also by peak-versus-sustained bandwidth and work omitted by the approximation, including quantization, KV-cache access, attention, kernel dispatch, sampling, and speculative verification.

Phase 0 is complete. Phase 1 may proceed.

# Phase 1 Working Record

## Measurement Contract

The first microbenchmark isolates the model provider from the agent loop.

| Experimental role | Current definition |
| --- | --- |
| Research question | What warm request latency and output throughput does the current Ollama configuration produce? |
| Controlled prompt | `provider-throughput-v1` |
| Controlled output | Maximum 128 tokens |
| Controlled sampling | Temperature 0 and seed 42 |
| Controlled reasoning | Thinking requested off and reasoning effort `none` |
| Warm-up count | 1 |
| Measured repetitions | 5 |
| Independent state | Cold first load followed by warm resident requests |
| Dependent measurements | Request duration, first-output time, output usage, and output-rate estimates |

The benchmark stores warm-up observations but excludes them from the measured median. A warm-up observation is not automatically cold; the corrected baseline explicitly unloaded the model before execution.

## Implementation Record

The first Phase 1 implementation added:

- `maxOutputTokens`, `temperature`, and `seed` to the provider request contract.
- OpenAI-compatible serialization using `max_tokens`, `temperature`, and `seed`.
- Provider serialization tests for the controls.
- A testable direct provider benchmark in `apps/daemon/src/provider-benchmark.ts`.
- Warm-up and measured observation separation.
- A versioned JSON report with controlled inputs and raw observations.
- Median summaries that exclude warm-up observations.
- Pre-run and post-run model descriptors so declared context and runtime context are not confused.
- Private report persistence under `~/.demesne/benchmarks/`.
- Root scripts `bench:provider` and `bench:ollama`.

The report schema was increased from version 1 to version 2 after the first run revealed that pre-load model discovery reported the declared 262K capacity while the actual loaded runner used 32K. The original schema version 1 artifact was preserved as evidence of the discovery rather than silently rewritten.

## Context-Control Finding

The initial Phase 0 request used Ollama's native generation API and explicitly selected an 8K context. The OpenAI-compatible benchmark did not inherit that context after the model was unloaded. Ollama loaded a new runner at 32K.

Two attempted OpenAI-compatible context controls were ignored by this Ollama version:

```json
{"options":{"num_ctx":8192}}
```

and:

```json
{"num_ctx":8192}
```

The runtime remained at 32,768 tokens after both requests. Therefore, the provider benchmark does not claim to control context through unsupported request fields. The current backend default is measured as it exists. An explicit 8K comparison will be created later through a verified Ollama service or model configuration.

## First Corrected Provider Baseline

Raw report:

```text
~/.demesne/benchmarks/provider-2026-08-27T03-10-40.204Z.json
```

### Configuration

| Property | Value |
| --- | --- |
| Report schema | 2 |
| Model | `qwen3.8:latest` |
| Provider | Ollama through the OpenAI-compatible API |
| Pre-run discovered context | 262,144 declared tokens |
| Post-load runtime context | 32,768 tokens |
| Maximum output | 128 tokens |
| Prompt tokens | 38 |
| Thinking | Requested off |
| Temperature | 0 |
| Seed | 42 |
| Warm-up observations | 1, explicitly cold for this run |
| Measured warm observations | 5 |

### Cold Warm-up Observation

| Measurement | Value |
| --- | ---: |
| Total request duration | 29.341 s |
| Time to first visible output | 15.624 s |
| Post-first-output window | 13.718 s |
| Output tokens | 128 |
| End-to-end output rate | 4.36 tok/s |
| Post-first-output rate estimate | 9.26 tok/s |

The cold end-to-end rate is low because it includes model loading. It must not be compared directly with warm decode behavior.

### Warm Measured Summary

| Measurement | Median | Observed range |
| --- | ---: | ---: |
| Request duration | 13.975 s | 13.967-14.009 s |
| Time to first visible output | 0.240 s | 0.237-0.278 s |
| End-to-end output rate | 9.16 tok/s | 9.14-9.16 tok/s |
| Post-first-output rate estimate | 9.25 tok/s | 9.25-9.25 tok/s |
| Output tokens | 128 | 128 in every run |
| Output characters | 787 | 787 in every run |

The request-duration range is approximately 42 ms, or about 0.3% of the median. The identical token and character counts indicate that the current deterministic controls produced repeatable output for this fixture.

### Memory Before and After Corrected Run

| Measurement | Before cold load | After benchmark | Delta |
| --- | ---: | ---: | ---: |
| Memory free percentage | 81% | 21% | -60 percentage points |
| Swap used | 3,546.44 MiB | 3,546.44 MiB | 0 MiB |
| Cumulative swap-outs | 942,129 pages | 942,129 pages | 0 pages |
| Cumulative ordinary page-outs | 837,763 pages | 837,784 pages | 21 pages, approximately 0.33 MiB |

The model was reported as 18 GB, 100% GPU-resident, with a 32K context after the run. This short baseline did not produce new swap traffic, but the 21% memory-availability result shows less headroom than the 8K Phase 0 observation.

## First Baseline Interpretation

### Facts

- The provider benchmark is repeatable for the current short fixture.
- Ollama's OpenAI-compatible route loads this model with a 32K runtime context under the current service configuration.
- The median warm request produces 128 output tokens in approximately 13.98 seconds.
- The provider-reported usage is stable across all measured requests.
- No swap-use or swap-out increase was observed during the corrected run.

### Interpretations

- The current warm generation rate is close to 9.2 tok/s for this fixture and runtime state.
- The 32K context allocation consumes additional headroom even though this short prompt uses only 38 input tokens, because the runtime reserves KV capacity according to its configured context.
- Deterministic controls materially reduce response-length and sampling variability.
- Runtime context must be observed after loading; declared model capacity is not runtime allocation.

### Limitations

- The post-first-output rate is an estimate from wall time, not Ollama's native `eval_duration`.
- Prompt prefill is too small in this fixture to characterize long-prompt performance.
- Memory was sampled before and after, not continuously, so peak memory remains unknown.
- Backend version and active runner flags are documented in Phase 0 but not yet embedded in the JSON fingerprint.
- The benchmark does not yet automate a verified cold state.
- This benchmark does not measure tools, multiple model rounds, coding correctness, or task completion.
- The repository-wide typecheck currently has unrelated pre-existing errors in `apps/cli/src/main.ts` and `apps/daemon/src/app.ts`; targeted tests for the new benchmark and provider controls pass.

## Phase 1 Next Decision

Retain this provider baseline and next add the missing runtime fingerprint and memory observations. After that, add native Ollama timing where it can be obtained without weakening provider neutrality, then design the full coding-agent fixture set.

## Native Timing and Power-State Finding

Ollama's OpenAI-compatible stream reports token usage but does not report native `prompt_eval_duration` or `eval_duration`. Native timing was therefore implemented as a separate instrument using `/api/generate`. Results from the native and provider paths remain separate rather than being merged as if API path were controlled.

The first native 32K run produced:

```text
~/.demesne/benchmarks/ollama-native-2026-08-27T10-27-54.445Z.json
```

| Measurement | Native median |
| --- | ---: |
| Client request duration | 23.13 s |
| Native prompt processing | 95.77 tok/s |
| Native decode | 5.63 tok/s |
| Output tokens | 128 per measured run |
| Runtime context | 32,768 |

This was unexpectedly slower than the earlier provider baseline near 9.16 tok/s. An immediate provider-path rerun also fell to approximately 5.41 tok/s, showing that the native API path was not sufficient to explain the difference.

The machine was then observed on battery power. Its raw active battery `powermode` value was `1`, while its configured AC `powermode` value was `2`. The earlier 9.16 tok/s artifact did not capture power state, so power source is a leading hypothesis rather than an established cause.

Benchmark schemas were revised to record power source, battery percentage and status, and raw current, battery, and AC power-mode values before and after every run. Numeric power-mode values are preserved as observations without assigning semantic labels that have not yet been verified.

### Controlled Battery-State Provider Baseline

```text
~/.demesne/benchmarks/provider-2026-08-27T10-35-28.117Z.json
```

| Property | Value |
| --- | --- |
| Source before and after | Battery |
| Battery percentage | 67% before, 64% after |
| Battery status | Discharging |
| Raw current power mode | 1 |
| Runtime context | 32,768 |
| Prompt and output | 38 input, 128 output tokens |
| Measured repetitions | 5 |
| Median request duration | 23.27 s |
| Median first visible output | 0.47 s |
| Median end-to-end output | 5.50 tok/s |
| Median post-first-output estimate | 5.57 tok/s |
| Swap-use delta | 0 MiB |
| Swap-out delta | 0 bytes |

The matched AC experiment has not yet been run. Until it is, we cannot conclude that AC power or raw power mode `2` caused the earlier higher throughput.

### Matched AC-Power Comparison

Completed on 2026-08-27 after AC power became available.

The cleanest provider comparison used a model already resident at 32K in both conditions. Model, backend, prompt, output limit, temperature, seed, reasoning selection, context, warm-up count, measured repetitions, and residency were held constant. The observed power source and raw power-mode value changed.

AC provider artifact:

```text
~/.demesne/benchmarks/provider-2026-08-27T22-17-20.291Z.json
```

| Provider measurement | Battery, raw mode 1 | AC, raw mode 2 | Observed change |
| --- | ---: | ---: | ---: |
| Median request duration | 23.27 s | 14.08 s | Approximately 39.5% lower |
| Median first output | 0.47 s | 0.24 s | Approximately 48% lower |
| Median end-to-end output | 5.50 tok/s | 9.09 tok/s | Approximately 65% higher |
| Median post-first-output estimate | 5.57 tok/s | 9.18 tok/s | Approximately 65% higher |

The native Ollama instrument independently showed the same direction.

AC native artifact:

```text
~/.demesne/benchmarks/ollama-native-2026-08-27T22-19-04.246Z.json
```

| Native measurement | Battery, raw mode 1 | AC, raw mode 2 | Observed change |
| --- | ---: | ---: | ---: |
| Median client request | 23.13 s | 14.06 s | Approximately 39% lower |
| Median prompt processing | 95.77 tok/s | 160.85 tok/s | Approximately 68% higher |
| Median native decode | 5.63 tok/s | 9.27 tok/s | Approximately 64.5% higher |

Both instruments support the conclusion that the observed AC power-policy condition materially improves this model's throughput on this machine. The result does not prove the same percentage for other Apple chips, models, battery levels, macOS versions, or power configurations. The experiments were run at different times rather than in a randomized alternating sequence, and privileged GPU frequency and power telemetry was not collected.

### AC Cold-Load Memory Finding

An AC run that began with no model resident loaded the 32K runner and produced:

```text
~/.demesne/benchmarks/provider-2026-08-27T22-15-13.130Z.json
```

| Measurement | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Reported memory availability | 88% | 14% | -74 percentage points |
| Swap used | Approximately 2.02 GiB | Approximately 3.34 GiB | Approximately +1.32 GiB |
| Cumulative swap-outs | 972,371 pages | 1,065,035 pages | Approximately +1.41 GiB |
| Ordinary page-outs | 853,559 pages | 854,259 pages | Approximately +10.94 MiB |

The five measured warm requests still sustained approximately 9.10 tok/s. This indicates that macOS may have displaced other memory while preserving model throughput. It does not make the swap activity acceptable for the target profile: Demesne aims to coexist with a normal development environment, not obtain speed by forcing unrelated application memory into swap.

The immediately repeated resident AC provider run showed less stable swap accounting: swap use decreased while the cumulative swap-out counter still increased. A subsequent resident native run showed no additional page-outs or swap-outs. This demonstrates why a single swap-use snapshot is insufficient and why cumulative counters, load state, and repeated observations must be considered together.

### Power Comparison Decision

Use AC power with raw mode `2` as the controlled condition for Phase 2 performance experiments. Keep the battery result as a product-relevant secondary profile because local users may operate unplugged. Treat the current 32K cold-load swap activity as evidence that reducing runtime context is a high-priority Phase 2 experiment.

### Research Lesson

Machine power state is an experimental control for local inference. A benchmark can hold model, prompt, context, and sampling constant while still produce a large unexplained difference if power source and performance policy are omitted. The correct response is to improve the fingerprint and repeat a matched experiment, not to select the faster historical number.

## Phase 1 Measurement-Model Checkpoint

Completed on 2026-08-26.

The student identified context length as the independent variable in an 8K-versus-32K experiment and identified the machine, model, temperature, and output limit as controls. The student also explained that the single 32-token validation result cannot establish an improvement over the five-run 128-token baseline because output length changes the influence of fixed costs and one observation does not characterize variability, a median, or a range.

This intermediate review is complete. Native timing and coding-agent baseline work may proceed independently of conceptual review.

## First Coding-Agent Baseline

The first coding-agent fixture measures the complete Demesne loop rather than isolated generation. It creates an isolated temporary TypeScript workspace containing this intentional defect:

```ts
export function calculateTotal(prices: number[]): number {
  return prices.reduce((total, price) => total - price, 0);
}
```

The model must use `read_file`, identify subtraction as the bug, emit a fixed correctness marker, and leave the workspace unchanged. The harness uses a private temporary database and daemon, so it does not alter the active Demesne daemon, project workspace, or user sessions.

The first real attempt revealed that Bun's default ten-second idle timeout was shorter than both the daemon's heartbeat interval and the model's first output under the observed battery state. The temporary benchmark server was corrected to allow long idle inference without changing the production daemon.

The first successful cold observation completed correctly in 79.40 seconds. Because it started with no loaded runtime and used the initial report schema, it remains a cold observation rather than part of the warm median.

Per-provider-call reporting was then added using persisted `providerCallId` values. The report now separates model rounds instead of presenting only turn-level totals.

The harness initially created a different random workspace path for every repetition. Demesne includes the workspace path in its system prompt, so that changed the model input by one or two tokens and changed the cacheable prefix. Report schema 3 reuses one isolated workspace and daemon across repetitions while resetting the fixture file before every run.

### Stable Warm Agent Artifact

```text
~/.demesne/benchmarks/agent-2026-08-27T10-58-17.264Z.json
```

| Property | Value |
| --- | --- |
| Fixture | `read-only-arithmetic-diagnosis-v1` |
| Runtime context | 32,768 before and after |
| Power source | Battery |
| Battery percentage | 51% before, 48% after |
| Raw current power mode | 1 |
| Warm-up runs | 1 |
| Measured runs | 3 |
| Successful runs | 3/3 |
| Measured duration range | 39.21-40.22 s |
| Median task duration | 39.71 s |
| Model rounds | 2 every run |
| Tool calls | 1 `read_file` every run |
| Input tokens | 3,606 every run |
| Output tokens | 189 every run |
| Workspace changes | None |
| Swap-use delta | 0 MiB |
| Swap-out delta | 0 bytes |

### Per-Round Decomposition

| Round | Purpose | Input tokens | Output tokens | Median duration | Median first output |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Select and emit `read_file` | 1,743 | 29 | 15.56 s | 15.56 s |
| 2 | Process tool result and answer | 1,863 | 160 | 24.15 s | 2.35 s |

Round 1's first emitted event is the tool call. The provider may buffer a structured call until enough of it is complete, so this metric is correctly interpreted as time to first emitted output rather than proof of first-token generation time.

The task duration and summed provider durations differ by only a few milliseconds. In this fixture, model processing dominates end-to-end time. Making the local file read a few milliseconds faster would not materially affect the approximately 40-second result. Reducing prompt/tool-schema input, reducing output, improving model throughput, or avoiding a model round would have much greater potential impact.

### Quality Scope

The 3/3 result establishes repeatability only for one deliberately simple read-only diagnosis fixture. It does not establish general coding-agent quality, editing ability, command execution, test repair, or long-session performance. Additional fixture classes remain future work, but this first fixture is sufficient to prove and validate the end-to-end benchmark harness.

### Cold Versus Warm Scope

The cold observation was approximately 79.40 seconds and the stable warm median was approximately 39.71 seconds. This strongly suggests residency and first-run initialization matter, but the artifacts also differ by report schema and harness improvements. A future dedicated cold-versus-warm agent experiment should automate residency state and use one unchanged schema before making a precise percentage claim.

## Final Phase 1 Review

Completed on 2026-08-26.

The student explained that cold and warm results must remain separate because they represent different operating conditions. The student also explained that accelerating a millisecond-scale file read has little effect on a task dominated by model processing, while eliminating an unnecessary model round avoids another large input, generated output, and inference delay.

Phase 1's measurement-foundation gate is complete. Phase 2 remains blocked on a controlled power condition, not on conceptual understanding.

## Phase 2 Opening Checkpoint

Completed on 2026-08-27.

The student explained that a 32K allocation creates more memory pressure than 8K because the runtime reserves greater context and KV-cache capacity even when the current prompt is short. The student also explained that reducing context should lower resource consumption but may not substantially increase decode speed because processing the large model weights remains dominant.

The controlled 8K-versus-32K experiment may proceed on AC power with raw mode `2`.

# Phase 2 Working Record

## Verified 8K Context Control

Ollama 0.32.15 ignored per-request `num_ctx` fields sent through its OpenAI-compatible route. Preloading the base model through the native API at 8K also failed to control the provider path: the provider request replaced that runner with its 32K default.

The reproducible control is an Ollama model alias whose Modelfile inherits the same weights and sets the runtime parameter:

```text
FROM qwen3.8:latest
PARAMETER num_ctx 8192
```

This profile is defined in `experiments/ollama/qwen3.8-8k.Modelfile` and was created as `qwen3.8-8k:latest`. The alias shares the base model's weight layers rather than copying approximately 17 GB of weights. Both `ollama ps` and the benchmark's post-load discovery confirmed an 8,192-token runtime context and 100% GPU placement.

## Controlled 8K and 32K Microbenchmarks

These experiments used AC power with raw mode `2`, the same model weights, q8_0 KV caches, Flash Attention, one inference sequence, fixed prompts and outputs, temperature 0, and seed 42.

| Measurement | 32K | 8K | Observed change at 8K |
| --- | ---: | ---: | ---: |
| Provider median output rate | 9.09 tok/s | 9.14 tok/s | Approximately +0.6% |
| Native prompt processing | 160.85 tok/s | 161.17 tok/s | Approximately +0.2% |
| Native decode | 9.27 tok/s | 9.33 tok/s | Approximately +0.6% |

Artifacts:

```text
~/.demesne/benchmarks/provider-2026-08-27T22-17-20.291Z.json
~/.demesne/benchmarks/ollama-native-2026-08-27T22-19-04.246Z.json
~/.demesne/benchmarks/provider-2026-08-27T23-00-30.506Z.json
~/.demesne/benchmarks/ollama-native-2026-08-27T22-55-33.593Z.json
```

The throughput differences are too small to support a claim that reducing context materially accelerates short decode. This matches the Phase 2 prediction: the model still reads approximately the same large weight set for every generated token.

The 8K native run ended with 29% memory availability and produced no new page-outs or swap-outs. The earlier cold 32K load ended with 14% availability and approximately 1.32 GiB of additional swap use. These runs began from different memory states, so they do not quantify an exact context-only memory delta. They do establish that the 8K runner operates safely in a state where the 32K cold load had displaced substantial memory.

## Agent Result and Batch-Size Confound

The first end-to-end agent comparison appeared to show a large 32K advantage:

| Profile | Runtime batch | Median task duration | Success |
| --- | ---: | ---: | ---: |
| 8K alias, first run | 1,024 | 28.24 s | 3/3 |
| 32K base model | 512 | 22.49 s | 3/3 |
| 8K alias, repeated A-B-A run | 1,024 | 28.59 s | 3/3 |

Artifacts:

```text
~/.demesne/benchmarks/agent-2026-08-27T23-02-29.902Z.json
~/.demesne/benchmarks/agent-2026-08-27T23-05-06.682Z.json
~/.demesne/benchmarks/agent-2026-08-27T23-07-29.662Z.json
```

The A-B-A sequence reproduced the difference, ruling out simple run order as its explanation. Per-round decomposition showed that the final-answer round remained close to 15 seconds. The difference came from the prefill-heavy tool-selection round: median first emitted output was approximately 13.39 seconds at 8K and batch 1,024, versus 7.63 seconds at 32K and batch 512.

Inspection of the generated runner commands revealed the confound. Ollama automatically selected physical and logical batches of 1,024 at 8K but 512 at 32K. Context capacity was therefore not the only independent variable.

## Matched-Batch Agent Experiment

A second alias explicitly controls both context and batch:

```text
FROM qwen3.8:latest
PARAMETER num_ctx 8192
PARAMETER num_batch 512
```

It is defined in `experiments/ollama/qwen3.8-8k-b512.Modelfile` and created as `qwen3.8-8k-b512:latest`. Runtime inspection confirmed `-c 8192`, `-b 512`, and `-ub 512`.

Matched 8K artifact:

```text
~/.demesne/benchmarks/agent-2026-08-27T23-11-37.366Z.json
```

| Agent measurement | 32K, batch 512 | 8K, batch 512 |
| --- | ---: | ---: |
| Successful runs | 3/3 | 3/3 |
| Median task duration | 22.492 s | 22.494 s |
| Median tool-selection round | 7.629 s | 7.635 s |
| Median final-answer round | 14.860 s | 14.858 s |
| Model rounds | 2 | 2 |
| Tool calls | 1 | 1 |
| Output tokens | 189 | 189 |
| Swap-use delta | 0 | 0 |
| Swap-out delta | 0 | 0 |

The two matched-batch task medians differ by approximately 2 ms, which is operationally identical. Compared with the repeated automatic-batch 8K result, explicit batch 512 reduced median task time from 28.59 to 22.49 seconds, approximately 21.3%. Tool-selection latency fell approximately 43.0% while task correctness, output, tool use, and final-answer latency remained stable.

## Interpretation and Decision So Far

The apparent 32K speed advantage was a batch-configuration effect, not a context-capacity advantage. On this M1 Max, model, backend version, and fixture, batch 512 completes the approximately 1,743-token chat/tool-selection request substantially faster than batch 1,024. The short provider and native decode benchmarks did not reveal this because their input prompt contained only 38 tokens and decode dominated their runtime.

## Long-Prompt Native Check

The native harness now supports deterministic prefill fixtures through `DEMESNE_BENCHMARK_PROMPT_BLOCKS`. Zero blocks preserves the original throughput fixture. A positive count generates numbered measurement records and includes the count in the fixture ID. This preserves the full generated prompt in the report while allowing the same prompt shape to be reproduced.

A 64-block fixture produced 2,205 input tokens. It was tested at 8K with batch 1,024, 8K with batch 512, and 32K with batch 512.

| Native long-prompt measurement | 8K, batch 1,024 | 8K, batch 512 | 32K, batch 512 |
| --- | ---: | ---: | ---: |
| Empty-cache prompt evaluation | 22.955 s | 22.928 s | 22.931 s |
| Empty-cache prompt rate | 96.06 tok/s | 96.17 tok/s | 96.16 tok/s |
| Repeated-prefix median request | 0.646 s | 0.644 s | 0.638 s |
| Repeated-prefix reported prompt rate | 8,087.59 tok/s | 8,086.64 tok/s | 8,120.47 tok/s |

Artifacts:

```text
~/.demesne/benchmarks/ollama-native-2026-08-27T23-18-27.304Z.json
~/.demesne/benchmarks/ollama-native-2026-08-27T23-16-43.477Z.json
~/.demesne/benchmarks/ollama-native-2026-08-27T23-17-15.868Z.json
```

The empty-cache prompt observations use Ollama's native `prompt_eval_duration`, which excludes the separately reported model-load duration. The repeated-prefix rate is not a physical full-prefill throughput measurement: Ollama reports the full logical prompt count while evaluating only the uncached remainder and cache bookkeeping. It instead characterizes the latency of a request with nearly complete prefix reuse.

This check does not show a general raw-prefill advantage for batch 512. All three configurations processed the uncached 2,205-token prompt at approximately 96.1 tok/s and reused the repeated prefix in approximately 0.64 seconds. The batch-512 benefit is currently established only for the OpenAI-compatible chat/tool-selection path or its partial KV-cache reuse pattern. That narrower claim replaces the earlier possible interpretation that batch 512 generally accelerates long-prompt prefill.

## Expanded Agent Fixtures

The agent report schema is now version 4. The harness supports fixture definitions with initial and expected file sets, required tools, permission policy, permitted write paths, permitted exact commands, and an optional requirement for a successful command result. Each repetition rebuilds the workspace and validates both file contents and the complete file list, so an expected edit accompanied by an unrelated file does not pass.

Two fixtures were added:

| Fixture | Required behavior | Success validation |
| --- | --- | --- |
| `single-file-greeting-edit-v1` | Read one TypeScript file, replace final punctuation using `edit_file`, and verify | Exact expected source, no extra files, required tools, fixed marker |
| `failed-test-arithmetic-repair-v1` | Run a failing test, inspect evidence, edit only source, rerun tests | Exact repaired source, unchanged test and package files, successful command, required tools, fixed marker |

Editing fixtures use the normal `ask` permission mode. The benchmark automatically approves only fixture-declared operations. The greeting fixture permits `edit_file` only for `src/greeting.ts`. The repair fixture permits `edit_file` only for `src/calculate-total.ts` and `run_command` only for the exact argument vector `["bun", "test"]`. Every other write or command request is denied. A negative test confirms that an attempted write outside the allowlist cannot modify the workspace or score as successful.

The implementation and validation changes increased the repository test result to 96 passing tests. The known repository-wide typecheck failures in `apps/cli/src/main.ts` and `apps/daemon/src/app.ts` remain unchanged.

## Stable System-Prompt Control

The original schema-3 harness reused one temporary workspace within a report but generated a different random path for each benchmark invocation. Because the production system prompt includes the absolute workspace path, cross-profile requests could differ by one or more tokens. In an initial failed-test comparison, that small change altered greedy tool selection: one profile used five tools while the other sometimes used six.

Schema 4 retains the production system prompt wording but substitutes the fixed logical path `/benchmark/workspace`. Tools still operate against the isolated real temporary workspace because model-facing paths are relative. The report records the logical path. This removes random path text from cross-run comparisons without weakening workspace isolation.

This is an important quality finding: temperature zero and a fixed seed do not make two requests equivalent when any prompt token differs. Small prompt changes can alter a tool decision and add an entire model round or tool call. Configuration fingerprints must therefore cover generated system-prompt content, not only the user prompt.

## Stable-Prompt Agent Matrix

All experiments below used AC power with raw mode `2`, q8_0 KV caches, Flash Attention, batch 512, one inference sequence, one warm-up, three measured runs, temperature 0, seed 42, and the fixed logical workspace path.

| Fixture | 8K median | 32K median | 8K change | Success at both | Rounds | Tools |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Read-only diagnosis | 29.623 s | 29.845 s | Approximately 0.7% faster | 3/3 | 2 | 1 |
| Single-file edit | 22.670 s | 22.433 s | Approximately 1.1% slower | 3/3 | 4 | 3 |
| Failed-test repair | 40.093 s | 39.434 s | Approximately 1.7% slower | 3/3 | 5 | 6 |

8K artifacts:

```text
~/.demesne/benchmarks/agent-2026-08-27T23-50-49.286Z.json
~/.demesne/benchmarks/agent-2026-08-27T23-45-26.871Z.json
~/.demesne/benchmarks/agent-2026-08-27T23-47-30.090Z.json
```

32K artifacts:

```text
~/.demesne/benchmarks/agent-2026-08-27T23-52-52.858Z.json
~/.demesne/benchmarks/agent-2026-08-27T23-40-59.959Z.json
~/.demesne/benchmarks/agent-2026-08-27T23-42-34.793Z.json
```

The profiles produced identical read/edit/test behavior and exact output-token counts for the read-only and editing fixtures. Repair tool output includes measured test timing text, producing a four-token cumulative input difference, but tool order and output behavior remained stable. No task had a context-overflow failure.

The read-only pair began at 29% available memory. The resident 8K run ended at 28%, generated approximately 0.14 MiB of page-outs, and generated no swap-outs. Switching to and running 32K ended at 20%, generated approximately 20.23 MiB of page-outs, and generated no swap-outs. This is not a randomized memory experiment, but its direction agrees with the earlier cold-load evidence that 8K retains more system headroom.

Across these three short fixtures, context capacity does not produce a practically meaningful task-speed advantage when batch size and prompt content are controlled. Differences range from 0.7% in favor of 8K to 1.7% in favor of 32K. The 8K profile preserves full observed task success while offering better memory headroom, which strengthens its candidacy as the 32 GB default.

## Direct Chat/Tool Path Isolation

The `apps/daemon/src/chat-tool-benchmark.ts` instrument reproduces the read-only fixture's two provider requests without starting a Demesne daemon, creating sessions, reading files, resolving permissions, or streaming daemon SSE events. It sends the same stable system prompt, user prompt, and complete production tool-definition set. The first request must emit the expected `read_file` call. The second request receives a canonical assistant tool call and canonical file result, then must emit the expected correctness marker.

The report records separate round latency, time to first output, token usage, tool calls, response text, memory, power, model discovery, and actual `llama-server` process command lines. Root script `bench:chat-tool` runs the instrument. Its focused test validates request construction, round separation, correctness scoring, and summaries.

Two explicit batch aliases avoid Ollama's state-dependent automatic selection:

```text
qwen3.8-8k-b512:latest   -> num_ctx 8192, num_batch 512
qwen3.8-8k-b1024:latest  -> num_ctx 8192, num_batch 1024
```

The batch-1024 definition is preserved in `experiments/ollama/qwen3.8-8k-b1024.Modelfile` as an experimental control rather than a supported profile.

### Explicit Unpadded Comparison

The final schema-2 artifacts include before-and-after runner command lines. They confirm identical weights, 8K context, one sequence, q8_0 KV caches, Flash Attention, and physical/logical batches of either 1,024 or 512.

```text
~/.demesne/benchmarks/chat-tool-2026-08-28T00-27-11.014Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-29-32.947Z.json
```

| Direct chat/tool measurement | Batch 1,024 | Batch 512 | Change at 512 |
| --- | ---: | ---: | ---: |
| Successful runs | 3/3 | 3/3 | No change |
| Median two-round cycle | 35.441 s | 29.761 s | Approximately 16.0% lower |
| Median tool-selection round | 13.372 s | 7.620 s | Approximately 43.0% lower |
| Median final-answer round | 22.065 s | 22.137 s | Approximately 0.3% higher |
| First-round input/output | 1,701 / 29 tokens | 1,701 / 29 tokens | Identical |
| Second-round input/output | 1,821 / 219 tokens | 1,821 / 219 tokens | Identical |

This reproduces the agent result after removing Demesne orchestration. The performance effect is inside the backend's OpenAI chat/tool request and cache behavior. It is not caused by filesystem access, SQLite, permission handling, SSE delivery, or the agent harness.

The approximately 5.75-second first-round gap is close to the time required to process roughly 550 tokens at the measured 96.1 tok/s uncached prefill rate. This supports, but does not prove, an interpretation that the batch-1,024 path recomputes approximately one additional 512-token region during the repeated partial-prefix cycle.

### Padding Test and Falsified Boundary Model

The instrument supports `DEMESNE_BENCHMARK_PROMPT_PADDING_BLOCKS`. Forty deterministic control blocks increase first-round input from 1,701 to 2,372 tokens.

An initial prediction stated that the two batch sizes might converge above a shared 2,048-token cache boundary. Clean, explicitly configured runs falsified that prediction:

| Padded tool-cycle measurement | Batch 1,024 | Batch 512 |
| --- | ---: | ---: |
| First-round input | 2,372 tokens | 2,372 tokens |
| Median tool-selection round | 13.63 s | 7.80 s |
| Median final-answer round | 13.57 s | 13.59 s |
| Successful runs | 3/3 | 3/3 |

Artifacts:

```text
~/.demesne/benchmarks/chat-tool-2026-08-28T00-15-59.148Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-18-28.663Z.json
```

The persistent gap means a simple `floor(prompt tokens / batch size)` cache-boundary explanation is inadequate. Batch granularity may still affect backend cache reconciliation or prompt reevaluation, but the exact mechanism is not established by current telemetry.

### Runner-Reuse and Cache-History Findings

Two attempted comparisons were excluded from profile conclusions after runtime inspection:

- Ollama reused an already-loaded batch-512 runner when a request selected another same-weight 8K alias. The requested model name changed, but the process remained `-b 512 -ub 512`.
- The automatic `qwen3.8-8k:latest` alias launched with batch 1,024 earlier in Phase 2 but selected batch 512 after a later clean load. Its batch is therefore not a reproducible profile parameter.

Cache history also materially changed a padded batch-512 result. Reusing a runner immediately after the unpadded fixture produced approximately 14.86-second first rounds, while a clean runner with the same explicit batch, context, weights, and padded prompt produced approximately 7.80-second first rounds. One warm-up did not remove this difference.

These are product-relevant findings rather than benchmark inconveniences. Demesne cannot infer active batch size or cache state from a requested model alias. Supported profiles need explicit backend parameters, post-load runner verification, and care when switching among aliases that share weight layers. Benchmark reports must distinguish requested configuration from observed process configuration.

## Flash Attention and KV-Cache Matrix

The runtime matrix used isolated Ollama services on port 11435 so each service inherited exactly one Flash Attention and KV-cache configuration. The Homebrew-managed service on port 11434 remained unchanged. Every valid comparison used the same weights, 8K context, explicit batch 512, one inference sequence, AC power with raw mode `2`, one warm-up, fixed prompts, temperature 0, and seed 42. Post-load runner command lines confirmed the requested cache types and Flash Attention state.

### Flash Attention

Ollama 0.32.15 cannot run the planned Flash-off/q8_0 control. It rejected the request with HTTP 500 and `llama_init_from_model: quantized V cache requires flash_attn to be enabled`. The valid controlled comparison therefore used f16 KV caches:

| f16 KV measurement | Flash off | Flash on | Observed change with Flash on |
| --- | ---: | ---: | ---: |
| Empty-cache 2,205-token prompt rate | 87.41 tok/s | 97.32 tok/s | Approximately +11.3% |
| Repeated-prefix reported prompt rate | 9,158.38 tok/s | 9,306.19 tok/s | Approximately +1.6% |
| Native decode | 12.76 tok/s | 12.90 tok/s | Approximately +1.1% |
| Direct tool-selection round | 8.141 s | 7.299 s | Approximately 10.3% lower |
| Direct fixture success | 3/3 | 3/3 | No change |
| Direct final-answer output | 161 tokens | 219 tokens | Different generated text |

Artifacts:

```text
~/.demesne/benchmarks/ollama-native-2026-08-28T00-39-08.202Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-39-43.724Z.json
~/.demesne/benchmarks/ollama-native-2026-08-28T00-41-49.147Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-42-18.175Z.json
```

The empty-cache native prompt and direct tool-selection results both show a meaningful prefill-path benefit from Flash Attention. Cached short decode changed little. Total direct-cycle latency is not comparable because changing the kernel changed the exact greedy output and its length, even though both answers were correct. Keep Flash Attention enabled. This is both faster on the measured prefill-heavy paths and required for quantized V caches in this Ollama version.

### KV-Cache Precision

The Flash-on matrix compared clean q8_0, f16, and q4_0 services:

| Measurement | q8_0 | f16 | q4_0 |
| --- | ---: | ---: | ---: |
| Empty-cache 2,205-token prompt rate | 96.18 tok/s | 97.32 tok/s | 93.99 tok/s |
| Repeated-prefix reported prompt rate | 8,138.99 tok/s | 9,306.19 tok/s | 8,608.91 tok/s |
| Native decode | 11.33 tok/s | 12.90 tok/s | 11.92 tok/s |
| Direct tool-selection round | 7.605 s | 7.299 s | 7.516 s |
| Direct final-answer output | 219 tokens | 219 tokens | 230 tokens |
| Direct fixture success | 3/3 | 3/3 | 3/3 |
| Native-run ending memory availability | 27% | 28% | 31% |
| New swap-outs | 0 | 0 | 0 |

Artifacts:

```text
~/.demesne/benchmarks/ollama-native-2026-08-28T00-35-13.821Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-35-52.576Z.json
~/.demesne/benchmarks/ollama-native-2026-08-28T00-41-49.147Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-42-18.175Z.json
~/.demesne/benchmarks/ollama-native-2026-08-28T00-45-04.168Z.json
~/.demesne/benchmarks/chat-tool-2026-08-28T00-45-34.756Z.json
```

At this 8K context, f16 produced the highest native decode rate, approximately 13.9% above q8_0. q4_0 recovered part of that loss and ended with the highest coarse memory-availability reading. The memory observations began from different system states and report integer percentages, so they support only the direction of the q4_0 result, not a precise cache-memory delta. q8_0 and f16 produced identical direct output; q4_0 produced a different but correct 230-token answer. KV quantization is therefore not behavior-neutral even at temperature zero and a fixed seed.

The strongest agent fixture provided a limited end-to-end quality check:

| Failed-test repair | q8_0 | f16 | q4_0 |
| --- | ---: | ---: | ---: |
| Successful runs | 3/3 | 3/3 | 3/3 |
| Median task duration | 40.093 s | 35.64 s | 36.85 s |
| Median model rounds | 5 | 5 | 5 |
| Median tool calls | 6 | 6 | 6 |

Additional f16 and q4_0 artifacts:

```text
~/.demesne/benchmarks/agent-2026-08-28T00-52-28.594Z.json
~/.demesne/benchmarks/agent-2026-08-28T00-49-32.832Z.json
```

All profiles diagnosed, edited, and verified the repair correctly. Three measured repetitions of one fixture establish basic task reliability, not broad quality equivalence. q8_0 retains the broadest evidence because it also passed the read-only and editing matrices. f16 is a credible higher-throughput 8K option, while q4_0 is a credible lower-memory experimental option that requires a larger quality suite before support.

### Batch Decision

Retain explicit batch 512 in the provisional `balanced-32gb` profile. It preserves output and correctness, materially improves the controlled repeated tool-selection path, and avoids relying on Ollama's unstable automatic batch choice. Do not claim that batch 512 universally improves raw prefill: the native 2,205-token test showed no raw-prompt advantage, and cache history can change the observed chat/tool result.

The leading `balanced-32gb` candidate is now:

```text
8K context
q8_0 KV cache
Flash Attention enabled
batch 512
one loaded model
one inference sequence
AC power with raw mode 2 for performance experiments
```

This remains the provisional balanced profile rather than a product default. q8_0 preserves more theoretical KV headroom than f16 and has the broadest measured task evidence, while avoiding q4_0's more aggressive numerical compression. It also preserves the measured task latency of the 32K runner while retaining more context-related memory headroom. The exact batch and cache results are hardware- and workload-specific and must not be generalized to other Apple chips, models, prompt sizes, or Ollama versions without measurement.

The planned KV-cache and Flash Attention comparisons are complete. The exact internal cause of batch-sensitive partial-prefix latency remains unresolved, but it is isolated to the backend path and no longer blocks profile selection. The experiments demonstrate why runtime batch size, actual runner flags, cache history, KV precision, Flash Attention, and exact generated prompt content belong in the reproducibility fingerprint: two runners with identical weights and similar raw prefill and decode throughput can still have materially different end-to-end agent latency or tool behavior.

## Opt-In Runtime Verification

The provisional `balanced-32gb` profile is implemented as an opt-in strict verifier, not as the default and not as an Ollama configuration manager. Setting `DEMESNE_RUNTIME_PROFILE=balanced-32gb` requires a local Ollama provider. The model alias remains user-selectable because the observed runtime, not an alias name, determines compliance.

On every provider call, `ProviderTurnProcessor` captures a pre-request runner baseline, starts the provider stream, inspects the post-load runtime, and completes verification before yielding the first event to the engine. The expected settings are 8K context, batch and micro-batch 512, one parallel sequence, q8_0 K/V caches, Flash Attention on, one loaded model, and one `llama-server` process parented by the Ollama process listening on the configured port. The runner must remain stable from the first provider event through metadata inspection. Missing inspection, missing flags, an unloaded selected model, additional loaded models or service-owned runners, runner replacement, and value mismatches fail closed before model output is persisted or displayed. Model switching resets status to `pending` and invalidates verification that began for the previous model.

Authenticated `GET /v1/runtime` returns `unconfigured`, `pending`, `verified`, `mismatch`, or `unavailable` with expected settings, sanitized observations, mismatch descriptions, and observation time. It excludes raw command lines, model blob paths, and process IDs. The unauthenticated health response remains unchanged.

A live isolated-service smoke test on 2026-08-28 verified Ollama 0.32.15's actual q8_0/Flash-on runner flags and `/api/ps` metadata through the production path before output was exposed. Runtime verification remains covered by the current repository tests and compiled daemon build.

# Phase 3 Working Record

## FIFO Inference Scheduler

`apps/daemon/src/inference-scheduler.ts` implements a daemon-wide FIFO semaphore. Capacity defaults to one and can be changed with the validated `DEMESNE_INFERENCE_SLOTS` setting for non-strict deployments. The `balanced-32gb` profile requires one slot at both executable startup and the exported app-construction boundary.

Each waiter records enqueue time, listens to its turn's abort signal, and receives an idempotent lease. Cancelling a waiter removes it from the queue without consuming a slot. Releasing a lease grants the oldest live waiter. Unit tests cover FIFO order, capacity accounting, queued cancellation, queue timing, duplicate release, and pre-cancelled acquisition.

## Per-Round Ownership

`AgentEngine` acquires a lease immediately before each provider call and releases it in `finally` only after the provider iterator has completed cleanup. Context-overflow retries release and rejoin the queue tail. The engine does not hold a lease during tool execution or permission waits. This allows one session to read files, edit, run tests, or wait for approval while another session uses the model.

Integration tests establish that concurrent sessions never exceed one provider stream, enter in FIFO order, and do not hand off the slot until asynchronous iterator cleanup finishes. Another test holds an editing turn at its permission boundary and confirms that a second session completes inference before the edit is approved.

## Immutable Turn Configuration

Every submitted turn receives an immutable `TurnInference` snapshot containing provider, model, profile, thinking selection, request defaults, and the stream closure. `ProviderTurnProcessor` captures the selected model and uses it for every round of that turn. A model switch changes only future snapshots. Runtime verification for an older snapshot may complete, but its shared status is reset to pending when the global selector has moved.

The generic compatibility path is limited to processors without model switching and checks for provider, model, or profile drift before each stream. Mutable processors must implement `createTurnInference`; snapshot validation occurs before turn persistence, so an incompatible processor cannot leave an orphaned queued turn. Provider-start events record the snapshotted profile and thinking selection alongside provider and model.

## Queue Metrics and Lifecycle

Provider-call storage now includes additive `queue_duration_ms` migration support. `model.metrics`, session snapshots, the CLI context rail, and agent benchmark schema 5 report queue duration separately from provider duration and TTFT. Multi-round benchmark queue totals remain unknown if any round lacks a metric rather than reporting an incomplete lower bound.

Cancellation while queued creates no provider-call row because no provider request started. Application shutdown rejects new requests, drains handlers that already entered the app, aborts active and queued turns, waits for all turn tasks and provider cleanup, then closes background processes and SQLite. Tests cover queued cancellation, active and queued shutdown, and migration of legacy provider tables.

## Phase 3 Verification

The implementation passes 125 tests across 17 files, repository-wide TypeScript typechecking, and compiled CLI and daemon builds. Deterministic integration coverage establishes scheduling correctness. Conceptual review is optional and does not block engineering progress.

## Controlled Scheduling Experiment

Two concurrent sessions ran the same deterministic two-round tool fixture under the controlled Phase 2 runtime conditions. Each condition used three measured pairs. With one Demesne slot and the verified one-sequence runner, all 3/3 pairs succeeded, median two-turn makespan was 33.41 seconds, and median aggregate Demesne queue time was 22.19 seconds:

```text
~/.demesne/benchmarks/scheduling-2026-08-28T04-25-13.970Z.json
```

A second condition requested `OLLAMA_NUM_PARALLEL=2` and allowed two Demesne slots. All 3/3 pairs succeeded and Demesne queue time fell to zero, but the observed `llama-server` still launched with `-np 1`. Median makespan remained 33.41 seconds while median aggregate provider occupancy rose from approximately 33.38 seconds to 55.56 seconds, a 66.4% increase:

```text
~/.demesne/benchmarks/scheduling-2026-08-28T04-28-03.514Z.json
```

This is not a valid one-versus-two parallel-sequence comparison. Ollama 0.32.15 queued the concurrent requests behind its single-sequence runner, moving queue delay out of Demesne's explicit metric and into overlapping provider-call duration. The tagged scheduler source forces `numParallel` to one for the `qwen35` architecture even when `OLLAMA_NUM_PARALLEL` requests a larger value, because that architecture is currently marked unsafe for parallel requests. The source of record is `server/sched.go` at tag `v0.32.15`:

```text
https://github.com/ollama/ollama/blob/v0.32.15/server/sched.go
```

For this exact model and backend version, a true `-np 2` condition is unavailable. The experiment therefore supports retaining one explicit Demesne slot: two application-level slots provided no makespan benefit, obscured approximately 22 seconds of queueing inside the backend, and increased aggregate provider occupancy. This is a configuration-specific scheduling result, not evidence that serialized inference universally outperforms safe parallel inference on other models or hardware.

# Phase 4 Working Record

## Measurement-First Context Plans

`apps/daemon/src/context-planner.ts` now runs before every provider request and before inference-slot acquisition. The first increment is deliberately observational: it records budget pressure and applies only the pre-existing deterministic historical tool-output reduction. It does not yet remove history based on estimates, create summaries, or rewrite stable conversational prefixes.

Each schema-1 plan records the effective known capacity, enforced output reserve, 768-token future tool-result reserve, 512-token safety reserve, soft and hard input limits, original and final estimated input, separate message and tool-definition estimates, budget status, estimator identity, and each compaction action. Capacity is the smallest applicable configured limit, discovered model capacity, and strict-profile limit captured in the immutable turn snapshot. Unknown capacity or an unenforced output limit produces `capacity_unknown` rather than a fabricated safe budget.

The initial `openai-json-utf8-bytes-divisor-3` estimator serializes messages and tool definitions in the OpenAI-compatible request shape, counts UTF-8 bytes at three bytes per estimated token, and adds explicit structural overhead. It is versioned calibration infrastructure, not an exact tokenizer. Historical tool output is eligible for the existing 15-head/10-tail line reduction only when the same whole-request estimator proves that the replacement is smaller. The planner never mutates its input and does not compact the current turn's active tool calls or matching results.

`TurnInference` snapshots now carry effective capacity and the enforced maximum output. `DEMESNE_MAX_OUTPUT_TOKENS` configures the provider request limit; `balanced-32gb` defaults it to 1536 tokens, matching the initial budget hypothesis. A limit that is not smaller than known context capacity is rejected before turn persistence or provider use.

Every `provider_calls` row stores `context_plan_json` through an additive migration. `model.request_started` exposes the same structured plan, and session snapshots pair the latest plan with actual provider usage and timing. Multi-round turns and provider-overflow retries receive distinct plans, allowing estimated input to be calibrated directly against reported `inputTokens` without conflating attempts.

Provider-confirmed overflow recovery remains the emergency mechanism. It still removes only complete oldest turns and persists the new context boundary. Recovery now recognizes a clear overflow message even when a provider attaches an unrecognized generic error code, while preserving status filtering and false-positive tests. The former arbitrary eight-retry cap was removed because halving a non-empty history is inherently finite and should be allowed to reach a protected-current-request-only attempt.

## Phase 4 Baseline Verification

Pure planner tests cover determinism, input immutability, tool-definition accounting, protected current messages, unknown and exhausted budgets, action/total estimate reconciliation, and refusal to apply a nominal compaction that would increase request size. Processor, storage, migration, and daemon integration tests cover immutable limits, impossible reserve rejection, one persisted plan per provider round, pairing with actual usage, and overflow recovery with generic provider codes.

## Initial Estimator Calibration Matrix

Agent benchmark schema 8 preserves each complete context plan and provider usage event joined by `providerCallId`. It records turn and round indexes, fixture shape, provider outcome, estimate error, `estimate / actual`, and the required `actual / estimate` calibration factor. Missing or invalid plans, usage, and incomplete calls remain explicit exclusions rather than becoming zero. Summaries use only measured, shape-valid observations while counting all other measured rounds as excluded.

The harness now includes exact-output direct and four-turn growing-session fixtures. Existing read-only and repair fixtures cover tool selection, tool follow-up, and a five-round repair. Repair scoring requires the failing command first, only bounded inspection tools before one completed allowed edit, and the passing command immediately last; commands must not time out, and altered command arguments are denied. Reports require the processor's model, output limit, temperature, and seed to match the declared configuration and include Bun version, immutable Ollama model digest, final sanitized strict-profile status, and observed runner settings. The `bench:agent` package script now honors caller-supplied model, endpoint, and provider variables instead of overriding them with defaults.

The authoritative matrix ran on AC power at raw mode 2 against an isolated Ollama 0.32.15 service. Every artifact records a verified `balanced-32gb` runtime: 8K context, batch and micro-batch 512, one sequence, q8_0 K/V cache, Flash Attention on, one loaded model, and one service-owned runner. Temperature was zero, seed 42, output limit 1536, and each fixture used three measured repetitions with no warmup:

| Shape | Successful observations | Eligible rounds | Observed `actual / estimate` |
| --- | ---: | ---: | ---: |
| Direct answer | 3/3 | 3 | 0.7470 |
| Tool selection and follow-up | 3/3 | 6 | 0.7361-0.7438 |
| Failed-test repair | 3/3 | 15 | 0.7416-0.7510 |
| Four-turn growing session | 3/3 | 12 | 0.6295-0.7465 |
| Combined | 12/12 | 36 | 0.6295-0.7510 |

```text
~/.demesne/benchmarks/agent-2026-08-28T05-40-27.204Z.json
~/.demesne/benchmarks/agent-2026-08-28T05-40-55.286Z.json
~/.demesne/benchmarks/agent-2026-08-28T05-42-33.119Z.json
~/.demesne/benchmarks/agent-2026-08-28T05-44-40.667Z.json
```

The estimator did not underestimate any measured request. Its estimates were approximately 33-59% above Ollama's reported input counts. The largest absolute overestimate was 1,364 tokens on the deepest padded growing-session request. Repeated positions produced identical token counts and ratios, so the 36 rounds contain 12 distinct request positions repeated three times rather than 36 independent prompt compositions.

A profile-specific factor of 0.80 was the candidate produced by this initial matrix. It was not applied pending composition stress testing.

Two earlier schema-6 artifacts are excluded. `agent-2026-08-28T05-09-27.364Z.json` targeted the normal endpoint because the old package script overrode the requested environment. That loaded a second 17 GB runner. `agent-2026-08-28T05-10-24.164Z.json` then encountered Metal out-of-memory failures on the otherwise-correct isolated runner while both copies were resident. Both contain zero eligible rounds and motivated the script and runtime-provenance hardening above. The later schema-6 and schema-7 successful matrices were implementation-validation runs and are superseded by the schema-8 artifacts listed above, which add strict fixture scoring, mandatory sampling metadata, model digest, and Bun version.

## Composition Stress Calibration

Agent benchmark schema 9 adds multilingual, escaped-JSON, dense-code, and historical tool-output shapes, per-turn tool limits and round labels, and a requirement that designated historical turns contain a real compaction action. The historical fixture reads a deterministic 90-line file through the production `read_file` tool, protects the active result, then verifies compaction when the result becomes history on the next turn.

This fixture exposed a production defect: tools return minified JSON, so embedded newlines are escaped and the old physical-line splitter saw one line. Historical compaction now parses JSON tool results, deterministically reduces multiline string fields, reserializes valid JSON, uses UTF-8 bytes for eligibility, and falls back to physical-line compaction for non-JSON output. Candidate replacements still apply only when the whole-request estimate decreases.

The first stress pass used estimator version 1 without an added factor:

| Shape | Estimated input | Actual input | `actual / estimate` | Result |
| --- | ---: | ---: | ---: | --- |
| Multilingual | 4,766 | 3,037 | 0.6372 | Overestimate |
| Escaped JSON | 4,900 | 3,661 | 0.7471 | Overestimate |
| Dense code | 4,811 | 5,454 | 1.1337 | Underestimated by 643 |
| Historical sequence | 2,267-5,471 | 1,691-3,497 | 0.6392-0.7459 | Overestimate |

```text
~/.demesne/benchmarks/agent-2026-08-28T06-00-32.220Z.json
~/.demesne/benchmarks/agent-2026-08-28T06-01-17.468Z.json
~/.demesne/benchmarks/agent-2026-08-28T06-02-07.432Z.json
~/.demesne/benchmarks/agent-2026-08-28T06-03-18.992Z.json
```

Dense code disproved both the 0.80 candidate and the assumption that the unscaled byte heuristic was conservative. Its actual input was 78 tokens above the 5,376 planned-input budget even though version 1 reported `within_soft_limit`. Both earlier threshold candidates are rejected.

Context-plan schema 2 and estimator version 2 apply a 1.20 safety factor to message and tool-definition estimates while retaining the separate 1,536 output, 768 future-tool-result, and 512 safety reserves. The repeated strict-profile stress matrix then produced:

| Shape | Adjusted estimate | Actual input | `actual / estimate` | Budget status |
| --- | ---: | ---: | ---: | --- |
| Multilingual | 5,720 | 3,037 | 0.5309 | Over soft |
| Escaped JSON | 5,881 | 3,661 | 0.6225 | Over soft |
| Dense code | 5,774 | 5,454 | 0.9446 | Over soft |
| Historical tool selection | 2,722 | 1,691 | 0.6212 | Within soft |
| Active large tool result | 6,566 | 3,497 | 0.5326 | Over soft |
| Compacted historical result | 4,034 | 2,318 | 0.5746 | Within soft |

```text
~/.demesne/benchmarks/agent-2026-08-28T06-07-26.172Z.json
~/.demesne/benchmarks/agent-2026-08-28T06-07-57.147Z.json
~/.demesne/benchmarks/agent-2026-08-28T06-08-41.663Z.json
~/.demesne/benchmarks/agent-2026-08-28T06-08-52.323Z.json
```

All 12/12 stress observations and 18/18 provider rounds succeeded with zero underestimates under estimator version 2. Dense code remains the limiting composition at 0.9446, leaving approximately 5.9% estimator headroom before the separate 512-token safety reserve. Historical compaction fired in all 3/3 required turns, removed 65 logical lines, and reduced the adjusted estimate by 2,627 tokens. The 5,376 adjusted soft budget is now approximately equivalent to a 4,480 version-1 raw estimate. The 1.20 factor is the current conservative policy; it must remain versioned and should not be reduced without broader tokenizer-specific evidence.

## Proactive Context Reduction

Context-plan schema 3 adds explicit reduction actions and receives historical turn ranges derived from stored `turnId` values rather than inferring boundaries from message roles. The deterministic request projection now applies this order:

1. Traverse historical `read_file` and `read_files` results newest first. For exact matches of path, range, content, and read metadata, retain the newest copy and replace only each older result's content field with a deterministic reference marker.
2. Apply the existing JSON-aware 15-head/10-tail historical tool-output compaction to remaining large outputs.
3. If capacity and output reserves are known and the adjusted estimate still exceeds the soft input limit, remove one complete oldest historical turn at a time until the estimate fits or no historical turns remain.
4. Retain provider-confirmed overflow recovery as the emergency fallback.

Duplicate reduction preserves every assistant tool call, tool-result message, tool-call ID, and valid JSON envelope. Changed content, different ranges, malformed or failed results, non-file tools, and current-turn reads are not eligible. Every accepted action must strictly lower the whole-request estimate, all action savings reconcile with the original and final estimates, and the raw transcript remains intact for auditing and deterministic replanning.

Complete-turn projection never removes the system prompt, tool definitions, current user request, or current-turn assistant calls and matching results. The engine applies only a prefix of stored completed turns, carries that prefix consistently through multi-round turns, and persists the context boundary after a successful final provider response. A confirmed overflow can combine already-planned prefix removal with the existing complete-turn halving fallback before retrying. Restart integration coverage proves that the persisted boundary does not resurrect removed turns.

Structured summary checkpoints remain a separate future rung. Schema 3 does not generate model-authored summaries; after deterministic reductions are exhausted, complete-turn removal is its final proactive fallback. This avoids silently introducing unmeasured summary cost, latency, and semantic-loss behavior.

### Controlled Long-Session Validation

Agent benchmark schema 11 adds `schema3-long-session-calibration-v1`. Each repetition creates a 90-line stable file and a 20-line changing file, requires one exact `read_files` call in each of two completed turns, changes only the second file from version A to version B between those turns, then submits one padded no-tool request. Strict scoring requires exact tool arguments and model-round counts, a valid workspace transition, eligible usage on all five provider rounds, the exact `deduplicate -> truncate -> drop` action sequence, deduplication from the older to the newer stable tool result, exact truncation and complete-turn coordinates, one complete four-message first-turn drop, and a trim event whose cursor matches the first persisted message of the retained second turn. The fixture is pinned to 8,192 context and a 1,536-token output reserve so configuration changes cannot silently remove the intended pressure.

The controlled run used one warmup and three measured repetitions on AC power at raw mode 2 against the isolated Ollama 0.32.15 service. The report verified `balanced-32gb`: explicit 8K context, batch and micro-batch 512, one sequence, q8_0 K/V cache, Flash Attention on, one loaded model, and one runner. It recorded model digest `e4d2f37f2ed03675fb6f0ab9c3e2afc55669746db3d43fe659646a6df85b2c04`, temperature zero, and seed 42. Source revision was unavailable and is recorded as `null` rather than inferred.

| Round | Adjusted estimate | Actual input | `actual / estimate` | Reduction |
| --- | ---: | ---: | ---: | --- |
| First read selection | 2,761 | 1,720 | 0.6230 | None |
| First read follow-up | 4,006 | 3,375 | 0.8425 | None; active result protected |
| Changed-file read selection | 3,612 | 2,565 | 0.7101 | Historical truncation |
| Changed-file read follow-up | 4,856 | 4,240 | 0.8731 | Historical truncation; active result protected |
| Schema-3 reduction | 5,122 | 3,071 | 0.5996 | Deduplicate, truncate, complete-turn drop |

```text
~/.demesne/benchmarks/agent-2026-08-28T07-15-27.706Z.json
```

All 3/3 measured sessions succeeded with exactly five model rounds and two tool calls. All 15/15 provider rounds were calibration-eligible, no request was underestimated, the median required factor was 0.7101, and the maximum was 0.8731. The final request began at an adjusted estimate of 7,068 tokens. Exact stable-content deduplication saved 749 estimated tokens, 65-line historical truncation saved 547, and dropping the complete oldest turn saved 650, producing the 5,122-token final request. The estimate immediately before the turn drop was 5,772, correctly above the 5,376 soft limit. Median measured task duration was 88.03 seconds.

This validates deterministic action ordering, estimator conservatism, strict changed-versus-unchanged identity, complete-turn boundary persistence, and model reliability for one controlled long-session shape. It does not establish broad repository behavior or model-authored summary quality.

### Matched Near-Capacity Latency Experiment

The standalone `bench:context-reduction` harness reconstructs the same two historical `read_files` turns without running an agent loop. The raw condition sends the complete ten-message history. The reduced condition sends exactly the six-message projection returned by `planContextRequest`. Both conditions use the same model settings and all 13 production `ToolRegistry` definitions. Fixture and tool-definition hashes are pinned, the planner must emit the exact `deduplicate -> truncate -> drop` action sequence, provider usage must be complete and remain below the hard input limit, and the final no-tool probe must reproduce the stable file's first and last records plus the latest B-version changing records.

The harness uses two warmup pairs and 12 measured pairs in balanced raw/reduced order. A unique nonce is prepended to both arms' system message for each pair. This prevents an immediately repeated request from reusing nearly its entire prefix while preserving an identical per-pair perturbation in both conditions. The first pilot without nonces is excluded: whichever condition repeated across a pair boundary reached approximately 0.4-second TTFT while the other condition required 32-61 seconds, making cache state perfectly confounded with order. The nonce-controlled pilot then produced consistent non-repeated-request TTFT in both order directions and was used only to validate the method.

The authoritative run used the verified `balanced-32gb` profile against isolated Ollama 0.32.15 on AC power at raw mode 2. The runner remained PID-stable with 8K context, batch and micro-batch 512, one sequence, q8_0 K/V cache, Flash Attention on, one loaded model, and the expected model digest. Temperature was zero, seed 42, output reserve 1,536, and source fingerprint `sha256:a3118116e64ba42bd29171f6ce5b5bd76f57083b2eca201a5d2d678e59956529`.

| Measurement | Raw | Reduced | Paired result |
| --- | ---: | ---: | ---: |
| Measured input tokens, median | 5,824.5 | 3,189.5 | 2,635 fewer; 45.24% mean reduction |
| Time to first output, mean | 63.273 s | 35.049 s | 28.224 s mean saving |
| Time to first output, median | 63.096 s | 35.002 s | 27.996 s median saving |
| Total duration, mean | 69.288 s | 40.298 s | 28.990 s mean saving |
| Exact probe quality | 12/12 | 12/12 | Zero reduced-only failures |

The geometric mean raw/reduced TTFT ratio was 1.806x with a paired log-ratio 95% interval of 1.777-1.835x. All 12/12 measured pairs favored reduction; the minimum paired saving was 26.9 seconds. The two order strata agreed at 1.815x when raw followed raw and 1.796x when reduced followed reduced. The second half's mean saving was 0.801 seconds lower than the first half, too small to explain the effect.

```text
~/.demesne/benchmarks/context-reduction-2026-08-28T15-22-49.331Z.json
```

Host telemetry is an explicit limitation. Available memory moved from 15% to 14%, swap use increased approximately 5.04 GiB, and recorded swap-out traffic was approximately 14.54 GiB. Both conditions were interleaved and order-balanced, the runner and power mode remained stable, and pair variance stayed low, so this does not explain away the treatment difference. It does prevent a clean-memory, memory-efficiency, thermal, or energy claim. The result is causal for this fixture, model, runtime, and observed pressure state; it must not be generalized to other repositories, prompts, models, machines, or context compositions without replication.

Ollama did not return an explicit cached-input counter. Benchmark schema 1 incorrectly rendered the absent counter as zero in this artifact, so those two cache medians must be interpreted as unknown. The pair nonce and order-stratified timings are the evidence against the exact-repeat confound; the provider usage object is not.

Decision: retain deterministic schema-3 reduction as the production context policy. The measured latency gain is large enough to justify the policy on the controlled near-capacity path. Keep `balanced-32gb` opt-in pending repository-transcript validation and acceptable memory behavior.

### Repository-Transcript Fidelity Smoke Run

`bench:repository-context` adds three versioned synthetic mini-repositories and completed production-format transcripts:

1. Repository inspection requires package, workspace, entrypoint, and context-policy facts after three exact repeated-file deduplications and multiline output truncation.
2. Single-file repair requires changed-file scope, public function, before/after default, command arguments, and passing validation after the complete diagnostic turn is removed.
3. Multi-file feature requires the protocol, daemon, and CLI contract after an unchanged test contract is deduplicated and the exploratory turn is removed. The deduplicated marker remains in the final projection rather than being discarded with the dropped turn.

Every scored fact is supported by retained repository content, tool-call arguments, or tool results rather than assistant narrative. Fixture repositories, complete semantic transcripts, planner outputs, gold objects, tool definitions, and manifests are hash-pinned. The runner re-plans injected fixtures before execution, rotates fixture order across pair blocks, balances raw/reduced condition order, and uses pair-specific system nonces. Missing source/runtime provenance, non-AC mode, a cold or replaced runner, provider failure, and timeout fail before additional conditions run. Changed-file arrays use set semantics; other arrays remain ordered.

The first smoke artifact is excluded from fidelity decisions because the original scorer treated changed-file order as significant. Raw and reduced both returned the same correct feature paths in tool-execution order, exposing a scorer defect rather than a treatment difference. The corrected scorer was covered by a deterministic reversed-order test before rerunning.

The corrected run used two warmup and two measured pairs per fixture against the verified `balanced-32gb` profile on isolated Ollama 0.32.15. It began after unloading the preceding runner, with host free-memory pressure reported at 91% before model load and 33% available at report start. AC mode 2, one runner, the expected digest, temperature zero, seed 42, and source fingerprint `sha256:fe3c183c5dfd5f32620dbd506a70cc6aef0130da1fee9f1333f31ca0e7df5555` remained verified.

| Fixture | Raw / reduced exact | Median input tokens | Median TTFT | Paired TTFT saving | Raw/reduced TTFT ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Inspection | 2/2 / 2/2 | 3,984.5 / 3,033.5 | 42.37 / 32.14 s | 10.23 s | 1.318x |
| Single-file repair | 2/2 / 2/2 | 3,843 / 2,438 | 41.07 / 26.02 s | 15.05 s | 1.578x |
| Multi-file feature | 2/2 / 2/2 | 4,400.5 / 3,405.5 | 47.43 / 36.61 s | 10.82 s | 1.296x |

All 6/6 measured pairs were operationally valid. Raw and reduced quality were both 100%, with zero reduced-only and zero raw-only failures. Input savings ranged from 951 to 1,405 tokens, every fixture favored reduction on TTFT, the equal-fixture geometric ratio was 1.392x, and the overall median paired TTFT saving was 10.91 seconds. The order-stratified ratios remained directionally consistent within every fixture. Cached-input counts remain unknown because Ollama did not provide them.

```text
~/.demesne/benchmarks/repository-context-2026-08-28T19-35-46.503Z.json
```

This is a smoke result, not an inferential repository benchmark: there is only one observation per condition order per fixture, and the repositories are deterministic miniatures rather than full live agent tasks. Memory also remains a blocker for default promotion. During the 17.3-minute corrected run, available memory fell from 33% to 13%, swap use increased approximately 2.13 GiB, and recorded swap-out traffic was approximately 3.04 GiB. The stable paired benefit means swap does not explain the direction of the context-reduction result, but the profile still fails a no-sustained-swapping default criterion.

Decision: the repository-transcript smoke gate supports schema-3 production use and justifies broader validation. It does not yet justify making `balanced-32gb` the default. Promotion now depends on full-agent repository fixtures and acceptable sustained memory behavior, not conceptual review.

### Full-Agent Context Experiment

`bench:full-agent-context` executes paired raw and schema-3 conditions through the production daemon loop rather than sending completed transcripts directly to the provider. Its inspection, single-file repair, and multi-file feature fixtures exercise session persistence, permissions, production tools, failing and passing focused tests, scoped workspace edits, exact final responses, context-plan telemetry, and final workspace validation. Pair order is balanced, fixture order rotates, and both arms share a unique per-pair system nonce. Power, runner identity, runtime profile, provider usage, source fingerprint, context limits, and raw-policy purity fail closed.

The first valid run used the original unconditional schema-3 policy. Both arms completed all 6/6 tasks, and schema 3 saved 798, 1,230, and 3,025.5 aggregate input tokens for inspection, repair, and feature work. It nevertheless made summed TTFT slower for every fixture on an equal-fixture geometric basis: raw/schema-3 ratios were 0.860x, 0.718x, and 0.624x. Per-round telemetry isolated the regression to the first provider call after historical compaction. Reducing an already in-budget history changed the otherwise append-only prefix and forced Ollama to prefill it again. The multi-file task later crossed the soft limit and changed the prefix a second time within the active turn.

```text
~/.demesne/benchmarks/full-agent-context-2026-08-28T20-46-49.405Z.json
```

This diagnostic result changed production behavior. Schema 3 now preserves all historical messages while the original estimate is within the known soft limit. If the estimate exceeds that limit, the existing `deduplicate -> truncate -> drop` sequence still runs. Deterministic tests cover the under-budget identity property, raw-policy identity, pressured reduction ordering, all three real tool/workspace fixtures, counterbalanced orchestration, treatment-only failures, and provenance rejection.

The corrected run used zero warmup and two measured pairs per fixture against the same PID-stable verified `balanced-32gb` runner on isolated Ollama 0.32.15. The model digest was unchanged, temperature was zero, seed was 42, output reserve was 1,536, AC raw mode remained 2, and the source fingerprint was `sha256:c761fb2b0e10e38bf19014ca27699e91870e3e57aef073358011c97d3ff33f40`.

| Fixture | Raw / schema-3 success | Median aggregate input | Median summed TTFT | Paired TTFT saving | Raw/schema-3 TTFT ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Inspection | 2/2 / 2/2 | 10,293 / 10,293 | 28.14 / 28.40 s | -0.26 s | 0.991x |
| Single-file repair | 2/2 / 2/2 | 17,289 / 17,289 | 42.12 / 41.98 s | 0.13 s | 1.003x |
| Multi-file feature | 2/2 / 2/2 | 17,432.5 / 14,565 | 44.04 / 52.52 s | -8.49 s | 0.838x |

All 6/6 pairs were operationally valid. Both conditions completed every task with valid workspace state, passing focused tests, and zero treatment-only failures. Under-budget fixtures correctly performed no reduction and matched raw latency within noise. The multi-file fixture crossed the soft limit, reduced aggregate input by 2,867.5 tokens or 16.45%, and retained exact task quality, but the necessary prefix change still imposed a substantial prefill cost. Provider-duration and task-duration savings are intentionally unknown for that fixture because schema 3 generated two more output tokens, so only aligned-round TTFT is compared.

```text
~/.demesne/benchmarks/full-agent-context-2026-08-28T21-01-06.610Z.json
```

Memory remains outside the default-promotion target. During the corrected 8.9-minute run, available memory fell from 27% to 15%, swap use increased approximately 2.10 GiB, and recorded swap-out traffic was approximately 2.32 GiB. This is sustained memory pressure, not a clean no-swap result.

Decision: retain the soft-budget gate and deterministic schema-3 reduction for capacity safety and fidelity. Do not characterize it as a universal full-agent latency optimization: an append-only raw history can be faster when it lets Ollama reuse the existing prefix. Keep `balanced-32gb` opt-in because the full-agent run fails both the no-sustained-swap criterion and the initial 20% task-time improvement target. The next context optimization should investigate cache-aware compaction timing without weakening the hard output-capacity boundary.

### Staged Memory Attribution Experiment

`bench:staged-memory` owns model residency on an explicitly configured isolated Ollama endpoint. It refuses the managed default port, incomplete source/runtime/power provenance, battery or non-mode-2 operation, and any runner not owned exclusively by the configured service. It unloads the selected model before measurement, records an unloaded baseline, loads and strictly verifies `balanced-32gb`, records a post-load checkpoint, observes an idle interval, executes the existing six-pair full-agent workload, and records recovery after unloading. Cleanup also unloads the model if a later phase fails.

The first run used isolated Ollama 0.32.15, the pinned model digest, one PID-stable runner, AC raw mode 2, a 60-second idle interval, zero warmup, two measured pairs per fixture, and source fingerprint `sha256:1c95852b1f48a5d892d99ba41e77185dc5d04fde6f1408ca9b87d5a3dfc55ceb`. The nested full-agent report remained valid with 6/6 operational pairs and 100% task success in both conditions.

| Interval | Available memory | Swap-use delta | Page-out traffic | Swap-out traffic |
| --- | ---: | ---: | ---: | ---: |
| Model load | 91% -> 34% | 0 | 0 | 0 |
| Idle residency, 60.16 s | 34% -> 34% | 0 | 0 | 0 |
| Full-agent workload, 546.22 s | 34% -> 13% | +84.12 MiB | 13.08 MiB | 116.13 MiB |
| Unload recovery | 13% -> 91% | 0 | 0 | 0 |

```text
~/.demesne/benchmarks/staged-memory-2026-08-28T21-24-48.384Z.json
```

The stage boundaries change the interpretation of the earlier 2.32 GiB full-agent swap result. The earlier run began with the model already loaded and only 27% available memory. The staged run began from 91% unloaded and 34% after loading, then produced no swap traffic during load or idle. Cumulative active work consumed the remaining headroom. The first four fixture pairs produced no swap-outs; the final raw inspection condition began at 16% availability, ended at 13%, and accounted for the complete 116.13 MiB swap-out delta. This is threshold behavior under sustained workload, not evidence of an idle residency leak or a raw-versus-schema-3 treatment effect.

Decision: keep `balanced-32gb` opt-in. Clean loading and idle residency are acceptable, but the standard full-agent workload still produces nonzero swap growth and drives available memory to 13%. The next controlled matrix should change one memory variable at a time, beginning with q4_0 KV cache and then a smaller batch, while preserving 8K context, one sequence, Flash Attention, model weights, workload, power, and provenance. A candidate must retain full task quality and remove workload swap growth before it can replace the current profile.

### q4_0 KV Memory Comparison

The named `experimental-q4-kv-32gb` verifier profile changes only K/V cache precision from q8_0 to q4_0. It retains 8K context, batch and micro-batch 512, one parallel sequence, Flash Attention, one loaded model, one runner, one Demesne inference slot, and a 1,536-token output reserve. The profile is strict and fails on observed q8_0 caches or any other runtime mismatch.

The q4_0 run repeated the same staged protocol and six-pair full-agent workload against the same model digest and Ollama 0.32.15. It used AC raw mode 2, zero warmup, two measured pairs per fixture, a 60-second idle interval, and source fingerprint `sha256:9dccc0be2f49afb3c5ab6ccfdc8d752d42a5d1fc79ff7adeaa92bf2a3468d850`.

| Measurement | q8_0 | q4_0 |
| --- | ---: | ---: |
| Unloaded availability | 91% | 92% |
| Loaded and idle availability | 34% | 34% |
| Post-workload availability | 13% | 17% |
| Workload swap-use delta | +84.12 MiB | -24.00 MiB |
| Workload page-out traffic | 13.08 MiB | 4.80 MiB |
| Workload swap-out traffic | 116.13 MiB | 0 |
| Workload duration | 546.22 s | 532.51 s |
| Operationally valid pairs | 6/6 | 6/6 |
| Raw / schema-3 task success | 100% / 100% | 100% / 100% |
| Treatment-only failures | 0 | 0 |

```text
~/.demesne/benchmarks/staged-memory-2026-08-28T21-38-37.974Z.json
```

The coarse availability metric does not show a post-load difference, suggesting the useful q4_0 headroom appears as the active slot and workload reach their high-water state rather than as an obvious idle allocation change. q4_0 eliminated swap-outs, reduced page-outs by approximately 63%, retained four additional percentage points of available memory, and shortened total workload time by approximately 2.5% in this run. The task outputs, tool paths, focused tests, and final workspaces all remained valid. Input-token differences were negligible and arose from per-pair nonce tokenization rather than cache precision.

Decision: q4_0 passes the current staged memory gate and becomes the leading experimental 32 GB profile. Do not promote it to the default or replace `balanced-32gb` yet. One six-pair synthetic workload is insufficient to establish the broader quality equivalence required for lower-precision KV cache. Replicate the staged run and add longer context-recall and edit-quality coverage before considering promotion. A smaller batch is not the next memory experiment because q4_0 already removed workload swap growth; batch changes should remain deferred unless replication fails or another workload reintroduces pressure.

### Expanded Quality Replication And Batch Follow-Up

The full-agent fixture set was expanded from three to five task classes before replication:

1. Historical recall reads an 80-line ledger, then retrieves early, middle, superseded, and latest facts in a later no-tool turn.
2. Two-file regression repair runs a failing focused test, reads a specification and implementation, infers the reserve/admission contract, edits exactly the two allowed source files, and proves the fix with the same test.

Both fixtures use production tools, permissions, persistence, exact response scoring, provider usage calibration, final workspace validation, and raw/schema-3 conditions. Deterministic processors execute the complete tool and test paths before live measurement. The expanded staged workload contains ten balanced-order pairs across five fixtures.

The matched q8/b512 and q4/b512 runs used the same source fingerprint `sha256:b29b84e4dc2aa0a8c7473fc6596efffacbe7d4e49044e605da93dcee136c3e01`. The q4/b256 follow-up added only the batch-256 model alias and strict profile, producing source fingerprint `sha256:b90ce7d78406c5ce1689cc63e163d53d2b5b66e5cea157333566ef65cfa8ea75`. Its alias has a different manifest digest because of the parameter layer but reuses the same model and projector blobs.

| Measurement | q8/b512 | q4/b512 | q4/b256 |
| --- | ---: | ---: | ---: |
| Operationally valid pairs | 10/10 | 10/10 | 10/10 |
| Raw / schema-3 task success | 100% / 100% | 100% / 100% | 100% / 100% |
| Historical recall success | 100% / 100% | 100% / 100% | 100% / 100% |
| Two-file repair success | 100% / 100% | 100% / 100% | 100% / 100% |
| Loaded availability | 34% | 33% | 35% |
| Post-workload availability | 13% | 15% | 14% |
| Workload swap-use delta | +1.42 GiB | +1.32 GiB | +1.02 GiB |
| Workload page-out traffic | 16.69 MiB | 22.45 MiB | 13.27 MiB |
| Workload swap-out traffic | 1.96 GiB | 1.68 GiB | 1.13 GiB |
| Workload duration | 877.98 s | 853.01 s | 797.63 s |
| Default memory eligible | No | No | No |

```text
~/.demesne/benchmarks/staged-memory-2026-08-28T21-59-02.812Z.json
~/.demesne/benchmarks/staged-memory-2026-08-28T22-15-44.981Z.json
~/.demesne/benchmarks/staged-memory-2026-08-28T22-33-15.354Z.json
```

The expanded run falsifies the narrow-run conclusion that q4_0 alone removes workload swapping. All configurations remained swap-free through the first fixture block, lost substantial availability as the second block began, and crossed into swapping during later second-block fixtures. q4_0 reduced swap-outs by approximately 14% relative to q8_0 at batch 512. Reducing batch to 256 cut swap-outs by approximately 42% relative to q8/b512 and shortened workload duration by approximately 9%, while preserving every measured quality outcome. It still accumulated 1.13 GiB of swap-out traffic and therefore failed the acceptance gate.

Decision: no profile is eligible for default promotion. `experimental-q4-kv-b256-32gb` is the best measured memory/performance candidate, but remains experimental because sustained workloads still force swapping. The next memory investigation should instrument runner resident/high-water allocation and test controlled runner recycling between workload blocks. Further cache or batch quantization should not proceed blindly until that experiment distinguishes unavoidable model footprint from reusable per-runner state that Ollama retains across requests.

### Runner Residency And Controlled Recycling

Staged-memory schema 2 adds one-second runner RSS sampling through fixed-argument `/bin/ps` calls that never request process environments. Required phase checkpoints fail closed if RSS is unavailable; periodic misses are counted separately. Samples are grouped by PID into runner epochs with first, latest, and observed-peak resident bytes. These values are observed RSS rather than kernel lifetime high-water or a complete accounting of Metal allocations, so host pressure, page-out, swap-use, and swap-out counters remain authoritative for the promotion gate.

The full-agent report now records explicit transitions between balanced-order blocks. Pair-level runner identity remains immutable. A changed PID is accepted only at a declared boundary with one runner before and after; the staged hook additionally requires AC mode 2, exclusive service ownership, unchanged backend and model digest, a complete unload to zero runners, a new PID, and successful strict-profile verification before work resumes. `DEMESNE_MEMORY_RELOAD_BETWEEN_BLOCKS=true` is limited to exactly two pairs per fixture so the intervention occurs once between the complete five-fixture blocks.

Two consecutive q4/b256 runs used Ollama 0.32.15, model digest `9de5bd0cc0f14577f4c20df530582c12142bbf6cd5515096ee90bf8bf0e432d0`, AC raw mode 2, and source fingerprint `sha256:9572fbfb86aeebdb204fdd385084d5968933a664c348749deba1f547c6a54344`.

| Measurement | Recycle run 1 | Recycle run 2 | No-recycle baseline |
| --- | ---: | ---: | ---: |
| Operationally valid pairs | 10/10 | 10/10 | 10/10 |
| Raw / schema-3 task success | 100% / 100% | 100% / 100% | 100% / 100% |
| Loaded and idle availability | 35% | 35% | 35% |
| Midpoint availability before / after recycle | 34% / 35% | 34% / 35% | Not applicable |
| Post-workload availability | 34% | 26% | 14% |
| Workload swap-use delta | -48 MiB | -48 MiB | +1.02 GiB |
| Workload page-out traffic | 8.14 MiB | 14.03 MiB | 13.27 MiB |
| Workload swap-out traffic | 0 | 0 | 1.13 GiB |
| Runner-epoch observed peak RSS | 21.73 / 22.39 GiB | 21.78 / 21.71 GiB | Not instrumented |
| Unavailable periodic RSS samples | 0 | 0 | Not instrumented |
| Recycle duration | 14.12 s | 14.12 s | Not applicable |
| Workload duration | 822.13 s | 824.75 s | 797.63 s |
| Default memory eligible | Yes | Yes | No |

```text
~/.demesne/benchmarks/staged-memory-2026-08-28T23-00-57.006Z.json
~/.demesne/benchmarks/staged-memory-2026-08-28T23-16-32.484Z.json
```

Both runner epochs independently reached roughly the same 21.7-22.4 GiB observed RSS range, but replacing the first runner restored host availability before the second block and prevented the cumulative availability collapse and swapping seen without recycling. This supports retained per-runner workload state as the dominant avoidable pressure source; RSS alone does not identify whether that state belongs to CPU mappings, Metal allocations, cache-slot storage, or another Ollama/llama-server subsystem. The intervention removed 1.13 GiB of swap-out traffic at the cost of approximately 14.12 seconds for unload, reload, verification, and settling. End-to-end workload duration increased approximately 3% in these runs while all quality gates remained unchanged.

Decision: controlled runner recycling reproducibly passes the expanded staged memory gate, and q4/b256 remains the runtime component of the leading candidate. Do not promote the profile or add unconditional production recycling yet. The benchmark boundary is an experimental control, not a realistic lifecycle policy, and recycling discards prefix/KV reuse while temporarily making the model unavailable. The next implementation question is to define and measure a safe trigger based on observed memory pressure and completed work, including concurrent-session behavior and queue latency, before backend residency control enters the daemon.

#### Quiescent Scheduler Boundary Prototype

The FIFO scheduler now accepts an optional benchmark-injected asynchronous boundary hook when capacity is exactly one. It runs only after the active provider lease has released and live work is queued, before the next lease is granted. Maintenance therefore executes with zero active inference, cannot race the next provider baseline capture, preserves FIFO order, and is included in the blocked request's existing queue-duration metric. A hook failure places the scheduler in a terminal state and rejects queued and future acquisitions. Daemon shutdown aborts and awaits in-progress maintenance before resources close. Production construction does not supply this hook.

The benchmark-only recycle controller combines three explicit gates: completed provider leases since the previous recycle, current host available-memory percentage, and a maximum recycle count. Every decision records scheduler state, memory state, threshold results, action, duration, and failure. Missing memory fails closed. Deterministic scheduler, controller, and two-session daemon tests establish that maintenance starts only at quiescence, queued work cannot enter early, FIFO and exact session outputs survive, queue time includes the intervention, cancellation and shutdown remain bounded, and failed maintenance cannot leak a request into the provider.

This is policy and concurrency scaffolding, not a production residency implementation or live scheduling result. The staged recycler still owns the only measured Ollama unload/reload path. The next experiment must connect that strict recycler to this hook on an isolated service, force exactly one threshold decision while two distinct sessions are queued, and record correctness, event integrity, queue latency, recycle latency, runner replacement, provenance, and host-memory deltas. Only then can a realistic threshold be selected.

#### Live Concurrent Recycling Experiment

`bench:scheduling-recycle` now owns model setup and cleanup on the isolated endpoint, injects the strict staged recycler into the scheduler boundary, and runs two concurrent read-only diagnosis sessions with distinct source markers and exact required endings. Each provider round must have exactly one start, usage, metrics, and completed terminal event. The forced mode deliberately uses one completed request, 100% available memory, and a one-recycle cap; this forces the mechanism for safety measurement and is not a candidate production threshold. Disabled mode uses the same harness without the hook.

The first two forced runs used source fingerprint `sha256:cf16b4c614465a1f8038e3b5f2a6d99c4da3ed0a1c8e71c90964d59b2ed968d9`. Both were valid and nearly identical: makespan was 93.464 and 93.444 seconds, recycle duration was 13.744 and 13.724 seconds, aggregate queue time was 87.799 and 87.766 seconds, and provider time was 79.661 and 79.653 seconds. Both sessions completed with isolated exact markers, `read_file`, and complete provider events. Each transition changed runner PID, retained the strict q4/b256 profile, restored availability from 33% to 34%, and produced zero swap-outs.

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-08-34.611Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-10-45.913Z.json
```

The authoritative matched control and forced run used source fingerprint `sha256:e9ab9039fbe354f4a32063543ca2532a5d85350e2c90ffcb22ed0efc7e42163b`, identical q4/b256 runtime settings, model digest, prompts, temperature, seed, one slot, and AC raw mode 2.

| Measurement | Recycling disabled | Forced recycle | Delta |
| --- | ---: | ---: | ---: |
| Valid concurrent pairs | 1/1 | 1/1 | 0 |
| Exact session and event-integrity success | 2/2 | 2/2 | 0 |
| Two-session makespan | 65.048 s | 93.513 s | +28.465 s / +43.8% |
| Aggregate queue duration | 45.800 s | 87.828 s | +42.028 s |
| Maximum single-round queue duration | 21.068 s | 33.436 s | +12.368 s |
| Aggregate provider duration | 65.019 s | 79.727 s | +14.708 s |
| Recycle duration | 0 | 13.737 s | +13.737 s |
| First request for session B | 5.088 s | 19.707 s | +14.619 s |
| Availability before / after workload | 34% / 33% | 34% / 33% | 0 |
| Workload page-out / swap-out traffic | 0 / 0 | 0 / 0 | 0 |
| Runner identity | Stable | Replaced and reverified | Expected |

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-13-43.823Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-15-15.123Z.json
```

The forced transition is safe but expensive in two separable ways. Unload, reload, strict verification, and settling consumed approximately 13.74 seconds while the next request remained queued. Replacing the runner also discarded the shared system/tool prefix, increasing session B's otherwise cache-assisted first request by another 14.62 seconds. That cold request delayed later rounds, so aggregate queue time increased more than wall-clock makespan. The tiny four-request workload had ample memory and no swap activity in either arm, so it received no memory benefit from recycling.

#### Sustained Concurrent Pressure Trigger

The scheduling fixture now supports nonce-separated repetitions and deterministic inert prompt padding. A one-pair calibration with 50 padding lines retained exact quality and produced 3,350-3,533 input tokens per round, 13,766 aggregate input tokens, and four provider rounds. Ten pairs therefore approximate the 135K-token first runner epoch from the expanded full-agent experiment while retaining concurrent queue pressure.

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-22-29.643Z.json
```

The matched sustained runs used source fingerprint `sha256:af5dedc1897d1994cda858fdac8618d2fe1198a2b47371c4b227da6870697ede`, q4/b256, 8K context, one inference slot, temperature zero, seed 42, 50 padding lines, ten concurrent pairs, 40 provider rounds, 138,380 input tokens in each arm, and AC raw mode 2. The policy required 12 completed rounds since the previous recycle, available memory at or below 20%, and at most one recycle.

| Measurement | Recycling disabled | Pressure-triggered recycle | Delta |
| --- | ---: | ---: | ---: |
| Operationally valid pairs | 10/10 | 10/10 | 0 |
| Exact session and event-integrity success | 20/20 | 20/20 | 0 |
| Aggregate input tokens / provider rounds | 138,380 / 40 | 138,380 / 40 | 0 |
| Total pair makespan | 1,070.687 s | 1,111.280 s | +40.592 s / +3.8% |
| Median pair makespan | 103.332 s | 102.047 s | -1.285 s / -1.2% |
| Availability before / after workload | 35% / 14% | 33% / 14% | Initial state differs by 2 points |
| Trigger point | None | Round 19 at 19% | One recycle |
| Availability across transition | Not applicable | 19% -> 33% | +14 points |
| Recycle duration | 0 | 13.703 s | +13.703 s |
| Swap-use delta | +2.33 GiB | +58.81 MiB | -2.27 GiB |
| Page-out traffic | 72.78 MiB | 38.17 MiB | -34.61 MiB |
| Swap-out traffic | 5.12 GiB | 130.81 MiB | -4.99 GiB / -97.5% |
| Strict memory eligible | No | No | Residual swapping |

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-24-50.964Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T00-43-37.091Z.json
```

The controller waited through the work gate and then through the pressure gate. Availability remained 32% through round 18, fell to 19% after round 19, and triggered before the next queued request. The transition itself produced no page-outs or swap-outs and restored 14 availability points. The intervention pair absorbed a 49.35-second matched penalty, while eight of the other nine pairs were 0.36-2.28 seconds faster than control as severe pressure was avoided. The aggregate policy cost was therefore 3.8%, substantially below the 43.8% eager-recycle penalty, while swap-out traffic fell by 97.5%.

A diagnostic run raised the cap to two recycles. It completed all 10/10 pairs with exact quality, transitioned at rounds 20 and 32, and reduced swap-outs further to 47.27 MiB, but still did not reach zero. Its report was correctly retained as invalid because the then-current report validator assumed one transition. The validator now accepts only a contiguous, counted multi-runner chain and has deterministic two-transition tests. The diagnostic was not promoted or used as matched evidence because it failed both report validity and the zero-swap target.

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T01-03-45.870Z.json
```

Decision: reject unconditional, per-request, and high-availability recycling. A 12-round/20%-availability trigger is the first policy to demonstrate a strong net memory benefit under sustained concurrent work: 4.99 GiB less swap-out traffic for 3.8% more total makespan with unchanged quality. Do not activate it in production yet. It still ended at 14% availability, produced 130.81 MiB of swap-outs, began two availability points below its matched control, and has only one valid sustained repetition. Keep the scheduler hook and pressure/work controller benchmark-only until this result replicates from equivalent initial host conditions and a second-epoch policy can satisfy the strict gate without eager-recycle latency.

#### Pressure Replication And Bounded Runner Lifetime

The replication series used source fingerprint `sha256:efcfb880a7325775de26931e0e9628b07688f6200a8925bc54a54d714e1bf1c6`. Every arm retained the same q4/b256 runtime, 8K context, one inference slot, temperature zero, seed 42, 50 padding lines, ten concurrent pairs, 40 provider rounds, 138,380 input tokens, and AC raw mode 2. Controller and report support was extended with an explicit subsequent-runner work threshold, runner-epoch decisions, and contiguous multi-transition validation. Repository verification passed 188 tests, typechecking, and both compiled builds before the live runs.

The replicated disabled control produced 5.09 GiB of swap-outs and 2.88 GiB of swap-use growth. The repeated 12-round/20%-availability policy fired after round 17 rather than round 19 and left 1.13 GiB of swap-outs. An adaptive arm allowed a second recycle after eight more rounds, but its first transition did not occur until round 21; that single transition produced zero swap-outs, and availability never again reached the 20% gate before the final request. The second-epoch rule therefore was not exercised. Across equivalent runs, the coarse pressure threshold fired at rounds 17, 19, and 21 and left 1.13 GiB, 130.81 MiB, and zero swap-outs. That variation rejects available-memory percentage as a sufficiently precise sole timing signal.

A deterministic one-recycle arm split the work after round 20. It reduced swap-outs to 52.88 MiB and added only 0.58% aggregate pair makespan, but still failed the strict zero-swap gate. Two deterministic recycles after rounds 13 and 26 passed the strict memory gate twice, but splitting four-request session pairs caused a repeatable 7.97-7.98% aggregate penalty. The final policy aligned transitions with complete benchmark pairs by recycling after rounds 12 and 24, leaving runner epochs of 12, 12, and 16 requests.

| Measurement | Disabled control | Pair-aligned run 1 | Pair-aligned run 2 |
| --- | ---: | ---: | ---: |
| Operationally valid pairs | 10/10 | 10/10 | 10/10 |
| Exact session and event-integrity success | 20/20 | 20/20 | 20/20 |
| Transition rounds | None | 12 and 24 | 12 and 24 |
| Total pair makespan | 1,074.504 s | 1,092.898 s | 1,092.797 s |
| Total pair makespan versus control | Baseline | +18.394 s / +1.71% | +18.292 s / +1.70% |
| Median pair makespan | 103.651 s | 102.344 s | 102.386 s |
| Median pair makespan versus control | Baseline | -1.26% | -1.22% |
| Availability before / after workload | 32% / 14% | 33% / 17% | 32% / 19% |
| Swap-use delta | +2.88 GiB | -24 MiB | -64 MiB |
| Page-out traffic | 53.47 MiB | 21.28 MiB | 14.72 MiB |
| Swap-out traffic | 5.09 GiB | 0 | 0 |
| Strict memory eligible | No | Yes | Yes |

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T01-39-19.720Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T01-57-52.665Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T02-16-30.726Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T02-36-16.055Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T02-56-18.084Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T03-16-23.529Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T03-36-49.649Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T03-55-54.590Z.json
```

The two pair-aligned repetitions differed by only 0.009% in total pair makespan. Both replaced and strictly reverified two runners, preserved the complete runner-transition chain, produced zero swap-outs, reduced existing swap use, and retained every quality and provenance gate. This satisfies the benchmark promotion criterion and establishes bounded runner lifetime as net-beneficial for the exact sustained fixture.

Decision: use 12-request, two-recycle, pair-aligned boundaries as the preferred benchmark policy for this workload. Do not infer that request 12 is intrinsically safe for arbitrary sessions: it works efficiently here because every pair has exactly four provider rounds, so both transitions occur between complete session pairs. Production remains disabled and all strict 32 GB profiles remain opt-in. The next production investigation should make the scheduler boundary aware of completed session work, or another cache-safe workload unit, so variable real sessions can receive the measured memory benefit without mid-session prefix invalidation.

#### Turn-Aware Boundary And Variable-Length Workload

The provider lease now carries its owning turn ID, and release atomically records whether that turn requires another provider round. The initial turn-aware scheduler tracked pending continuation turns and did not invoke benchmark maintenance while the set was nonempty. Unlike the earlier request-only boundary behavior, a deferred maintenance opportunity did not advance the boundary baseline; it remained pending until continuations finished. Turn-task cleanup removed stale state after cancellation, tool failure, or shutdown. Production behavior remained unchanged because normal daemon construction did not inject a recycle hook.

Deterministic scheduler tests cover FIFO ordering across interleaved multi-round turns, deferred maintenance, cancellation during tool work, idempotent release, maintenance failure, and shutdown. A daemon integration test runs two concurrent tool-using turns and proves that maintenance occurs only after both complete and before the next turn enters the provider. Scheduling benchmark schema 3 added per-session read-chain depths, expected read counts, and expected provider-round counts. Recycle report schema 2 recorded the zero-pending-continuation invariant at each decision. These schemas were subsequently superseded by the continuous-admission experiment below.

The first padded asymmetric calibration was retained as invalid negative evidence. Its continuation wording did not specify a terminal read count, so session B often searched for nonexistent additional files after completing the required two reads. Event integrity and factual answers remained correct, but only 3/8 pairs matched the exact round gate and one turn exhausted the eight-round limit. The corrected fixture states the exact read count, reveals each next path only in the preceding tool result, and prohibits listing or searching after the terminal read. It passed a 3/3 padded calibration before the authoritative comparison.

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T04-35-14.953Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T04-37-24.670Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T04-54-40.459Z.json
```

The authoritative runs used source fingerprint `sha256:cd6543ed6638503e8c2bcb2a98eada0dc9604f5475fc98a9ab27780cb49baad0`, q4/b256, 8K context, one slot, temperature zero, seed 42, 50 padding lines, eight concurrent pairs, 40 provider rounds, 141,223 input tokens, and AC raw mode 2. Session A required one read and two provider rounds; session B required two sequential reads and three provider rounds. The policy required 12 completed requests per runner, disabled the pressure gate for deterministic timing, and allowed two recycles. Since each complete pair contained five requests, both nominal 12-request thresholds were deferred to safe boundaries after requests 15 and 30.

| Measurement | Disabled control | Turn-aware run 1 | Turn-aware run 2 |
| --- | ---: | ---: | ---: |
| Operationally valid pairs | 8/8 | 8/8 | 8/8 |
| Exact session round shapes | 8/8 | 8/8 | 8/8 |
| Aggregate input tokens / provider rounds | 141,223 / 40 | 141,223 / 40 | 141,223 / 40 |
| Recycle boundaries | None | 15 and 30 | 15 and 30 |
| Pending continuations at recycle | Not applicable | 0 and 0 | 0 and 0 |
| Total pair makespan | 840.485 s | 863.659 s | 864.019 s |
| Total pair makespan versus control | Baseline | +23.174 s / +2.76% | +23.535 s / +2.80% |
| Median pair makespan | 101.616 s | 104.726 s | 104.721 s |
| Median pair makespan versus control | Baseline | +3.06% | +3.06% |
| Availability before / after workload | 34% / 15% | 34% / 33% | 34% / 33% |
| Swap-use delta | +2.03 GiB | -424 MiB | -32 MiB |
| Page-out traffic | 47.17 MiB | 8.08 MiB | 16.16 MiB |
| Swap-out traffic | 2.55 GiB | 0 | 0 |
| Strict memory eligible | No | Yes | Yes |

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T05-00-16.479Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T05-14-45.490Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T05-29-57.043Z.json
```

The policy repetitions differed by 0.042% in total pair makespan and 0.005% in median pair makespan. Both strict reports include complete runner-transition chains, zero pending continuations at every transition, zero swap-outs, decreasing swap use, exact provider-event sets, and unchanged quality. The measured latency cost is much smaller than eager recycling and avoids the mid-session prefix-loss penalty seen at nonaligned request counts.

Decision: the turn-aware boundary satisfies the benchmark promotion gate for asymmetric multi-round turns and supersedes fixture-count alignment as the preferred experimental mechanism. Keep production recycling disabled. The current fixture admits work in discrete pairs, whereas real sessions can arrive continuously, wait on permissions, fail tools, or remain active for much longer. Promotion to an opt-in daemon feature requires representative full-agent workloads and a policy for bounded deferral when there is no naturally quiescent all-turns-complete boundary.

#### Bounded Continuation Drain Under Continuous Admission

Scheduling benchmark schema 4 adds `maximumInFlightPairs`, allowing multiple pairs to submit before earlier pairs finish while keeping warmup and measured phases separate. Recycle report schema 3 adds explicit continuation-drain requests, deadlines, timeout counts, active-drain snapshots, and a report-validity gate requiring zero drain timeouts.

Only the recycle controller opts into mid-turn boundary evaluation. Once work, pressure, and recycle-count gates pass with continuations pending, it returns a bounded drain request instead of unloading the runner. The scheduler then holds fresh first-round waiters and grants the earliest queued request belonging to an already-started turn. This temporarily narrows FIFO to the continuation set so those turns can become terminal without admitting an unbounded stream of new work. At zero pending continuations, the same controller hook performs strict unload, reload, verification, and settling before fresh FIFO resumes. If the deadline expires, the scheduler abandons the drain, resumes fresh FIFO, disables further boundary maintenance for its lifetime, and marks the controller report timed out. Production installs no hook, so ordinary scheduling retains global FIFO without this path.

Deterministic tests cover continuation priority over fresh waiters, cancellation exposing a safe boundary, timeout recovery, shutdown during drain, invalid timeout values, and an integrated continuously admitted asymmetric workload. The integrated test proves that a threshold crossed with multiple pending turns records a drain request, completes older continuations, and recycles at a zero-pending active-drain snapshot while fresh pairs remain queued. Repository verification passed 199 tests, typechecking, and both compiled builds before live measurement.

A two-pair live calibration used source fingerprint `sha256:9fa352667e4820426be9dc0dcda325bf80c5dc66e0bbd6b3ec1086bd7a0e5431`. At request 2, two turns were pending; the controller requested a drain and recycled at request 5 with zero pending continuations. All 10 expected rounds and both pair outcomes were exact, and no timeout occurred.

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T16-59-45.734Z.json
```

An attempted eight-pair all-at-once disabled control exceeded the 15-minute per-turn deadline before every queued turn completed. No artifact was promoted. The matched sustained series therefore used six pairs admitted together, a 30-minute deadline, 50 padding lines, asymmetric two- and three-round turns, 30 total provider rounds, 105,555 input tokens, q4/b256, 8K context, one slot, temperature zero, seed 42, and AC raw mode 2. The policy disabled the pressure gate for deterministic timing, requested a drain after four completed requests, allowed two recycles, and used a five-minute maximum drain duration.

| Measurement | Disabled control | Bounded-drain run 1 | Bounded-drain run 2 |
| --- | ---: | ---: | ---: |
| Operationally valid pairs | 6/6 | 6/6 | 6/6 |
| Exact provider rounds / input tokens | 30 / 105,555 | 30 / 105,555 | 30 / 105,555 |
| Drain requests | None | Rounds 4 and 14 | Rounds 4 and 14 |
| Pending turns at drain request | Not applicable | 4 and 4 | 4 and 4 |
| Recycle boundaries | None | Rounds 10 and 20 | Rounds 10 and 20 |
| Pending turns at recycle | Not applicable | 0 and 0 | 0 and 0 |
| Drain timeouts | 0 | 0 | 0 |
| Total pair makespan | 5,116.133 s | 2,536.347 s | 2,536.668 s |
| Total pair makespan versus control | Baseline | -50.42% | -50.42% |
| Median pair makespan | 853.736 s | 413.863 s | 413.878 s |
| Median pair makespan versus control | Baseline | -51.52% | -51.52% |
| Median aggregate queue duration | 1,357.399 s | 700.749 s | 700.804 s |
| Availability before / after workload | 32% / 18% | 34% / 33% | 34% / 34% |
| Swap-use delta | +493.31 MiB | -88 MiB | -64.06 MiB |
| Page-out traffic | 25.28 MiB | 0 | 0.02 MiB |
| Swap-out traffic | 749.31 MiB | 0 | 0 |
| Strict memory eligible | No | Yes | Yes |

```text
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T17-18-23.105Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T17-33-32.629Z.json
~/.demesne/benchmarks/scheduling-recycle-2026-08-29T17-45-33.198Z.json
```

Both policy runs requested drains after four requests with four pending turns, overshot safely to ten completed requests while draining those turns, and then repeated the same 10-request epoch. Their total pair makespans differed by 0.013% and median pair makespans by 0.004%. Avoided swap and queue collapse outweighed two approximately 13.73-second maintenance pauses, producing a much larger speed benefit than the sequential-admission workload. The magnitude is specific to this heavily queued control and is not a general local-agent speed claim.

Decision: bounded continuation draining reproducibly satisfies strict memory, quality, transition, timeout, and latency gates for this continuously admitted asymmetric fixture. It supersedes passive all-turn deferral as the preferred benchmark mechanism. Keep production disabled: live evidence still lacks representative editing, testing, permission-wait, cancellation, and failure workloads, and the opt-in configuration and operator-visible timeout/failure policy have not been designed.

#### Mixed Lifecycle Deterministic Gate

Before creating a measured mixed-agent artifact, deterministic daemon coverage was extended to the lifecycle cases that the read-only scheduling report cannot score honestly. The shared one-slot test queues an approved `edit_file` turn, a second permission wait that is cancelled, an unknown-tool call that returns a recoverable tool error, a turn cancelled before provider entry, and fresh work. A real recycle controller crosses its threshold while all three multi-round turns are pending. Drain mode runs the recoverable-failure continuation first, holds fresh work while two permission continuations remain, removes the cancelled permission turn from continuation state, runs the approved edit continuation, and invokes maintenance only at zero pending continuations. Fresh inference remains blocked until the deliberately held maintenance callback completes.

The test requires exact provider-entry order, no provider start for the queued cancellation, `tool.call_failed` followed by successful recovery, permission request/resolution/tool completion ordering for the approved edit, tool cancellation without resolution for the cancelled edit, unchanged cancelled workspace content, and the expected approved workspace edit. A late attempt to resolve the cancelled permission returns HTTP 409.

A companion test leaves a permission continuation unresolved with fresh work queued. The configured deadline expires, records one drain timeout, performs no recycle, resumes fresh FIFO, and disables all later boundary decisions for that scheduler lifetime. Cancelling the stalled turn then clears its permission projection and rejects late resolution. Existing tests separately cover running-provider cancellation and shutdown during active drain.

This work exposed a persistence defect: turn cancellation changed pending tools to `cancelled` but left `permission_status='pending'`, so session state could advertise an unresolvable permission. Cancellation now transactionally changes pending permission state to `cancelled`, and tool start accepts only explicit `allowed` or `not_required` states. Direct storage tests require an empty pending-permission projection and reject both late resolution and tool start.

Repository verification passed 202 tests, typechecking, and both compiled builds with source fingerprint `sha256:1acad2e75b8d5c67c78afb8c7ee017c2cd59b59ff85d835e743050029fe3fecb`.

Decision: the scheduler, controller, daemon, broker, and persistence layers now pass the mixed lifecycle prerequisite. Do not treat this as new live-model or memory evidence. The existing scheduling artifact requires every provider round and turn to complete successfully, so cancellation and expected tool failure need a dedicated scenario-aware report rather than being forced into that schema. The next implementation should use one shared daemon with rolling task admission and per-scenario expected outcomes, reusing executable agent fixture workspace validation and provider-round parsing.

#### Scenario-Aware Mixed-Agent Continuous Admission

Mixed-agent admission schema 1 implements the dedicated report rather than weakening the scheduling schema. One shared daemon and one inference slot continuously refill a bounded pool from five explicit scenario contracts: read-only completion, cancellation before provider entry, an approved edit, a missing-file read followed by successful recovery, and cancellation while an edit permission is pending. Every task receives a separate workspace and session. The report validates terminal status, final response marker when applicable, ordered lifecycle events, provider-round integrity, final workspace content, permission cleanup, expected cancellation/failure behavior, and rolling admission. Scenario repetitions make the workload sustained without merging task state.

The strict schema-1 recycle wrapper owns the isolated runner from unloaded preflight through final recovery. It requires an explicit loopback endpoint, complete backend/model/source/power provenance, AC raw mode 2, exclusive runner ownership, strict q4/b256 flags, contiguous PID transitions, zero drain timeouts, and zero swap-out growth. Invalid reports are persisted for diagnosis and the executable exits nonzero. Production still installs no maintenance hook.

The first live calibration exposed scoring assumptions rather than lifecycle failures: all operational outcomes and workspaces were correct, but natural final prose, harmless reads around an approved edit, and partial text before permission cancellation were rejected. The corrected gates retain exact terminal, workspace, lifecycle-order, provider-integrity, permission, cancellation, and failure requirements while allowing those valid agent behaviors. A fresh one-repetition calibration then passed 5/5 scenarios.

The matched sustained experiment used three repetitions, six rolling tasks in flight, 30 provider rounds, q4/b256, 8K context, one slot, temperature zero, seed 42, AC raw mode 2, and source fingerprint `sha256:bf19093bdc09f45378ad5b89d5a8d2e08b3a9a68da9e7460ce8fcabc862dab31`. Policy arms disabled the pressure gate for deterministic timing, requested drains after four completed requests, safely reached zero pending continuations at requests 10 and 20, recycled twice, and used a five-minute drain deadline. Median substantive task sojourn excludes cancellation-before-entry tasks and measures terminal time from that task's admission.

| Measurement | Control 1 | Drain 1 | Control 2 | Drain 2 |
| --- | ---: | ---: | ---: | ---: |
| Valid scenario outcomes | 15/15 | 15/15 | 15/15 | 15/15 |
| Completed provider rounds | 30 | 30 | 30 | 30 |
| Input tokens | 54,637 | 54,667 | 54,637 | 54,637 |
| Recycles / drain timeouts | 0 / 0 | 2 / 0 | 0 / 0 | 2 / 0 |
| Workload makespan | 199.739 s | 255.406 s | 198.771 s | 262.179 s |
| Makespan versus matched control | Baseline | +27.9% | Baseline | +31.9% |
| Median substantive task sojourn | 82.549 s | 101.550 s | 82.716 s | 104.956 s |
| Sojourn versus matched control | Baseline | +23.0% | Baseline | +26.9% |
| Aggregate queue duration | 816.591 s | 1,038.486 s | 817.330 s | 1,061.275 s |
| Aggregate provider duration | 199.612 s | 227.638 s | 198.636 s | 234.414 s |
| Recycle duration | 0 | 27.511 s | 0 | 27.508 s |
| Swap-out traffic | 0 | 0 | 0 | 0 |
| Strict memory eligible | Yes | Yes | Yes | Yes |

```text
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T18-51-07.768Z.json
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T18-52-56.588Z.json
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T18-56-44.380Z.json
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T19-02-25.093Z.json
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T19-06-12.323Z.json
```

Both controls were already memory-eligible, so this workload offers no avoided-swap mechanism to offset runner replacement and lost prefix state. Across the two pairs, recycling increased makespan by a mean 29.9% and median substantive task sojourn by a mean 25.0%, while preserving all expected quality, permission, cancellation, failure-recovery, event, and transition outcomes. The result complements rather than contradicts the earlier overloaded read-only fixture: bounded draining can recover severe swap-induced queue collapse, but recycling is harmful when the same workload remains below memory pressure.

Decision: do not promote recycling into production or expose an opt-in daemon policy from this result. The mixed lifecycle mechanism is operationally sound, but a useful policy must avoid intervention while the runner is memory-eligible and cannot rely on the deliberately disabled pressure gate used to calibrate boundary behavior. Retain strict FIFO and no production hook.

The final pressure-eligibility escalation tested whether longer representative mixed admission would create a condition for a real memory gate. A six-repetition disabled control completed 30/30 tasks, 60 provider rounds, and 109,294 input tokens in 380.265 seconds. Availability changed from 34% to 33%, page-out traffic was 8.62 MiB, and swap-out growth was zero. The first ten-repetition diagnostic completed all operational outcomes but correctly failed report scoring when one permission-cancellation turn performed a harmless inspection round before requesting the edit. The contract and deterministic regression fixture now allow that one optional inspection while retaining exact cancellation, permission cleanup, workspace, event, and provider-integrity requirements.

The fresh maximum control used source fingerprint `sha256:30c33978fd5ae753793afc44e1ad7c77868f1afe53cf489f1c2de05fd45c1d1e` and the same isolated q4/b256 runtime, 8K context, one slot, temperature zero, seed 42, six-task rolling limit, AC raw mode 2, model digest, and strict runner verification. It completed 50/50 tasks and 100 provider rounds with 182,270 input tokens and 3,150 output tokens. Workload makespan was 629.863 seconds, aggregate provider duration was 629.648 seconds, and aggregate queue duration was 2,967.413 seconds. Availability again changed only from 34% to 33%; page-out traffic was 7.23 MiB and both swap-use and swap-out deltas were zero.

```text
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T19-18-22.816Z.json
~/.demesne/benchmarks/mixed-agent-recycle-2026-08-29T19-36-55.245Z.json
```

No pressure-policy arm was run after the maximum control. A genuine threshold would remain ineligible and reproduce the disabled condition, while forcing eligibility would repeat the already replicated intervention-cost experiment rather than test a pressure policy. Artificially padding prompts solely to manufacture swapping would weaken the representative-workload claim and duplicate the established overloaded scheduling fixture.

Final decision: recycling research is complete and production recycling is rejected. Bounded continuation draining remains a tested experimental mechanism, not a shipped policy. Reopen this question only if independent production telemetry demonstrates sustained runner-induced memory pressure under real mixed work; any future proposal must then beat an unchanged control twice on quality, swap growth, task latency, timeout behavior, and transition integrity.

## Structured Summary Checkpoint Experiment

Production summary activation was deliberately not implemented before measurement. The measurement-only checkpoint module defines a strict version-1 JSON schema for goals, current state, constraints, active/superseded/rejected decisions, file facts and changes, validation commands and outcomes, and unresolved work. Its parser rejects unknown fields, malformed or absolute paths, duplicate IDs and paths, invalid or cyclic supersession, blank/control-bearing text, Markdown wrappers, and trailing prose. Valid content is sorted with deterministic JavaScript lexical ordering and rendered as an immutable assistant-role historical-data message rather than a system instruction.

The standalone `bench:summary-checkpoint` harness compares three conditions over the same fact-bearing prefix and raw tail:

1. Raw history retains the complete source.
2. Drop removes the old fact-bearing prefix and retains only the raw tail.
3. Checkpoint replaces that prefix with the model-authored structured message and retains the same tail.

One unrebutted final source message instructs the summarizer to replace the goal, activate a rejected decision, and invent a passed deployment command. Mechanical scoring detects unknown facts, wrong decision categories, changed validation outcomes or commands, omissions, contradictions, malformed JSON, and tool-call attempts. The harness uses all six condition permutations in complete blocks, requires complete numeric usage, computes latency from paired observations, records compression and cached-token fields, and labels only `fidelityEligible`; `productionEligible` is hard-coded false. Runtime provenance is separately required and cannot be inferred from a successful fidelity score.

The controlled experiment used one full warmup and six measured balanced-order repetitions on the verified `balanced-32gb` profile against isolated Ollama 0.32.15. The artifact records the same model digest as the preceding experiments, explicit 8K context, batch and micro-batch 512, one sequence, q8_0 K/V cache, Flash Attention on, one loaded model, one runner, temperature zero, seed 42, and an unversioned source-content fingerprint. AC power at raw mode 2 was an operator-controlled condition verified immediately before the run, not a field persisted in this artifact.

| Measurement | Result |
| --- | ---: |
| Exact structured checkpoint rate | 0/6 |
| Raw-history exact recall | 6/6 |
| Dropped-prefix exact recall | 0/6 |
| Checkpoint-assisted exact recall | 6/6 |
| Injection hallucinations | 0 |
| Median checkpoint-generation input/output | 642 / 570 tokens |
| Median raw continuation input | 991 tokens |
| Median checkpoint continuation input | 918 tokens |
| Median summary-generation duration | 37.59 s |
| Median raw continuation duration | 18.71 s |
| Median checkpoint continuation duration | 18.63 s |
| Median checkpoint total duration | 56.22 s |
| Median paired continuation saving | 0.083 s |
| Median paired latency break-even | 450.63 continuations |
| First-continuation latency improvements | 0/6 |

```text
~/.demesne/benchmarks/summary-checkpoint-2026-08-28T07-51-33.039Z.json
```

Every summary ignored the injection attack, preserved all IDs, paths, decision statuses, commands, and outcomes, and supported exact structural-key recall for the probe. The probe does not re-evaluate every descriptive text field. All six summaries changed capitalization and terminal punctuation in the two validation fact strings. The strict checkpoint scorer therefore matched 10/12 atomic facts, recorded two contradictions, zero hallucinations, and rejected exact checkpoint fidelity. The artifact's byte-compression ratio is excluded because source and checkpoint bytes were measured at different serialization layers; future reports compare serialized message arrays on both sides. The provider token counts remain comparable: checkpointing reduced continuation input by only 73 tokens and saved approximately 83 milliseconds while adding approximately 37.6 seconds of generation. The result is not economically close to first-turn improvement and would require an implausible number of identical follow-ups to amortize on this fixture.

Decision: do not add checkpoint storage, scheduler integration, or production activation. Schema-3 deterministic reduction remains the supported behavior. Summary checkpoints should be reconsidered only with a substantially cheaper summarizer or deterministic extractor, near-capacity source prefixes that achieve materially stronger compression, multiple realistic repository fixtures, and demonstrated multi-turn amortization without fidelity loss.

## Cache-Aware Compaction Timing Experiment

Production activation was again kept separate from measurement. The benchmark-only delayed-hard planner first computes an unreduced plan, preserves it through the soft band, invokes the exact production schema-3 reducer only when the original estimate exceeds the hard input limit, and rejects a request if reduction cannot restore that limit. For the measured 8K context and 1,536-token output reserve, the production soft planned-input limit is 5,376 and the hard input limit is 6,656. The production planner remains unchanged.

Full-agent report schema 3 adds the `soft-delayed-hard` comparison, generic baseline/treatment observations, first-reduction and soft-band telemetry, reduction-action counts, provider cache-token fields, a timing-discrimination gate, and a mandatory live hard-boundary gate. The cache-timing suite uses the five established full-agent fixtures plus a measurement-only long-session fixture. Deterministic tests prove that the treatment preserves raw history inside the soft band, crosses the hard boundary in a later round, applies the exact production deduplicate, historical-tool-truncate, and complete-turn-drop actions, and remains at or below the hard limit. Unknown limits and irreducible over-limit requests fail closed before provider use.

Two initial five-fixture runs established the multi-file signal in both arm orders. Each completed 10/10 valid pairs with exact task quality; the unchanged replication lowered aggregate multi-file time to first output by 5.78 and 6.22 seconds despite carrying approximately 2,867 additional input tokens. Two expanded six-fixture runs then independently exercised both the preserving and reducing paths:

| Measurement | Expanded run 1 | Expanded run 2 |
| --- | ---: | ---: |
| Valid measured pairs | 12/12 | 12/12 |
| Timing-discriminating pairs | 4 | 4 |
| Hard-boundary reduction pairs | 2 | 2 |
| Baseline/treatment task success | 100% / 100% | 100% / 100% |
| Multi-file added treatment input, median | 2,862.5 tokens | 2,871.5 tokens |
| Multi-file baseline-minus-treatment aggregate TTFT, median | 6.412 s | 5.799 s |
| Long-session added treatment input, median | 895 tokens | 895 tokens |
| Long-session baseline-minus-treatment aggregate TTFT, median | 11.775 s | 11.840 s |
| Overall baseline/treatment TTFT geometric ratio | 1.083 | 1.087 |
| Workload swap-out growth | 6.42 GiB | 4.73 GiB |

Every expanded hard-boundary treatment preserved one soft-band round, later observed original estimate 7,100, and reduced to estimate 5,155 with the same three production actions. The long-session output-token counts were identical between arms, so its median provider-duration savings of 11.75 and 11.82 seconds and task-duration savings of 11.75 and 11.83 seconds are directly comparable. The multi-file treatment produced two fewer output tokens, so its provider and task durations are not labeled comparable; the aggregate TTFT signal still repeated in both arm orders and both independent runs. All exact workspace, focused-test, recall, citation, edit, and tool-loop quality checks passed.

```text
~/.demesne/benchmarks/full-agent-context-2026-08-29T20-13-50.039Z.json
~/.demesne/benchmarks/full-agent-context-2026-08-29T20-28-21.554Z.json
~/.demesne/benchmarks/full-agent-context-2026-08-29T20-44-30.737Z.json
~/.demesne/benchmarks/full-agent-context-2026-08-29T21-03-55.020Z.json
```

Decision: the local q4/b256 Ollama runtime benefits reproducibly from preserving the append-only prefix until intervention is necessary, and the benchmark-only policy preserved the hard output-capacity boundary in every measured crossing. Do not promote it as the provider-neutral production default. Ollama exposed no non-null cached-input-token counters, providers without prefix caching would receive 5.5-19.7% more input on the discriminating fixtures, and both expanded runs encountered substantial host swapping. Reconsider activation only behind an explicit provider cache capability or opt-in policy, with broader provider coverage and replicated low-pressure measurements. Production retains schema-3 soft-boundary reduction.

## Final Release-Readiness Audit

The final source audit covered production daemon startup, SQLite recovery, provider lifecycle, workspace boundaries, automatic tools, permission scope, undo behavior, background descendants, CLI transport, terminal rendering, package reproducibility, compiled artifacts, and research-only isolation. Benchmark and experimental entrypoints remain absent from the production daemon import graph, and production still uses strict FIFO, soft-boundary schema-3 reduction, no recycle hook, and no delayed-hard policy.

The audit found and remediated the following release-blocking runtime defects:

1. Automatically approved Git status and diff could execute repository-configured fsmonitor, text conversion, or external diff programs. Git now resolves only from trusted system locations, disables repository hooks and fsmonitor, and invokes diff with `--no-ext-diff --no-textconv`; executable-helper regressions prove no marker process runs.
2. `allow_session` on one unsandboxed command granted every later `run_command`. Commands are now one-shot in both broker and CLI, permission events include exact bounded tool arguments, previews quote argv, and redirected use requires both stdin and stdout TTYs before offering approval.
3. Undo followed substituted symlinks, lacked post-turn conflict detection, partially marked failed reverts, and omitted one side of moves. Regular-file snapshots now record both move endpoints and expected post-state hashes, preflight every target, reject legacy or changed states, restore through atomic renames, roll back partial application, and mark a turn reverted only after all targets succeed. Directory mutations are intentionally not advertised as undoable.
4. A second daemon could open the same database and interrupt the first daemon's live turns before failing to bind. Production now acquires an owner-recorded exclusive data-directory lock before constructing storage, safely claims dead-owner locks, releases idempotently on shutdown, and fails a second live owner before SQLite access.
5. Workspace roots are revalidated before tool path traversal, root and descendant symlinks are refused, automatic read/search protection now covers nested `.git`, `.ssh`, `.aws`, `.gnupg`, `.docker`, common credential names, and private-key formats, and permission summaries escape terminal controls and bidirectional overrides.
6. Background commands did not own process groups, so descendants could survive stop or shutdown. Background leaders are now detached, and a shell-plus-child regression proves group termination reaches the descendant.
7. The CLI could send its bearer token to a non-loopback cleartext endpoint. Non-loopback daemon URLs now require HTTPS and URL-embedded credentials are rejected before a request is sent.
8. Provider-controlled output could inject terminal control sequences. Streaming response and reasoning renderers, user/tool display paths, model listings, and fatal errors now neutralize C0/C1, escape, and bidirectional controls while preserving persisted text and machine-readable JSON routes.
9. A silent or endless provider could hold the sole inference slot indefinitely. Provider rounds now enforce a three-minute first-event deadline, a fifteen-minute total deadline, a 20,000-event limit, and one usage event; both deadlines are configurable. Ollama model discovery is capped at 1,000 unique models and metadata enrichment uses four-way bounded concurrency.
10. Configured providers could begin turns without a known context capacity or output reserve. Non-profile model startup now requires `DEMESNE_CONTEXT_WINDOW` and `DEMESNE_MAX_OUTPUT_TOKENS`; strict profiles provide their measured defaults. This keeps the hard output-capacity boundary defined before every configured-provider turn.
11. Crash recovery left permissions pending and turn failure writes could overwrite terminal states. Recovery now denies pending permission records while interrupting their calls, pending queries require a pending call, and failure transitions are conditional and guarded against secondary persistence errors.
12. Dependency resolution used `latest`, storage lacked downgrade protection, and artifacts had no version output. Bun 1.4.0, `@types/bun` 1.4.0, and TypeScript 7.0.2 are pinned; frozen install and dependency audit pass; storage schema version 1 rejects newer databases; package and CLI report version 0.1.0.

Verification after remediation and selected-model allowlisting passed 234 tests across 32 files, 1,302 assertions, TypeScript checking, frozen dependency installation, a zero-vulnerability `bun audit`, and both compiled builds. Process smoke testing started the compiled daemon, verified health, proved that a second daemon using the same data directory failed before opening storage while the first remained healthy, delivered SIGTERM, observed lock removal, and confirmed that the listener closed. The compiled CLI returned version 0.1.0 and successful help output.

Artifact inspection does not pass a public macOS distribution gate. Both generated binaries are Mach-O arm64 only, and `codesign --verify --deep --strict` reports invalid signatures. The audited pre-model-cleanup source/config fingerprint was `sha256:75d5b27403b8d71eaacf1d73a292c562dcd9352270a5bea1352db4aaa34e54e4`; the corresponding local binary hashes are `4cebc8a89d08b25acd329b6a56f38bc01ed622d23099dd89418ca3ae77e115cf` for `demesne` and `98d39884e985ab2c1137d01ce0e04e366f99c3bb7d1cc535e872cd1fed4f1349` for `demesned`. The repository has no x86_64 build matrix, Developer ID signing, notarization, release-checksum workflow, license selection, changelog, or security-policy workflow. Decision: version 0.1.0 is ready as a source/local-development candidate on the audited arm64 environment, but it is not a publishable macOS binary release. Do not label or distribute the current `dist` files as signed release artifacts. The next release phase is packaging and governance, not runtime research.

## Local Quantization And Storage Decision

The final local-model cleanup removed `qwen3:14b`, `qwen3:14b-fast`, `qwen2.5:0.5b`, four redundant Qwen3.8 aliases, and two failed experimental quantizations. Ollama storage fell from 26 GiB to 17 GiB, and free disk increased from 24 GiB to 44 GiB. The sole installed model is `qwen3.8-8k-b256:latest`, sharing the original Qwen3.8 27.3B Q4_K_M text weights and vision projector with an explicit 8,192-token context and batch 256.

A pristine BF16/F16 conversion was infeasible because the approximately 55 GiB source weights could not fit on the initial filesystem. The controlled fallback used llama.cpp 0.3.0 with `--allow-requantize --leave-output-tensor`. Q3_K_M produced 12,864.82 MiB at 3.95 BPW and IQ4_XS produced 14,695.60 MiB at 4.51 BPW, compared with the 16,021.46 MiB, 4.92-BPW Q4_K_M text model. Both retained the original projector, renderer, parser, context profile, and capabilities during Ollama inspection.

Matched 96-token, temperature-zero, seed-42 decode probes at 8K context and batch 256 measured 11.14 tokens per second for Q4_K_M, 9.04 for Q3_K_M, and 8.14 for IQ4_XS. Q3_K_M was approximately 19% slower and IQ4_XS approximately 27% slower than the baseline on the M1 Max Metal backend. Because neither candidate passed the speed gate and both compounded quantization error by starting from Q4_K_M, they were rejected before broader capability promotion and their blobs were removed. The retained Q4_K_M profile then passed a native structured `read_file` selection and a production-provider coding/tool cycle with one valid call, the exact arithmetic diagnosis marker, and 1/1 successful measured runs. Runtime inspection reported 100% GPU placement, context 8,192, and 32% host free memory after the cycle. Decision: retain Q4_K_M as the single supported local model; lower-bit 27B requantization is not an effective speed optimization on this hardware/runtime combination.

## Q4_0 32K Runtime Result

The later 15-token-per-second investigation retained the exact Qwen3.8 27.3B model as its baseline and tested runtime changes before changing quantization. Ollama q8 KV at a verified 32,768-token context reproduced 9.26 decode tokens per second; f16 KV reached 9.50. Sweeping built-in MTP draft depths 0 through 4 produced 11.35, 10.08, 9.02, 10.70, and 9.46 tokens per second respectively, so drafting was disabled. Current llama.cpp without MTP reached 10.60 tokens per second; fully allocated non-repacked serving reached 11.40. Thread count, host-buffer placement, and split mode were flat.

A Q4_0 requantization created with llama.cpp 0.3.0, `--allow-requantize`, and `--leave-output-tensor` reduced the text model from 16,021.46 MiB at 4.92 BPW to 14,977.32 MiB at 4.60 BPW. Raw llama.cpp decode rose to 15.44 tokens per second. An explicit 32,768-token llama.cpp server then sustained 15.93-15.97 tokens per second across four deterministic 128-token runs, with a median near 15.94. The server loaded all model layers on Metal, retained the original vision projector, and reported one 32,768-token slot.

Model-free llama.cpp `ngram-cache` speculation was subsequently tested with every other server flag held constant. Across three measured 256-token provider runs, median end-to-end output fell from 15.81 to 14.64 tokens per second and the post-first-output estimate fell from 15.91 to 14.73, a 7.4% regression. The warm six-round multi-file agent fixture still passed quality but slowed from 49.03 to 65.30 seconds, a 33.2% regression. The non-speculative server was restored; the raw reports are `provider-2026-08-30T06-32-27.739Z.json`, `provider-2026-08-30T06-34-31.848Z.json`, and `agent-2026-08-30T06-36-05.149Z.json` under `~/.demesne/benchmarks/`.

The direct OpenAI-compatible endpoint passed a one-run structured tool cycle and a one-run production-style coding diagnosis fixture. The latter used exactly one `read_file` call across two model rounds, found the exact required arithmetic marker, preserved the unchanged workspace, completed in 11.15 seconds, and produced zero swap-out growth. Ollama 0.32.15 copied this GGUF into its blob store but remained indefinitely in `parsing GGUF`, so the supported candidate is served directly by llama.cpp rather than imported into Ollama. The original Q4_K_M Ollama alias remains installed as the fallback baseline.

Decision: promote the direct Q4_0 llama.cpp profile as the local 32K performance candidate because it clears the 15-token-per-second gate without reducing parameter count and passes the initial tool/coding gates. Retain Q4_K_M as the fallback until broader long-session and editing fixtures replicate quality under sustained use.

## Measured llama.cpp 32K KV Precision, Batch, And Context-Length Study

This study began as a proposed optimization and ended as a rejection. The proposal was that the audited 32K llama.cpp profile should quantize its K/V caches from f16 to q8_0, on the argument that the profile allocates 32,768 tokens of f16 K/V on a 32 GB host, that the earlier Ollama work had measured q4/b256 as the lowest-swap configuration, and that halving K/V bytes would both reduce memory pressure and reduce per-token bytes read. A secondary proposal was that batch and micro-batch 256 were inherited from 8K Ollama memory testing and might be limiting prefill. Both proposals were measured and both were rejected.

The study also exposed a measurement gap rather than only a configuration question. `bench:provider` uses a fixture prompt of roughly forty tokens. At that length the K/V cache holds a few hundred of its 32,768 allocated slots, so K/V precision is nearly unobservable. The existing 32K Ollama datapoint in the preceding section, 9.26 decode tokens per second for q8 K/V against 9.50 for f16, is a 2.5% difference measured under exactly that limitation and therefore understated the effect by more than an order of magnitude. No conclusion about K/V precision, batch size, or context capacity is defensible from short-prompt measurement.

Method. All runs used the retained Qwen3.8 27.3B Q4_0 text model with its original vision projector, llama.cpp build `b10621-c1d0e7a00`, a 32,768-token allocated context, one slot, Flash Attention on, no repacking, no speculative drafting, AC power, and an exclusively owned server. Each configuration was launched cold and each fixture discarded one warmup observation. Prefill and decode rates are taken from llama.cpp's own `timings` block rather than estimated from client stream timing, so the two phases are separated by the server that performed the work, and prompt caching is disabled so prefill is genuinely recomputed for every observation.

First, the documented baseline replicated exactly. Three independent `bench:provider` runs on the f16 profile produced post-first-output medians of 15.94, 15.93, and 15.08 tokens per second, the first two on f16 and the third on q8_0, with zero swap-use growth. The 15.94 figure in the README is reproducible.

Second, K/V precision was measured across context length. On the f16 profile the gated long-context harness recorded 15.42 decode tokens per second at 491 prompt tokens, 15.03 at 4,051, 14.95 at 8,174, and 14.23 at 16,556, with prefill between 105.41 and 110.81 tokens per second throughout. Decode is therefore close to flat across a thirty-fourfold increase in context, falling only 7.7% from the shortest to the longest fixture. On q8_0 K/V the same fixtures recorded 11.95 decode tokens per second at 4,051 prompt tokens and 7.17 at 16,556, against 15.03 and 14.23 for f16: a 20.5% regression at agent-scale context and a 49.6% regression at long context. A separate matched cold-start pair at an identical 14,734-token prompt measured 14.25 tokens per second for f16 and 7.58 for q8_0, a 46.8% regression, corroborating the direction and magnitude independently of the harness.

The q8_0 configuration also failed the memory argument that motivated it. Its gated run recorded 246.66 MiB of swap-out growth where the matched f16 run recorded zero, so the report self-invalidated on the swap gate. Quantized K/V on this build did not reduce host memory pressure; it introduced pressure the f16 configuration did not have, presumably through additional dequantization scratch allocation. The raw reports are `llama-longctx-2026-08-30T07-57-34.723Z.json`, valid, f16, and `llama-longctx-2026-08-30T08-13-26.489Z.json`, invalid, q8_0, under `~/.demesne/benchmarks/`.

Third, batch size was measured and found neutral. Raising batch and micro-batch from 256 to 512 on the f16 profile changed prefill from 105.71 to 105.25 tokens per second and decode from 14.25 to 14.00 at 14,734 prompt tokens, both within run-to-run noise. Batch 256 is not limiting prefill on this configuration, and the earlier Ollama observation that batch 256 was approximately 9% faster than q8/b512 is better explained by the K/V precision difference in that comparison than by batch size.

Fourth, and most consequential for the product, prefill dominates agent turns and decode does not. At 16,556 prompt tokens, prefill consumed approximately 157 seconds against approximately 9 seconds to generate 128 output tokens, so prefill was roughly 94% of the turn. Because measured prefill is close to constant at approximately 105 tokens per second, each 1,000 tokens of context removed before a request saves approximately 9.5 seconds of time to first output. Applying that rate to the recorded schema-3 reduction of a median 5,824.5 to 3,189.5 provider-reported input tokens predicts approximately 24.9 seconds of saving against the 28.1 seconds actually measured, so the context planner's benefit is independently reproduced by this study from an unrelated harness. Deterministic context reduction, not runtime tuning, is the effective latency lever on this hardware.

Fifth, the remaining headroom was estimated in order to bound future work. This paragraph is an estimate and is labeled as such. The text model file is 15,715,853,664 bytes, so single-stream decode must read approximately 15.72 GB of weights per token. The measured 15.93 tokens per second therefore corresponds to approximately 250 GB/s of effective read bandwidth, which is approximately 63% of the M1 Max 400 GB/s specification figure and approximately 71% of a commonly achievable 350 GB/s. Measured prefill of approximately 105 tokens per second corresponds to approximately 5.9 TFLOPS against roughly 10.4 peak fp16 TFLOPS. Both phases are therefore within the normal efficiency band for this backend, and neither shows the large unexploited margin that a framework substitution would need in order to pay off.

That bound also answers a specific claim that prompted this study: that mlx-lm often achieves 15% to 25% higher raw decode throughput than llama.cpp on M1 Max and M2 Max for 14B and 32B models. The claim is not supported as a general rule for this configuration. Single-stream decode here is bandwidth bound at approximately 71% of achievable bandwidth, so the entire remaining margin to a perfect implementation is smaller than the upper end of the claimed range. Published comparisons are also routinely confounded by bits per weight, because a 4.5-bpw MLX 4-bit file is proportionally faster than a 4.85-bpw Q4_K_M file in a bandwidth-bound regime for reasons that have nothing to do with kernel quality; the retained Q4_0 model is already 4.60 BPW, which removes most of that margin. The claim was not tested directly and is recorded as unverified rather than false. Testing it would require an equal-bits-per-weight MLX conversion of the same weights, and would also cost the runtime provenance verification described below, because `mlx_lm.server` exposes no equivalent of the llama.cpp command line and `/props` observation surface.

A silent-substitution risk was found and closed. Before this work, `daemon:llama` set no `DEMESNE_RUNTIME_PROFILE`, so the directly served llama.cpp profile ran with no runtime verification at all, while the Ollama verifier hard-refused any provider other than `ollama` and parsed only Ollama's long runner flags. During this study the f16 and q8_0 servers were served under the identical alias `qwen3.8-q4_0-32k-b256`, and a configuration measuring 49.6% slower at long context was benchmarked without any component of the system detecting the substitution. This is the concrete failure the existing principle against trusting a requested alias was written to prevent.

Implementation. Runtime verification now covers directly launched llama.cpp servers. Profiles declare their required provider, and `llama-f16-kv-32k-b256-32gb` pins the measured 32K configuration, including f16 K/V precision, while `experimental-llama-f16-kv-32k-b512-32gb` retains the neutral batch-512 variant for controlled comparison only. Because a direct server has no supervising service, the process listening on the configured port must itself be the inference server. Context window and slot count are read from the server's own `/props` response and the command line is then required to agree, which catches a server started with flags that do not match what it actually serves; K/V precision, batch, and micro-batch are observable only from the command line. Both short and long llama.cpp flag spellings are accepted so a profile cannot be defeated by equivalent spelling, and `-mm` and `-ub` are proven not to be misread as `-m` and `-b`. `daemon:llama` now requests the strict profile, and `daemon:llama:unverified` preserves the previous unverified behavior for deliberate experiments. Provider benchmark reports now record the llama.cpp build identifier, which matters because Metal behavior for quantized K/V has changed between builds.

`bench:llama:longctx` is the new gated harness for this class of question. It sweeps nominal 512, 4,096, 8,192, and 16,384-token fixtures, records server-measured prefill and decode separately, pins the fixture set with a SHA-256 prompt digest so drift is visible, and reports the measured prompt length rather than assuming the nominal target was met. It fails closed and marks the report invalid on battery power, a non-exclusive or replaced server, any swap-out growth, missing build or command-line provenance, or an unstable prompt length. Its scoring and gating logic is unit tested offline, so `bun test` validates the harness without a live model.

Decision: retain f16 K/V for the 32K llama.cpp profile and reject quantized K/V for this build, because q8_0 cost 20.5% of decode throughput at agent-scale context, 49.6% at long context, and introduced swap growth where f16 had none. Retain batch and micro-batch 256, because 512 was neutral. Do not pursue framework substitution as a throughput optimization, because both prefill and decode are already within the normal efficiency band for this backend. Treat prefill as the dominant per-turn cost and deterministic context reduction as the primary latency lever. The one substantial untested lever remains Phase 7 draft-model speculative decoding, which is distinct from the already-rejected model-free `ngram-cache` and built-in MTP speculation and which cannot be evaluated on this host until a vocabulary-compatible draft model small enough to coexist with a 15.72 GB resident model is available.

## Measured 32K Context Feasibility, Prefix Reuse, And The Cold-Prefill Deadline

The preceding study established that decode is near the hardware limit and that prefill dominates a turn. This study asked the separate question of whether the 32,768-token context window is actually usable, given that the profile allocates it and the verifier now enforces it. The finding is that 32K is fully feasible on this hardware and was blocked entirely by two software decisions, one of which made near-capacity requests impossible.

Capacity is reachable and memory is not the constraint. A cold request of 31,149 prompt tokens, essentially the usable ceiling of 32,768 less the 1,536-token output reserve, completed with prefill at 97.11 tokens per second and decode at 13.08 tokens per second. Wired memory held at 19.67 GiB with no swap-out growth. Extending the earlier curve, measured decode was 15.42 tokens per second at 491 prompt tokens, 15.03 at 4,051, 14.95 at 8,174, 14.23 at 16,556, and 13.08 at 31,149, so decode degrades only 15.2% across a sixtyfold increase in context. Prefill stayed between 97.11 and 110.81 tokens per second throughout. There is no memory or throughput cliff at capacity.

Prefix reuse is the mechanism that makes 32K practical, and it is very strong. llama.cpp reports `prompt_tokens_details.cached_tokens` through the OpenAI-compatible endpoint, and measurement of an append-only transcript recorded 9,145 prompt tokens with zero cached tokens and 83.40 seconds on the cold request, then 9,141 of 9,145 cached and 0.25 seconds on repetition, then 9,146 of 9,167 cached and 0.78 seconds after appending a further round. Growing a conversation therefore costs approximately the prefill of only the newly appended tokens, not of the whole transcript.

The same measurement quantifies the cost of rewriting history. Replacing the oldest turn with a reduced version, which is the shape schema-3 reduction produces, dropped cache reuse to zero and cost 58.50 seconds at 6,475 prompt tokens. The comparison is stark: the unreduced 9,167-token request with an intact prefix reached first output in 0.78 seconds, while the reduced 6,475-token request with a rewritten prefix took 58.50 seconds. Removing 2,692 tokens saved approximately 25 seconds of nominal prefill and forfeited approximately 83 seconds of cache reuse, so reduction made the request roughly seventy-five times slower. For a provider with strong prefix reuse, deterministic context reduction is a capacity-safety mechanism that must not be treated as a latency optimization, and firing it early is actively harmful.

This is the evidence the delayed-hard compaction study was missing. That study recorded delayed reduction as carrying additional input tokens while lowering aggregate time to first output by 5.80 to 6.41 seconds and 11.77 to 11.84 seconds on its fixtures, and it was nonetheless kept measurement-only because "Ollama returned no cached-token counters, providers without prefix reuse would pay only the extra input cost" and production therefore awaited "an explicit cache-capability or opt-in policy." llama.cpp supplies exactly that capability signal. The policy question is now decidable per provider rather than provider-neutral, and the measured magnitude on the 32K profile is far larger than the eight-second effects that were observed at 8K.

A hard blocker was found and fixed. The `DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS` default of 180,000 ms was chosen when the supported context was 8,192 tokens. At the measured prefill rate it permits a cold prefill of only about 18,900 tokens, so every near-capacity request on the 32K profile failed. Instrumented directly through the production provider adapter, a cold 31,149-token request emitted its first provider event at 320.8 seconds. llama.cpp does emit keep-alive bytes during prefill, observed as a three-byte chunk at 30.2 seconds and 153 bytes in total before the first content token, but those bytes do not decode into provider events and so do not satisfy the deadline, which is applied to the parsed provider event stream in `withProviderDeadlines`.

The fix derives the deadline from the capacity the profile verifies rather than from a fixed default. `runtimeProfileMinimumFirstEventTimeoutMs` divides the profile's context window by a conservative measured prefill floor of 85 tokens per second, below the slowest observation of 97.11, and applies a 1.3 safety factor. The 32K profile therefore requires at least 502,000 ms while the 8K profiles derive 125,000 ms, which is below the existing default and so changes nothing for them. An explicit environment value always wins, and starting below a profile's derived floor now logs a warning naming the measured budget. The total request timeout floor is raised alongside it so the two settings cannot be left inconsistent.

Matched end-to-end control on the production path, using one daemon, the strict profile, the real provider adapter, the engine deadlines, and the CLI. With the deadline forced to the old 180,000 ms, a cold 30,720-token nominal turn failed at 180 seconds with "Provider did not emit an event before the timeout", and the new startup warning correctly reported that 180,000 ms was below the 502,000 ms measured budget. With the derived default, the identical turn completed in 318 seconds and returned the exact expected marker. The blocker was the deadline, not the model, the memory, or the backend.

`capacity-31k` was added to the long-context fixture catalog at 30,720 nominal tokens to keep this ceiling permanently measurable. It is deliberately excluded from the default sweep because one cold observation costs over five minutes of prefill, and is selected with `DEMESNE_LONGCTX_FIXTURES=capacity-31k`.

One caveat is recorded for the provider layer. Bun's `fetch` aborts a request with no inbound bytes after approximately 300 seconds regardless of the supplied `AbortSignal`, which is why a non-streaming 31,149-token probe failed while the streaming path succeeded. Production streams, and llama.cpp's roughly thirty-second keep-alives keep the socket active, so this is not currently a defect. It does mean a non-streaming provider that returns nothing for five minutes cannot be supported at this context size without a transport change, and any future non-streaming path must not assume otherwise.

Decision: treat 32K as a supported context capacity for the strict llama.cpp profile, because capacity was reached with no swap growth, only 15.2% decode degradation, and a completed production turn. Size cold-prefill deadlines from verified capacity rather than from a fixed default. Treat prefix reuse as a first-class performance property, and treat schema-3 reduction as capacity safety rather than latency optimization on providers that report cached tokens.

## Cache-Aware Planning And Ngram-Mod Promotion

Two follow-up studies were completed together because they optimize different halves of a turn: cache-aware planning protects prefill reuse, while speculation accelerates decode.

The context-policy study first corrected a measurement artifact caused by llama.cpp's one-slot prompt cache: each reduction variant was preceded by a restored full-history request so every arm was measured against the same 13,911-token cached prefix. Append-only growth preserved 13,912 of 13,931 tokens and reached first output in 0.81 seconds. Reducing the oldest turn produced 10,942 tokens, zero cached tokens, and 101.44 seconds; reducing the newest turn preserved 4,358 of 10,742 tokens and took 60.59 seconds. Dropping the oldest turn produced 9,553 tokens, zero cached tokens, and 87.51 seconds; dropping the newest produced 9,143 tokens, preserved 4,358, and took 44.92 seconds. At comparable reduced sizes, changing position alone therefore changed time to first output by 1.95x, while preserving the append-only request remained approximately 125x faster than oldest-first reduction.

`--cache-reuse 256` did not rescue oldest-first rewriting: the reduced request still reported zero cached tokens and 58.16 seconds. KV shifting requires a useful common prefix, and rewriting the earliest historical content removes that prerequisite.

Implementation. Strict directly served llama.cpp profiles now advertise prompt-cache preservation as an immutable per-turn inference property. Production selects cache-aware delayed-hard planning only for that explicit profile capability, not from an operator-supplied provider label and not for provider-neutral runtimes. The raw transcript is retained through the soft-hard band. Above hard, exact duplicate file reads retain the oldest occurrence and rewrite newer duplicates, and historical tool outputs are traversed newest-first. Complete-turn dropping remains oldest-first because SQLite's `context_start_message_id` records a contiguous retained suffix; dropping an interior or newest turn cannot be persisted honestly with that data model. Generic providers retain the previous soft-boundary schema-3 policy. Unit tests cover both ordering modes, and an app integration proves that a cache-capable inference preserves an identical transcript that a generic inference trims at soft. A later production failure exposed a separate hard-boundary case: one turn accumulated nine tool outputs, then a final 26 KB README read pushed protected current-turn evidence over hard after all historical options were exhausted. The planner now compacts older current-turn tool results newest-first, preserves the newest contiguous result batch, and records `scope: current_turn` on those actions. The exact prompt that previously failed now completes through four provider rounds; interactive chat also contains future failed turns and returns to its prompt instead of terminating the CLI.

Production-path validation used the strict ngram profile, the real provider adapter, engine, SQLite journal, and CLI. A near-capacity append completed in one second with 29,317 of 29,338 input tokens reported cached, 99.93%, and the persisted context plan recorded no actions. This verifies the capability selection and append-only result outside synthetic planner tests.

The speculation study screened `none`, `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, and `ngram-mod`, bracketed by a second `none` process. Every arm used llama.cpp build `b10621-c1d0e7a00`, cold process isolation, unique aliases, 32,768 allocated tokens, f16 K/V, batch and micro-batch 256, Flash Attention, one slot, AC power, and zero swap-out growth. `ngram-simple`, `ngram-map-k`, and `ngram-map-k4v` were flat: their provider post-first-output medians were 15.87, 15.89, and 15.87 tokens per second against bracketed baselines of 15.92 and 15.89. `ngram-mod` reached 70.56, a 4.44x provider-fixture increase. Raw provider reports are `provider-2026-08-30T18-50-24.578Z.json`, `provider-2026-08-30T18-52-23.719Z.json`, `provider-2026-08-30T18-54-23.031Z.json`, `provider-2026-08-30T18-56-22.302Z.json`, `provider-2026-08-30T18-58-09.247Z.json`, and `provider-2026-08-30T18-59-31.258Z.json` under `~/.demesne/benchmarks/`.

The gain survived context growth but declined as attention cost rose. At 491, 4,051, 8,174, and 16,556 prompt tokens, `ngram-mod` decoded at 57.38, 64.18, 53.37, and 23.27 tokens per second against non-speculative measurements of 15.42, 15.03, 14.95, and 14.23. All gates passed, including exclusive runner, AC power, stable fixture lengths, build/command provenance, and zero swap growth. The raw report is `llama-longctx-2026-08-30T19-15-55.950Z.json`. Long-context reports now parse and record the speculation type explicitly instead of relying only on the raw command line.

Quality and task latency were measured separately because the fixed provider fixture strongly favors repeated ngrams. `ngram-mod` passed 3/3 matched full-agent multi-file feature runs in a median 43.80 seconds, with exactly six model rounds, six tool calls, and the expected final workspace; the bracketed non-speculative arm passed 3/3 in 49.39 seconds. The end-to-end gain was therefore 11.3%, not 4.44x. It also passed one measured read-only arithmetic diagnosis in 9.97 seconds, single-file repair in 29.95 seconds, and repository inspection in 22.11 seconds, with exact required tools and outcomes. Raw reports are `agent-2026-08-30T19-03-21.880Z.json`, `agent-2026-08-30T19-06-53.274Z.json`, `agent-2026-08-30T19-13-13.475Z.json`, `agent-2026-08-30T19-13-56.965Z.json`, and `agent-2026-08-30T19-15-00.189Z.json`.

Runtime verification now treats speculation as configuration. The non-speculative production fallback rejects any `--spec-type` other than `none`; each experimental ngram profile accepts only its exact mode; and the promoted llama.cpp profiles require `ngram-mod`. `model:llama:baseline` and `daemon:llama:baseline` retain the measured non-speculative 32K fallback.

Decision: promote `ngram-mod` for the directly served Qwen3.8 27B Q4_0 32K profile. It clears the raw throughput gate, preserves every measured quality fixture, improves the matched production-style multi-file task by 11.3%, and introduces no memory regression. Do not generalize the 4.44x fixed-fixture number to arbitrary coding output; measured gains range from 63.5% at 16K context to 4.44x on highly reusable prose, and task-level gain was 11.3%. Keep MTP and the older `ngram-cache` disabled, retain the non-speculative fallback, and require strict speculation provenance.

## Native 64K Promotion And 100K Boundary

The retained GGUF was inspected directly rather than inferred from a model name. Its architecture is `qwen35`, native context length is 262,144, block count is 65, embedding length is 5,120, full attention occurs every four layers, KV head count is four, key and value lengths are 256, RoPE base is 10,000,000, and one NextN prediction layer is present. Therefore 64K and 100K remain inside native context and require no RoPE extrapolation. The hybrid architecture has sixteen context-growing full-attention layers; f16 KV is approximately 2.00 GiB at 32K, 4.00 GiB at 64K, and 6.25 GiB at 102,400.

Strict profiles and scripts were added before live testing. The 64K and 100K profiles require text-only serving, f16 K/V, batch and micro-batch 256, one slot, Flash Attention, and `ngram-mod`; runtime verification now observes the served vision modality and rejects a projector under either text-only profile. `capacity-61k` and `capacity-96k` extend the native timing fixture catalog, and `bench:llama:retrieval` supplies a deterministic exact-needle quality gate with provider-reported input tokens, AC power, exclusive unchanged runner, swap growth, and runtime provenance. The native timing harness was converted to streamed `/completion` so llama.cpp keepalives permit prefills longer than Bun's non-streaming idle timeout. Warmups are configurable and were disabled for capacity runs.

64K passed every gate. Cold startup from an 88-91% free host ended at 22-27% free memory without swap-use growth. A midpoint retrieval fixture reported 58,426 input tokens, returned the exact `DEMESNE_NEEDLE_7F3A9C2E` marker, reached first output in 695.32 seconds, retained one unchanged runner on AC, and generated zero swap-outs. The near-capacity native fixture used 65,075 prompt tokens and measured 81.33 prefill tokens per second and 10.96 decode tokens per second with zero swap growth. A final short provider screen reproduced 67.74 end-to-end and 70.57 post-first-output tokens per second, equal to the promoted 32K result rather than slower. Raw reports are `llama-retrieval-2026-08-30T22-14-11.428Z.json`, `llama-longctx-2026-08-30T22-32-12.668Z.json`, and `provider-2026-08-31T00-42-19.860Z.json`.

The text-only 102,400-token f16 profile proved model capability but failed the 32 GB memory gate. Startup ended at 12% memory availability without immediate swap-use growth. A 93,129-token midpoint retrieval returned the exact marker, measured 71.50 prefill tokens per second and 9.51 native decode tokens per second, and reached first output in 1,302.54 seconds. The cold request nevertheless generated 11.63 MiB of swap-outs. Repeating the identical request proved that prefix reuse scales: first output fell to 0.53 seconds, but the warm request generated another 95.94 MiB of swap-outs with matching swap-use growth. The raw reports are `llama-retrieval-2026-08-30T22-46-45.899Z.json` and `llama-retrieval-2026-08-30T23-09-24.482Z.json`; both are deliberately marked invalid.

Two memory alternatives were rejected. Disabling the 2 GiB RAM cache and reducing context checkpoints from four to one improved neither the 12% startup availability nor swap sufficiently, saving only approximately 0.2 GiB wired. Asymmetric q8 K / f16 V improved startup availability to 20% and reduced wired memory by approximately 1.9 GiB, but Metal prefill collapsed continuously: 103 tokens per second at 512 tokens, 40 at 6,400, 7.15 at 32,768, and 6.58 at 35,072. The run reached only 38% of the 93K request before the 90-minute deadline and was cancelled cleanly. This confirms that quantized K is also non-viable at long context on this build; the prior q8 K/V rejection was not caused only by value-cache quantization.

Decision: promote text-only 64K as the default local profile. It doubles capacity, keeps the exact 70.57-token-per-second short-context result, passes exact 58K retrieval, sustains 10.96 decode tokens per second at 65K, and produces zero measured swap growth. Preserve `model:llama:32k` and `daemon:llama:32k` as the vision-capable fallback and the non-speculative 32K baseline separately. Keep f16 100K available only as an explicit research profile: quality, native context, decode, and warm reuse are proven, but the memory gate fails on both cold and warm workloads. Reject q8-key and q8-value long-context profiles on this Metal build.

## Exact 100K Mmap And The 15-Token Target

The 102,400 rejection was revisited by separating requested capacity from binary-prefix shorthand and by testing model load policy. Exact `-c 100000` is served by llama.cpp as 100,096 because slot capacity is aligned to the 256-token batch. Relative to 102,400, this removes 2,304 allocated tokens, approximately 144 MiB of f16 KV for this hybrid model. Startup sweeps then held model, context, f16 K/V, batch, speculation, slot count, projector absence, and cache settings constant while changing load policy. Anonymous `none` ended at 15% availability; `mmap` ended at 17-18%; `mmap --no-host` remained 17%; `none --no-host` regressed to 12%. Batch 128 and 64, repacking, disabling the 2 GiB RAM cache, and reducing context checkpoints did not materially improve startup memory. Repacking was also throughput-neutral at 70.60 versus 70.71 post-first-output tokens per second. Decision: mmap, batch 256, no repack.

The selected exact-100K mmap candidate passed the memory and quality gate that 102,400 failed. A 93,129-token midpoint request returned the exact needle with zero swap-out growth, 1,304.37-second first output, 71.40 native prefill tokens per second, and 9.60 native decode tokens per second. Short-context throughput remained 70.71. The raw reports are `llama-retrieval-2026-08-31T03-05-00.526Z.json` and `provider-2026-08-31T03-04-22.143Z.json`.

The 15-token goal was defined as an exact, 128-word copy/reuse workload at the same depth rather than as a claim that arbitrary output becomes faster. The fixture embedded one deterministic passage at 50% of a 93,274-token prompt and required byte-exact reproduction. Cold output passed at 16.30 native tokens per second and 16.39 client post-first-output, with 141 of 192 ngram drafts accepted, 73.4%, and mean draft length 48. Swap growth was zero. Repeating the identical request reused 99.8% of the prefix, reached first output in 0.43 seconds, passed exact output at 20.37 native and 20.49 client tokens per second, accepted 164 of 192 drafts, 85.4%, and again produced zero swap growth. Raw reports are `llama-retrieval-2026-08-31T03-49-11.271Z.json` and `llama-retrieval-2026-08-31T04-11-34.345Z.json`.

The scope is explicit. Unpredictable 15-token needle output at 93K remains 9.60 tokens per second; 15+ is achieved when coding output copies or repeats sufficiently long sequences from context for `ngram-mod` to amortize target weight reads. This is representative of paths, identifiers, file content, patches, and repeated structured syntax, but not universal prose. The theoretical reason is visible in the measured acceptance: at 100K, arbitrary decode reads approximately 15.72 GB of weights plus 6.1 GB of KV per token, while accepted 48-token ngram blocks amortize target-model weight traffic.

Every alternative acceleration path was screened. Offline Metal tuning for f16, head dimension 256 selected the installed baseline in every tested bucket and produced no replacement table rows. A generic Qwen3.5 0.8B Q4 draft was rejected before allocation because its three-section MRoPE layout is incompatible with the target's four-section layout. Built-in MTP loaded but reduced the fixed provider fixture to 12.67 tokens per second and startup availability to 12%; raw report `provider-2026-08-31T03-36-01.981Z.json`. A target-specific 1.14 GB DFlash2 Q4_K_M draft required building llama.cpp PR 27342 because the installed build expected a different tensor schema. The custom Metal server loaded it, but startup availability fell to 6%, provider decode fell to 6.11 tokens per second, and swap use grew by 1.20 GiB; raw report `provider-2026-08-31T03-44-39.017Z.json`. Both draft paths are rejected on this 32 GB M1 Max.

Decision: promote exact-100K mmap, f16 K/V, batch 256, no-repack, text-only, `ngram-mod` as the default profile. It passes native context, exact quality, zero-swap cold and warm gates, preserves 70.71-token short throughput, and clears 15 tokens per second on exact copy/reuse output at 93K. Preserve 64K as the lower-memory fallback. Do not advertise universal 15-token decode at 100K; the measured arbitrary-output floor remains approximately 9.6.

## Online Research: Next 100K Optimization Paths

Upstream state was reviewed through 31 August 2026 and ranked against local measurements rather than accepted as transferable benchmark claims. The installed llama.cpp b10621 predates b10710's merged M1 Max Flash-Attention table: [PR 27932](https://github.com/ggml-org/llama.cpp/pull/27932) adds 188 M1-Max-specific rows, including Q4_0 and Q8_0 256-by-256 cases used by Qwen3.8. The local offline f16/head-256 tuner selected the existing fallback in every bucket, so no f16 table change is expected; the actionable A/B is b10621 versus b10710 for quantized KV. Local q8 K and q8 K/V failures remain the stronger evidence until that exact A/B demonstrates otherwise. The open [Qwen3.8 long-context issue 27756](https://github.com/ggml-org/llama.cpp/issues/27756) reports unstable EOS behavior beginning around 130K; production remains capped at 100K with explicit retrieval gates.

DFlash2 should be retested only on current mainline, not the older PR branch used locally. Mainline support was updated after the original PR; the model card recommends draft width seven, but Apple-oriented evidence and other draft-width sweeps commonly peak at three to five. Published llama.cpp M5 Pro Q4 results report 10.42 to 18.89 tokens per second and mean acceptance 5.03 ([PR 27342](https://github.com/ggml-org/llama.cpp/pull/27342)); those results do not override the local M1 Max result of 6.11 tokens per second and 1.2 GiB swap. A current b10710+ test must sweep widths three, four, and five, verify full draft offload, and pass the same swap gate before reconsideration. The open fused encoder/injection [PR 27310](https://github.com/ggml-org/llama.cpp/pull/27310) removes synchronization and graph-build work but reports only approximately 1% Qwen3.8 DFlash2 gain on CUDA, so it is not expected to close the local gap by itself.

The strongest alternative backend evidence is Ollama's native MLX runner. [Ollama issue 18131](https://github.com/ollama/ollama/issues/18131) reports 16.58 tokens per second on a 32 GB M1 Max and a real OpenCode repository workload completing in 696 seconds versus 1,341 for GGUF/Metal. [Issue 18029](https://github.com/ollama/ollama/issues/18029) reports an M2 Max 100K prompt at 101.62 prefill and 15.44 decode tokens per second. Quantization parity is not exact: the official [`qwen3.8:27b-mlx`](https://ollama.com/library/qwen3.8:27b-mlx) artifact is NVFP4 rather than this project's Q4_0 GGUF. More importantly, Ollama's MLX runner currently has a fixed 8 GiB prefix-cache allowance; on 32 GB this can grow an approximately 18 GB runner toward 28 GB and induce swap. Therefore MLX is a sidecar experiment, not a migration: require at least 12.5 arbitrary tok/s, 85 prefill tok/s at 93K, no regression below 16.3 copy-heavy tok/s, exact streaming tools, zero swap, and at least 10% steady-state availability after divergent cache branches.

vLLM Metal is the memory fallback if Ollama MLX fails its cache gate. Its [TurboQuant documentation](https://docs.vllm.ai/projects/vllm-metal/en/latest/turboquant/) describes Q8-K/Q3-V compression that could reduce this model's theoretical 100K attention cache from 6.10 GiB to approximately 2.4 GiB, but exact identifier retrieval is not guaranteed and shipped Qwen MTP support remains incomplete. Stock mlx-lm and LM Studio are lower priority because hybrid server prefix reuse and server-side KV quantization remain unresolved ([mlx-lm issue 980](https://github.com/ml-explore/mlx-lm/issues/980), [issue 1043](https://github.com/ml-explore/mlx-lm/issues/1043)).

Exact-context approximation methods are excluded from the main target. SnapKV, H2O, StreamingLLM, and rotating caches can reduce KV traffic substantially but can discard arbitrary middle-context code dependencies. Paged KV reduces fragmentation rather than the single-sequence 6.10 GiB payload. Prompt lookup remains the only mature lossless decode accelerator and is already promoted as `ngram-mod`. Prefix persistence remains the largest TTFT opportunity, but current llama.cpp slot save/restore omits recurrent checkpoints; [PR 26004](https://github.com/ggml-org/llama.cpp/pull/26004) is still open.

Ranked next experiments: (1) b10710 exact baseline and Q8 FA A/B; (2) Ollama MLX sidecar using the project's existing 2K, 93K cold, 93K warm, incremental suffix, copy-heavy, and tool-cycle gates; (3) current-mainline DFlash2 widths three to five; (4) vLLM Metal TurboQuant only if MLX memory fails. Do not spend more time on batch size, repacking, no-host, generic drafts, MTP depth, or cache/checkpoint startup tuning without new upstream evidence; local controlled runs have closed those paths.

The first three online-research experiments were then executed. Ollama was upgraded from 0.32.15 to service version 0.33.2 and the official 18 GB `qwen3.8:27b-mlx` NVFP4 artifact was pinned to 100K. It achieved 15.43 and 15.29 post-first-output tokens per second in cold and resident short screens, meeting the arbitrary decode target. It failed capacity and memory: initial load generated 789 MiB of swap-use growth, every short request transiently consumed about 60 percentage points of availability, and the native 93K request terminated with Metal `kIOGPUCommandBufferCallbackErrorOutOfMemory`. The partial prefix grew the loaded runner from 19.18 GB to 22.57 GB and pushed swap use to approximately 4.7 of 5.1 GB. Tool and divergent-cache gates were cancelled because the mandatory 93K gate had already failed. Raw short reports are `provider-2026-08-31T04-36-54.151Z.json` and `provider-2026-08-31T04-38-35.831Z.json`. The MLX artifact and alias were removed after rejection; Ollama 0.33.2 and the shared 32K fallback remain.

Current upstream llama.cpp commit `daef7b6`, built locally with Metal, improved the exact-100K f16 short screen only from 70.71 to 71.20 tokens per second, within noise. Its new Q8 256-dimension tuning did not rescue quantized KV: at 31,991 tokens Q8 K/V measured 96.05 prefill but only 7.00 decode tokens per second. Raw reports are `provider-2026-08-31T05-19-39.937Z.json` and `llama-longctx-2026-08-31T05-20-50.988Z.json`. The Homebrew b10621 f16 runtime remains the supported baseline because current mainline provides no material f16 gain and the temporary build is not distribution-stable.

Current-mainline DFlash2 was retested with the exact target-specific Q4_K_M draft and widths three, four, and five. Startup availability was only 10%. Post-first-output throughput declined as width grew: 11.06, 9.63, and 7.87 tokens per second; width five also generated 234 MiB of swap-use growth. Raw reports are `provider-2026-08-31T05-29-21.353Z.json`, `provider-2026-08-31T05-31-08.582Z.json`, and `provider-2026-08-31T05-33-09.960Z.json`. This confirms the earlier rejection was not only an old-branch or width-seven artifact. The draft and temporary build were removed.

Prompt-lookup tuning was also exhausted. The current `ngram-mod` defaults, match 24 and draft 48-64, were bracketed against shorter match/minimum settings, tuned `ngram-map-k4v`, and a combined mode. Post-first-output results were 70.34 and 69.80 for baseline brackets, 56.82 for match 16/minimum 32, 70.56 for match 12/minimum 24, 15.27 for map-k4v size 8/minimum hits 2, and 56.58 combined. The sole microbenchmark survivor, match 12/minimum 24, then passed 3/3 coding fixtures but regressed median six-round task duration from 43.82 to 49.91 seconds, 13.9%. Raw reports are `provider-2026-08-31T05-45-12.014Z.json` through `provider-2026-08-31T05-49-11.262Z.json`, and `agent-2026-08-31T05-50-18.940Z.json` versus `agent-2026-08-31T05-54-09.212Z.json`. Decision: retain ngram-mod 24/48/64.

vLLM Metal TurboQuant was installed from dev release `v0.4.0.dev20260831001336` with vLLM 0.28.0 and `mlx-community/Qwen3.8-27B-4bit`. At 100K, paged attention allocated a 4.03 GB q8-K/q3-V cache versus a logged 10.31 GB fp16 equivalent, exposed capacity for 139,285 tokens, and started with 41% system availability and zero swap growth. This confirmed the expected memory advantage. It failed speed: short post-first-output throughput was 14.09 tokens per second with 1.13-second TTFT, below both the 15-token arbitrary target and llama.cpp's copy-heavy results. The mandatory 93K request then produced no bytes within 90 minutes, reduced system availability to 8%, and was cancelled. llama.cpp completes the same exact retrieval in 21.7 minutes. Raw short report is `provider-2026-08-31T06-44-55.957Z.json`. The 15 GB checkpoint and 1.8 GB isolated environment were removed after rejection.

Decision after sourced implementation: retain exact-100K llama.cpp mmap/f16/`ngram-mod` as production. Ollama MLX proves that 15-token arbitrary decode is computationally possible on M1 Max but not at 93K within 32 GB under its fixed cache policy. Updated llama.cpp, quantized KV, DFlash2, tuned ngrams, and vLLM Metal do not improve the complete local target. Every currently evidenced software path has now been measured against capacity, quality, speed, and memory rather than left as an assumption. A future reconsideration requires new upstream Metal kernels, configurable MLX cache limits, or different hardware; further local flag sweeps are not justified by current evidence.

## Ollama MLX Cache-Budget Fork

The configurable-cache requirement was implemented rather than left hypothetical. GitHub fork `Shingi-Michael/ollama` was cloned as sibling repository `/Users/shingikamucheka/projects/ollama-demesne` on branch `demesne/mlx-cache-budget`, tracking `ollama/ollama` main. The complete MLX runner is open Go code in `x/mlxrunner`; its numeric runtime is pinned MLX/MLX-C built from source. The measured 8 GiB limit was located at `x/mlxrunner/prefix_cache.go` and found to apply only to owned paged-out snapshots, excluding weights, live cache state, allocator cache, and lazy snapshots still backed by the active cache.

The fork adds five inherited MLX runtime controls while preserving upstream defaults: `OLLAMA_MLX_PREFIX_CACHE_MB`, `OLLAMA_MLX_PREFIX_CACHE_MAX_BRANCHES`, `OLLAMA_MLX_PREFILL_CHUNK_SIZE`, `OLLAMA_MLX_PREFIX_SNAPSHOT_INTERVAL`, and `OLLAMA_MLX_WIRED_MEMORY_MB`. It also extends the existing `OLLAMA_KV_CACHE_TYPE=q8_0` setting to compatible full-history MLX caches. Prefix policy moved from a package constant to per-runner state; inactive leaves are LRU-evicted while the active path remains protected; zero snapshot interval disables periodic 8K restore points but retains the final pre-thinking snapshot. Environment, branch-limit, chunk, interval, wired-memory, hybrid-cache, affine-q8 snapshot, numerical-attention, and Qwen3.5 focused tests pass. Metal 3 and Metal 4 runners were built from source after installing Xcode's optional Metal toolchain. Implementation and reproduction notes are retained in the fork at `docs/demesne-mlx-cache.md`.

The first Metal 3 run used a 1 GiB snapshot budget, one branch, and 512-token chunks. Short throughput regressed to 13.22 tokens per second and load-time swap grew 1.75 GiB. Metal 4 with 2,048-token chunks recovered 14.99 tokens per second and reduced load-time swap to 680 MiB. The first 93K Metal 4/512 run took 1,817 seconds and generated approximately 117 GiB of swap-out traffic; its response remained in Qwen's thinking field because the native benchmark had not disabled thinking. This result revealed that byte and branch limits do not evict periodic snapshots on the active path.

A second fork revision made the 8,192-token active-path snapshot interval configurable and set it to zero for the single-session test. The exact 93,120-token midpoint retrieval then passed in 1,689 seconds, improving TTFT by 7% and reducing swap churn by approximately 63%. It still generated 44.5 GiB of swap-out traffic, ended at 9% availability during measurement, and decoded at only 0.80 tokens per second after sustained pressure. The active 100K model/KV/recurrent state and temporary MLX execution footprint, not merely inactive snapshots, exceed the practical 32 GB envelope.

The smaller 16 GB affine-int4 checkpoint was then imported through Ollama's experimental native-safetensors path. With f16 K/V it passed exact retrieval and zero swap at 7,470 and 30,663 reported input tokens, peaking at 17.12 and 19.73 GiB. At 62,387 tokens it remained exact but peaked at 27.88 GiB and generated 2,248.69 MiB of swap-out traffic. The fork therefore added affine q8 active K/V with full prefix snapshot/restore semantics and quantized GQA attention. Corrected q8 reduced the corresponding peaks to 17.05, 19.21, and 21.27 GiB. The 64K run still generated 72.88 MiB of swap-out traffic, took 919.73 seconds to first output, and decoded at 7.15 tokens per second. A 256-token prefill-chunk variant also failed the swap gate. The strict sequence stopped before 93K.

Decision: preserve the forked implementation and tests for future upstream/hardware work, but do not integrate it into Demesne production on this M1 Max. Cache configurability and q8 active K/V are real and effective, but insufficient: the best 64K MLX result still swaps and is slower than llama.cpp decode. The original official NVFP4 artifact was removed; the affine checkpoint, imported alias, and generated fork build remain available for development. Source changes remain uncommitted on the dedicated local branch in accordance with repository policy. Production was restored to exact-100K llama.cpp after the experiments.

## Llama.cpp Context-Capacity Ladder

Context growth is now evaluated as a strict 10K application-capacity ladder with 256-token served-context alignment. The fixed configuration remains Qwen3.8 27B Q4_0, mmap, f16 K/V, batch and micro-batch 256, one sequence, Flash Attention, no repack, a 2 GiB RAM cache, four context checkpoints, and `ngram-mod`. Each rung must preserve the current short decode rate and fixed 93K prompt-processing rate within 5%, return exact retrieval, retain at least 10% availability, and generate zero swap-out traffic before a near-capacity prompt is attempted. The ladder and thresholds are pinned in `experiments/llama-context-capacity-ladder.json`.

The first 110K rung used 110,000 application tokens and 110,080 served tokens. Startup passed at 17% availability with no swap growth. Controlled current-binary A/B measurements showed no meaningful speed regression: short decode measured 57.69 tokens per second at 100K versus 57.52 at 110K, while the exact 7,470-token retrieval reached first output in 67.15 versus 67.14 seconds. The fixed 95K-nominal fixture then reported 93,274 input tokens and remained exact. Its TTFT changed from 1,305.65 to 1,306.90 seconds and copy-heavy decode from 16.39 to 16.27 tokens per second, both within 1%. Memory failed: availability declined from 17% to 13% and the swap-out counter grew by 149,241,856 bytes (142.33 MiB).

Two memory variants isolated the deficit. Reducing RAM prompt cache from 2 GiB to 1 GiB preserved speed but still generated 127,926,272 bytes of swap at fixed 93K. Reducing context checkpoints from four to one then made both fixed 93K and a cold near-capacity 102,201-token prompt exact with zero swap, 11-14% final availability, and 16.40-16.54 tokens per second decode. This was not a free improvement: the repeated coding repair took 33.43 seconds versus the 18.96-second production baseline because its initial prefix was no longer retained. The one-checkpoint 110K profile therefore fails the 10% coding-latency gate despite passing long-context quality, speed, and memory.

A production-equivalent 105K boundary probe (105,216 served tokens, 2 GiB RAM cache, four checkpoints) passed startup, short, and 8K gates, but its fixed-93K run produced 1,006,895,104 bytes of swap traffic. This is larger than every 110K result and coincided with extensive prior long-run swap churn; it cannot be attributed to context size. The 105K boundary is recorded as inconclusive in `experiments/llama-context-capacity-105k-results.json` and must be repeated from a clean reboot before comparison.

Decision: 110K is technically feasible but not promotable with current policy: four checkpoints miss the memory gate and one checkpoint misses cache-reuse latency. Further boundary research requires clean host-memory state between candidates. It must not weaken the fixed-93K comparison or silently trade everyday coding latency for capacity. Production remains exact-100K.

# Current Status

Phase 0 and Phase 1 foundations are complete. Phase 2's runtime research and strict profile verification, Phase 3's FIFO inference scheduler, Phase 4's context and memory work, and Phase 7's available speculative paths are complete. Exact-100K mmap, f16 K/V, `ngram-mod`, and cache-aware delayed-hard planning are promoted for the strict directly served llama.cpp profile; 64K remains the lower-memory fallback. The 100K profile clears 15 tokens per second on measured copy/reuse output but not arbitrary output. Production summary checkpoints, production recycling, provider-neutral delayed-hard compaction, quantized K/V, larger batches, MTP, DFlash2, generic drafts, and the older `ngram-cache` remain rejected. Production remains strict FIFO with no recycle hook; generic providers retain soft-boundary schema-3 reduction; strict prompt-cache runtimes preserve append-only history through hard. Public binary distribution remains blocked on cross-architecture packaging, signing, notarization, checksums, and release governance.

The immediate next actions are:

1. Define the supported distribution contract and build separate arm64 and x86_64 release artifacts.
2. Add Developer ID signing, notarization, generated checksums, artifact smoke tests, and provenance to a non-interactive release pipeline.
3. Select and publish the project license, changelog, security policy, support matrix, and persisted-data backup/upgrade guidance.
4. Keep recycling measurement-only unless independent production evidence supplies a new deployment study; keep cache-aware delayed-hard restricted to explicit strict runtime capability.
5. Re-measure the strict Ollama profiles with the long-context harness, because `balanced-32gb` specifies q8_0 K/V and the experimental profiles specify q4_0, and every comparison that selected them was made at short prompt lengths where K/V precision is nearly unobservable.
6. Continue Phase 7 with real draft-model speculation only after acquiring a vocabulary-compatible draft model; `ngram-mod` is now the model-free production baseline.
7. Add a persistent planner calibration signal from actual provider input usage, because the byte estimator can undercount token-heavy synthetic content even though it overestimates the measured repository fixtures.
8. Evaluate `--slot-save-path` for durable per-session KV restoration after daemon or model-server restart.

This document will be updated as tasks are completed, predictions are tested, measurements are recorded, and decisions are made.
