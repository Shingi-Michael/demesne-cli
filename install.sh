#!/bin/sh
# Installs or updates the Demesne desktop app for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/shingi-michael/demesne-cli/main/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --version vX.Y.Z   install that release instead of the latest
#   --source           build from source (needs git, Bun 1.4 and Node.js 22+)
#   --uninstall        remove the app, its launcher and icon (keeps ~/.demesne)
#
# Environment: DEMESNE_VERSION, DEMESNE_FROM_SOURCE=1, DEMESNE_HOME (Linux
# install root, default ~/.local/share/demesne), DEMESNE_REPO, and
# DEMESNE_RELEASE_URL (a base URL that holds the release assets, for mirrors).
#
# Linux installs into $DEMESNE_HOME with a launcher in ~/.local/share/applications
# and `demesne-desktop` in ~/.local/bin. macOS installs Demesne.app into
# ~/Applications. Nothing needs sudo. Your sessions and settings in ~/.demesne
# are never touched.

set -eu

REPO="${DEMESNE_REPO:-shingi-michael/demesne-cli}"
VERSION="${DEMESNE_VERSION:-latest}"
FROM_SOURCE="${DEMESNE_FROM_SOURCE:-0}"
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --source) FROM_SOURCE=1; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  if fetch "$(release_url "$1.sha256")" "$TMP/$1.sha256" 2>/dev/null; then
    want=$(cut -d' ' -f1 <"$TMP/$1.sha256")
    got=$(sha256 "$TMP/$1")
    [ "$want" = "$got" ] || die "checksum mismatch for $1"
  else
    say "no checksum published for $1; skipping verification"
  fi
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

  say "installed to $APP_HOME"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "add $BIN_DIR to PATH to run demesne-desktop from a terminal" ;; esac
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
  say "installed to $MAC_APP"
}

# An older daemon keeps serving until it restarts; say so rather than stop it
# under running work.
daemon_note() {
  if [ -f "$HOME/.demesne/daemon.pid" ] && kill -0 "$(cat "$HOME/.demesne/daemon.pid")" 2>/dev/null; then
    say "a daemon from the previous version is still running; use Settings › Data and daemon › Restart the daemon once nothing is working"
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
case "$(uname -s)" in
  Linux) install_linux ;;
  Darwin) install_macos ;;
  *) die "unsupported system $(uname -s); see https://github.com/$REPO#install" ;;
esac
daemon_note
