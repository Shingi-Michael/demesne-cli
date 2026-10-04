<p align="center">
  <img src="docs/assets/hero.svg" alt="demesne — An agent workspace. Inside your terminal." width="100%">
</p>

<p align="center">
  A coding agent with a browser-rendered interface in Ghostty.<br>
  Local or hosted models. Durable work. Every change open to inspection.
</p>

<p align="center">
  <a href="https://github.com/Shingi-Michael/demesne-cli/actions/workflows/ci.yml"><img src="https://github.com/Shingi-Michael/demesne-cli/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-334b5e?style=flat-square&amp;labelColor=101a23" alt="MIT license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-1.4.0-334b5e?style=flat-square&amp;labelColor=101a23" alt="Bun 1.4.0"></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="docs/README.md"><strong>Documentation</strong></a> ·
  <a href="docs/architecture.md"><strong>Architecture</strong></a> ·
  <a href="CONTRIBUTING.md"><strong>Contribute</strong></a>
</p>

<br>

<a href="docs/assets/demesne-review.png"><img src="docs/assets/demesne-review.png" alt="Demesne showing a completed coding turn beside the retry helper’s diff and passing checks" width="100%"></a>

<p align="center"><sub>The real graphics UI, captured from terminal image tiles using an isolated, deterministic demo. <a href="docs/assets/README.md">About these captures</a>.</sub></p>

## A place to build—and understand what changed

Demesne brings the conversation, code, and evidence into one terminal workspace. A local daemon owns the work, so closing the interface doesn’t discard an active coding turn. Reopen a session to inspect its history and continue.

<table>
<tr>
<td width="50%" valign="top">
<h3>See the work</h3>
<p>Review diffs, open source files, inspect command output, and rerun checks. Recorded evidence stays attached to the turn that produced it.</p>
<a href="apps/graphics/README.md#review-panel-upgrades">Explore the panels →</a>
</td>
<td width="50%" valign="top">
<h3>Choose your model</h3>
<p>Connect a local OpenAI-compatible server, OpenRouter, or your ChatGPT account. Pick the model and supported reasoning level for the task.</p>
<a href="docs/authentication.md">Connect a provider →</a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>Delegate the investigation</h3>
<p>Send independent questions to read-only subagents with separate contexts. Provider-specific queues match concurrency to your server’s capacity.</p>
<a href="docs/subagents.md">Meet the subagents →</a>
</td>
<td width="50%" valign="top">
<h3>Give Drive a mission</h3>
<p>Choose evidence-linked next steps, or set a mission. Drive coordinates coding turns, checks results, and remembers completed work and project preferences.</p>
<a href="docs/agent-drive.md">How Drive works →</a>
</td>
</tr>
</table>

## Get started

**You’ll need [Bun 1.4.0](https://bun.sh), [Ghostty](https://ghostty.org), and a model connection.** The graphics interface uses Electron/Chromium and Kitty graphics; the plain CLI supports headless workflows. Published release builds target macOS; Linux source setup and sandbox repair are covered in the [Linux guide](docs/linux.md).

```sh
git clone https://github.com/Shingi-Michael/demesne-cli.git
cd demesne-cli
bun install --frozen-lockfile
bun run build
bun run build:graphics

./dist/demesne setup
./dist/demesne daemon start
./dist/demesne
```

Setup walks through the provider, model, and configuration. Choose a local server, **Continue with ChatGPT**, OpenRouter, or a custom endpoint. [Provider and account guide →](docs/authentication.md)

<details>
<summary><strong>Installation details and working in another project</strong></summary>

Both builds are required for the graphics interface. Keep `dist/graphics` and `dist/node_modules` beside the CLI and daemon:

```text
dist/
├── demesne
├── demesned
├── graphics/
└── node_modules/
```

Link the binaries into an existing directory on your PATH, then open your project:

```sh
ln -sf "$PWD/dist/demesne" "$PWD/dist/demesned" /usr/local/bin/
cd /path/to/project
demesne
```

For source development, use `bun run graphics:setup` and `bun run demesne`. [Graphics setup and packaging](apps/graphics/README.md) covers the details; [troubleshooting](docs/troubleshooting.md) covers older running processes and terminal capabilities. Rebuilds don’t replace a running daemon or UI.

</details>

## From an idea to a verified change

```text
Explain how session restore works, with file references.
```

Explore first, then ask for a focused change. Inspect the result beside the conversation, or delegate a bounded mission:

```text
/drive --bounded Fix the failing parser tests and verify the change
```

Plain `/drive <mission>` is continuous; `--bounded` stops after one verified task. NEXT’s **Run** action starts a bounded mission. Drive still waits for your approvals and answers. [Mission controls and limits →](docs/agent-drive.md)

<details>
<summary><strong>See the start screen and Drive’s NEXT queue</strong></summary>

### Start with a question or a suggested next step

<img src="docs/assets/demesne-start.png" alt="Demesne start screen with the composer, starter actions, and three Drive proposals" width="100%">

### Decide what runs next

<img src="docs/assets/demesne-drive.png" alt="Drive NEXT panel with evidence-linked proposals and Run, Plan first, Not now, and Never actions" width="100%">

These are demo scenarios rendered by the application, not live-model performance benchmarks.

</details>

## Stay in control

| Do this | Use this |
| --- | --- |
| Send a message / add a line | Enter / Shift+Enter |
| Open settings | Tab on an empty composer, or Ctrl+K |
| Inspect changes / files / checks | Alt+D / Alt+O / Alt+T |
| Open Drive / history | Alt+J / Alt+H |
| Return to live output | Ctrl+G |
| Stop work | Ctrl+C, or double Esc after closing menus/panels |
| Close the UI | Ctrl+Q; daemon-owned work continues |

[All commands and keyboard shortcuts →](docs/cli-reference.md)

Writes and host commands require approval unless a matching grant applies. **Commands run as your OS user, not in a sandbox.** Subagents are read-only, and Drive cannot approve tools on your behalf. [Security boundaries →](SECURITY.md)

## Also at home in a script

```sh
demesne prompt --output json "Explain the test layout"
echo "Summarize this failure" | demesne prompt --output stream-json
demesne ps --json
```

Use text, JSON, or streamed events. Non-interactive approval requests are denied rather than left waiting. [Headless usage →](docs/cli-reference.md#headless-output)

## Go deeper

| | |
| --- | --- |
| [Documentation index](docs/README.md) | Every guide in one place |
| [Configuration](docs/configuration.md) | Providers, context budgets, slots, and environment variables |
| [Architecture](docs/architecture.md) | Processes, APIs, storage, and request flows |
| [Image preview](docs/artifact-preview-plan.md) | Artifacts, references, zoom, and model vision |
| [Troubleshooting](docs/troubleshooting.md) | Startup, auth, rendering, and slow inference |
| [Contributing](CONTRIBUTING.md) | Development setup and verification |

---

<p align="center">
  Built by <a href="https://github.com/Shingi-Michael">Shingirayi Kamucheka</a> ·
  <a href="LICENSE">MIT licensed</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/Shingi-Michael/demesne-cli/issues">Issues &amp; ideas</a>
</p>
