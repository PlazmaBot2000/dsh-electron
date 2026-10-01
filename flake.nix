{
  description = "Desktop shell for the local DeepSeek Harness runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs { inherit system; }));
      # The flake tree *is* the application: keep just what the derivation
      # installs — the Electron app directory, the launcher, the icon and the
      # metadata — so the store copy stays small and pure.
      appSource = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./src
          ./bin
          ./scripts
          ./build
          ./package.json
          ./README.md
          ./README.ru.md
          ./LICENSE
        ];
      };
      mkPackage = pkgs: pkgs.callPackage ./nix/package.nix {
        # nixpkgs' default `electron` builds Chromium from source for hours;
        # the shell is a thin wrapper, so take the prebuilt one.
        electron = pkgs.electron-bin;
        appSrc = appSource;
      };
    in
    {
      packages = eachSystem (pkgs: {
        dsh-electron = mkPackage pkgs;
        default = mkPackage pkgs;
      });

      # nixpkgs users without flakes: the overlay takes the derivation's own
      # default source (the pinned release tarball) and electron-bin.
      overlays.default = final: prev: {
        dsh-electron = final.callPackage ./nix/package.nix {
          electron = final.electron-bin;
        };
      };
    };
}
