# boxd file layout: the contract between the code and the packages

The code (server/, client/, power/) and the Void templates (srcpkgs/) both follow this table. Change it here first,
then both sides. Names: product `boxd`, client command `box`. Anything machine specific is a setting, never code.

## boxd-server (the build host)

| Installed path | Source in the repository | What |
|---|---|---|
| /usr/bin/boxd-pod | server/boxd-pod | ForceCommand dispatcher (was tower-pod) |
| /usr/bin/boxd-reset | server/boxd-reset | build area reset (was tower-reset) |
| /usr/bin/boxd-keepawake | server/boxd-keepawake | keep the host busy while a command runs (was keepawake) |
| /usr/bin/boxctl | server/boxctl | start, stop, status, check, log, reload (wraps sv) |
| /usr/bin/boxd-setup | server/boxd-setup | one-time, rerunnable host setup (account, subvolumes, fstab, key, kvm, zram, images) |
| /usr/libexec/boxd/images-build | server/images-build | builds and archives an image from /usr/share/boxd/images/<name> |
| /usr/libexec/boxd/work-setup | server/work-setup | build area part of boxd-setup |
| /usr/share/boxd/images/toolbox/ | images/toolbox/ | Containerfile and toolbox-check |
| /etc/boxd/boxd.conf | server/boxd.conf | ALL settings, sh syntax (conf_files: kept on upgrade) |
| /etc/boxd/sshd_config | server/sshd_config | the build account's own sshd (conf_files) |
| /etc/boxd/storage.conf, /etc/boxd/containers.conf | server/ | podman settings; boxd-setup links them into /etc/containers |
| /etc/sv/boxd/ | server/sv/boxd/ | the one service the owner controls: run starts boxd-sshd (and boxd-power when enabled), finish stops everything (boxes too) |
| /etc/sv/boxd-sshd/ | server/sv/boxd-sshd/ | build sshd inside the capped cgroup (was sshd-build); ships with a `down` file, started by boxd |
| /var/lib/boxd/images/ | (created by the package, mounted by setup) | image archives that survive `boxd-reset all`; on btrfs the subvolume @boxd-images |

## boxd-power (optional module, OFF by default)

| Installed path | Source | What |
|---|---|---|
| /usr/bin/boxd-idle | power/boxd-idle | sleep after quiet minutes, arm wake on the network cards, reset before sleep (was tower-idle) |
| /etc/sv/boxd-power/ | power/sv/boxd-power/ | ships with a `down` file; boxd starts it only when BOXD_POWER=on |

## boxd-client (the agents' machine)

| Installed path | Source | What |
|---|---|---|
| /usr/bin/box | client/box (sh shim) | `exec node /usr/lib/boxd/box.mjs "$@"` |
| /usr/lib/boxd/box.mjs | client/box.mts compiled | the client (was tower.mjs) |
| /usr/lib/boxd/box-wake.mjs | client/box-wake.mts compiled | wakes sleeping hosts before ssh (was tower-wake.mjs) |
| /usr/share/boxd/skill/SKILL.md | client/skill/SKILL.md | Claude skill; `box setup` installs it for the user |

`box setup <host> [--port 2222] [--wake <mac>,<mac> --broadcast <addr>]` writes the user's ssh entries (`Host boxd-<host>`)
and, only for hosts given wake addresses, the ssh Match line that runs box-wake. Void's ssh_config has no include
directory, so this stays a per-user command.

## Settings (/etc/boxd/boxd.conf, defaults in the code)

BOXD_USER (build account, default boxd; the tower keeps "build"), BOXD_WORK (default /var/lib/boxd/work; the tower
keeps /work), BOXD_WORK_FS (auto, btrfs or dir: how the work area is kept clean), BOXD_CGROUP (the build cgroup folder, default
/sys/fs/cgroup/boxd; the Debian package names the cgroup of boxd-sshd.service), BOXD_PORT (2222), BOXD_TRUSTED_NET (address range exempt from ssh penalties, default empty),
BOXD_LIMITS, BOXD_VM_LIMITS, BOXD_VM_MAX, BOXD_VM_ENGINE_DISK, BOXD_VM_TMP_DISK, BOXD_VM_NET_ALLOW, BOXD_TTL, BOXD_IMAGE, BOXD_MEM_MAX (cgroup memory.max,
default 85 % of memory), BOXD_SWAP_MAX, BOXD_POWER (off|on), BOXD_IDLE_CHECKS, BOXD_IDLE_LOAD_MAX, BOXD_RESET_AT,
BOXD_WIRED, BOXD_WIFI, BOXD_IDLE_IGNORE (addresses whose build-port connections are not work; power module only). Keys that may only read are a
file, /etc/boxd/view_keys (written by `boxd-setup --view-key`), not a setting. The values of a given host are kept by whatever installs boxd there, which
writes this file.

## Packages

boxd-server depends on podman, catatonit, rsync, git, util-linux, btrfs-progs, zramen (optional swap), openssh; it
does NOT depend on microsandbox-bin: boxd-setup installs microsandbox-bin when /dev/kvm and processor
virtualization exist (owner decision: virtual machines optional, installed by default where supported).
boxd-power depends on boxd-server, ethtool, iw. boxd-client depends on nodejs, rsync, openssh.
microsandbox-bin repacks the pinned official release tarball (checksum checked): /usr/lib/microsandbox/<version>/
(msb and libkrunfw side by side) and /usr/bin/msb.

## Debian packages (the file list of `tools/build-deb` and `tests/deb-package-test.sh`)

The Debian side follows the tables above with three differences: systemd units replace the runit service directories
(the `run` and `finish` files are the same files, installed under `/usr/libexec/boxd/` with the manager named in the
unit), the packaged `boxd.conf` names the build cgroup (`BOXD_CGROUP`), and there is no `boxd-power` yet (the first
host never sleeps). Rows of this table are read by `tools/build-deb` (what to install) and by the test (what must be
installed): keep one row per path, five columns. `Source` is a file of the repository, a folder ending in `/` (the whole
tree, modes kept), or one of `dir` (an empty folder made by the package), `generated:copyright`,
`generated:changelog` (the Debian changelog), `generated:upstream-changelog` (CHANGELOG.md), `download:<file>` (a file of
the pinned microsandbox release, `download:LICENSE` its licence) or `link:<target>` (a symbolic link). `@MSB_VERSION@` is
the version in `srcpkgs/microsandbox-bin/template`. A path under `/etc` is a conffile.

| Package | Installed path | Source | Mode | What |
|---|---|---|---|---|
| boxd-server | /usr/bin/boxd-pod | server/boxd-pod | 755 | dispatcher |
| boxd-server | /usr/bin/boxd-reset | server/boxd-reset | 755 | build area reset |
| boxd-server | /usr/bin/boxd-keepawake | server/boxd-keepawake | 755 | |
| boxd-server | /usr/bin/boxctl | server/boxctl | 755 | wraps systemctl (or sv) |
| boxd-server | /usr/bin/boxd-setup | server/boxd-setup | 755 | |
| boxd-server | /usr/libexec/boxd/images-build | server/images-build | 755 | |
| boxd-server | /usr/libexec/boxd/work-setup | server/work-setup | 755 | |
| boxd-server | /usr/libexec/boxd/boxd-run | server/sv/boxd/run | 755 | run file of boxd.service |
| boxd-server | /usr/libexec/boxd/boxd-finish | server/sv/boxd/finish | 755 | stop file of boxd.service |
| boxd-server | /usr/libexec/boxd/sshd-run | server/sv/boxd-sshd/run | 755 | run file of boxd-sshd.service |
| boxd-server | /usr/share/boxd/images/toolbox/ | images/toolbox/ | tree | toolbox image sources |
| boxd-server | /etc/boxd/boxd.conf | server/boxd.conf | 644 | with the BOXD_CGROUP line enabled |
| boxd-server | /etc/boxd/sshd_config | server/sshd_config | 644 | |
| boxd-server | /etc/boxd/storage.conf | server/storage.conf | 644 | linked into /etc/containers/storage.conf.d |
| boxd-server | /etc/boxd/containers.conf | server/containers.conf | 644 | linked into /etc/containers/containers.conf.d |
| boxd-server | /usr/lib/systemd/system/boxd.service | server/systemd/boxd.service | 644 | the owner's service |
| boxd-server | /usr/lib/systemd/system/boxd-sshd.service | server/systemd/boxd-sshd.service | 644 | the capped build sshd |
| boxd-server | /var/lib/boxd/images/ | dir | 755 | image archives that survive a reset |
| boxd-server | /usr/share/doc/boxd-server/copyright | generated:copyright | 644 | |
| boxd-server | /usr/share/doc/boxd-server/changelog.Debian.gz | generated:changelog | 644 | |
| boxd-server | /usr/share/doc/boxd-server/changelog.gz | generated:upstream-changelog | 644 | |
| boxd-client | /usr/bin/box | client/box | 755 | sh shim |
| boxd-client | /usr/lib/boxd/box.mjs | client/box.mjs | 644 | |
| boxd-client | /usr/lib/boxd/box-wake.mjs | client/box-wake.mjs | 644 | |
| boxd-client | /usr/share/boxd/skill/SKILL.md | client/skill/SKILL.md | 644 | |
| boxd-client | /usr/share/doc/boxd-client/copyright | generated:copyright | 644 | |
| boxd-client | /usr/share/doc/boxd-client/changelog.Debian.gz | generated:changelog | 644 | |
| boxd-client | /usr/share/doc/boxd-client/changelog.gz | generated:upstream-changelog | 644 | |
| boxd | /usr/share/doc/boxd/README.md | README.md | 644 | documents only |
| boxd | /usr/share/doc/boxd/packaging-debian.md | docs/packaging-debian.md | 644 | |
| boxd | /usr/share/doc/boxd/layout.md | docs/designs/layout.md | 644 | |
| boxd | /usr/share/doc/boxd/copyright | generated:copyright | 644 | |
| boxd | /usr/share/doc/boxd/changelog.Debian.gz | generated:changelog | 644 | |
| boxd | /usr/share/doc/boxd/changelog.gz | generated:upstream-changelog | 644 | |
| microsandbox-bin | /usr/lib/microsandbox/@MSB_VERSION@/msb | download:msb | 755 | |
| microsandbox-bin | /usr/lib/microsandbox/@MSB_VERSION@/libkrunfw.so.* | download:libkrunfw.so.* | 644 | a library, not executable |
| microsandbox-bin | /usr/bin/msb | link:../lib/microsandbox/@MSB_VERSION@/msb | link | |
| microsandbox-bin | /usr/share/doc/microsandbox-bin/copyright | generated:copyright | 644 | names the common Apache-2.0 licence file |
| microsandbox-bin | /usr/share/doc/microsandbox-bin/LICENSE | download:LICENSE | 644 | upstream licence text |
| microsandbox-bin | /usr/share/lintian/overrides/microsandbox-bin | debpkgs/microsandbox-bin/lintian-overrides | 644 | the upstream binary finds libkrunfw beside it |
| microsandbox-bin | /usr/share/doc/microsandbox-bin/changelog.Debian.gz | generated:changelog | 644 | |

Debian dependencies (the control files are in `debpkgs/`): boxd-server needs podman (5.0 or newer), openssh-server,
rsync, git, uidmap, catatonit, procps and systemd; it recommends btrfs-progs, microsandbox-bin and passt and suggests
zram-tools. boxd-client needs nodejs, rsync, openssh-client and git. `boxd` only suggests the other two.
