# Linux graphics setup

[Documentation index](README.md) · [Graphics interface](../apps/graphics/README.md) · [Troubleshooting](troubleshooting.md)

Run Demesne as your normal user inside Ghostty in a Linux desktop session. Bun dependencies are installed once; a missing Electron runtime is downloaded automatically on source launch:

```sh
bun install --frozen-lockfile
bun run demesne setup
bun run demesne daemon start
bun run graphics
```

Before opening the terminal UI, Linux launches a small **sandboxed** Electron renderer and verifies that it produces pixels. It forwards the desktop’s display/authentication variables, including `XAUTHORITY`, while keeping provider credentials out of Electron’s environment. No model request is made by this check.

For a standalone check:

```sh
bun run graphics:setup
# Or, with a built bundle:
./dist/graphics/host --check-runtime
```

`bun run graphics:setup --download-only` downloads the runtime for headless builds. It explicitly does **not** certify that display access or sandboxing works. `build:graphics` uses this download-only path so packaging does not require a desktop.

## SUID sandbox helper failure

An error about a SUID helper requiring root ownership and mode `4755` concerns Electron’s **chrome-sandbox executable**, not your project directory. If startup identifies this failure:

```sh
bun run graphics:setup --install-sandbox
bun run graphics
```

For the compiled bundle:

```sh
./dist/graphics/host --install-sandbox
./dist/demesne
```

This is an explicit administrator-assisted repair. The command asks `sudo` to run only the small helper-installation script, which:

1. Checks that the destination directories are root-owned, not writable by other users, and not symlinks.
2. Copies the helper to `/usr/local/lib/demesne/sandbox/<sha256>/chrome-sandbox`.
3. Verifies the copied bytes before setting root ownership and mode `4755`.
4. Atomically installs the copy. The normal user then links their Electron runtime to it.
5. Re-runs the sandboxed renderer check before reporting success.

It does not elevate Bun, the coding daemon or the UI, and does not change workspace permissions. Installation is never attempted automatically. An Electron upgrade can require a new helper copy. Packaged builds contain ordinary helper bytes rather than an absolute link to the builder’s machine; each destination machine validates its own setup.

A read-only/system-owned runtime needs its package administrator to establish the helper link. Containers mounted `nosuid`, containers forbidding namespace creation, and restrictive host policies can still prevent startup after permissions are correct. The startup check reports that failure; it does not disable sandboxing or change host-wide security policy. See [Electron’s sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox).

## Desktop libraries and display access

A minimal Linux installation may lack Electron’s shared libraries. The launcher identifies the missing library. On Ubuntu 20.04, the common runtime dependencies are:

```sh
sudo apt-get install libgtk-3-0 libnss3 libgbm1 libatk-bridge2.0-0 libcups2 libasound2
```

Ubuntu 24.04 uses `libasound2t64` in place of `libasound2`. Package installation is an administrator action; Demesne does not run `apt` automatically. See the [CI image](../.github/linux/Dockerfile) for the tested dependency lists.

No `DISPLAY` or `WAYLAND_DISPLAY` means there is no configured graphical session. For a desktop, launch from Ghostty in the logged-in session. Over headless SSH, use `demesne prompt`; terminal graphics capability alone does not provide an Electron display server. Native window capture is currently macOS-only.

## Trusting a workspace

The first time you open a folder, Demesne asks whether you trust its files. Its instruction files, project commands and config can steer the agent, which then reads, writes and runs commands there. The answer is recorded once per folder and covers its subfolders. See [workspace trust](../SECURITY.md#workspace-trust).

Directory ownership and mode bits aren't checked: a group-writable project (for example mode `775` under Ubuntu's default `umask 002`) opens normally.

## What CI verifies

[Linux graphics CI](../.github/workflows/graphics-linux.yml) runs Ubuntu 20.04 and 24.04 userlands in isolated containers on an Ubuntu runner. Xvfb supplies an X11 display; the real Electron runtime and a synthetic terminal exercise the Kitty graphics transport. The jobs:

- Force the SUID route to reproduce an incorrectly configured helper.
- Install and verify the protected helper, then render with the sandbox enabled.
- Accept a group-writable (`775`) workspace without changing its mode.
- Capture a coding turn, actual file edit, passing checks and Drive proposals through decoded terminal tiles.
- Build the graphics bundle and verify its setup and startup checks independently.

The disposable containers allow the namespace operations needed by the SUID helper. This verifies those Ubuntu libraries and the application path, not every distribution’s kernel policy. Software rendering, X11 and the synthetic terminal do not establish GPU performance, Wayland compositor integration, or a manual Ghostty desktop session. No real model, personal credentials or project data are used.
