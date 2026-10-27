# PR #296: Windows login startup review

## Scope and status

Reviewed [PR #296](https://github.com/Shingi-Michael/demesne-cli/pull/296)
at head `3d8c79a74b2907d49b466b4fcf297af4a8ed550e` on 2026-10-27.
The task is still relevant: GitHub reports the PR open, draft, unmerged and
mergeable. There are no submitted reviews, check runs or commit statuses at
this head. The combined status API says `pending` with zero statuses; this is
absence of evidence, not a failed check. The repository's CI workflow is
manual-only and runs on Ubuntu, so opening this PR does not validate Windows.

The existing PR already adds the installer, restart wrapper, model arguments,
matching config, consistency tests and user guide. This review does not copy
those files or implement a competing startup mechanism.

## Findings to resolve in the existing PR

### P1: source fallback breaks when the checkout path contains spaces

In `scripts/assistant/install.ps1`, the Bun fallback writes `run` and the full
`apps\daemon\src\main.ts` path as separate lines in `demesned.args`.
`Read-Arguments` in `scripts/assistant/keep-running.ps1` splits **every** line
at its first whitespace and appends both pieces as separate arguments.
For a checkout at `C:\Users\Mike\My Projects\demesne-cli`, Bun therefore
receives `C:\Users\Mike\My` and `Projects\demesne-cli\apps\daemon\src\main.ts`
instead of one script path. The model's `--model PATH` format does not have
this particular problem because the split separates its flag from its value.

Use an unambiguous argument-array format shared by installer and runner, or
otherwise preserve positional paths without splitting them. Add an executable
PowerShell regression that checks the arguments received by a harmless child
program, including the source fallback from a checkout containing spaces.
The current TypeScript tests compare static config/args and file existence;
they never exercise this parser or launch a process.

### P2: the advertised log rotation does not bound a running service's log

The wrapper checks the 20 MB threshold only before launching its child.
`& $Program @arguments *>> $Log` then blocks until the child exits. A healthy
llama-server or daemon can run for days, during which the log can grow past
20 MB without rotation. This undermines the bounded logging claim for the
always-on case.

Rotate while collecting output (with a defined retention limit), or explicitly
document that rotation happens only between launches and provide an operational
limit. Verify with a continuously running noisy child, not only one that exits.

### P2: model placeholder substitution interprets replacement metacharacters

The installer's `-replace '@MODEL@', $Model` uses .NET regex replacement
semantics. A valid model filename containing `$&`, for example
`C:\models\Qwen$&.gguf`, substitutes the matched text `@MODEL@` into the
resolved filename instead of preserving the literal path. `Test-Path` can
succeed on the original model while the generated arguments point elsewhere.

Use literal string replacement for this literal placeholder and cover spaces
and dollar-sign sequences in a model path.

## Evidence required before leaving draft

The PR author reports `bun run typecheck` passing and `bun test` with 950 pass,
0 fail across 144 files. Those are author-reported results, not Windows runtime
evidence. The PR explicitly says PowerShell and the Windows daemon were not
run. Neither `powershell` nor `pwsh` is available on this review host either.
Keep the PR draft until the following results are recorded on the target Windows
machine, using the documented `powershell.exe` host (not only PowerShell 7):

- Run `install.ps1 -DryRun` with explicit executable/model paths. Confirm it
  changes no tasks, config or assistant state. Repeat with paths containing
  spaces and the literal replacement case above.
- Install as the intended non-elevated user; verify both tasks are registered
  for that user and become Running. Confirm the generated argument files,
  selected daemon executable and config match the dry run.
- Check the daemon health endpoint, model `/v1/models`, and one completed local
  model turn. Task state alone only proves the restart wrapper is alive; it can
  remain Running while its child repeatedly fails.
- Log out and back in; confirm startup without an open terminal/window. Kill
  each child and verify one replacement appears after about five seconds.
- Stop each scheduled task and confirm its child exits and releases the GPU or
  daemon port. The wrapper comment promises this, but the guide already warns
  that llama-server might remain in Task Manager; establish the actual process
  tree behavior rather than assuming it.
- Re-run installation with a task already running, then verify which arguments
  are active. `IgnoreNew` plus `Start-ScheduledTask` does not establish that an
  existing wrapper has reloaded the argument file it read before its loop.
- Complete a scheduled routine with the window closed, as the guide describes,
  and inspect both logs for restart loops or unsupported Windows operations.

These are validation gates, not claims that all of these behaviors are broken.
The existing guide's warning about Unix-shell assumptions remains appropriate;
a Windows daemon smoke test is required before promising an unattended service.

## Verification of this review

This branch changes only this review note. Findings above are static code-review
results at the pinned PR head, not reproduced PowerShell failures. The PR's
PowerShell scripts and added tests are not present on this branch and were not
executed here. `bun run typecheck` passed on this branch. Whitespace checks
(`git diff --check` and a no-index check of this new note) emitted no diagnostics;
the no-index command returned 1 because the file is new. No dependencies,
startup tasks or user configuration were changed.
