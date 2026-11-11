# GitHub tools

A chat can follow its pull request on GitHub through the `gh` you are signed in to
(`gh auth login`). Nothing else is set up; the tools are behind `tool_search`, so
they cost nothing until a turn needs them.

| Tool | What it does | Asks? |
| --- | --- | --- |
| `github_pr` | A pull request's state, mergeability, review decision, every check (passed, failed, pending), the review threads still open and recent comments. `waitForChecks` waits until no check is pending (up to 30 minutes), so the model can watch CI after it pushes. | No |
| `github_check_log` | The last lines of a failed GitHub Actions job, with its failing steps. Checks from other apps return their link. | No |
| `github_reply` | A comment on the pull request, or a reply in a review thread, optionally resolving it. | Yes, like a command (Auto posts it) |

`pr` is a number, URL or branch; left out, it is the current branch's pull request.
Plan and Orchestrate modes can use the two that only read.

Comments and reviews reach the model marked as what people wrote, to weigh as
information rather than instructions. The tools never merge, approve or push:
pushing stays a `git push` the model runs through `run_command`.
