# Changelog

## 0.4.54

- A foreground `box` call ends standard error with `box: exit <code> on <host>` once its command was handed to a build server (also when that server refused): the code `box` exits with and the host it ran on, so a wrapper that loses the exit code still shows it in its log. Not printed with `--detach` or `--shards`, by the other subcommands, or by a call that ended before a host was chosen. Standard output is unchanged.

## 0.4.53

- A run's event record (`box log <run> --events`) has three more words. `guest_kills`: processes the kernel INSIDE a machine box killed for lack of memory during the run (counted from the guest's kernel log; a dash for a container box, whose `box_kills` says it). `job_disk_pct`: how full the file system behind `/job` was when the run ended. `disk_full`: `yes` from 99 percent. A run killed by its own machine's limits was invisible to the host before.

## 0.4.52

- A machine size that can never fit a host is refused for good: `boxd-pod: a machine of size xlarge (12288 MB) never fits this host: its cap is 11410 MB; use a smaller --size here or another host`, exit 125, from `pod run` and from `pod queue`. Before, the answer was `no room ... yet` (exit 75) and a call with `--wait` waited for ever.
- The client skips a host whose cap is below the asked size when another host fits, and a `--wait` ends with the server's line when every server asked says the size never fits.

## 0.4.51

- A new machine box says what its size gives on this host: `boxd-pod: machine box <box>: size large on this host is 4096 MB of memory and 4 processors (--size small, medium, large or xlarge at creation)`. The size `large` is each host's own default, so the same call got 8 GB on one host and 4 GB on another without a word.
- A shared image that the disk pressure pass removed and a call had to load again says so in one line: `boxd-pod: image <ref> was no longer in this host's store; loaded again from its archive`.

## 0.4.50

- The client's collector no longer removes a box while a run or a call is going in it. It sends `pod drop <box> idle` to a server from 0.4.50; the server keeps a busy box (exit 75) and the collector says `kept until it ends` and asks again at its next pass. Before, the removal was forced: on 2026-11-19 a box with a detached run was removed because a worktree had been deleted. `box drop` (an explicit order) still removes at once.
- A box named with `--pod` stays with the worktree that made it for as long as that worktree exists. Before, the last caller became the owner, so a look into the box from another worktree, followed by deleting that worktree, removed the box.
- A build from `--image-file` loads a `FROM localhost/<name>` base image from its archive when the store no longer has it (the disk pressure pass removes unused images). Before, the build failed with `unable to copy from source docker://localhost/...`.

## 0.4.49

- Fixes a fault of 0.4.48 that removed live files from the shared package caches (`/cache` of the boxes). The daily pass of 0.4.48 judged a file by its modification time, and package tools keep the upstream's old times on files they unpack, so files written an hour before were removed: the content of unpacked cargo sources (their markers stayed, so builds failed with `failed to find <crate> in path source`) and parts of the Maven, npm, pnpm and Go caches. If a host ran 0.4.48: remove the folders under `cache/pod/cargo/registry/src` in its work area once, so cargo unpacks them again.
- The daily pass no longer touches the package caches. They are cleaned only under disk pressure, as before 0.4.48, and now by the time a file was written on the host, so an unpacked package goes whole. The daily pass keeps the image archives of boxes that no longer exist and the unused images.

## 0.4.48

- The shared caches and unused images are cleaned by age, once a day, without waiting for the disk to fill. Until now they went only under disk pressure, and some never. What goes when it is older than `BOXD_KEEP_DAYS`: files of the shared package caches (`/cache` of the boxes), saved image archives of boxes that no longer exist, and images that no box uses. What stays: the host's own shared images (those with an archive in `BOXD_IMAGES_DIR`), the built image of a box whose folder exists, and any image that an existing box folder names, so a stopped box does not pull its image again.
- Each kind that removed something writes one line to the removal log, as box removals do.

## 0.4.47

- A detached run started in a box that already has a detached run going says so: `boxd-pod: run <id> is still going in this box; both use the same /job/src`. The run starts as before. Two runs in one box share its source folder, and nothing told the caller.
- The build of a box's own image (`--image-file`) is quiet. Until now every call printed the whole build output on standard error, also when nothing had changed. Now: nothing when the image is unchanged; one line `boxd-pod: built the box's image from <image file> (<n> s)` when it is new or changed; the build's output only when the build fails; and `boxd-pod: building the box's image, <n> s so far` every 20 seconds while a long build runs.

## 0.4.46

- In a machine box `/job` and `/cache` could hold only 4 GiB: the machine engine gives a mounted host folder that quota when none is named, and boxd named none. A run that wrote more ended with "No space left on device". The quota is now set: 64 GiB each by default, new settings `BOXD_VM_JOB_DISK` and `BOXD_VM_CACHE_DISK`. Container boxes were never limited.
- A machine made by an older server keeps its 4 GiB until it is made again. A call into such a machine says so once: `boxd-pod: machine box <box> was made with a 4 GiB limit on /job and /cache (an older server); --recreate gives it 64G and 64G (files stay)`.

## 0.4.45

- `boxd-setup` on btrfs puts the image archive folder (`BOXD_IMAGES_DIR`, default `/var/lib/boxd/images`) into a subvolume of its own, `@boxd-images`, mounted by a line in `/etc/fstab`. Until now it sat inside the system's file system, so every snapshot of the system kept an old copy of the archives (about 4 GB per image rebuild). A folder that exists is moved without copying data and with its sizes and times kept, so no image is loaded again; a rerun changes nothing; it is skipped while an image build runs. `boxd-reset` leaves the subvolume alone.

## 0.4.44

- A host whose work area shares its disk with the system no longer starts with cleanup levels meant for a disk of its own. `boxd-setup` now writes `BOXD_EVICT_AT` (the disk's fill plus 20 points, at most 70), `BOXD_EVICT_TO` (10 below) and `BOXD_KEEP_DAYS=3` into the settings file on such a disk, when none of them is set, and prints what that means in GB. On a laptop with one 954 GiB disk the defaults (70 and 60 percent, 14 days) had let build data grow to hundreds of GB before anything was removed.
- `pod report`: the host line gains `work_own` (the work area is a file system of its own: `yes`, `no`, or `folder` on a host without btrfs), `work_shared` (it sits on the same disk as the system) and the levels in force, `evict_at`, `evict_to`, `keep_days`.
- `tools/host-watch` warns when a work area is not a file system of its own (the system's snapshots then keep build data) and when a shared disk still has a cleanup level of 60 percent or more.

## 0.4.43

- A run ended with `box stop --run` always says so in its log: the line `boxd: ended by box stop --run` is written before the run is ended. In 0.4.42 it was missing whenever the run's own wrapper wrote the ending first, which on a real host was every time (exit 143 from a container box, 255 from a machine box).

## 0.4.42

- `box stop --run <run id>` ends one detached run and nothing else (server word `pod end <box> <run>`): the processes of that run inside the box, then its wrapper; the box, its files and its other runs stay. The log ends with `boxd: ended by box stop --run` and `EXIT 143`. Until now a detached run could only be waited out, because `box stop` and `box drop` refuse a box with a running command; that refusal now names the run: `…; end a detached run with: box stop --run <id>`.
- The event record of a detached run gains `siblings=<run ids>`: the other detached runs of the same box whose window overlaps, a dash for none.
- A detached run now carries its own call marker (`BOXD_CALL=run-<id>`), as foreground calls do.

## 0.4.41

- Calls that wait for room are served in turn. Until now `box --wait` asked again every 30 seconds and held no place, so a call that arrived late could be served before one that had waited for an hour. Now a waiting call holds a ticket on the server (`cache/queue`, new server word `pod queue`), and nobody takes room that an earlier waiter could take at its next ask. A waiter whose need does not fit anyway holds nobody back, and a call into a box that is already busy is never held back.
- The refusal tells a waiting call its place and what holds the room: `2 calls wait ahead of this one (since 01:16, 01:33); busy now: x (since 23:13)`.
- `pod status` and the host line of `pod report` gain `waiting=<number of waiting calls>`. New setting `BOXD_QUEUE_LIVE` (seconds a ticket lives without a new ask, default 120).
- The client sends the new words only to a server of this version or later; with an older server `--wait` works as before.

## 0.4.40

- The event record of a detached run (0.4.39) was never written on a real host: its folder was to be made at the top of the work area, which belongs to root, not to the build account. The records now go to `cache/events/<box>` in the work area, which the build account owns and no box sees. With 0.4.39 every record read `complete=no`, `why=no-start-record`, never a false "nothing happened".

## 0.4.39

- The event record of a detached run. A run started with `--detach` now leaves on the server, outside every folder the box can write, the host's counters at its start and at its end. `box log <run> --events` (server word `pod events <box> <run>`) prints what happened in between, one `key=value` per line: the window (`start`, `end`, `seconds`), memory stall time of all boxes and of the box itself, kills for memory split by whose limit called the killer (`kills`, `kills_by_cap`, `box_kills`, `box_limit_kills`), transmit timeouts and link changes of the host's network card, and the other boxes that were busy in the window (`others`).
- A record that does not cover the whole window never reads as "nothing happened": `complete=no` with the reason in `why` (`running`, `no-start-record`, `no-end-record`, `host-restarted`, `counter-unreadable`, `calls-log-short`), and `box log --events` exits 3.
- Limits, stated in the contract: a machine box has no memory group of its own, so its box words are dashes and only the figures of all boxes together apply; no name of a killed process, no times of network stalls, nothing about kills made inside a machine by its own kernel.
- The record is removed with its box.

## 0.4.38

- `pod report`: the host line gains four counters that only grow, so two reports say what happened in between: `pressure_some_ms` and `pressure_full_ms` (milliseconds in which memory stalled some, or all, processes of the boxes) and `net_tx_timeouts` and `net_link_changes` (transmit timeouts and link changes of the network card of the default route). A dash when a value cannot be read.
- `tools/host-watch`: every progress line shows `stall_ms` (the increase of `pressure_full_ms` since the previous sample), `tx_timeouts` and `link_changes`, and a finding is logged when the transmit timeouts rise: `<host>: the network card stalled while sending (transmit timeouts <new>, were <old>)`. It works unchanged against an older server.
- Agent guide: a sandbox that mounts its own `/proc` needs a machine box; a container box refuses it.

## 0.4.37

- **A box that runs an older copy of the shared image says so, once.** A box keeps the image it was made from; a
  rebuilt `localhost/` image reaches it with `--recreate`, or when the idle rule has removed the box and the next
  call makes it again. Nothing told the user which of the two a kept box had: a user could not tell whether a tool
  added to the image was missing from the image or only from the old box. A call into an existing box that was made
  from an older copy now prints one line on standard error,
  `boxd-pod: box <box> runs an older copy of localhost/<name> (the image was rebuilt since the box was made); --recreate gives it the new one`,
  once per box and per rebuild. A container box is judged by the image it was made from against the image the name
  has now; a machine box by the archive it was made from (recorded from this release on; an older machine says
  nothing). Never for an image built from the worktree's own file or pulled from a registry.

## 0.4.36

- **The files of the repository in the box keep their times between calls on the same commit.** With `--git` or
  `--commit` the client builds the box's small repository new at every call, and every file under `/job/src/.git`
  got the time of that call. A build script that watches `.git/HEAD` or `.git/index` (the usual way to embed a
  version) therefore ran again at every call on an unchanged worktree, and what depends on it was rebuilt. Everything
  under `.git` now carries the committer time of the commit that is sent, so a second call on the same commit changes
  nothing there; a new commit, or a tag added or removed with `--history`, changes what really differs. git in the box
  answers as before (`git status`, `git diff`). Found by a user whose Rust build recompiled one crate at every run.

## 0.4.35

- **An option before one of box's own words is refused instead of run.** The words of `box` (`drop`, `stop`, `ps`,
  `log`, `runs`, `hosts`, `forward`, `vnc`, `gc`, `image`, `setup`) must come first. With an option before the
  word, as in `box --host tower drop`, the word was taken as the command to run in the box: the box was made or
  started, `drop` was not found inside (exit 127) and nothing was dropped. A clean-up line of that form, with its
  output thrown away, left every box of a user to the idle rule for two days. Such a call now exits 2 with one line
  that names the right form (`box drop --host tower`), before anything is contacted. A program that really has such
  a name runs with `--` before it: `box --host tower -- drop`.

## 0.4.34

- **A call for a container box removes idle machines before it is refused for room.** A machine counts its full size
  while it exists. When a machine was asked for and there was no room, idle machines (no run or call, unused for
  `BOXD_VM_IDLE_MIN` seconds) already went, the longest unused first, their files kept. A call for a container box did
  not do that: on a host that held one busy machine and one whose run had ended, a small container box was refused
  (`no room for another busy box`). It now removes idle machines the same way, and none when all of them together
  would not make the call fit. `pod status` answers `box_room` by the same rule.
- When a machine without a run is still too young to count as idle, that refusal ends
  `, or stop a machine that has no run (box stop)`. Otherwise its text is unchanged.

## 0.4.33

- **A machine box made after an image rebuild gets the rebuilt image.** `images-build` builds the shared image into
  the store that container boxes use and writes its archive, but the machine engine has its own store, and the server
  loaded the archive into it only when the tag was missing there. So machine boxes kept the copy that was loaded first,
  for good: on a host a fresh machine still ran an image from days before, without tools the image had long had, while
  a fresh container box had them (a user's suite skipped 67 tests in a machine against 39 elsewhere). The server now
  records which archive (size and time) the machine store was loaded from, in `cache/loaded-vm-<checksum>`, and when
  a machine is created from a local image whose archive differs from the record, or there is no record, it loads the
  archive first. One lock keeps two creations from loading at once. A machine that exists keeps its image until
  `--recreate`. `pod report` shows the record as `vm_loaded=` on the image line.

## 0.4.32

- **`--history`: the repository in the box carries the full history and the tags.** With `--git --history` or
  `--commit <rev> --history` the box gets every commit reachable from that commit and exactly the tags that point into
  that history (annotated and lightweight), still detached, with no branches, no remote, no hooks and no reflog. The
  repository is built new at each call, so a tag deleted or moved in the source is gone or moved in the box at the next
  call. The history carries the authors' names and mail addresses of its commits. Without the option nothing changes:
  one commit, no tags. Asked for by a user whose hosted jobs check out the full history and whose tests read tags.
- **`box runs` takes `--host <name>`**: only the runs on that host are listed and followed; the other hosts are not
  asked. An unknown host and an unknown option each get one line and exit 2 (`box runs --follow --host <name>` used to
  print the whole help and return).
- The toolbox image recipe makes the folder of the TypeScript interface before it installs into it: the image build of
  0.4.26 to 0.4.31 failed at that step on a host (`canonicalizing the --dir argument`). The recipe was built for real
  under a throwaway name before this release.

## 0.4.31

- **The home of a `--user` machine box is writable.** In a machine made with `--vm --user` (0.4.28 to 0.4.30)
  `/job/home` belonged to root inside the machine: `touch: cannot touch '/job/home/x': Permission denied`, git could
  not write its settings file and npm not its cache. The home was made by root in the guest, and only what the host
  makes is presented as the account's. The server now makes it on the host before each call, and a home that is
  already wrong is handed over once, so existing machines heal at their next call without `--recreate`. Found by a
  user; the proof of 0.4.28 had tested the source folder and the caches, not the home.
- **`--wait` no longer gives up when the call builds its image.** A refusal for room was recognised by the server's
  line at the start of the call's error output. With `--image-file` the build's lines come first, so the client took
  exit 75 for the command's own and returned it: no waiting, no try on the next host, no move, no hint. The client now
  keeps the end of the error output and looks at its last line, which is where the server writes a refusal. A command
  that exits 75 by itself is still not taken for one. Found by a user who started several such calls side by side.
- The toolbox image recipe gains `bubblewrap` (a sandbox tool some test suites need); `toolbox-check` checks it. A host
  gets it at its next image build.

## 0.4.30

- **`--commit <rev>`: the box's source is exactly one commit, as a fresh clone and checkout gives it.** Tracked files
  of that commit only, with their modes and links, submodule folders empty, as a repository at that commit (as `--git`
  makes it: one commit, detached, nothing that names the user). Nothing from the working folder travels: no
  uncommitted edit, no untracked file, no build output, and leftovers of earlier calls in the box's source folder are
  removed. The client makes a temporary export with its own temporary index, so the working folder, the index and the
  branches are never touched, and removes it at the end, also after a failure. It prints
  `box: source is commit <hash> (<rev>), not the working folder`. Works with `--detach`, `--shards`, `--vm`, `--user`
  and `--image-file` (the file of the commit); not with `--git`, `--snapshot`, `--no-sync`, `--include` or
  `--clean`. A later call without it syncs the working folder again. `--git` copies the working folder, so a build
  passed in a box and failed in the repository's own automation on stray files that only a fresh clone shows.

## 0.4.29

- **`box --shards <n>`: several commands side by side from one worktree in one call.** It makes `<n>` boxes for the
  worktree (its box name with `-s1` to `-s<n>`), starts the command in each with `{shard}` and `{shards}` filled in
  (`box --shards 5 -- npx vitest --shard={shard}/{shards}`), waits for all, prints one line as each ends
  (`shard 2/5  <host>  <box>  run <id>  exit=0  118 s`), then the last 20 lines of the log of every run that failed
  (`--tail <n>` for another count or for all), stops the boxes (files and caches kept) and exits 0 only when every
  run ended with 0. Each box is admitted like any other; a start refused for room ends the call, leaves the earlier
  runs going and says how to follow them. `box runs --follow` takes `--tail <n>` too. Asked for by a user who started
  the five parts of a test suite by hand and wrote a waiting loop each time.
- **The box's folder remembers what kind of box it was.** After `box stop` or the idle removal of a box, a call that
  named no engine made a plain container running as root on the same folder, although the box had been a machine
  with an ordinary account (seen on a real host). The server now records engine, account, `--kvm` and a named image
  in the folder (`.kind`) and makes the box again as it was when the call names none of them; a call that names
  another engine, or `--user` or `--kvm` against the record, gets the usual refusal and needs `--recreate`. A box that
  stands gets its record at its next call; a folder left by an older server without one behaves as before.

## 0.4.28

- **A `--user` machine box gets its files and the shared caches through the mounts, not through a walk before each
  call.** 0.4.27 handed the account every file under `/job/src` before each call and left `/cache` to root, so
  cargo, pnpm, npm, Go and Maven could not write their caches as the account (`Permission denied`, seen on a real
  machine). A machine made with `--user` is now created with `uid=1000,gid=1000` on its `/job` and `/cache` mounts:
  inside, every file made on the host shows as the account's, also those a later sync writes, and on the host they
  stay the build account's. The account is the image's own one with that number when it has one, else `box`; the
  command runs with `HOME=/job/home`. A machine made by 0.4.27 with `--user` needs `--recreate` once.

## 0.4.27

- **`--user` works for machine boxes.** `box --vm --user --git ...` now gives all three at once: an ordinary account,
  the machine's container runtime and the worktree as a git repository, which is what a hosted runner gives. A machine
  made with `--user` keeps it (also through `--recreate`), as a container box does. Before each call the server makes
  the account `box` in the machine when it is missing (home `/job/home`, member of group `docker` when the image has
  it) and hands it every file under `/job/src` and `/job/home` that is not its own, so files written by a later sync
  are covered; the command then runs as that account. An image without `useradd` is refused with
  `boxd-pod: --user needs useradd in the machine's image`. `pod report` shows `user=yes` for such a machine and the
  creation line names the account. Asked for by a user whose tests fail as root for reasons that are not the code.

## 0.4.26

- **`box stop`: free a box's memory and keep its files.** Stops this worktree's box on its host; the folder with the
  build outputs stays, so the next call makes the box again on the same files and the build is warm. Same guards as
  `box drop` (your own box only, refused while a call or a run is going in it, a sleeping host is not woken). Prints
  `box stop: stopped <host> box <box>; its files are kept`. `box drop` removes the folder too and is for a worktree
  that is going away: a user who dropped after every run to free memory lost 22 GB of build output each time.
- **The machine engine's own line no longer reaches the caller of `pod stop`.** `ssh boxd-<host> pod stop <box>` on a
  machine box printed the engine's `✓ Removed pod-<box>`. Every removal of a machine now goes through one helper that
  is silent on success and says `boxd-pod: removing <name> failed: <engine output>` with a failing exit otherwise.
- **The toolbox image carries the JavaScript interface of TypeScript at a fixed path.** Version 6.0.3 in
  `/opt/typescript-api/node_modules/typescript` (with `lib/typescript.js`), for tools and tests that load the compiler
  as a library; version 7 on the path is the native compiler and no longer ships it. `toolbox-check` checks it. A host
  gets it at its next image build (`boxd-setup --images`).

## 0.4.25

- **A run in a machine box writes its output as it comes.** The machine engine's command runner held the output of a
  command without a terminal until the command ended, then wrote it at once: `box log` of a detached run in a machine
  box stayed empty (`bytes=0`) for the whole run, `--follow` printed nothing until the end, and a machine that died
  took the output with it. The detached run and the foreground call without a terminal now start with the engine's
  `--stream` option (measured: lines arrive at once, output and error stay apart, the exit code is kept). Needs
  microsandbox 0.7.15, the packaged version. Container boxes never had the problem. Reported by a user who watched a
  45 minute run with an empty log.
- **Each machine box records what it really needs in memory.** Seen from the host a machine always uses its whole size,
  because the system inside fills spare memory with file cache. A small loop inside the machine now keeps the highest
  `MemTotal - MemAvailable` in `jobs/<box>/.mem-peak`; `pod report` shows it as `mem_peak_mb` on the box line; when
  the box's folder goes, one line (time, box, size, megabytes of the size, peak) is appended to
  `cache/mem-peaks.log`. The peak belongs to the box: it is kept and only grows when the idle machine is made again;
  `--recreate` starts from nothing.
- **`box drop` and the collector say what a removed machine box needed**, with advice where it helps:
  `...freed; it needed 2900 MB of its 8192 MB at most (--size medium would have held it)`, or
  `(close to the limit: --size xlarge gives 12288 MB)` above 80 percent.
- **A machine made again without `--size` takes the smallest size that held its past need** with a quarter to spare
  (small, medium or the host's default, never above it) and says so:
  `boxd-pod: machine box <box>: size medium chosen from its past need of 2900 MB (give --size to choose yourself)`.
  Admission is unchanged: it counts sizes, now possibly a smaller one.

## 0.4.24

- **Container boxes are admitted, no longer only limited by the cap.** A call that would start work in a container box is
  refused with exit 75 when the memory already counted plus a reserve for the new work does not fit the cap:
  `boxd-pod: no room for another busy box (<counted> MB counted + <reserve> MB reserve > <limit> MB, <percent>% of the
  <cap> MB cap); wait for one to end`. Counted are the sizes of the running machines and the measured memory of every
  container box, where a box whose work started in the last `BOXD_VM_IDLE_MIN` seconds counts at least the reserve (it has
  not claimed its memory yet). New host setting `BOXD_BOX_RESERVE` (megabytes, default 4096; 0 turns the rule off). A call
  into a box that is already busy is never refused, nor are reads. Machine admission counts young busy container boxes the
  same way. `pod status` gains `box_room`, `box_fit_mb` and `box_reserve_mb`; the client judges a container call by
  them, tries the next host, waits with `--wait`. Before this, ten builds started at once all began and the kernel killed
  a process of some box past the cap, possibly another user's long run.
- **Machine boxes go to the smallest host that fits.** Among the hosts where the asked size fits, the client takes the one
  with the smallest memory cap (`group_mem_max_mb`), so small machines no longer fill the big host and leave no room for a
  big one. Logged as `fit` in `choices.log`. Container boxes still go to the host with the most free memory.
- **A box whose own host is full comes back on another host by itself.** When a placed worktree is refused for room and
  another host has room, the client moves it there as `--host` would and says so first:
  `box: <old> has no room; this worktree moves to <new> (its caches on <old> are kept until that host's time limit)`.
  Never when the old host still lists a box or a run of this worktree, cannot be asked, or when `BOXD_HOST` or `--host`
  named the host.

## 0.4.23

- **`--git`: the box gets a git repository at the worktree's real commit.** With it, `/job/src` in the box is a shallow
  repository whose `HEAD` is the commit the worktree is on (the same hash, that one commit, no history, detached, no
  branch names, no hooks, no remote, nothing that names the user), and `git status` there shows exactly what differs
  between the synced files and that commit. The repository stays on later calls until a call with `--git` refreshes it.
  `--snapshot` is unchanged (a repository with one new commit); the two together, or `--git` with `--no-sync`, are
  refused. A machine box now trusts `/job/src` for git inside the guest, where root is not the owner of the synced files.
  Asked for by a user whose tools record their own commit at the start of a run and whose tests need a repository.
- **A new box says which account its commands run as.** Once, on standard error, when a call creates the box:
  `boxd-pod: new container box <box>: commands run as root; an ordinary account needs --user at creation`, the same
  for a box made with `--user`, and for a machine box. Tests that fail only as root were taken for real failures.
- **`box drop` removes a box whose image runs its own services.** It refused a machine made from the toolbox image with
  "still has a command running in it", because the image's own `dockerd` and `containerd` were counted. It now asks the
  server whether a call or a detached run is going in the box (`busy=` of `pod report`) and refuses only then. A server
  too old to say keeps the old rule.
- **The "no room" refusal says what fits now.** After the lines per host it names the largest smaller size that fits and
  where (`fits now: --size large on laptop (11400 MB free; ...)`) and, unless the call already waits,
  `or wait for room: add --wait`. Computed from what the hosts already answered; exit code and the other lines unchanged.

## 0.4.22

- **A fourth machine size: `--size xlarge`, 8 processors and 12 GB.** For work that needs more than the 8 GB of `large` in
  one machine. Admission counts it as 12288 MB in every rule (the sum of the running machines' sizes, the room for one
  more, the removal of idle machines to make room, the refusal text with its numbers); a host whose cap cannot hold it
  refuses with the usual line (`0 MB in use + 12288 MB asked > 8192 MB cap`). The size is fixed and does not follow
  `BOXD_VM_LIMITS`. As with the other sizes, a box keeps the size it was made with and another one needs `--recreate`.
  The client sends a worktree that asks for it to a host that can fit 12288 MB when another registered host cannot
  (`vm_fit_mb` of `pod status`). Take it only when the work needs it: fewer machines fit beside it. Asked for by a user
  whose three reviewers ran one after another only for lack of memory.

## 0.4.21

- **GitHub makes the public release by itself.** A pushed tag `v<version>` runs the tests, builds the Void packages in a Void
  container and signs them, builds and checks the Debian packages, creates the release with all of them
  (`tools/release-github`) and proves in fresh Void and Debian containers that both kinds install from it. A tag with a
  suffix (`v0.4.21-citest1`) is a trial that makes a prerelease. The tests also run on every push. New tools:
  `tools/sign-repo` (the index and signing step, now shared with `tools/sign-and-publish`), `tools/release-version`,
  `tools/test-shell`, `tools/ci-build-void`, `tools/ci-build-deb`, `tools/ci-prove`.
- **Tests no longer depend on the machine.** The retention case measures what an empty folder weighs on the file system
  it runs on (0 MB on btrfs, 1 MB on ext4). The call log case uses any installed locale with a decimal comma. The process
  report test no longer starts `sleep` through a link with another name (on Ubuntu 26.04 that ends at once and the test
  waited for it without end) and fails at once when a helper process is gone. `tools/test-shell` names and stops
  whatever a test leaves behind. The checks that the compiled client files are fresh look for the compiler in `BOXD_TSC`,
  then on the path, and are skipped with a reason where there is none.
- The README has an Acknowledgements section for what boxd ships and what it is built on.
- No behaviour of `box`, `boxd-pod` or the dashboard changes in this release.

## 0.4.20

- **boxd is public, under the MIT license.** The source is at https://github.com/gsalucci/boxd. The packages state the
  license (`license="MIT"` with the license file in the Void packages, the Expat text in the Debian copyright file).
- **Every release on GitHub carries the built packages.** New tool `tools/release-github <version>` creates the release
  `v<version>` with the change log section as its notes and attaches the signed Void packages with their index, the Debian
  packages and a `SHA256SUMS` file, then downloads everything again and compares. A Void host installs straight from it:
  `repository=https://github.com/gsalucci/boxd/releases/latest/download` in `/etc/xbps.d/boxd.conf`. A Debian host
  downloads the `.deb` files. `tools/release-deb` keeps its built packages in `BOXD_DEB_KEEP` when that names a folder.
- **The release tools have no default registry.** `tools/sign-and-publish` needs `BOXD_REGISTRY`; `tools/publish-deb` and
  `tools/release-deb` need `GITEA_URL` and `GITEA_OWNER`. Unset, each prints one line that names the variable and exits 2.
- **Documents for a first reader.** New README; the settings table is now `docs/settings.md`, the development notes
  `docs/development.md`. Examples in documents, tests and comments use neutral host names and the documentation address
  range 192.0.2.0/24.
- `tools/host-watch` keeps its state in `~/.local/state/boxd/watch` unless `HOST_WATCH_DIR` says otherwise. The dashboard
  stack runs in UTC. Node type definitions for the compile come from `package.json` (`pnpm install`).
- No behaviour of `box`, `boxd-pod` or the dashboard changes in this release.

## 0.4.19

- **A removal says how much disk it freed.** The server measures a box's folder before it removes it and answers
  `evicted <box> (<reason>), <n> MB freed`; `box drop` and the collector (`box gc`) print `..., <n> MB freed` after `and its
  files`. Measured in the build account's user namespace, where files made by other users inside a box are readable. Limits:
  the image built from a box's own Containerfile, removed in the same step, is not counted; a box without a folder, a failed
  measurement or a server older than this release leave the line as before. `evictions.log` keeps its three fields. Asked for
  by a user who wants cleanup reports to quote a measured number.
- **`box log <run> --state` says when an ended run ended and how long it ran.** The line gains `ended=<time>` (the last write
  of the run's log, in UTC as `2026-11-16T17:48:47Z`) and `seconds=<n>` (from the creation of the log at the run's start to that
  last write). The server sends both as new words at the end of the `pod log` header of an ended run; readers that take the
  words by key are not disturbed. `seconds` is absent on a file system that reports no creation time; a running run and an
  older server print the line as before. Asked for by a user who computed wall minutes from the log.

## 0.4.18

- **`box drop` removes this worktree's box at once.** Run from inside a worktree you are about to delete, it removes the box and
  its files on the build server and the record on this machine, without the collector's two passes 15 minutes apart. It refuses
  while a command still runs in the box (no force), never wakes a sleeping server (the collector removes the box when it wakes),
  and with `--pod` removes only a box this machine recorded for this worktree or for a worktree that is gone. A box the server
  already removed for idleness is cleaned too (its folder and record). Each removal is a line in `gc.log` ending in `asked`.
  Client only, the server is unchanged. Asked for by a user whose rule is to clean up before reporting done.

## 0.4.17

- **`box log <run> --state` says in one line whether a detached run still runs.** It prints `<run>`, `state=running|ended` and
  `exit=<code>` (a dash while running, or when the run ended without a code because its box or host went down), tab separated,
  and no log text; it exits 0. One `pod log` call, the box is not started. Asked for by a user who read the log tail for `EXIT`.
  Limit: it does not say when the run ended.
- The host watcher (`tools/host-watch`) no longer reports the record of a box on a sleeping host as left behind: the collector
  wakes no host, the record waits for it.

## 0.4.16

- **A machine's process limit is raised from 4096 to 32768.** The guest kernel microsandbox boots (6.12.117) is built small and
  logs `pid_max: default: 4096 minimum: 301`: all processes and threads of a machine share 4096 numbers, whatever `threads-max`
  says. Measured on the build host on 2026-11-16: a loop of 4300 background processes died with `sh: 0: Cannot fork`, and a
  user's detached runs (three browsers and docker containers inside 4 GB machines) lost containers three times in one night with
  `OCI runtime exec failed: ... error executing setns process`, with memory to spare and no kernel kill line, which is what a failed
  fork looks like. Creating a machine, and every later start of a stopped one (the setting does not survive a stop), now writes
  32768 to `/proc/sys/kernel/pid_max` in the guest call that already prepares it, before the user's command; a call into a running
  machine and container boxes are not touched, and a guest that refuses the write keeps its limit without any message. Limit:
  32768 is this guest kernel's ceiling (4194304 is refused); the real fix is a guest kernel not built small, which is microsandbox's.

## 0.4.15

- **A removed idle machine is said in one line.** The first removal on a real host (laptop: a machine idle for 315 seconds
  gave its slot to a new one, as designed) put the engine's own `✓ Removed pod-...` into the caller's output. The caller now
  reads `boxd-pod: the idle machine of box <box> was removed to make room for this one` on standard error.
- `tools/bump-version <new>` moves every place that carries the release version and compiles the client.

## 0.4.14

- **`box log <run> --tail <n>` prints only the last lines.** `box log <run> --follow` started near or after the end of a run
  printed the whole log (megabytes) when the reader wanted the last lines and the exit code, and piping through `tail` hid
  the exit code. `--tail <n>` (a whole number from 0 to 100000) holds the output back until the first catch-up, keeps only the
  last `<n>` lines, prints them, and with `--follow` goes on with everything that comes after; `--tail 0 --follow` prints
  only what comes after. The exit code rules are unchanged.
- **`box gc --dry-run` says when a box will go.** For a box whose worktree is gone and was seen before, the message now says
  how long ago the worktree was first seen missing and in how many minutes a pass removes the box (`is missing since 6 minutes;
  a pass in 9 minutes or later removes it`), from the collector's own clock. Only the words changed; a dry run still records nothing.

## 0.4.13

- **The guest kernel's kill lines also come from a guest without `dmesg`.** The first run on a real host after 0.4.12 (a
  small machine from the plain Void image on the tower) showed the lines never came: that image has no `dmesg`, and the run
  was then left unwrapped. The kernel's own device `/dev/kmsg` is now read in that case, without blocking; seen working in
  that machine. A guest where neither can be read still runs as before and adds nothing.

## 0.4.12

- **`pod status` says the largest machine that fits.** `vm_room` and `vm_why` are judged for the default size (8192 MB), so a
  user asking for `--size medium` (4096 MB) was told "no room" on a host that would have admitted it. A new last word,
  `vm_fit_mb`, is the largest size `pod run` admits now (the smaller of the cap minus the measured use and the commit share
  minus the running machines minus the container boxes' use; `0` at the count ceiling; a dash when memory cannot be measured
  or on a host without machines). One computation now feeds `pod run`'s refusal, `vm_room`, `vm_why` and `vm_fit_mb`; the
  refusal text and exit code are unchanged.
- **What the guest's kernel killed is written into the detached run's log.** On 2026-11-15 and 2026-11-16 a docker container
  inside a 4 GB machine died under a detached run, the host killed nothing, and the guest's kernel log went with the machine.
  The log of a detached run in a machine now gets the guest's `Killed process` lines that appeared during the run, each as
  `[boxd] guest kernel: ...`, before the `EXIT` line. Nothing is added when there are none; the exit code is unchanged.
- **Idle machines give their room back.** An idle machine held its whole size until the reaper's 30 minutes, also on a full
  host with callers waiting. When a new machine has no room,
  `pod run` now removes idle machines first, the longest unused first and no more than needed: unused for
  `BOXD_VM_IDLE_MIN` seconds (300), with no run or call in them. A machine with a run in flight is never touched; none is
  removed when that would not make the room. `pod status` counts the room idle machines would give, and each removal is an
  `evicted` line in `pod report`.
- **Room is judged for the size asked.** The client refused a `--size small` or `--size medium` request by the server's
  answer for the default size; it now reads `vm_fit_mb` and says the numbers when it refuses (`3000 MB fit, 4096 MB asked`).
- **`box runs --pod <pattern>`**, with and without `--follow`: only the runs of boxes whose name matches (`*` and `?`,
  repeatable); the exit code of `--follow` then reflects only them.

## 0.4.11

From the second round of feedback of the tool's users.

- **`pod status` says why no machine fits.** `vm_room=no` gave no reason: a user with four machines on a group at 16.5 of
  24.6 GB could not tell when a slot would open. A last word `vm_why` is appended: empty when a machine fits, otherwise the
  sentence `pod run` refuses with (sizes of the running machines, memory used by container boxes, the size asked, the cap).
  `box hosts` shows it, and the client's "no room" lines and `--wait` use it in place of their own shorter words.
- **`box --version`** prints the client's version; `tools/release` refuses a release whose client is not at that version.
- **`box runs --follow`.** Waits for the detached runs that are running now, on every awake host, prints one line for each as
  it ends (host, box, run id, exit code) and exits 0 when all ended with 0, otherwise 1. It replaces polling `box log` per run.

## 0.4.10

From feedback of the tool's users.

- **`pod status` and `pod report` print the release version.** `VERSION` in `server/boxd-pod` was a hard-coded `0.4.0`, so a
  0.4.9 install answered `version=0.4.0` and a user took a fix for not installed. It is now `0.4.10`, equal to `version=` of
  `srcpkgs/boxd/template`. `tests/contract-pod-test.sh` fails when the two differ, and `tools/release` refuses a release whose
  `server/boxd-pod` is not at the version being released.
- **`pod status` shows the host's memory.** `mem_free_mb` is boxd's accounting (the group cap minus what boxes use, never below 0)
  and read 0 while the host had 9.5 GB available. It stays as it is. Three words are appended after `images`, so readers by
  position and by key keep working: `mem_avail_mb`, `group_mem_used_mb`, `group_mem_max_mb`, with the meaning and the code of the
  `host` line of `pod report`. The contract now says plainly what `mem_free_mb` is and is not.
- **`pod help`.** `ssh <host> pod help` lists the commands the server accepts, one line each; read only, also for keys that may
  only read. The `unknown command` error is unchanged: the client and the dashboard match its text to detect old servers.
- **`box` ends quietly when its output pipe is closed** (exit 0, no output), as in `box hosts | head -1`; it used to crash with
  `EPIPE`.
- **A warning for a box option after the command.** `--pull`, `--include`, `--env`, `--detach`, `--host`, `--pod`, `--no-sync` or
  `--wait` written after the command without `--` is handed to the command; `box` now says so once and goes on.
- **`--pull` of a path that is not in the box** prints `box: nothing at <path> in the box, nothing pulled` in place of rsync's words.
- **`box runs`.** The detached runs still running on the awake hosts, for this machine's boxes: host, box, run id, age, worktree
  and last output line. It never wakes a sleeping host.
- **`--wait`.** When no host has room the call asks again every 30 seconds in place of exit 75 at once. It holds nothing and gives
  no order among waiting callers; a refusal that waiting cannot fix still exits at once; a wait whose starter is gone ends (129).
- **`--detach` tells where results live.** `--pull` does nothing with it (now a warning); results must be under `/job/src`, files
  outside `/job` go with the idle box, and the printed command fetches them later (`box --no-sync --pull <path> true`).
- **Skill text:** the clock in a box is coordinated universal time, a synced tree has no git data without `--snapshot`, how to see
  out-of-memory kills in a machine box, `box runs`, `--wait`, `box log` keeps the full output.
- **`tools/host-watch`** (for the owner of the hosts): a read-only watcher of both hosts that reports machines over the cap, kernel
  kills, cleanup that did not happen and placements past a host with room.

## 0.4.9

From the machine box killed on the tower on 2026-11-15 (see 0.4.8): the rule of 0.4.7 and 0.4.8 counted only machines, so
machines could reserve 100 % of the cap while a container box (12 GB limit by default) grew on top, and the build running at
the kill was in a container box. When the cap was hit the kernel picked its victim by size, a machine (one large process),
not the container process that grew. The design: machines hold reservations, container boxes are best effort.

- **Container memory counts in the commitment.** A machine is admitted when the sizes of the running machines + the memory the
  running container boxes use now + the asked size fit `BOXD_VM_COMMIT` percent of the cap. The container figure is measured
  as the cap check measures (anonymous, shared and swapped memory, no file cache) in the cgroup of each box's init process. The
  refusal names the three numbers: `... (4096 MB of running machines + 4096 MB used by container boxes + 2048 MB asked >
  8192 MB, 100% of the 8192 MB cap) ...` (the container term is left out when it is 0). A running container whose memory
  cannot be read counts as its `--memory` limit; with no limit to assume, the call is refused (`the running container boxes
  cannot be measured now`). `pod status` (`vm_room`) follows, as the one rule is `vm_refusal`.
- **The grower dies, not a machine.** New container boxes are made with `--oom-score-adj 1000`: the kernel adds that share
  (a thousandth) of the cgroup's limit to the badness of every process, so when the build cgroup is full a container process
  ends before any machine. Boxes made before 0.4.9 keep their old score until recreated (marked `shortcut:` in `server/boxd-pod`).
- **A killed container run says so.** A command in a container box that ends with 137 while the cgroup's `oom_kill` count rose
  gets `boxd: the command in box <box> was killed (exit 137): the host's out-of-memory killer ended a process of the boxes
  meanwhile (kernel log: dmesg)` on stderr, or in the run log before `EXIT 137` (the same mechanism as 0.4.8's machine line).
- Judged and not built: refusing container boxes by load or memory (rejected in 0.4.8: a container has no size to check and
  refusing would stop the work the box is for), and a score for boxes made earlier (needs a write into processes owned by the
  container's user namespace on every call; not small).

## 0.4.8

0.4.7 was committed but never published; this release carries it too. From a machine box killed on the tower on 2026-11-15
at 13:38 (reported from use): the kernel's out-of-memory killer, host-wide, ended the largest
machine (8 GB) with three detached runs in it. Eight machines were running (36 GB of sizes on the 28 GB cap) plus a CUDA
build, and the cap did not protect the host: its swap is zram, kept in RAM.

- **Swapped-out memory counts as in use.** Admission and `mem_free_mb` (and the dashboard's `group_mem_used_mb`) read the
  build cgroup's `anon` plus `shmem`, which leave RAM when swapped: the tower's group read 23713 MB with 7.7 GB more in swap
  and kept admitting machines. They now add `memory.swap.current`. `mem_free_mb` is never below 0.
- **`BOXD_VM_COMMIT` defaults to 100** (was 150 in 0.4.7): the sizes of the running machines never exceed the cap. At 150 the
  eight machines of the incident (36864 MB on 28672) would still have been admitted.
- **The memory cap leaves room for swap kept in RAM.** When swap is on zram, half of what the group may swap there (up to
  the zram size) is taken off the default `BOXD_MEM_MAX`; a set cap that, with that share, is over 90 % of the host's memory
  logs a warning in the `boxd-sshd` log. Takes effect when `boxd-sshd` restarts.
- **A machine that ends under a command says so.** The run log, before its `EXIT` line (stderr for a foreground call):
  `boxd: the virtual machine of box <box> ended under this run`, with `: the host's out-of-memory killer ended a process of
  the boxes meanwhile (kernel log: dmesg)` when the build cgroup's `oom_kill` count rose during the run. Before, the log said
  only `exec session ended without exit event`.
- `pod ps` (`box ps`) on a stopped machine box: `virtual machine box <box> is stopped; the next command in it starts it again,
  when the host has room` (was `box <box> is not running`, read as the container box).
- **A new worktree goes to the build server with the most free memory** (`mem_free_mb`; ties keep `box hosts` order; a
  sleeping server counts as empty). It went to the first server in order with room, which filled the tower while laptop
  stayed idle unless a session named it. `choices.log` names such a choice `spread`. Worktrees already placed stay.
- Judged and not built: a limit by load (load lagged and was a symptom: processes waiting for memory; memory is what kills
  boxes), and refusing to end a box with live runs (boxd did not end it, the kernel did).

## 0.4.7

- **Machines are also admitted by their sizes, not only by measured memory.** Reported from use: twelve 4 GB machines were
  admitted on the tower's 28 GB cap, because a young machine has not claimed its memory yet, and free memory fell to 2 GB once the builds
  grew. The sizes of the running machines plus the new one must now fit `BOXD_VM_COMMIT` percent of the cap (default 150: ten 4 GB
  machines on 28 GB; 100 means the sizes never exceed the cap). Refusal: `no room for another virtual machine (<sizes> MB of running
  machines + <asked> MB asked > <limit> MB, 150% of the <cap> MB cap)`. Machines already running are never stopped by the rule.
- **The build account's sshd accepts more connections that have not logged in yet** (`MaxStartups=100:30:200`, was sshd's default of 10).
  Four sessions following their runs at once were dropped (`drop connection #10 ... MaxStartups` in the log, "Connection reset by peer"
  on the client). Takes effect when the `boxd-sshd` service restarts.

## 0.4.6

- **`BOXD_MAVEN_MIRROR`: a host setting that points every box's Maven at a caching repository on the local network.** Asked by a user
  after Maven Central refused the network's address: a repository manager on the homeserver now serves Java packages. The server
  writes the settings file into the shared cache and adds `-s /cache/maven-settings.xml` to `MAVEN_ARGS`. Unset by default; a machine box
  also needs the address in `BOXD_VM_NET_ALLOW`. With the repository's server off, Java builds that need a new file fail with a clear
  network error; files already in `/cache/m2` still serve.

## 0.4.5

- **The shared package cache covers Maven and Gradle.** Every box already had `/cache` (one folder per host for cargo, go, npm, pnpm and
  everything under `XDG_CACHE_HOME`); new boxes now also get `MAVEN_ARGS=-Dmaven.repo.local=/cache/m2` and `GRADLE_USER_HOME=/cache/gradle`.
  Reported from use: dozens of Java builds in fresh machines, each downloading its whole dependency set, and Maven Central
  answered the network's one public address with 429 for a day. A box made before this release gets the settings when it is made
  again (the reaper removes idle boxes after 30 minutes). Builds in nested containers must mount `/cache` themselves (skill).
- Under disk pressure, files of the shared package caches not written for `BOXD_KEEP_DAYS` are removed.
- Judged and not built: a caching proxy per package source on each host (a service per source to run and keep; the shared folder gives
  most of it) and a report of which sources refuse the address (not boxd's to probe).

## 0.4.4

- **A foreground call keeps the host awake by itself.** Until now only its ssh connection did, and a connection from an address of
  `BOXD_IDLE_IGNORE` does not count: a quiet foreground call from such an address (the package pipeline's runner shares the dashboard's
  address) could have had the host sleep under it. The call now holds the keep-awake lock for as long as it runs, like a detached run
  and a forward. Consequence: `boxd-reset` refuses while a foreground call runs, as it does for a detached run.

## 0.4.3

- **`boxd-setup --add-key <file> [--from <addresses>]` and `--remove-key <file>`: further keys with full run rights**, for another client
  machine (asked for a package pipeline whose runner calls `box` from the homeserver). Listed in `/etc/boxd/run_keys`, kept across reruns and
  across a new `--key`, each removable on its own; `--from` limits a key to source addresses (sshd's `from="..."`). The first key is
  never removed this way. Server command set unchanged (`version=0.4.0`).

## 0.4.2

- Defect of 0.4.0 and 0.4.1: `pod report` and `pod log` wrote a "No such file or directory" line to standard error for every ended run
  (seen in `box log` and in the dashboard's polls; the answers themselves were right). The contract test now reads standard error too.
- Acceptance on two hosts: the second host's own build account and work area (`BOXD_TEST_USER2`, `BOXD_TEST_WORK2`), a machine ceiling the
  scenarios set and take back themselves, and the sleep scenarios are skipped with the reason while someone is logged in on the host.

## 0.4.1

The server's command set is unchanged except for the new `evicted` lines of `pod report`, so `pod status` keeps reporting `version=0.4.0`.

- **Retention covers images.** The image built from a box's Containerfile goes with the box's folder. When disk pressure starts, the images
  no box uses go before the first folder does (both engines), with the dangling layers. They come back by themselves, except an image
  sent with `box image push`, which must be pushed again. Not by age: images were 6 GB of 953 on the tower.
- **The dashboard shows what retention removed**: `pod report` lists the removals of the last day and the dashboard raises one alert per host
  with what went and why (nothing to do; so that a missing folder is no surprise).
- Acceptance 44 counts the relay itself (it read 3 for one relay on a real host).
- The dashboard is reachable at `https://boxd.example.com` behind your reverse proxy, limited to your own network.

## 0.4.0

The server's command set changes (`pod drop`, `pod forward`, `--delete-excluded` in the sync), so `pod status` and `box hosts` report `version=0.4.0`.
The client works against a 0.3.x server except for `box forward`, `--clean` and the removal of box folders.

- **Retention: boxd keeps the build host clean by itself** (owner decision 2026-11-14: nobody cleans by hand). Measured on the tower that day:
  143 box folders in 36 hours, 136 GB, and nothing removed a folder short of the wipe of the whole work area at 85 percent. Now the reaper
  removes whole box folders: unused for 14 days (`BOXD_KEEP_DAYS`), or least recently used first, one per minute, while the work area is
  70 percent full until it is under 60 (`BOXD_EVICT_AT`, `BOXD_EVICT_TO`); the client's collector removes the folder of a worktree that
  is gone with the new verb `pod drop <box>` (before: it only stopped the box, and forgot a box the reaper had already removed).
  Never a folder in use (a run, a sync, a pull, a box being made), never single files inside a box. Every removal is a line in
  `cache/evictions.log`, and the next call of that box says once that its folder was removed and why.
  **Behaviour change for callers: `/job` is not an archive. Pull what must last.**
- A sync or pull now holds its box folder busy and renews its stamp.
- From a user's feedback after a day of use (about 40 model-driven runs):
  - `--include <path>` sends a named file or folder although git ignores it. Their run journal was a `*.log` file, never synced, so a run
    continued in a fresh box started from nothing.
  - `--clean` makes the box's source folder exactly the worktree: ignored files of earlier runs are deleted first (the history of
    `--snapshot` is kept). Results of an earlier run had sat in the folder of the next measurement. Needs server 0.4.0 (an older one
    refuses the sync: nothing starts).
  - **Defect: `box log --follow` waited for ever on a run whose host lost power or whose box was killed**: the run's record stayed, so it
    read as running. The server now checks that the recorded process group is alive; the client says the run ended without an exit
    code and exits 129 (before: 1 for a run without an `EXIT` line).
  - Help: `--pull` transfers only changed files; a `--pod` box belongs to the worktree that called it last.
  - Judged and not built: a volume that outlives the box (`/job` already does; see retention), copying results out when a detached run
    ends and redacting credentials in pulled files (the caller's job), `--wait-room` (exit 75 is the contract), a user for machine boxes
    (deferred: larger), `pod top` (`pod report` has the memory per box), the workstation as a build host (it is never loaded).
- **`box forward` and `box vnc`: reach a port inside a running container box.** A box can run a VM desktop (QEMU in a `--kvm` box,
  x11vnc on 127.0.0.1:5900, noVNC on 6080) that only listens inside the box. New server verb `pod forward <box> <port>` relays the ssh
  channel to `127.0.0.1:<port>` in the box's network namespace with the host's socat (`podman unshare nsenter --net=/proc/<pid>/ns/net socat`,
  so no image needs socat); the build sshd still has `AllowTcpForwarding no`. Port checked 1 to 65535 on the server; never creates or starts a
  box (missing or stopped: 125; a vm box: 125 `forward is for container boxes`). Each channel holds the box busy like a foreground call (shared
  lock on `.running`, `boxd-keepawake`) and ends with the channel; one call-log line per channel, command `forward <port>`.
  The forwarder ends when the process that started it is gone (exit 129), like a foreground call: nothing of boxd stays running on the workstation by itself.
  Client: `box forward [--host] [--pod] <local-port> <box-port>` listens on 127.0.0.1 only, one ssh per connection; `box vnc` forwards 5900 and
  runs `xdg-open vnc://127.0.0.1:<port>`. `socat` is a new dependency of `boxd-server` (void and deb). Command set 0.4.0; the client says so against an older server.

- **The sync no longer prints a line that reads like a failure when it succeeded.** Defect report from a user who lost money:
  `cannot delete non-empty directory: <folder>` is rsync's remark (exit 0) for a folder deleted in the worktree that still holds
  ignored files on the server (build output, caches; they stay on purpose). The run started, an agent read the line as "not
  started" and relaunched it four times into the same box. The client now writes
  `box: sync complete; 1 folder deleted here stays on the server because it holds files git ignores: <folder>`.
  A sync that really fails says `box: sync failed (rsync exit <code>); nothing was started` and exits with that code.
  The rule for callers: exit 0 and a `run <id>` line mean started; anything else means not started.

## 0.3.1

The server's command set is unchanged, so `pod status` and `box hosts` keep reporting `version=0.3.0`; the package version says which build runs.

- **Behaviour change: a foreground call now ends with the process that started it. Work that must outlive its starter needs `--detach`.**
  Stranded boxes, reproduced on a real host: `box -- sh -c 'sleep 100000'` without a terminal, then the client and its ssh killed: the sleep kept
  running, `podman exec -i` stayed on the host holding the box's `.running` lock, and the reaper never took the box. Server: without a terminal the dispatcher runs the engine in the
  background with a marker (`BOXD_CALL=<marker>`) in the call's environment and watches its parent (sshd's session process); when that is gone,
  or on a hangup, termination, interrupt or broken pipe, a second exec in the box (the same account, both engines) sends TERM then KILL to every process
  carrying the marker, the host-side engine process ends, the lock is released (exit 129, call log reason `session gone`). Detached runs and calls on a terminal are
  untouched. Client: a non-terminal foreground call notices that its parent process id changed, prints
  `box: the process that started this call is gone; ending the call (use --detach for work that must outlive its starter)`, ends its ssh and exits 129;
  `BOXD_KEEP_ORPHAN=1` turns that off. Limits: a command that clears its environment (`env -i`) is not found. Tests: contract cases in
  `tests/contract-pod-test.sh` (fake engines, fifos), `tests/box-client.test.mts`, acceptance scenario 43.
- The collector, inside the client (no service, timer or daemon): `box gc [--dry-run]` and a quiet pass after an ordinary call at most every 15 minutes
  (`BOXD_GC=0` turns it off). Every call records its box, host and worktree under `~/.local/state/boxd/boxes/`; a box whose worktree is gone (or is no longer a
  git worktree top folder) is stopped, also with a run going, once two passes at least 15 minutes apart found it missing (`~/.local/state/boxd/gc.log`); a sleeping
  host is never woken, a host that is down is skipped; boxes no record names are listed as "unknown owner" and never touched; commands running over 6 hours are reported, never ended.
- `box log <run> [--pod <name>] [--host <name>] [--follow]` reads a detached run's log with `pod log`: a stopped box is no longer recreated empty by a late
  `box -- cat /job/runs/<run>.log`. `box --detach` now prints this command.
- Fixed: `pod status` and `pod report` counted active file cache as used (an idle host right after a big file copy reported `mem_free_mb=133`). Free memory is now the
  cgroup's limit minus `anon` plus `shmem` (the figure the admission already used); `group_mem_used_mb` follows. Cases changed: the free-memory case of `pod status` and the
  `group_mem_used_mb` figure of the `pod report` case.
- Fixed: `pod list` (and `pod status`, `pod report`) hid a failed engine listing: `box_rows` ran in a pipeline, so a failing `podman ps` or `msb ls` gave the other engine's boxes alone
  (a running machine missing from the list) with exit 0. A failed listing is now exit 125 with one reason line. Four contract cases.

## 0.3.0

- `box --kvm`: a container box made with it gets the host's `/dev/kvm` (`--device /dev/kvm --label boxd.kvm=1`), for QEMU on KVM
  inside a box; opt-in per box and sticky like `--user`, refused with `--vm`, when the build account may not open the device, and when the device has no access rule for it.
  `boxd-setup` installs acl-progs (Void) or acl (Debian) and gives the build account an access rule on `/dev/kvm` (`setfacl`, kept by
  `/etc/udev/rules.d/70-boxd-kvm.rules`): rootless `runc` drops the `kvm` group inside a box, the user id stays; the device stays 0660.
  Tests: ten `pod` cases and one `client` case in `contract/cases.json`, acceptance scenario 42.
- The dashboard as a docker stack for the homeserver (`dashboard/stack/`), in place of the system package that was planned: `Containerfile` (node 26.13.1 on alpine,
  the ssh client, user 10001, a health check, the service as the only process), `compose.yaml` (network `proxy` only, no published port, read-only root file system,
  all capabilities dropped, memory and process limits), `dashboard.json.example`, `make-bundle` (a reproducible tar.gz of exactly the files the stack needs) and
  `INSTALL.md` (every step, host side included). New dashboard setting `listenAnywhere`: without it a non-loopback `listen` address stays refused. Tests:
  `tests/dashboard-stack-test.sh` (builds and runs the stack, needs docker) and `tests/dashboard-bundle.test.mts`.
- Debian packages proven on a real systemd (`tests/deb-systemd-test.sh`, run inside a boxd virtual machine box; see `docs/packaging-debian.md`,
  "Proven on systemd"). Three defects found and fixed, none changes the Void behaviour: `sshd-run` looked for sshd only in `/usr/bin` (Debian has
  it in `/usr/sbin`, so `boxd-sshd.service` could never start); `boxd-sshd.service` could not start again after a plain stop while boxes were still running
  (`Device or resource busy`): it now has `DelegateSubgroup=sshd`, and `sshd-run` accepts the child cgroup as its own; every podman call of the build
  account failed on Debian with `permission denied` in `/run/user/<uid>`: `work-setup` now enables lingering for the account on systemd hosts
  (`postrm` removes it on purge). `sshd-run` also no longer prints a raw shell error on a kernel without swap support (the swap cap is skipped, said plainly).
- The dashboard page (`dashboard/web/`: `index.html`, `boxd.css`, fonts, and plain JavaScript modules the browser loads directly): the designed interface
  fed by `/api/fleet.json` (asked again every 15 seconds, drawn again only when it changed, focus, scroll, sorting and filters kept). Read only: no
  button changes a host, and where the prototype had one the page shows the command to run as copyable text. The box page reads `/api/ps` and `/api/log`.
  The service now also serves these files (GET and HEAD, a fixed list made at start, anything else 404) under a content security policy that
  allows only the page's own origin. `tests/dashboard-web.test.mts` renders every view from the fixture in node.
- The dashboard service (`dashboard/boxd-dashboard.mjs`, source `.mts`, node built-in modules only): polls each build host over ssh every
  minute (`pod report`, `pod calls`; a server on 0.2.0 is read with `pod status` and `pod list`), keeps seven days of calls, load samples
  and events in plain files under its state folder, and serves `GET /api/fleet.json`, `GET /api/ps` and `GET /api/log` on a loopback
  address; every other path is 404 and every other method 405. It never sends anything to a host that does not answer on its port, so it
  cannot wake one. The web page and the packages follow (`docs/designs/dashboard.md`, workstreams 3 and 4).
- Server 0.3.0: the read-only verbs the dashboard (`docs/designs/dashboard.md`) reads, all with no lock, no stamp and no call log line:
  `pod report` (the facts of the host, its boxes, their detached runs and its image archives, with `busy` and `mem_mb` of each box),
  `pod calls [<offset>]` (the call log in windows of at most 1 MB, whole lines, from a byte offset) and `pod log <box> <run> [<offset>]`
  (a detached run's log without starting the box). `pod status` reports version 0.3.0 and is otherwise unchanged. Needs nothing from
  the client. Formats and exit codes: `docs/pod-contract.md`, "The reading verbs".
- The call log `$BOXD_WORK/cache/calls.log` gains two columns after the refusal reason: the run id of a detached run and the first 200
  characters of the command (control characters and tabs become spaces; values passed with `--env` are never on a command line, so
  never in it). Owner decision 2026-11-13. Seven-column readers such as the usage monitor keep working (the reason is still column 7);
  readers must split on tabs and ignore extra fields. A credential written in a command's text is now kept in that log: use `box --env`.
- Keys that may only read: `/etc/boxd/view_keys` lists keys that can run only `pod status|list|ps|report|calls|log` (everything else, the
  rsync passthrough included, exits 125 `this key may only read`). The build sshd's `sshd_config` gains `ExposeAuthInfo yes` so `boxd-pod`
  knows which key logged in; with view keys listed and no such line every command is refused, loudly (the file is kept on upgrade:
  `boxd-setup --view-key <public key file>` adds the line, lists the key and allows it, then `boxctl reload`). Owner decision 2026-11-13.
- New power module setting `BOXD_IDLE_IGNORE` (addresses): connections on the build port from them are not work, so the dashboard's polls
  never keep a host awake; port 22 always counts. Owner decision 2026-11-13.

- Debian packages (`boxd`, `boxd-server`, `boxd-client`, `microsandbox-bin`) for Debian-based distributions, first target Debian 13
  (LMDE 7). `tools/build-deb` builds them with `dpkg-deb` (no root, from a checkout or a tag archive); `tools/publish-deb`
  uploads them to a Gitea Debian registry; the file list is the new Debian table of `docs/designs/layout.md`;
  `tests/deb-package-test.sh` builds and checks them inside a Debian container box. How to build, publish and install:
  `docs/packaging-debian.md`. The power module is not packaged for Debian yet (the first Debian host never sleeps).
- systemd support next to runit, one program for both: `boxctl` detects the service manager (`BOXD_MANAGER=runit|systemd` forces
  one) and calls `systemctl`/`journalctl` instead of `sv`/the log file. The units `boxd.service` and `boxd-sshd.service`
  (`server/systemd/`) run the same `run` and `finish` files as the runit services (installed as `/usr/libexec/boxd/boxd-run`,
  `boxd-finish`, `sshd-run`), which now call `systemctl` when `BOXD_MANAGER=systemd`. The build sshd runs in the cgroup of its own
  unit (`Delegate=yes`, `KillMode=process` so a plain stop never kills running builds) instead of one it makes at the
  cgroup root; it refuses to start when that cgroup is not the one `BOXD_CGROUP` names.
- New setting `BOXD_CGROUP`: the folder of the build cgroup that `boxd-pod` measures for virtual machine admission and that holds
  the caps. Default `/sys/fs/cgroup/boxd` (unchanged on Void); the Debian package enables
  `/sys/fs/cgroup/boxd.slice/boxd-sshd.service` in `/etc/boxd/boxd.conf`. `BOXD_CGROOT` stays the test hook.
- The work area works without btrfs: `work-setup` picks directory mode when the file system is not btrfs (setting
  `BOXD_WORK_FS=auto|btrfs|dir`), keeping the work area as a plain folder with a marker and a pristine copy next to it
  (`<work>-clean`); `boxd-reset` then refreshes it with `rsync` (takes as long as deleting the files; btrfs hosts keep the instant swap).
  `work-setup` skips the Void-only hardening (`/var/tmp` in memory, mail folder, `rc.conf`, `rc.local`) on systemd hosts and links
  the podman storage settings as a drop-in instead of replacing `/etc/containers/storage.conf`. `boxd-setup` installs
  `microsandbox-bin` with `apt-get` where `xbps-install` is absent, enables `boxd.service` for boot without starting it
  (the owner may need to set `BOXD_PORT` first), and tunes `zram-tools` where `zramen` is not used.

## 0.2.0

- `box --vm --size small|medium|large` (server `pod run --size`): the size of a virtual machine box. `small` is 2
  processors and 2 GB, `medium` 4 and 4 GB, `large` is `BOXD_VM_LIMITS` (4 and 8 GB by default, the machine every box
  had before; no `--size` means `large`). Sticky like engine and image: the size is recorded when the box is made
  (`jobs/<box>/.vm-size`), a later call without `--size` keeps it, naming another size is refused with exit 125
  (`box <box> is <have>, asked for <want>; add --recreate`) and `--recreate --size <size>` replaces the box at the new
  size. `--size` with a container box is refused (125); the client refuses an unknown size word (2). Owner decision
  2026-11-13. Needs a server of this version.
- Virtual machines are admitted by measured memory instead of a count: a new machine (creation or start) is admitted
  when the memory the build cgroup really uses (`anon` plus `shmem` of its `memory.stat`) plus the memory of its size
  fits the cgroup's `memory.max` (the host's memory when that reads `max`). The refusal still starts with `no room for
  another virtual machine` and now gives megabytes. `BOXD_VM_MAX` is now an optional hard ceiling (unset: none; was 3).
  When the cgroup files cannot be read the count rule with 3 applies. Known limit: overcommit; machines admitted
  while light can later fill their size together, and the cgroup's cap then ends a process in the group, usually a
  whole machine (the host stays safe).
- Several build servers: with two or more hosts set up (`box setup` for each), the first call of a worktree picks the first
  host, in the order of `~/.config/boxd/hosts.order`, that has room for the call, and the worktree stays on it (recorded in
  `boxd-host` inside the worktree's own git folder). A host that sleeps counts as having room and is never woken just to ask;
  a host that is down is skipped. A placed worktree whose host is full is refused with the exact `box --host <name> ...`
  command that moves it, never moved by itself. `--host` names a host and records it; `BOXD_HOST` is for one call.
  Every placement decision is one line in `~/.local/state/boxd/choices.log`. New: `box hosts` (state of every host) and,
  on the server, `pod status` (one line of facts: engines, load, machines used and `vm_room`, boxes, disk, memory, local
  images). The client decides virtual machine room only from the server's own `vm_room`, not from the counts. Needs a server
  of this version for the choice; a host with an older server is used only when no other host has room.
- Changed: a refusal for lack of virtual machine room now exits **75** (was 125), still with `boxd-pod: no room for another
  virtual machine (...)` on stderr, so a client can tell "nothing ran, try another host" from other refusals. The client also
  exits 75 when no host has room. Anything that tested for 125 after a full machine limit must test for 75. Owner decision
  2026-11-13. A new `~/.config/boxd/hosts.order` file is written by `box setup`; older clients ignore it.
- `box image push [--host <name>] [--vm|--container] <ref>` (server `pod image has` and `pod image load`): sends an image from the caller's
  machine to the host's store for one engine, for images of private registries. The build host never holds registry credentials: the client
  pulls `<ref>` with the caller's own login (podman, else docker), asks the host whether it already has the same image id (then nothing is
  sent), and otherwise streams `save` over ssh into `load`, with no archive file on the client. The host writes the stream to a fresh file under
  `cache/images`, loads it, checks the reference is in the store and removes the file. The reference goes through the allowed-registries list like
  `--image`. A box created with `--image <ref>` afterwards uses the pushed copy: `podman run` now says `--pull=missing` explicitly. Needs a server of
  this version. Owner decision 2026-11-13.

## 0.1.7

- `box --env <NAME>` (server `pod run --env`, repeatable): hands a credential from the caller's environment to the
  command, in both engines, foreground and detached. The value travels in ssh's own environment passing
  (`BOXD_SECRET_<NAME>`, `AcceptEnv BOXD_SECRET_*` in the build sshd's configuration), never on a command line, in a
  synced file or in the call log. Only names ending in `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD`. Needs a server
  of this version (its `sshd_config` included). Owner decision 2026-11-13.

- `box --image-file <path>` (server `pod run --image-file`): the box's image is built from a Containerfile in the worktree
  (`podman build`, output on stderr, image `localhost/built-<box>`). The box is replaced by itself when the built image
  changes (files under `/job` stay) and reused when it does not; a failed build exits 125 and keeps the old box. Virtual
  machine boxes get the new image through an archive in `cache/images`. `BOXD_REGISTRIES` does not limit `FROM` lines
  or downloads inside the build. Needs a server of this version; private registry credentials are not supported.

## 0.1.6

- `BOXD_VM_NET_ALLOW` (host setting): home-network services virtual machine boxes may reach, for example model
  servers, while the rest of the local network stays blocked. Lets work that needs podman or docker inside AND a
  service on the local network run in a vm box. Admin-set only; empty by default (no change).

## 0.1.5

- A foreground `box` call that prints nothing for 15 minutes gets the `box ps` table on stderr, every line prefixed
  `[box ps] `, repeated while the silence lasts (owner decision, from the sessions' answers). `--ps-after <minutes>` or
  `BOXD_PS_AFTER` shortens it; `0` turns it off for callers that parse stderr strictly. Not on a terminal, not for
  `--detach`. Client only; servers from 0.1.4 on answer `pod ps`.

## 0.1.4

- `box ps` (server `pod ps <box>`): the processes running in a box, oldest first, with age, processor time, working
  folder and command, for both engines. Read only. Asked for by an agent whose test run hung for two hours unseen.

## 0.1.3

- `box --pull <folder>` copies the folder itself; before, a pulled folder landed inside itself (`out/out`).
  A trailing slash is accepted. Missing parent folders are created.

## 0.1.2

- Virtual machine boxes get `/tmp` on its own sparse disk (`BOXD_VM_TMP_DISK`, default 64G, mode 1777, gone with
  the box): the guest root has about 4G free, too little for tools that need tens of GiB. Boxes made earlier keep
  the small `/tmp` until `--recreate`.
- The toolbox image has the official TypeScript compiler (`tsc` 7.0.2) next to `tsc-rs`.

## 0.1.1 (tagged, never built or published; its changes ship in 0.1.2)

- The sync skips links that point outside the worktree (`--safe-links`): a `node_modules` linked to the main
  checkout no longer dangles in the box. A dangling link synced by an older client stays until removed once.
- The sync carries exactly the files git counts as part of the worktree: tracked files under an ignore rule
  (`git add -f`), negated ignore patterns, `.git/info/exclude` and the global excludes are honoured.
- `boxd-pod` logs every `pod run` in `$BOXD_WORK/cache/calls.log` (one tab separated line: start, box, engine,
  lock wait, exit code, duration, refusal reason), for a usage monitor.
- `box --user`: a container box runs every command as an unprivileged user that owns the synced files
  (`podman --userns=keep-id`, `HOME=/job/home`, label `boxd.user=1`). Sticky; refused for virtual machine boxes.
- The toolbox image has GNU `patch`.
- `boxd-pod` passes only the client's own rsync lines: short options, `--server`, `--sender`, `--delete`, `--mkpath`,
  `--safe-links`, `.` and paths `jobs/<box>/src[/...]`. A destination outside a box or an option such as
  `--log-file=` exits 125. The race free creation of the sync folder stays.
