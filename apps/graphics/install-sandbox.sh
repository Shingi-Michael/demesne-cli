#!/bin/sh
# Invoked explicitly via graphics:setup --install-sandbox. Only this copy runs as root.
set -eu
source_path=$1
expected_hash=$2
case "$source_path" in /*) ;; *) echo 'Sandbox source must be absolute' >&2; exit 1;; esac
case "$expected_hash" in *[!a-f0-9]*|'') echo 'Invalid sandbox hash' >&2; exit 1;; esac
[ "${#expected_hash}" = 64 ] || exit 1
[ "$(id -u)" = 0 ] || { echo 'Sandbox installation requires administrator access' >&2; exit 1; }
# Refuse redirects or writable ancestors; never change ownership of a user's tree.
for directory in /usr /usr/local /usr/local/lib /usr/local/lib/demesne /usr/local/lib/demesne/sandbox; do
  [ ! -L "$directory" ] || { echo "Refusing symlink: $directory" >&2; exit 1; }
  if [ ! -e "$directory" ]; then mkdir -m 755 -- "$directory"; fi
  [ -d "$directory" ] && [ "$(stat -c %u -- "$directory")" = 0 ] || exit 1
  directory_mode=$(stat -c %a -- "$directory")
  [ "$((0$directory_mode & 0022))" = 0 ] || { echo "Unsafe writable directory: $directory" >&2; exit 1; }
done
# Atomic root-owned copy, verified BEFORE granting setuid. Updates get different hashes.
destination="/usr/local/lib/demesne/sandbox/$expected_hash"
[ ! -L "$destination" ] || exit 1
if [ ! -e "$destination" ]; then mkdir -m 755 -- "$destination"; fi
[ -d "$destination" ] && [ "$(stat -c %u -- "$destination")" = 0 ] || exit 1
directory_mode=$(stat -c %a -- "$destination")
[ "$((0$directory_mode & 0022))" = 0 ] || exit 1
copy_path=$(mktemp "$destination/.install-XXXXXX")
trap 'rm -f -- "$copy_path"' EXIT HUP INT TERM
cat -- "$source_path" > "$copy_path"
actual_hash=$(sha256sum -- "$copy_path")
[ "${actual_hash%% *}" = "$expected_hash" ] || { echo 'Sandbox helper changed; installation refused' >&2; exit 1; }
chown root:root -- "$copy_path"
chmod 4755 -- "$copy_path"
mv -fT -- "$copy_path" "$destination/chrome-sandbox"
