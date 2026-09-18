#!/bin/sh
# Installs the latest Demesne release for macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Shingi-Michael/demesne-cli/main/scripts/install.sh | sh
#
# Environment:
#   DEMESNE_VERSION       Release tag to install (default: latest)
#   DEMESNE_INSTALL_DIR   Destination directory (default: ~/.local/bin)

set -eu

REPOSITORY="Shingi-Michael/demesne-cli"
INSTALL_DIR="${DEMESNE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "Demesne currently ships macOS binaries only." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [ -n "${DEMESNE_VERSION:-}" ]; then
  TAG="$DEMESNE_VERSION"
else
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPOSITORY}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
fi

if [ -z "$TAG" ]; then
  echo "Could not determine the latest Demesne release." >&2
  exit 1
fi

ARTIFACT="demesne-darwin-${ARCH}.tar.gz"
BASE_URL="https://github.com/${REPOSITORY}/releases/download/${TAG}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Downloading Demesne ${TAG} for darwin-${ARCH}..."
curl -fsSL "${BASE_URL}/${ARTIFACT}" -o "${TEMP_DIR}/${ARTIFACT}"
curl -fsSL "${BASE_URL}/${ARTIFACT}.sha256" -o "${TEMP_DIR}/${ARTIFACT}.sha256"

EXPECTED="$(awk '{print $1}' "${TEMP_DIR}/${ARTIFACT}.sha256")"
ACTUAL="$(shasum -a 256 "${TEMP_DIR}/${ARTIFACT}" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum verification failed for ${ARTIFACT}." >&2
  exit 1
fi

tar -xzf "${TEMP_DIR}/${ARTIFACT}" -C "$TEMP_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0755 "${TEMP_DIR}/demesne" "${INSTALL_DIR}/demesne"
install -m 0755 "${TEMP_DIR}/demesned" "${INSTALL_DIR}/demesned"

echo "Installed demesne and demesned to ${INSTALL_DIR}."
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to your PATH to run them." ;;
esac
