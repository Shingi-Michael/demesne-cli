# Threads

[Documentation index](README.md) · [Agent Drive](agent-drive.md)

A chat in a project can start **threads**: up to six chats that work side by side, each in its own git worktree and branch. Threads are separate jobs. Each can be on a different thing (a feature, a fix, a doc), and you can start more as you go; they are not parts of one job that end together. The chat that started them is the **orchestrator**. It plans, hands out the work and reads the reports; the threads change the files.

Threads only exist inside a project. A plain chat on Home, the assistant's chat, and a thread itself can't start threads.

You can talk to a thread directly in its own chat, or ask the orchestrator to tell it something (`message_thread`): words reach a working thread after its current step, or start its next turn once it's back. What the orchestrator sends is a short note: it must say what it is for (`purpose`, a few words) and stay under 1,200 characters, so it names files instead of quoting them. In the thread's chat the note reads "Orchestrator · the purpose" with its few lines under it, never as something you typed, and a thread sent back shows that purpose on its line.

A thread answers only to its orchestrator and to you: it isn't on Heartbeat (no address, no mail, no `heartbeat` tool).

## Orchestrate mode

The composer's mode word has a fifth mode in project chats: **Orchestrate**. In it the chat is the project's orchestrator: it reads, plans, starts threads (`start_threads`) and passes them your rules and corrections (`message_thread`), and it never edits files or runs commands itself. The threads do all the work. The setting is kept per chat (`orchestrate` on the session).

## How a run goes

1. Ask for work made of independent jobs, or ask for threads. The model calls `start_threads` with a title, a brief and the files each thread may change. Two threads may not claim the same file or folder.
2. Each thread starts at once in its own worktree beside your checkout (dependencies are linked, not reinstalled). Its chat opens on its brief.
3. The orchestrator chat gets one **threads ribbon** at its top (pass 232). It belongs to the chat, not to one reply: it holds every thread that is still live, whatever each is on and whenever it started, and it stays in place while you scroll and talk. Under the reply that started threads sits one quiet line, "Started" and each thread's ring and name, as the record.
4. As each thread finishes, demesne commits its work on its branch and **checks it**: did it change files outside its claim, and did a check it ran fail? If so, it goes back to work once with what to fix (its line says "Sent back" and why). Then it reports to the orchestrator, which reads the summary against the brief it gave and can send it back once more with `message_thread`.
5. Each ready thread has its own **Merge**, so one that is stuck holds up nothing. If your branch moved on and a thread no longer applies, its work is laid on top of your latest commit in its worktree and the thread gets a turn to settle the conflicts; press Merge again once it's back. The model can't merge; only you can.

## The threads ribbon

The ribbon has the checklist ribbon's shape: one bar, folded until you click it.

- **The bar** counts across every live thread: "Three threads working", "Fix the jumping header asks you · 1 working · 1 ready", "Two threads need you", "Three threads ready to merge". Under the words is one fine segment per thread: moving silver while it works, amber when it asks you, red when it stopped, green when it is ready.
- **Opened**, it shows one line per thread over the chat (the chat does not move). What needs you is on top: a thread that asks you, then one that stopped, then ready ones, then working ones. Among equals the order they started in stays, so a line only moves when its thread's state changes.
- **Each line** has a ring that fills as the thread works, its name, what it is doing in plain words ("Editing csv.ts", "Asks you", "Ready · +42 −6"), its minutes while it works, and at most one next step: **Answer** for a thread that asks, **Merge** for a ready one, **Open** for one that stopped. Resting on a line says what it leaves out: the files it may touch, whether the orchestrator checked it, and how its checks went.
- **A line opens in place.** A working thread shows its last words and its last three steps, drawn as any chat draws a step, and its branch. A ready thread shows its summary, the files it changed with their counts (a file unfolds to its diff), how it was checked ("Stayed in its files · bun test passed"), and Merge. Every open line also has "Open its chat" and Delete; Delete asks once more, then stops the thread and removes its worktree and branch.
- **Merge all N** shows under the lines only when every live thread is ready. Each line keeps its own Merge.
- **A thread leaves the ribbon when it is merged** (or deleted). With no live thread there is no ribbon. The line under the reply stays: its ring turns into a tick and the word becomes "Merged". Clicking a name there opens that thread's line while it is live, or its chat once it is merged.

**A thread's question comes to you.** A thread decides small things itself. When its job turns on a choice that is yours to make, it asks once (`ask_user`) and waits for the answer. Its question card appears at the end of the orchestrator chat, labelled with the thread's name ("Write the farewell asks"), and you answer it there like any question. The ribbon's Answer points at the card. A thread that waits for a permission is answered in its own chat; Answer opens it.

**A thread's full chat is a chat like any other.** "Open its chat", or its row under the orchestrator in the sidebar, opens it as a normal tab with the thread's ring on it: the same composer, model chip and context as every chat. Its first line says whose thread it is (click the name to go back), its brief and the files it may touch. There is no split view, no thread side and no second row of tabs.

**Merged somewhere else.** If you merge a ready thread's branch yourself (a merge, a cherry-pick or a squash onto your branch), or its pull request is merged on GitHub, demesne notices within a few seconds: the thread leaves the ribbon, its name under the reply turns to a tick (resting on it says where it was merged), and its worktree and branch are cleaned up. Your checkout is looked at every few seconds while the threads are in view; GitHub is asked at most once a minute, and only for a thread whose branch was pushed. A thread with words since it finished that aren't committed is left alone.

## Threads that wait for another

A thread can be built on another: `start_threads` takes `after` with the title of a thread listed before it. Its line says "After …" and it has no chat yet; once the thread it waits for is back and checked, it starts in its own worktree on that thread's branch, so it only carries its own work and may touch the same files. It merges after the one it was built on (Merge says so if you try it first). If that thread stops, the one waiting stops too.

Words you send a thread after it finished are committed with it when you merge.

## Where it lives

- Daemon: `apps/daemon/src/threads.ts` (the `start_threads` and `message_thread` tools, claim checks), `DriveFixes.startThread` in `apps/daemon/src/drive-fixes.ts` (worktrees, the thread prompt, reports), `GET /v1/threads?from=<chat>`. Threads are worktree jobs like Drive's, kept out of Drive's own lists.
- Report format: `packages/protocol/src/thread-report.ts`.
- What a thread changed: `GET /v1/drive/fixes/<id>/changes` (`DriveFixes.changes`, `parseChanges`): each file's path, counts and hunks, at most 40 files and 400 lines a file.
- Window: `apps/desktop/workspace/thread-watch.ts` (the chat's threads; follows the open line's chat and the chat of a thread that asks), `threads-view.ts` (the ribbon, its lines, the record line, rings), `renderThreads` in `live.ts`, `#threads-ribbon` in `index.html`.
- Checks: `apps/daemon/test/threads.test.ts`, `apps/daemon/test/threads-checked.test.ts`, `apps/desktop/workspace/test/threads-view.test.ts`, and the threads scenario in `scripts/check-desktop.ts` (capture `17-threads-*`).
