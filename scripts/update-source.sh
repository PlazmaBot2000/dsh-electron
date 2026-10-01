#!/usr/bin/env bash
# Pin the release tarball hash in both packaging files: sha256sums in the
# PKGBUILD (hex) and nix/package.nix's default appSrc (SRI base64).
# Run once per release, after the tag is pushed:
#   ./scripts/update-source.sh [vX.Y.Z]
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-v$(sed -n 's/^ *"version": "\(.*\)",$/\1/p' package.json)}"
url="https://github.com/PlazmaBot2000/dsh-electron/archive/${tag}.tar.gz"

echo "Fetching $url ..."
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
hash="$(sha256sum "$tmp" | cut -d' ' -f1)"
sri="$(openssl dgst -sha256 -binary < "$tmp" | openssl base64)"

sed -i "s/^sha256sums=.*/sha256sums=('${hash}')/" PKGBUILD
sed -i "s|sha256 = \"sha256-[A-Za-z0-9+/=]*\"|sha256 = \"sha256-${sri}\"|" nix/package.nix
echo "PKGBUILD pinned to ${hash}, nix/package.nix to sha256-${sri} for ${tag}"
echo "Review and commit alongside the release bump."
