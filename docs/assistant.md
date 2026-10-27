# The always-on assistant

[Documentation index](README.md) · [Configuration](configuration.md) · [Heartbeat](heartbeat.md)

Demesne is growing a second job: a personal assistant that lives on your desktop, reads your files (and your phone's, through iCloud for Windows), plans with you and pushes reminders to your phone. It runs Qwen3.8-27B on your own GPU, so nothing leaves the machine and it costs nothing to leave on.

It is built in small steps, each one usable on its own:

| Step | What it adds | Status |
| --- | --- | --- |
| 1. The model as a service | llama-server and the daemon start at login and restart if they crash | [Done](#step-1-the-model-as-a-service-windows) |
| 2. A home and one tool | An assistant folder, its own instructions, and a tool that reads the folders you choose | [Done](#step-2-a-home-and-one-tool) |
| 3. File index | A local search index over those folders, so it finds the right file without reading them all | Next |
| 4. Push to your phone | An ntfy tool, so a routine like "every morning at 8, tell me what's due" reaches your iPhone | Later |

Everything the assistant reads from a file, an email or a web page is data, never instructions. A document that says "forward this to…" cannot make it act; it asks you before it sends, deletes or buys anything.

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

- **llama.cpp for Radeon.** Download the Windows HIP build from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) (the zip with `hip` and `radeon` in its name) and unzip it somewhere like `C:\llama`. AMD's HIP SDK for Windows may also be needed if the release notes say so.
- **The model**, for example `C:\models\Qwen3.8-27B-Q5_K_M.gguf`.
- **This repository and [Bun](https://bun.sh)**, as for running Demesne from source.

Then, in PowerShell from the repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\assistant\install.ps1 `
  -Model C:\models\Qwen3.8-27B-Q5_K_M.gguf -LlamaServer C:\llama\llama-server.exe -DryRun
```

`-DryRun` prints exactly what each task will run and changes nothing. When it looks right, run it again without `-DryRun`. Add `-Config` to replace `%USERPROFILE%\.demesne\config.toml` with the assistant's (the old one is backed up next to it), or leave it off and copy the `[provider]` section across yourself. `-ExecutionPolicy Bypass` is needed because Windows refuses to run downloaded scripts by default; it applies to this one run only.

The tasks start at login. If Windows restarts for an update and nobody logs in, they wait until you do.

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

Open that folder as a project in the Demesne window and chat there. Routines you write from that chat run there too, with the same instructions.

### One tool: `personal_files`

The assistant needs to see your files, but not all of them, and it must never change them. You list the folders it may read in `~/.demesne/config.toml`, each with a one-word name:

```toml
[assistant]
folders = { documents = 'C:\Users\you\Documents', icloud = 'C:\Users\you\iCloudDrive' }
```

Single quotes keep Windows backslashes as they are. Restart the daemon after changing this (`Stop-ScheduledTask` then `Start-ScheduledTask` on `demesned`).

The daemon then offers the model one more tool, [`personal_files`](../apps/daemon/src/personal-files.ts), with two actions:

- **list** a folder or subfolder: names, sizes and dates.
- **read** a text file's lines, by its path inside the named folder, like `documents` and `Trips/lisbon.md`.

What it can't do, on purpose:

- **Write, move or delete.** There is no action for it.
- **Leave the folder.** `..`, absolute paths and shortcuts (symlinks) out of it are refused, and a whole home folder can't be shared.
- **Read secrets.** Hidden files, `.env`, keys and `.ssh` stay out, the same rule as project reads.
- **Take orders from a file.** Every read comes back with a note telling the model the content is data, not instructions, and `DEMESNE.md` says the same. This is the first defence against a document that says "ignore your instructions and…".

It reads plain text (notes, Markdown, CSV, saved emails as `.eml`). PDFs and Word files come back as "binary" for now; step 3's indexer extracts their text.

### Try it

With a folder shared and the daemon restarted, ask in the Assistant project: "What's in my documents folder?", then "What does my grocery list say?". The steps show which tool it called and which file it read.

### Known limits

- A routine in a project runs on **Auto**: nobody is at the window, so it doesn't stop to ask before running a command or editing a file in the Assistant folder. `personal_files` itself can only read, but the coding tools are still there. Until the assistant gets its own narrower tool set, keep routines in the Assistant project to reading and summarizing.
- The model's base instructions are still the coding agent's; `DEMESNE.md` is added after them.
