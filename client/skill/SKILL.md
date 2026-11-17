---
name: box
description: Run builds, test suites, benchmarks and other heavy compute on a boxd build server instead of this machine. Use when a build or test run would load the owner's machine, when a task needs a tool that is not installed anywhere (any Linux package, inside a podman container), or when the build server's disk is full and its build area needs a reset.
---

# box: build server for heavy compute

`box` runs a command on a headless build server. Every git worktree gets its own box: a podman container with your
files in `/job/src`. A server that sleeps when idle is woken by `box` itself (about 10 s from sleep, 25 s from off).
`box setup <host>` was run once for the server; `box --host <name>` or `BOXD_HOST` picks another one.
With several servers set up, the first call of a worktree picks the one with room that has the most free memory (ties: `box hosts`
order; a sleeping one counts as empty) and the worktree stays on it; you do nothing. `box --host <name> ...` moves the worktree to that server (and keeps it there). When the server a
worktree is on has no room, the call exits 75 and prints the exact `box --host <name> ...` command that moves it: run it. When no
server has room the call exits 75 at once with one reason per server; stop a machine you no longer need, or add `--wait`: the call then asks
again every 30 seconds and goes on when room appears (it holds nothing meanwhile and gives no order among several waiting callers; a refusal
waiting cannot fix, like a missing image, still exits at once).

## Use

- Run `box <command...>` from inside your git worktree. It syncs the worktree, runs the command in your box, prints
  the output, exits with the command's exit code. Same box on every call.
- Example: `box cargo test -p mycrate`. Gate on the exit code, never on a pipe.
- No shell: the command is an argument list. Pipes, `&&`, redirects, globs: `box sh -c 'make && make test'`.
- Image: `--image rust:1.83` (default debian:stable-slim). Registries: the ones the server allows (docker.io and ghcr.io by default; others are refused, exit 125).
  A box keeps one image; to change it add `--recreate` (files stay). Install extra tools inside (`apt-get install -y ...`).
- Your own image: put a Containerfile in the worktree and run `box --image-file <path> <command...>` (path relative to the worktree's
  top folder, no `..`; not with `--image`). The server builds it on every call (unchanged builds are fast) and replaces the box by itself
  when the built image changed; files under `/job` stay. A failed build exits 125 with the build output on stderr and the old box stays.
  Later calls without `--image-file` keep the box's image. The allowed-registries list does not apply to `FROM` lines or downloads in the build.
- Image of a private registry: the server holds no registry login. On your own machine, where you are logged in, run
  `box image push [--vm] <ref>` (full reference, an allowed registry), then use `box --image <ref> ...`; nothing is sent when the server already has it.
- Virtual machine: add `--vm` only when the work needs docker or podman inside, its own kernel, root, or runs untrusted
  code, and only when the server has virtual machines (otherwise the call is refused with a clear message, exit 125).
  Example: `box --vm --image localhost/toolbox docker run --rm hello-world`. Containers stay the default: lighter and
  they reach the server's own network (a virtual machine reaches the public internet only). A box keeps its engine like its image; to switch
  add `--recreate` (files stay). Pick the smallest size that fits with `--size small|medium|large|xlarge` (2, 4, 8 or 12 GB of memory; 2, 4, 4 or 8 processors; no `--size` means large; take xlarge (8 processors, 12 GB) only when the work needs more than 8 GB, because fewer machines fit beside it; the size is kept, another one needs `--recreate`). A new machine starts when the memory the server really uses plus the machine's size fits, so small machines leave room for others; when it does not fit the call is refused (exit 75, no room). Remove a machine box you no longer need. Repeat `--vm`
  on every call for that box, also when reading a detached log.
- A credential for the command: `box --env NAME <command...>` (repeatable) hands the variable `NAME` from your own environment to
  the command, in both engines, foreground and `--detach`. Only names ending in `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD`. The value
  never appears on a command line, in a synced file or in a log; never put a credential in the command text or in the worktree instead: the server's call log keeps the first 200 characters of every command, so a credential in the command text is written to disk there (the dashboard shows it).
- Unprivileged user: `--user` (container boxes only, not with `--vm`) runs every command as a user that owns the synced files, with
  `HOME=/job/home`; for tools that refuse to run as root. A box keeps it once made with it; adding it to a root box needs `--recreate`.
- QEMU on KVM inside a box: `--kvm` (container boxes only, not with `--vm`) gives the box the server's `/dev/kvm`. Only when the
  work runs virtual machines itself (an operating system image, a test harness). A box keeps it once made with it; adding it needs `--recreate`.
- Long runs: `--detach`. It prints a run id and returns at once; read the log with `box log <id>` (`--follow` keeps
  reading until the run ended and exits with its code; the log ends with `EXIT <code>`; the printed command already repeats
  `--host` and `--pod`). `box log` reads from the server and never starts a stopped box, unlike `box cat /job/runs/<id>.log`,
  which makes a new empty one. With the power module on, the server stays awake until the run ends.
  `--pull` does nothing with `--detach`. **A detached run's results must be under `/job/src`** (files elsewhere, like `/tmp`, go when the idle box
  is removed); fetch them later with `box --no-sync --pull <path> true`. `box log <id>` keeps the full output on the server, so a long test
  output need not pass through you: read the end of it (`box log <id> | tail -n 50`) instead of printing it in the call.
- `box runs` lists the detached runs still running on the servers (host, box, run id, age, worktree, last output line, tab separated), so you
  can see your work in flight without lock files of your own. It never wakes a sleeping server (it names it).
  `box runs --follow` blocks until all of the runs running at that moment have ended, printing `host`, `box`, run id and `exit=<code>` for each as it ends
  (`exit=-`: no code known); it exits 0 when every one ended with 0, otherwise 1; runs started later are not followed. Ask `box --version` for the client's version.
  `--pod '<pattern>'` (repeatable; `*` any characters, `?` one, the rest literal, over the whole box name as the box column shows it) keeps only your own boxes' runs, for the list and for the exit code of `--follow`; react to each end with `box runs --follow --pod 'rf-*' | while IFS=$'\t' read -r host box run code; do ...; done` (`code` is `exit=<n>`).
- **Started or not: only the exit code and the `run <id>` line say.** Exit 0 with `run <id>` on standard output: the run started, whatever
  else was printed. Any other exit code: nothing started (`box: sync failed ...; nothing was started`, or a refusal). Never relaunch on a
  message alone; a second launch runs beside the first in the same box. `box: sync complete; ... stays on the server` is a note, not an error.
- **A foreground call ends with the process that started it** (exit 129, the command inside the box is ended too). Work that
  must outlive you (a server, a long build you will read later) needs `--detach`; `BOXD_KEEP_ORPHAN=1` is only for a wrapper
  that exits on purpose.
- After you delete a worktree yourself, run `box drop` first, from inside it: the box is found from the worktree. It removes the box, its files on the server and its record at once, refuses while a command still runs in the box, and does not wake a sleeping server (the collector then does it later).
- `box gc` (`--dry-run` to only look) removes the boxes and server files of worktrees that were deleted (found missing by two passes 15 minutes
  apart), lists boxes nobody here owns and reports commands running over 6 hours; it also runs by itself after ordinary calls
  (`BOXD_GC=0` turns that off). You never need to stop a box by hand.
- A call that prints nothing for 15 minutes gets the `box ps` table on stderr by itself, every line prefixed
  `[box ps] `, repeated while the silence lasts; stdout and the exit code are untouched. `--ps-after 5` (or
  `BOXD_PS_AFTER=5`) reports sooner; `--ps-after 0` turns it off when you parse stderr strictly (or filter
  `grep -v '^\[box ps\] '`).
- A server inside the box that only listens on `127.0.0.1` (a VM desktop's x11vnc on 5900, a noVNC page on 6080, a dev server):
  `box forward <local-port> <box-port>` (local port 0 picks a free one; it prints it) listens on `127.0.0.1` here and runs until Ctrl+C or until the process that started it is gone; each
  connection is one ssh channel that holds the box busy while it is open. `box vnc` does it for port 5900 and opens `vnc://`. Container
  boxes only, the box must be running (a forward never starts one); needs a build server 0.4.0 or newer.
- A command seems stuck (no output for a long while, tests that never finish): `box ps` lists the processes running in
  your box, oldest first, with age, processor time, working folder and command. It changes nothing; stop what is
  hung yourself (`box sh -c 'kill <pid>'`). A process with no processor time that is hours old is waiting on something.
- Results: `--pull <path>` copies a file or folder from the box back into your worktree after the run. Repeat for more.
- Tests that need a git repository: `--snapshot`. A synced tree has no git data otherwise (`.git` is not sent): a build that embeds
  `git describe` says `unknown`; pass `--snapshot` when the build needs it.
- The clock inside a box is coordinated universal time (UTC); the servers' own clocks and the times `box` prints (run ids, `box runs`) are local time.
- Memory and out-of-memory kills inside a virtual machine box: `box --no-sync -- sh -c 'free -m; grep oom_kill /proc/vmstat'`
  (a count above 0 means the kernel in the box ended a process for lack of memory).
- Options go before the command: `box --no-sync sh -c '...' --pull x` hands `--pull x` to the command (box warns once); write `--` before
  the command to say it is meant.
- **The sync sends only what git counts as the worktree.** A file git ignores (a `*.log` journal, a state folder) does not reach the box
  unless named: `--include <path>` (file or folder, repeatable). The other way round, ignored files a run made in the box stay there
  between calls; `--clean` deletes them first, so the box's source folder is exactly your worktree (use it for measurements).
- `box log <id> --state` answers "is it still running" in one line (`<id>`, `state=running|ended`, `exit=<code>`, and for an ended run `ended=<UTC time>` and `seconds=<wall seconds>`), without reading the log.
- `box log <id> --follow --tail 20` answers "how did it end" for a run that has ended (its last 20 lines), and exits with the run's code.
- `box log <id> --follow` exits 129 when the run ended without an exit code: its box or the server went down under it (reboot, power loss,
  box removed). Nothing restarts such a run. A server never sleeps while a detached run or a call is going.
- `--no-sync` skips the sync; `--pod <name>` shares one box between worktrees; `box --help` lists everything.
- Boxes vanish after 30 idle minutes (a detached run keeps its box). `/job/src` and your build outputs stay; the next call recreates the box.
- **`/job` is not an archive: the server removes whole box folders by itself.** When the worktree was deleted, after 14 days without a call, or
  least recently used first when the server's disk is 70 % full. Pull what must last (`--pull`). Under that disk pressure unused images go too: after it, `box image push` again. The first call after a removal says
  `boxd-pod: the folder of this box was removed on <date> (<reason>); it starts empty`. Files inside a box in use are never touched: keeping
  a project's own caches small (old virtual disks, old runs) is the project's job.
- Caches live under `/cache` (cargo, go, npm, pnpm, pip, Maven, Gradle), shared by all boxes of the server: a package is downloaded once per
  server, not once per box. That matters beyond speed: all machines here leave through one public address and package sources limit
  requests per address (Maven Central answered 429 for a day in November 2026). A build inside a nested container does not inherit this:
  mount `/cache` into it and pass the same settings (`-v /cache:/cache -e MAVEN_ARGS=-Dmaven.repo.local=/cache/m2`, `GRADLE_USER_HOME=/cache/gradle`,
  `npm_config_cache=/cache/npm`). A 429 or "too many requests" from a package source is the address being limited, not a broken build.
  Where the server names a Maven mirror (`echo $MAVEN_ARGS` shows `-s /cache/maven-settings.xml`), Java packages come from the caching
  repository on your own network; pass the same `MAVEN_ARGS` into nested containers. "No route to host" for that address means the
  repository's server is off, not that the build is broken. Build outputs in your worktree folder (ignored files) survive syncs.
- The box can write only under `/job` and `/cache`. Never ssh to the server for builds; never build as the build account.

## Disk full: reset

The whole build area is replaced by a clean copy in seconds (btrfs subvolume swap). It needs an administrator account
on the server; ask the owner which one and how it signs in, then run on the server:

```sh
sudo boxd-reset        # build area, caches kept
sudo boxd-reset all    # also caches
```

`boxd-reset` refuses (exit 1) while a build-account process runs: another session may be building. Do not add
`--force` unless the owner said so. With the power module on, the server also resets the build area by itself
before sleeping when the disk is 85 % full.

Source and design: the boxd repository (README).
