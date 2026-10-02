# Agent Drive

Agent Drive is a separate planning context that operates Demesne’s text or graphics
workbench. Missions are bounded by default: finish the requested work, inspect the
results, record completion, and stop. Give it a mission in the work session:

```text
/drive Finish the parser changes discussed earlier, then review the diff and test results.
```

For ongoing improvement, explicitly use `/drive --continuous <mission>` (or check
**Keep choosing improvements** in the graphics panel). `/drive --bounded <mission>`
selects the default explicitly. A saved mission retains its original mode.

`/drive` or **Alt+J** opens the Drive panel. The `▷` rail button opens it too.
The panel shows the mission, current task/cycle, finished tasks, current action, completed and remaining items,
working notes, reviewed evidence, and recent UI actions. Its controls stay at the
top while notes scroll. It docks on wide terminals and overlays on narrow ones.
Preview the panel with `bun run ui:session --state=complete --drive`.

## Watching Drive think

Drive streams the selected provider's **Thinking** output as it arrives, followed
by its action draft, validated action, and result. Each decision has a local
model/duration/token receipt. Correction attempts appear separately, with the
validation error that prompted them. Thinking can be expanded or collapsed.

When Drive opens History, Diff, or another inspection pane, a compact activity
card above the composer keeps its planning visible. Click the card or press
**Alt+J** for the full trace. Submitted coding work uses the normal conversation's
Thinking, tool, and response display.
Submitting new work returns from Drive's inspection panes to the live
conversation so the working agent's Thinking follows automatically. Opening
the Drive panel keeps that conversation following too. Your own scrollback
still holds its reading position; the conversation's **Live** control resumes it.

The Drive panel follows new output at a readable pace. Scroll back to hold a
snapshot; **Live** or **Ctrl+G** returns to current output. Reading, scrolling,
and expanding thinking in this panel keep Drive running. Pause preserves partial
thinking, and reopening a saved mission retains the latest eight attempts
(bounded to 2.1 million characters each and 4.2 million total). If a provider
doesn't return thinking text, the panel says so.

These operator-visible traces are excluded from planner observations and
completion evidence. They do not change the model's reasoning settings or
output allowance.

## The operating loop

1. Read the actual rendered terminal rows and their visible clickable controls.
2. Recover intent from the current conversation, turn History, and the sessions
   picker. During a mission the picker is scoped to the same workspace.
3. Return to the mission's original session and compose a specific instruction.
   The text is displayed before Enter sends it through the normal prompt path.
4. Wait for the coding agent to settle, then inspect Diff, execution logs,
   verification output, or image Preview.
5. Send a targeted correction, continue inspecting, report a blocker, or finish
    with quoted evidence from inspected results.
6. **Continuous mode only:** ask the **coding agent** a focused question about useful next improvements,
   based on the finished work and your earlier goals. Read its answer, judge the
   suggestions, choose a concrete next task, and submit it through the composer.
7. In continuous mode, repeat the work/review/consultation cycle. If a fresh assessment finds no
   worthwhile work within your direction, become **idle** with an explanation.

### Hybrid controller and context

The local controller handles waiting and routine inspection. When the latest
answer settles, it opens the answer and reads up to six visible pages before
asking the model to judge it. The planner can also request one `inspect` action
to open/expand a Diff file, read a selected log record, or collect verification
heads and tails across up to six checks. Each inspection uses native workbench
handlers and appears as **CONTROLLER · UI navigation · no model inference**.
Goals, task selection, review conclusions, and worker instructions still use the
selected model and its configured reasoning/output budget.

Inspection packets contain exact rendered text, observation IDs, selected items,
scroll positions, and completed-answer provenance. A packet is capped at twelve
views and 24,000 text characters. Omitted content is explicitly marked; `continue`
reads further pages or the next batch of checks. Selecting a specific check reads
its middle as well as its outcome. The model receives one compact copy of the
visible text and six recent action receipts, while full observations and the
journal remain available for validation and recovery.

Scrolling during inspection discards that in-progress packet and holds the
reading position until **Live**. Typing or Pause cancels inspection. Collected
evidence expires when the session, selected turn, or document changes, and packets
are recollected after restart. Collecting rows never decides that work succeeded;
the model must still evaluate and quote them.

Drive's planning context remains separate from the worker's conversation. Local
controller actions consume no inference context; submitted prompts and worker
answers still occupy the worker's context. Sharing a single Qwen slot can still
replace its cached prompt when switching between worker and planner, but routine
paging no longer requires repeated planner inference.

### Live coder check-ins

Drive can review a coder turn **while it is working**, using the same loaded
model and inference slot. New text and graphics clients enqueue a review when a
recorded check finishes, two edit operations complete, or the same tool arguments
recur three times within the recent twelve calls. Quick events coalesce into one
pending checkpoint. Checkpoint reviews have a 15-second cooldown; the configured
`check_in_interval_seconds` (120 by default) remains a fallback for new activity.
Each worker turn permits at most three check-ins, within the existing mission
check-in and redirection limits.

A queued check-in gets priority at the next available inference boundary. It never
preempts a model response already generating. If coding work is queued, two
reviews cannot run consecutively; ordinary work retains FIFO ordering. Only one
queued or active review is allowed per worker. Strict runtime continuation-drain
hooks retain their existing ordering. Tools execute outside the inference lease,
so they can continue while Drive reviews. This does not create a second model
instance or increase the configured inference-slot count.

After acquiring the slot, the daemon replaces the old screen excerpt with a fresh,
bounded packet of recorded tool actions, result excerpts, check outcomes and file
changes. The packet has a worker/session identity, event cursor and revision. The
planner sees current task criteria and compact recent context, rather than an old
screen captured before a long queue wait. If the worker has already settled, is
waiting on human input, or has no eligible tool activity, the review is skipped
without a model call. The trace reports queue time and model-review duration.

- `keep_working` leaves aligned or inconclusive work running. A temporarily failing
  test or missing detail alone is not grounds for interruption.
- `redirect` must quote the fresh packet and provide a specific correction. The
  client checks its current session, worker and UI state. The daemon then compares
  the reviewed revision with current tool/source/check state immediately before
  cancelling that exact worker. Changed evidence or pending human input rejects the
  interruption. Only an acknowledged cancellation can lead to a correction through
  the visible composer, and Pause prevents it from being replayed later.
- A check-in never approves a tool, marks a task complete, or treats partial work
  as a verified result. Reading holds, drafts and approvals prevent new check-ins.

Reviews still consume model time and can displace the worker's prompt cache.
A single slot cannot inspect through another indefinitely running model call;
mission limits and provider timeouts remain active. This implementation prioritizes
safe handoffs, not simultaneous inference. The isolated regression tests use fake
providers and real daemon/tool execution; no additional PC model is loaded.

In explicit continuous mode, Drive asks the coding agent what is worth doing next
within your mission. Consultations use the read-only `/plan` path, with at most one
focused clarification per completed task. The controller records the exact
consultation turn; an unrelated later answer cannot authorize follow-on work.
The original mission and recovered constraints (including audit-only requests or
no-commit instructions) continue to govern later tasks. Each task is reviewed
before the next-work phase. The last eight finished tasks remain in its journal.

During an action, a **DRIVE** label appears in the terminal header. Clicks briefly
highlight the actual target with a `▷` cursor before activation; keyboard and
scroll actions show their key or direction. Composer instructions enter in
readable chunks, pause visibly at **Sending · Enter**, and then submit. Taking
over during that interval cancels the pending action and preserves the draft.
These action annotations are cleared before the next model observation, so they
cannot become verification evidence. The bottom footer stays unchanged.

Observations also identify the rendered panes, their coordinates, and keyboard
focus, plus actual scroll offsets and bounds. Positive scrolling moves down toward
the maximum; negative scrolling moves up toward zero. Diff exposes its file list
and code as separate targets. Action receipts report the resulting surface and pane locations, including
docked logs beside the conversation. A scroll that cannot move its target is
reported explicitly. The log belongs to the selected turn; Drive can use History
to inspect earlier checks without asking the worker to rerun them. Home/End jump
to the start/end of the focused pane, including long expanded test outputs.

The planner has only a `drive_ui` action tool. It reads terminal cells and invokes
the workbench's native keyboard and click handlers; it does not control other
desktop applications. Browser work is delegated to the coding agent's existing
tools and reviewed through their results and screenshot artifacts. With
`provider.vision` enabled, the selected Preview image is also attached to the
planner's observation. Otherwise it receives the visible image metadata.

Drive uses the currently selected provider/model, its configured reasoning
settings and full output budget, in a context separate from the coding agent.
Its inference shares the daemon scheduler, including single-slot runtimes.
`POST /v1/drive/decide` is an authenticated planning endpoint; UI operation stays
in the attached CLI. Clients requesting `Accept: text/event-stream` receive
queued/attempt notifications, thinking/text/action deltas, usage, corrections,
and one final validated result (or an error). Disconnecting cancels planning and
releases the scheduler slot. The transport never silently replays a disconnected
request. Drive's controller instead retains the failed trace, waits, observes the
current UI again, and requests a fresh decision. JSON clients remain supported.

The daemon exempts Drive planning (both SSE and JSON) and session event streams
from Bun's default 10-second HTTP idle timeout. Remote-model prompt processing or
a scheduler wait can legitimately take longer than that before producing output.
The 15-second stream heartbeats, provider deadlines, client cancellation, and
daemon shutdown still govern these requests.

Malformed model decisions, invalid evidence quotes, and premature completion
receive one validation-feedback correction attempt
before any UI action runs. The same reasoning/output settings and overall request
deadline apply. Truncated responses and provider failures are not retried through
this correction path. The controller can recover from transient socket/network,
timeout, rate-limit, and temporary service failures with at most three fresh
decisions after 1, 3, and 8 seconds. Rejected decisions/no-progress loops get up
to two fresh-observation recovery attempts with specific feedback. **RETRYING**
and the reason remain visible. Authentication, credit, and configuration failures
block instead of repeatedly spending requests; ambiguous failures after UI
execution begins never automatically replay the action. Pause cancels backoff.
Persistent failures name the reason in the saved mission's blocker message.
The daemon and CLI use the same contextual validation rules. A rejected decision's
feedback is saved and sent on Resume (including after
relaunch), so the planner can address the rejection instead of repeating it blindly.

## Taking over and resuming

- **Pause** stops Drive's next action and cancels pending planning. Coding work
  already submitted can finish. Resume re-observes the current UI.
- **Stop** halts Drive and interrupts the current coding turn when it is running
  in the mission session. **Resume** or `/drive resume` explicitly restarts the
  saved mission from a fresh observation, retaining its notes and progress.
- Pointer movement and wheel/trackpad scrolling keep Drive running. Scrolling
  actionable content invalidates pending screen-based actions so Drive re-observes before acting;
  composer text already being entered can finish while you read elsewhere.
  Scrolling Drive's own excluded notes leaves pending navigation usable.
  **Live** (or conversation **Ctrl+G**) releases a reading hold without pausing Drive.
- Typing, pasting, clicking conversation controls, or keyboard navigation pauses
  Drive and preserves your draft and reading position. Opening or closing Drive's
  own progress panel (including **Alt+J**) keeps the mission running.
- Existing tool approvals stay with the operator. Drive waits while an approval
  is on screen and continues after it is resolved.
- `/drive pause`, `/drive resume`, and `/drive stop` provide the same controls
  from the idle composer.

The latest mission is saved privately under `<data_dir>/drive/`, keyed by daemon
and workspace. Saved notes include the goal, progress, evidence, and a bounded
action journal. Incomplete missions reopen **paused**. Actions are never replayed
automatically: even a crash between inserting a prompt and sending it leads to
a new observation on resume. A process lock prevents concurrent writers.

Drive attempts a different route after skipped or no-progress actions. Persistent
no-progress/repeated identical work requests, unavailable capabilities, or 256 UI
decisions within a task/discovery phase block with saved progress. Finishing a
task, selecting the next task, or explicit Resume grants a fresh allowance.
Stopped and idle missions can be resumed. Completed missions cannot be resumed
or silently converted into continuous missions. Starting `/drive <mission>`
sets a new direction. Resuming without a saved mission shows an explanation.

## Mission-wide loop protection

The controller enforces budgets across **all** working/discovery phases. Defaults:

| Limit | Default |
| --- | ---: |
| Active mission time, including enabled waiting | 240 minutes |
| Planning/controller cycles, including failed attempts | 512 |
| Completed tasks | 16 |
| Reserved worker submissions, including consultations/corrections | 48 |
| Accounted planning + tracked worker input/output tokens | 2,000,000 |
| Cycles without new recorded outcomes or verified completion | 24 |
| Model check-ins | 24 |
| Check-in redirections | 3 |

Active time excludes explicit pauses and time with the CLI closed. A local timer
enforces it even while planning is silent or queued. A protection stop aborts
pending planning and requests cancellation of the exact tracked coder turn;
cancellation failure is reported rather than treated as success. No correction or
new task is submitted after that stop.

Input/output usage receipts replace token estimates. Cumulative receipts and
replayed events are deduplicated, and correction attempts count separately.
Until receipts arrive, input estimates and streamed-character estimates provide
accounting even for interrupted or usage-less providers. These are stopping
thresholds, not exact dollar billing or a guarantee of zero in-flight overshoot.
Worker accounting applies to turns submitted by this mission, including `/plan`;
unrelated human turns are excluded. Durable event cursors recover missed worker
usage when a session is reopened.

The text and graphics clients fetch recorded facts from the daemon before planning
and recheck them before completion or a worker submission. Facts include selected
and latest turn IDs/statuses, bounded file revisions, and the latest outcome of
each recorded check. The daemon refreshes facts again after acquiring the model
slot. Assistant summaries, clocks, and new IDs for an unchanged passing check do
not reset progress. Two worker requests with unchanged repository/check outcomes
require reconciliation with saved criteria; another rephrased request is refused.
The planner gets bounded correction opportunities to inspect, finish, or explain
an actual blocker.

Drive also detects three repetitions of a two-to-six-action navigation cycle,
repeated/reworded worker requests, and proposed tasks overlapping completed task
goals. Task comparison normalizes wording and common synonyms, and distinguishes
different file targets and work phases such as implementation versus testing.
It remains an overlap heuristic, not perfect semantic understanding; mission budgets
remain the backstop for paraphrases it does not recognize. All completed task
fingerprints remain within the mission's bounded history, beyond the eight tasks
shown in planning context. Changing notes, observation IDs, or completing/selecting
another task does not replenish these budgets.

The panel shows **MISSION BUDGET** counters and an explicit **PROTECTION STOP**
reason. Counters, loop history and a protection stop survive Pause, Resume and
relaunch. Ordinary Resume cannot clear a protection stop. Start a deliberate new
`/drive <revised mission>` after reviewing the reason. Older journals migrate with
the available task/action/usage history and explicitly indicate incomplete older
accounting; damaged protection records preserve the mission but block resumption.

Configure limits for **new missions** in user or project `config.toml`:

```toml
[drive]
max_active_minutes = 240
max_cycles = 512
max_tasks = 16
max_worker_requests = 48
max_tokens = 2000000
max_stalled_cycles = 24
check_in_interval_seconds = 120
max_check_ins = 24
max_redirects = 3
```

Values must be positive integers; task and submission histories support up to 64
tasks and 256 worker requests. A saved mission retains its original limits when
config changes. Model reasoning settings and maximum output allowance are not
lowered by these controller protections.

## Durable tasks and reopening

Drive owns a versioned task ledger. Each task has a stable ID, a goal, acceptance
criteria, worker turn IDs, and immutable completion revisions. The planner can set
criteria before the first worker submission; it cannot redefine them afterward.
A completion records those criteria, inspected quotes, the worker turn, relevant
file revisions and recorded checks. Free-form `completed`/`remaining` suggestions
cannot erase this record. Meaningful acceptance still requires model judgment;
passing checks do not automatically prove every requirement.

A completed goal includes its verification. Rephrasing it, changing “implement”
to “review,” or requesting another summary does not create a new task. Automatic
reopening requires a relevant changed file or a newly failing current check that
previously passed, plus a recorded reason. Unrelated edits do not qualify. To
explicitly request another pass yourself, use the task ID shown in the panel:

```text
/drive reopen <task-id-or-unique-prefix> <reason>
```

Reopening keeps earlier completion evidence. Resume cannot reopen completed work.
The ledger survives restart; malformed records block resumption rather than being
silently discarded. Up to 64 tasks and 16 completion revisions per task are retained
within a mission. Legacy completed records retain their summaries, but missing
historical file/check fingerprints are not invented. Starting a new mission is an
explicit new instruction, not an automatic continuation of a completed goal.

These clients need the matching daemon’s `/v1/sessions/:id/drive/facts` endpoint.
An older daemon produces an actionable restart message. Restart after active work
finishes; merely rebuilding does not update an already running process.

## Verification and scope

Drive stays in its mission workspace and selects useful follow-on work with the
coding agent. Persistent working notes carry progress across restarts; they are
not model training. Task completion requires fresh quoted evidence in the
current home-session observation or a still-valid controller inspection, and an
empty remaining-work list:

- `complete` with `basis: verified-work` (the default for older clients) requires
  an inspected Diff, execution log, review, output, or Preview. An assistant's
  statement that a change or test succeeded does not satisfy that gate.
- `complete` with `basis: answer` delivers an advisory answer in `note`, grounded
   in `observation.answerRows` or completed-answer inspection pages: text collected
   from visible completed assistant answers.
  This works with the Drive panel docked beside the conversation. Requests,
  unfinished replies, Thinking, Drive notes, and hidden/covered rows cannot
  qualify. Historical reports support a conversation-based recommendation,
  not a claim that the current repository or tests were freshly verified.

In the next-work phase, `next_task` and `idle` require a submitted consultation and
a quote from `observation.latestAnswerRows` or an inspection page with latest-answer
provenance, the latest turn's visible completed answer. Older answers,
failed/unfinished replies, and unobserved rows cannot stand
in for that assessment. `next_task` records the selected goal; the following
composer action visibly sends its implementation or review instruction.

These checks establish provenance; the model still judges whether the result
satisfies the mission.

Automated coverage includes the full UI history → composer → approved file
operation → saved Diff → completion loop, plus human takeover, stale controls,
inference cancellation, truncated decisions, journal recovery, draft preservation,
daemon shutdown, multi-task consultation/selection, bounded planning recovery,
actual Diff scrolling/navigation, multi-page controller inspections, bounded
context projection, and inspection cancellation/provenance.
Protection coverage includes journal migration/restart, rephrased task loops,
alternating navigation, silent-planner timeouts, usage deduplication, and real
single-slot check-ins through cancellation and composer delivery.
