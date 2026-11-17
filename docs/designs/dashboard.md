# boxd dashboard: the real service behind the designed interface (design, 2026-11-13)

Status: workstreams 1 (the read-only server verbs, release 0.3.0), 2 (the collector and the service, `dashboard/`), 3 (the page, `dashboard/web/`) and 4 (a docker
stack, `dashboard/stack/`) are built and in the test runs (see "Workstream 1 as built" to "Workstream 4 as built" and "Executable acceptance"). The system
package form of workstream 4 is dropped by the owner's decision of 2026-11-14. Grounded in boxd 0.2.0 (`server/boxd-pod`, `power/boxd-idle`,
`server/boxd-reset`, `client/box.mts`, `docs/pod-contract.md`) and in an earlier prototype
(`boxd.js`, `boxd-data.js`). Points not checked on a real machine are
marked UNVERIFIED and collected at the end.

## Goal and the measurable outcome

The owner opens one page and sees the true state of every build host: which hosts are awake, which boxes exist and
what runs in them, the calls of the last day with their refusals, and the anomalies the usage monitor script reports
today. The page is the interface that was already designed; the invented sample data is replaced by live data.

How we see that it works:

- Every number on the page can be traced to a command output on a host (the field map below names it), and the
  acceptance scenarios compare the two on the real hosts.
- The dashboard never wakes a sleeping host and never delays its sleep: the power module's log on the tower shows the
  same sleep and wake times with the dashboard running as without it (scenarios 4 and 5).
- The dashboard cannot change a host: its login key is refused for every command that is not a read (scenario 1).
- A hand-made monitor script, which needs an administrator
  login and ends after 24 hours, can be retired: every anomaly it raises appears as an alert (scenario 15).

## 1. Field map: sample data to real sources

The prototype renders everything from `window.BOXD_DATA` (`boxd-data.js`), copied into one state object
(`boxd.js:16-47`). Each table lists every field a view reads. "Source today" is what a login of the build account can
already read. "New" names the smallest server addition; all additions are in the verbs of section 4. **CUT** marks a
field the design invented, or one whose only source needs an administrator login or heavy work on the host.

What already exists and needs nothing new: `pod status` (`boxd-pod:289-305`), `pod list` (`boxd-pod:260-267`),
`pod ps <box>` (`boxd-pod:270-284`). What no verb exposes today: the call log (`boxd-pod:43-52`), the job folders
(`runs/<id>.log`, `runs/<id>.pid`, `.last-used`, `.vm-size`), the build cgroup's pressure and kill counters, and the
power module's state.

### Hosts (`BOXD_DATA.hosts`; overview, hosts, host detail, capacity tables)

| Field | Shown as | Source today | New |
|---|---|---|---|
| `id` | host name | the dashboard's own host list (section 2) | none |
| `state` (`awake`, `asleep`, `waking`) | state pill | the collector's last poll: answered, or no answer from a host that sleeps (the rule of `probe`, `box.mts:326-338`) | none. `waking` is CUT (the dashboard wakes nothing); a new state `unreachable` is added for an always-on host that does not answer |
| `powerModule` | "power module on/off", sleep rules | setting `BOXD_POWER`, read by `boxd-pod` with the settings file (`boxd-pod:8-9`) | `pod report` key `power` |
| `hardware` | processor name | none | CUT (a label nobody decides by) |
| `cores` | "(8 cores)" | none | CUT; `threads` stays |
| `threads` | load meter maximum | `pod status` `cpus` (`nproc`) | none |
| `ramGiB` | "32 GiB" | `/proc/meminfo` `MemTotal`, readable by anyone | `pod report` key `mem_total_mb` |
| `addr` | address | the dashboard's host list | none |
| `bootAgo` | (state only, no view prints it) | `/proc/stat` `btime` | `pod report` key `boot` |
| `lastSeenAgo` | (not printed) | collector: time of the last answer | none; now printed as "data from ..." because a view must say how old it is |
| `awakeAgo`, `asleepSinceAgo` | "awake for", "asleep for" | collector: when the state last changed, exact to one poll interval | none |
| `load` (1, 5, 15 minutes) | load meter, "1 / 5 / 15 min" | `pod status` `load1` only | `pod report` keys `load1`, `load5`, `load15` (`/proc/loadavg`) |
| `loadHist` | trend line, 2 hours | none | collector stores one `load1` sample per poll (section 2); gaps while the host sleeps |
| `buildMemMaxGiB` | build-group memory meter maximum | cgroup `memory.max`, already read (`boxd-pod:297`) | `pod report` key `group_mem_max_mb` |
| (memory used: the prototype sums invented box numbers, `boxd.js:208`) | build-group memory meter | `anon` plus `shmem` of `memory.stat` (since 2026-11-14; it was `memory.current` minus `inactive_file`); `pod status` gives only the free part | `pod report` key `group_mem_used_mb` |
| `buildBoxLimit` | "limit per box" | setting `BOXD_LIMITS` (`boxd-pod:11`) | `pod report` key `box_mem_mb` |
| `swap.usedGiB`, `swap.totalGiB` | swap meter | `/proc/meminfo` `SwapTotal`, `SwapFree` | `pod report` keys `swap_total_mb`, `swap_used_mb` |
| `pressure.some10/some60/full10/full60` | pressure rows | cgroup `memory.pressure` (the monitor reads it, `monitor.sh:41`); the file is world readable | `pod report` keys `pressure_*` |
| `memKills` | "memory kills" | cgroup `memory.events` `oom_kill` (`monitor.sh:40`): kills since the build sshd started, not "since boot" | `pod report` key `oom_kills`; the label becomes "since boxd started" |
| `lastKillAgo` | "last ... ago" | none on the host | collector: the poll at which the counter rose |
| `lastKillBox` | link to the box | kernel log only (administrator) | CUT |
| `zswap.storedGiB`, `zswap.compressedGiB` | compressed swap, ratio | the hosts use zram, not zswap; `/sys/block/zram0/mm_stat` | CUT from the first version (two more keys later) |
| `vmInstalled` | slots widget | `pod status` `engines` | none |
| `slotsMax` | "2/3 slots", free slot counts | `pod status` `vm_max`, which is `none` since 0.2.0: machines are admitted by measured memory, not by a count (`boxd-pod:222-235`) | none. The slot cells are drawn only when `vm_max` is a number; otherwise the widget reads "2 machines running, room for another: yes/no" from `vm_used` and `vm_room` |
| `disk.totalGiB` | disk meter | `df` of the work area; `pod status` gives only the percentage | `pod report` keys `disk_total_mb`, `disk_used_mb` |
| `disk.baseGiB` | (used = base + box files) | invented split | CUT; the meter shows the measured use |
| `disk.thresholdPct` | reset threshold tick | setting `BOXD_RESET_AT` (`boxd-idle:22`), meaningful only with the power module | `pod report` key `reset_at` |
| `caches` (cargo, npm, pnpm, go, podman images, microsandbox) | "Caches by kind" | `du` over trees of 100 GiB and more: minutes of disk work per poll | CUT from the first version. Later: the `boxd` service writes the sizes once an hour and `pod report` reads that file |
| `idleTimeoutSec` | "sleeps after N min idle" | setting `BOXD_IDLE_CHECKS` times 60 (`boxd-idle:20`) | `pod report` key `idle_checks` |
| (idle countdown: the prototype simulates it, `boxd.js:1240-1261`) | "N:NN to sleep" | `/run/boxd-idle/count` and `last` (`boxd-idle:50-62`): quiet checks so far and the last busy reason | `pod report` keys `idle_count`, `idle_last` |
| `holds` (who, what, since, expires) | "keepawake holders" table | invented: `box keepawake 30m` is not a command. Real: whether the keepawake lock is held (`boxd-idle:35`) | `pod report` key `keepawake` (`held`, `free`, `none`). The table is CUT; the panel shows the busy reason and the detached runs |
| `lastResetAgo` | "last reset" | none (the reset swaps the subvolume, `boxd-reset:84`) | CUT from the first version. Later: `boxd-reset` writes a stamp |

### Boxes (`BOXD_DATA.boxes`; boxes table and cards, box detail, placement table)

| Field | Shown as | Source today | New |
|---|---|---|---|
| `name`, `engine`, `image` | name, engine, image | `pod list` columns 1, 5, 2 | none |
| `host` | host link | which host answered | none |
| (state: the prototype derives `running`, `stopped`, `failed`, `ok`, `detached` from runs, `boxd.js:175-182`) | state pill | `pod list` column 3 (`running`, `stopped`); "a run is in progress" is the `.running` lock (`boxd-pod:560-561`), which no verb reports | `pod report` box key `busy` |
| `userFlag` | "unprivileged / root" | container label `boxd.user` (`boxd-pod:405-407`) | `pod report` box key `user` |
| `lastUsedAgo` | "last used" | `pod list` column 4 (`.last-used`) | none |
| (time left: constant 1800 in `boxd.js:13`) | "time left" | setting `BOXD_TTL` (`boxd-pod:30`) | `pod report` key `ttl` |
| `worktree` | worktree path | the server never learns the path: the box name is the folder name plus a checksum, made by the client (`box.mts:88`) | CUT; the page shows the box name |
| `worktreeGone` | "worktree is gone", state `detached` | the server cannot know | CUT |
| `cpuPct` | processor meter | none without sampling inside the engines | CUT from the first version; `box ps` shows processor seconds per process |
| `memGiB` | memory meter | none | `pod report` box key `mem_mb` (virtual machine: resident memory of its machine process; container: `memory.current` of its cgroup; `-` when unreadable, UNVERIFIED for rootless containers) |
| `memLimitGiB` | memory meter maximum | `BOXD_LIMITS` for containers; the size record `.vm-size` for machines (`boxd-pod:421,438,516`) | `pod report` box keys `mem_limit_mb`, `size` |
| `cacheGiB` | "cache in use" | invented: all boxes share one cache folder (`boxd-pod:506`) | CUT |
| `diskGiB` | "box files", freed sizes | `du` of the job folder: heavy | CUT from the first version (later, with the hourly sizes) |
| `lastExit` | "failed" state | the newest finished call of that box in the call log | none (collector) |
| `runs[].id`, `.state`, `.exit` | run tabs, run pills | detached runs only: `runs/<id>.log`, `runs/<id>.pid` while it runs, last line `EXIT <code>` (`boxd-pod:541-553`). A foreground call has no run id and no log | `pod report` `run` lines |
| `runs[].cmd`, `.startedAgo` | "$ command, started ..." | the call log line of that run, which today has neither the run id nor the command | two new call log columns (section 4) |
| `ps` | `box ps` table, "possibly hung" | `pod ps <box>` | none; asked on demand when the box page is open |

### Calls (`BOXD_DATA.calls`; calls view, recent calls, statistics)

The call log has one line per finished or refused `pod run`: start in microseconds, box, engine, lock wait, exit code
or `detached`, duration, refusal reason (`boxd-pod:43-52`).

| Field | Source today | New |
|---|---|---|
| time, box, duration, lock wait, exit code, refusal reason | call log columns 1, 2, 6, 4, 5, 7 | a verb to read it: `pod calls` |
| engine (not in the design) | column 3 | shown in the table: it is there |
| `host` | which host's log | none |
| command | not logged | call log column 9 (owner decision 2) |
| run id | not logged | call log column 8 |
| a call that still executes (`exitCode: null`, "running") | a foreground call is logged only when it ends (`boxd-pod:569`) | CUT as a row of the calls table: a call in progress shows on its box (`busy`) and in `box ps`. A detached run has its line at once, with `detached` |
| refusal: "all exit 125" (`boxd.js:796`) | wrong since 0.2.0: no room is exit 75 (`boxd-pod:56`) | the view prints each refusal's own code |
| statistics: calls in the last 60 minutes, median, 95th percentile, longest lock wait, distribution | computed in the browser from the calls it has (`boxd.js:465-484`) | none: the service serves the calls of the last 24 hours |

### Images, services, alerts, logs

| Field | Source today | New |
|---|---|---|
| `images[].name`, `.archive` | `pod status` `images` (`boxd-pod:301`) | none |
| `images[].tag` | derived: `localhost/<name>:latest` | none |
| `images[].sizeGiB`, `.built` | size and change time of the archive file | `pod report` `image` lines |
| `images[].digest` | none (`podman` could tell, for one store only) | CUT |
| "used by N boxes" | derived from the boxes | none |
| `tools` (tool versions per image) | none: needs a run inside the image | CUT from the first version. Later: `images-build` writes a versions file next to the archive |
| `services[].name`, `.role` | fixed: `boxd`, `boxd-sshd`, `boxd-power` | none |
| `services[].status` | `sv status` needs an administrator. Derived: a host that answers has `boxd` and `boxd-sshd` up; `boxd-power` follows the `power` setting | none; a sleeping or silent host shows `unknown` |
| `services[].pkg` | `pod status` `version` (one package version for all three, `docs/packaging.md`) | none |
| `services[].upAgo` | none without an administrator | CUT |
| `alerts[]` | the monitor script's anomalies (`monitor.sh:55-67`), computed by an administrator login | the collector computes them from the same data, read through the new verbs (rules in section 2) |
| `alerts[].growth` and the "disk grows faster than usual" alert | invented | CUT; replaced by a plain threshold alert |
| `alerts[].acked` | invented state | kept in the browser's own storage (section 3) |
| `logs[run].lines` (level, message), `.more`, `.end` | `runs/<id>.log` on the host: plain text, last line `EXIT <code>` | `pod log`. The `INF/WRN/OK/ERR` levels are invented and CUT: the viewer shows the lines as written |
| `version` | the hosts' `version` | none; the status bar shows the newest, the services view flags a host on an older one |

## 2. Architecture

### Constraints the code imposes

1. **Any ssh through a client alias wakes a sleeping host**: `box setup --wake` installs an ssh hook that runs
   `box-wake` (`docs/pod-contract.md`, "Host choice"). The dashboard must not use those aliases.
2. **An ssh connection on the build port counts as work.** `boxd-idle` samples the established connections once a
   minute (`boxd-idle:31`) and a hit sets the quiet count back to zero (`boxd-idle:55`). A poll lasts well under a
   second, so most samples miss it, but the host sleeps only after 20 misses in a row, and a poller with the same
   60 second period can fall into step with the sampler and hit every time. A dashboard that polls can therefore
   keep the tower awake for good. This is the main design risk; decision 5 removes it.
3. **A session of the build account makes `boxd-reset` refuse** (`boxd-reset:26-27`) unless forced. A poll that
   coincides with a reset gives "refused, build has an ssh session"; the owner runs it again. Accepted, and stated in
   the page's reset text.
4. **Every command of the build account goes through `boxd-pod`** (`sshd_config:20`), and every key in
   `/etc/ssh/authorized_keys/<account>` may run boxes today. `ForceCommand` in the sshd settings overrides a
   per-key `command=`, so a key cannot be limited there.
5. **Placement records live on the agents' machines** (`~/.config/boxd/hosts.order`, `~/.local/state/boxd/choices.log`,
   `box.mts:255,354`), not on the machine that serves the dashboard. The dashboard shows where each box is (each
   host says so) but not why a worktree was placed there. CUT.

### Alternatives

**A. A collector service on the homeserver (recommended).** One node process, started by the machine's service
manager, under its own unprivileged account. Every 60 seconds it asks each host over the build account's ssh, with
its own key that may only read, stores what it needs for history in plain files, and keeps one JSON (JavaScript
Object Notation) document in memory. It serves that document and the static front end on the loopback address; the
a reverse proxy on the same machine adds the encrypted connection and the basic authentication it already
uses for other services.

**B. No collector: ask the hosts when the browser asks.** A small server that runs the ssh calls on each page
request. Nothing stored, nothing running between visits. Rejected: no load history, no alert while nobody looks, the
calls statistics need the log read again on every request, every open tab multiplies the ssh connections, and a
host that has gone to sleep has no last known values.

**C. The hosts push.** The `boxd` service on each host posts its report to the dashboard once a minute. No key on
the homeserver, no incoming connection on the hosts, so constraints 2 and 3 vanish, and a sleeping host is simply
silent. Rejected for the first version: each host needs a credential for the dashboard and its address, the service
loop grows a network client, and the on-demand reads (`box ps`, a run's log) still need a way in. It stays the
fallback if decision 5 is answered "no change to the power module".

**D. The collector of alternative A on the workstation.** Same code; it would also see `choices.log`.
Rejected as the home of the service: the workstation is not always on and has no proxy. It is the development
setup: the service starts anywhere with a host list and a key.

### Recommendation in detail (alternative A)

- **Where:** the homeserver, account `boxd-dashboard`, state in `/var/lib/boxd-dashboard`, settings in
  `/etc/boxd/dashboard.json`: the listen address (default `127.0.0.1:8377`), the poll interval, and the hosts in the
  order of the `hosts.order` of the agent's machine: name, address, port, build account, and whether the host sleeps. The homeserver,
  once it is a build host, is one more entry (address `127.0.0.1`).
- **How it reaches a host:** `ssh -F /dev/null -i <key> -o BatchMode=yes -o ConnectTimeout=3 -o IdentitiesOnly=yes
  -p <port> <account>@<address> pod ...`. By address, with no settings file: no alias, no wake hook, so it cannot
  wake a host by construction (constraint 1). No connection sharing (`ControlMaster`): a kept connection would be
  an established connection on the build port forever (constraint 2).
- **The key may only read.** The host learns which key logged in (`ExposeAuthInfo yes` in the build sshd's
  settings) and `boxd-pod` refuses every command but the reads for keys listed in `/etc/boxd/view_keys`
  (section 4). A stolen dashboard key can read build logs and nothing more.
- **One poll of one host:**
  1. A plain connection to the address and port, 3 seconds at most (what `answers` does, `box.mts:308`). No answer:
     the host is `asleep` when it is marked as one that sleeps, else `unreachable`. Nothing else is sent. A wake
     packet is never sent: the collector has no code for it.
  2. `pod report`. Exit 125 means a server older than 0.3.0: fall back to `pod status` and `pod list`, and mark the
     host "status and box list only". An ssh failure (exit 255) after the port answered: `unreachable`, detail
     "ssh refused".
  3. `pod calls <next>` with the offset the last answer gave, repeated while the answer says more is waiting.
  Hosts are polled in parallel and independently: one slow host delays only its own row.
- **A sleeping host is shown with its last known values**, dimmed, with "asleep since" and "data from" times, as the
  design already draws for `asleep` (`boxd.js:384-388`). The last answer is kept on disk, so a restart of the service
  does not lose it.
- **On demand, never polled:** `pod ps <box>` when a box page is open, and `pod log <box> <run> <offset>` when a run's
  log is open, each only while the host is `awake`, at most one ssh per host at a time, an answer reused for 5
  seconds. Entering every box every minute would be load nobody asked for.
- **What is stored** (plain text, appended, one folder per host, no database): `calls.log` (the host's lines as
  received, same format), `cursor` (the next offset), `load.log` (time and `load1` per poll), `events.log` (state
  changes and rises of the kill counter), `last.report`. Kept for 7 days, trimmed once a day by rewriting the file.
  At one line per call and per minute this stays in the low megabytes.
- **What the browser gets:** one document, `GET /api/fleet.json`, shaped like `BOXD_DATA` (same top-level keys, same
  field names where a source exists) so `boxd.js` changes least. Two differences, both forced: times are absolute
  (milliseconds since 1970, the form `boxd.js` already uses inside its state) because "seconds before page load"
  has no meaning for a page that reloads its data, and calls are objects, not positional arrays. The page asks again
  every 15 seconds (`If-None-Match`, so an unchanged document costs one small answer). `GET /api/ps?host=&box=` and
  `GET /api/log?host=&box=&run=&from=` serve the two on-demand reads. Nothing else is served; every other method
  than `GET` is answered 405.
- **Authentication:** none in the service. It listens on the loopback address only; the reverse proxy's basic
  authentication is the door, as for your other pages. Nothing new to manage.
- **Language and runtime:** TypeScript compiled with `tsc-rs`, run as the emitted JavaScript on node, like the
  client. Built-in modules only (`node:http`, `node:child_process`, `node:fs`, `node:net`). No framework and no
  dependency, on the server or in the page; the front end stays plain files as the prototype is.
- **Structure for testing:** everything that decides is in pure functions of `dashboard/fleet.mts` (`fleet`,
  `parseAnswer`): text in, document out, the time as an input. The part with timers, ssh and files is a thin loop
  around them.

### Alert rules

The first five are the monitor script's own (`monitor.sh:55-67`); the last two exist because the dashboard sees more
than one host. An alert groups its occurrences of the last 24 hours and carries a count.

| Kind | Raised when | From the monitor |
|---|---|---|
| `refused` | a call was refused: exit 125 with a reason, or exit 75. Boxes named `agent-*` are left out (acceptance test boxes refuse on purpose) | yes (`monitor.sh:57-59`), extended to exit 75 |
| `lock-wait` | a call waited more than 10 000 milliseconds for its box's lock | yes (`monitor.sh:60`) |
| `memory-kill` | the build group's kill counter rose between two polls | yes (`monitor.sh:65`) |
| `load` | the 1-minute load is above the thread count | yes (`monitor.sh:67`), with the host's own thread count instead of 16 |
| (machine refused while more than 8192 megabytes were free) | CUT: since 0.2.0 the refusal itself states the measured megabytes, so the `refused` alert carries the evidence | `monitor.sh:61` |
| `disk` | the work area is at or above the reset threshold | new |
| `unreachable` | an always-on host does not answer. A host that sleeps is never an alert | new |

## 3. Actions: the first version only reads

Reading is safe. Every drawn button changes a live host that other agent sessions are using at that moment, and the
page sits behind one shared password. **The first version draws no action button.** Where the design has one, the
page shows the command the owner can run, so nothing is hidden. One state change remains and touches no host:
acknowledging an alert, kept in the browser's own storage (an alert that happens again comes back).

| Drawn button | First version | What it needs later |
|---|---|---|
| Wake a host | CUT | The collector sends the wake packets itself (the logic of `box-wake`; card addresses in its settings; the homeserver must be on the same network segment as the host, UNVERIFIED). No server verb. One click, no confirmation: waking costs only power |
| Sleep a host | CUT | Only root can suspend (`boxd-idle:74`). A request file the power service honours when the host is quiet. Low value: the host sleeps by itself |
| Power module switch | CUT, for good | It edits `/etc/boxd/boxd.conf` and restarts a service as root. Stays a host command |
| Stop a box | CUT | `pod stop <box>` exists (`boxd-pod:307-311`): it removes the box and ends what runs in it; files stay. Needs a second key that is not limited to reads, a `POST` checked against cross-site request attacks (same-origin check and a token from the document), and a confirmation that names the runs it ends |
| Recreate a box | CUT | There is no verb: `--recreate` is an option of a call with a command. Leave it to `box --recreate` |
| Remove a box (delete its files) | CUT | No verb deletes one job folder; only a reset does. A new verb, and the same safeguards as "stop" |
| End a run | CUT | A new verb that signals one detached run's process group (`term_runs` does it for all, locally, `boxd-pod:315-324`) |
| Service start, reload, stop | CUT, for good | `boxctl` as root. The services view is information only |
| Reset a host, reset all | CUT | `boxd-reset` as root; it kills every session's work. The reset view explains what a reset loses and keeps and prints the command. Its two checkboxes are corrected: `boxd-reset work` always removes the box files and keeps the caches, `boxd-reset all` also empties the caches (`boxd-reset:2-5`); "keep box files" does not exist |
| Acknowledge, reopen an alert | kept, in the browser | Stored in the service only if the owner wants it shared between browsers |

Who may act, later: the proxy knows one user. Until it knows more, any action is the owner's, and each one is
written to a log of the service with the time and the command sent.

## 4. Contract

### Additions to `docs/pod-contract.md` (server 0.3.0)

To add to the table under "Commands". All three are read only: no lock, no `.last-used` stamp, no call log line,
no engine call that starts, stops or changes anything. Extra words: exit 125, `boxd-pod: unknown command`.
Unknown values are a dash. A server older than these verbs answers `unknown command` (exit 125).

**`pod report`**: the facts of the host, its boxes, their detached runs and the local image archives, in one answer.
Lines of tab separated words; the first word says what the line is, the others are `key=value`, in this order:

- one `host` line: `version`, `engines`, `cpus`, `load1`, `load5`, `load15` (`/proc/loadavg`), `boot` (epoch seconds,
  `btime` of `/proc/stat`), `mem_total_mb`, `mem_avail_mb`, `swap_total_mb`, `swap_used_mb` (`/proc/meminfo`, or the
  file named by the test hook `BOXD_MEMINFO`; megabytes are kilobytes divided by 1024, rounded down),
  `group_mem_max_mb`, `group_mem_used_mb` (the build cgroup: `memory.max`, and `anon` plus `shmem` of `memory.stat` plus `memory.swap.current` since 0.4.8,
  the rule of `mem_free_mb`), `pressure_some10`, `pressure_some60`, `pressure_full10`, `pressure_full60`
  (`memory.pressure`), `oom_kills` (`oom_kill` of `memory.events`), `vm_used`, `vm_max`, `vm_room` (exactly as in
  `pod status`), `vm_mem_mb` (memory of a machine of the default size), `box_mem_mb` (the `--memory` of
  `BOXD_LIMITS`), `disk_pct`, `disk_total_mb`, `disk_used_mb` (`df` of the work area), `ttl` (`BOXD_TTL`),
  `power` (`on` or `off`, `BOXD_POWER`), and, a dash each when the power module is off: `idle_checks`
  (`BOXD_IDLE_CHECKS`), `idle_count` and `idle_last` (the files `count` and `last` of the power module's state
  folder, `BOXD_IDLE_STATE`), `reset_at` (`BOXD_RESET_AT`); last `keepawake`: `held`, `free`, or `none` when the
  lock file does not exist.
- one `box` line per box, sorted by name: `box`, `engine`, `image`, `state` (`running` or `stopped`, as `pod list`),
  `last_used` (epoch seconds, 0 when never), `user` (`yes`, `no`; a dash for a virtual machine), `size` (`small`,
  `medium`, `large`; a dash for a container), `mem_limit_mb`, `mem_mb` (a dash when stopped or unreadable), `busy`
  (`yes` while a foreground or detached run holds the box's `.running` lock, tested without waiting, as the reaper
  does), `runs` (detached runs still running).
- `run` lines, by box, then id: `box`, `id`, `state` (`running` while the pid record exists, else `ended`), `exit`
  (the code of the last line `EXIT <code>`; a dash while running), `bytes` (size of the log), `changed` (epoch
  seconds of its last write). Listed: every running run and, per box, the three ended runs with the greatest ids
  (an id starts with its date and time, so these are the newest).
- one `image` line per archive in the images folder: `name`, `bytes`, `built` (epoch seconds of the file).

`pod status` and `pod list` stay as they are: the client's host choice reads `pod status`, and it must stay one
short line.

**`pod calls [<offset>]`**: the call log from a byte offset. First line `calls`, `size=<bytes of the log>`,
`from=<offset really used>`, `next=<offset after the last line sent>`; then the log's lines, unchanged. Only complete
lines are sent (a line being written waits for the next call). One answer carries at most 1 048 576 bytes of lines
(test hook `BOXD_READ_MAX`), cut at a line end; `next` below `size` means "ask again from `next`". An offset greater
than the size (the log was emptied by `boxd-reset all`) reads from 0. Without an offset: the last 1 048 576 bytes,
from a line start; this is the first contact with a host whose log is huge. No log: `size=0 from=0 next=0`. An
offset that is not a number of at most 18 digits: exit 125, `boxd-pod: bad offset`.

**`pod log <box> <run> [<offset>]`**: a detached run's log, read from the job folder on the host (the box need not
run, and is not started, unlike `box --no-sync cat /job/runs/<id>.log` today). First line `log`, `size`, `from`,
`next`, `state` (`running` or `ended`), `exit`; then the bytes, with the rules of `pod calls` for the offset, the
limit and the missing offset. No such run: exit 125, `boxd-pod: no run <run> in box <box>`. A bad box name or run
id: exit 125, `boxd-pod: bad box name`, `boxd-pod: bad run id`.

**The call log gains two columns** (under "Activity, cleanup and reset"): column 8 is the run id of a detached run
(empty otherwise), column 9 the command: the decoded words joined by spaces, tabs and newlines as spaces, cut to
200 characters; empty for a refusal made before the command is decoded and for `pod image`. Old lines keep seven
columns; a reader accepts seven to nine. The values handed over with `--env` never appear in a command, as today.

**Keys that may only read** (new section): the build sshd's settings gain `ExposeAuthInfo yes`, so `boxd-pod` finds
the key that logged in (`SSH_USER_AUTH` names a file with a line `publickey <type> <key>`). `/etc/boxd/view_keys`
(test hook `BOXD_VIEW_KEYS`) lists keys, one `<type> <key> [comment]` per line. A login with a listed key may run
`pod status`, `pod list`, `pod ps`, `pod report`, `pod calls`, `pod log`; everything else, the rsync passthrough
included, exits 125 with `boxd-pod: this key may only read` before anything is touched. Other keys keep every
command. When the file lists a key and sshd did not say which key logged in, every command of every key is refused
(`boxd-pod: view keys are set but the login key is hidden; add ExposeAuthInfo yes to the build sshd`): the settings
file `/etc/boxd/sshd_config` is kept on upgrade, so an old one must fail closed, loudly, not open.
`boxd-setup --view-key <file>` adds a key to the allowed keys and to the list.

**The power module** (under "Activity"): setting `BOXD_IDLE_IGNORE`, addresses (words). An established connection on
the build port from one of them is not work for `boxd-idle`. Connections on port 22 always count. Empty by default.

### The document the service serves (`GET /api/fleet.json`)

Schema, in TypeScript notation. Times are milliseconds since 1970. Sizes are GiB, megabytes divided by 1024 and
rounded to two decimals. `null` means "this host did not say" (asleep before it was ever seen, or an older server).

```ts
type Fleet = {
  schema: 1;
  generatedAt: number;
  version: string;                       // the newest server version among the hosts; "" when none answered yet
  hosts: Host[];                         // in the order of the settings file
  boxes: Box[];                          // host order, then name
  calls: Call[];                         // started in the last 24 hours, newest first, at most 2000
  callsCut: boolean;                     // true when more than 2000 were left out
  images: Image[]; services: Service[]; alerts: Alert[];
};
type Host = {
  id: string; state: "awake" | "asleep" | "unreachable"; detail: string;   // detail: "", "no answer", "ssh refused", "server 0.2.0: status and box list only"
  sleeps: boolean; addr: string; version: string | null;
  report: boolean;                       // false: an older server, only pod status and pod list were read
  seenAt: number | null; sinceAt: number; stale: boolean;   // last answer; start of the current state; true when not awake
  powerModule: boolean | null; threads: number | null; ramGiB: number | null; bootAt: number | null;
  load: [number, number | null, number | null] | null; loadHist: number[];   // loadHist: load1 of the last 2 hours, oldest first
  memAvailGiB: number | null; buildMemMaxGiB: number | null; buildMemUsedGiB: number | null; buildMemFreeGiB: number | null;
  boxMemGiB: number | null; vmMemGiB: number | null;
  swap: { usedGiB: number; totalGiB: number } | null;
  pressure: { some10: number; some60: number; full10: number; full60: number } | null;
  memKills: number | null; lastKillAt: number | null;
  vmInstalled: boolean; vmUsed: number | null; slotsMax: number | null; vmRoom: boolean | null;   // slotsMax null: no count ceiling
  disk: { pct: number; totalGiB: number | null; usedGiB: number | null; thresholdPct: number | null } | null;
  ttlSec: number | null;
  idle: { timeoutSec: number; quietSec: number; busy: string | null } | null;   // null: power module off or unknown; busy: ssh, load, keepawake, no-wake-card
  keepawake: boolean | null;
};
type Box = {
  name: string; host: string; engine: "container" | "vm"; image: string; state: "running" | "stopped";
  userFlag: boolean | null; size: "small" | "medium" | "large" | null;
  lastUsedAt: number | null; ttlAt: number | null; memGiB: number | null; memLimitGiB: number | null;
  busy: boolean | null; lastExit: number | null;
  runs: { id: string; state: "detached" | "exited"; exit: number | null; startedAt: number | null; cmd: string | null; logBytes: number; changedAt: number }[];
};
type Call = { at: number; host: string; box: string; engine: string; cmd: string | null; dur: number; lock: number;
  exit: number | null; reason: string | null; run: string | null };   // exit null: a detached run was started
type Image = { host: string; name: string; tag: string; archive: string; sizeGiB: number | null; builtAt: number | null; usedBy: number };
type Service = { host: string; name: "boxd" | "boxd-sshd" | "boxd-power"; version: string | null; status: "active" | "inactive" | "unknown" };
type Alert = { id: string; kind: "refused" | "lock-wait" | "memory-kill" | "load" | "disk" | "unreachable"; severity: "warning" | "danger";
  host: string; box: string | null; sinceAt: number; lastAt: number; count: number; title: string; detail: string; action: string };
```

The real example is `tests/fixtures/dashboard/fleet.json`: the document for three hosts (the tower on 0.3.0 and
awake, laptop on 0.2.0, the homeserver not answering), computed from the recorded answers beside it. It is the
expected value of `tests/dashboard-data.test.mts`, so the example and the contract cannot drift. One piece of each
kind, copied from it:

```json
{"id":"tower","state":"awake","detail":"","sleeps":true,"addr":"192.0.2.72","version":"0.3.0","report":true,
 "seenAt":1794571198000,"sinceAt":1794559800000,"stale":false,"powerModule":true,"threads":16,"ramGiB":31.24,
 "bootAt":1794218400000,"load":[17.42,9.1,6.85],"loadHist":[9.2,16.8,17.1,17.42],"memAvailGiB":8.91,
 "buildMemMaxGiB":26.55,"buildMemUsedGiB":18.75,"buildMemFreeGiB":7.8,"boxMemGiB":12,"vmMemGiB":8,
 "swap":{"usedGiB":1.2,"totalGiB":8},"pressure":{"some10":2.31,"some60":1.12,"full10":0.4,"full60":0.18},
 "memKills":1,"lastKillAt":1794561600000,"vmInstalled":true,"vmUsed":2,"slotsMax":null,"vmRoom":false,
 "disk":{"pct":71,"totalGiB":953.87,"usedGiB":677.25,"thresholdPct":85},"ttlSec":1800,
 "idle":{"timeoutSec":1200,"quietSec":0,"busy":"load"},"keepawake":true}

{"name":"acme-api-3340981172","host":"tower","engine":"vm","image":"docker.io/library/rust:1.83","state":"running",
 "userFlag":null,"size":"medium","lastUsedAt":1794570986000,"ttlAt":1794572786000,"memGiB":3.1,"memLimitGiB":4,
 "busy":false,"lastExit":null,"runs":[{"id":"20261113-110800-9f3c","state":"detached","exit":null,
 "startedAt":1794568080000,"cmd":"cargo test --release -p oracle","logBytes":48211,"changedAt":1794571190000}]}

{"at":1794570180000,"host":"tower","box":"acme-web-1923847561","engine":"container","cmd":"pnpm test","dur":12,
 "lock":0,"exit":null,"reason":null,"run":"20261113-114300-77aa"}

{"id":"refused|tower|acme-wave19-4007723605|","kind":"refused","severity":"warning","host":"tower",
 "box":"acme-wave19-4007723605","sinceAt":1794565800000,"lastAt":1794566400000,"count":2,
 "title":"2 calls of box acme-wave19-4007723605 refused on tower",
 "detail":"no room for another virtual machine (24100 MB in use + 8192 MB asked > 27188 MB cap); wait for one to end or stop one",
 "action":"Wait for a virtual machine to end, stop one, or place the worktree on another host with box --host."}
```

`GET /api/ps?host=<name>&box=<box>` answers `{ "at": <time>, "ps": [[pid, ageSec, cpuSec, folder, command], ...] }`,
the array form the design's table already reads (`boxd.js:727-736`). `GET /api/log?host=&box=&run=&from=<offset>`
answers `{ "size", "from", "next", "state", "exit", "text" }`. Both answer 409 with a one-line reason when the host
is not awake, and 400 for a name that does not match the server's own patterns.

## 5. Workstreams, their seams, and the build order

One workstream at a time; each is built, reviewed, merged and run before the next starts. Each seam has a contract
test that both sides pass with their real code.

1. **Server verbs (release 0.3.0). BUILT 2026-11-14, see "Workstream 1 as built" below.** `pod report`, `pod calls`, `pod log`, the two call log columns, keys that may
   only read with `ExposeAuthInfo` and `boxd-setup --view-key`, `BOXD_IDLE_IGNORE` in `boxd-idle`; the contract
   document, `boxd.conf`, `CHANGELOG.md`, the skill where it names the call log.
   Seam: the text a host answers. Contract test: 31 cases (first `contract/cases-dashboard.json`, now in `contract/cases.json`) and block 7 of
   `tests/boxd-idle-test.sh`, written now. Add as script rules while building: `busy=yes` while a run holds the lock
   (a fifo, as the reap rules do) and `mem_mb` of a running box.
   Then on the real hosts: scenarios 1, 2, 5, 11.
2. **Collector and service. BUILT 2026-11-14, see "Workstream 2 as built" below.** (`dashboard/fleet.mts`, `dashboard/boxd-dashboard.mts`, emitted `.mjs` committed like
   the client's). Seam with the server: the first step replaces the typed fixtures `tower.report` and
   `tower.calls` by answers captured from the real `server/boxd-pod` under the fakes, as
   `tests/box-client.test.mts` does for the status line; the expected document is then recomputed and reviewed.
   Seam with the browser: `fleet.json`. Contract test: `tests/dashboard-data.test.mts`, written now. Add while
   building: the poll loop against a fake `ssh` on `PATH` (no ssh is spawned for a host whose port does not answer;
   exit 125 falls back to `pod status` and `pod list`; the cursor survives a restart), with fifos, no clocks.
   Then on the real hosts, from the workstation first: scenarios 3, 4, 6, 9, 10, 14.
3. **Front end** (`dashboard/web/`: the prototype's `index.html`, `boxd.css`, fonts, and `boxd.js` adapted).
   Changes to `boxd.js`: the state is built from `fleet.json` and rebuilt on every poll while route, sorting,
   filters and scroll stay; the mutating actions (`boxd.js:1024-1173`), the simulated idle countdown and the
   invented log lines (`boxd.js:1240-1293`) go; `usage()` reads the host's measured memory, disk and machine count
   instead of summing invented box numbers (`boxd.js:205-217`); the slots widget handles "no count ceiling"; a
   state `unreachable`; "last known" marking from `stale`; the cut fields and buttons of sections 1 and 3 leave the
   views; the status bar reads "boxd <version>, data from <time>, read only".
   Seam: the same `fleet.json`. Contract test, to write first in this workstream: a node test that builds the state
   from `tests/fixtures/dashboard/fleet.json` and renders every view to its string without a browser, asserting that
   none throws and that each shows a value only the fixture has. This needs the views to be callable without a page,
   so the file is split into a pure part (state and views) and the part that touches the page.
   Then scenarios 7, 8, 12, 13.
4. **Packaging. REPLACED 2026-11-14 by a docker stack, see "Workstream 4 as built"; the system package described here is not built.** Not edited here. What a package `boxd-dashboard` needs, for the Void template and for the Debian
   packaging on branch `debian-packaging` (the homeserver is Debian, so that one is the first to be used):
   - files: `/usr/lib/boxd-dashboard/*.mjs`, `/usr/share/boxd-dashboard/web/` (page, style, script, fonts),
     `/usr/bin/boxd-dashboard` (a shim like `client/box`), an example `/etc/boxd/dashboard.json` kept on upgrade;
   - depends on `nodejs` and `openssh` (the client program only); not on `boxd-server` or `boxd-client`;
   - a system account `boxd-dashboard` with home `/var/lib/boxd-dashboard` (state and its ssh key);
   - a service: a systemd unit on Debian, a runit service on Void, running the shim as that account;
   - `docs/designs/layout.md` gains the package's table first, as for the others;
   - not packaged: the reverse proxy entry and the key exchange (`boxd-setup --view-key` on each host); the
     dashboard's own setup prints both.
   Then scenario 12 again through the public address, and 15 over a day.

### Workstream 1 as built

Built as specified in section 4; `contract/cases-dashboard.json` (31 cases) moved into the pod list of `contract/cases.json` unchanged
(the file is gone; its two `pod status` neighbours that expected version 0.2.0 now expect 0.3.0) and block 7 of `tests/boxd-idle-test.sh` runs in
the default run; both pass, and no case was loosened. Added as script rules in `tests/contract-pod-test.sh`: `busy=yes` while a run holds the
lock (a fifo, no clock), `mem_mb` of a running container and of a running machine, the call log under control characters, tabs, a long
command and an `--env` value, windows that cross a line longer than the limit, and the view key rules. The real-host scenarios of this
workstream are 38 (design scenario 1), 39 (2), 40 (5) and 41 (11) of `tests/pod-acceptance.sh`. Deviations from the text above, each small:

- **`mem_mb` of a container** is `memory.current` of the cgroup that holds the container's init process (the id comes from `podman inspect`
  `{{.State.Pid}}`, the cgroup from `/proc/<id>/cgroup`), because no other place of a rootless container's cgroup is known. New test hook
  `BOXD_PROC` (default `/proc`) next to `BOXD_MEMINFO`. Still UNVERIFIED on the real hosts: scenario 39 fails there if the figure is a dash.
- `group_mem_max_mb` is a dash when `memory.max` reads `max` (no cap), and `group_mem_used_mb` is still given.
- `runs/dockerd.log` (the docker daemon's log inside a machine box) is not listed as a run.
- A single line longer than `BOXD_READ_MAX` is cut at the limit instead of blocking the reader forever (the call log's lines are at most
  about 300 bytes, a run's log can have any line).
- The view keys list fails closed in one more case: when it exists and the build account cannot read it, every command is refused
  (`boxd-pod: view keys cannot be read`), because an unreadable list would otherwise mean "no key is limited". A list with only comments
  limits nobody.
- `boxd-setup --view-key <file>` is a mode of its own (it does only that, after the first full run) and every full run also puts the listed
  keys back into the allowed keys, since `--key` replaces that file. It also adds `ExposeAuthInfo yes` to `/etc/boxd/sshd_config` when it is
  missing, as decision 4 says. Test: `tests/boxd-view-key-test.sh` (new hooks `BOXD_ETC` and `BOXD_AUTH_DIR`, for the scratch folder).
- `pod report` takes its first six words from `pod status` itself (one source of truth, so scenario 2 cannot drift), at the cost of one more
  `podman ps` and `msb ls` per report.
- The command's first 200 characters are counted by bash in the locale of the login: a multi-byte character can be cut in the middle.

### Workstream 2 as built

Files: `dashboard/fleet.mts` (pure: `fleet`, `parseAnswer`, `parseReport`, `parseStatus`, `parseList`, `parseCalls`, and the server's name patterns `BOX_RE`, `RUN_RE`),
`dashboard/boxd-dashboard.mts` (settings, poll loop, state files, http), their emitted `.mjs` and `dashboard/tsconfig.json`. Tests:
`tests/dashboard-data.test.mts` (the seam with the browser; assertions unchanged, no pending switch), `tests/dashboard-service.test.mts` (22 cases: the
poll loop against a fake `ssh` on `PATH`, the state files, the http side, the settings, the stale emitted file) and `tests/dashboard-capture.sh`
(the seam with the server). Start by hand: `node dashboard/boxd-dashboard.mjs <settings.json>` (or `BOXD_DASHBOARD_SETTINGS`; default `/etc/boxd/dashboard.json`).

The seam with the server: `tower.report` and `tower.calls` are no longer typed. `tests/dashboard-capture.sh` runs the real `server/boxd-pod` against a
scratch work area with fake podman, msb, pgrep, nproc and df (the technique of `tests/contract-pod-test.sh`): the boxes, run folders, cgroup files,
memory file, power state and image archive are made as the host would hold them, one run holds the box's lock and the keepawake lock, and the script writes
what `pod report` and `pod calls` printed. A test in `dashboard-data.test.mts` runs it again and compares, so the fixtures cannot drift from the server.
Result: the captured answers are byte for byte the typed ones, so `fleet.json` did not change. The typed values were right; what the capture adds is that the
server really prints them. Two things of the real machine change on every run and are pinned afterwards, by key name on the `host` line: `load1`, `load5`,
`load15` (`/proc/loadavg`) and `boot` (`/proc/stat`), neither of which has a test hook. The call log is the host's own file, so its lines are seeded (fixed
start times; the logging itself is tested by `tests/contract-pod-test.sh`) and `pod calls` frames them; the fixture is the body of that answer.

The poll follows the design: a plain connection first (3 seconds), nothing else sent to a host that does not answer (a host that sleeps is `asleep`, any other
is `unreachable` with an alert); then `pod report`; exit 125 with `unknown command` falls back to `pod status` and `pod list`; then `pod calls` from the stored
offset, window by window. Hosts are polled in parallel; a failure of one (ssh, or a state folder that cannot be written) is logged and does not stop the others.
Deviations and additions, each small:

- **Settings.** One JSON file; unknown settings are refused (a typo is not ignored). Keys: `listen` (default `127.0.0.1:8377`; only a loopback address is
  accepted, because the service has no login of its own, unless `listenAnywhere` is true: added in workstream 4, for a container), `pollSeconds` (default 60, 5 to 3600), `stateDir` (default `/var/lib/boxd-dashboard`) and the hosts:
  `name` (the pattern of a box name, 32 characters at most), `address` (a name or address that cannot start with a dash, so never an ssh option), `port`,
  `account`, `keyFile` (absolute, must exist), `sleeps` (default false). On a bad file the program prints one line and exits 2.
- **ssh arguments.** `-F /dev/null -i <key> -o BatchMode=yes -o ConnectTimeout=3 -o IdentitiesOnly=yes -o ControlMaster=no -o ControlPath=none
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=<stateDir>/known_hosts -p <port> -- <account>@<address> <command>`, started with an argument array,
  20 seconds at most, 4 MiB of answer at most. The design's list had no host key option: with `-F /dev/null` and `BatchMode`, a host never seen before would be
  refused, so the first key a host shows is recorded in the state folder and a changed key is refused afterwards.
- **No static files.** The design says the service also serves the front end; that is workstream 3. Today it serves `/api/fleet.json`, `/api/ps` and `/api/log`;
  everything else is 404, every method but GET and HEAD is 405. `/api/fleet.json` has an entity tag and answers 304 to `If-None-Match`; on a first start it answers
  503 until the first poll has finished (after a restart it serves the stored history at once).
- **On-demand reads.** 400 for a host, box, run or offset that does not match its pattern (nothing reaches ssh), 404 for a host that is not in the settings or for
  `no run` or `no box` (the host's exit 125), 409 when the host was not awake at the last poll, 502 when ssh fails. One ssh per host at a time (the second waits),
  an answer reused for 5 seconds, no state change on the host (`pod ps` and `pod log` only).
- **Stored files** in `<stateDir>/<host>/`: `calls.log`, `cursor`, `load.log`, `events.log`, `last.report` (or `last.status` and `last.list`), `host.json`; all but
  the two appended logs are written to a fresh name and renamed. `cursor` holds the offset to ask for and the length of our copy of the call log: a copy longer
  than that (a window stored, then a stop before the cursor was written) is cut back at the next start, so no call is stored twice. A missing cursor discards
  the copy. Seven days are kept: at every start and then once a day, lines older than that are dropped by rewriting the file; the trim also drops a line that is
  not a call log line.
- **`input.json` and the load samples.** A load sample may carry a third value, the disk percentage of that poll; the `disk` alert uses it for "since". Without it
  the alert counts from the last answer. `load.log` lines are `time load1 [disk]`; `events.log` lines are `time kill <added>` and `time state <state>`.
- **Alerts** (the rules of the design, with the details it left open): `load` is open while the host is awake and its current load is above its thread count,
  `since` is the start of that run of samples and `count` the number of such runs in 24 hours; `memory-kill` counts the kills added by the rises of the last 24 hours;
  `refused` and `lock-wait` group by host and box; the list is sorted by last occurrence, newest first. The fourth part of an alert id is always empty.
- **Not built:** the flag for a host whose clock is more than a minute off (failure modes table): `pod report` carries no time of the host, so there is nothing to
  compare. A call log is read at most 64 windows (64 MiB) per poll; the next poll goes on from the cursor.
- **ssh failures** show as `ssh refused` (exit 255), `ssh timed out` or `ssh failed`, or, for exit 125 with a reason other than `unknown command`, that reason (a view
  key list with an old sshd settings file).
- `docs/designs/layout.md` is not changed (workstream 4 became a docker stack, so there is no package table).

### Workstream 3 as built

Files: `dashboard/web/index.html`, `boxd.css` (the prototype's, with the rules of cut parts removed), `assets/fonts/` (the prototype's, local),
`boxd-theme.js` (the stored theme, before first paint), `boxd-views.mjs` (pure: `newState`, `applyDoc`, `route`, `renderView`, `chrome`; importable by node, no
`document`) and `boxd.mjs` (routing, events, polling, theme, focus and scroll). The prototype's `boxd.js` split as the design says; the modules are `.mjs`
so node and the browser both read them as modules without a `package.json`. Tests: `tests/dashboard-web.test.mts` (9 cases: every view, including each host and
box detail, rendered from `fleet.json`; the poll keeps route, sorting, filters, view mode and acknowledgements; the status bar; no view draws a host-changing
action; the on-demand data; every host-supplied text escaped, with a fixture copy full of `<script>`, quotes and `&`; no inline script, handler or style, no
outside reference in the folder) and three cases added to `tests/dashboard-service.test.mts` (the files and their types, the policy, every file the page names is
served, traversal and its relatives answer 404). `tests/dashboard-fixture-server.mts` opens the page by hand against the fixtures (see `README.md`).

Deviations and additions, each small:

- **Serving.** `pageFiles()` lists the web folder once at start (`$BOXD_DASHBOARD_WEB` or `webDir` can name another; default the `web` folder beside the program); a request path
  is only ever a key of that list, so nothing from a request is joined to a folder. Hidden files, links and files of unknown type are not listed; a file added later is not served.
  `Cache-Control: no-cache` for everything but fonts (one day). Policy: `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self';
  img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. No inline style attribute exists: widths and offsets are `data-w` and `data-left` attributes
  that `boxd.mjs` sets through the style object, which the policy allows. The theme script of the prototype's `<head>` is the external `boxd-theme.js`.
- **Drawing.** A poll draws again only when the document text changed, and not while the person is selecting text in the page. A redraw puts focus back by id, or by the place and
  action of the control, keeps the scroll of the page and of the log, and the one-second tick only rewrites live values ("ago", "up for", "time left") in place.
- **The log** is plain text as the host wrote it. The first answer is the tail the server gives; while the run lives and Follow is on, each beat asks from the stored `next`.
  When the answer's `from` is not the offset asked, the page starts the text again. The process table and the log are asked only while the host was awake at the last poll.
- **Acknowledgement** is kept in the browser's storage as the alert's last occurrence time; an alert whose `lastAt` is later comes back. Storage that is blocked only loses it.
- **Command text.** Where the prototype had a button: stop a box (`pod stop <box>`, as the build account on the host), recreate (`box --recreate <command>`), services
  (`boxctl status`, `reload`; `start`, `stop` named), reset (`boxd-reset work` and `boxd-reset all`, as root, with `--force`), the power module (`BOXD_POWER` in
  `boxd.conf`, then `boxctl reload`). Waking a host has no command here: it wakes on the next call from a client set up with `box setup --wake`. A copy button writes the text
  to the clipboard (or selects it where the clipboard is refused); it changes nothing on a host.
- **Cut from the prototype's views:** every action button and the confirmation steps; the simulated idle countdown and the invented log lines and levels; hardware, cores, last
  killed box, compressed swap, caches by kind, keepawake holders table, last reset, worktree and "worktree is gone", box cpu, cache and disk meters, image digest and tool versions,
  service uptime, the alert's "source", "metric" and growth text, the reset checkboxes (replaced by the two commands side by side), the `waking` state.
- **Added:** state `unreachable` (own shape and colour), "last known" marking from `stale`, the notice for a server on 0.2.0, the status bar "boxd <version>, data from <time>, read only"
  (or the service's failure with the time of the data shown), the machine widget for no count ceiling ("N running, room for another: yes or no, measured memory decides"), the host
  address on the host cards, the engine and the refusal's own exit code (125 or 75) in the calls and refusal tables.
- **Visual check** against `../screenshots` of the design was done with the headless browser from the Playwright cache on this machine; see the report of the build.

### Workstream 4 as built: a docker stack

On 2026-11-14 the owner chose the form of workstream 4: a docker stack for the homeserver, in a common layout (`~/stacks/<name>/`, `compose.yaml`, `./data`,
`container_name`, `restart: unless-stopped`, the external network `proxy`, nothing published, the proxy manager reaches it by container name),
**instead of a system package**. The package form (files under `/usr/lib`, a systemd unit and a runit service, a system account, a table in `docs/designs/layout.md`)
is dropped, so `docs/designs/layout.md` names no dashboard package and is unchanged. "Home network only" (decision 6) is an access list in the proxy manager's
own interface, not part of the stack.

Files, in `dashboard/stack/`: `Containerfile`, `compose.yaml`, `.dockerignore`, `dashboard.json.example`, `INSTALL.md` (the exact steps for the homeserver, host side
commands included) and `make-bundle`. Tests: `tests/dashboard-stack-test.sh` (builds the image from the bundle, starts the stack with the shipped `compose.yaml` and checks it
with a second container on the network) and `tests/dashboard-bundle.test.mts` (the bundle's exact file list, nothing private or test-only, identical bytes on two runs, the example
settings against the real parser).

- **Image.** `node:26.13.1-alpine3.24` (26 is the long-term-support line of node since October 2026; the tag is exact), plus `openssh-client` from the Alpine package
  repository (the only package installed; the service has no node modules), the two program files and `web/`, user and group 10001 without a login shell,
  `HEALTHCHECK` that asks `/api/fleet.json` on `127.0.0.1:8377` with node's `fetch` (no curl), the service as the only process. The image has no tini, so `compose.yaml`
  sets `init: true` (Docker's own init is process 1). Size on this machine: 256 MB (the node base alone is about 250 MB; the alpine variant is the smallest official one).
- **Listening.** New setting `"listenAnywhere": true`. Without it, a non-loopback `listen` address is refused exactly as before; with it any address is accepted. The
  container's `listen` is `0.0.0.0:8377`. The exposure is the docker network `proxy`: nothing is published, so only containers on that network reach it. Tests in
  `tests/dashboard-service.test.mts` (refused without the key, with `false`, with a non-boolean; accepted with `true`, and the service then listens on `0.0.0.0`).
- **`compose.yaml`.** Service and container `boxd-dashboard`, image tag `boxd-dashboard:local`, built from `.` (the unpacked bundle, which holds only what the image
  needs; `.dockerignore` keeps the owner's settings and the key out of the build context even so), network `proxy` only, no `ports`, `./data` as `/state`, `./dashboard.json` as
  `/config/dashboard.json` and `./data/key` as `/run/boxd/key`, both read-only, `read_only: true` with no tmpfs (the service writes only under `/state`), `cap_drop: [ALL]`,
  `no-new-privileges`, memory 192 MB with the same swap limit, 64 processes, half a processor.
- **The bundle** (`make-bundle [-r <ref>] [-o <file>]`): from the working tree, or from a tag with `-r`; GNU tar with sorted names, owner 0, one fixed time (the commit's), modes
  644 and 755, `gzip -n`: the same bytes for the same sources. It holds exactly `Containerfile`, `compose.yaml`, `.dockerignore`, `dashboard.json.example`, `INSTALL.md`,
  `dashboard/boxd-dashboard.mjs`, `dashboard/fleet.mjs` and `dashboard/web/`.

Deviations and things to know:

- **The user id must belong to the data folder.** The container runs as 10001. ssh stops when its user id has no entry in `/etc/passwd`, so the id cannot simply be the owner's;
  instead `INSTALL.md` step 2 gives `data` and `data/key` to 10001 with `sudo chown`. The public key stays world readable so the owner can still print it.
- **The health check lives in the image**, not in `compose.yaml` (one place; compose uses it). Its port is fixed at 8377: a different `listen` port needs the Containerfile line changed.
- **The key is also visible at `/state/key`** (the `./data` mount holds it); the read-only mount at `/run/boxd/key` is the path the settings name.
- **The stack test** runs on a machine where docker answers without sudo (it does here; the test prints SKIP otherwise), refuses to run when a container `boxd-dashboard` or the image
  `boxd-dashboard:local` already exists, creates the network `proxy` only when absent and removes only what it created. It gives the key to user 10001 with a root container
  with one capability instead of sudo.
- **Not run here:** a build host, the real proxy manager, the own-network access list, the owner's own folder and user ids (see the report of the build).

## 6. Acceptance scenarios and failure modes

Observed on the real hosts unless a contract test is named. "A poll" means one round of the collector.

1. **The key only reads.** With the dashboard's key, `pod report` on the tower prints a `host` line; `pod run`,
   `pod stop`, `pod image load` and an rsync each exit 125 with `this key may only read`, and no file under the work
   area changes. An agent's key still runs a box. (Also the view key cases of `contract/cases.json`.)
2. **The report tells the truth.** On each host, `pod report` and, in the same moment, `pod status`, `pod list`,
   `nproc`, `df` of the work area and the cgroup files agree field by field.
3. **A call appears.** `box true` from a worktree: after at most two polls the calls view shows it with its box,
   exit 0, its duration and the command `true`. A call with an image of a registry that is not allowed shows as
   refused with the server's reason, and an alert of kind `refused` opens.
4. **A sleeping host is not woken.** With the tower asleep and the page open on its host and box views for 30
   minutes, the power module's log on the tower has no `woke up` line in that window. The page shows `asleep`,
   "asleep since", and the last known values marked as such.
5. **Sleep is not delayed.** With the tower idle, the dashboard polling and its address in `BOXD_IDLE_IGNORE`: the
   power log shows `idle, sleeping after 20 quiet checks` and then `sleeping`, with no `busy: ssh` line between
   them. (Also `tests/boxd-idle-test.sh`.)
6. **A wake is seen.** A `box` call wakes the tower: within one poll the page shows `awake` and "awake for" counts
   from that poll.
7. **A box's life.** A first call from a new worktree: the box appears within a poll. Its page shows the same lines
   as `box ps`. With the page left open, the box is removed by the reaper at its time limit, exactly as without the
   page (the reads leave `.last-used` alone), and disappears from the list.
8. **A detached run's log.** `box --detach sh -c 'for i in 1 2 3; do echo line $i; sleep 20; done'`: the run shows as
   detached, the log view shows each line as it is written and then `EXIT 0`, and the run shows as ended.
9. **A host goes down.** The owner stops boxd on laptop (`boxctl stop`): within two polls its row reads
   `unreachable`, an alert opens, the other hosts' rows keep updating. After `boxctl start` the alert closes.
10. **An older server.** A host still on 0.2.0 shows its state, load, boxes and images, the note "status and box
    list only", empty calls, and no error. (Also `tests/dashboard-data.test.mts`.)
11. **A huge call log.** On a host whose call log is larger than 1 megabyte, a first `pod calls` answers with
    `next` minus `from` at most 1 048 576, and following `next` reaches `size`. (Also the contract cases, with
    `BOXD_READ_MAX`.)
12. **The door.** A request to the public address without the password gets 401 from the proxy. From another
    machine, a connection to the service's own port is refused: it listens on the loopback address only.
13. **Nothing but reads.** A `POST` to any path answers 405. The build sshd's log on a host shows, for the
    dashboard's address, only the six reading commands.
14. **A restart keeps the history.** After the service is restarted, the load trend and the calls of the last day
    are still there, and the next `pod calls` continues from the stored offset (no call twice, none missing).
15. **The monitor can retire.** With the monitor script and the dashboard running side by side for a day, every
    `ANOMALY` line of the kinds refused, waited, memory kills and load in the monitor's log has its alert.

Failure modes:

| What happens | What the dashboard does |
|---|---|
| A host that sleeps does not answer on its port | `asleep`, last known values, no ssh, no alert, no wake packet |
| An always-on host does not answer | `unreachable`, "no answer", an alert; polled again at every interval |
| The port answers, ssh fails (key removed, sshd restarting, a connection penalty) | `unreachable`, "ssh refused"; the homeserver's address belongs in `BOXD_TRUSTED_NET` so that failed tries are not penalized |
| `pod report` is an unknown command (server 0.2.0) | `pod status` and `pod list`; host marked; calls, runs, logs and alerts from its call log are absent |
| A host on 0.2.0 has view keys but an old sshd settings file | impossible: view keys arrive with 0.3.0. On 0.3.0 with an old settings file every call is refused with the reason, and the page shows that reason as the host's detail |
| The call log is huge | first contact reads only the last megabyte; later polls read only what is new |
| The call log was emptied (`boxd-reset all`) | the server restarts from 0; the collector keeps what it had stored |
| A call log line is broken or of a newer format | left out; the others are kept (seven to nine columns accepted, more ignored) |
| A poll of one host hangs | the ssh ends after its connect limit and a 20 second limit on the answer; that host keeps its last values, the others are not delayed |
| The poll meets a `boxd-reset` | the reset refuses once ("has an ssh session"); stated in the reset view |
| The service stops | the proxy answers 502; the page keeps what it has and shows "no data since ..." |
| The clocks of a host and the homeserver differ | times of calls come from the host, "data from" from the homeserver; a host more than a minute off is flagged in its detail |
| Two browsers are open | both read the same document; neither causes a poll. The on-demand reads are limited per host |

## 7. Cut from the first version, and why

- **Every action button** (section 3): they change hosts other sessions are using; reading first.
- **Fields with no honest source:** worktree path and "worktree gone", cache per box, the disk "base", the tool
  versions per image, the image digest, the last killed box, the processor name and core count, service uptimes,
  keepawake holders by name, log levels, the disk growth alert. Listed in section 1.
- **Fields that would load the host:** sizes of the caches and of each box's files (`du`), processor share per box.
  Later, measured once an hour by the service that already runs on the host.
- **Calls in progress as rows of the calls table:** the server logs a call when it ends. A box shows that it is busy.
- **Placement reasons** (`choices.log`): they live on the agents' machines.
- **Compressed swap, last reset time:** small, but each needs its own key or stamp; not needed to run the fleet.
- **Notifications** when an alert opens (decision 8), **a history view** longer than the trend line, **several
  users**.

## Owner decisions

**Decided by the owner on 2026-11-13** (the questions and options as they were put are kept below):

1. The service runs on the homeserver, behind the reverse proxy.
2. The server writes the first 200 characters of each call's command into the call log.
3. The first version is read only: no button changes a host; the page prints the command to run.
4. The dashboard's key is limited to reading by key (`/etc/boxd/view_keys`, the build sshd tells boxd-pod which key logged in).
5. The power module ignores the dashboard's connections (`BOXD_IDLE_IGNORE` with the homeserver's address).
6. **Own network only**, not a public name: the proxy serves the page to your own addresses only. This differs from the
   recommendation; wherever this document says "public name", read "a name the proxy answers for your own network only".
7. The services and reset views stay as information, without buttons.
8. No notifications from the dashboard at first: compare its alerts with the usage monitor script for a day, then add
   them and retire the script.


1. **Where does the dashboard service run?**
   - (recommended) On the homeserver, beside the reverse proxy, under its own account: always on, already the door to
     your other pages.
   - On the workstation: no new key or account, but the page is gone when the workstation is off.
   - On every build host, each showing only itself: no ssh at all, but no fleet view and nothing while a host sleeps.
2. **May the server write each call's command into the call log, so the calls view can show it?** Today the log has
   box, engine, times and exit code, and no command.
   - (recommended) Yes, the first 200 characters. The values passed with `--env` are never on a command line. The
     command of a running process is already visible to the same reader through `box ps`.
   - No: the calls view shows box and outcome only, and a run's command is shown only while it runs.
   - Only the first word of the command (the program name).
3. **Is the first version read only?**
   - (recommended) Yes. No button changes a host; the page prints the command to run instead.
   - Read only plus "wake a host": the one action that costs only power.
   - Read only plus "stop a box" with a confirmation: needs a second key that may write, on the homeserver.
4. **How is the dashboard's key limited to reading?**
   - (recommended) By key: the build sshd tells `boxd-pod` which key logged in, and listed keys may only read. Needs
     one line in each host's `/etc/boxd/sshd_config` (kept on upgrade, so added by `boxd-setup`). Fails closed.
   - By address: every login from the homeserver's address may only read (two lines in the sshd settings). Simpler,
     but the homeserver could then never run `box` against the other hosts.
   - No limit: a separate key that can do everything an agent's key can. Nothing to build; a break-in on the
     machine that faces the internet could then run boxes on every host.
5. **May the power module ignore the dashboard's connections when it decides whether the host is idle?** Without
   this, the polls can keep the tower awake.
   - (recommended) Yes: setting `BOXD_IDLE_IGNORE` with the homeserver's address. Connections from it on the build port
     are not work. A build started from the homeserver itself would then not keep the tower awake by its connection
     alone (its load still would).
   - No change on the hosts: the hosts push their report instead (alternative C); more to build on every host.
   - No change at all: poll an awake host that sleeps only every 10 minutes, and accept that the page is that old
     and that a sleep is sometimes late by up to 20 minutes.
6. **Is the page reachable from the internet, behind the proxy's password, or only on your own network?** It shows commands,
   box names and build logs.
   - (recommended) Like your other pages behind the proxy: a public name, encrypted, basic authentication.
   - Home network only.
7. **What happens to the two views that only act: services and reset?**
   - (recommended) They stay as information: the version and derived state per host, and what a reset loses and
     keeps with the command to run. No buttons.
   - They are hidden until actions exist.
8. **When an alert opens, should the service also send a notification, as the monitor script does today?**
   - (recommended) Not in the first version: first compare the alerts with the monitor for a day (scenario 15),
     then add it and retire the script.
   - Yes, from the start, to the same notification topic.

## Executable acceptance

The tests of workstreams 1 and 2 are in the default runs and pass (see "Workstream 1 as built" and "Workstream 2 as built"):

```sh
node --test tests/dashboard-data.test.mts tests/dashboard-service.test.mts tests/dashboard-web.test.mts
```

- Workstream 4: `bash tests/dashboard-stack-test.sh` (needs docker without sudo) and `node --test tests/dashboard-bundle.test.mts`.
- Workstream 1: the 31 cases (now in `contract/cases.json`) and block 7 of `tests/boxd-idle-test.sh`.
- `tests/dashboard-data.test.mts`: `fleet()` and `parseAnswer()` of `dashboard/fleet.mjs` against the fixtures in `tests/fixtures/dashboard/`: `tower.report` and
  `tower.calls` (captured by `tests/dashboard-capture.sh` from the real server), `laptop.status` and `laptop.list` (the 0.2.0 formats, from `boxd-pod:302-304` and
  `boxd-pod:265`), `input.json` (states, load samples, kill events) and `fleet.json` (the expected document, recomputed by the implementation and read against the schema above).
- `tests/dashboard-service.test.mts`: the poll loop and the http side against a fake `ssh` (see "Workstream 2 as built").

## Not determined from the code (UNVERIFIED)

- Whether the build account can read `/run/boxd-idle/count` and `last` (they are made by root; the default mode
  would allow it).
- Where rootless podman puts a container's cgroup under the build cgroup on the hosts, and so how `mem_mb` of a
  container is read. The key may be a dash at first.
- That `ExposeAuthInfo` behaves as described with the OpenSSH of Void and of Debian, and that `SSH_USER_AUTH`
  reaches a `ForceCommand` program.
- The reverse proxy on the homeserver: which program, how a new page is added, whether its basic authentication can
  cover a new name. Nothing in this repository describes it beyond `docs/packaging.md`.
- Whether the homeserver and the tower share a network segment (needed only for a later "wake" button).
- The addresses, ports and account names of the real hosts as the homeserver sees them (the tower's build account is
  `build`, its address in the monitor script is 192.0.2.72; the rest is the owner's).
- The cost of one `pod report` on a loaded host (it calls `podman ps`, `msb ls` and one inspect per box). If it is
  more than a fraction of a second, the poll interval of that host grows.
- The Debian packaging: branch `debian-packaging` had no commit beyond `main` when this was written.
- An observation, not part of this design: the power module measures the disk of `/` before a sleep
  (`boxd-idle:67`) while `pod status` measures the work area (`boxd-pod:304`). They are the same file system on the
  the tower; on a host where they are not, the threshold the page draws is not the one the reset uses.
