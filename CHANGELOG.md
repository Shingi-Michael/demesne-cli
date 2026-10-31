# Changelog

Current release status is **0.1.0 plus unreleased development on main**. The entries below summarize delivered code as of 2026-10-05; they do not claim a new published release. See the [documentation index](docs/README.md) for current setup and commands.

## [Unreleased]

### Changed

- Questions: a set of questions has Back, which takes your last answer back to change it (a typed answer returns to the field). While the agent works past an open question, the end of its steps says "Waits for your answer" with the question, and a click goes to the card.
- A chat's tab gets a real name after its first answer: the chat's own model (thinking off) names it in 2 to 4 words from what was asked and answered ("Tab names", not the first prompt cut at sixty characters). Only chats a person is in, only once, and never over a name you gave it meanwhile; a slow or odd reply leaves the first-prompt name.
- The app runs on Electron 44.10.0 (from 44.7.2: Chromium and Node security and bug fixes), with electron-builder 26.18 and sharp 0.35.5.
- While the model works, the silver line under the turn says what it's doing and moves on as the work does: the heading of its latest thought, the step running now ("Reading live.ts"), fast steps counted ("Reading 5 files"), and what it has read so far. It is one line kept out of the turn's repaints, each phrase stays at least 2.4 seconds, phrases glide, and the shimmer slides over a bright copy of the words instead of repainting them, so it doesn't stutter. The thinking row and running steps no longer shine on their own.
- You don't have to say "Foundry": the model decides by the shape of the best answer (something to look at, click or compare gets a page, made in that turn), `foundry_save` reads as "show the person something", plan mode can make pages, and Drive, routines and mail make one only when asked. `scripts/eval-foundry-inference.ts` scores it against your own model.
- The Foundry pane is one line: the title (it opens the Foundry page), the version arrows with the version's note on hover, and icons for code, phone width, export and close. The line under the page is gone, and with it Revise (the composer does that), the separate Copy (it's in code view) and Open in Foundry (the title). An artifact keeps one chip in the chat; a later change shows "Edited Idea garden · v2" instead of another chip. A plain chat's closing line no longer says "Create in Foundry here".
- The app starts the daemon it bundles: it looked for it one folder too high, so starting a daemon fell back to whatever `demesned` was on PATH (possibly an older install), and replacing a daemon from another build never happened.
- The app keeps its daemon current: a daemon left running from an older build of the app is restarted from the bundled one once nothing is working, instead of serving old code until someone restarts it by hand. Builds now carry an id (commit and build time) that `/healthz` reports as `build`.
- The motion line's buttons no longer get rebuilt on every tick of a playing motion, so a click on Pause or a motion name that lands mid-motion isn't lost.
- A Foundry page that moves by itself (the kit's anime.js) no longer gets the first-show assembly on top of its own motion: the two animated the same pieces, anime.js cancelled the page's, and the page was left faded and short of its marks with the motion line stuck near the start.
- The agent offers Foundry while it works: when the question is how something should look or flow, it says it will mock it in Foundry and makes it, instead of describing it in words, and offers a mockup when one would help you decide.
- A Foundry page that names its motions (`demesne.motion("Arrive", timeline)`, in the kit's anime.js) gets one thin line under the page in the pane: play or pause, a scrubber, the motions by name, half speed, Replay. The frame and the pane talk by postMessage; a page without named motions shows no line.
- Foundry pages start from a kit served from inside the app (`foundry://kit/base.css`: Inter, one ink and its tints, hairlines, radii, light and dark, buttons, inputs, tables, cards; `foundry://kit/anime.js` for motion), and the design brief tells the model to lean on it: content, layout and its own accent, little CSS of its own. Pages read as one hand and cost fewer tokens to write; Export inlines the kit so the file stands alone.
- Foundry costs a chat less: the tools' text is a third shorter and no longer repeated in the system prompt, and a page's source leaves the history once the turn that made or read it is over (a one-line stub names the artifact; `foundry_read` brings the text back). A 20 KB page used to ride along with every request for the rest of its chat.
- Home's cherry blossom is a still anime-style drawing: two boughs with cel-shaded blossoms, a moon and stars at night, a blue sky with clouds by day. The swaying photographed boughs and falling petals are gone, and with them the start screen's constant redrawing.
- The agent's questions live in the chat and no longer stop it: a clarification is a card at the step that asked it, and the agent keeps doing whatever doesn't depend on the answer. Answers are picked in the card (with what each choice means, several at once where the question allows, or your own words in its field); the composer stays a composer. The answer reaches a running turn after its current step, or starts the next one, and the question folds into one "✓ Asked · question · answer" line. The card springs in word by word (anime.js), amber only on its ring, top edge and suggested answer. Interviews such as `/themefy` still wait for each answer.

### Fixed

- On the Mac, Demesne comes to the front when it opens, once. Opened from a terminal or script it could stay behind the app that launched it, with its window present but hidden.
- A chat whose project folder was removed (a deleted worktree) no longer makes the daemon throw ENOENT when the window lists its files; the daemon answers "The project folder is gone".
- The daemon log no longer grows without end: past 5 MB it moves to `daemon.log.1` (replacing the one before) when a daemon starts. One Mac's had reached 28 MB.
- The green button goes straight to full screen on the Mac: the window no longer grows, snaps back and grows again.
- The buttons drawn in Mac full screen work with the sidebar open too: its drag region was still taking their clicks.
- The assistant's Windows tasks and the window no longer fight over the daemon. `install.ps1` writes `daemon.managed` in the data directory, naming the task as the daemon's owner; while it exists the window waits for that daemon instead of starting one of its own, whatever `[daemon] auto_start` says; **Start daemon** says who runs it, and Settings › **Restart the daemon** stops it and waits for the task to bring it back. Stopping a task now stops its program too (`keep-running.ps1` ties the two with a Windows job object), and a copy left from before is stopped the next time the task starts, instead of the new daemon failing on "data directory is already in use" every five seconds.
- The assistant's chat runs only on its own model: the `[provider]` model, or the one `[assistant] model` names. Before, the window's model picker switched the daemon's model for every chat at once, so picking Codex in any chat sent the assistant's next routine, and the files it read, to Codex until the daemon restarted; a dropped provider could do the same mid-turn. Now the assistant's turns are pinned, and one that loses its provider fails instead of continuing elsewhere.
- The assistant's chat moves into its folder when the folder is trusted a moment after the chat was first opened, instead of staying without `DEMESNE.md`, notes or a to-do list for good.
- The assistant's chat no longer shows Drive: no "Drive is choosing the first step…" in an empty chat, no Drive word in its title bar, no Drive line or branch notes, and the model there is told nothing of Drive.
- The conversation no longer flickers while the model writes a command: only the step's words change as they arrive, instead of the whole turn being redrawn every few characters.
- A commit's tree always shows the branch you're on, even on its first commit next to three other branches, and long labels end in "…" inside their column.

### Removed

- Proof marks: answers no longer carry underlined claims, the "N proved · M not checked" line, Prove it, or the extra model call after each answer that made them. The daemon's proof pass and `/proofs` route, the `turn.proofs` events, the Settings › Models switch and `[agent] proof_marks` are gone (a config that still names the key loads and ignores it).
- Self-build (Try it here, Your look · Keep · Go back): the window no longer rebuilds its own page from the open project or swaps the installed app, and chats in the Demesne checkout are no longer told to leave building and launching to the app. An agent in that project builds and relaunches Demesne like any other command.
- The terminal app: the `demesne` command (terminal chat, `setup`, `doctor`, `auth`, `prompt`, `drive`, `daemon`), `install.sh` and the CLI release tarballs. Demesne is now only the desktop app, which carries its own daemon. Sign-in and setup live in the app under Settings › Providers.

### Changed

- Clear glass on macOS 26: the window is see-through with no blur, so the wallpaper shows sharp behind the tint, instead of the older frosted blur. `DEMESNE_GLASS_VARIANT=<n>` puts Apple's liquid glass behind it instead (through the MIT add-on electron-liquid-glass). Older Macs, or a material named in `DEMESNE_VIBRANCY`, keep the frosted glass.
- Full screen on the Mac always stays on the desktop's Space, green button included, so the glass never turns black.
- Glass you can see: the Glass slider now runs from nearly see-through to solid (default 15), so full screen still looks like glass. The window's top edges catch a light rim, a soft sheen falls from the top, and answers and code get a soft backing while the glass is clear. On the Mac the blur under the glass is now `hud`, which lets the most wallpaper colour through; `DEMESNE_VIBRANCY` picks another material to try.
- Foundry shows what it made the way Claude shows an artifact: a chip in the conversation (kind, title, version) and the page itself in a pane beside the chat, edge to edge, with one line of controls above it (title, version arrows, Preview · Code, phone width, close) and one below (version note, Copy, Export, Revise, Open in Foundry, Make this the latest). A new artifact opens the pane by itself, a new version moves it on, Esc closes it, and each chat remembers whether it was open. The boxed 480px card that sat in the conversation under each save is gone.

### Added

- The desktop window can use a daemon on another computer without an environment variable: put that daemon's token in `remote-daemons/<host>_<port>.token` in the data directory, and it is sent only to that host and port. [The assistant guide](docs/assistant.md#step-5-use-it-from-anywhere) shows how to reach the PC's daemon from anywhere over Tailscale Serve.
- The assistant's Windows installer can use the llama-server you already run: `-LlamaArgs` takes your own flags (a Vulkan build, the model pinned to one GPU), and `-NoModel` installs only the daemon's task for a server you start yourself. It ends by checking that the model answers where Demesne's config looks for it.
- The assistant has its own place: **Assistant**, under New chat in the sidebar, opens its one continuous chat instead of a new chat per question. Routines written from that chat run in it, each as a quiet line with its time and name ("↗ phone" when the answer goes to your phone), each day starts with a day line, and the title bar names the folders it may read. The chat lives in `~/Assistant` (or `[assistant] home`) once trusted, and never joins the list of chats.
- The commit and merge tree spreads across the chat column inside a hairline frame. A top line names the project and branch, counts the branches it leaves out and has a replay; one line underneath carries the command and then the result. Text is shorter: branch names and files in mono, commit words in Inter, Drive's branches without their `drive/` prefix and random tail, and long names cut at a word. It re-fits when the window is resized.
- Commit and merge trees now replay the whole history after success in a full-width subtle frame. Real branch names and commit messages wrap below the graph; spaced hash labels stay clear of paths. Expand branch history or the committed file diff, replay with the keyboard, and resize without losing open details. File-flight and waiting animations are removed.
- Foundry assembles a page in front of you: while the model writes it the pane opens on the title, and on the save the page's pieces spring into place in reading order (anime.js, bundled with the app and served into the sandboxed frame for that first show only); a revision settles only the pieces the edit changed; a Markdown document assembles the same way in the pane; the chip lands in the chat as the page finishes. Reopening, walking versions and reduced motion show the page plainly.
- Foundry revises like a file: `foundry_edit` applies exact find-and-replace edits to the version the model read, and `foundry_save` takes the same `base_version`, so a version you changed by hand (Edit source) or in another chat is never overwritten; the model is told to read the latest version and carry its change onto it. Artifact frames may now load pinned libraries from cdnjs, jsdelivr and unpkg and Google Fonts, so charts, React and real typefaces work; everything else stays blocked. The tools carry a design brief (custom-property colours with a dark set, hairlines over outlines, phone width, no stock AI looks, Demesne's tokens for Demesne UI).
- Drive's word in the title bar: while Drive makes a branch elsewhere the chat's title bar ends in a breathing dot and the mission, green "Ready · mission" once the branch is ready; click opens Drive's chat. The strip that sat on the panel's right edge is gone, so the chat keeps its full width.
- Codex provider: sign in to your Codex plan under Settings › Providers and Demesne talks to Codex's backend directly, with Codex's own OAuth (`localhost:1455`, PKCE) and no Codex app or CLI. Models are `codex/<slug>` from the plan's live catalog, usage counts against the plan's 5-hour and weekly windows rather than credits, and the plan's state shows in the model picker. A sign-in left by the earlier managed Codex home carries over once. The ChatGPT provider stays as the credit-metered route.
- Workflows: a markdown file in `.demesne/workflows/` (or `~/.demesne/workflows/`) lists steps, and `/<name> <goal>` runs them in order as one Drive mission in its own worktree. A step's `check:` command is run by Drive itself and must pass (or fail, with `expect: fail`) before the next step starts. The live block shows each step's check, and the receipt counts steps.

- Releases include the desktop app: `demesne-desktop-darwin-arm64.zip` for Apple silicon Macs and `demesne-desktop-linux-amd64.deb` for Ubuntu 22.04/24.04, so installing demesne no longer needs Bun or Rust.
- Label a GitHub issue `drive` to queue it for Drive: open ones become Next proposals, and the PR Drive opens for one says `Closes #n`.
- Away mode: **Run top 3 away** (a link in the Next heading) has the daemon work through Drive's top proposals one after another, each in its own worktree. Finished branches fold into one "While you were away" card, a line each; click one to open its Apply / Open PR / Discard.
- Drive keeps working when you close the window: a running mission is handed to a background process with no window, which carries it to the end and commits a worktree mission for review. Opening the project again takes it back and resumes it in the window.
- Model scoreboard: the model picker shows how each model has done on your own work over the last 30 days (turns finished, tool calls without errors, speed, checks passing, Drive runs kept), and `demesne models scoreboard` prints it as a table, marking local models.
- Drive learns its own accuracy: every proposal you Run records whether it landed and how long it took, and Next ranks with this project's landing rate per confidence level and scales time estimates by how far off they have been. The Next heading shows the hit rate.
- Drive mission receipts: the review card shows how many tasks the recorded checks verify, and Copy receipt / Open PR carry a Markdown receipt that separates verified work from claims.
- `/drive` missions work in their own git worktree and session, then commit the result for Apply / Open PR / Discard and return you to your session. `--here` keeps a mission in the current session.
- Drive Next's **Run** works in its own git worktree and branch, with the breakage-fix card's Apply / Open PR / Discard. Your checkout is untouched until you apply it; outside git it falls back to a bounded mission.

- `/themefy` adaptive composer interviews, instant validated palettes, saved custom themes and persistent theme undo in the shared desktop/Ghostty interface. Theme interviews have a restricted tool scope and stay out of coding context.

- Default Ghostty graphics UI using offscreen Electron/Chromium and Kitty image tiles, with browser typography, Markdown, syntax highlighting, math, themes and responsive scaling.
- Files/source navigation, recorded and workspace diffs, verification freshness and reruns, command inspection/stop, image zoom/pan/reference comparison, history and context panels.
- Durable image artifacts from tools, MCP and a separately configured image backend; authenticated content routes and optional model vision hydration.
- ChatGPT account sign-in with private OAuth storage/refresh, account model discovery, a Responses adapter and supported reasoning choices; OpenRouter and OpenAI-compatible providers remain available.
- Direct GPT-6.1 Sol selection through ChatGPT sign-in, with an account access check when the catalog omits it and complete tool calls handled by Demesne.
- Read-only subagents with independent model selection and per-provider inference queues/slot limits, allowing supported servers to service concurrent tasks without loading a model per agent.
- Drive task criteria, completion evidence, persistent project memory, bounded/continuous modes, checkpoint-based live reviews and direct daemon control.
- Drive NEXT: collected workspace/repository signals, evidence-linked model proposals, Run/Plan first/Not now/Never actions, start-screen suggestions and rail counts.
- Validated manual compaction with durable checkpoints, replay, cancellation and retained original history.

### Changed

- A sub-agent is one step on the guide: "Agent · task" with "N steps" on the right while it works and "✓ N steps · time" when done; click it and its own steps unfold one level in, drawn like the turn's (reads fold as Explored), ending in what it found. The "Sub-agent trace" box, its arrow lines and thinking are gone; the saying that cycles after the task while the agent works stays. Sub-agents run with thinking off, whatever the chat chose.
- Normal interactive `demesne` launches the graphics UI; non-interactive use retains the streaming CLI. The former text workbench and its `ui:*` preview scripts are removed.
- Graphics delivery uses GPU rasterization, parallel compressed RGBA tile encoding, local file transfer when supported, backpressure and incremental state updates.
- Plain `/drive MISSION` is continuous by default. Explicit `--bounded` and NEXT’s Run action stop after the bounded mission is verified.
- Documentation now separates current behavior, configuration, auth, concurrency, previews, operations and historical notes, with linked source references and flow diagrams.
- Removed the separate Codex runtime provider, CLI auth commands and executable dependency. Legacy `auth = "codex"` sections are retired during config loading; remaining providers and saved sessions are preserved, and the next config write backs up the original.

### Removed

- The Ghostty terminal interface is removed, along with its Electron renderer and Kitty image transport. The desktop window is now the interface. `demesne` in a terminal opens it on the current folder, and `demesne prompt` remains for scripts.

### Fixed

- A `/drive` mission in its own worktree no longer stops at its first decision with "Drive observations must belong to the mission's workspace": Drive now observes the worktree session at the worktree's root.
- Custom commands in `.demesne/commands/` show in the desktop app's slash list and send their prompt; the desktop app didn't load them before.
- Linux graphics startup now installs a missing source runtime, verifies sandboxed rendering, preserves desktop authentication variables, and diagnoses sandbox/display/library failures. Explicit helper repair uses a protected, verified copy; workspace permission errors name the folder and a non-recursive remedy. Linux graphics CI covers Ubuntu 20.04/24.04 userlands and packaged startup.

- Responses streams with completed output items but empty terminal output no longer lose their tool calls. Truly incomplete or malformed tool calls are still rejected before execution.
- Per-provider capacity no longer requires all configured backends to share one global inference allowance.
- Drive reviews acquire a provider slot before reading fresh worker evidence and reject stale corrections; completed tasks require explicit or evidence-backed reopening.
- The NEXT/composer pixel mismatch uses a stable compositor layer without hiding pixels or increasing capture tolerance.
- Renderer output-pipe closure, asynchronous `EPIPE` and startup/shutdown races now terminate cleanly instead of displaying an uncaught Electron main-process exception. Packaging includes the pipe lifecycle helper.


## [0.1.0] - 2026-09-18

### Added

- Durable local daemon owning model requests, workspace tools, approvals, SQLite
  state, and resumable SSE event streams.
- Streaming terminal client with a fixed footer, phase-aware beacon, ANSI- and
  grapheme-safe response pacing, and a shared slash-command grammar.
- Bounded coding tools: listing, paged reads, batch reads, ripgrep search,
  create/append/batch edits, atomic writes, git status/diff, move, delete, and
  approved host commands with background handles.
- Per-call approval broker with session-scoped write grants and conflict-checked
  turn undo.
- Deterministic context planning with schema-3 reduction, cache-aware
  delayed-hard planning for strict llama.cpp profiles, and provider-reported
  usage inspection.
- Runtime profile verification for strict Ollama and llama.cpp deployments.
- Measurement harnesses for provider throughput, long context, retrieval,
  scheduling, context reduction, and staged memory.
