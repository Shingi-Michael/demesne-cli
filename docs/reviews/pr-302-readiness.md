# PR #302 readiness review

**Recommendation: hold for the smoke-test regression and completion of the stack.**
The normal notification paths work in the checks below, but this is not a green
end-to-end or native OS delivery sign-off.

Reviewed 2026-10-27: [PR #302](https://github.com/Shingi-Michael/demesne-cli/pull/302),
head `679e3085f26d65c8eb989155cb9926878c0c7df0`, all six changed files and the
host/storage code feeding notification snapshots. No production code changed.

## Merge blockers

### P1: the new completion default breaks the desktop smoke suite

`apps/desktop/workspace/settings-page.ts:88` now defaults `done` to `true`, but
`scripts/check-desktop.ts:774–776` still clicks the completion switch and waits
for the saved value to become `true`. Starting with fresh preferences, the click
actually saves `false`, so the suite times out with **A chat finishes turns on**.
This prevents the later question-notification and focused-completion assertions
from running. This is a regression introduced by the new default, not an OS
notification failure.

Make the smoke test assert the initial enabled state, toggle it off and verify
that state, then toggle it back on and verify persistence. Run the complete
smoke suite afterward; the later tests cannot currently provide evidence.

### Stack dependency remains open

At review time GitHub showed #302 open, targeting
`fix/linux-navigation-and-panel-depth`, with **Checks (0)**. Its description
explicitly requires the still-open #301 to merge first, followed by retargeting
or rebasing #302 onto main. There is no passing GitHub check result to cite;
the author's typecheck/build claims are not CI runs. Merge the prerequisite and
validate the final integration revision before approving this for main.

## Additional confirmed input-path defects (inherited, not introduced here)

These are existing logic problems in the feature this PR promises to support;
they should not be attributed to its added lines. Fix them or explicitly track
and accept these limits before claiming reliable background input alerts.

- **A second request in one turn is lost.** `live.ts:3458` keys waits by session
  ID and session `updatedAt`, and `3466–3467` retains that key after the wait
  clears. A running chat can request approval, receive an answer, and then ask
  another question without changing its session timestamp. Only the first wait
  notifies. Storage's `requestToolPermission` and `requestQuestions`
  (`packages/storage/src/index.ts:1470–1552`) insert request events without
  updating `sessions.updated_at`; the host copies that timestamp into snapshots
  (`workspace/host.ts:317–326`). Use request identity/event time rather than a
  session metadata timestamp. Test two distinct requests in the same turn,
  including a first request suppressed while focused.
- **A turn begun before launch cannot notify a later input request.**
  `live.ts:3437,3450` filters the entire session by its timestamp relative to app
  startup. If a daemon turn started a minute before launch, a genuinely new
  approval/question after launch is skipped because requests do not update that
  timestamp. Initial-snapshot suppression already exists at `3466`; distinguish
  old requests from new ones using request/event identity and time. Test opening
  the app during a running daemon turn, then requesting input after startup.

The review harness executes the actual `renderNotifications` function extracted
from the supplied checkout, with fake snapshots, focus, and desktop IPC. Its last
two checks assert the observed defective behavior; a passing harness means the
findings were reproduced, not that the feature is correct.

## Validation performed

All commands used the exact PR head in a disposable detached worktree and reused
existing dependencies without installing or upgrading anything.

- `bun run typecheck`: **passed** once isolated workspace package links resolved
  to the reviewed sources. Initial missing/mismatched package-resolution errors
  were local checkout setup issues, not PR findings.
- `bun test apps/desktop/workspace/test/settings-page.test.ts`: **11 passed**.
- `bun scripts/prepare-desktop.ts`: **passed** on macOS arm64.
- `bun scripts/check-desktop.ts`: first stopped at `check-desktop.ts:545` because
  the fixture assumes `master` while this machine initializes `main`. This is an
  unrelated portability issue. Reran without changing global Git configuration:

  ```sh
  env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=init.defaultBranch \
    GIT_CONFIG_VALUE_0=master bun scripts/check-desktop.ts
  ```

  This rerun passed the unfocused approval and default-completion notification
  assertions at lines 396 and 436, then reproduced the completion-toggle timeout
  above. **The full smoke suite did not pass.**
- `bun scripts/review-pr302-notifications.ts <PR-checkout>`: **six
  characterization checks passed**, covering background wait/completion routing,
  selected question/approval wording, focus suppression, saved opt-outs, and the
  two inherited failures. The harness is retained with this review for replay.

Electron smoke tests replace `Notification.show` and force `document.hasFocus`;
they prove application-to-main-process routing, not real OS banners. Actual
minimized/hidden-window delivery, notification-click restore/navigation, and
Linux/macOS/Windows native delivery remain unverified. The question and focused
completion cases were checked in the isolated renderer harness, not reached in
the end-to-end suite. No dependency, production implementation, commit, push,
or GitHub review/comment was changed by this review.
