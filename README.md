<p align="center">
  <img src="docs/assets/hero.svg" alt="demesne — The coding agent that knows what’s next." width="100%">
</p>

<p align="center">
  <strong>Drive reads your project—failing checks, open PRs, unfinished work—and proposes what to do next.</strong><br>
  Run it, watch the evidence come in, review every change. Local or hosted models. Terminal or desktop.
</p>

<p align="center">
  <a href="https://github.com/Shingi-Michael/demesne-cli/actions/workflows/ci.yml"><img src="https://github.com/Shingi-Michael/demesne-cli/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-334b5e?style=flat-square&amp;labelColor=101a23" alt="MIT license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-1.4.0-334b5e?style=flat-square&amp;labelColor=101a23" alt="Bun 1.4.0"></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#a-three-minute-tour"><strong>Tour</strong></a> ·
  <a href="docs/agent-drive.md"><strong>How Drive works</strong></a> ·
  <a href="docs/README.md"><strong>Documentation</strong></a> ·
  <a href="CONTRIBUTING.md"><strong>Contribute</strong></a>
</p>

<br>

<a href="docs/assets/demesne-drive.png"><img src="docs/assets/demesne-drive.png" alt="Demesne: a finished coding turn with its edits and passing check, beside the Drive panel proposing the next tasks" width="100%"></a>

<p align="center"><sub>The real interface, captured from an isolated, deterministic demo. <a href="docs/assets/README.md">About these captures</a>.</sub></p>

## Why demesne

<table>
<tr>
<td width="33%" valign="top">
<h3>◇ Drive proposes the work</h3>
<p>Drive collects signals from your repository—failing checks, red CI, open pull requests, uncommitted changes, unfinished asks—and ranks what’s worth doing by value, confidence and cost. <strong>Run</strong> starts a bounded mission; Drive directs the coding agent, checks the result, and remembers what it learned.</p>
<a href="docs/agent-drive.md">How Drive works →</a>
</td>
<td width="33%" valign="top">
<h3>✓ Every change has evidence</h3>
<p>Diffs, command output, and checks stay attached to the turn that produced them. Review a change beside the conversation, rerun a check, or undo a file. A local daemon owns the work, so closing the window never loses a turn in progress.</p>
<a href="apps/graphics/README.md#review-panel-upgrades">See the review panels →</a>
</td>
<td width="33%" valign="top">
<h3>⚙ Your models</h3>
<p>Run a model on your own machine for free, use your ChatGPT plan, or sign in to OpenRouter. Sign in and out from <strong>Settings › Providers</strong>; switching never needs a restart, and each model offers its own thinking levels.</p>
<a href="docs/authentication.md">Connect a provider →</a>
</td>
</tr>
</table>

## Get started

You’ll need [Bun 1.4.0](https://bun.sh) and a model: a local OpenAI-compatible server, a ChatGPT plan, or an OpenRouter account.

```sh
git clone https://github.com/Shingi-Michael/demesne-cli.git
cd demesne-cli
bun install --frozen-lockfile
```

Then pick how you want to work:

<table>
<tr>
<td width="33%" valign="top">
<h4>In the desktop app</h4>

```sh
bun run desktop
```

A native window (Tauri, system webview). Needs [Rust and platform prerequisites](docs/desktop.md#prerequisites). Pick a project, connect a provider in setup; `bun run build:desktop` builds an app bundle. <sub>Preview: macOS and Ubuntu 22.04/24.04, not yet signed. <a href="docs/desktop.md">Desktop guide</a></sub>
</td>
<td width="33%" valign="top">
<h4>In Ghostty</h4>

```sh
bun run build
bun run build:graphics
./dist/demesne setup
./dist/demesne daemon start
./dist/demesne
```

The full interface inside [Ghostty](https://ghostty.org), drawn with Kitty graphics. <sub><a href="#install-details">Install details</a> · <a href="#on-linux">Linux</a></sub>
</td>
<td width="33%" valign="top">
<h4>From a script</h4>

```sh
demesne prompt --output json \
  "Explain the test layout"
```

Text, JSON, or streamed events, no window. Approval requests are denied rather than left waiting. <sub><a href="docs/cli-reference.md#headless-output">Headless usage</a></sub>
</td>
</tr>
</table>

Setup walks you through the provider, model and configuration. [Provider and account guide →](docs/authentication.md)

<details id="install-details">
<summary><strong>Install details and working in another project</strong></summary>

Both builds are needed for the Ghostty interface. Keep `dist/graphics` and `dist/node_modules` beside the CLI and daemon:

```text
dist/
├── demesne
├── demesned
├── graphics/
└── node_modules/
```

Link the binaries into a directory on your PATH, start the daemon, then open any project:

```sh
ln -sf "$PWD/dist/demesne" "$PWD/dist/demesned" /usr/local/bin/
demesne daemon start
cd /path/to/project
demesne
```

For source development, use `bun run graphics:setup` and `bun run demesne`. [Graphics setup and packaging](apps/graphics/README.md) covers the details; [troubleshooting](docs/troubleshooting.md) covers older running processes and terminal capabilities. Rebuilds don’t replace a running daemon or UI.

</details>

<details id="on-linux">
<summary><strong>On Linux</strong></summary>

From the cloned repository, as your **normal user inside Ghostty** in a desktop session:

```sh
bun install --frozen-lockfile
bun run demesne setup
bun run demesne daemon start
bun run graphics
```

`bun run graphics` downloads a missing Electron runtime and checks that a sandboxed renderer can start. If you see “The SUID sandbox helper binary was found, but is not configured correctly”, run the explicit repair, then launch again:

```sh
bun run graphics:setup --install-sandbox
bun run graphics
```

The repair requests administrator access **only for the sandbox helper**; the app stays unprivileged and sandboxed. Ubuntu 20.04 and 24.04 are checked in CI. See the [Linux guide](docs/linux.md).

</details>

## A three-minute tour

**1 · Ask, or start from a proposal.** The start screen shows what Drive would do next, ranked, with the evidence behind each item.

<img src="docs/assets/demesne-start.png" alt="Demesne start screen: the composer, three Drive proposals with Run and Plan first, and starter actions" width="100%">

**2 · Let it work.** The agent reads, edits and runs checks; each step appears as it happens. When it finishes, the composer suggests a next prompt—press **Tab** to use it.

```text
/drive --bounded Fix the failing parser tests and verify the change
```

**3 · Review the evidence.** Every edit, command and check is attached to its turn. Open **Review** to read the diff and rerun a check before you commit.

<img src="docs/assets/demesne-review.png" alt="Demesne review panel: the retry helper’s diff beside the conversation, with the check passing" width="100%">

## What’s inside

| | |
| --- | --- |
| **Agent Drive** | Proposes next work from real signals; runs bounded or continuous missions; remembers decisions, outcomes and vetoes per project. [Guide](docs/agent-drive.md) |
| **Review panels** | Diffs, files, checks and the full step log, per turn or across the session. |
| **Sub-agents** | Read-only investigators with their own context, run in parallel, on a model you choose. [Guide](docs/subagents.md) |
| **Session tools** | The agent can define presets and multi-step lookups for a session, without changing the real tools. [Guide](docs/session-tools.md) |
| **Durable sessions** | A local daemon owns the work: close the window, reopen, continue. Compact long conversations with `/compact`. |
| **Providers** | Local servers, ChatGPT plan, OpenRouter; sign in and out in Settings; thinking levels per model. [Guide](docs/authentication.md) |
| **Desktop and terminal** | The same interface in a native window or inside Ghostty. |

## Stay in control

**Commands run as your OS user, not in a sandbox.** Your own turns ask before writing files or running commands, unless you’ve granted that action. Sub-agents are read-only. **Drive’s coding turns run with every tool allowed**, so a mission works unattended; pushing, pull requests, releases and package publishes still ask. Run Drive where that’s acceptable. [Security boundaries →](SECURITY.md)

<details>
<summary><strong>Keyboard shortcuts</strong></summary>

| Do this | Use this |
| --- | --- |
| Send a message / add a line | Enter / Shift+Enter |
| Use the suggested next prompt | Tab on an empty composer |
| Open settings | Tab on an empty composer (no suggestion), or Ctrl+K |
| Inspect changes / files / checks | Alt+D / Alt+O / Alt+T |
| Open Drive / history | Alt+J / Alt+H |
| Return to live output | Ctrl+G |
| Stop work | Ctrl+C, or double Esc after closing menus and panels |
| Zoom (desktop) | ⌘= / ⌘- / ⌘0 |
| Close the UI | Ctrl+Q; daemon-owned work continues |

[All commands and shortcuts →](docs/cli-reference.md)

</details>

## Go deeper

| | |
| --- | --- |
| [Documentation index](docs/README.md) | Every guide in one place |
| [Configuration](docs/configuration.md) | Providers, context budgets, slots, and environment variables |
| [Architecture](docs/architecture.md) | Processes, APIs, storage, and request flows |
| [Troubleshooting](docs/troubleshooting.md) | Startup, auth, rendering, and slow inference |
| [Contributing](CONTRIBUTING.md) | Development setup and verification |

---

<p align="center">
  Built by <a href="https://github.com/Shingi-Michael">Shingirayi Kamucheka</a> ·
  <a href="LICENSE">MIT licensed</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/Shingi-Michael/demesne-cli/issues">Issues &amp; ideas</a>
</p>
