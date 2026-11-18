# Packaging boxd for Debian and Debian-based distributions

Paths and the package split follow the Debian table of `docs/designs/layout.md`. Control files and maintainer scripts are in
`debpkgs/`, the units in `server/systemd/`, the tools in `tools/`, the check in `tests/deb-package-test.sh`. The first target is
Debian 13 "trixie" and its derivative LMDE 7; the packages are architecture independent except
`microsandbox-bin`.

## Packages

| Package | Architecture | Content |
|---|---|---|
| `boxd` | all | documents only (readme, this file, the layout); suggests the other two |
| `boxd-server` | all | build host: programs, settings, the units `boxd.service` and `boxd-sshd.service`, the toolbox image sources |
| `boxd-client` | all | the `box` command and the Claude skill |
| `microsandbox-bin` | amd64 | the pinned official release (`/usr/lib/microsandbox/<version>/`, link `/usr/bin/msb`); same version and checksums as `srcpkgs/microsandbox-bin/template`, which `tools/build-deb` reads |

`boxd-power` (the module that sleeps the host when idle) is **not packaged**: `homeserver` never sleeps, and the module needs a unit
for `boxd-idle` that nobody has tested yet. `BOXD_POWER=on` on a systemd host is reported by `boxd-setup` and refused by
`boxctl check`.

Dependencies of `boxd-server`: `podman (>= 5.0)`, `openssh-server`, `rsync`, `git`, `uidmap`, `catatonit`, `procps`, `systemd`, `socat` (the relay of `pod forward`).
They are what `boxd-pod`, `boxd-setup`, `work-setup` and `boxd-reset` really call beyond Essential packages (`useradd`, `usermod`,
`runuser`, `findmnt`, `blkid`, `flock`, `base64`, `awk`, `pgrep` come from Essential packages, `util-linux` and `procps`).
`uidmap` gives rootless podman its subordinate id mapping, `catatonit` is the init that `podman run --init` starts. Recommended:
`btrfs-progs` (only used when the work area is btrfs), `microsandbox-bin` (virtual machine boxes), `passt` (rootless container
networking of podman 5). Suggested: `zram-tools`. `jq` is only used by the tests, so it is no dependency.

## Build

On a Debian machine, or in a Debian container box (the build host runs Void, so a box is how it is done there):

```
tools/build-deb                      # boxd boxd-server boxd-client microsandbox-bin, into ./deb-out
tools/build-deb boxd-server          # one package
BOXD_SOURCE_ARCHIVE=boxd-0.2.0.tar.gz tools/build-deb   # from `git archive --prefix=boxd-0.2.0/ v0.2.0`
```

From the repository on any boxd build server:

```
box --image docker.io/library/debian:trixie-slim -- sh -c 'apt-get update && apt-get install -y curl ca-certificates && tools/build-deb'
box --pull deb-out --image docker.io/library/debian:trixie-slim -- bash tests/deb-package-test.sh   # builds, checks, copies deb-out back
```

No root: files are staged in a temporary folder and `dpkg-deb --root-owner-group` records root ownership. `debhelper` was not
chosen: the packages are shell and node files copied to fixed paths, the file list already lives in `layout.md`, and a
container with `debhelper` and `dpkg-dev` would need the layout repeated as `debian/*.install` files. Environment: `BOXD_DEB_OUT`,
`BOXD_DEB_REVISION` (default 1), `BOXD_SOURCE_ARCHIVE`, `BOXD_MSB_TARBALL` and `BOXD_MSB_LICENSE` (local copies; the checksums of
the template are checked either way), `SOURCE_DATE_EPOCH`. The same inputs give byte-identical files. The version of `boxd` is
`<template version>-<revision>`, of `microsandbox-bin` `<release version>-<revision>`.

`boxd.conf` is the only file that differs from its repository source: `tools/build-deb` enables its `BOXD_CGROUP` line (see below).

## Publish

```
GITEA_TOKEN=<token with package write> tools/publish-deb            # every file of ./deb-out
```

The registry address is set with the environment variables `GITEA_URL` and `GITEA_OWNER`, which `tools/publish-deb` and `tools/release-deb` require (there is no default). Uploads to `https://gitea.example.com/api/packages/OWNER/debian/pool/trixie/main/upload` (`GITEA_URL`, `GITEA_OWNER`,
`BOXD_DEB_DIST`, `BOXD_DEB_COMPONENT` change it), deletes and re-uploads a file the registry already has (answer 409), and reads
the index back anonymously. The registry builds and signs `Release` and `Packages` itself. The packages stay public, like the Void
ones. The distribution name `trixie` is just a name in the registry; it is not checked against the host.

For a released version, `tools/release-deb <version>` does the whole round in one command: it builds the three packages from the
tag `v<version>` in a `debian:13` container, checks that `boxd-pod` in the server package is the file of the tag, publishes with
`tools/publish-deb` (the token comes from `GITEA_TOKEN` or `~/.secrets`), and installs from the registry in a fresh container to
compare the checksums. `--no-publish` stops after the build; `BOXD_DEB_ENGINE=podman` changes the container engine. `BOXD_DEB_KEEP=<folder>` copies the built `.deb` files there (made if missing) once the build succeeded, with or without `--no-publish`; `tools/release-github` uploads them to the GitHub release (see `docs/packaging.md`).

## Install on a Debian host

```
sudo curl -fsSL https://gitea.example.com/api/packages/OWNER/debian/repository.key -o /etc/apt/keyrings/gitea-boxd.asc
echo 'deb [signed-by=/etc/apt/keyrings/gitea-boxd.asc] https://gitea.example.com/api/packages/OWNER/debian trixie main' | sudo tee /etc/apt/sources.list.d/boxd.list
sudo apt update
sudo apt install boxd-server          # boxd-client on the agents' machine
```

Compare the key's fingerprint with the owner's copy before trusting it. Without the registry, `sudo apt install ./boxd-server_*.deb
./microsandbox-bin_*.deb` works the same (apt resolves the dependencies from the local files).

## First setup of a build host

Installing changes nothing but files. Then, as root:

```
sudoedit /etc/boxd/boxd.conf                       # at least BOXD_PORT when 2222 is taken (see the homeserver notes)
boxd-setup --key /path/to/agents-machine.pub       # account, work area, ssh settings, virtual machine support; add --images for the toolbox image
# after a rebuild of the image (boxd-setup --images again) new machine boxes get the new image by themselves; existing boxes, with --recreate
boxctl check                                       # every condition boxd needs
boxctl start                                       # boxd.service: starts boxd-sshd.service and the reaper
boxctl status
```

`boxd-setup` on a systemd host: makes the account `boxd` and its work area (`work-setup`), writes
`/etc/ssh/sshd_config.d/20-boxd.conf` (`DenyUsers boxd` on the main sshd, optional connection penalty exemption), installs
`microsandbox-bin` with `apt-get` when `/dev/kvm` and processor virtualization exist and the package is in an apt source (else
containers only, said plainly), tunes `zram-tools` when it is installed, runs `systemctl daemon-reload` and
`systemctl enable boxd.service`, reloads `ssh`. It does **not** start boxd: on a host where the default port is taken a start before
the setting is right would fail in a loop. `boxctl start` starts it. Virtual machine boxes need the account in group `kvm` and take
effect for new sessions only.

`boxctl log` reads the journal (`journalctl -u boxd-sshd.service`); `boxctl log boxd -f` follows boxd.

## The work area without btrfs

Void hosts keep the work area as btrfs subvolumes (`@work`, `@work-clean`, `@cache`) so a reset takes milliseconds. A host whose root
is ext4 (or anything but btrfs) cannot do that, so `work-setup` chooses **directory mode** (`BOXD_WORK_FS=auto`, or `dir`):

- the work area is a plain folder, `/var/lib/boxd/work`, with a marker file `.boxd-dir-mode`; `cache/` inside it belongs to the build account;
- the pristine copy is the folder next to it, `/var/lib/boxd/work-clean`, rebuilt by every `work-setup` run;
- `boxd-reset` runs `rsync -a --delete --exclude=/cache` from the pristine copy (`all` also empties the cache). It refuses and
  kills the same way the btrfs version does. It takes as long as deleting the files, from seconds to minutes with big caches;
- nothing is mounted, so no `fstab` lines, no `rprivate`, no `rc.local`.

An existing work area keeps its kind (a btrfs mount stays btrfs; the marker file stays directory mode). A host on btrfs, such as a
Debian install on btrfs, gets the subvolume layout and the same fstab lines as Void; `btrfs-progs` is then needed. Hardening that
`work-setup` does only for Void is skipped on systemd hosts: `/var/tmp` in memory (a Debian server keeps its own), the mail spool mode,
`CGROUP_MODE` in `rc.conf`, `rc.local`. Podman settings are linked as drop-ins (`/etc/containers/containers.conf.d/boxd.conf`,
`/etc/containers/storage.conf.d/boxd.conf`) because `/etc/containers/storage.conf` belongs to the package `containers-common`
there.

## What differs from Void, and why

| Topic | Void | Debian | Why |
|---|---|---|---|
| Service manager | runit service directories in `/etc/sv` | systemd units in `/usr/lib/systemd/system` | Debian 13 runs systemd; the `run` and `finish` files are the same files, installed under `/usr/libexec/boxd/` (`boxd-run`, `boxd-finish`, `sshd-run`), told the manager by `BOXD_MANAGER=systemd` in the unit. One logic, two thin wrappers |
| One program for the owner | `boxctl` calls `sv` | `boxctl` calls `systemctl` and `journalctl` | `boxctl` picks the manager (`BOXD_MANAGER`, else `/run/systemd/system` exists) |
| Which services run | `boxd` enabled and started; `boxd-sshd` carries a `down` file | `boxd.service` enabled, not started by setup; `boxd-sshd.service` has no `[Install]` | the same shape; not starting is for the port check |
| Build cgroup | made by the run file at `/sys/fs/cgroup/boxd` | the cgroup systemd makes for the unit, `/sys/fs/cgroup/boxd.slice/boxd-sshd.service` | see the next section |
| Stop of the build sshd | `sv stop` signals only sshd | `KillMode=process` | a stop of the unit must not kill running builds mid-write; `boxd` stopping removes the boxes, as before |
| Stop file | runit's `./finish` | `ExecStopPost=` (also runs when the run file ends by itself) | `finish` runs whenever `run` ends under runit |
| Logs | `svlogd` files in `/var/log/boxd*` | journal | native |
| Work area | btrfs subvolumes | btrfs or a plain folder | the first Debian host may not use btrfs |
| Podman settings | `/etc/containers/storage.conf` replaced by a link | drop-ins | package-owned file |
| Hardening of the first host | `/var/tmp` in memory, mail spool, rc files | not done | other distribution, other defaults |
| Compressed swap | `zramen` | `zram-tools`, only when installed | what each distribution has |
| Virtual machine package | `xbps-install` | `apt-get install` from the registry | |
| Power module | `boxd-power` | not packaged | out of scope for the first cut |

### The build cgroup path (decision)

`boxd-pod` measures the build cgroup (`memory.stat`, `memory.max`) to admit virtual machines (`vm_mem`, hook `BOXD_CGROOT`).
Under runit the run file makes `/sys/fs/cgroup/boxd` itself. Under systemd, a cgroup made at the root by hand lives outside what
systemd manages, and systemd may rewrite the root's controller list. The clean way is the unit's own cgroup with `Delegate=yes`,
which has another name. The path therefore became a **documented setting**, `BOXD_CGROUP` (default `/sys/fs/cgroup/boxd`, so Void
does not change), and the packaged `/etc/boxd/boxd.conf` enables it as `/sys/fs/cgroup/boxd.slice/boxd-sshd.service` (`Slice=boxd.slice`
in the unit). Alternatives rejected: detecting the path at run time from `/proc/self/cgroup` (magic, and the reaper runs in another
cgroup), a fixed second default in the code chosen by `/run/systemd/system` (breaks the tests on any systemd host, and the setting is
clearer). The run file refuses to start under systemd when its own cgroup is not `BOXD_CGROUP`, so a wrong value cannot silently admit
virtual machines against the wrong cap. If `memory.max` ever reads `max`, `boxd-pod` already falls back to the memory of the host.

## Podman 5.4 against the options boxd uses

Debian 13 has podman 5.4.2; the Void hosts run 6.x. Every option `boxd-pod`, `images-build` and `work-setup` pass to podman is listed in
step 9 of `tests/deb-package-test.sh`, which asks the installed podman's `--help` for it. See "Results" below for the outcome.
Differences that do not show in options and that the owner should know: podman 5 uses `pasta` (package `passt`) for rootless container
networking, so without `passt` a box has no network; `boxd.conf` limits (`--memory`, `--memory-swap`, `--pids-limit`,
`--cpu-shares`) need the cgroup controllers `memory`, `pids` and `cpu` delegated to the build account, which `sshd-run` does with the
delegated cgroup of the unit; `cgroup_manager = "cgroupfs"` and `events_logger = "file"` (`containers.conf`) are right for an account
that has no systemd user session (the build sshd has no PAM session).

## homeserver notes

Read from the host on 2026-11-13: LMDE 7 "gigi" (Debian 13 base), amd64, kernel 7.1.8, systemd 257, 24 processors, 62 GB memory,
`/dev/kvm`, cgroups version 2, 370 GB free on one root file system of unknown type; `openssh-server`, `rsync`, `jq` and `docker-ce`
installed, no podman, `uidmap`, `passt`, `crun`, `fuse-overlayfs`, `zram-tools`.

- **Port.** Ports 22 and 2222 are in use (2222 by another service). Set `BOXD_PORT=2223` in `/etc/boxd/boxd.conf` **before**
  `boxctl start`; the default stays 2222 in the code. Then `box setup homeserver --port 2223` on the agents' machine.
  `boxd-setup` prints the port it will use; `ss -ltn | grep :2223` must show nothing before the first start.
- **Docker is not touched.** boxd uses podman for the build account only, in its own storage under the work area. `docker-ce`'s
  service, networks and `docker0` are left alone; podman's rootless networking (`pasta`) does not use `docker0`. Nothing of boxd
  edits `/etc/docker`. One overlap: both run containers, so memory pressure is shared; `BOXD_MEM_MAX` (85 percent of the memory by
  default) caps the build side only. Consider a lower `BOXD_MEM_MAX` there, for example `40G`.
- **File system.** Run `findmnt -n -o FSTYPE /` first. btrfs gets subvolumes at the top of the file system (`@work`, `@cache`,
  `@work-clean`) and two `fstab` lines, with `btrfs-progs`; anything else gets directory mode and no `fstab` change. Force one with
  `BOXD_WORK_FS`. With about 370 GB free, a reset in directory mode is limited by the size of the caches, not by the processor.
- **Podman.** Debian's candidate is 5.4.2. All options pass (see Results). `crun` and `netavark` come with it; `fuse-overlayfs` is not
  needed and not wanted (`storage.conf` has no `mount_program`; the kernel's overlay is used rootless).
- **Never sleeps.** The power module is not installed, so nothing arms wake-on-network or sleeps the host.
- **Proxy, git server, model server.** Nothing in boxd listens on port 22, 80 or 443 or changes the main `sshd` other than the
  `DenyUsers boxd` drop-in; `boxd-sshd.service` listens on `BOXD_PORT` only.
- **Order** for the owner's session: `apt install` the registry key and source, `apt install boxd-server microsandbox-bin`,
  edit `boxd.conf` (port), `boxd-setup --key <agents key> --images`, `boxctl check`, `boxctl start`, then from the agents' machine
  `box setup homeserver --port 2223` and a first `box --vm echo ok` and `box echo ok`.

## Proven on systemd (in a box machine, 2026-11-14)

`tests/deb-systemd-test.sh` runs inside a boxd virtual machine box (own kernel, root, 4 GB; the command is in the script's header). A box machine's
first process is not systemd, so the script starts a Debian 13 container with systemd as its first process (podman inside the machine,
`--systemd=always --privileged --cgroupns=private`; systemd 257, cgroups version 2), builds and installs the four packages there, and checks them with
`podman exec`. Last run: 73 checks ok, `ALL OK`, twice in a row in the same machine. Docker and `systemd-nspawn` were not needed.

| Item | Evidence (real output) |
|---|---|
| `tools/build-deb` builds four packages in Debian; `apt install ./*.deb` resolves the dependencies | four files; `dpkg-query`: `ii ii ii ii`, podman 5.4.2, `dpkg --audit` empty |
| `boxd-setup` runs to the end on systemd | exit 0, `boxd.service` `enabled`, not started; `boxctl check`: `boxd: conditions hold` |
| `boxctl start`, `status`, `log` against real units | both units `active`; `status` shows `Active: active (running)` twice; `log boxd`: `sh[..]: boxd: up`; `log sshd`: `Server listening on 0.0.0.0 port 2299.` |
| The build sshd gets `/sys/fs/cgroup/boxd.slice/boxd-sshd.service` | `systemctl show -p ControlGroup`: `/boxd.slice/boxd-sshd.service`; sshd's `/proc/<pid>/cgroup`: `0::/boxd.slice/boxd-sshd.service/sshd` |
| Controllers can be handed to the children; the account owns the cgroup | `cgroup.subtree_control`: `cpu memory pids`; owner `boxd` |
| `memory.max` equals `BOXD_MEM_MAX` and survives `daemon-reload` and `boxctl reload` | `2147483648` (2G) before, after `systemctl daemon-reload`, after `boxctl reload` |
| A real call through the build sshd | `ssh -p 2299 boxd@127.0.0.1 'pod status'`: `version=0.3.0 engines=container ... vm_room=no` |
| Real `box` client (`box setup 127.0.0.1`), real rootless podman 5.4 box, exit code, second call, `--user`, `pod ps` | `exit 7` passes through; a file written by call one is read by call two; `--user --pod usr`: uid `1000`, home `/job/home`; `box ps` lists `sleep 600` |
| The box's processes are inside the capped cgroup | container init: `0::/boxd.slice/boxd-sshd.service/<container id>`; the unit's `memory.current` counts them |
| `KillMode=process` on `systemctl stop boxd-sshd` | both boxes keep running, an open session runs to its end (exit 0, its file is written), the unit starts again |
| `boxctl stop` removes the boxes; `boxctl start` works again | `podman ps -aq` empty; `boxd: down` in the journal; new `pod status` and a new box after the start |
| `boxd-reset work` in directory mode | exit 0 without `--force` (no session open): leftover gone, cache kept, marker kept, boxes removed |
| `dpkg --purge` | account and work area stay; units, `/etc/boxd`, drop-ins, the `boxd.service` link gone; `systemctl show -p LoadState`: `not-found`; nothing listens on the port |

Defects the run found, all fixed (see `CHANGELOG.md`):

- `sshd-run` ran `/usr/bin/sshd`; Debian has it in `/usr/sbin` (it looks in both now, `BOXD_SSHD` still wins).
- `boxd-sshd.service` could not start again after a plain stop while boxes were running (`Failed to spawn 'start' task: Device or resource busy`).
  A cgroup that hands controllers to its children cannot hold a process, and systemd put the new main process into it. The unit has
  `DelegateSubgroup=sshd` now (systemd 254 or newer; Debian 13 has 257); `sshd-run` accepts the child cgroup as its own.
- Every podman call of the build account failed (`mkdir /run/user/1000: permission denied`): podman keeps its run state there, logind removes the
  folder when the last login session of the account ends (each `runuser -l`). `work-setup` enables lingering for the account on systemd hosts, which
  keeps the folder owned by the account; `postrm` removes the setting on purge.
- `sshd-run` printed a raw shell error where `memory.swap.max` does not exist (kernel without swap support); it says so and skips the cap.

What the test bed changes, none of it a packaging fact: the machine's disk (not the container's overlay root) carries `/var/lib/boxd`, because the
kernel's overlay does not nest on an overlay; fuse-overlayfs is not used. `/dev/net/tun` of the machine is made world-usable (a real host has it 0666) for
pasta. The image's `/usr/sbin/policy-rc.d` (container images refuse every service stop in package scripts) is removed. The machine has no swap, so
`memory.swap.max` is not checked, and the bare image has two failed units (`systemd-modules-load`, `systemd-sysctl`, no kernel modules in a container) that are not boxd's.

## Still unproven

- Virtual machine boxes (microsandbox): the machine has no `/dev/kvm`, so `boxd-setup` correctly said "containers only" and `msb` could not run a box. What would settle it:
  `boxd-setup` and a first `box --vm echo ok` on a Debian host with `/dev/kvm` (`homeserver`).
- A reboot of the host: `boxd.service` coming up by itself at boot, lingering and `/run/user/<uid>` before the first call. The container's systemd started once.
  What would settle it: `reboot` on `homeserver`, then `boxctl status` and `box echo ok`.
- Swap cap: `memory.swap.max` written to `BOXD_SWAP_MAX` on a host with swap (the machine has none).
- The unit as the real kernel and a non-nested disk see it (the container shares the machine's kernel; storage there is ext4 under overlay, as on a real host, but the first run on `homeserver` is the proof).
- `tools/publish-deb` is proven for 0.4.8 and 0.4.9 (2026-11-15; with 0.4.9 the path of an existing file was seen too: upload 409, delete 204, upload 201, and the index check now reads the index of each file's architecture, `all` packages being only in `binary-all`): the registry accepted the three `Architecture: all` files and the `amd64` one, a Debian 13
  container with only the registry source ran `apt update`, saw all four packages at the published version, downloaded them with checksums equal to
  the local files, and `apt install boxd-server` installed `boxd-server 0.4.8-1` and `microsandbox-bin 0.7.15-1`. Not seen: the delete answering 204
  (the 409 path of an existing file), and one first run of `tools/publish-deb` over all four files ended without a message after the third
  upload (the fourth file, 21 MB, was on the registry afterwards; a rerun of that file alone printed the index check and the source lines). A
  `curl` failure under `set -e` in its `code` function exited silently; since then `code` prints curl's error and the upload reports status 000.

## Results of the last run in a Debian 13 container

`box --image docker.io/library/debian:trixie-slim -- bash tests/deb-package-test.sh` on 2026-11-13: 171 checks ok, none failed, last line
`ALL OK`. Debian 13 container, podman 5.4.2, nodejs 20.19.2, systemd 257.

- Build: four packages (`boxd_0.2.0-1_all`, `boxd-server_0.2.0-1_all`, `boxd-client_0.2.0-1_all`, `microsandbox-bin_0.7.15-1_amd64`);
  a second build and a build from a tag archive are byte identical.
- lintian: no error. Warnings that remain, none hidden: `initial-upload-closes-no-bugs` (four packages: the changelog is generated, there is
  no bug to close), `no-manual-page` (`box`, `boxctl`, `boxd-keepawake`, `boxd-pod`, `boxd-reset`, `boxd-setup`, `msb`: the programs have
  `--help`/usage text and the documents are in `/usr/share/doc/boxd`, no manual pages written yet), `copyright-without-copyright-notice` for
  `microsandbox-bin` (the upstream release names no copyright holder or year that was verified; the licence text is shipped as `LICENSE`).
  Overridden with a reason: `relative-library-search-path` of `msb` (`$ORIGIN`: libkrunfw beside the binary by design).
- apt installed all four local files and resolved podman 5.4.2, catatonit, uidmap, openssh-server and the rest.
- Every installed path is a row of the layout table, with mode and owner; every row is installed; nothing else is installed; every
  program is byte for byte its repository file; `boxd.conf` differs only by the enabled `BOXD_CGROUP` line.
- `systemd-analyze verify` accepts both units without a complaint.
- `boxctl check` fails as it should without an account and work area; after `work-setup` in directory mode it finds both.
  `work-setup` and `boxd-reset work|all` ran for real in directory mode (leftovers removed, cache kept or emptied, marker kept).
- `tests/contract-pod-test.sh` against the installed `/usr/bin/boxd-pod`: `ALL OK`.
- Podman 5.4.2 **accepted every option** `boxd-pod` uses: `run --init --userns --pull --label --hostname --name --memory --memory-swap
  --pids-limit --cpu-shares -w -v -d -e`, `exec -i -w -e --user`, `ps --filter --format -a`, `rm -f -a`, `container inspect --format`,
  `image inspect --format`, `image prune -f`, `image exists`, `save -o`, `load -i`, `build -f -t`. **No incompatibility with podman 5.4
  was found.** What the check cannot show is behaviour: `--userns=keep-id` and `--pull=missing` on 5.4 ran only against the
  fake podman of the contract suite, never a real box.
- `dpkg --purge boxd-server` removes the programs, settings and podman drop-ins and leaves the account and work area.
