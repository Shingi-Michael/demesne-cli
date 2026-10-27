#!/usr/bin/env bash
# Installs the assistant's two always-on services for your user on Linux:
# the model (llama-server) and Demesne's daemon. Run it from anywhere:
#
#   scripts/assistant/install.sh --model ~/models/Qwen3.8-27B-Q5_K_M.gguf
#
# Options:
#   --model PATH         the GGUF file to serve (required)
#   --llama-server PATH  llama-server built with HIP (default: the one on PATH)
#   --demesned PATH      a built daemon (default: dist/demesned, else `bun run` from source)
#   --config             also write assistant.toml to ~/.demesne/config.toml (backs up the old one)
#   --dry-run            print the units instead of installing them
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
model="" llama_server="" demesned="" write_config=0 dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift 2 ;;
    --llama-server) llama_server="$2"; shift 2 ;;
    --demesned) demesned="$2"; shift 2 ;;
    --config) write_config=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "$1" >&2; exit 1; }

[ -n "$model" ] || fail "Say which model to serve: --model ~/models/Qwen3.8-27B-Q5_K_M.gguf"
model="$(realpath "$model" 2>/dev/null)" && [ -f "$model" ] || fail "No model file there."
llama_server="${llama_server:-$(command -v llama-server || true)}"
[ -x "$llama_server" ] || fail "llama-server isn't on PATH. Build llama.cpp with HIP and pass --llama-server PATH."
if [ -z "$demesned" ]; then
  if [ -x "$repo/dist/demesned" ]; then demesned="$repo/dist/demesned"
  else
    bun="$(command -v bun || true)"
    [ -n "$bun" ] || fail "No built daemon and no bun. Run 'bun run build:daemon' or pass --demesned PATH."
    demesned="$bun run $repo/apps/daemon/src/main.ts"
  fi
fi

# systemd splits ExecStart on spaces, so a path with one has to be quoted.
quote() { case "$1" in *" "*) printf '"%s"' "$1" ;; *) printf '%s' "$1" ;; esac; }

render() {
  sed -e "s|@LLAMA_SERVER@|$(quote "$llama_server")|" -e "s|@MODEL@|$(quote "$model")|" -e "s|@DEMESNED@|$demesned|" "$here/$1"
}

if [ "$dry_run" = 1 ]; then
  for unit in llama-server.service demesned.service; do echo "# $unit"; render "$unit"; echo; done
  exit 0
fi

units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
for unit in llama-server.service demesned.service; do render "$unit" > "$units/$unit"; done

if [ "$write_config" = 1 ]; then
  config="$HOME/.demesne/config.toml"
  mkdir -p "$HOME/.demesne" && chmod 700 "$HOME/.demesne"
  [ -f "$config" ] && cp "$config" "$config.bak.$(date +%Y%m%d%H%M%S)" && echo "Backed up your old config next to it."
  install -m 600 "$here/assistant.toml" "$config"
fi

systemctl --user daemon-reload
systemctl --user enable --now llama-server.service demesned.service
echo "Started. Check them with: systemctl --user status llama-server demesned"
echo "Logs: journalctl --user -u llama-server -f"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "They stop when you log out. To keep them running from boot: sudo loginctl enable-linger $USER"
fi
