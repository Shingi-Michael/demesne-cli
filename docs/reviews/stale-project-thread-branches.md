# Stale project-thread branches

Reviewed against local `main` at `9393f70` (2026-10-27). Both named refs still
exist and each has one commit not reachable from `main`, dated 2026-10-17.
The stale-branch finding is real, but neither branch needs merging: their useful
behavior has been superseded on main. This is a local-ref review, not a check of
remote branch state or uncommitted work in other worktrees.

## Recommendations

### `claude/project-thread-0u385m`: superseded; recommend deletion

Outstanding commit: `9ad8c57465c7a008f0f9c6fa3ae376c227aae6a7`,
“Desktop: Settings as its own window, pages on the left”.

The patch changes `apps/graphics/live.ts` and `live.css`, desktop workspace CSS,
and the desktop check/screenshot scripts. It adds settings navigation and search,
inline mode/approval/theme controls, provider accounts, session history/cleanup,
and connection information, keeping Settings open during changes. Despite the
commit title, this is an in-renderer modal, not a separate native window.

Main subsequently landed `06d80ba` (#187), “Settings as one sheet with sections
and inline controls”, then `9117b87` (#275), “Settings as a page: thirteen
sections backed by config.toml and the daemon”. Current
`apps/desktop/workspace/settings-page.ts` implements navigation, cross-section
search, theme selection/undo, permissions, model/provider controls, archived chats,
cleanup and daemon information. `docs/desktop.md` documents the replacement
page and its keyboard behavior. The old source location was folded into desktop
by `c693d0c` (#200).

No unfinished feature in this patch warrants recovery. Its five-page modal,
select-based theme picker, styling and old selectors are obsolete; merging them
would reintroduce the previous settings surface and obsolete smoke-test steps.
Do not merge or cherry-pick it. Delete the branch after its owner confirms there
is no uncommitted work to retain.

### `claude/project-thread-hj0xqh`: superseded; recommend deletion

Outstanding commit: `1a58d3104b9bb1e4d2f17f215b7ff44a8a0fed60`,
“Desktop: six recent chats, each with a × that deletes it at once”.

The patch caps the sidebar at six chats, adds a hover/focus removal button and a
host `delete-session` handler that archives rather than permanently deletes,
removes the older “N more” menu, and updates the desktop documentation.

Main landed `e8ad032` (#181), “delete a conversation from its sidebar row; list
six”, followed by `ce9bb56` (#185), keyboard delete and undo, and `e761092`
(#186), a further sidebar revision. Current `apps/desktop/workspace/live.ts`
retains `SIDEBAR_ROWS = 6`, now per group, and a row-level Archive control hidden
for working chats. Its `delete-session` dispatch removes a row immediately and
uses the `archive` API, with delayed archival/undo for another chat. Search
reaches all matching chats; Show more expands inline rather than opening the
old menu. These evolved behaviors are documented in `docs/desktop.md`.

The original commit is not an exact patch-equivalent merge (`git cherry` reports
`+`), but its useful intent is present. Recovering its old host endpoint or
removing the newer inline expansion would be a regression, not unfinished work.
Do not merge or cherry-pick it. Delete the branch after the same owner/worktree
check.

## Verification and limits

Inspected both complete outstanding patches, their `main..branch` histories,
main's replacement history, current settings/sidebar code and documentation.
Ran `bun test apps/desktop/workspace/test/settings-page.test.ts` for the current
settings implementation: **13 passed, 0 failed**. This review changes
only this report, not runtime code. No dependency changes, merges, branch deletions,
commits or pushes were performed. Full desktop/Electron smoke checks were not run;
the sidebar conclusions are source/history comparisons, not a new UI sign-off.
