---
name: box
description: Run builds, test suites, benchmarks and other heavy compute on a boxd build server instead of this machine. Use when a build or test run would load the owner's machine, when a task needs a tool that is not installed anywhere (any Linux package, inside a podman container), or when the build server's disk is full and its build area needs a reset.
---

# box: build server for heavy compute

`box` runs a command on a headless build server. Every git worktree gets its own box: a podman container with your
files in `/job/src`. A server that sleeps when idle is woken by `box` itself (about 10 s from sleep, 25 s from off).
`box setup <host>` was run once for the server; `box --host <name>` or `BOXD_HOST` picks another one.
With several servers set up, the first call of a worktree picks the one with room that has the most free memory, a busy one (`load1` above its `cpus`) after the calm ones, for a `--vm` machine too (ties: `box hosts`
order; a sleeping one counts as empty; a `--vm` machine goes to the one with the smallest memory cap that has room, so the big server stays free for big machines) and the worktree stays on it; you do nothing. A script that must choose a host itself (for example to force `--host` for an already placed worktree) asks `box hosts --pick` instead of comparing numbers by hand. `box --host <name> ...` moves the worktree to that server (and keeps it there). When the server a
worktree is on has no room, the client moves the worktree to a server that has room by itself and says so in one line (`box: <old> has no room; this worktree moves to <new> ...`), unless the box still holds a machine, a container or a run on the old server, or the call named a server (`--host`, `BOXD_HOST`); then the call exits 75 and prints the exact `box --host <name> ...` command that moves it: run it. A server that cannot be reached ends the call with exit 255 and `box: <name> is unreachable (ssh got no answer); nothing was started`: a `--host` call leaves the placement as it was, and a placed worktree stays on its server (its box may be there) and is told which other servers have room and the `box --host <name> ...` command to run there. A call that starts work in a container box can be refused too, when the build group has too little memory left for another busy box (`boxd-pod: no room for another busy box`, exit 75, `<host>: no memory for another busy box`): add `--wait`, or start fewer builds at once (a second call into a box that is already busy is never refused). When no
server has room the call exits 75 at once with one reason per server; the refusal then lists what fits now (`fits now: --size <size> on <host>`: use that size, with `--recreate` when the box already exists with another one) and `or wait for room: add --wait`; stop a machine you no longer need, or add `--wait`: the call then asks
again every 30 seconds and goes on when room appears, saying `box: room on <host> after waiting <time>; starting` (on a server of 0.4.41 or later `--wait` keeps your place in line: waiting calls are served in the order they first asked, as far as memory allows, and the waiting
line tells your place and what holds the room, for example `2 calls wait ahead of this one (since 18:02, 18:10); busy now: wf_a (since 17:40)`. Do not build your own lock or
queue around `box`; a refusal waiting cannot fix, like a missing image, still exits at once).
A program that reads the refusal sets `BOXD_REFUSAL_JSON=1`: every exit 75 for room then ends its standard error with one line, `box-refusal: ` and a JSON object with `exit`, `waitable` (true: `--wait` can help),
`hosts` (per server: `host`, `state`, `reason`, and `free_mb`, `fit_mb`, `need_mb`, `cap_mb` when known) and `text` (the printed sentence); no need to read numbers out of the sentence.

## Use

- Run `box <command...>` from inside your git worktree. It syncs the worktree, runs the command in your box, prints
  the output, exits with the command's exit code. Same box on every call.
  The last line on stderr of a foreground call is `box: exit <code> on <host>` (the code box exits with, the host it
  ran on), once the command was handed to a host; `--detach`, `--shards` and a call refused before a host was chosen print none.
- Example: `box cargo test -p mycrate`. Gate on the exit code, never on a pipe.
- No shell: the command is an argument list. Pipes, `&&`, redirects, globs: `box sh -c 'make && make test'`.
- Image: `--image rust:1.83` (default debian:stable-slim). Registries: the ones the server allows (docker.io and ghcr.io by default; others are refused, exit 125).
  A box keeps one image; to change it add `--recreate` (files stay). When the host's shared image was rebuilt after the box was made, the first call into the box afterwards prints `boxd-pod: box <box> runs an older copy of localhost/<name> ...` once: a tool missing from the box may be only missing from the old copy, and `--recreate` gives the new one. Install extra tools inside (`apt-get install -y ...`).
- Your own image: put a Containerfile in the worktree and run `box --image-file <path> <command...>` (path relative to the worktree's
  top folder, no `..`; not with `--image`). The server builds it on every call (unchanged builds are fast) and replaces the box by itself
  when the built image changed; files under `/job` stay. A failed build exits 125 with the build output on stderr and the old box stays; a build that changed nothing is silent, a changed image adds one line.
  Later calls without `--image-file` keep the box's image. The allowed-registries list does not apply to `FROM` lines or downloads in the build.
- Image of a private registry: the server holds no registry login. On your own machine, where you are logged in, run
  `box image push [--vm] <ref>` (full reference, an allowed registry), then use `box --image <ref> ...`; nothing is sent when the server already has it.
- Virtual machine: add `--vm` only when the work needs docker or podman inside, its own kernel, root, or runs untrusted
  code, or a sandbox that mounts its own `/proc` (a container box refuses `bwrap --unshare-all --proc /proc` with
  `bwrap: Can't mount proc on /proc: Operation not permitted`, while plain `bwrap --ro-bind / / true` works there, so
  probe with the options the sandbox really takes), and only when the server has virtual machines (otherwise the call is refused with a clear message, exit 125).
  Example: `box --vm --image localhost/toolbox docker run --rm hello-world`. In the toolbox image, tools that load TypeScript as a library find its JavaScript interface, version 6, at /opt/typescript-api/node_modules/typescript (`tsc` itself is version 7, which has no library file). Containers stay the default: lighter and
  they reach the server's own network (a virtual machine reaches the public internet only). A box keeps its engine like its image; to switch
  add `--recreate` (files stay). `/job` and `/cache` hold up to 64 GiB in a machine made by this version; a machine made earlier is limited to 4 GiB there and needs `--recreate`. Pick the smallest size that fits with `--size small|medium|large|xlarge` (2, 4, 8 or 12 GB of memory; 2, 4, 4 or 8 processors; no `--size` means large; take xlarge (8 processors, 12 GB) only when the work needs more than 8 GB, because fewer machines fit beside it; the size is kept, another one needs `--recreate`). A new machine starts when the memory the server really uses plus the machine's size fits, so small machines leave room for others; when it does not fit the call is refused (exit 75, no room). Remove a machine box you no longer need. Repeat `--vm`
  on every call for that box, also when reading a detached log.
- A credential for the command: `box --env NAME <command...>` (repeatable) hands the variable `NAME` from your own environment to
  the command, in both engines, foreground and `--detach`. Only names ending in `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD`. The value
  never appears on a command line, in a synced file or in a log; never put a credential in the command text or in the worktree instead: the server's call log keeps the first 200 characters of every command, so a credential in the command text is written to disk there (the dashboard shows it).
- Unprivileged user: `--user` (container and `--vm` boxes) runs every command as a user that owns the synced files, with
  `HOME=/job/home`; for tools that refuse to run as root. In a machine the account has the number 1000, may use docker, and owns every file under `/job` and `/cache` (shared package caches included) at every call, also files a later sync wrote. A box runs commands as root without it: the first call that makes a box prints one line on stderr (`boxd-pod: new container box <box>: commands run as ...`, or `new machine box`) saying which, so a test failure that only root causes is not taken for a real one. A box keeps it once made with it; adding it to a root box needs `--recreate`. To get what a hosted CI runner gives (an ordinary account, docker, the worktree as a git repository): `box --vm --user --git ...`. An older server refuses `--user` with `--vm` (`--user is not supported for virtual machine boxes yet`); a machine's image without `useradd` is refused too.
- QEMU on KVM inside a box: `--kvm` (container boxes only, not with `--vm`) gives the box the server's `/dev/kvm`. Only when the
  work runs virtual machines itself (an operating system image, a test harness). A box keeps it once made with it; adding it needs `--recreate`.
- The server's NVIDIA graphics card: `--gpu` (container boxes only, not with `--vm`) for CUDA, model inference on the card, headless rendering
  with EGL or Vulkan, or a browser or game that needs a graphics card. The first call goes to a server that has a card (`box hosts` shows `gpus=<n>` per server); none has one: exit 75, `no graphics card`. The driver libraries and `nvidia-smi` come from the host; the CUDA toolkit, Vulkan loader or Mesa utilities must be in the image or installed in the box. Rendering is headless: use Vulkan or the EGL surfaceless (or device) platform; there is no display server, and the GBM, Wayland and X11 platforms fail (`eglinfo` prints their errors first, then the working one). The card and its memory are shared by every `--gpu` box. A box keeps it once made with it; adding it needs `--recreate`.
- Long runs: `--detach`. It prints a run id and returns at once; read the log with `box log <id>` (`--follow` keeps
  reading until the run ended and exits with its code; the log ends with `EXIT <code>`; the printed command already repeats
  `--host` and `--pod`). `box log` reads from the server and never starts a stopped box, unlike `box cat /job/runs/<id>.log`,
  which makes a new empty one. With the power module on, the server stays awake until the run ends.
  A box takes one detached run at a time unless the runs share no files: all runs of a box use `/job/src`, and the server says on stderr when one is already going.
  `--pull` does nothing with `--detach`. **A detached run's results must be under `/job/src`** (files elsewhere, like `/tmp`, go when the idle box
  is removed); fetch them later with `box pull <path>` (add `--to <folder>` to put them under another folder, each keeping its relative path; it runs nothing in the box, so a stopped box or machine stays stopped). `box log <id>` keeps the full output on the server, so a long test
  output need not pass through you: read the end of it (`box log <id> | tail -n 50`) instead of printing it in the call.
- `box runs` lists the detached runs still running on the servers (host, box, run id, age, worktree, last output line, tab separated), so you
  can see your work in flight without lock files of your own. It never wakes a sleeping server (it names it). A run that wrote nothing
  to its standard output or standard error for an hour or more gets one more line on standard error ("has written nothing for 1h02m; it may hang, or it writes elsewhere"):
  check it with `box log --state`, end it with `box stop --run`. A program that writes its progress only to files of its own looks silent:
  launch it with `box --detach --alive <path>` (a file or folder of the worktree, relative, no `..` part); the newest change under that path then counts as output.
  `box runs --follow` blocks until all of the runs running at that moment have ended, printing `host`, `box`, run id and `exit=<code>` for each as it ends
  (`exit=-`: no code known); it exits 0 when every one ended with 0, otherwise 1; runs started later are not followed. Ask `box --version` for the client's version.
  `--pod '<pattern>'` (repeatable; `*` any characters, `?` one, the rest literal, over the whole box name as the box column shows it) keeps only your own boxes' runs, for the list and for the exit code of `--follow`; react to each end with `box runs --follow --pod 'rf-*' | while IFS=$'\t' read -r host box run code; do ...; done` (`code` is `exit=<n>`).
- Several commands side by side from one worktree, in one call: `box --shards <n> -- <command with {shard} and {shards}>` (`<n>` 2 to 32), for example
  `box --shards 5 -- npx vitest --shard={shard}/{shards}`. It makes `<n>` boxes of this worktree (your box name with `-s1` to `-s<n>`), syncs and starts the
  command detached in each one after the other, replaces `{shard}` by the box's number and `{shards}` by `<n>` in every word, then waits for all of them and
  prints one line as each ends (`shard <i>/<n>  <host>  <box>  run <id>  exit=<code>  <seconds> s`), the last 20 lines of the log of each run that did not end with 0
  (`--tail <n>` changes it; 0 for none; with it every shard's tail is printed), stops the boxes (files and caches stay) and exits 0 only when every run ended with 0.
  Each shard is an ordinary box: it is admitted like any box (the room rules apply to each start; `--wait` queues) and it has its own folder, so **its own dependencies
  must be installed there** (a `node_modules` made in your box is not in the others; install inside the command, or use `--image-file`). A command with neither placeholder is refused.
  A start refused for room ends the call with the runs already started left running; the message names `box runs --follow --pod '<base>-s*'` to follow them. Not with `--detach`, `--pull`, `--no-sync`, `--snapshot`.
  `box runs --follow --tail <n>` likewise prints the last lines of each followed run when it ends.
- **Started or not: only the exit code and the `run <id>` line say.** Exit 0 with `run <id>` on standard output: the run started, whatever
  else was printed. Any other exit code: nothing started (`box: sync failed ...; nothing was started`, or a refusal). Never relaunch on a
  message alone; a second launch runs beside the first in the same box. `box: sync complete; ... stays on the server` is a note, not an error.
- **A foreground call ends with the process that started it** (exit 129, the command inside the box is ended too). Work that
  must outlive you (a server, a long build you will read later) needs `--detach`; `BOXD_KEEP_ORPHAN=1` is only for a wrapper
  that exits on purpose.
- When `box drop` says `it needed <n> MB of its <m> MB at most`, that is the most memory the machine really used inside (file cache not counted); a smaller size, named in the line, would have held it, and a smaller size leaves room for other machines. A new machine for a box with no `--size` takes its size from that need by itself.
- To free a box's memory between runs while the worktree lives on, run `box stop`: the box stops and its files stay (build outputs included), so the next call makes it again on the same files. Use `box drop` only when the worktree is going away: it removes the files too, and the next call starts from a cold build.
- After you delete a worktree yourself, run `box drop` first, from inside it: the box is found from the worktree. It removes the box, its files on the server and its record at once, refuses while the box is busy (a call or a detached run; the image's own daemons do not count), and does not wake a sleeping server (the collector then does it later).
- `box gc` (`--dry-run` to only look) removes the boxes and server files of worktrees that were deleted (found missing by two passes 15 minutes
  apart; a box with a run still going is kept until it ends), lists boxes nobody here owns and reports commands running over 6 hours; it also runs by itself after ordinary calls
  (`BOXD_GC=0` turns that off). You never need to stop a box by hand.
- A call that prints nothing for 15 minutes gets the `box ps` table on stderr by itself, every line prefixed
  `[box ps] `, repeated while the silence lasts; stdout and the exit code are untouched. `--ps-after 5` (or
  `BOXD_PS_AFTER=5`) reports sooner; `--ps-after 0` turns it off when you parse stderr strictly (or filter
  `grep -v '^\[box ps\] '`).
- A server inside the box that only listens on `127.0.0.1` (a VM desktop's x11vnc on 5900, a noVNC page on 6080, a dev server):
  `box forward <local-port> <box-port>` (local port 0 picks a free one; it prints it) listens on `127.0.0.1` here and runs until Ctrl+C or until the process that started it is gone; each
  connection is one ssh channel that holds the box busy while it is open. `box vnc` does it for port 5900 and opens `vnc://`. Container
  boxes only, the box must be running (a forward never starts one); needs a build server 0.4.0 or newer.
- A server in a box that should not hold the build server awake (a model server on the graphics card, a dev server): start it with
  `box serve <local-port> <box-port> --idle <seconds> -- <box arguments>`, where `<box arguments>` is what you would write after `box` to run it in the
  foreground (for example `--gpu --no-sync llama-server --port 8080`). It listens on `127.0.0.1` here, starts the server on the first connection, and the host stops it once
  no connection has been open for the idle time (default 300 seconds); the first connection after a stop waits for the start (up to `--start-wait`, default 180 seconds).
  Keep the data the server needs under /job outside /job/src (the model files, caches), so a start does not fetch them again; run one `box serve` process per server and keep it
  running on your machine (it ends when the process that started it is gone, like `box forward`, unless `BOXD_KEEP_ORPHAN=1`).
- A command seems stuck (no output for a long while, tests that never finish): `box ps` lists the processes running in
  your box, oldest first, with age, processor time, working folder and command. It changes nothing; stop what is
  hung yourself (`box sh -c 'kill <pid>'`). A process with no processor time that is hours old is waiting on something.
- "no box <name>" for a box you expect to exist: `box list` prints every box this machine recorded, with its host and the worktree that owns it, and asks no server. The box you mean may have another name (started with `--pod <name>`, or made from another worktree).
- Results: `--pull <path>` copies a file or folder from the box back into your worktree after the run. Repeat for more.
- Tests that need a git repository: `--snapshot`. A synced tree has no git data otherwise (`.git` is not sent): a build that embeds
  `git describe` says `unknown`; pass `--snapshot` when the build needs it (it makes a new commit named snapshot).
- Tools that need the worktree's real commit (`git rev-parse HEAD`, git status): `--git` makes `/job/src` a repository at the same commit hash, one commit, detached; uncommitted work shows as changes. It stays until the next `--git` call. Not with `--snapshot` or `--no-sync`. Files under `.git` keep their times between calls on the same commit, so build scripts that watch `.git/HEAD` do not rerun.
- When a test reads tags or history (`git describe`, `git tag`, `git log` over several commits), add `--history` to `--git` or `--commit`: the repository then holds every commit and the tags inside it (the commits' author names and mail addresses travel too).
- Before a release, or to reproduce a hosted run: `--commit HEAD` (or another commit) makes `/job/src` exactly what a fresh clone at that commit holds, with no uncommitted or untracked files and no old build outputs; use `--git` for everyday work on uncommitted changes. Mixing the two in one box alternates the source.
- With `--git`, a file that is new and not yet committed exists in the box but is untracked there: `git status` shows it, `git ls-files` does not. A test that reads the list of tracked files will not see it and can pass in the box and fail after the commit: commit first, or check `git status --short` in the box.
- The clock inside a box is coordinated universal time (UTC); the servers' own clocks and the times `box` prints (run ids, `box runs`) are local time.
- Memory and out-of-memory kills inside a virtual machine box: `box --no-sync -- sh -c 'free -m; dmesg | grep "Out of memory"'` (after a detached run: `guest_kills` in `box log <run> --events`)
  (a count above 0 means the kernel in the box ended a process for lack of memory).
- Options go before the command: `box --no-sync sh -c '...' --pull x` hands `--pull x` to the command (box warns once); write `--` before
  the command to say it is meant.
- The words `setup`, `runs`, `hosts`, `list`, `image`, `ps`, `log`, `forward`, `vnc`, `drop`, `stop` and `gc` must come FIRST: right is `box drop --host tower`, wrong is `box --host tower drop`. An option before one of them is refused at once (exit 2, one line on stderr, nothing contacted), because it would otherwise be run as a command in the box. To run a program of that name in the box, write `--`: `box --host tower -- drop`.
- **The sync sends only what git counts as the worktree.** A file git ignores (a `*.log` journal, a state folder) does not reach the box
  unless named: `--include <path>` (file or folder, repeatable). The other way round, ignored files a run made in the box stay there
  between calls; `--clean` deletes them first, so the box's source folder is exactly your worktree (use it for measurements).
- `box log <id> --state` answers "is it still running" in one line (`<id>`, `state=running|ended`, `exit=<code>`, and for an ended run `ended=<UTC time>` and `seconds=<wall seconds>`; for a running run `age=<seconds since it started>` and `quiet=<seconds since the run last printed to standard output or standard error; files it writes do not count>`), without reading the log.
- `box log <id> --follow` ends standard error with `box: run <id> exit <code> on <host>` once the run has ended, so a wrapper that loses the exit code still shows it.
- `box log <id> --follow --quiet-limit <seconds>` stops waiting when the run has written nothing for that long (`quiet` as `--state` shows it): it says so on standard error and exits 4, and the run keeps running (a run's own exit code 4 comes with `box: run <id> exit 4` instead). Use it in place of a loop over `--state`.
- With `BOXD_PHASES=1` in the environment a call that runs a command ends its standard error with `box: phases room=<s> sync=<s> run=<s> on <host>` (whole seconds: waiting for room, file sync, command on the server), so a log tells server wait from work; not with `--shards`.
- `box log <id> --follow --tail 20` answers "how did it end" for a run that has ended (its last 20 lines), and exits with the run's code.
- `box log <id> --events` after a detached run ended (a paid measurement): the host's own record of what could have disturbed it, one `key=value` per line: memory stall milliseconds and
  kills for memory (of all boxes, and of this box when it is a container), network card stalls, other boxes busy meanwhile (`others`), other detached runs of the same box (`siblings`), and the run's own box limits: processes the machine's own kernel killed for memory (`guest_kills`, a machine box; `-` after a restart of the machine) and how full `/job` was at the end (`job_disk_pct`, `disk_full=yes` from 99 percent). Void the run by a rule fixed beforehand. Exit 0: the record covers the whole
  run. Exit 3: it does not (`why` on standard error and in the lines: still running, older server, host restarted, a counter unreadable); never read exit 3 as "nothing happened". Not given: the name of a killed process.
- `box stop --run <id>` ends that one detached run (a mistaken or hanging one, which holds its room meanwhile) and nothing else: the box keeps running with its files and its other runs. A run that already ended: nothing to do, exit 0. `box stop` and `box drop` refuse a box with a command running and name the run to end.
- `box log <id> --follow` exits 129 when the run ended without an exit code: its box or the server went down under it (reboot, power loss,
  box removed). Nothing restarts such a run. A server never sleeps while a detached run or a call is going.
- `--no-sync` skips the sync; `--pod <name>` shares one box between worktrees (the worktree that made it owns it while it exists); `box --help` lists everything.
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
- The box points the language tools at those shared caches through the environment (`CARGO_HOME`, `GOPATH`, `GOMODCACHE`, `GOCACHE`, `npm_config_cache`, `PIP_CACHE_DIR`, `MAVEN_OPTS`). A test that brings its own cache (its own Go module cache, for example) is overruled by them and can fail in a way that looks unrelated: unset the variable for that test run (`env -u GOMODCACHE -u GOPATH <command>`).
- `/cache` keeps what a tool downloaded, not what it installed into the box with the system package manager: a tool found there (a Playwright browser under `/cache/xdg/ms-playwright`) may still need its system libraries in each new box (`playwright install-deps chromium`). "Present in `/cache`" is not "runs in this box".
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
