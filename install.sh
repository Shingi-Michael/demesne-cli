#!/bin/sh
# Installs or updates the Demesne desktop app for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/shingi-michael/demesne-cli/main/install.sh | sh
#
# Automatically detects fresh install vs upgrade; on upgrade, restarts any
# running daemon so it runs the new version.
#
# Options (after `sh -s --` when piped):
#   --version vX.Y.Z   install that release instead of the latest
#   --source           build from source (needs git, Bun 1.4 and Node.js 22+)
#   --no-restart       do not restart a running daemon on upgrade
#   --uninstall        remove the app, its launcher and icon (keeps ~/.demesne)
#   --insecure-skip-checksum  explicitly skip verification for trusted legacy releases
#
# Environment: DEMESNE_VERSION, DEMESNE_FROM_SOURCE=1, DEMESNE_NO_RESTART=1,
# DEMESNE_HOME (Linux install root, default ~/.local/share/demesne), DEMESNE_REPO,
# and DEMESNE_RELEASE_URL (a base URL that holds the release assets, for mirrors).
#
# Linux installs into $DEMESNE_HOME with a launcher in ~/.local/share/applications
# and `demesne-desktop` in ~/.local/bin. macOS installs Demesne.app into
# ~/Applications. Nothing needs sudo. Your sessions and settings in ~/.demesne
# are never touched.

set -eu

REPO="${DEMESNE_REPO:-shingi-michael/demesne-cli}"
VERSION="${DEMESNE_VERSION:-latest}"
FROM_SOURCE="${DEMESNE_FROM_SOURCE:-0}"
NO_RESTART="${DEMESNE_NO_RESTART:-0}"
SKIP_CHECKSUM=0
ACTION=install

usage() {
  cat <<'EOF'
Installs or updates the Demesne desktop app for the current user.

Usage: sh install.sh [options]
       curl -fsSL https://raw.githubusercontent.com/shingi-michael/demesne-cli/main/install.sh | sh -s -- [options]

  --version vX.Y.Z          install that release instead of the latest
  --source                  build from source (git, Bun 1.4, Node.js 22+)
  --no-restart               do not restart a running daemon on upgrade
  --restart                  restart a running daemon on upgrade (default)
  --insecure-skip-checksum   explicitly install without checksum verification
  --uninstall                remove the app, launcher and icon; keep ~/.demesne
  -h, --help                 show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --source) FROM_SOURCE=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --restart) NO_RESTART=0; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    --insecure-skip-checksum) SKIP_CHECKSUM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "demesne: $*"; }
die() { printf '%s\n' "demesne: $*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_HOME="${DEMESNE_HOME:-$DATA_HOME/demesne}"
BIN_DIR="$HOME/.local/bin"
DESKTOP_FILE="$DATA_HOME/applications/demesne.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/512x512/apps/demesne.png"
MAC_APP="$HOME/Applications/Demesne.app"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t demesne)
trap 'rm -rf "$TMP"' EXIT INT TERM

if has curl; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif has wget; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "needs curl or wget"
fi

release_url() {
  if [ -n "${DEMESNE_RELEASE_URL:-}" ]; then
    echo "${DEMESNE_RELEASE_URL%/}/$1"
  elif [ "$VERSION" = latest ]; then
    echo "https://github.com/$REPO/releases/latest/download/$1"
  else
    echo "https://github.com/$REPO/releases/download/$VERSION/$1"
  fi
}

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Downloads a release asset into $TMP and checks it against its .sha256.
# Returns 1 when the release does not carry that asset.
download() {
  fetch "$(release_url "$1")" "$TMP/$1" 2>/dev/null || return 1
  if [ "$SKIP_CHECKSUM" = 1 ]; then
    say "WARNING: checksum verification explicitly disabled for $1"
    return 0
  fi
  fetch "$(release_url "$1.sha256")" "$TMP/$1.sha256" \
    || die "could not fetch checksum for $1; refusing unverified install (only for trusted legacy releases, use --insecure-skip-checksum)"
  want=$(cut -d' ' -f1 <"$TMP/$1.sha256")
  got=$(sha256 "$TMP/$1")
  [ "$want" = "$got" ] || die "checksum mismatch for $1"
}

# Builds the desktop app from source into $TMP/src and prints the bundle path.
build_from_source() {
  for tool in git bun node; do has "$tool" || die "--source needs $tool"; done
  ref=main
  [ "$VERSION" = latest ] || ref="$VERSION"
  say "building $ref from source (a few minutes)"
  git clone --quiet --depth 1 --branch "$ref" "https://github.com/$REPO.git" "$TMP/src" >&2
  (cd "$TMP/src" && bun install --frozen-lockfile >&2 && bun run build:desktop -- --dir >&2)
}

# Electron's sandbox needs unprivileged user namespaces when chrome-sandbox is
# not setuid root, which a per-user install cannot make it. Ubuntu 24.04's
# AppArmor policy blocks them, so fall back to --no-sandbox there.
sandbox_flag() {
  if has unshare && unshare -Ur true >/dev/null 2>&1; then echo ""
  else echo " --no-sandbox"
  fi
}

install_linux() {
  [ "$(uname -m)" = x86_64 ] || [ "$FROM_SOURCE" = 1 ] \
    || die "prebuilt Linux builds are x86_64 only; try --source"
  stage="$TMP/stage"
  mkdir -p "$stage"
  if [ "$FROM_SOURCE" != 1 ] && download demesne-desktop-linux-x64.tar.gz; then
    tar -xzf "$TMP/demesne-desktop-linux-x64.tar.gz" -C "$stage"
    bundle="$stage/demesne"
  else
    if [ "$FROM_SOURCE" != 1 ]; then
      has bun && has git && has node \
        || die "release $VERSION has no Linux tarball; install git, Bun 1.4 and Node.js 22+ and rerun, or use the .deb on Ubuntu"
      say "release $VERSION has no Linux tarball"
    fi
    build_from_source
    bundle="$TMP/src/apps/desktop/release/linux-unpacked"
    cp "$TMP/src/apps/desktop/build/icon.png" "$bundle/icon.png"
  fi
  for file in demesne-desktop resources/backend/demesned resources/backend/demesne-desktop-host; do
    [ -x "$bundle/$file" ] || die "the bundle is missing $file"
  done

  # Swap the whole directory so a running copy keeps its files until it exits.
  mkdir -p "$(dirname "$APP_HOME")"
  rm -rf "$APP_HOME.new" "$APP_HOME.old"
  mv "$bundle" "$APP_HOME.new"
  [ -e "$APP_HOME" ] && mv "$APP_HOME" "$APP_HOME.old"
  mv "$APP_HOME.new" "$APP_HOME"
  rm -rf "$APP_HOME.old"

  mkdir -p "$BIN_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
  ln -sf "$APP_HOME/demesne-desktop" "$BIN_DIR/demesne-desktop"
  [ -f "$APP_HOME/icon.png" ] && cp "$APP_HOME/icon.png" "$ICON_FILE"
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Demesne
Comment=Coding agent with Drive
Exec=$APP_HOME/demesne-desktop$(sandbox_flag) %U
Icon=demesne
Terminal=false
Categories=Development;
StartupWMClass=Demesne
EOF
  has update-desktop-database && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
  has gtk-update-icon-cache && gtk-update-icon-cache -q "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

  if [ "$IS_UPGRADE" = 1 ]; then
    say "updated $APP_HOME"
  else
    say "installed to $APP_HOME"
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "add $BIN_DIR to PATH to run demesne-desktop from a terminal" ;; esac
  fi
}

install_macos() {
  [ "$(uname -m)" = arm64 ] || [ "$FROM_SOURCE" = 1 ] \
    || die "prebuilt macOS builds are Apple silicon only; try --source"
  if [ "$FROM_SOURCE" = 1 ]; then
    build_from_source
    app="$TMP/src/apps/desktop/release/mac-arm64/Demesne.app"
  else
    download demesne-desktop-darwin-arm64.zip || die "release $VERSION has no macOS app"
    ditto -x -k "$TMP/demesne-desktop-darwin-arm64.zip" "$TMP/stage"
    app="$TMP/stage/Demesne.app"
  fi
  [ -d "$app" ] || die "the download did not contain Demesne.app"
  mkdir -p "$(dirname "$MAC_APP")"
  rm -rf "$MAC_APP"
  mv "$app" "$MAC_APP"
  # Preview builds are unsigned; clear the download quarantine so they open.
  xattr -dr com.apple.quarantine "$MAC_APP" 2>/dev/null || true
  if [ "$IS_UPGRADE" = 1 ]; then
    say "updated $MAC_APP"
  else
    say "installed to $MAC_APP"
  fi
}

find_running_daemon_pid() {
  pid_file="$HOME/.demesne/daemon.pid"
  lock_file="$HOME/.demesne/daemon.lock/owner.json"
  pid=""
  if [ -f "$pid_file" ]; then
    p=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      pid="$p"
    fi
  fi
  if [ -z "$pid" ] && [ -f "$lock_file" ]; then
    p=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$lock_file" 2>/dev/null || true)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      pid="$p"
    fi
  fi
  echo "$pid"
}

# Stops and starts the daemon so it runs the newly installed binary.
restart_daemon() {
  old_pid="$1"
  pid_file="$HOME/.demesne/daemon.pid"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    say "stopping running daemon (pid $old_pid)..."
    kill "$old_pid" 2>/dev/null || true
    i=0
    while kill -0 "$old_pid" 2>/dev/null && [ "$i" -lt 30 ]; do
      sleep 0.2
      i=$((i + 1))
    done
    if kill -0 "$old_pid" 2>/dev/null; then
      say "warning: daemon pid $old_pid did not exit after 6s; kill it manually or use Settings › Data and daemon"
      return 1
    fi
    say "stopped daemon (pid $old_pid)"
    rm -f "$pid_file"
  fi

  daemon_bin=""
  case "$(uname -s)" in
    Darwin) daemon_bin="$MAC_APP/Contents/Resources/backend/demesned" ;;
    *) daemon_bin="$APP_HOME/resources/backend/demesned" ;;
  esac

  if [ -x "$daemon_bin" ]; then
    mkdir -p "$HOME/.demesne"
    chmod 700 "$HOME/.demesne" 2>/dev/null || true
    say "starting updated daemon..."
    log_file="$HOME/.demesne/daemon.log"
    touch "$log_file"
    log_start=$(( $(wc -c <"$log_file") + 1 ))
    if has nohup; then
      nohup "$daemon_bin" </dev/null >>"$HOME/.demesne/daemon.log" 2>&1 &
    else
      "$daemon_bin" </dev/null >>"$HOME/.demesne/daemon.log" 2>&1 &
    fi
    new_pid=$!
    # Read only this startup's output, not a stale listening line. The logged
    # URL respects configured ports and IPv6 without parsing the user's TOML.
    i=0
    while [ "$i" -lt 10 ] && kill -0 "$new_pid" 2>/dev/null; do
      daemon_url=$(tail -c +"$log_start" "$log_file" | sed -n 's/^demesned [^ ]* listening on \(http:\/\/[^ ]*\).*$/\1/p' | tail -n 1)
      if [ -n "$daemon_url" ] && daemon_healthy "${daemon_url%/}/healthz" && kill -0 "$new_pid" 2>/dev/null; then
        echo "$new_pid" >"$pid_file"
        chmod 600 "$pid_file" 2>/dev/null || true
        say "restarted daemon (pid $new_pid)"
        return 0
      fi
      sleep 1
      i=$((i + 1))
    done
    kill "$new_pid" 2>/dev/null || true
    # Do not wait indefinitely for a daemon that ignores SIGTERM.
    i=0
    while kill -0 "$new_pid" 2>/dev/null && [ "$i" -lt 15 ]; do
      sleep 0.2
      i=$((i + 1))
    done
    kill -KILL "$new_pid" 2>/dev/null || true
    wait "$new_pid" 2>/dev/null || true
    rm -f "$pid_file"
    tail -n 20 "$log_file" >&2
    die "updated daemon failed to become healthy; see $log_file"
  else
    say "daemon binary not found at $daemon_bin; launch Demesne desktop to start it"
  fi
}

daemon_healthy() {
  if has curl; then
    curl -fsS --noproxy '*' --max-time 1 "$1" >/dev/null 2>&1
  else
    wget -q --no-proxy -T 1 -t 1 -O /dev/null "$1" >/dev/null 2>&1
  fi
}

find_running_desktop_pid() {
  pid_file="$HOME/.demesne/desktop.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  if has pgrep; then
    # Match the full executable, not Linux's truncated comm name (which can
    # also match demesne-desktop-host), nor arbitrary command-line substrings.
    case "$(uname -s)" in
      Darwin) desktop_exe="$MAC_APP/Contents/MacOS/Demesne" ;;
      *) desktop_exe="$APP_HOME/demesne-desktop" ;;
    esac
    desktop_pattern=$(printf '%s' "$desktop_exe" | sed 's/[][\\.^$*+?(){}|]/\\&/g')
    pgrep -u "$(id -u)" -f "^$desktop_pattern( |$)" 2>/dev/null | head -n 1 || true
  fi
}

notify_desktop() {
  touch "$HOME/.demesne/desktop.reload" 2>/dev/null || true
  desktop_pid=$(find_running_desktop_pid)
  if [ -n "$desktop_pid" ]; then
    say "hot-reloaded desktop UI (pid $desktop_pid)"
    kill -USR1 "$desktop_pid" 2>/dev/null || true
  fi
}

handle_daemon() {
  # On upgrade, restart any running daemon so it runs the new version.
  if [ "$IS_UPGRADE" = 1 ] && [ -n "$DAEMON_PID" ]; then
    if [ "$NO_RESTART" = 1 ]; then
      say "a daemon from the previous version is still running (pid $DAEMON_PID); restart it from Settings › Data and daemon once nothing is working"
    else
      restart_daemon "$DAEMON_PID"
    fi
  fi
  if [ "$IS_UPGRADE" = 1 ]; then
    notify_desktop
  fi
}

uninstall() {
  case "$(uname -s)" in
    Darwin) rm -rf "$MAC_APP" ;;
    *)
      rm -rf "$APP_HOME" "$DESKTOP_FILE" "$ICON_FILE"
      [ -L "$BIN_DIR/demesne-desktop" ] && rm -f "$BIN_DIR/demesne-desktop"
      ;;
  esac
  say "removed the app; sessions and settings remain in ~/.demesne"
}

if [ "$ACTION" = uninstall ]; then uninstall; exit 0; fi

# Detect fresh install vs upgrade before modifying files
IS_UPGRADE=0
case "$(uname -s)" in
  Darwin) [ -d "$MAC_APP" ] && IS_UPGRADE=1 ;;
  *) ([ -d "$APP_HOME" ] || [ -f "$BIN_DIR/demesne-desktop" ] || [ -f "$DESKTOP_FILE" ]) && IS_UPGRADE=1 ;;
esac

DAEMON_PID=$(find_running_daemon_pid)

case "$(uname -s)" in
  Linux) install_linux ;;
  Darwin) install_macos ;;
  *) die "unsupported system $(uname -s); see https://github.com/$REPO#install" ;;
esac
handle_daemon
