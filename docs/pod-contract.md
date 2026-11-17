# Box per agent: the contract between the agents' machine (`box`) and the host (`boxd-pod`)

Both sides must pass `contract/cases.json` with their real code (the server verbs `pod report`, `pod calls`, `pod log`, the call log columns and the keys that may only read, release 0.3.0, included): `tests/contract-client.test.mts` (the agents' machine
side) and `tests/contract-pod-test.sh` (host side, fake `podman` and fake `msb` first on PATH). Change this
file and the cases together, never one side alone.

## Names and settings

In this file `/work` stands for the work area, the setting `BOXD_WORK` (default `/var/lib/boxd/work`); `build` stands
for the build account, `BOXD_USER` (default `boxd`). Every other setting named here is read from
`/etc/boxd/boxd.conf` (sh syntax; the programs also take `BOXD_CONF` to point elsewhere, which the tests use).
Settings in this file: `BOXD_LIMITS`, `BOXD_TTL`, `BOXD_IMAGE`, `BOXD_REGISTRIES`, `BOXD_VM_LIMITS`, `BOXD_VM_MAX`, `BOXD_VM_COMMIT`, `BOXD_VM_IDLE_MIN`, `BOXD_BOX_RESERVE`,
`BOXD_VM_ENGINE_DISK`, `BOXD_VM_TMP_DISK`, `BOXD_VM_NET_ALLOW`, `BOXD_PORT`, `BOXD_MEM_MAX`, `BOXD_SWAP_MAX`. The two paths `BOXD_IMAGES_DIR` (default
`/var/lib/boxd/images`) and `BOXD_POD_CLEAN` (default `/run/boxd-pod.clean`) are not meant to be changed; tests do.

## Transport

The client runs `ssh boxd-<host> <command line>` (the ssh alias `box setup <host>` writes). On the host, sshd runs `boxd-pod` (bash) as
`ForceCommand` for the account `build`; it reads the client's command line from `SSH_ORIGINAL_COMMAND` and
splits it on spaces only. Every word is a fixed keyword or matches a strict pattern without spaces; the
agent's command travels as ONE word: standard base64 (no line breaks) of its words joined by NUL bytes.
Nothing from the client is ever evaluated by a shell on the host.

`boxd-<host>` is port `BOXD_PORT` (default 2222): a second sshd (runit service `boxd-sshd`, `AllowUsers build`, `ForceCommand
/usr/bin/boxd-pod`) that root starts inside the cgroup `/sys/fs/cgroup/boxd/sshd`, so every build
session and every box is under the total cap. The main sshd (port 22) refuses `build` (`DenyUsers build`).

## Commands (`SSH_ORIGINAL_COMMAND`)

| Command | Meaning |
|---|---|
| `rsync --server ...` | Runs as is on the host (the client's sync), with its working folder set to the work area: the client's paths are relative to it (`jobs/<box>/src/`), so it never needs to know where the work area is. Only the client's own sync and pull pass: the words must be `--server`, `--sender`, `--delete`, `--mkpath`, `--safe-links`, `.`, a short option bundle (`^-[A-Za-z0-9.]+$`) or a path `jobs/<box>/src[/...]` with a valid box name and no `..` component; anything else (a destination outside a box, `--log-file=`, `--temp-dir=`) exits 125 with `boxd-pod: rsync refused: <word>` before rsync or any folder is touched. The filter rules travel inside rsync's protocol, not on this line. The client's real lines are `rsync --server -logDtpre.iLsfxCIvu --delete --safe-links --mkpath . jobs/<box>/src/` and, for a pull, `rsync --server --sender -logDtpre.iLsfxCIvu . jobs/<box>/src/<path>`; a test captures them from the real client and runs them through `boxd-pod`. The sync folder is made by the dispatcher itself before rsync starts (race free for two first calls). |
| `pod run <box> [--image <ref> \| --image-file <path>] [--vm\|--container] [--size <size>] [--user] [--kvm] [--env <NAME>]... [--recreate] [--snapshot] [--detach <run>] -- <b64>` | Ensure box `<box>` exists on the asked engine, then run `<command>` in it (see below). `--image-file` builds the box's image from a Containerfile of the synced worktree first (see "Building an image"). |
| `pod stop <box>` | Remove the box on every engine that has it; its files stay. Exit 0 also when neither had it. |
| `pod drop <box>` | Since 0.4.0. Remove the box and its folder `jobs/<box>` (see "Retention"), also when a run is still going in it; one line `evicted <box> (worktree gone), <n> MB freed` (`<n>`: whole megabytes of the folder, measured before the removal; the line has no size when the measurement failed). A machine box with a recorded need says it before the freed words: `evicted <box> (worktree gone), needed <peak> MB of <size> MB (<size name>), <n> MB freed` (see "Memory need"); an older client reads only the ending `, <n> MB freed` and ignores the rest. Exit 0 also when there was nothing; 125 when the box is being made right now. Sent by the client's collector for a worktree that is gone. Not for a key that may only read. |
| `pod forward <box> <port>` | Since 0.4.0. Relay this session's standard input and output to `127.0.0.1:<port>` inside a running container box, until either side ends (see "Forwarding a port"). Never creates or starts a box: a box that is missing or stopped, and a `vm` box (`forward is for container boxes`), answer 125 with one line. The port is checked here (1 to 65535, no leading zero). A key that may only read is refused. |
| `pod ps <box>` | Read only: the processes running in the box, one line each, tab separated, oldest first: `<pid> <elapsed seconds> <processor seconds> <working folder> <command>`. The folder is `?` when unreadable; newlines and tabs in a command become spaces. Left out: process 1, the box's keep-alive (`sleep infinity`, `catatonit`) and the report itself. Runs `PS_SCRIPT` (plain `sh` and `/proc`, so any image works) with `podman exec` or `msb exec`; takes no lock, writes no `.last-used`, starts nothing. A stopped box: `boxd-pod: box <box> is not running` on stderr (a virtual machine box: `boxd-pod: virtual machine box <box> is stopped; the next command in it starts it again, when the host has room`, since 0.4.8), exit 0, no lines. No box on either engine: exit 125, `boxd-pod: no box <box>`. The client (`box ps`) prints the lines as a table. |
| `pod image has <engine> <ref> <id>` | Read only: exit 0 when the engine's own store (`container` or `vm`) holds `<ref>` with image id `<id>` (lowercase hex, 12 to 64 characters), exit 1 when it does not; prints nothing either way. See "Pushing an image". |
| `pod image load <engine> <ref> <id>` | Reads an image archive from standard input into the engine's own store, then checks `<ref>` is there. See "Pushing an image". |
| `pod list` | One line per box, tab separated: `<box> <image> <running\|stopped> <last-used epoch seconds> <engine>`, engine `container` or `vm`. The fifth column is appended, so readers of the first four keep working. The listing is complete or it is an error: when an engine's own listing fails (`podman ps`, `msb ls`) the answer is exit 125 with one `boxd-pod: podman ps failed` or `boxd-pod: msb ls failed` line and nothing on stdout, never the other engine's boxes alone (`pod status` and `pod report` follow the same rule). |
| `pod status` | Read only: one line on stdout, tab separated `key=value` words, exit 0. Fields in this order: `version` (the release version of the package, equal to `version=` of `srcpkgs/boxd/template`; it is `0.4.10` in 0.4.10), `engines` (`container`, or `container,vm` when `msb` exists), `cpus` (`nproc`), `load1` (first word of `/proc/loadavg`), `vm_used` (running sandboxes named `pod-*`; 0 without `msb`), `vm_max` (`BOXD_VM_MAX`; `none` when no ceiling is set and memory can be measured, 3 when it cannot), `vm_room` (`yes` or `no`: the server's own answer to "room for one more virtual machine of the default size", computed by the one function `vm_room`, which today is `vm_used < vm_max`; `no` without `msb`), `boxes` (rows of both engines), `disk_pct` (`df` of the work area), `mem_free_mb` (the build cgroup `$BOXD_CGROOT/boxd`: `memory.max` minus the memory that cannot be given back, `anon` plus `shmem` of `memory.stat`, in megabytes: the same figure the admission of a virtual machine uses (`vm_mem`), so file cache, active or not, counts as free (an idle host right after a big file copy reported 133 MB free when the old rule counted active cache as used); `MemTotal` stands for a cap of `max`; `unknown` when the files cannot be read), `images` (names of the `*.tar` archives in `BOXD_IMAGES_DIR`, comma separated, sorted; per-box builds in `cache/images` are not listed), then, since 0.4.10 and after `images` so that a reader by position keeps working, `mem_avail_mb` (`MemAvailable` of `/proc/meminfo`, megabytes; a dash when unreadable), `group_mem_used_mb` and `group_mem_max_mb` (the build cgroup, exactly as in the `host` line of `pod report`: the same code computes both). Last, since 0.4.11, `vm_why`: empty when `vm_room=yes`, otherwise the sentence `pod run` would refuse a machine of the default size with (for example `16468 MB of running machines + 3100 MB used by container boxes + 8192 MB asked > 24576 MB, 100% of the 24576 MB cap`, or `4 of 4 running`); it is for people and logs, a client shows it and never parses it, and it is empty on a host without the virtual machine engine. Very last, since 0.4.12, `vm_fit_mb`: the largest machine, in megabytes, that `pod run` would admit now, so a client can judge a size other than the default: the smaller of (the cap minus the measured use) and (`BOXD_VM_COMMIT` percent of the cap minus the sizes of the running machines minus the memory the container boxes use), never below 0; `0` when the count ceiling `BOXD_VM_MAX` is reached; a dash when the memory cannot be measured or counted (only the count rule exists then, the client falls back to `vm_room`) and on a host without the virtual machine engine. The same code computes `vm_room`, `vm_why`, `vm_fit_mb` and the refusal of `pod run`, so a machine of a size up to `vm_fit_mb` is admitted (unless the host changed meanwhile). Then, since the admission of container boxes (owner decision 2026-11-17), the last three words, in this order: `box_room` (`yes` or `no`: whether `pod run` would admit a call that starts work in a container box that is not busy yet, with the rule of "Container boxes are admitted by a reserve" under `pod run`; `yes` when the rule is off or the memory cannot be measured or counted), `box_fit_mb` (the megabytes one more busy box may claim: `BOXD_VM_COMMIT` percent of the cap minus the sizes of the running machines minus what the container boxes count for, never below 0; a dash when the rule is off or the memory cannot be measured or counted) and `box_reserve_mb` (`BOXD_BOX_RESERVE`). `box_room=no` exactly when `box_fit_mb` is below `box_reserve_mb`. The idle machines are not left out of these sums (an idle machine still holds the memory it uses, and `pod run` removes none for a container call), so the word says what the call would get. `pod report` does not carry them. `mem_free_mb` is boxd's own accounting of the build group (the cap minus what boxes use, never below 0) and says nothing about what the host as a whole has available; read `mem_avail_mb` for that. It takes no lock, makes no engine call that changes anything and writes no call log line: the numbers are advice, and the room lock of `pod run` stays the authority. A client decides room by `vm_room` and never by comparing `vm_used` with `vm_max`: the rule behind `vm_room` may change (for example to measured memory) without the client changing. `vm_used` and `vm_max` are information. A server older than this command answers `unknown command` (exit 125); a client then treats the host as awake with unknown room. Extra words: exit 125, `boxd-pod: unknown command`. |
| `pod report` | Read only, for the dashboard (see "The reading verbs"): the facts of the host, its boxes, their detached runs and the local image archives, in one answer. |
| `pod calls [<offset>]` | Read only: the call log from a byte offset, whole lines, in windows of at most 1 048 576 bytes (see "The reading verbs"). |
| `pod log <box> <run> [<offset>]` | Read only: a detached run's log from a byte offset, the same windows; the box is not started (see "The reading verbs"). |
| `pod help` | Since 0.4.10. Read only, one line per command the server accepts over ssh with a few words each, exit 0; no lock, no stamp, no call log line; allowed for keys that may only read. Extra words: exit 125, `boxd-pod: unknown command`. |
| anything else | Exit 125, `boxd-pod: unknown command` on stderr (the text stays as it is: the client and the dashboard match it to detect a server older than the command; `pod help` lists the commands). `pod report`, `pod calls` and `pod log` with more words than shown are unknown commands too. |

- `<box>` matches `^[a-z0-9][a-z0-9_.-]{0,62}$`, else exit 125. The client derives it from the worktree:
  `<lowercased basename, characters outside [a-z0-9_.-] replaced by ->-<cksum of the absolute worktree path>`,
  leading characters outside [a-z0-9] dropped (nothing left: `worktree`), basename cut to 40 characters;
  `--pod <name>` overrides it (same validation). The name does not depend on the engine.
- Options of `pod run` may come in any order on the host side; the client sends them in the order
  `--image` or `--image-file` (not both: 125), `--vm`, `--container`, `--size`, `--user`, `--kvm`, `--env`, `--recreate`, `--snapshot`, `--detach`. `--vm`, `--container`, `--user` and `--kvm` take no value; `--size` takes `small`, `medium`, `large` or `xlarge`.
- `<ref>`: an image reference from `docker.io`, `ghcr.io` or another registry listed in `BOXD_REGISTRIES` (short names like `rust:1.83`
  mean `docker.io/library/rust:1.83`); anything else exit 125. Default: `docker.io/library/debian:stable-slim`.
  Also allowed: a local image `localhost/<name>[:<tag>]` (name `[a-z0-9][a-z0-9_.-]*`, no further slash; no tag
  means `:latest`, and the reference is used with the tag spelled out). Local images are built on the host by
  `server/images-build` (run by `boxd-setup --images`), which also saves each as the archive `/var/lib/boxd/images/<name>.tar`. The same
  rules hold on both engines.
- `<b64>`: the command, base64 of its words joined by NUL. Decoded, it runs as an argument list (no shell)
  inside the box; agents who want a shell pass `sh -c '...'` themselves. Exactly one word after `--`, else 125.
- `<run>`: matches `^[A-Za-z0-9_.-]{1,64}$`.

## Engines

A box runs on one of two engines:

- **`container`** (default): a rootless podman container. Shares the host kernel; no docker or podman inside.
- **`vm`**: a microsandbox virtual machine (libkrun on KVM, the Kernel-based Virtual Machine, version 0.7.15).
  It has its own kernel (6.12, no loadable modules), root inside, and can run docker or podman inside. Measured
  on the host: start about 355 ms, one `msb exec` 40 to 47 ms, about 85 MB of host memory for an idle box.

**Sticky boxes.** `--vm` asks for `vm`, `--container` asks for `container` (both together: 125). A call that names
neither keeps the existing box's engine, and a call without `--image` keeps its image; only a NEW box gets the
defaults (`container`, `BOXD_IMAGE`). Naming an engine or image that differs from the box's is refused
with 125 unless `--recreate`; `--recreate` alone gives a fresh box with the same engine and image. (Agents
forgot to repeat `--image` on every call, and each call was refused: the box is what it was made as.) Both engines name the box object `pod-<box>` (podman
container or microsandbox sandbox), so a box name means one box whatever the engine. The job folder
`/work/jobs/<box>`, its `.lock`, `.last-used` and `.running`, `--snapshot`, the detach wrapper, boxd-keepawake and
the reaper are shared.

**`--user`.** The box runs every command as an unprivileged user whose id owns the synced
files: the build account's own id. A new box is made with `--userns=keep-id` (inside, the build account's uid and
gid equal its host ones, so files under `/job` stay its own), `--label boxd.user=1` and `-e HOME=/job/home`
(the folder `/work/jobs/<box>/home` is created first; the sync never touches it), and every `podman exec` of
that box, foreground and detached, gets `--user <uid>:<gid> -e HOME=/job/home` (ids from `id -u` and `id -g` of the
account that runs `boxd-pod`) before `-w`. The label is read back from `podman container inspect`
(`{{.Config.Labels}}`). Sticky like engine and image: a later call without `--user` keeps it, and so does
`--recreate` without it. `--user` on an existing box made without it is refused (exit 125,
`boxd-pod: box <box> was made without --user, asked for --user; add --recreate`); `--user --recreate` replaces
it. Limit: there is no way to go back to a root box except `pod stop` and a new call.

**`--user` in a machine.** The account has the number 1000 (user and group). Made with `--user`, a machine has the empty file
`/work/jobs/<box>/.vm-user` next to `.vm-size` (a machine has no label); a creation without `--user` removes it. Every rule above holds
the same: sticky (also through `--recreate`, and when the machine is made again from its folder after the reaper removed it), and the
refusal `boxd-pod: box <box> was made without --user, asked for --user; add --recreate` reads the file for a machine. The files get their
owner from the mounts: such a machine is created with `--mount-dir /work/jobs/<box>:/job:host-perms=mirror,uid=1000,gid=1000` and
`--mount-dir /work/cache/pod:/cache:host-perms=mirror,uid=1000,gid=1000` (a machine without `--user` keeps the lines without the two
ids). The guest then shows every file under `/job` and `/cache`, also one a later sync wrote, as 1000:1000, while on the host the owner stays
the build account; no file is changed at any call. Before the command, after the sync and after `--snapshot`, each call that runs in such a
machine runs one `msb exec -w / pod-<box> -- sh -c <script> _ 1000` as root in the guest (the script text starts with `: boxd-user-setup`).
It finds the account with that number in `/etc/passwd`, whatever its name, or else makes `box` (group 1000 made unless it exists, home
`/job/home`, `useradd -M -u 1000 -g 1000`), makes `/job/home`, adds the account to the group `docker` when the image has it and it is not
a member, opens `dmesg` for every account (so the kill lines of a detached run still come), and prints the account's name. The command
then runs as `msb exec [-t|--stream] -u <name> -e HOME=/job/home ...` (foreground, with and without a terminal, and detached; `HOME` is
the same as in a container box whatever home the account has); the server's own helper commands (the start script, `pod ps`, the cleanup
of a lost call) stay root. An image without `useradd` or `groupadd` where the account must be made, or one that fails, is refused after the
machine exists: exit 125, `boxd-pod: --user needs useradd in the machine's image`, one line, the command is not run. Older servers refuse
`--user` with the `vm` engine (exit 125, `boxd-pod: --user is not supported for virtual machine boxes yet`) and an older client sends the
flag as it always did, so against this server it gets the account. `--kvm` stays for container boxes only.

**`--kvm` (container boxes only).** A new box is made with `--device /dev/kvm --label boxd.kvm=1`, so QEMU inside
runs on the processor's hardware virtualization: the box's code gets the same virtualization the build account has. Its
memory counts against the box's limits and the build group's cap like any other process. Sticky like `--user`: a later
call without it keeps it, and so does `--recreate`; `--kvm` on an existing box made without it is refused (exit 125,
`boxd-pod: box <box> was made without --kvm, asked for --kvm; add --recreate`), `--kvm --recreate` replaces it. `--kvm`
with the `vm` engine is refused (exit 125, `boxd-pod: --kvm is only for container boxes`). A box to be made with
`--kvm` when the build account may not read and write `/dev/kvm` is refused before anything is removed or made (exit 125,
`boxd-pod: --kvm: /dev/kvm is missing or the build account may not open it`). Where `getfacl` exists, a
device without the build account's own access rule is refused the same way (`boxd-pod: --kvm: /dev/kvm has no access rule
for <account>; run boxd-setup on this host`): the `kvm` group alone passes on the host but not inside a box. The device opens inside through an access
rule for the build account's user id (`setfacl -m u:<account>:rw /dev/kvm`, put back at every boot by the udev rule
`/etc/udev/rules.d/70-boxd-kvm.rules`; both written by `boxd-setup`): rootless `runc` drops the account's `kvm` group
inside the box, but container root, and the `--user` uid, are that user id on the host. The device stays 0660
`root:kvm`. Without `--kvm` a box has no `/dev/kvm`.

**`--size small|medium|large|xlarge` (virtual machine boxes only).** The machine's processors and guest memory:
`small` = `-c 2 -m 2G`, `medium` = `-c 4 -m 4G`, `large` = `BOXD_VM_LIMITS` (default `-c 4 -m 8G`, the machine every
box had before sizes existed), `xlarge` = `-c 8 -m 12G` (fixed, whatever `BOXD_VM_LIMITS` says; admitted as 12288 MB by every rule that counts sizes, so a host whose cap cannot hold 12288 MB refuses it with the usual no-room line). No `--size` on a new box means `large`. Sticky like engine and image: the size is
written at creation to `/work/jobs/<box>/.vm-size` (the word, no newline; a virtual machine box without that file, made
by an older server, is `large`), and a later call without `--size` keeps it, also with `--recreate`. A call that names a
different size than the box has is refused without `--recreate` (exit 125,
`boxd-pod: box <box> is <have>, asked for <want>; add --recreate`); with `--recreate` the box is replaced at the new
size and the file rewritten. A refusal changes nothing, the file included. A machine made with no `--size` for a box whose folder holds a recorded need takes its size from it ("Memory need"). `--size` for the container engine, asked
(`--container`) or existing, is refused (exit 125, `boxd-pod: --size is only for virtual machine boxes`); any other
word than the four is refused (exit 125, `boxd-pod: bad size <word>`), a missing value too
(`boxd-pod: --size needs a value`). The client refuses an unknown word with exit 2 before any call.

**Running, for a virtual machine,** means `msb ls` lists the sandbox as running AND its host process exists.
`msb ls` alone can list a box whose machine died, and the next `msb exec` restarts such a box silently.
`pod list`, the room check (step 5b) and the reaper use this definition. How 0.7.15 names the host process is
confirmed by the builder (the experiment notes give `msb machine --name <sandbox>`, UNVERIFIED); the check
goes through a command found on `PATH`, so tests fake it.

**docker starts by itself in a virtual machine.** Every `pod run` on a `vm` box runs, after the box is up and
before the command (step 5d), the fixed script below as `msb exec -w / pod-<box> -- sh -c '<script>'`. When the
image has `dockerd` (the toolbox, `docker:dind`), a box always has a daemon, also after a restart or a silent
restart after a crash. Its exit code and output are ignored: an image without `sh` or without `dockerd` runs
the command as if the step were absent. It costs one exec (about 45 ms) per call.

```sh
command -v dockerd >/dev/null 2>&1 || exit 0
p=$(cat /var/run/docker.pid 2>/dev/null) && kill -0 "$p" 2>/dev/null && exit 0
rm -f /var/run/docker.pid /var/run/docker.sock
setsid dockerd >>/job/runs/dockerd.log 2>&1 </dev/null &
p=$!
while kill -0 "$p" 2>/dev/null && [ ! -S /var/run/docker.sock ]; do sleep 0.1; done
```

The wait ends on an event (the socket appears or dockerd exits), so a broken daemon never hangs the call;
its log stays readable with `box --vm -- cat /job/runs/dockerd.log`. podman inside needs no daemon.

**The guest's process limit is raised (since 0.4.16).** The guest kernel microsandbox boots (6.12.117) is built small and logs
`pid_max: default: 4096 minimum: 301`: a machine has 4096 process numbers for all processes and threads together, and a failed
fork looks like a container lost with memory to spare (measured 2026-11-16: 4300 background processes died with `Cannot fork`).
When a call creates the machine or starts a stopped one (the limit does not survive a stop), the same exec first runs
`{ echo 32768 > /proc/sys/kernel/pid_max; } 2>/dev/null`; a call into a running machine, and a container box, do not. 32768 is
the ceiling of this kernel (4194304 is refused; 6000 processes ran after the raise); a guest that refuses the write or lacks
the file keeps its limit, silently. The real fix is a guest kernel not built small, which is microsandbox's.

## `pod run` in order

1. **Validate** everything (exit 125 on any error, nothing created, no engine called). With `--vm`, `msb`
   missing from `PATH` gives exit 125, `boxd-pod: virtual machines are not installed on this host`.
2. Take the lock `/work/jobs/<box>/.lock` (flock) for steps 3 to 5, so two first calls create one box.
3. Create `/work/jobs/<box>/{src,runs}` if missing.
4. **Look the box up on both engines:** `podman container inspect pod-<box>`, and `msb inspect pod-<box>`
   (skipped when `msb` is not installed).
   - Found on the other engine, without `--recreate`: exit 125 with
     `boxd-pod: box <box> is a container, asked for a virtual machine; add --recreate` or
     `boxd-pod: box <box> is a virtual machine, asked for a container; add --recreate`.
     Found on both engines (only after a crash) counts as found on the other engine.
   - Found on the asked engine with another image, without `--recreate`: exit 125 with
     `boxd-pod: box <box> runs <old>, asked for <new>; add --recreate`.
   - With `--recreate` the box is always removed (files stay), on every engine that has it, also when engine
     and image are the same: the agent asked for a fresh box. The removal (`podman rm -f pod-<box>`,
     `msb rm -f pod-<box>`) happens only after the checks of step 5 have passed, so a refused call keeps the
     old box.
5. **Checks, then create or start.** A refusal in 5a or 5b changes nothing.

   a. **Image**, when the box is missing (or is to be removed in 4) and the image is `localhost/<name>[:<tag>]`
      and is not in the asked engine's own store, it is loaded from `/var/lib/boxd/images/<name>.tar` (the build
      account's stores are emptied by `boxd-reset all`):
      - container: `podman image exists <ref>` fails, then `podman load -i <archive>`, then `podman image exists <ref>`;
      - vm: `msb image inspect <ref>` fails, then `msb load < <archive>` (standard input from the file, no tag
        option, so the archive's own tags count), then `msb image inspect <ref>`.

      Archive missing or unreadable: exit 125,
      `boxd-pod: image <ref> is not in storage and <archive> is missing; run boxd-setup --images`.
      Loaded but the image is still absent (the archive lacks that tag): exit 125,
      `boxd-pod: loading <archive> did not give <ref>`. The two stores are separate: loading for one engine
      never touches the other. Registry images are pulled by `podman run` (only when the store lacks them) or `msb create` themselves; an image that
      `pod image load` put into a store is therefore used, not pulled again.

   b. **vm only: room**, when the box is to be created or started. Take the global lock
      `$WORK/cache/vm-room.lock` (flock, after the box lock, so the order never inverts) and hold it until 5c
      ends. The machine's memory is the `-m` value of its size (`--size`, else the box's recorded size, else `large`; a
      stopped box that is only started counts its recorded size). Two rules, both must pass:
      - **Measured memory** (the default): the build group's `anon` plus `shmem` (bytes, from `memory.stat` of the cgroup
        `/sys/fs/cgroup/boxd`) plus its `memory.swap.current` (swapped-out memory is still in use; absent file: 0; since
        0.4.8) plus the asked memory must not exceed the group's cap, `memory.max`, or the host's
        `MemTotal` from `/proc/meminfo` when `memory.max` reads `max`. All in megabytes (1 MB = 1048576 bytes, rounded
        down); equal to the cap passes. `anon` and `shmem` are what machines really use (guest memory is anonymous memory
        of the `msb` process); file cache is reclaimable and does not count. Refused with exit **75**,
        `boxd-pod: no room for another virtual machine (<used> MB in use + <asked> MB asked > <cap> MB cap); wait for one to end or stop one`.
      - **Commitment** (with the measured rule, since 0.4.7): a young machine has not claimed its memory yet, so the
        measure alone admits too many. The sizes of the running sandboxes named `pod-*` (each from its box's `.vm-size`,
        `large` without a record; the asked box itself not included) plus the asked memory must not exceed
        `BOXD_VM_COMMIT` percent (default 100 since 0.4.8, was 150; rounded down) of the same cap; equal passes. Refused with exit **75**,
        `boxd-pod: no room for another virtual machine (<sizes> MB of running machines + <asked> MB asked > <limit> MB, <percent>% of the <cap> MB cap); wait for one to end or stop one`.
        A listing that fails refuses as in the count ceiling. `BOXD_VM_COMMIT` that is not a number: exit **125**,
        `boxd-pod: BOXD_VM_COMMIT must be a number`.
      - **Container boxes in the commitment** (since 0.4.9): machines hold reservations, container boxes are best effort.
        The memory the running container boxes use now (per box, the `anon` plus `shmem` plus `memory.swap.current` of the cgroup of
        its init process, as the report's `mem_mb` finds the cgroup; no file cache) is added to the sizes of the machines:
        sizes + container memory + asked must not exceed the same `BOXD_VM_COMMIT` percent of the cap. A container box that cannot be
        read counts as its `--memory` limit in `BOXD_LIMITS`; with no such limit, or when the listing or an inspection fails,
        the call is refused with `... (the running container boxes cannot be measured now); ...`. The message then names three numbers
        (the container term is left out when it is 0, so a host without container memory reads as before 0.4.9):
        `boxd-pod: no room for another virtual machine (<sizes> MB of running machines + <container> MB used by container boxes + <asked> MB asked > <limit> MB, <percent>% of the <cap> MB cap); wait for one to end or stop one`.
        Container boxes themselves were never refused for load or memory until the reserve below (judged and rejected in 0.4.8, decided
        the other way by the owner on 2026-11-17).
      - **Container boxes are admitted by a reserve** (owner decision 2026-11-17; setting `BOXD_BOX_RESERVE`, megabytes, default 4096; `0`
        turns the rule off and gives exactly the behaviour before it; not a number: exit **125**, `boxd-pod: BOXD_BOX_RESERVE must be a number`).
        Before, the only limit on container boxes was the cap of the whole build group, and past it the kernel ended a process of some
        box, possibly another user's long run. A machine is admitted by the sizes of the machines because a young machine has not claimed
        its memory yet; a container box that has just started work has not either, so the same protection is given by one number. A call
        that starts work in a container box (a `pod run`, foreground or detached, which makes, starts or reuses the box) is admitted only
        when the **counted** memory plus the **asking box's share** is at most `BOXD_VM_COMMIT` percent of the cap. Counted: the sizes
        of the running machines (as above, `vm_commit`), plus, for every running container box other than the asking one, what it uses
        now (as above, `ctr_commit`) and, for one that is **busy** and whose call or run began **no more than `BOXD_VM_IDLE_MIN` seconds
        ago**, at least the reserve (the larger of the two). Busy is what `busy=` of `pod report` says (a call or run holds the box's
        `.running` lock); the time is the box's `.last-used` stamp, touched when a call begins, against the server's clock. The asking
        box's share is the larger of the reserve and what the box itself uses when it runs and is kept (a box that is made, started or
        recreated by the call uses nothing yet). Refused with exit **75**, one line, nothing made or started and no stamp:
        `boxd-pod: no room for another busy box (<counted> MB counted + <share> MB reserve > <limit> MB, <percent>% of the <cap> MB cap); wait for one to end`.
        A call into a box that is **already busy** adds nothing and is never refused by this rule; `pod ps`, `pod log`, `pod drop`,
        `pod stop`, `pod list`, `pod status`, `pod report`, `pod forward` and the rsync passthrough are never refused by it. A host whose
        memory cannot be measured or counted (no readable build group, a container box that cannot be read and has no `--memory` limit, a
        failing listing) admits as before. The machine rules count a young busy container box the same way (the one function
        `ctr_commit` is under both), so a machine is not admitted into memory that a container box started a second ago is about to
        claim. One admission at a time: the room lock of the machines is held from the check until the call holds its box busy (the
        shared lock on `.running`, taken before the lock is given back, also for a detached run, whose wrapper inherits it), so ten calls
        at once are counted one after the other. Limits: idle machines are not removed for a container call (the machine rule does that
        for a machine); the server's clock is used, with no fixed clock in the settings.
      - **Count ceiling**: only when `BOXD_VM_MAX` is set and not empty (unset or empty: no count limit). Count the
        running sandboxes named `pod-*`, the asked box itself not included; if that count is `BOXD_VM_MAX` or more: exit **75**,
        `boxd-pod: no room for another virtual machine (<n> of <max> running); wait for one to end or stop one`.
        When the running machines cannot be counted at that moment (the listing fails), the call is refused the same way with
        `(the running machines cannot be counted now)`: a failed listing never reads as "no machine runs".
      - **Fallback**: when `memory.stat` or `memory.max` of the group cannot be read (or lack `anon`), the measured rule
        cannot run and the count rule applies with `BOXD_VM_MAX` defaulting to 3, as before sizes existed.

      The rule is one server function (`vm_refusal`; `vm_room` asks it for one more `large` machine, and that is what
      `pod status` reports). Every refusal text starts with `no room for another virtual machine`, and the exit code is
      the signal: 75 means nothing ran and nothing changed, another host may take the call. A command can exit 75
      itself, so a client also checks that stderr starts with that text.
      Known limit: this is overcommit. A `--recreate` of a running box counts the old machine's memory too (it is removed
      only after the check). Machines admitted while light can later grow to their size together; the group's cap then
      ends a process of the group (usually a whole machine; the host stays safe), see "Memory budget".

   c. **Create or start.** Then remove what step 4 marked for removal, and:
      - container, missing:
        `podman run -d --init --name pod-<box> --hostname <box> --label boxd.box=<box> [--userns=keep-id --label boxd.user=1 -e HOME=/job/home, with --user] [--device /dev/kvm --label boxd.kvm=1, with --kvm] -v /work/jobs/<box>:/job -v /work/cache/pod:/cache -w /job/src --pull=missing <env> --oom-score-adj 1000 <limits> <ref> sleep infinity`,
        `--pull=missing` states what podman does by default (pull only an image the store lacks) so a host setting cannot change it: an image put into the store by `box image push` is used as it is;
        limits `BOXD_LIMITS`, default `--memory 12g --memory-swap 16g --pids-limit 4096 --cpu-shares 1024`
        (this podman has no `--cpu-weight`; 1024 shares is weight 100, equal for every box).
        Stopped: `podman start pod-<box>`.
      - vm, missing:
        `msb create --name pod-<box> --mount-dir /work/jobs/<box>:/job:host-perms=mirror --mount-dir /work/cache/pod:/cache:host-perms=mirror <env> <vm limits> <ref>`,
        `<env>` as `-e KEY=VALUE` each, `<vm limits>` the limits of the box's size (see `--size`; `large` is `BOXD_VM_LIMITS`, default `-c 4 -m 8G`). No command:
        the box stays up between calls, like `sleep infinity` does in a container. `host-perms=mirror` keeps
        mode bits, and files the guest's root writes belong to `build` on the host.
        In any state other than running: `msb start pod-<box>`.
      - env, both engines: `CARGO_HOME=/cache/cargo GOMODCACHE=/cache/go/mod GOCACHE=/cache/go/build npm_config_cache=/cache/npm npm_config_store_dir=/cache/pnpm-store XDG_CACHE_HOME=/cache/xdg MAVEN_ARGS=-Dmaven.repo.local=/cache/m2 GRADLE_USER_HOME=/cache/gradle`
        (the last two since 0.4.5). With `BOXD_MAVEN_MIRROR=<address>` in the settings (0.4.6) `MAVEN_ARGS` also carries
        `-s /cache/maven-settings.xml`, a file `pod run` writes into the shared cache whenever it is missing or differs: one mirror
        (`mirrorOf` central) at that address. An address that is not a plain `http(s)://` one: 125 `bad BOXD_MAVEN_MIRROR`. `/cache` is one folder for all boxes of the host: a package is downloaded once per host. Under disk
        pressure its files not written for `BOXD_KEEP_DAYS` are removed (see "Retention").

   d. **vm only:** the docker start script of "Engines". It also runs `git config --system --replace-all safe.directory /job/src` (when `git` exists in the image): the guest's root is not the owner of the synced files (the mirror of the build account's ids), and git refuses a repository owned by another account ("dubious ownership"), so `git status` in `/job/src` would fail after `--git` or `--snapshot`. It trusts that one folder, inside the machine only; the host's configuration is untouched. In a container box the files belong to the account that runs commands (container root maps to the build account; `--user` uses `--userns=keep-id`), so nothing is needed there.
6. Touch `/work/jobs/<box>/.last-used`. When this call made the box (a first call, `--recreate`, or a replacement because the image build changed), one line goes to standard error, after the box exists, after the refusals of the call and the snapshot, and before the command, saying which account commands run as: `boxd-pod: new container box <box>: commands run as root; an ordinary account needs --user at creation`, `boxd-pod: new container box <box>: commands run as an ordinary account (--user)`, or `boxd-pod: new machine box <box>: commands run as an ordinary account (--user)` / `boxd-pod: new machine box <box>: commands run as root; an ordinary account needs --user at creation`. A later call into the same box prints none, and nothing goes to standard output. The server says it because only the server knows that the call made the box; a refusal (exit 125 or 75) comes before it, so a refusal still has exactly one `boxd-pod:` line. The line is plain text for people; a client never parses it.
7. `--snapshot`: on the host, in `/work/jobs/<box>/src`: `git init -q` if no `.git`, `git add -A`, commit as
   `boxd <boxd@localhost>` (a repository for tests that need one; the sync never carries `.git`). The repository is made on the host by the account that owns the files, so git never meets a foreign owner while it is made. `--git` (client only, see "Client") gives a repository at the worktree's own commit instead; the two cannot go together.
8. Foreground (no `--detach`), exit code the command's, `.last-used` touched again at the end:
   - container: `podman exec -i [-t when SSH_TTY is set] [--user <uid>:<gid> -e HOME=/job/home, with --user] [-e <NAME> per --env] [-e BOXD_CALL=<marker>, without a terminal] -w /job/src pod-<box> <command words>`;
   - vm: `msb exec [-t when SSH_TTY is set, else --stream] [-e <NAME> per --env] [-e BOXD_CALL=<marker>, without a terminal] -w /job/src pod-<box> -- <command words>`. The working folder is
     always given: an image whose own working folder does not exist fails otherwise.
   - **The session rule (without a terminal).** A foreground command lives as long as the session that started it. sshd does not
     hang a session without a terminal up when the client dies, so the command used to run on with the box's `.running` lock
     held and the reaper never took the box (a `podman exec` stayed on the host and the process inside it survived even the
     end of that exec). The dispatcher therefore runs the engine in the background with a fresh marker (`BOXD_CALL=c<pid>-<time>-<random>`,
     in the environment of every process of the call) and waits. A watcher notices that the dispatcher's parent (sshd's session
     process) is gone (the parent id changed; looked at every `BOXD_WATCH_INTERVAL` seconds, default 1, a test hook) and hangs the
     dispatcher up; a hangup, termination, interrupt or broken pipe received by the dispatcher counts the same. Then, in this order:
     (a) a second `podman exec [--user <uid>:<gid> -e HOME=/job/home, as the call had] pod-<box> sh -c <cleanup> _ <marker>` (vm:
     `msb exec -w / pod-<box> -- sh -c <cleanup> _ <marker>`, bounded by `timeout 30`) finds every process whose environment holds
     `BOXD_CALL=<marker>` (the `environ` file of each process under `/proc`, so it needs only `sh`, `tr` and `sleep`; the cleanup runs
     as the call's own account, other users' environments are unreadable), sends them TERM, waits up to 5 s and sends KILL to what
     remains (pid 1 and the cleanup itself are skipped); (b) the host-side engine process gets TERM; (c) `.last-used` is touched, one
     line `boxd-pod: the session that started the call is gone; the call was ended` goes to stderr, the call log line has exit code
     129 (reason `session gone`), and the dispatcher exits 129. Its `.running` lock is then free, the box is idle and the reaper takes
     it after `BOXD_TTL`. **Detached runs are not touched** (they outlive the session on purpose), and a call on a terminal keeps the
     old behaviour (sshd hangs the session up and the engine follows). Limits: a command that clears its own environment (`env -i`)
     leaves no marker to find, and the watched parent is the nearest process only (a wrapper shell between sshd and `boxd-pod` that stays
     alive would hide the end of the session; the ForceCommand runs the script directly). Work that must outlive its starter needs `--detach`.
9. `--detach <run>`: start on the host, detached from the ssh session (`setsid`), holding the boxd-keepawake lock
   for its whole life: `boxd-keepawake podman exec [--user <uid>:<gid> -e HOME=/job/home, with --user] -w /job/src pod-<box> <command words> > /work/jobs/<box>/runs/<run>.log 2>&1`
   (vm: `boxd-keepawake msb exec --stream -w /job/src pod-<box> -- sh -c <script> _ <command words>`, same log; the script is described under "The guest kernel's kill lines" below), then append `EXIT <code>` to
   that log. **The log of a run in a machine box grows while it runs**: every `msb exec` that runs the user's command without a terminal (the detached run and the foreground call without a terminal) gets `--stream` (bidirectional streams without a terminal, no echo and no line translation; it conflicts with `--tty`, so the call with a terminal keeps `-t` and has no `--stream`). Without it microsandbox 0.7.15 held all output until the command ended (`bytes=0` in `pod report` and an empty `pod log` for the whole run, and the output was lost with a machine that died). The option is in 0.7.15, the packaged engine and the minimum; the server does not check the engine's version, and an engine without the option would refuse the call. The server's own helper commands in the guest (process list, start-up script, cleanup) do not use it. Print `<run>` on stdout, exit 0 at once. The client reads the log with
   `box log <run>` (`pod log`, which does not start or recreate the box; a plain `box -- cat /job/runs/<run>.log` is a normal foreground
   run and makes a stopped box again).
   **Words about a kill** (stderr of a foreground call, the run log before `EXIT <code>` of a detached one; since 0.4.8 for machines,
   since 0.4.9 for containers). A machine gone after the command: `boxd: the virtual machine of box <box> ended under this run`, with
   `: the host's out-of-memory killer ended a process of the boxes meanwhile (kernel log: dmesg)` when the build cgroup's `oom_kill`
   count rose during the call. A container command that ended with 137 while that count rose:
   `boxd: the command in box <box> was killed (exit 137): the host's out-of-memory killer ended a process of the boxes meanwhile (kernel log: dmesg)`.
   The exit code stays 137.
   **The guest kernel's kill lines** (detached runs in a machine only, since 0.4.12; foreground calls have no log to hold them and a
   container box shares the host's kernel, whose kills the words above and `oom_kills` of `pod report` already cover). The command runs
   inside the guest under a small `sh -c` wrapper (`msb exec -w /job/src pod-<box> -- sh -c <script> _ <command words>`) that counts the
   lines of the guest's `dmesg` containing `Killed process` before the command, and when the command has ended prints, to the same
   log, only the matching lines past that count, each with its timestamp removed and the prefix `[boxd] guest kernel: ` (for example
   `[boxd] guest kernel: Out of memory: Killed process 1234 (python) total-vm:...`). They come before the words above and before `EXIT <code>`.
   A count, not the wall clock, marks "during this run". Nothing is printed when there are none; the exit code is the command's; a guest
   without `dmesg` (the plain Void image) has the kernel's own device read instead (`/dev/kmsg`, without blocking; since 0.4.13), and one where neither can be read prints nothing. A machine killed with the run prints nothing here (the
   words above say it ended). A last output line without a newline is joined by the first of these lines.

Exit codes: the command's own; 125 for `boxd-pod`'s errors and 75 for "no room" (step 5b), each with one `boxd-pod: ...` line on stderr.

**`boxd-pod` environment for every `msb` call:** `HOME` and `MSB_HOME=$WORK/cache/msb` exported (msb needs
both; the path must stay short because it holds sockets, and `@cache` keeps images over a plain reset), and
`umask 022` (microsandbox refuses a state folder created under umask 002, its issue 2003).

**Call log:** every `pod run` appends one tab separated line to `$BOXD_WORK/cache/calls.log` (for a usage monitor):
start (microseconds since 1970, digits only: the decimal separator of bash's `EPOCHREALTIME` follows the locale, a comma
in Italian, so every non-digit is removed before any arithmetic), box, engine (`container` or `vm`), lock wait in
milliseconds, exit code or `detached`, duration in milliseconds, refusal message (empty unless the exit code is 125 or 75), then,
since 0.3.0, two columns after it: the run id of a detached run (empty otherwise) and the command (the decoded words joined by
spaces; every control character, tabs and newlines included, becomes a space, so a line and its columns stay whole; cut to the
first 200 characters; empty for a refusal made before the command is decoded and for `pod image`). **Readers must split on
tabs, accept seven to nine columns and ignore any extra field**: the reason stays in column 7, so the usage monitor that reads
seven columns keeps working, and old lines keep their seven. A value handed over with `--env` is never on a command line, so
it is in no column (acceptance scenario 26 checks the host's files). A refusal that happens before the cache folder exists
logs nothing: the log never creates the folder, and a failed write is ignored.

## Limits mapping

| Concern | container | vm |
|---|---|---|
| Memory per box | `--memory 12g`; page cache can be taken back by the host | `-m 8G` of guest memory (`large`; `--size small` 2G, `medium` 4G, `xlarge` 12G). The guest kernel ends a process inside the box at that size; the box lives on. Guest memory is host memory charged to the box process once the guest touches it, page cache included, until the box stops (UNVERIFIED whether libkrun gives freed pages back). Hence 8G, not 12G. |
| Swap per box | `--memory-swap 16g` (4G of swap) | None inside the guest. The host may swap guest memory to zram within the build cgroup's swap cap (UNVERIFIED). |
| Processors | `--cpu-shares 1024`: a weight, no cap | `-c 4`: four virtual processors, a cap. Each is a host thread that competes like any build thread. |
| Processes | `--pids-limit 4096` | No host limit needed (about 22 host threads per box), none inside the guest. |
| Total | build cgroup: `memory.max` `BOXD_MEM_MAX`, `memory.swap.max` `BOXD_SWAP_MAX` | The same cgroup: `msb` creates none, so the box process stays where `pod run` started it, `/sys/fs/cgroup/boxd/sshd`, under the cap (seen on a development machine for a plain shell; UNVERIFIED under the delegated build cgroup). |
| Over the total | the kernel ends a process, usually inside one box | The kernel ends a whole virtual machine (box gone, `/job` and `/cache` files kept). Admission (step 5b) keeps the measured memory plus a new machine's size within the cgroup cap. A container that grows can still push the total over and cost a virtual machine. Upgrade path: a child cgroup per virtual machine with `memory.min`. |
| Disk | podman storage under `/work/cache` | Three sparse ext4 disks owned by the box, under `MSB_HOME`, gone with the box: `/var/lib/docker` and `/var/lib/containers` (`BOXD_VM_ENGINE_DISK`, 32G each; the engines cannot stack overlay on the guest's overlay root) and `/tmp` (`BOXD_VM_TMP_DISK`, 64G, mode 1777, so tools that need tens of GiB free find it without settings). The guest root itself has about 4G free. Other guest writes land in the box's writable layer and vanish with the box, as for containers. |

## Activity, cleanup and reset (host side)

- Sleep belongs to the optional power module (`boxd-idle`, `BOXD_POWER=on`); `boxd-pod` and `boxd-reset` never touch power
  settings. Busy (no sleep) = an incoming ssh connection (port 22 or `BOXD_PORT`), load, or a boxd-keepawake holder (every
  foreground call, detached run and forward holds it since 0.4.4, so a call from an address of `BOXD_IDLE_IGNORE` is safe too).
  The setting `BOXD_IDLE_IGNORE` (addresses, words, empty by default) names addresses whose connections on `BOXD_PORT` are not
  work: the dashboard's polls must not keep the host awake. The peer address is compared whole (`10.0.0.90` is not `10.0.0.9`);
  connections on port 22 always count, from every address; an address in the form `::ffff:a.b.c.d` is `a.b.c.d`. A build
  started from a listed address then does not keep the host awake by its connection alone (its load still does).
  Processes inside boxes, of either engine, do NOT count: idle boxes survive suspend. `boxd-idle status` prints the
  busy reason, or `quiet`, as its first line and changes no state. Suspend freezes a virtual machine's process with
  everything else; its behaviour across a real suspend is UNVERIFIED.
- **Busy and young** (used by the admission of container boxes and of machines). A box is *busy* while a call or a run holds the shared lock on its
  `jobs/<box>/.running` (tested without waiting, the reaper's test, `busy=` of `pod report`). Its call or run is *young* while the box's
  `.last-used` stamp, touched when a call begins and again when it ends, is no more than `BOXD_VM_IDLE_MIN` seconds old by the server's clock
  (the same setting as the idle machine, on the other side of the line: an idle machine is one that is neither busy nor young).
- The `boxd` service creates the boxd-keepawake lock `/run/boxd-keepawake.lock` when it starts, so a held lock also
  keeps `boxd-reset` from replacing the work area under a run, with or without the power module.
- **Retention** (owner decision 2026-11-14: the host is kept clean by boxd, nobody cleans by hand). After the boxes, every reaper pass
  looks at the box folders `jobs/<box>`. Only whole folders are removed, never single files of a box (which file of a project is worth
  keeping is the project's rule, not boxd's). A folder goes when:
  - it was **unused for `BOXD_KEEP_DAYS`** (default 14): last use is the date of `.last-used` (touched by every `pod run`, and by a sync or
    pull into a folder that has one), or the folder's own date when no call stamped it yet;
  - **the work area is full**: from `BOXD_EVICT_AT` percent (default 70, as `df` reports it) the least recently used folder goes, one per
    pass (freed space shows late on btrfs, so each pass measures again), until the fill level is under `BOXD_EVICT_TO` (default 60;
    the state between passes is the file `cache/.evicting`). A folder used within `BOXD_TTL` is never taken. The reset of the whole
    work area by the power module (`BOXD_RESET_AT`, 85) stays as the last resort;
  - **its worktree is gone**: `pod drop <box>` from the client's collector.
  **Images.** The image built from a box's Containerfile (`localhost/built-<box>:latest`) is removed with the box's folder, on both
  engines. When disk pressure starts (once per episode, before the first folder goes) every named image goes unless a box uses it (the
  engines refuse those: `podman rmi`, `msb image rm` without force) or it is the built image of a box whose folder is still there; then
  the dangling layers (`podman image prune -f`) and the records of pushed machine images (`cache/pushed-vm-*`). The log line's box column
  is `images`. Images come back by themselves (pulled, loaded from `BOXD_IMAGES_DIR`, built again); only an image sent with
  `box image push` must be pushed again (`pod image has` answers no). Images are not removed by age.
  The reaper never takes a folder whose `.lock` is held (the box is being made) or whose `.running` is held (a run, a sync or a pull: the
  dispatcher runs the client's rsync as `flock -s jobs/<box>/.running rsync ...` when the folder exists). The box goes with its folder
  (`pod stop`), then `podman unshare rm -rf jobs/<box>` (files made by other users inside a box belong to the account's subordinate ids).
  Before this boot's clear of the machines (`/run/boxd-pod.clean`) nothing is evicted. Each removal prints `evicted <box> (<reason>), <n> MB freed` (`du -smx` of the folder inside `podman unshare`, before the removal; the built image is not counted; without the size when it could not be measured) and
  adds one tab separated line to `cache/evictions.log`: epoch seconds, box, reason (`unused <n> days`, `disk <n> percent full`,
  `worktree gone`); the file keeps its last 1000 lines. A machine box with a recorded need also adds one line to `cache/mem-peaks.log` ("Memory need"). The first `pod run` into a new folder of a box named there writes once to
  standard error: `boxd-pod: the folder of this box was removed on <date> (<reason>); it starts empty`. A `pod run` that waited for the
  lock of a folder removed meanwhile makes the folder again and takes the new lock.
- `boxd-pod reap [--now <epoch>]` (run by the `boxd` service every minute as `runuser -u build -- boxd-pod reap`; the
  command sets up the account's home folder and environment itself, because rootless podman needs them): removes every box whose
  `.last-used` is older than `BOXD_TTL` seconds (default 1800), unless its `.lock` is held (being created)
  or its `.running` is held (a foreground or detached run). Files stay (until "Retention" below takes the folder). `--now` exists for tests. Boxes are the
  podman containers labelled `boxd.box` and the microsandbox sandboxes named `pod-*` (every sandbox in this
  `MSB_HOME` is a box); removal is `podman rm -f pod-<box>` or `msb rm -f pod-<box>` by engine.
  - Virtual machines are skipped (no `msb` call at all) until `/run/boxd-pod.clean` exists; containers are
    reaped as before.
  - microsandbox's own idle timeout is not used: the reaper is the only clock.
  - reap and clear call only `msb ls`, `msb inspect` and `msb rm`, never a command that starts a box: they run
    outside the build cgroup, and a box they started would escape the cap.
- `boxd-pod clear` (local only, like `reap`; over ssh it is an unknown command): first every detached run gets
  SIGTERM (a detached run records its process group in `/work/jobs/<box>/runs/<run>.pid` and removes the record
  before it writes the `EXIT` line; `clear` waits up to about 10 s for each group to end and drops stale records),
  then `podman rm -af`, then `msb rm -f` for every `pod-*` sandbox. Prints `cleared`. Files stay.
  - `server/sv/boxd-sshd/run` runs it once per boot before `exec sshd`:
    `[ -e /run/boxd-pod.clean ] || { runuser -l build -c 'boxd-pod clear' && : > /run/boxd-pod.clean; }`.
    `/run` lives in memory, so the marker is gone after a reboot. Why: microsandbox trusts a process id recorded
    before the reboot (its issue 1642, open); at that point no build session exists, so a stale signal can
    only hit the clearing process itself.
- `boxd-reset`: busy = boxd-keepawake held or an ssh session of `build`; it then runs `boxd-pod clear` as `build`
  (in place of `podman rm -af`), kills the remaining `build` processes, and swaps subvolumes as before. Removing
  a box also ends its detached runs (their exec exits with the box), which releases their boxd-keepawake locks.
  `work` keeps `/work/cache/msb`, so virtual machine images survive while boxes go; `all` empties it, and the
  next `--vm --image localhost/toolbox` call reloads the archive, as podman does.

## The reading verbs (`pod report`, `pod calls`, `pod log`) and the keys that may only read

For the dashboard (`docs/designs/dashboard.md`). All three are read only: no lock, no `.last-used` stamp, no call log line, no
engine call that starts, stops or changes anything (they ask `podman ps` and `msb ls`, as `pod list` does). Extra words: exit 125,
`boxd-pod: unknown command`. A server older than 0.3.0 answers `unknown command`. What cannot be read is a dash.

**`pod report`**: lines of tab separated words; the first word says what the line is, the others are `key=value`, in this order.

- One `host` line: `version`, `engines`, `cpus`, `load1` (these first six words are taken from `pod status` itself, so the two
  always agree), `load5`, `load15` (`/proc/loadavg`), `boot` (epoch seconds, `btime` of `/proc/stat`), `mem_total_mb`, `mem_avail_mb`,
  `swap_total_mb`, `swap_used_mb` (`/proc/meminfo`, or the file `BOXD_MEMINFO`; megabytes are kilobytes divided by 1024, rounded
  down), `group_mem_max_mb`, `group_mem_used_mb` (the build cgroup: `memory.max`, and the memory that cannot be given back,
  `anon` plus `shmem` of `memory.stat` plus `memory.swap.current`, the rule of `mem_free_mb` and of the admission; the maximum is a dash when `memory.max` is `max`, the used figure is still given), `pressure_some10`, `pressure_some60`, `pressure_full10`,
  `pressure_full60` (`avg10` and `avg60` of `memory.pressure`), `oom_kills` (`oom_kill` of `memory.events`), `vm_used`, `vm_max`,
  `vm_room` (exactly as in `pod status`), `vm_mem_mb` (memory of a machine of the default size), `box_mem_mb` (the `--memory` of
  `BOXD_LIMITS`), `disk_pct`, `disk_total_mb`, `disk_used_mb` (`df` of the work area), `ttl` (`BOXD_TTL`), `power` (`on` or `off`,
  `BOXD_POWER`), `idle_checks`, `idle_count`, `idle_last`, `reset_at` (`BOXD_IDLE_CHECKS`, the files `count` and `last` of the power
  module's state folder `BOXD_IDLE_STATE`, `BOXD_RESET_AT`; each a dash when the power module is off, or its file cannot be read), and
  last `keepawake`: `held`, `free`, or `none` when the lock file (`BOXD_KEEPAWAKE_LOCK`) does not exist.
- One `box` line per box, sorted by name: `box`, `engine`, `image`, `state` (`running` or `stopped`, as `pod list`), `last_used` (epoch
  seconds, 0 when never), `user` (`yes`, `no`; for a machine from the file `.vm-user`, a dash from older servers), `size` (`small`, `medium`, `large`, `xlarge`; a dash for a
  container), `mem_limit_mb`, `mem_mb` (a dash when stopped or unreadable), `busy` (`yes` while a foreground or detached run holds the
  box's `.running` lock, tested without waiting, as the reaper does), `runs` (detached runs still running), and, last, `mem_peak_mb` (see "Memory need"; a dash for a container box and for a machine with nothing recorded). `mem_mb` of a virtual
  machine is the resident memory (`VmRSS`) of its machine process; of a container, `memory.current` of the cgroup of the
  container's init process (`podman inspect` gives its id, `/proc/<id>/cgroup` the cgroup). UNVERIFIED on rootless podman of the real
  hosts: a dash there means the cgroup is not readable (acceptance scenario 39 shows which).
- `run` lines, by box, then id: `box`, `id`, `state` (`running` while the pid record exists and the process group it names is alive, else `ended`), `exit` (the code of the
  last line `EXIT <code>`; a dash while running or without such a line), `bytes` (size of the log), `changed` (epoch seconds of its
  last write). Listed: every running run and, per box, the three ended runs with the greatest ids (an id starts with its date and
  time, so these are the newest). `runs/dockerd.log`, the docker daemon's log of a virtual machine box, is not a run.
- One `image` line per archive in the images folder: `name`, `bytes`, `built` (epoch seconds of the file).
- Since 0.4.1, one `evicted` line per removal by retention in the last day (from `cache/evictions.log`, oldest first, 50 at most): `at` (epoch
  seconds), `box` (`images` for the image pass), `reason`. The dashboard shows them as one alert per host.

`pod status` and `pod list` stay as they are: the client's host choice reads `pod status`, and it must stay one short line.

**`pod calls [<offset>]`**: the call log from a byte offset. First line `calls`, `size=<bytes of the log>`, `from=<offset really used>`,
`next=<offset after the last line sent>`; then the log's lines, unchanged. Only complete lines are sent (a line being written
waits for the next call). One answer carries at most 1 048 576 bytes (`BOXD_READ_MAX`, a test hook), cut at a line end; `next` below
`size` means "ask again from `next`". A single line longer than the limit is cut at the limit, so a reader always advances. An
offset greater than the size (the log was emptied by `boxd-reset all`) reads from 0. Without an offset: the last 1 048 576 bytes,
from the first line start at or after that point (the first contact with a host whose log is huge). No log: `size=0 from=0 next=0`,
and nothing is made. An offset that is not a number of at most 18 digits: exit 125, `boxd-pod: bad offset`. Readers split every line
on tabs and ignore fields beyond the ninth (see "Call log").

**`pod log <box> <run> [<offset>]`**: a detached run's log, read from the job folder (the box need not run, and is not started,
unlike `box --no-sync cat /job/runs/<id>.log`). First line `log`, `size`, `from`, `next`, `state` (`running` while `runs/<run>.pid` exists,
else `ended`), `exit` (the last line `EXIT <code>`; a dash while running or without one: a run whose box or host went down under it is `ended` with a dash, and `box log --follow` then exits 129); an ended run's header ends with two more words, `ended=<epoch seconds>` (the log's last modification time) and `seconds=<n>` (that time minus the log's creation time, `stat -c %W`; left out when the file system gives no creation time or the difference is negative), a running run's with neither (readers take the words by key); then the bytes, with the rules of `pod calls`
for the offset, the limit and the missing offset. No such run: exit 125, `boxd-pod: no run <run> in box <box>`. A bad box name or run
id: exit 125, `boxd-pod: bad box name`, `boxd-pod: bad run id`.

**Keys that may only read.** The build sshd's settings (`/etc/boxd/sshd_config`) carry `ExposeAuthInfo yes`, so that sshd writes the
login's authentication to a file named by `SSH_USER_AUTH` (a line `publickey <type> <key>`) and `boxd-pod` can tell which key logged in.
`/etc/boxd/view_keys` (the hook `BOXD_VIEW_KEYS`) lists keys, one `<type> <key> [comment]` per line, `#` starts a comment; the file must
be readable by the build account (mode 644: public keys are not secret). A login with a listed key (type and key text must match
exactly) may run `pod status`, `pod list`, `pod ps`, `pod report`, `pod calls`, `pod log` and `pod help`; everything else, the rsync passthrough
and unknown commands included, exits 125 with `boxd-pod: this key may only read` before anything is touched or logged. Other keys keep
every command. Fails closed: when the list has entries and sshd did not name a public key that logged in (an old settings file
without `ExposeAuthInfo`, or a login that is not by key), every command of every key is refused with `boxd-pod: view keys are set but
the login key is hidden; add ExposeAuthInfo yes to the build sshd`; when the list exists but cannot be read: `boxd-pod: view keys
cannot be read`. A list with no entries (comments only) limits nobody. The settings file is kept on upgrade, so an old one fails
loudly rather than open.
`boxd-setup --view-key <file>` (as root, after the first `boxd-setup --key`) adds the key on the file's first line to the list and to
the allowed keys of the build account and adds `ExposeAuthInfo yes` to the settings file when it is missing; then `boxctl reload`.
Every full `boxd-setup` run puts the listed keys back among the allowed keys (a new `--key` replaces that file). By hand, the same
three steps as root on a host: append `ExposeAuthInfo yes` to `/etc/boxd/sshd_config`; append the key line (`ssh-ed25519 AAAA...
dashboard@homeserver`) to `/etc/boxd/view_keys` (mode 644) and to `/etc/ssh/authorized_keys/<account>`; run `boxctl reload` (restarts only
the build sshd; sessions and boxes stay).

## Forwarding a port (`pod forward`, `box forward`, `box vnc`)

Since 0.4.0. A box can run a server of its own (a desktop with x11vnc on 5900, a noVNC page on 6080) that only listens on
`127.0.0.1` inside the box. `AllowTcpForwarding no` stays in the build sshd (no `ssh -L`): the channel is a command.

- **Server, `pod forward <box> <port>`.** The box name goes through the box-name check, the port must be 1 to 65535 (checked here: the
  client's check is no boundary), the target is always `127.0.0.1` inside the box. It never creates or starts a box: missing or stopped
  gives 125 with one line (`no box <box>`, `box <box> is not running`); a `vm` box gives 125 `forward is for container boxes`
  (shortcut: a vm box has no host-side network namespace to enter; when a vm box needs a viewer, relay through `msb exec`). The relay is the
  host's own socat inside the box's network namespace, so any image works without socat in it:
  `podman unshare nsenter --net=/proc/<pid>/ns/net socat - TCP:127.0.0.1:<port>`, `<pid>` being the box's init process
  (`podman container inspect --format '{{.State.Pid}}'`); `podman unshare` enters the build account's user namespace, which owns the
  box's network namespace. `socat` is a dependency of `boxd-server`.
- **Held like a foreground call.** For the life of the channel the call holds a shared lock on `jobs/<box>/.running` (the reaper,
  retention and the dashboard see the box busy) and runs under `boxd-keepawake` (the sleep module leaves the host awake); it touches
  `.last-used` on open and on end. A hangup, termination or broken pipe ends the relay.
- **It ends when the channel ends.** The ssh session closing closes standard input; socat then ends and so does the call.
- **Call log.** One line per channel in the nine columns, command column `forward <port>`, written when the channel ends (exit code of
  the relay, `129` when hung up). Nothing per byte.
- **Client, `box forward [--host <name>] [--pod <name>] <local-port> <box-port>`.** Listens on `127.0.0.1` only (local port 0 picks a free
  one), and for each accepted connection runs one `ssh boxd-<host> pod forward <box> <box-port>` whose standard input and output are the
  connection. No sync, no box registration, no collector pass. Prints `forwarding 127.0.0.1:<local> -> box <box> port <box-port> (Ctrl+C stops)`
  and runs until SIGINT or SIGTERM, then closes the listener and every channel and waits for the ssh children. A closed connection ends its
  ssh. A server answering `unknown command` is told as `box: this build server is older than 0.4.0, forward needs an upgrade`; any other
  refusal line of the server is passed on.
- **`box vnc [--host <name>] [--pod <name>] [--port <box-port>]`** is `box forward` with local port 0 and box port 5900 (or `--port`),
  then `xdg-open vnc://127.0.0.1:<local>`; when `xdg-open` is missing it prints the address instead. No viewer probing.
- Test hooks: the fake podman answers `unshare nsenter` (`FAKE_FWD_PROBE`, `FAKE_FWD_OUT`, `FAKE_FWD_EXIT`), `FAKE_CPID` is the box's process id.

## Images

- `localhost/toolbox` carries a docker engine (`dockerd`, `containerd`, the `docker` command) and `podman`,
  for use inside virtual machine boxes. Its `/etc/containers/containers.conf` sets
  `cgroup_manager = "cgroupfs"`: podman inside a virtual machine needs it. In a container box neither runs (no
  privileges there); `toolbox-check` checks that they are installed. A `--vm` box of the toolbox starts
  `dockerd` by itself (see "Engines"). Its `tsc` is the native compiler (version 7, no `lib/typescript.js`); tools that load TypeScript as a
  library find its JavaScript interface, version 6, at /opt/typescript-api/node_modules/typescript (not on `PATH`).
- The vm store is `/work/cache/msb`, separate from podman's, so `localhost/toolbox` is stored twice (size not
  measured).
- Large registry pulls can fail in microsandbox (its issue 2006); `localhost/` images come from the archive and
  avoid that.

## Pushing an image (`box image push`)

Owner decision 2026-11-13: the build host never holds registry credentials. The machine where the owner is logged in to a
private registry pulls the image and streams it to the host; the host's two verbs only see the finished archive.

- `pod image has <engine> <ref> <id>`: `<engine>` is `container` or `vm` (else 125, `boxd-pod: bad engine <word>`); `<ref>` goes through
  the same normalisation and registry list as `--image` (else 125, `boxd-pod: image not allowed`; a short name means
  `docker.io/library/<name>`); `<id>` is `^[a-f0-9]{12,64}$` (else 125, `boxd-pod: bad image id`). Container: `podman image inspect
  --format {{.Id}} <ref>` equals `<id>`. vm: `msb image inspect <ref>` succeeds AND the id recorded by the last `pod image load vm <ref> <id>` (file `cache/pushed-vm-<checksum of ref>`) equals `<id>`; microsandbox reports no image id of its own (its inspect prints only its digest of the converted image; seen on the tower, msb 0.7.15). Limit: an image of that name that reached the vm store another way (a registry pull by `msb create`) has no record, so a push transfers once. Exit 0 or 1, no output;
  `vm` without microsandbox installed: 125. Anything but exactly these words: 125, `boxd-pod: unknown command`.
- `pod image load <engine> <ref> <id>`: same checks of engine, `<ref>` and `<id>` (the image id the client read on its side). The archive from standard input is written to a fresh file
  `$WORK/cache/images/push.<random>` (never a name or path from the client) and removed when the call ends, whatever its outcome. Loading
  goes through the same code as the archives of local images (container: `podman load -i <file>`; vm: `msb load < <file>`), then
  `<ref>` must exist in that engine's store (`podman image exists`, `msb image inspect`), else exit 125,
  `boxd-pod: loading the archive did not give <ref>`. The other engine's store is never touched. Exit 0 on success.
- Both verbs are logged in `calls.log` like other calls: box `image`, the engine, the exit code (1 of `has` is logged as 1), the refusal reason.
- No size check: the work area has no reset threshold in the server code (the power module's disk percent is its own, for
  sleeping), so none applies here. A full disk makes the archive write or the load fail, and the call exits 125.
- A box created afterwards with `--image <ref>` finds the image in its store and does not pull it (`podman run --pull=missing`; `msb create`
  uses a cached image, UNVERIFIED for msb 0.7.15: scenario 37 of `tests/pod-acceptance.sh` can only show that the box answers).

## Handing a credential to the command (`--env`)

`pod run <box> --env <NAME> ...` (repeatable): the command, foreground or detached, gets the variable `<NAME>`. Owner
decision 2026-11-13: a credential may reach a box, never a disk.

- The value is never on the command line. The client puts it in ssh's own environment passing as
  `BOXD_SECRET_<NAME>` (`ssh -o SendEnv=BOXD_SECRET_<NAME>`); the build sshd accepts exactly that prefix
  (`AcceptEnv BOXD_SECRET_*` in `sshd_config`). `SSH_ORIGINAL_COMMAND`, and so the call log, carry the name only.
- `<NAME>` must match `^[A-Z][A-Z0-9_]{0,62}_(TOKEN|KEY|SECRET|PASSWORD)$`, else exit 125
  (`boxd-pod: --env <NAME>: only names ending in _TOKEN, _KEY, _SECRET or _PASSWORD`); the client refuses the same
  names with exit 2, and a name not set in the caller's environment too. The reason: boxd-pod exports `<NAME>` in its
  own process just before the command starts (both engines take a bare `-e <NAME>` from there), so a name that
  steers podman, msb or the loader on the host (`PATH`, `LD_PRELOAD`) must never pass.
- A name whose `BOXD_SECRET_<NAME>` did not arrive is refused before any work (exit 125, `boxd-pod: --env <NAME>:
  the value did not arrive (the host's sshd must accept BOXD_SECRET_*)`): a host with an older `sshd_config`.
- The `BOXD_SECRET_*` carriers are unset before the command starts. The value is written to no file by boxd; it
  lives in the environment of boxd-pod, the engine's exec and the command, for that call only. A later call without
  `--env` does not see it. Limits: anything running in the same box can read it from the command's environment, and
  what the command itself prints or writes is its own business (a detached run's log is on the host's disk).

## Building an image (`--image-file`)

`pod run <box> --image-file <path> ...`: the box's image is built from a Containerfile the agent keeps in its worktree.
`<path>` is relative to the worktree's top folder (the synced `/work/jobs/<box>/src`): plain components of
`[A-Za-z0-9_.-]`, no leading `/`, no `.` or `..` component, at most 200 characters, else exit 125 (`boxd-pod: bad image file path`);
the client refuses the same paths with exit 2 and refuses `--image` together with `--image-file` (the host: 125).

In the box lock, after the sync made `src` and before the box is looked up:

1. The file must exist, be a regular file and stay inside `src` once links are resolved (`realpath`), else exit 125
   (`boxd-pod: image file <path> not found`). Nothing was called on either engine yet.
2. `podman build -f /work/jobs/<box>/src/<path> -t localhost/built-<box>:latest <folder of the file>`. Everything the
   build prints goes to stderr (stdout stays the command's). Failure: exit 125, `boxd-pod: image build failed`; the old box is
   untouched, like every refusal that comes before a removal.
3. `podman image prune -f` (dangling images only, so the layers of the previous build go).
4. `podman image inspect --format '{{.Id}}' localhost/built-<box>:latest` gives the new image id. The box's image is
   `localhost/built-<box>:latest`.

The id the box was made from is kept in `/work/jobs/<box>/.built-id`, written after the box is created (a box created
without `--image-file` removes it). With an existing box on the asked engine:

- same id: the box is reused (no removal, no `run`); a stopped box is started;
- another id, or no record: the box is replaced, as `--recreate` does, on the same engine, without `--recreate` and
  without the refusal about another image; files under `/job` stay. The other refusals hold: a box on the other
  engine, or made without `--user` or `--kvm` when it is asked, needs an explicit `--recreate`.

The build runs on every `--image-file` call; podman's layer cache makes an unchanged one fast. A later call without
`--image-file` keeps the box's image (the sticky rule). A box that was removed (the reaper, `pod stop`) and is then
asked for without `--image-file` gets the default image, as for any other image.

**vm engine.** The microsandbox store is separate from podman's. When the build is new for a box that is to be
created (id differs from `.built-id`, or there is none), the host runs `podman save -o /work/cache/images/built-<box>.tar
localhost/built-<box>:latest` and loads that archive into microsandbox with the same step as for `localhost/` archives
(`msb load < <archive>`, always, even when a store entry of that tag exists, then `msb image inspect`), still before any
removal. `/work/cache/images` is under `cache`: it survives `boxd-reset work` and goes with `boxd-reset all`. The image
step also looks for `<name>.tar` there when `/var/lib/boxd/images` has none, so a box recreated by `--recreate` from a built image finds
its archive.

**What `BOXD_REGISTRIES` does not cover.** The setting guards the `--image` path only. A build runs the agent's own
file: its `FROM` lines and `RUN` downloads (`curl`, `apt`, `pip`) reach any registry and any address the host can, and are
not checked. The build runs as the build account, rootless, and what it produces runs under the box's limits. Private
registry credentials are not supported.

The call log line is unchanged (a refusal or a failed build is a 125 line with its message).

## Network (vm only, recorded rather than changed)

- microsandbox's default policy is "public-only": the internet works; the home network, the host itself,
  loopback and metadata addresses are blocked. Container boxes reach the home network: a known difference.
- A build that needs a name the host reaches only through a home-network address would fail in a virtual machine box. How
  such a name resolves there is UNVERIFIED.
- Published ports: none.
- `BOXD_VM_NET_ALLOW` (admin setting, empty by default): home-network services a vm box may reach, words
  `<address[/bits]>:<tcp|udp>:<port[-port]>`. When set, `msb create` gets `--net public` and one
  `--net-rule allow@<word>` per word, so the public internet and exactly those services work and the rest of the home
  network stays blocked (checked on the tower: the two model servers answer, workstation's ssh port does not). A malformed
  word refuses the creation (exit 125, `boxd-pod: bad BOXD_VM_NET_ALLOW entry: <word>`). Only boxes created after a
  change get it. The client cannot set it.

## Memory budget

The cgroup `/sys/fs/cgroup/boxd`: `memory.max` `BOXD_MEM_MAX` (default 85 % of the host's memory less half of the swap the group may put on zram, computed when `boxd-sshd` starts), `memory.swap.max` `BOXD_SWAP_MAX` (default 25 %), no `memory.high` (the spike showed
it makes a runaway job crawl instead of dying). Per container box 12G of memory and 4G of swap
(`--memory-swap 16g`). Swap is 16G of compressed memory (zram, zstd, service `zramen`, enabled by `boxd-setup` when the package is installed). A new virtual machine (a creation or the start of a stopped one) is admitted when the memory the build group
really uses (`anon` plus `shmem` of its `memory.stat`, plus `memory.swap.current`) plus the memory of its size (`small` 2G, `medium` 4G, `xlarge` 12G, `large`
`BOXD_VM_LIMITS`, 8G by default) is at most the group's cap, and while the sizes of the running machines plus the new
one fit `BOXD_VM_COMMIT` percent (100) of that cap (step 5b); `BOXD_VM_MAX`, when set, is a hard ceiling on the
count on top. Guest memory is not page cache the host can take back. Limit, in plain words: this is overcommit.
Machines admitted while they were light can later fill their full size together; the group's cap then ends a
process in the group, usually a whole machine (its files stay, the host stays safe). The count rule (default 3,
used only when the group's files cannot be read) kept the sum of sizes below the cap instead. Since 0.4.9 the container boxes count too (memory they use now, step 5b) and are made with `--oom-score-adj 1000`, so when the cap is reached the kernel ends a process of a container box, the one that grew, before a machine; boxes made before 0.4.9 keep their old score until recreated.

**Container boxes are admitted by a reserve (owner decision 2026-11-17).** The kill the oom score only softens is better avoided: a call that starts work in a container box that is not busy is refused (exit **75**, `boxd-pod: no room for another busy box (...)`) when the sizes of the running machines, what the other container boxes use (a busy one with a call or run begun no more than `BOXD_VM_IDLE_MIN` seconds ago at least `BOXD_BOX_RESERVE` megabytes, default 4096, because it has not claimed its memory yet), and the larger of the reserve and the asking box's own use would exceed `BOXD_VM_COMMIT` percent of the cap. `BOXD_BOX_RESERVE=0` turns it off. The machine admission counts the same young busy boxes, by the same code. The full rule is under `pod run`, step 5b; the words `box_room`, `box_fit_mb` and `box_reserve_mb` of `pod status` let a client judge a container call before sending it.

**Idle machines give their room back (since 0.4.12).** A machine is idle when its box was last used more than
`BOXD_VM_IDLE_MIN` seconds ago (default 300; not a number: exit **125**, `boxd-pod: BOXD_VM_IDLE_MIN must be a number`)
and neither of the reaper's two locks is held (it is not being made, and no run, detached or foreground, and no call is in
it). When `pod run` would refuse a new machine for room, it first removes idle machines, the longest unused first and no
more than needed, and asks again after each; it removes none when the busy machines and the container boxes alone already
refuse the call (the answer with the idle machines left out names the sizes or the count ceiling). A removed machine is
treated as after the reaper: its folder under `jobs/` stays, files outside `/job` are gone, its next call makes it
again. Each removal appends a line to `cache/evictions.log` with the reason `idle machine removed, <box> asked for
room`, which `pod report` prints as an `evicted` line. `pod status` answers with the idle machines left out of the
sizes and of the count (`vm_room`, `vm_why`, `vm_fit_mb`), so a client does not refuse a call the server would make
room for; `vm_used` stays the true count. Limit: the measured memory still holds what idle machines use, so `pod status`
can say no where `pod run` would make room. Without waiting callers nothing changes: an idle box of either engine still
goes after `BOXD_TTL`.

## Memory need (owner decision 2026-11-17)

The host cannot see what a machine really needs: its guest fills spare memory with file cache and never gives it back, so every machine looks as large as its size. The guest knows: `MemTotal - MemAvailable` of its `/proc/meminfo`. A reading at the end of a run misses the peak (a build frees its memory when it ends), so a small loop in the guest keeps the highest value while the machine lives. **Admission is unchanged**: machines are counted by their sizes. The numbers are collected (`cache/mem-peaks.log`) so that the owner can decide whether admission may one day count a machine by its need.

- **The loop** (`GUEST_MEM_PEAK` in `server/boxd-pod`, started by `GUEST_MEM_START` in the same call that runs the start-up script, before every command): reads `/proc/meminfo` every 3 seconds and keeps the highest `MemTotal - MemAvailable`, in whole megabytes, in `/job/.mem-peak`, that is `jobs/<box>/.mem-peak` on the host. Not `/job/src` (the sync deletes there); `/job` itself the sync never touches, the box's `.last-used`, `.vm-size` and `runs/` live there too, and the host reads it without asking the guest. The file is written only when the value grows, as a temporary file renamed over it, so a reader never sees half a number. The start is the file's old value, so the peak only grows. The loop is one `sh` in its own session with its output closed (as `dockerd`), one `sleep` child at a time, no process of the host: it holds neither `.running` nor a call, so it does not keep the machine from being idle and it does not make `box drop` refuse (`busy=` is the host's lock). `pod ps` leaves it and its sleep out: the pid file `/run/boxd-mem-peak.pid` names the loop, and a process is hidden when it is that pid or its child. It is one per machine (the pid file names it, and counts only when the process's command line carries the word `boxd-mem-peak`), and ends with the machine. An image without `sleep`, without `/proc/meminfo` or without `MemAvailable` records nothing, silently. Test hooks: `BOXD_GUEST_MEMINFO`, `BOXD_GUEST_ROUNDS`, `BOXD_GUEST_NAP`, `BOXD_MEM_PEAK_FILE`, `BOXD_MEM_PEAK_PID` (unset in a guest).
- **It belongs to the box.** When the idle machine is removed and made again the file stays and only grows. `--recreate` removes it (after the old machine is gone, before the new one starts), and so does the removal of the box folder. A recreation because the Containerfile changed keeps it.
- **`pod report`**: the `box` line ends with `mem_peak_mb=<megabytes>`, a dash for a container box, for a machine with no file and for a file that is not a number. It is the last word of the line, so a reader that takes words by key (the client, the dashboard) is not disturbed. The dashboard fixture `tests/fixtures/dashboard/tower.report` was regenerated (`tests/dashboard-capture.sh` now seeds a need of 2900 MB for one machine; the four box lines gained the word, nothing else changed).
- **`cache/mem-peaks.log`**: where a box folder goes (retention by age, by disk pressure, `pod drop`; the removal of an idle machine does not remove the folder and writes none), one tab separated line when the box has a recorded need: time (epoch seconds, as in `evictions.log`), box, size name, size in megabytes, need in megabytes. Last 10000 lines kept once it passes 20000. This is the week of numbers to decide from. `--recreate` discards a need without a line.
- **The size of a machine made again with no `--size`**: when `pod run` creates a machine for a box whose folder holds a recorded need, the size is the smallest of `small`, `medium` and `large` (the host's default, never `xlarge`, never above the default) whose megabytes are at least 1.25 times the need (`size * 4 >= need * 5`, whole numbers), recorded in `.vm-size` as for any size and counted by admission as that size. Standard error gets, next to the creation line: `boxd-pod: machine box <box>: size <name> chosen from its past need of <peak> MB (give --size to choose yourself)`. With no need, with `--size`, with `--recreate`, for a stopped machine that is only started, or when not even the default holds the need with that margin (the box then keeps its recorded size, `large` when there is none; an `xlarge` box that is made again stays `xlarge`), nothing changes. The client sends `--size` only when the user gave one, and its host choice judges a call without it as the default size; the server may then fit a smaller machine than the client assumed, which is safe.
- **Compatibility.** A new client against an older server: the answer of `pod drop` has no need words and the line is as before; the machine has no loop (the file never appears), so nothing else is seen. An older client against a new server: it reads the ending `, <n> MB freed` of the answer and ignores the need words, so it prints the line as before; it reads `pod report` by key, so the new last word changes nothing; it never sends `--size` unasked, so it gets the size from the need like any client. Limit: the file's owner and readability for the host are those of what the guest root writes under `/job` (mirrored ids); UNVERIFIED on a real host until `mem_peak_mb` shows a number there.

## Client (`box` on the agents' machine)

`box [--host <name>] [--pod <name>] [--image <ref> | --image-file <path>] [--vm|--container] [--size small|medium|large|xlarge] [--user] [--kvm] [--env <NAME>]... [--recreate] [--no-sync] [--snapshot | --git] [--detach] [--wait] [--pull <path>]... [--ps-after <minutes>] [--] <command...>`
run from inside a worktree (git toplevel of the current directory):

1. Sync (skipped with `--no-sync`), the recipe of `remote-cargo.sh`:
   `rsync -a --delete --mkpath [--filter='. <rules file>'] --safe-links --exclude=/.git --filter=':- .gitignore' <toplevel>/ boxd-<host>:jobs/<box>/src/` (relative: the host's dispatcher runs the sync inside the work area).
   Exactly git's files: rsync's own .gitignore reading misses git's negations (`!pattern`), `.git/info/exclude` and the
   global excludes, and drops tracked files that an ignore rule matches (`git add -f`). The client runs a local dry run
   of the base filter (`--safe-links --exclude=/.git --filter=':- .gitignore'`), compares it with
   `git ls-files -co --exclude-standard`, and puts one rule per difference in a merge file read first (the rules file;
   the characters `*?[\` of rsync patterns are escaped with a backslash): include what git keeps but the filter drops
   (with its folders, whose other content stays excluded), exclude what the filter would send but git ignores. The base
   filter stays, so deletions still propagate and ignored build outputs in the box stay. No difference: no rules file.
   `--safe-links`: a link pointing outside the worktree (a `node_modules` linked to the main checkout) is not
   carried into the box, where it would dangle (pnpm install then failed). It is the receiving side that ignores such
   links, so a dangling link synced by an older client stays until removed once (`box -- rm -f node_modules`).
   **`--git`** (client only; nothing of it is sent to the pod, so the pod line is the same with or without it). After the sync, `/job/src` in the box becomes a git repository whose `HEAD` is the worktree's current commit (same hash), shallow (that one commit, no history), **detached** (a branch name of this machine would be carried over for nothing, may be private, and a branch checked out in another worktree could not be reused; there are no branches, no tags, no remote, no hooks, no reflog and no `FETCH_HEAD`, so no name, mail or path of the user is in it). The index is the commit's tree, so `git status` in the box lists exactly what differs between the synced files and that commit: uncommitted and untracked work shows as such; work staged in the worktree shows as unstaged there. How: in an empty temporary folder the client runs `git init -q --template=`, `git fetch -q --depth=1 --no-write-fetch-head <toplevel> <sha>` (git sends only what that one commit needs; works from a linked worktree and a detached head; a submodule that is not checked out stays an empty folder and a clean entry), `git update-ref --no-deref HEAD <sha>` and `git read-tree HEAD` (all with `core.logAllRefUpdates=false`), then `rsync -a --checksum --delete <tmp>/.git/ boxd-<host>:jobs/<box>/src/.git/` and removes the folder (`--checksum`: on a new commit `HEAD` and the index may have the same size and, within one second, the same time). A repository without a commit is refused (`box: --git: this worktree has no commit yet; nothing was started`, exit 1). The rule for later calls: **the repository stays until a call with `--git` replaces it or the box folder goes** (the sync never touches `/.git`, with `--clean` too); a second call with `--git` after a new commit moves `HEAD` to it. `--git` with `--snapshot` is refused (`box: --git and --snapshot cannot go together`, exit 2, also in `plan`); `--git` with `--no-sync` is refused (`box: --git needs the sync; drop --no-sync`, exit 2); outside a git worktree the client already refuses. Ownership: see the docker start script in "Engines" (vm) and the note under `--snapshot`.
   Files deleted locally are deleted there; ignored files there (build outputs) are kept, because excluded
   files are protected from `--delete`. (`--files-from` cannot be used: it turns recursion and so `--delete` off.)
2. Run: `ssh [-t when stdin and stdout are terminals] boxd-<host> pod run <box> [options] -- <b64>`.
   `--detach` generates `<run>` = `<YYYYmmdd-HHMMSS>-<4 random hex>` and prints it with the log read command,
   which repeats the run's `--host <name>` (when given), `--pod <name>`, `--image <ref>` and `--vm` (without them it would name another box,
   or be refused with 125 for the image or the engine). The run id is the time of the clock of the machine the client runs on, in its
   local time zone (not the host's clock, not coordinated universal time); `box runs` reads it back that way. After the log line it prints one more:
   `files outside /job go when the idle box is removed (after the host's time limit, 30 minutes by default); keep results under /job/src and fetch them later with: box [--host <name>] [--pod <name>] --no-sync --pull <path> true`
   (`--pull` runs after a foreground call, so that call is a `true` that starts the box if needed; the rsync reads the job folder, which stays).
   `--pull` together with `--detach` is never carried out (the run has not ended when the client returns): the client says so on stderr
   (`box: --pull is ignored with --detach ...`) and goes on.
   Silence report (owner decision 2026-11-13): a foreground call that is not on a terminal passes the command's
   output through the client; when nothing arrives on stdout or stderr for `--ps-after` minutes (default 15, else
   `BOXD_PS_AFTER`; decimals allowed; `0` = off), the client runs `ssh boxd-<host> pod ps <box>` and writes the table
   to stderr, every line prefixed `[box ps] `, the first one `no output for <time>; processes in box <box>, oldest
   first:`, and waits again while the silence lasts. It never ends or changes the call; stdout and the exit code are
   untouched. Not for `--detach` (it returns at once) and not on a terminal (the person sees the silence).
3. `--pull <path>` (after a foreground run): `rsync -a --mkpath boxd-<host>:jobs/<box>/src/<path> <toplevel>/<parent of path>/`
   (into the parent folder, so a folder lands as itself; a trailing slash is dropped). A path that is not in the box (rsync's
   `link_stat` or `change_dir` "No such file or directory") prints the one line `box: nothing at <path> in the box, nothing pulled` instead of rsync's
   words; every other rsync failure keeps its output, followed by `box: pull <path> failed`. Both end the pulls and keep the exit code (the
   command's, else rsync's).
3a. **Box options go before the command.** Options are read until the first word that is not one (or `--`). When no `--` was written and
   one of `--pull`, `--include`, `--env`, `--detach`, `--host`, `--pod`, `--no-sync` or `--wait` appears as a whole word after the command
   started, the client prints once on stderr `box: <option> after the command is handed to the command, not to box; put box options before the command (or write -- before the command to silence this)`
   and goes on unchanged (the word stays in the command). With `--` there is no warning.
3b. **A foreground call ends with its starter.** Without a terminal and without `--detach`, the client remembers its parent process id at
   start and looks at it every second (`BOXD_ORPHAN_CHECK_MS`, a test hook). When it changed (the process that started the call is gone)
   the client prints `box: the process that started this call is gone; ending the call (use --detach for work that must outlive its starter)`
   on stderr, ends its ssh with a termination (the server's session rule then ends the command in the box, see step 8 of `pod run`),
   skips the pulls and the collector, and exits 129. `BOXD_KEEP_ORPHAN=1` turns it off, for the rare wrapper that exits on purpose.
   Behaviour change: **work that must outlive its starter needs `--detach`.**
4. Exit code: the remote command's (ssh passes it through); 125 from `boxd-pod` errors and 75 for no room are passed through too (no pull after either). The client itself exits 75 when no host has room (see "Host choice").

`--vm` is a flag without a value. Its help line:
`--vm             the box is a small virtual machine (own kernel, root, docker or podman inside); a box keeps its engine, change it with --recreate`.
An old host answers `--vm` with `boxd-pod: bad option --vm`, exit 125; an old client never sends it.

`<host>` is `--host`, else `BOXD_HOST`, else the host this worktree was placed on, else a choice among the registered hosts (see "Host choice"); with one host registered that is the host `box setup` saved, and none is a usage error (exit 2).
`box setup <host> [--hostname <name>] [--port <n>] [--user <name>] [--identity <file>] [--wake <mac>,<mac> --broadcast <addr>] [--default]`
writes the ssh entry `Host boxd-<host>` into `~/.ssh/config`, remembers the default host, installs the skill and, for
hosts given wake addresses, the wake hook and `~/.config/boxd/wake.json`; it also keeps `~/.config/boxd/hosts.order`
(below); a second run changes nothing.

`box hosts` (read only) prints one line per registered host in order, tab separated: name, `sleeps` (it has a wake entry) or
`always on`, state (`asleep`, `awake`, `unreachable`) and the host's `pod status` line (`-` when it has none). It never wakes a host.

**A closed output pipe** (`box hosts | head -1`) ends any subcommand quietly: the client exits 0 and prints nothing (`EPIPE` on standard
output or standard error is not an error of the program).

`box runs` (read only) lists the detached runs still running, for the boxes this machine registered (see "The collector"): hosts are the
registered ones and those named in the registry, probed as for `box hosts` (a sleeping host is never woken or asked, an unreachable one is
skipped; each is named on one line `box runs: <host> is asleep (not woken, not asked)` or `... is unreachable (skipped)`). On an awake host it asks
`pod report` and keeps each `run` line with `state=running` whose `box` has a registry record for that host. One tab separated line
per run: host, box, run id, age, the record's worktree path, last output line. Age is now minus the time in the run id, read as local time of
this machine (the client wrote it, see step 2 of the call; `BOXD_NOW` is the test hook for now); `-` when the id is not of that shape. The last
line comes from `pod log <box> <run> <offset>` with `offset` = the report's `bytes` minus 2048, not below 0: the last non-empty line (a
carriage return also ends a line, so a progress bar shows its latest state) with tabs turned into spaces, control and other non-printable
characters removed and 120 characters at most; `-` when the log has none. With no such run it prints `no detached run is running`
(before any host note), exit 0.

`box log <run> --state` prints no log, only one line `<run>`, `state=running|ended`, `exit=<code>` (a dash while running or without a code), tab separated, from the header of one `pod log` call, and exits 0. For an ended run the line ends with `ended=<time>` (UTC, like `2026-11-16T17:48:47Z`) and, when the server sent a valid `seconds`, `seconds=<n>` (the run's wall seconds); only digits are believed, and a running run or an older server gives the line without them.

`box log <run> [--pod <name>] [--host <name>] [--follow] [--tail <n>]` reads a detached run's log with `pod log <box> <run> <offset>` (the box of
this worktree, or `--pod`, on the host this worktree is placed on, or `--host`; no choosing, no sync, the box is neither started nor
recreated). It asks from offset 0 and prints each answer's text; while the answer's `next` is below its `size` it asks again at once from
`next`. Without `--follow` it then exits 0. With `--follow` it asks again from `next` every `BOXD_LOG_POLL_MS` (default 2000) until the
answer says `state=ended`, then exits with the answer's `exit` code (1 when it is a dash). With `--tail <n>` (a whole number from 0 to 100000, else a usage error, since 0.4.14) the output is held back until the first catch-up (`next` reaches `size`), keeping only the last `<n>` lines (a last line without a newline counts as one), and then printed; with `--follow` everything after that is printed as before, `--tail 0 --follow` printing only what comes after. The exit code rules do not change. An answer whose first line is not `log` with numeric
`size` and `next` and a `state` is an error (exit 1), and a refusal of the host (for example 125 for an unknown run) is the exit code. The line
`box --detach` prints points at it: `read its log: box log <run> [--pod <name>] [--host <name>] (--follow waits for the end and exits with its code)`.

## The collector (client): `box gc [--dry-run]`

`box drop [--pod <name>] [--host <name>]` is the same removal asked for by a person, for the box of the worktree it runs in, without the two passes. It probes the host and never wakes it (asleep: one line, exit 1), refuses with exit 1 while the box is busy (no force): a running box is asked `pod report`, and when its `box` line says `busy=yes` (a call or a detached run holds it; the same notion the reaper and the idle rule use) the refusal is `box <box> on <host> still has a command running in it; nothing removed`; `busy=no` removes it, whatever `pod ps` lists (an image's own daemons, such as `dockerd` and `containerd` in a machine, are processes but not work). A server whose report fails, has no line for the box or no `busy=` word keeps the older rule: any row of `pod ps` refuses, then sends `pod drop <box>`, which also answers 0 for a box the host no longer has (it stops nothing and removes the folder when there is one). With `--pod` it removes only a box this machine recorded, for the worktree it runs in or for a worktree that is gone; a box of another worktree that still exists, or one without a record, is refused before the host is asked. On success it prints `box drop: removed <host> box <box> and its files, <n> MB freed` (the size is the one `pod drop` measured; without it, and for a server that does not say it, the line ends after `its files`; the collector's line carries the same addition right after `and its files`). For a machine box with a recorded need the line goes on `; it needed <peak> MB of its <size> MB at most`, then, in parentheses, either `--size <name> would have held it` (the smallest of small, medium, large and xlarge with at least 1.25 times the need in megabytes; left out when that is the size the box had) or, when the need is above 80 percent of the size, `close to the limit: --size <next size up> gives <megabytes> MB` (just `close to the limit` for xlarge). Pure function `removedWords`, cases `drop_words` of `contract/cases.json`., removes the record and appends a `gc.log` line whose last field is `asked`; on a failure it keeps the record and exits 1.

`box stop [--pod <name>] [--host <name>]` frees the memory of the box and keeps its files: the same target, the same `--pod` ownership guard, the same probe (a sleeping host is not woken, exit 1) and the same busy refusal as `box drop` (the refusal ends `nothing stopped`), then it sends `pod stop <box>` instead of `pod drop <box>`. The record on this machine stays (the folder still exists, and the collector removes it when the worktree goes); no `gc.log` line is written. On success it prints `box stop: stopped <host> box <box>; its files are kept` (exit 0); when `pod list` shows no box of that name it sends nothing and prints `box stop: <host> has no running box <box>; nothing to do` (exit 0); a failed `pod stop` keeps the record and exits 1. The next call makes the box again on the same files.

Owner decisions 2026-11-14: stranded boxes must not happen, and the monitor of the worktrees lives in the client, not in a service or a
timer on the agents' machine. Nothing is installed besides the client.

- **Registry.** Every call that reaches a host (after its sync) records the box in `~/.local/state/boxd/boxes/<host>.<box>`: one small
  JSON file with `box`, `host` and the absolute `worktree` path, written to a fresh name and renamed (a call from the worktree also clears
  the mark below). A state folder that cannot be written means no record, never a failed call.
- **A pass** (`box gc`, by hand, or in passing, below). Hosts: the registered ones and those named in the registry. Each is probed as
  in "Host choice": a host that sleeps is never woken or asked (named in the output), one that is down is skipped and named. On an awake
  host it asks `pod list`, and then, per record whose box is listed:
  - the worktree is **missing** when its folder is gone or is no longer a git worktree top folder (`git rev-parse --show-toplevel` is the
    folder itself; a git that cannot be started counts as present: nothing is removed on doubt);
  - a missing worktree's box and folder are removed (`pod drop <box>`, also when a run is still going in it: owner decision; a server older
    than 0.4.0 answers 125 and the client falls back to `pod stop <box>`, which leaves the folder) only when it was found missing by
    **two passes at least 15 minutes apart**: the first sighting is written into the record (`missingSince`, epoch milliseconds) and
    nothing else happens, so `box gc` twice in a row says "first sighting" and then "seen again too soon"; a record whose worktree is back loses the mark;
  - each stop is one tab separated line in `~/.local/state/boxd/gc.log`: time (ISO), host, box, worktree path, `run live` or `idle` (from
    `pod ps` just before), and the record is dropped; `--dry-run` says what it would do and writes nothing (no mark, no log line, no stop);
  - a record outlives its box (the reaper removes an idle box after 30 minutes and leaves the folder): it is dropped only together with the
    folder of a worktree that is gone; a record on a host that was not asked stays.
  - A box on an awake host that no record names is **unknown owner** (made before the collector or from another machine): never touched, listed
    with the command that would stop it (`ssh boxd-<host> pod stop <box>`).
  - **Report, never kill:** every process of a running record's box older than 6 hours (from `pod ps`, whose second column is the age in seconds)
    is listed with box, age, folder and command. A detached run's command is listed too (`pod ps` cannot tell them apart).
- **In passing.** After an ordinary `box` call has finished (not `ps`, `hosts`, `runs`, `log`, `setup`, `image` or `gc`, and not after a call whose
  ssh itself failed, exit 255, nor one refused for room, nor one that ended because its starter was gone) the same pass runs at most once per 15
  minutes per machine (the mtime of `~/.local/state/boxd/gc.stamp`, written before the pass), quietly: nothing on stdout, one stderr line
  `[box gc] stopped <host> box <box>: worktree <path> is gone` per stopped box, every ssh with `ConnectTimeout=3`, `ServerAliveInterval=5` and
  a 30 second limit, a host that does not answer is skipped; any failure of the pass is swallowed and the call's exit code is never changed.
  `BOXD_GC=0` turns it off. `BOXD_NOW` (epoch milliseconds) is a test hook for the clock.

## Host choice (client)

With two or more registered hosts the client picks the host of a worktree once, on its first call, and keeps it there.
Owner decisions 2026-11-13; the reasoning is in `docs/designs/load-management.md`.

- **Registry.** The hosts are the marker blocks `# boxd:host:boxd-<name>:begin` that `box setup` writes in `~/.ssh/config`;
  `wake.json` says which of them sleep. Nothing else is stored about a host: engines, limits, load and images are asked live
  with `pod status`.
- **Order.** `~/.config/boxd/hosts.order`, one name per line, written by `box setup`: a new host goes last, `--default` puts it
  first. `~/.config/boxd/host` keeps meaning the default host and is all older clients read. Registered hosts missing from the
  file come last; with no file the saved default comes first.
- **Placement.** One line with a host name in `boxd-host` inside the worktree's own git folder (`git rev-parse --absolute-git-dir`;
  a linked worktree has its own, it goes away with the worktree). Which host a call uses, first match: `--host <name>` (used and
  recorded: this is how a worktree moves; the old box on the previous host is left to the time limit), `BOXD_HOST` (used for this
  call only, never recorded), the recorded host while it is still registered, otherwise the choice below. `--recreate` names no
  host, so it recreates the box where the worktree is placed. With fewer than two registered hosts none of this happens: no
  probe, no file, the saved default as before.
- **The probe never wakes a host.** All hosts are asked in parallel, once per first call. A host with a wake entry is first tried
  with a plain connection to its wake target (3 seconds at most); no answer means `asleep` and no ssh is made, because any ssh to
  its alias would wake it. Otherwise `ssh -o ConnectTimeout=3 -o BatchMode=yes boxd-<host> pod status`: its line means awake,
  exit 125 means awake with no status (an old server), anything else means `unreachable`.
- **The choice** takes, among the hosts with room for this call, the one with the most free memory (`mem_free_mb` of its status line: room left under boxd's cap); ties keep the order, and a host whose figure is unknown comes after those that report it. Spreading, not filling the first host: on 2026-11-15 the first host took every new worktree until its kernel killed a machine while the second stayed idle. Asleep has room and counts as the most free (nothing runs there; the
  call wakes it). Unreachable has none. Awake: a container has room unless the status line says `box_room=no` (the server would refuse a call that starts work in a box, see "Container boxes are admitted by a reserve" under `pod run`; a server that prints no `box_room` never refuses one); a virtual
  machine (`--vm`) needs `vm` in `engines` and `vm_room=yes`; a local image (`--image localhost/<name>`) must be in `images`.
  A virtual machine of a size other than the default (`--size small`, `medium` or `xlarge`) is judged by `vm_fit_mb` against its size in megabytes (2048, 4096, 12288) instead of `vm_room`, so a worktree is not sent to a host that cannot fit 12288 MB while another can; a host that prints no `vm_fit_mb` is judged by `vm_room`, as before.
  **A machine goes to the smallest host that fits (owner decision 2026-11-17).** The rule above (most free memory) was filling the big host with small machines, and a later `--size xlarge` then found no room while a small host stood empty. For a virtual machine request (`--vm`) the client instead takes, among the awake hosts with room for this call (by `vm_room`, or by `vm_fit_mb` for a size other than the default, as above), the one with the smallest cap for boxes (`group_mem_max_mb` of its status line, a number); ties keep the order. A host that does not print a cap (a dash, or an older server) and a sleeping host come after the awake hosts that print one; among themselves they keep the rule above. A container request keeps the most free memory rule, and the caps are not looked at. The reason word logged for a machine placed by the cap is `fit`.
  Awake with no status is the last resort, used only when no other host has room. The pure function is `choose`, with the cases
  under `choose` in `contract/cases.json`; `source` (same file) is the precedence above.
- **No host has room:** the client exits 75 at once, before any sync, with `box: no build server has room for this call` and one
  line `  <host>: <reason>` per host (`3 of 3 machines` at the count ceiling, `no memory for another machine (5 running)` under the memory rule, `no virtual machines`, `image <name> missing`, `unreachable`). For a refusal for room (not for a missing image, a missing machine engine or an unreachable host) it then says what would work now, computed only from the status lines the probe already returned (no new request): `  fits now: --size <size> on <host> (<n> MB free; a box that exists keeps its size, changing it needs --recreate)` when a size below the one asked (small 2048, medium 4096, large 8192, xlarge 12288 MB; large when no `--size`) fits on at least one host by `vm_fit_mb`, naming the largest such size and the host with the most free memory; and `  or wait for room: add --wait` when the call was not made with `--wait`. A host without `vm_fit_mb` (older server, unmeasured) is not guessed at: only the wait line. A container call refused for `box_room=no` has the reason line `<host>: no memory for another busy box (<box_fit_mb> MB fit, <box_reserve_mb> MB wanted)`, a reason time can change (so `--wait` waits for it), and gets only the wait line: a container has no size to suggest. Exit code and the other lines are unchanged and nothing goes to standard output; the pure function is `roomHint`. It never
  queues.
- **`--wait`** (a client option, off by default; nothing above changes without it) turns that exit into waiting. When no host has room for
  a reason time can change (`<n> of <m> machines`, `no memory for another machine`), or the call is refused at the host for room (the lost race
  with no host left, a placed worktree whose host is full), the client prints once on stderr `box: waiting for room, asking every 30 seconds:`
  and the usual reason lines, then probes and chooses again every 30 seconds (`BOXD_WAIT_MS`, a test hook; the word "30" in the message is
  that interval in seconds) until the call can be placed, and goes on as a normal call (sync, run, pulls, collector). When the reasons
  change it prints one line `box: the reasons changed: <host>: <reason>; ...`, and only then. A worktree this call placed is chosen afresh each
  round; a placed worktree is moved by itself only as "A placed worktree whose host has no room" says, and that is tried first in each round, so the call waits only while it cannot move. The probe is the same one: a sleeping host is never woken to ask, and
  counts as room as before. A refusal waiting cannot fix (no host with the image, none with virtual machines, none reachable) still exits 75 at
  once. **Waiting holds nothing on any host and gives no order among several waiting callers**: whoever asks when room appears gets it, so a
  caller can wait while later ones pass. Like a foreground call it ends when the process that started it is gone (checked after each sleep:
  `box: the process that started this call is gone; no longer waiting`, exit 129; `BOXD_KEEP_ORPHAN=1` turns it off).
- **Lost race.** The status line can be a second old. When `pod run` answers 75 with the refusal text (`boxd-pod: no room for another virtual machine ...` or, for a container call, `boxd-pod: no room for another busy box ...`: the client tests the common start `boxd-pod: no room for another`; it keeps the first
  2 KB of stderr for this; on a terminal ssh merges stderr into stdout, so there is no retry and no hint), nothing ran, so the
  client syncs to the next host with room from the same probe and runs there, once per remaining host, recording each. With no
  host left it prints why and exits 75, and a placement this call made is removed.
- **A placed worktree whose host has no room moves by itself** (owner decision 2026-11-17; before it was refused with the command that
  moves it, because its caches are there, and an idle box need not be stuck on a full host). When the call of a placed worktree is
  refused for room on its own host (the host answers 75 with the refusal text, or with `--wait` the probe says no room for a reason
  time can change), and another registered host has room for this call by the choice above, the client moves the worktree there as
  `--host <name>` would (the placement is recorded, the old box is left as `--host` leaves it, reason `moved` in `choices.log`)
  and prints one line on standard error first: `box: <old> has no room; this worktree moves to <new> (its caches on <old> are kept until that host's time limit)`.
  The call is then synced and run on the new host; a lost race there walks the other hosts with room and, with none left, drops the
  placement, as for a placement the call made. The choice among the other hosts is the normal one (smallest cap for a machine, most
  free memory for a container). Two guards, both checked before moving; with either the old text stays: (1) **nothing that would be
  lost or stranded**: the old host's `pod report` (asked in parallel with the other hosts' status, each time a move is tried) lists no `box` line of this box (a machine or container of it in any
  state) and no `run` line of it (running, or ended: its log and results may not be fetched yet); an old host that cannot be asked
  (the report fails, is empty or has no `host` line: asleep, unreachable, a server older than `pod report`) keeps the worktree.
  (2) **no host was named for this call**: never with `BOXD_HOST` set (it names a host for this call only) and never when the caller
  passed `--host`. Otherwise (a guard trips, or no other host has room) the client exits 75 and prints
  `box: <host> has no room; hosts that do: <names>. Move this worktree with: box --host <name> <the same arguments>`, or the
  reasons when no other host has room, followed by the same two lines (computed from the other hosts' status lines; the own host's figure is not asked again).
  Limit: a run log whose box the host no longer lists (the reaper removed the box, the folder stays) is not in `pod report`, so it
  does not stop a move; the collector's rules for the old folder (the time limit) apply as after `--host`.
- **Evidence.** One line per placement decision (not per call) is appended to `~/.local/state/boxd/choices.log`, tab separated:
  time (ISO), box, request (`vm` or `container`, then the image or `-`), host, reason (`order`: the first host in order; `spread`: a later one with more free memory while the first had room;
  `overflow`: a later one because the first had no room; `fit`: a machine placed by the smallest cap, whichever host that is; `retry`: after a lost race; `moved`: `--host`, or the move by itself above), and each probed host, in order, as `<host>=<state or reason>`
  separated by commas.

### `box image push [--host <name>] [--vm|--container] <ref>`

Not tied to a worktree. `<host>` as for every command; `<ref>` is one word matching `^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$`; engine `container` unless `--vm`
(both flags, no reference, two references, an unknown option or a bad reference: usage error, exit 2, nothing runs).
1. `podman pull <ref>` on the client with the caller's own login (`docker` when `podman` is not installed; neither: exit 2). A failed
   pull exits with its code. The login is never sent: no password option exists, nothing is added to ssh's environment.
2. `<id>` = `<tool> image inspect --format {{.Id}} <ref>` (a leading `sha256:` dropped).
3. `ssh boxd-<host> pod image has <engine> <ref> <id>`: 0 prints `box: <ref> is already on boxd-<host> for <engine>, nothing sent` and exits 0; 1 goes on; any other
   code (125 refused, 255 ssh failed) is the exit code.
4. `<tool> save <ref> | ssh boxd-<host> pod image load <engine> <ref> <id>`: the archive goes from the pipe into ssh, no file on the client.
   Exit code: `save`'s when it failed (and the client says so), else the server's.

## Install (host)

- The packages install files; `boxd-setup` does the machine state, including adding `build` to group `kvm` and
  installing `microsandbox-bin` (0.7.15, checksum checked by the package, `msb` found on `PATH`) when the host has
  `/dev/kvm` and processor virtualization. UNVERIFIED that `msb` finds `libkrunfw` relative to its binary rather than
  under `MSB_HOME/lib`; if not, `boxd-reset all` would delete it.
- The settings file `/etc/boxd/boxd.conf` lists `BOXD_VM_LIMITS="-c 4 -m 8G"` among the defaults, and `BOXD_VM_MAX` (optional count ceiling, commented out: no limit) as a comment.
- Before the first `--vm` call, `msb doctor` passes as `build` on the host (the board's virtualisation
  setting, SVM, AMD's virtualisation extension, is UNVERIFIED).

## Test hooks (both sides)

(`BOXD_WATCH_INTERVAL`: seconds between the server's looks at its parent process; `BOXD_ORPHAN_CHECK_MS`, `BOXD_LOG_POLL_MS`, `BOXD_WAIT_MS` and `BOXD_NOW`: the client's, see above.)

- `BOXD_VIEW_KEYS` (the keys that may only read), `SSH_USER_AUTH` (the file sshd writes), `BOXD_READ_MAX` (largest answer of `pod calls` and
  `pod log`), `BOXD_MEMINFO` (the file read as `/proc/meminfo`), `BOXD_PROC` (the folder read as `/proc` for a box's process and its
  cgroup), `BOXD_CGROOT` (the cgroup root, also used for a container's own cgroup), `BOXD_IDLE_STATE` and `BOXD_KEEPAWAKE_LOCK` (the
  power module's files, read by `pod report`). The dashboard cases use `work_files` (files under `/work` written before the call),
  `files_match` (a file's content against a regular expression) and `cgroup` (files of the fake build cgroup).
- `boxd-pod` reads `BOXD_IMAGES_DIR` (default `/var/lib/boxd/images`) as the folder of image archives; the
  cases name the default and the test rewrites it, like `/work`. The fake podman answers `image exists` and `load` from
  a folder of image names; cases list `images` (present in storage) and `archives` (names with a `.tar` file).
- `boxd-pod` reads `BOXD_WORK` (default `/var/lib/boxd/work`) as the root for `jobs/` and `cache/`, so the contract
  test runs in a scratch folder; podman, msb, rsync, boxd-keepawake and git are found on `PATH` (fakes in tests).
  Inside-box paths (`/job`, `/cache`) and the `-v` and `--mount-dir` sources in the cases are written with `/work`;
  the test sets `BOXD_WORK` to a scratch folder and rewrites `/work` in the case regexes and paths to that folder
  before matching (the fake podman never touches a real work area).
- Cases of the `image` verbs: `stdin` is the call's standard input (an archive here is one line `<ref> <image id>`: the fake `podman load` and
  `msb load` make that image appear with that id, an empty archive keeps the old meaning), `image_ids` and `vm_image_ids` give images with ids
  in the container store and the microsandbox store (the fakes' `image inspect` prints the id). The test checks that no `push.*` file stays in `cache/images`.
  Client cases with `image_args` run `imagePlan` of `client/box.mjs` (`host`, `has`, `load` words, or `exit` 2); `tests/box-client.test.mts` runs
  the whole `box image push` against a fake ssh, podman and docker.
- The fake podman state for a case is `containers`: name to `{image, state}`; `inspect` answers from it, `exec`
  exits with `exec_exit`.
- The fake `msb` comes first on `PATH` with its own log (so `exact` podman cases stay valid) and its own state:
  - `sandboxes`: name to `{image, state}`, state `running`, `stopped` or `crashed` (listed as running, host
    process gone; the fake process check answers from the same state);
  - `vm_images`: references in the microsandbox store; `load` logs `load < <archive path>` (from
    `/proc/$$/fd/0`) and adds `localhost/<name>:latest`;
  - `exec` of the docker start script (first command word `sh`, working folder `/`) exits with `starter_exit`
    (default 0) and never blocks; any other `exec` exits with `exec_exit`;
  - `"msb": false` takes the fake off `PATH` (microsandbox not installed);
  - `ssh_tty` sets `SSH_TTY` for the case.
- `msb_calls` and `msb_calls_absent` are regexes matched against the fake msb's log, with the rules of
  `podman_calls` and `podman_calls_absent`. `exact` holds for each log whose `*_calls` key the case lists.
- `BOXD_POD_CLEAN` (default `/run/boxd-pod.clean`) is the boot marker's path.
- `BOXD_CGROOT` (default `/sys/fs/cgroup`, also read by the `boxd-sshd` service script) is the folder that holds the `boxd`
  cgroup `boxd-pod` reads `memory.stat`, `memory.max` and `memory.current` from, for the memory admission (step 5b) and
  `pod status`; a test hook, never set on a host. The test sets it to a scratch folder in which a case's `cgroup` (file
  name to content, for example `memory.stat` and `memory.max`) is written byte for byte under `boxd/`; without `cgroup`
  the folder does not exist, which is the fallback to the count rule.
- `pod status` cases: the fake `nproc` prints 8 and the fake `df` 37 percent; `load1` is the machine's own, so a case matches
  stdout with `stdout_re` (a regular expression, tabs written as `\t`) instead of `stdout`. A case's `cgroup` (above) gives the memory files. `archives` (above) feed `images`.
- Two more case lists in `contract/cases.json`, run by `tests/contract-client.test.mts` against `choose` and `source` of
  `client/box.mjs`: `choose` (hosts as `{name, state, status}` with the status line exactly as the server prints it, and the
  request `{vm, image}`; the expected `chosen` host and `reason`, or the `refusal` lines) and `source` (`flag`, `env`, `placed`,
  `registered`; the expected `how`, `host`, `record`). The seam is also tested with a status line captured from the real
  `boxd-pod` (`tests/box-client.test.mts`), never typed by hand.
- Rules `tests/contract-pod-test.sh` checks as a script, with blocking fifos and no clocks:
  - reap, time limit 1800, now 2000: a stale virtual machine goes with `msb rm -f` and is named `reaped <box>`;
    a fresh one, one with `.running` held and one with `.lock` held stay;
  - reap without the boot marker: no `msb` call at all, containers still reaped;
  - `boxd-pod clear`: `podman rm -af`, then `msb rm -f` once per `pod-*` sandbox, prints `cleared`, exit 0;
    `pod clear` over ssh gives 125;
  - two simultaneous first `--vm` calls for two boxes with one slot left: exactly one `create`, one exit 75;
  - the settings file's `BOXD_VM_LIMITS="-c 2 -m 1G"` and `BOXD_VM_MAX=1` take effect;
  - the size record `.vm-size` follows creation, a kept size, `--recreate` with and without `--size`, and a refusal
    (none written); `memory.max` reading `max` makes `MemTotal` the cap; `BOXD_VM_MAX` alone is the limit when no
    cgroup files exist;
  - every `msb` call sees `MSB_HOME=$BOXD_WORK/cache/msb` and `HOME`;
  - `pod list` prints the fifth column for containers too (the list rule's expected lines gain `\tcontainer`).
- Every `msb` flag spelling and output format in this file and in the cases (`-w`, `-t`, `-e`, `-c`, `-m`,
  `--mount-dir ...:host-perms=mirror`, `image inspect`, `load`, `inspect`, `ls`) is checked by the builder
  against `msb <command> --help` 0.7.15 first; a different spelling changes this file and the cases together.
- `box` exposes a pure function for the client cases: given toplevel, flags and argv, return the box name
  and the remote command line (or a usage error, exit 2). Its stale-build check is the same as box-wake's.
