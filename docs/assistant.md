# The always-on assistant

[Documentation index](README.md) · [Configuration](configuration.md) · [Heartbeat](heartbeat.md)

Demesne is growing a second job: a personal assistant that lives on your desktop, reads your files (and your phone's, through iCloud), plans with you and pushes reminders to your phone. It runs Qwen3.8-27B on your own GPU, so nothing leaves the machine and it costs nothing to leave on.

It is built in small steps, each one usable on its own:

| Step | What it adds | Status |
| --- | --- | --- |
| 1. The model as a service | llama-server and the daemon start at login and restart if they crash | This guide |
| 2. A home and one tool | An assistant folder, its own instructions, and a tool that reads the folders you choose | Next |
| 3. File index | A local search index over those folders, so it finds the right file without reading them all | Later |
| 4. Push to your phone | An ntfy tool, so a routine like "every morning at 8, tell me what's due" reaches your iPhone | Later |

Everything the assistant reads from a file, an email or a web page is data, never instructions. A document that says "forward this to…" cannot make it act; it asks you before it sends, deletes or buys anything.

## Step 1: the model as a service

### Why a service

Until now you started llama-server in a terminal and Demesne's daemon from the window. That's fine for coding, but an assistant has to be awake when you aren't looking: a routine set for 8:00 only fires if the daemon is running at 8:00. On Linux, **systemd** is the program that keeps background programs running. A *user service* is a small text file that tells it what to run, and to start it again if it stops.

Two services, in [`scripts/assistant/`](../scripts/assistant):

- [`llama-server.service`](../scripts/assistant/llama-server.service) runs the model on port 8081.
- [`demesned.service`](../scripts/assistant/demesned.service) runs Demesne's daemon, after the model.

### The settings, and why

| Flag | Value | Why |
| --- | --- | --- |
| `--ctx-size` | `131072` (128K) | Qwen3.8-27B silently stops generating once a prompt passes about 130K tokens. The server refuses anything larger, and Demesne's `context_window` is the same number, so a long session compacts instead of dying without an error. |
| `--cache-type-k/v` | `q8_0` | The K/V cache is the model's working memory for the conversation. At 8 bits it takes half the VRAM of the default, which is what lets 128K fit beside a Q5_K_M or Q6_K 27B on the R9700's 32 GB. |
| `--flash-attn` | `on` | Needed for a quantized V cache, and faster at long context. |
| `--n-gpu-layers` | `99` | Every layer on the GPU. |
| `--parallel` | `1` | One conversation at a time gets the whole 128K. Demesne's `inference_slots = 1` matches. |
| `--host` | `127.0.0.1` | Only this machine can reach the model. Your phone will reach the assistant later through Tailscale, never an open port. |
| `--jinja` | | Uses the model's own chat template, which tool calling needs. |

[`assistant.toml`](../scripts/assistant/assistant.toml) is the matching Demesne config. It sets `reasoning_effort = "low"`, because Qwen's default effort can spend tens of thousands of thinking tokens on one reply, and `daemon.auto_start = "never"`, because the service now owns the daemon. A test ([`assistant-services.test.ts`](../apps/daemon/test/assistant-services.test.ts)) fails if the two files ever disagree about the cap, the port or the model name.

### Install

You need llama.cpp built with HIP (ROCm) so `llama-server` is on your PATH, and the model file. Then, from the repository:

```sh
bun run build:daemon        # optional: a compiled daemon; otherwise it runs from source with bun
scripts/assistant/install.sh --model ~/models/Qwen3.8-27B-Q5_K_M.gguf --config
```

`--config` replaces `~/.demesne/config.toml` with the assistant's, after backing up the old one next to it. Leave it off to keep your config and copy the `[provider]` section across yourself. `--dry-run` prints the two service files without installing anything, so you can read exactly what will run.

Services stop when you log out. To keep them running from boot, even before you log in, run the command the installer prints: `sudo loginctl enable-linger $USER`.

### Check it

```sh
systemctl --user status llama-server demesned     # both should say "active (running)"
journalctl --user -u llama-server -f              # the model's log; Ctrl+C to stop following
curl -s http://127.0.0.1:8081/v1/models           # the model answers
```

Open the Demesne window: it connects to the running daemon instead of starting its own. To try the always-on part, open **Scheduled**, add "Every day at 9, say good morning and list today's date" and close the window. The chat is there when you come back.

To stop or remove them:

```sh
systemctl --user stop llama-server demesned        # until next login
systemctl --user disable llama-server demesned     # don't start at login
```

### Gaming on the same card

The model holds most of the GPU's 32 GB while llama-server runs. Stop it before a game (`systemctl --user stop llama-server`) and start it after. The daemon stays up; a chat or routine that runs while the model is stopped fails, so stop it only while you aren't expecting one.
