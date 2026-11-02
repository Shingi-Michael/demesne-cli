# Threads

[Documentation index](README.md) · [Agent Drive](agent-drive.md)

A chat in a project can split a job into **threads**: up to three chats that work side by side, each in its own git worktree and branch. The chat that started them is the **orchestrator**. It plans, hands out the work and reads the reports; the threads change the files.

Threads only exist inside a project. A plain chat on Home, the assistant's chat, and a thread itself can't start threads.

## How a run goes

1. Ask for work made of independent jobs, or ask for threads. The model calls `start_threads` with a title, a brief and the files each thread may change. Two threads may not claim the same file or folder.
2. Each thread starts at once in its own worktree beside your checkout (dependencies are linked, not reinstalled). Its chat opens on its brief.
3. The window splits into even halves. On the left, the orchestrator chat shows the thread list: a ring per thread that fills as it works, amber when it waits on you, and one line saying what it is doing. On the right is the thread you picked, live, with its own composer so you can steer it. Click a row to switch; × closes the right half. Nothing else moves it, so a thread that needs you turns amber but never pulls the right half over.
4. As each thread finishes, demesne commits its work on its branch and the thread reports back to the orchestrator as one quiet line. When the last one is back, the orchestrator says whether each stayed inside its files and passed its checks, and suggests the order to merge.
5. Once they are all back, the bar above the composer offers **Merge**. It applies each ready thread onto your branch in order and stops at the first that doesn't apply cleanly. The model can't merge; only you can.

A thread you stop is discarded with its worktree and branch. Words you send a thread after it finished are committed with it when you merge.

## Where it lives

- Daemon: `apps/daemon/src/threads.ts` (the `start_threads` tool and claim checks), `DriveFixes.startThread` in `apps/daemon/src/drive-fixes.ts` (worktrees, the thread prompt, reports), `GET /v1/threads?from=<chat>`. Threads are worktree jobs like Drive's, kept out of Drive's own lists.
- Report format: `packages/protocol/src/thread-report.ts`.
- Window: `apps/desktop/workspace/thread-watch.ts` (follows the open thread's chat), `threads-view.ts` (list, rings, Merge bar), `renderThreads` in `live.ts`.
- Checks: `apps/daemon/test/threads.test.ts`, `apps/desktop/workspace/test/threads-view.test.ts`, and the threads scenario in `scripts/check-desktop.ts` (capture `17-threads-*`).
