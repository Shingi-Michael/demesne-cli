# Security Policy

## Scope

Demesne runs a local daemon that executes model-authored tools with the
permissions of the operating-system user who started it. `run_command` is host
execution, not a sandbox. The project's security boundaries are:

- The daemon listens on loopback only. Remote control is intentionally
  unavailable until paired-device authentication exists.
- Every non-health route requires the bearer token stored in
  `~/.demesne/daemon.token` (mode `0600`).
- The data directory must be private to the current user.
- Sensitive paths such as `.env`, `.git`, `.ssh`, `.aws`, `.docker`, common
  credential files, and private keys are excluded from automatic reads and
  searches.
- Workspaces cannot be `/`, the user's home directory, or overlap the Demesne
  data directory.

Approval prompts are the primary defense against unintended writes and
commands. Redirected or otherwise non-interactive use denies these operations
by default.

## Reporting a Vulnerability

Please do not open a public issue for security problems. Use the repository's
private security advisory form ("Report a vulnerability" under the Security
tab) and include:

- A description of the issue and its impact.
- Reproduction steps or a proof of concept.
- The version, platform, and configuration involved.
- Any suggested mitigation.

You can expect an acknowledgement within a few days. Confirmed issues will be
fixed in a patch release and credited unless you prefer otherwise.

## Supported Versions

Only the latest release receives security fixes while the project is in
pre-1.0 development.
