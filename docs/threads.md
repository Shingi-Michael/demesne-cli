# Threads

[Documentation index](README.md) · [Agent Drive](agent-drive.md)

A chat in a project can split a job into **threads**: up to six chats that work side by side, each in its own git worktree and branch. The chat that started them is the **orchestrator**. It plans, hands out the work and reads the reports; the threads change the files.

Threads only exist inside a project. A plain chat on Home, the assistant's chat, and a thread itself can't start threads.

You can talk to a thread directly in the right half, or ask the orchestrator to tell it something (`message_thread`): words reach a working thread after its current step, or start its next turn once it's back.

A thread answers only to its orchestrator and to you: it isn't on Heartbeat (no address, no mail, no `heartbeat` tool).

## Orchestrate mode

The composer's mode word has a fifth mode in project chats: **Orchestrate**. In it the chat is the project's orchestrator: it reads, plans, starts threads (`start_threads`) and passes them your rules and corrections (`message_thread`), and it never edits files or runs commands itself. The threads do all the work. The setting is kept per chat (`orchestrate` on the session).

## How a run goes

1. Ask for work made of independent jobs, or ask for threads. The model calls `start_threads` with a title, a brief and the files each thread may change. Two threads may not claim the same file or folder.
2. Each thread starts at once in its own worktree beside your checkout (dependencies are linked, not reinstalled). Its chat opens on its brief.
3. The window splits into even halves. On the left, the orchestrator chat shows the thread list: a ring per thread that fills as it works, amber when it waits on you, and one line saying what it is doing. On the right is the thread you picked, live, as a chat like the left one: the same composer, and a model chip that sets the thread's own model and effort (a thread starts on the orchestrator's). Its head holds only the thread's name, branch and state, **Merge** once it is ready, and ×. Tabs across the top of the right half switch between threads too (⌘[ and ⌘] step through them). Click a row to switch; × closes the right half. Nothing else moves it, so a thread that needs you turns amber but never pulls the right half over.
4. As each thread finishes, demesne commits its work on its branch and **checks it**: did it change files outside its claim, and did a check it ran fail? If so, it goes back to work once with what to fix (its row says "Sent back" and why). Then it reports to the orchestrator, which reads the summary against the brief it gave and can send it back once more with `message_thread`. A thread that came back clean, with its checks passing, says **Checked**. When the last one is back, the orchestrator says how each did and suggests the order to merge.
5. Each ready thread has its own **Merge** on its row, so one that is stuck holds up nothing; once they are all back, the bar above the composer also offers Merge all. If your branch moved on and a thread no longer applies, its work is laid on top of your latest commit in its worktree and the thread gets a turn to settle the conflicts; press Merge again once it's back. The model can't merge; only you can.

Each row shows four short marks for where the thread is: working, back, checked, merged (the third is pink while it is sent back). The threads also hang under their orchestrator chat in the sidebar, each with its ring; clicking one opens it on the right.

## Threads that wait for another

A thread can be built on another: `start_threads` takes `after` with the title of a thread listed before it. It shows "Waits for …" and has no chat yet; once the thread it waits for is back and checked, it starts in its own worktree on that thread's branch, so it only carries its own work and may touch the same files. It merges after the one it was built on (Merge says so if you try it first). If that thread stops, the one waiting stops too.

Words you send a thread after it finished are committed with it when you merge.

## Where it lives

- Daemon: `apps/daemon/src/threads.ts` (the `start_threads` and `message_thread` tools, claim checks), `DriveFixes.startThread` in `apps/daemon/src/drive-fixes.ts` (worktrees, the thread prompt, reports), `GET /v1/threads?from=<chat>`. Threads are worktree jobs like Drive's, kept out of Drive's own lists.
- Report format: `packages/protocol/src/thread-report.ts`.
- Window: `apps/desktop/workspace/thread-watch.ts` (follows the open thread's chat), `threads-view.ts` (list, rings, Merge bar), `renderThreads` in `live.ts`.
- Checks: `apps/daemon/test/threads.test.ts`, `apps/desktop/workspace/test/threads-view.test.ts`, and the threads scenario in `scripts/check-desktop.ts` (capture `17-threads-*`).
