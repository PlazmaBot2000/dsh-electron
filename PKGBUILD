# Maintainer: PlazmaBot2000 <guardian9641@gmail.com>
# Packaged from the GitHub release tarball. The PKGBUILD ships inside that very
# tarball, so pinning its checksum would be self-referential: the tag itself is
# the identity and sha256sums stays SKIP. To build a published tag with a pinned
# hash locally, run scripts/update-source.sh first.
pkgname=dsh-electron
pkgver=1.1.0
pkgrel=1
pkgdesc='Desktop shell for the local DeepSeek Harness runtime'
arch=('any')
url='https://github.com/PlazmaBot2000/dsh-electron'
license=('MIT')
# The runtime is the distribution's Electron (the launcher globs
# /usr/lib/electron*/electron), which keeps the shell a thin wrapper and lets
# Chromium receive distro security updates.
depends=('electron')
makedepends=('imagemagick')
install="${pkgname}.install"
source=("${pkgname}-${pkgver}.tar.gz::${url}/archive/v${pkgver}.tar.gz")
sha256sums=('SKIP')

package() {
  cd "${srcdir}/${pkgname}-${pkgver}"

  # 1. The application itself: a plain Electron app directory. The shipped
  #    launcher resolves APP_DIR relative to this location, so the whole tree
  #    lands read-only under /usr/share.
  install -d "${pkgdir}/usr/share/${pkgname}"
  cp -r src bin scripts build package.json README.md README.ru.md LICENSE \
    "${pkgdir}/usr/share/${pkgname}/"
  # The GitHub archive preserves whatever modes the author's umask produced;
  # normalize to the usual 644/755 so the read-only tree is world-readable.
  find "${pkgdir}/usr/share/${pkgname}" -type d -exec chmod 755 {} +
  find "${pkgdir}/usr/share/${pkgname}" -type f -exec chmod 644 {} +
  chmod 755 "${pkgdir}/usr/share/${pkgname}/bin/${pkgname}" \
    "${pkgdir}/usr/share/${pkgname}/scripts/"*.sh

  # 2. A launcher on PATH that follows the packaged app, mirroring what
  #    scripts/install.sh does for a source checkout.
  printf '#!/bin/sh\nexec /usr/share/%s/bin/%s "$@"\n' "${pkgname}" "${pkgname}" \
    | install -Dm755 /dev/stdin "${pkgdir}/usr/bin/${pkgname}"

  # 3. Icons at the sizes desktop environments actually request.
  for size in 48 64 128 256 512; do
    install -d "${pkgdir}/usr/share/icons/hicolor/${size}x${size}/apps"
    convert "build/icon.png" -resize "${size}x${size}" \
      "${pkgdir}/usr/share/icons/hicolor/${size}x${size}/apps/${pkgname}.png"
  done

  # 4. Desktop entry. StartupWMClass must match the WM_CLASS the running window
  #    carries (Electron derives it from the application name, "DeepSeek
  #    Harness" -> "deepseek-harness"), or the dock shows a second icon.
  install -d "${pkgdir}/usr/share/applications"
  cat > "${pkgdir}/usr/share/applications/${pkgname}.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Version=1.0
Name=DeepSeek Harness
GenericName=AI coding agent
Comment=Desktop shell for the local DeepSeek Harness runtime
Exec=dsh-electron
TryExec=dsh-electron
Icon=dsh-electron
Terminal=false
Categories=Development;Utility;
Keywords=deepseek;harness;dsh;ai;agent;shell;terminal;
StartupNotify=true
StartupWMClass=deepseek-harness
EOF

  # 5. License copy for the package manager.
  install -Dm644 LICENSE "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
}
