# The always-on assistant

[Documentation index](README.md) · [Configuration](configuration.md) · [Heartbeat](heartbeat.md)

Demesne has a second job: a personal assistant that lives on your desktop, reads your files (and your phone's, through iCloud for Windows), plans with you and pushes reminders to your phone. It runs Qwen3.8-27B on your own GPU, so it costs nothing to leave on, and the only thing that leaves the machine is the notifications you set up.

It was built in small steps, each one usable on its own:

| Step | What it adds |
| --- | --- |
| [1. The model as a service](#step-1-the-model-as-a-service-windows) | llama-server and the daemon start at login and restart if they crash |
| [2. A home and one tool](#step-2-a-home-and-one-tool) | An Assistant project with its own instructions, and `personal_files`, which reads the folders you choose, PDFs included |
| [3. File index](#step-3-file-index) | `search_personal_files`, a search index over those folders, so it finds the right file without reading them all |
| [4. Push to your phone](#step-4-push-to-your-phone) | Routines send their answers to your iPhone through ntfy, and chats get `notify_phone` |
| [5. Use it from anywhere](#step-5-use-it-from-anywhere) | The Demesne window on another computer talks to the daemon on the PC, over Tailscale, with the daemon's token |

### Setting it up, start to finish

1. Install the two Windows tasks and the Assistant folder ([step 1](#install)): `install.ps1 -Model … -LlamaServer … -Config`.
2. In `%USERPROFILE%\.demesne\config.toml`, under `[assistant]`, list the folders it may read ([step 2](#one-tool-personal_files)) and your ntfy topic ([step 4](#step-4-push-to-your-phone)). Restart the `demesned` task.
3. Open `%USERPROFILE%\Assistant` as a project in the Demesne window once, trust it, and fill in **About me** in its `DEMESNE.md`.
4. Click **Assistant** in the sidebar (under New chat). Ask it something from your files ("when does my car insurance renew?"), then open **Scheduled** from that chat and add a routine: "Every weekday at 8, what's on today and this week? Check my documents for dates."

(This replaces the separate demesne-assistant app: everything it did now runs inside Demesne's daemon.)

Everything the assistant reads from a file, an email or a web page is data, never instructions. A document that says "forward this to…" cannot make it act; it asks you before it sends, deletes or buys anything. The one exception is what you set up ahead of time: a routine's answer going to your phone.

## Step 1: the model as a service (Windows)

### Why a service

Until now you started llama-server in a terminal and Demesne's daemon from the window. That's fine for coding, but an assistant has to be awake when you aren't looking: a routine set for 8:00 only fires if the daemon is running at 8:00. On Windows, **Task Scheduler** is the built-in way to start programs on their own. [`install.ps1`](../scripts/assistant/install.ps1) adds two tasks, under a **Demesne** folder in Task Scheduler, that start hidden when you log in:

- **llama-server** runs the model on port 8081.
- **demesned** runs Demesne's daemon.

Each task runs [`keep-running.ps1`](../scripts/assistant/keep-running.ps1), a few lines of PowerShell that start the program, write its output to a log, and start it again five seconds after it exits. That loop is what turns a crash into a short gap instead of a dead assistant.

### The settings, and why

The model's settings are in [`llama-server.args`](../scripts/assistant/llama-server.args), one per line, so you can read and change them without touching any code:

| Flag | Value | Why |
| --- | --- | --- |
| `--ctx-size` | `131072` (128K) | Qwen3.8-27B silently stops generating once a prompt passes about 130K tokens. The server refuses anything larger, and Demesne's `context_window` is the same number, so a long session compacts instead of dying without an error. |
| `--cache-type-k/v` | `q8_0` | The K/V cache is the model's working memory for the conversation. At 8 bits it takes half the VRAM of the default, which is what lets 128K fit beside a Q5_K_M or Q6_K 27B on the R9700's 32 GB. |
| `--flash-attn` | `on` | Needed for a quantized V cache, and faster at long context. |
| `--n-gpu-layers` | `99` | Every layer on the GPU. |
| `--parallel` | `1` | One conversation at a time gets the whole 128K. Demesne's `inference_slots = 1` matches. |
| `--host` | `127.0.0.1` | Only this machine can reach the model. Your phone will reach the assistant later through Tailscale, never an open port. |
| `--jinja` | | Uses the model's own chat template, which tool calling needs. |

[`assistant.toml`](../scripts/assistant/assistant.toml) is the matching Demesne config. It sets `reasoning_effort = "low"`, because Qwen's default effort can spend tens of thousands of thinking tokens on one reply, and `daemon.auto_start = "never"`, because the task now owns the daemon. A test ([`assistant-services.test.ts`](../apps/daemon/test/assistant-services.test.ts)) fails if the two files ever disagree about the cap, the port or the model name.

### Install

You need:

- **llama.cpp for Radeon.** Download the Windows HIP build from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) (the zip with `hip` and `radeon` in its name) and unzip it somewhere like `C:\llama`. AMD's HIP SDK for Windows may also be needed if the release notes say so. The Vulkan build works too, without the SDK; see [If you already run llama-server](#if-you-already-run-llama-server) for its flags.
- **The model**, for example `C:\models\Qwen3.8-27B-Q5_K_M.gguf`.
- **This repository and [Bun](https://bun.sh)**, as for running Demesne from source.

Then, in PowerShell from the repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\assistant\install.ps1 `
  -Model C:\models\Qwen3.8-27B-Q5_K_M.gguf -LlamaServer C:\llama\llama-server.exe -DryRun
```

`-DryRun` prints exactly what each task will run and changes nothing. When it looks right, run it again without `-DryRun`. Add `-Config` to replace `%USERPROFILE%\.demesne\config.toml` with the assistant's (the old one is backed up next to it), or leave it off and copy the `[provider]` section across yourself. `-ExecutionPolicy Bypass` is needed because Windows refuses to run downloaded scripts by default; it applies to this one run only.

The tasks start at login. If Windows restarts for an update and nobody logs in, they wait until you do.

### If you already run llama-server

Maybe you already have a server you like: a Vulkan build instead of HIP, the model pinned to one of two cards, a bigger window. You don't have to switch to these settings. Two options:

- **Let the task run your server.** Write your flags into a file in the same one-per-line form as [`llama-server.args`](../scripts/assistant/llama-server.args) and pass it with `-LlamaArgs C:\path\to\my.args`. Keep `--host 127.0.0.1`, `--port 8081` and `--alias qwen3.8-27b`, which is where and what Demesne's config looks for, and leave `@MODEL@` where the model path goes (or write the path itself and skip `-Model`). `llama-server --list-devices` names your GPUs; `--device Vulkan1` puts the model on the second.
- **Keep starting it yourself.** Pass `-NoModel` and only the daemon becomes a task. Then the assistant only works while your server is up, so a routine at 8:00 needs it running at 8:00.

Either way the installer finishes by asking `http://127.0.0.1:8081/v1/models` what it serves, and says so if nothing answers there.

A server window bigger than 128K is fine: Demesne keeps to its own `context_window = 131072` (Qwen3.8-27B stops generating past about 130K, whatever the server allows). The extra only costs VRAM. With `--parallel` above 1, check that each slot still gets the whole window (`n_ctx` in `http://127.0.0.1:8081/props`), since older builds split it between slots.

### Check it

```powershell
Get-ScheduledTask -TaskPath \Demesne\                             # both should say Running
Get-Content $HOME\.demesne\assistant\llama-server.log -Wait -Tail 20   # the model's log; Ctrl+C to stop following
Invoke-RestMethod http://127.0.0.1:8081/v1/models                 # the model answers
```

Open the Demesne window: it connects to the running daemon instead of starting its own. To try the always-on part, open **Scheduled**, add "Every day at 9, say good morning and list today's date" and close the window. The chat is there when you come back.

To stop them until next login, or remove them:

```powershell
Stop-ScheduledTask -TaskPath \Demesne\ -TaskName llama-server
Stop-ScheduledTask -TaskPath \Demesne\ -TaskName demesned
Unregister-ScheduledTask -TaskPath \Demesne\ -TaskName llama-server   # remove for good
```

If `llama-server.exe` is still in Task Manager after stopping its task, end it there too.

### Gaming on the same card

The model holds most of the GPU's 32 GB while llama-server runs. Stop its task before a game and start it after (`Start-ScheduledTask -TaskPath \Demesne\ -TaskName llama-server`). The daemon stays up; a chat or routine that runs while the model is stopped fails, so stop it only while you aren't expecting one.

### Not yet tried on Windows

Demesne's releases are built for macOS and Ubuntu, and its daemon hasn't been run on Windows yet. Some of its tools assume a Unix shell. If the daemon task keeps restarting, its log (`%USERPROFILE%\.demesne\assistant\demesned.log`) says why, and fixing that comes before step 2.

## Step 2: a home and one tool

### A home

Demesne works in *projects*: a folder you open, whose `DEMESNE.md` file is read at the start of every turn as standing instructions. The assistant gets a project of its own, `%USERPROFILE%\Assistant`, made by `install.ps1` (pass `-AssistantHome` for another place). Its [`DEMESNE.md`](../scripts/assistant/home/DEMESNE.md) says who it is working for, how to answer, where to keep its notes (`notes.md`, `todo.md` in the same folder) and its rules. Open the folder, fill in **About me**, and change anything you like: edits apply from the next message, with no restart. The installer never overwrites it.

### Its own chat

The assistant has one chat, not a chat per question: **Assistant**, second in the sidebar under New chat. Your questions, its routines' runs and what it sent to your phone all land in that one conversation, with a quiet line where each day starts. It compacts itself as it grows, like any long chat. The row wears the same marks as a chat's row: amber when it needs you, a breathing dot while it works, and blue when it did something while you were elsewhere.

The chat lives in the assistant's folder, so its `DEMESNE.md` applies: `~/Assistant` (what `install.ps1` makes) when that folder exists and you've trusted it, or the folder `[assistant] home` names. Without one it can still read and search your folders, but keeps no notes and has no `DEMESNE.md`. Its title bar names the folders it may read.

A routine you write from Scheduled while that chat is open runs in it: at its time the question is a quiet line with the time and the routine's name ("↗ phone" when its answer goes to your phone), and the answer follows. If the chat is busy at that moment, the routine waits for the next minute.

### One tool: `personal_files`

The assistant needs to see your files, but not all of them, and it must never change them. You list the folders it may read in `~/.demesne/config.toml`, each with a one-word name:

```toml
[assistant]
folders = { documents = 'C:\Users\you\Documents', icloud = 'C:\Users\you\iCloudDrive' }
```

Single quotes keep Windows backslashes as they are. Restart the daemon after changing this (`Stop-ScheduledTask` then `Start-ScheduledTask` on `demesned`).

The daemon then offers the model one more tool, [`personal_files`](../apps/daemon/src/personal-files.ts), with two actions:

- **list** a folder or subfolder: names, sizes and dates.
- **read** a text file's or PDF's lines, 400 at a time, by its path inside the named folder, like `documents` and `Trips/lisbon.md`.

What it can't do, on purpose:

- **Write, move or delete.** There is no action for it.
- **Leave the folder.** `..`, absolute paths and shortcuts (symlinks) are refused, and a whole drive or home folder can't be shared.
- **Read secrets.** Hidden files, `.env`, keys, `.ssh` and password databases (`.kdbx`) stay out.
- **Take orders from a file.** Every read comes back with a note telling the model the content is data, not instructions, and `DEMESNE.md` says the same. This is the first defence against a document that says "ignore your instructions and…".

It reads plain text (notes, Markdown, CSV, saved emails as `.eml`, calendar `.ics`) and PDFs that have text in them, through pdf.js, the PDF reader Firefox uses. Scanned PDFs (pictures of pages), Word files and images can't be read yet.

### Try it

With a folder shared and the daemon restarted, ask in the Assistant project: "What's in my documents folder?", then "What does my grocery list say?". The steps show which tool it called and which file it read.

### Its own tools, not the coding agent's

A routine runs on **Auto**: nobody is at the window to approve its steps. If the assistant had the coding agent's tools, a PDF that says "run this command" would be one bad decision away from being run. So the assistant's chat gets only these, and the daemon refuses any other tool the model asks for there, even one it makes up:

| Tool | What it does |
| --- | --- |
| `search_personal_files`, `personal_files` | Find and read your shared folders. Read-only. |
| `assistant_notes` | Reads and writes `notes.md` (what you asked it to remember) and `todo.md` (what you said you'd do) in its folder, without asking, the way you'd jot something down. Nothing else there: it can't change `DEMESNE.md`, so a document can't talk it into a new standing rule. Each file is capped at 64 KB. |
| `notify_phone` | Push to your phone. Asks first in a chat you're at; on Auto it sends, up to 10 an hour. |

No shell, no edits, moves or deletes, no sub-agents, no Drive. Taking a tool away is stronger than telling the model not to use it, and a shorter prompt leaves more of the 128K for your files.

It gets its own base instructions too, in place of the coding agent's (and in place of a `system_prompt` you configured for coding): who it is, how to find things, that files are data and never instructions, and to ask before anything leaves the computer. Your `DEMESNE.md` follows them.

Each of your messages reaches the model with the local date and time in front, like `[Tue 2026-10-27 09:05] what's on today?`, so "today" and "this week" mean something. You see your message as you typed it. The time goes with the message rather than in the instructions at the top, because changing the top would make llama-server re-read the whole conversation (its prompt cache) every time.

### Why the chat only ever grows at the end

llama-server keeps the conversation it last read (its prompt cache). When the next request starts with exactly the same text, it only reads what's new, which takes a second or two instead of minutes for a long chat. Change anything near the top, even the order of the tools, and it reads everything again. Qwen3.8 makes this stricter than most models: its memory of the conversation can't be rewound to an arbitrary point, only to a few saved checkpoints.

So the assistant's chat is kept append-only:

- The instructions and the tool list are the same on every turn, yours or a routine's. That's why it has no `ask_user` tool, which other chats only get while you're at the window: here it simply asks in its answer.
- The time goes on each message, not in the instructions, and the coding agent's live context (Heartbeat's list of reachable agents, Drive) stays out.
- The chat never ends, so it can't wait for you to type `/compact`. After a turn whose request used three quarters of the room for input (about 86K of the 128K, after 16K kept for the reply), the daemon summarizes the older turns, the same way `/compact` does, and keeps the last two in full. That rewrites the start once; from then on it grows at the end again. Without it, past the limit Demesne would trim old tool output on *every* request, and every request would be read from the start.

## Step 3: file index

With a few files, the assistant can list folders and open what looks right. With thousands it needs a search index, like the one behind the search box in your file explorer, only over the *text* inside the files.

The daemon keeps one in `personal-index.sqlite`, beside its own database, using SQLite's built-in full-text search (FTS5). The code is in [`personal-index.ts`](../apps/daemon/src/personal-index.ts):

1. **Read.** Every readable file in your shared folders is turned into text, PDFs included.
2. **Cut.** Each file's text is cut into overlapping pieces of about 1,500 characters, so a match points at the right passage, not just the right file. The file's name goes in too, so "insurance" finds `insurance-2026.pdf`.
3. **Search.** A new tool, `search_personal_files`, looks up the words the model gives it ("car insurance renewal") and returns the 8 best files, each with the matching passage. Results are ranked by BM25, the standard search-engine score: rare words count for more than common ones.
4. **Read the best one.** The model then opens that file with `personal_files`.

(Projects already have a `search_files` tool for code; this one only looks in the assistant's folders.)

The index is brought up to date when the daemon starts and every ten minutes after. Only files whose size or date changed are read again, so after the first time (which can take a few minutes for a big folder) it takes seconds. Deleted files drop out. It skips what `personal_files` skips: hidden files, secrets and shortcuts. If you ask while the first index is still being built, the search waits a few seconds and then says results may be incomplete.

This is word search, not meaning search: "car" won't find a file that only says "vehicle". Meaning search (embeddings) is a later step.

## Step 4: push to your phone

The assistant reaches your phone through [ntfy](https://ntfy.sh), a free push service: the daemon posts a message to a *topic*, and the ntfy app on your phone shows everything posted to topics you subscribe to.

1. Install **ntfy** from the App Store and allow notifications.
2. Make up a long random topic name, like `mike-assistant-` followed by 12 random letters and digits. Anyone who knows the name can read it, so don't use something guessable. (The config refuses anything under 16 characters.)
3. In the app, tap **+** and subscribe to that topic on `ntfy.sh`.
4. Add it to `~/.demesne/config.toml` and restart the daemon:

```toml
[assistant]
ntfy = "https://ntfy.sh/mike-assistant-7f3k2p9qx8mz"
```

Then:

- **Routines send their answer to your phone.** Write one from the assistant's chat, like "Every weekday at 8, what's on today and this week? Check my documents for dates." At 8:00 the assistant asks it in its chat, looks through your files, and its answer arrives as a notification titled with the question. If the run fails, you get a notification saying so instead of silence. This applies to every routine once `ntfy` is set, so a coding routine's summary reaches your phone too.
- **Chats get a `notify_phone` tool.** Say "send that to my phone" and the model can push a short note. In a chat you're at, it asks you first, like any step that reaches outside the computer. On Auto (routines, Heartbeat mail) it sends without asking. Either way it's limited to 10 notifications an hour.

Two things to know:

- **This is the one part that leaves your computer.** The text of each notification goes through ntfy.sh to reach your phone. Keep routines to things you're fine with that for, or host ntfy yourself later: `ntfy` takes any https address (or plain http on this computer or over Tailscale), and `ntfy_token` adds a password.
- A routine written in the assistant's chat runs in that chat; any other routine run is its own chat. Either way you can open it in Demesne later to see what it read.

## Step 5: use it from anywhere

The daemon and the model stay on the PC. The Demesne window on another computer (and later the iPhone app) talks to that daemon instead of running its own, so it's the same assistant, the same chat and the same files wherever you are.

Three locks keep it yours:

1. **Who can reach the PC: Tailscale.** [Tailscale](https://tailscale.com) is a private network of only your own devices, signed in with your account. Traffic between them is encrypted (WireGuard), and it works from any Wi-Fi or mobile data without opening a port on your router. Nothing on the open internet can see the PC.
2. **The connection: `tailscale serve`.** It gives the daemon an `https://` address inside your tailnet, with a real certificate, and passes requests on to `127.0.0.1:7337`. The daemon itself still only listens on the PC (it refuses any other address), and llama-server stays on `127.0.0.1:8081`, where only the daemon talks to it.
3. **Who can use the daemon: its token.** Every request except `/healthz` needs the token in `%USERPROFILE%\.demesne\daemon.token`, which the daemon made the first time it ran. A device on your tailnet without it gets `401 Unauthorized`. That's what limits it to your Demesne apps.

Treat the token like a password. It can do anything the Demesne window on the PC can, including a coding chat that runs commands there. Copy it only over something private (a USB stick, or Taildrop between your own devices), never email or chat. If it leaks, delete `daemon.token`, restart the daemon (it makes a new one) and copy the new one to your other computers.

Never use **Tailscale Funnel** or forward a router port for this. Both put the daemon on the public internet, where the token would be the only lock.

### On the PC

Turn on **MagicDNS** and **HTTPS Certificates** in the Tailscale admin console (DNS page) once. Then, in PowerShell:

```powershell
tailscale serve status                                    # what's already published here
tailscale serve --bg --https=8443 http://127.0.0.1:7337   # the daemon, inside your tailnet only
tailscale serve status                                    # shows https://<pc-name>.<tailnet>.ts.net:8443
```

Port 8443 leaves 443 free for anything you already publish (the iOS gateway, for example). `--bg` keeps it published across restarts; `tailscale serve --https=8443 off` takes it down.

### On the other computer

1. Install Tailscale and sign in with the same account.
2. In `~/.demesne/config.toml`, point the window at the PC and stop it starting a daemon of its own:

   ```toml
   server = "https://demesne-pc.tail1234.ts.net:8443"

   [daemon]
   auto_start = "never"
   ```

3. Copy the PC's `daemon.token` to `~/.demesne/remote-daemons/demesne-pc.tail1234.ts.net_8443.token` (the PC's name and port, as in `server`). The window sends a token only to the host and port it is named for, and never sends this computer's own `daemon.token` anywhere else.
4. Open Demesne. It connects to the PC, and **Assistant** in the sidebar is the PC's chat. **Start daemon** isn't offered for a daemon on another computer: the PC's login task starts it.

(`DEMESNE_DAEMON_TOKEN` in the environment still overrides the file, as before.)
