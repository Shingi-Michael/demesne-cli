# Releases

Every merge to `main` makes a release (`.github/workflows/release.yml`): it picks the next version, builds the apps, uploads them to a draft release and publishes it. Installed apps update themselves from the latest release.

## Where it builds

The repository is private, so GitHub Actions minutes come out of the account's monthly budget, and GitHub's macOS machines bill ten minutes for each minute they run. A few merges a day spend the month. When the budget is spent, GitHub starts no job at all ("The job was not started because an Actions budget is preventing further use"), and releases stop until the month turns over or the budget is raised.

So releases can build on your own Mac instead. A self-hosted runner costs no minutes.

| `RELEASE_RUNNER` variable | Jobs run on | Builds |
| --- | --- | --- |
| unset | GitHub's machines | Mac, Linux, Windows |
| `mac` | your Mac (self-hosted runner) | Mac only |

With `mac`, a release waits while the Mac is asleep or offline and builds when it is back. Linux and Windows apps keep their last release; to build them, unset the variable for one run when the budget allows.

CI (`ci.yml`) runs on pull requests only, on GitHub's machines. It no longer runs again on the push to `main`.

## Setting up the runner on the Mac

Once, with the `gh` login that can administer the repo:

```sh
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL -o runner.tgz "$(gh api repos/actions/runner/releases/latest --jq '.assets[] | select(.name | test("osx-arm64-.*tar.gz$")) | .browser_download_url')"
tar xzf runner.tgz && rm runner.tgz
./config.sh --unattended --url https://github.com/Shingi-Michael/demesne-cli \
  --token "$(gh api -X POST repos/Shingi-Michael/demesne-cli/actions/runners/registration-token --jq .token)" \
  --name "$(scutil --get LocalHostName)" --replace
./svc.sh install && ./svc.sh start      # starts at login, keeps running
gh variable set RELEASE_RUNNER --body mac -R Shingi-Michael/demesne-cli
gh workflow run release.yml -R Shingi-Michael/demesne-cli   # release what is waiting
```

To go back to GitHub's machines: `gh variable delete RELEASE_RUNNER -R Shingi-Michael/demesne-cli`. To remove the runner: `./svc.sh uninstall` and `./config.sh remove --token "$(gh api -X POST repos/Shingi-Michael/demesne-cli/actions/runners/remove-token --jq .token)"`.

The runner checks out the repo into `~/actions-runner/_work`, never your own checkout, and needs `gh` on its `PATH` (Homebrew's `/opt/homebrew/bin` is picked up when it is configured from a normal shell).
