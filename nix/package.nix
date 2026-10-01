# dsh-electron as a Nix package.
#
# Mirrors the Arch packaging: a pure-JS Electron app installed read-only,
# driven by the distribution's Electron instead of a private one — here that
# means nixpkgs' prebuilt `electron-bin` (the `electron` attr would build
# Chromium from source), and Nix's nodejs for the harness launcher, since the
# shipped wrapper looks for /usr/bin/node by default.
{ lib
, stdenv
, fetchurl
, bash
, electron
  # NOTE: callPackage fills this from pkgs.electron, which builds Chromium
  # from source for hours. Always pass electron = pkgs.electron-bin (the
  # flake does); nix-build users:
  #   nix-build -E 'with import <nixpkgs> {}; callPackage ./nix/package.nix { electron = electron-bin; }'
, nodejs
, imagemagick
, makeWrapper
, version ? "1.1.0"
  # Not named `src`: callPackage would fill it from pkgs.src instead of the
  # default below, which is a confusing nixpkgs pitfall (pkgs.src is a real
  # attribute). The derivation still sets src = appSrc.
, appSrc ? fetchurl {
    # Release tarball; bump together with `version`. The flake overrides this
    # with the flake tree itself, so `nix build` packages the checkout, not
    # the published tarball.
    url = "https://github.com/PlazmaBot2000/dsh-electron/archive/v${version}.tar.gz";
    sha256 = "sha256-XGjVtqz6wMcZ5aYNOaHVzRzcyJMvw4VV4PAfHfkFyYk=";
  }
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "dsh-electron";
  inherit version;
  src = appSrc;

  # Both source shapes land in $sourceRoot: a GitHub tarball has a single
  # top-level directory (stdenv picks it up), a flake path *is* the tree.

  nativeBuildInputs = [ imagemagick makeWrapper ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    # genericBuild already lands us at the tree root for both source shapes
    # (tarball: auto-detected sourceRoot; path: $src itself), so no cd here.

    # 1. The application itself: a plain Electron app directory. The shipped
    #    launcher resolves APP_DIR relative to this location, so the whole
    #    tree can live read-only in the store.
    dest="$out/share/${finalAttrs.pname}"
    mkdir -p "$dest"
    cp -r src bin scripts build package.json README.md README.ru.md LICENSE "$dest/"
    chmod -R a+rX "$dest"
    chmod 755 "$dest/bin/${finalAttrs.pname}" "$dest"/scripts/*.sh

    # 2. A launcher on PATH. The inner bin/dsh-electron resolves the app tree
    #    and picks the Electron binary; DSH_* point it at the Nix-provided
    #    Electron and Node instead of /usr/lib/electron* and /usr/bin/node.
    #    --set-default keeps caller overrides (debug with a fake harness), and
    #    --prefix keeps the caller's PATH so the runtime `dsh` (npm global or
    #    ~/.local/bin) is still found by src/config.js candidates.
    makeWrapper "$dest/bin/${finalAttrs.pname}" "$out/bin/${finalAttrs.pname}" \
      --set-default DSH_ELECTRON_BIN "${electron}/bin/electron" \
      --set-default DSH_NODE_BIN "${lib.getExe nodejs}" \
      --prefix PATH : "${lib.makeBinPath [ bash electron nodejs ]}"

    # 3. Icons at the sizes desktop environments actually request.
    for size in 48 64 128 256 512; do
      d="$out/share/icons/hicolor/''${size}x''${size}/apps"
      mkdir -p "$d"
      convert "$dest/build/icon.png" -resize "''${size}x''${size}" "$d/${finalAttrs.pname}.png"
    done

    # 4. Desktop entry. StartupWMClass must match the WM_CLASS the running
    #    window carries (Electron derives it from the application name,
    #    "DeepSeek Harness" -> "deepseek-harness"), or the dock shows a
    #    second icon.
    mkdir -p "$out/share/applications"
    cat > "$out/share/applications/${finalAttrs.pname}.desktop" <<'EOF'
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

    # 5. License copy.
    install -Dm644 "$dest/LICENSE" "$out/share/licenses/${finalAttrs.pname}/LICENSE"

    runHook postInstall
  '';

  meta = {
    description = "Desktop shell for the local DeepSeek Harness runtime";
    homepage = "https://github.com/PlazmaBot2000/dsh-electron";
    license = lib.licenses.mit;
    mainProgram = finalAttrs.pname;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
    # The app is pure JS; Electron itself stays a regular (non-fixed-output)
    # runtime dependency.
    sourceProvenance = [ lib.sourceTypes.fromSource ];
  };
})
