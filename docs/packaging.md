# Packaging boxd for Void Linux

Paths and the package split follow `docs/designs/layout.md`. Templates are in `srcpkgs/`, tools in `tools/`.
Debian-based distributions are in `docs/packaging-debian.md`.

## Packages

| Package | Template | Content |
|---|---|---|
| `boxd` | `srcpkgs/boxd` | documents only; install `boxd-server` or `boxd-client` |
| `boxd-server` | `srcpkgs/boxd` (subpackage) | build host: programs, settings, the `boxd` and `boxd-sshd` services |
| `boxd-power` | `srcpkgs/boxd` (subpackage) | optional power module, service `boxd-power` |
| `boxd-client` | `srcpkgs/boxd` (subpackage) | the `box` command and the skill |
| `microsandbox-bin` | `srcpkgs/microsandbox-bin` | pinned official release, `/usr/lib/microsandbox/<version>/`, link `/usr/bin/msb` |

One template with subpackages: the three parts share one source archive and one version, so they cannot drift apart.
`srcpkgs/boxd-server`, `boxd-power` and `boxd-client` are symlinks to `boxd`, as `xbps-src` requires.

Decisions the layout did not cover:

- No `system_accounts`. The build account is made by `boxd-setup` (one place, rerunnable, honours `BOXD_USER`); a
  package trigger would make a second kind of account.
- `boxd-power` depends on `boxd-server` at the same version or newer.
- `microsandbox-bin` keeps `archs="x86_64"`, `nostrip`, `noshlibprovides`. Apache-2.0 allows redistribution, so it is
  not `restricted`; the license file is installed.
- The services keep their `down` files for `boxd-sshd` and `boxd-power`; `boxd` is the only one that starts them.
- The checksum of the `boxd` source archive is a placeholder in the template until a tag exists. `tools/build-packages`
  replaces it in its own work copy; write the real value into the template when you cut a tag.

## Build (build host, inside a box, unprivileged account)

```
tools/build-packages
```

Clones `void-packages` into `$BOXD_PKG_WORK` (default `~/boxd-packages`), copies `srcpkgs/` in, runs `xbps-src pkg` for
`boxd` and `microsandbox-bin`. Output: unsigned `.xbps` files in `$BOXD_PKG_WORK/void-packages/hostdir/binpkgs`.
It never signs; the key is not on this machine.

## Sign and publish (the maintainer's workstation)

One time: `openssl genrsa -out <key> 4096`, mode 0600, kept in `~/.secrets` territory, backed up. Then:

```
BOXD_SIGNING_KEY=<key> GITEA_TOKEN=<token> BOXD_BUILD_HOST=<ssh target> tools/sign-and-publish
```

Steps: rsync the new `.xbps` files from the build host into `~/.local/share/boxd-repo`, `xbps-rindex --add`,
`--sign --signedby "boxd"`, `--sign-pkg`; upload packages and `.sig2` files first and `x86_64-repodata` last (an
existing name answers 409, so each file is deleted before upload); finally download everything anonymously with the
user agent `xbps/2.0` and compare checksums. `BOXD_PUBLISH_ALL=1` re-uploads every file.

## Release in one command

```
BOXD_SIGNING_KEY=<key> GITEA_TOKEN=<token> tools/release <version>
```

From a clean `main` whose template and `CHANGELOG.md` carry `<version>`: tags `v<version>`, builds the packages in a
virtual machine box on the default build host (`box --vm`, image `ghcr.io/void-linux/void-glibc`), pulls them, then
runs `tools/sign-and-publish`. A rerun after a failed build reuses the tag. Upgrading the hosts
(`xbps-install -Syu boxd-server boxd-power`) stays a separate step.

## Client setup (every machine that installs boxd)

```
# /etc/xbps.d/boxd.conf
repository=https://gitea.example.com/api/packages/OWNER/generic/boxd/x86_64
```

The index lists only the newest version of each package (that is how an xbps repository works): pin with a range such as
`boxd-client>=0.4.4_1<0.5`, not with an exact older version, which answers "not found in repository pool". The files of older versions
stay downloadable at the same address for a manual `xbps-install` from a local folder.

Then `xbps-install -S boxd-server` (or `boxd-client`). The first sync asks to accept the key fingerprint; compare it
with `xbps-rindex`/the owner's copy before accepting. To import the public key without the prompt, place it as
`/var/db/xbps/keys/<fingerprint>.plist` as `xbps-install` would write it.

## Upgrading the microsandbox pin

1. Open the new release on GitHub, read `checksums.sha256`, take the line for `microsandbox-linux-x86_64.tar.gz`.
2. Download the release `LICENSE` at the tag and run `sha256sum` on it.
3. Edit `srcpkgs/microsandbox-bin/template`: `version`, both `checksum` lines, reset `revision=1`.
4. Check `tar -tzvf` of the tarball: `msb` and `libkrunfw.so.*` must still be top-level files.
5. Build, sign, publish as above. Current pin: 0.7.15, tarball sha256
   `37ffc7bf7b2b977ab004f620f47ae4466f021a9b880c94f46f697c56cf6932b7`.

## Unverified

Nothing here was built. Not yet checked: `xbps-src lint`, that `msb` runs from `/usr/lib/microsandbox/<version>/`
(the experiment says it finds `libkrunfw` beside its real path), that Gitea's per-file `DELETE` returns 204 for the
generic registry, that the homeserver proxy lets the `xbps/2.0` user agent through, and that a Gitea tag archive keeps a
stable checksum.

## Probed on the real hosts (2026-11-13)

- Anonymous download from the generic registry works (HTTP 200 without a token; the owner account is public).
- The homeserver proxy's crawler block lets xbps through: user agent `xbps/2.0` gets 200, a crawler agent gets 403.
- Deleting a single file of a generic package version works (204); the other files stay (200). Re-uploading an
  existing file name returns 409, so `sign-and-publish` deletes first.

## Published (2026-11-13)

The registry address is set with the environment variable `BOXD_REGISTRY` (the release tools require it; there is no default). The addresses below use the placeholder `https://gitea.example.com` and `OWNER`.

`boxd` 0.1.0 (boxd, boxd-server, boxd-power, boxd-client) and `microsandbox-bin` 0.7.15 are published at
`https://gitea.example.com/api/packages/OWNER/generic/boxd/x86_64`, signed by "boxd"
(fingerprint `<fingerprint of your signing key>`). Packages are public, so clients need no login. Builds use `BOXD_SOURCE_ARCHIVE` from `git archive <tag>`.

Client setup, in this order (a first sync that imports the key must run on its own; combined with an install in one
command xbps reported "not found in repository pool"):

    echo 'repository=https://gitea.example.com/api/packages/OWNER/generic/boxd/x86_64' | sudo tee /etc/xbps.d/boxd.conf
    sudo xbps-install -S          # shows the fingerprint above; answer yes
    sudo xbps-install boxd-client # or boxd-server (+ boxd-power) on a build host

Verified: a dry-run install into an empty root on the workstation resolved all four packages and their Void dependencies.
