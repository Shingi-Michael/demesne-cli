<p align="center">
  <img src="docs/assets/hero-b.svg" alt="demesne — Your repo has a to-do list. Drive already read it." width="100%">
</p>

<p align="center">
  <a href="https://github.com/Shingi-Michael/demesne-cli/actions/workflows/ci.yml"><img src="https://github.com/Shingi-Michael/demesne-cli/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5AA9E6?style=flat-square&amp;labelColor=0B1218" alt="MIT license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-1.4.0-5AA9E6?style=flat-square&amp;labelColor=0B1218" alt="Bun 1.4.0"></a>
</p>

<p align="center">
  <a href="#try-it">Try it</a> &nbsp;·&nbsp;
  <a href="#how-drive-works">How Drive works</a> &nbsp;·&nbsp;
  <a href="#see-it">See it</a> &nbsp;·&nbsp;
  <a href="#install">Install</a> &nbsp;·&nbsp;
  <a href="docs/README.md">Docs</a>
</p>

Most coding agents wait for you to say what to do. **demesne reads your project first**—failing checks, red CI, open pull requests, half-finished work—and puts a ranked list of next moves in front of you. Press **Run** and Drive directs the coding agent through a bounded mission, checks the result, and hands back the diff, the commands and the passing checks. You review; it remembers.

## Try it

```sh
git clone https://github.com/Shingi-Michael/demesne-cli.git && cd demesne-cli
bun install --frozen-lockfile
bun run desktop
```

Pick a project, connect a model, and open **Drive**. You need [Bun 1.4.0](https://bun.sh), [Rust](docs/desktop.md#prerequisites) for the desktop window, and a model: one running on your machine, your ChatGPT plan, or OpenRouter. Prefer the terminal or a script? See [Install](#install).

## How Drive works

<img src="docs/assets/drive-loop.svg" alt="Drive: reads signals from the repo, ranks what’s worth doing, runs a bounded mission, hands back the evidence, and remembers decisions, outcomes and vetoes" width="100%">

Every proposal shows why it's there and what it would cost. **Run** starts it, **Plan first** asks for a plan you approve, **Not now** and **Never** teach Drive what to skip. Missions are bounded by default; `/drive --bounded "…"` starts one from the composer. [The full guide →](docs/agent-drive.md)

## See it

<a href="docs/assets/demesne-drive.png"><img src="docs/assets/demesne-drive.png" alt="A finished coding turn with its edits and passing check, beside the Drive panel proposing the next tasks" width="100%"></a>

<table>
<tr>
<td width="50%" valign="top"><img src="docs/assets/demesne-start.png" alt="Start screen with three Drive proposals"><br><sub><b>Start from a proposal.</b> The start screen shows what Drive would do next, with the evidence behind each item.</sub></td>
<td width="50%" valign="top"><img src="docs/assets/demesne-review.png" alt="Review panel with a diff beside the conversation"><br><sub><b>Review the evidence.</b> Every edit, command and check stays attached to its turn; rerun a check before you commit.</sub></td>
</tr>
</table>

<p align="center"><sub>Real captures from an isolated, deterministic demo. <a href="docs/assets/README.md">How they’re made</a>.</sub></p>

## Also inside

<table>
<tr>
<td width="50%" valign="top"><b>Your models, your call</b><br>Local servers, ChatGPT plan, OpenRouter. Sign in and out in <b>Settings › Providers</b> without a restart; each model has its own thinking levels. <a href="docs/authentication.md">Providers</a></td>
<td width="50%" valign="top"><b>Work that survives</b><br>A local daemon owns every turn. Close the window, reopen, continue. <code>/compact</code> keeps long sessions in budget.</td>
</tr>
<tr>
<td valign="top"><b>Sub-agents</b><br>Read-only investigators with their own context, in parallel, on a model you choose. <a href="docs/subagents.md">Sub-agents</a></td>
<td valign="top"><b>Session tools</b><br>The agent shapes presets and multi-step lookups for the job, without changing the real tools. <a href="docs/session-tools.md">Session tools</a></td>
</tr>
<tr>
<td valign="top"><b>A suggested next prompt</b><br>After each turn the composer offers what to ask next. <b>Tab</b> takes it.</td>
<td valign="top"><b>Desktop or terminal</b><br>The same interface in a native window or inside Ghostty, drawn with Kitty graphics.</td>
</tr>
</table>

> [!WARNING]
> **Commands run as your OS user, not in a sandbox.** Your own turns ask before writing files or running commands. Drive's coding turns run with every tool allowed so a mission can work unattended; pushing, pull requests, releases and package publishes still ask. Run Drive where that's acceptable. [Security boundaries](SECURITY.md)

## Install

<details>
<summary><b>Desktop app</b> — native window, macOS and Ubuntu 22.04/24.04 (preview, unsigned)</summary>

```sh
bun run desktop          # run from source
bun run build:desktop    # build an app bundle
```

Needs [Rust and platform prerequisites](docs/desktop.md#prerequisites). See the [desktop guide](docs/desktop.md).
</details>

<details>
<summary><b>Ghostty</b> — the full interface in your terminal</summary>

```sh
bun run build
bun run build:graphics
./dist/demesne setup
./dist/demesne daemon start
./dist/demesne
```

Keep `dist/graphics` and `dist/node_modules` beside the binaries. To use it in any project, link `dist/demesne` and `dist/demesned` onto your PATH, then run `demesne` in that project. Source development: `bun run graphics:setup` and `bun run demesne`. See [graphics setup](apps/graphics/README.md) and [troubleshooting](docs/troubleshooting.md).
</details>

<details>
<summary><b>Linux</b> — Ghostty in a desktop session, as your normal user</summary>

```sh
bun run demesne setup
bun run demesne daemon start
bun run graphics
```

If you see “The SUID sandbox helper binary was found, but is not configured correctly”, run `bun run graphics:setup --install-sandbox` and launch again. It asks for administrator access only for the sandbox helper. See the [Linux guide](docs/linux.md).
</details>

<details>
<summary><b>Scripts and CI</b> — no window</summary>

```sh
demesne prompt --output json "Explain the test layout"
```

Text, JSON or streamed events. Approval requests are denied rather than left waiting. See [headless usage](docs/cli-reference.md#headless-output).
</details>

<details>
<summary><b>Keyboard shortcuts</b></summary>

| Do this | Use this |
| --- | --- |
| Send / new line | Enter / Shift+Enter |
| Take the suggested prompt | Tab on an empty composer |
| Settings | Tab (no suggestion) or Ctrl+K |
| Changes / files / checks | Alt+D / Alt+O / Alt+T |
| Drive / history | Alt+J / Alt+H |
| Back to live output | Ctrl+G |
| Stop | Ctrl+C, or double Esc |
| Zoom (desktop) | ⌘= / ⌘- / ⌘0 |
| Quit the UI (work continues) | Ctrl+Q |

[All commands →](docs/cli-reference.md)
</details>

---

<p align="center">
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="CHANGELOG.md">Changelog</a>
  <br><sub>Built by <a href="https://github.com/Shingi-Michael">Shingirayi Kamucheka</a> · MIT licensed</sub>
</p>
