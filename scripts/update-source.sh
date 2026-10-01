#!/usr/bin/env bash
# Pin PKGBUILD's sha256sums to the GitHub release tarball it downloads.
# Run once per release, after the tag is pushed:
#   ./scripts/update-source.sh [vX.Y.Z]
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-v$(sed -n 's/^ *"version": "\(.*\)",$/\1/p' package.json)}"
url="https://github.com/PlazmaBot2000/dsh-electron/archive/${tag}.tar.gz"

echo "Fetching $url ..."
hash="$(curl -fsSL "$url" | sha256sum | cut -d' ' -f1)"

sed -i "s/^sha256sums=.*/sha256sums=('${hash}')/" PKGBUILD
echo "PKGBUILD sha256sums pinned to $hash for ${tag}"
echo "Review and commit alongside the release bump."
