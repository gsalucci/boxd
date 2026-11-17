# boxd: choosing a build host among several (design draft, 2026-11-13)

Status: built (branch `load-management`, see "Built" at the end for where it differs from this draft). Draft text below kept as decided. Grounded in boxd 0.1.3 (`client/box.mts`, `client/box-wake.mts`,
`server/boxd-pod`, `power/boxd-idle`, `docs/pod-contract.md`, `contract/cases.json`). Points not checked on a real
machine are marked UNVERIFIED.

## Goal and the measurable outcome

A `box` call is served whenever any registered host has room for it, without the agent naming a host.

How we see it:

- No call is refused with "no room" while another registered host had room at that moment. Each host's
  `calls.log` keeps logging refusals, and the client adds one line per placement decision (see "Evidence").
- A worktree's calls keep landing on the same host (files, caches and the sticky box stay where they are).
- A sleeping host is never woken just to ask how busy it is.

## What exists today (facts from the code)

- **Resolution:** `--host`, else `$BOXD_HOST`, else `~/.config/boxd/host` (`box.mts:141-145`). The result is the
  ssh alias `boxd-<name>`. There is exactly one answer per call, and no fallback.
- **Registration:** `box setup <name> ...` writes a `Host boxd-<name>` block between the markers
  `# boxd:host:boxd-<name>:begin` and `...:end` in `~/.ssh/config`. For a host that sleeps, it also writes a wake
  `Match` block and an entry in `~/.config/boxd/wake.json`: target `address:port`, card addresses, broadcast address
  (`box.mts:151-219`). **This is already a host registry:** the marker blocks list the hosts, and `wake.json` says
  which of them sleep.
- **Call order:** the sync runs first (`box.mts:259-266`), then `ssh boxd-<host> pod run ...` (`box.mts:268`). A
  refusal (exit 125) therefore arrives **after** a full sync to that host.
- **Virtual machine slots:** the server counts running machines under the lock `$WORK/cache/vm-room.lock` and
  refuses with `no room for another virtual machine (<n> of <max> running)` (`boxd-pod:269-275`). This lock is the
  only authority on slots. Containers have no slot limit and are never refused for room.
- **Waking:** `box-wake` first tries a plain network connection to the target address and port. If it answers,
  box-wake exits at once; otherwise it sends wake packets and waits (`box-wake.mts:4-7, 39-74`). Any ssh to the
  alias runs box-wake through the `Match` line, **so any ssh to a sleeping host's alias wakes it.**
- **Staying awake:** a host counts as busy while any connection on port 22 or the build port is established, while
  the load is high, or while someone holds the keepawake lock (`boxd-idle:29-35`). One short status call holds a
  connection for a fraction of a second. It only keeps the host awake if it lands exactly on an idle check.
- **The `box` name** depends only on the worktree path (`box.mts:46-64`). The same worktree gets the same box name on
  every host, but each host has its own separate box.
- **Commands:** `pod run`, `pod stop`, `pod list`; anything else exits 125 (`boxd-pod:386-393`).

## 1. Host registry

**`box hosts`** (new, read-only). It prints one line per registered host:

- name and order;
- `sleeps` or `always on`;
- the live state: `asleep`, `awake` (with load, machine slots used and free, disk percent), or `unreachable`.

What lives where:

- **Client side, already stored:**
  - name, ssh details (`~/.ssh/config` marker blocks);
  - sleeps or not, wake details (`wake.json`).
  - Nothing new is stored, except the order (below).
- **Server side, reported live by `pod status`:** engines offered, machine slot maximum, load, processor count,
  disk use. The server knows these from its own settings (`BOXD_VM_MAX`, whether `msb` exists). Copying them to the
  client would let them go stale. **Keep them server-reported.**
- **Order:** `~/.config/boxd/host` becomes an ordered list, one name per line, written by `box setup` (new hosts are
  appended; `--default` moves a host to the top). The first line stays the default. A single-line file is today's
  format, so old clients keep reading it. UNVERIFIED: old clients read the whole file trimmed, so they would see
  "tower\nlaptop" as one invalid name. They must be upgraded with the new file, or the order must live in a second
  file (`hosts.order`). Decision below.
- **Network distance (local network or a remote tunnel):** expressed only through the order (remote hosts last). No
  measured distance.

## 2. The status query

New command: `pod status`. It prints one line, tab separated, `key=value` words:

`version=0.2.0 engines=container,vm cpus=16 load1=0.42 vm_used=1 vm_max=3 vm_room=yes boxes=4 disk_pct=37 mem_free_mb=21000 images=toolbox`

Where each field comes from:

| Field | Source |
|---|---|
| `load1` | `/proc/loadavg` |
| `cpus` | `nproc` |
| `vm_used` | the same count as `pod run`, read **without** taking the room lock: it is advice, not a reservation |
| `vm_max` | `VM_MAX` (information only; optional once virtual machine room is measured memory) |
| `vm_room` | `yes` or `no`: the server's own answer to "room for one more virtual machine of the default size", from the one function `vm_room` (measured memory plus an optional count ceiling, see the contract; at first: running machines < `VM_MAX`). **The client decides virtual machine room from this field only**, so the rule can change on the server without a client change |
| `engines` | `vm` only when `have_msb` |
| `boxes` | rows of `box_rows` |
| `disk_pct` | `df` of the work area, as `boxd-idle` already does |
| `mem_free_mb` | the cgroup's `memory.max` minus `anon` plus `shmem` from `memory.stat` (changed after 0.3.0: the first rule, `memory.current` minus `inactive_file`, counted active file cache as used) |

On `mem_free_mb`: `memory.current` includes the file cache. The usage monitor showed 23 GB "used" on an idle the tower.
So file cache that can be reclaimed must not count as used. UNVERIFIED: whether `inactive_file` is the right
correction. v1 reports the field but does not use it in the choice (see the cull). Settled 2026-11-14: it was not (active file cache stayed counted; an idle host showed 133 MB free after a big copy); the field now uses the admission's figure, `anon` plus `shmem`.

Cost and safety:

- **Never wake a host to ask.** Before the ssh, the client tries a plain connection to the target address and port
  from `wake.json`, with a short timeout. That is the same probe box-wake uses, run in the client and not through the
  alias.
  - No answer: the host is **asleep**, and no ssh is made.
  - Hosts without a wake entry: the ssh itself, with `ConnectTimeout`; no answer means **unreachable**.
  - Since the probe only says "awake" when the address answers, the ssh that follows passes box-wake's
    "already answers" exit. So no wake packet is sent.
- **Cost:** one ssh round trip per awake host, made in parallel. Expected 0.1 to 0.5 s on your own network,
  UNVERIFIED; more over the tunnel. It is only paid on a worktree's **first** call (see stickiness), never on every
  call, and never by a poller.
- **The server stays the authority.** A status line can be stale a second later; only `pod run`'s lock decides.

## 3. Stickiness: a worktree lives on one host

Once a worktree's box has a host, every later call goes there. Files, caches and the sticky box image, engine and
user are on that host. Moving them costs a full sync and cold caches.

- **Where the placement is recorded:** `$(git rev-parse --git-dir)/boxd-host`, one line with the host name.
  - For a linked worktree the git folder is `.git/worktrees/<name>`, so each worktree has its own file.
  - It is removed with the worktree, needs no global file, and causes no locking between different worktrees.
  - UNVERIFIED: whether any tool cleans unknown files in the git folder (`git gc` does not, as far as known).
- **Two first calls of one worktree at once:** each makes its choice and writes the file atomically (write a
  temporary file, then rename). The first rename wins and the second call re-reads the file. Rare; the worst case is
  one extra sync.
- **Precedence of a call:**
  1. `--host X`: use X **and record it**. This is how a box moves; no other move command.
  2. `$BOXD_HOST`: use it, but do not record it. It is a session override, as today.
  3. The placement file, if its host is still registered.
  4. Otherwise choose (section 4) and record the choice.
- **`--recreate`** never moves a box. It recreates it on its placed host.
- **Moving a box:** `box --host other -- ...` syncs the worktree there (the sync is always complete) and records
  `other`. The old box on the first host is removed by that host's time-to-live reap (`BOXD_TTL`, 30 minutes) and its
  files by the next reset.
  - Files the box made that are not in the worktree stay behind. That is the same rule as the sync today.
  - Detached run logs stay on the old host. The log read command must name the old host:
    `box --host old --no-sync cat /job/runs/<id>.log`. The client prints that line.
- **Existing worktrees after the upgrade:** no placement file, so the choice runs once, and the default host wins on
  an equal footing. Boxes that already exist on the tower stay there.

## 4. The choice (first call of a worktree only)

Smallest policy that fits the owner's machines, and the one proposed for v1: **host order first, overflow second.**

1. Go through the hosts in order.
2. For each host, decide whether it has room for **this** request:
   - **asleep:** has room. A sleeping host runs nothing, so every slot is free. Choose it; the ssh then wakes it
     (the tower took 5 s).
   - **unreachable:** skip it, and note why.
   - **awake, asking for a virtual machine:** room means `engines` has `vm` and `vm_room=yes`. The client never compares `vm_used` with `vm_max`.
   - **awake, asking for a container:** always room. The server never refuses a container for room.
     - UNVERIFIED and deferred: whether a container should spill when `load1 >= cpus` or memory is short. In v1 it
       does not.
3. The first host with room is chosen. (Changed in 0.4.8: the host with room that has the most `mem_free_mb`, ties in order,
   asleep counts as the most free; the first-in-order rule filled the tower until its kernel killed a machine on 2026-11-15
   while laptop stayed idle. `choices.log` names such a choice `spread`.)
4. No host has room: exit 125 with one line per host and its reason (`tower: 3 of 3 machines`, `laptop:
   unreachable`). **Never queue silently.**

The rejected alternative is "awake first": prefer an awake host with room over waking a sleeping one higher in the
order. It saves the 5 s wake, but it puts builds on the owner's laptop while the build server sleeps. That decision
belongs to the owner (see the list at the end).

**Lost race, "no room" after the probe said there was room:** two clients took the last slot between the probe and
`pod run`.

- The client retries `pod run` on the next host with room, after a sync to it, and records that host. At most one
  retry per remaining host.
- The client must tell this refusal apart from other 125s. The refusal line already starts
  `boxd-pod: no room for another virtual machine`. The contract makes that prefix stable, and the client captures
  stderr for that call only. Alternative: a distinct exit code for "no room", which is a contract change; decision
  below.
- **A placed worktree that hits "no room"** (its own host is full, for example its machine box was reaped): no
  automatic move, because its caches are there. The error names the hosts that have room and the exact
  `--host <name>` to move. Decision below whether to move automatically.

## 5. Failure modes

| Case | What happens |
|---|---|
| Host down or off | The probe gets no answer. A sleeping host whose wake fails (box-wake gives up) is skipped by the choice; a placed worktree gets the ssh error and the move hint. |
| Host asleep | Chosen as "has room", woken by the ssh it was going to receive anyway. Never woken by `box hosts` or a probe. |
| Network split (the remote tunnel is down) | Same as down. The probe's timeout bounds the delay; it is a network timeout, not a test clock. |
| Stale status | Harmless: the server lock decides; a lost race retries on the next host. |
| Two clients, last slot | The server lock serializes them (`boxd-pod:269-275`): one wins, the other gets "no room" and retries elsewhere. |
| Cold caches on a new host | Expected cost of overflow: the first build there downloads crates, packages and images. Order keeps the build server first, so overflow is the exception. |
| Placement names a host that was removed from the registry | Treated as no placement: choose again. |
| Local image missing on the overflow host (`localhost/toolbox`) | `pod run` refuses it. The choice must treat a host without the requested local image as no room. That needs `images=toolbox` in `pod status`. |
| Different boxd versions | `pod status` prints `version`. An old server answers `unknown command` (125): treat as "awake, room unknown", choose only if nothing better. |

## 6. Contract changes

`docs/pod-contract.md`:

- **Commands table:** a `pod status` row: the exact fields, one line, the `key=value` grammar, no lock taken, exit
  0.
- **A new section, "Host choice (client)":**
  - the registry (marker blocks and `wake.json`) and the order file;
  - the placement file and the precedence rules;
  - the probe that never wakes, and the policy;
  - the lost-race retry and the error format.
- **The "no room" refusal:** the text prefix is part of the contract (or a new exit code).

`contract/cases.json`:

- **`pod` cases for `pod status`** with the fakes' given state (sandboxes, settings) and the expected line.
  `contract-pod-test.sh` runs them against the real `boxd-pod`.
- **A new key `choose`:** pure data cases. The input is a list of hosts, each with `{state: asleep|unreachable|awake,
  status line}`, plus the request (engine, local image). The output is the chosen host, or the 125 message. The
  client's choice is a pure function tested against these cases; the same cases document the policy.
- **`client` cases:** the placement precedence (`--host` records, `$BOXD_HOST` does not, `--recreate` keeps).

Contract test at the new seam: the client parses the **real** server's `pod status` output, captured from
`boxd-pod` under the fakes, exactly as the rsync lines are captured today. A stub line typed by hand is not enough.

## 7. Acceptance scenarios (write first, against the real the tower and laptop)

Each scenario runs against the real hosts. Test hosts get small limits so they fill quickly; laptop already has
`BOXD_VM_MAX=1`. Power scenarios lower `BOXD_IDLE_CHECKS` the way scenario 9 does today.

1. **Overflow:** fill all the tower's machine slots with three worktrees. A fourth worktree's first `--vm` call
   exits 0 on laptop. Its placement file says `laptop`. The tower's `calls.log` has no refusal for it.
2. **Stickiness:** free a the tower slot. The fourth worktree's next call still goes to laptop, and no status query
   reaches the tower: its `calls.log` and ssh log show nothing.
3. **Move:** `--host tower` on that worktree. Its files appear on the tower, the placement says `tower`, and the
   next plain call goes to the tower.
4. **All full:** fill both hosts. A new worktree's `--vm` call exits 125 promptly, with one reason per host. Nothing
   is left waiting on either host.
5. **Sleeping build server first:** the tower asleep, laptop awake. A new worktree's first call wakes the tower
   and runs there. laptop's `calls.log` has no line for it.
6. **Never wake to ask:** the tower asleep. `box hosts` prints `asleep`, and the tower is still asleep afterwards
   (no ping answer through the next idle check).
7. **Lost race:** two new worktrees' first `--vm` calls at once, for the tower's last slot. Both exit 0, one on each
   host. Each placement file names the host its box is on.
8. **Host down:** laptop unreachable (its build sshd stopped). With the tower full, a new `--vm` call exits 125
   naming `laptop: unreachable` within the probe timeout. With the tower having room, the call is served there
   with no delay from the dead host: probes run in parallel.
9. **Evidence:** every placement in scenarios 1-8 left one line in the client's choice log, giving the host, the
   reason and each host's state.

## 8. Evidence (the trace)

The client appends one line per **placement** (not per call) to `~/.local/state/boxd/choices.log`, tab separated:
time, worktree box name, request (engine, image), chosen host, reason (`placed`, `order`, `overflow`, `retry`,
`moved`), and each host's state as probed.

The usage monitor gains one anomaly: "refused or overflowed while an earlier host had room". It finds that by
comparing this log with the hosts' `calls.log` files.

## 9. Ponytail cull

| Piece | Verdict | Why |
|---|---|---|
| Registry from `~/.ssh/config` markers and `wake.json` | KEEP | Already exists; zero new storage. |
| Order file (first line = default) | KEEP | The only new client state besides placements. |
| `box hosts` | SHRINK | Name, order, asleep, awake or unreachable, plus the status line as printed. No formatting work. |
| `pod status` verb | KEEP | Needed for virtual machine room; one function in `boxd-pod`. |
| Fields `load1`, `cpus`, `vm_used`, `vm_max`, `engines`, `images`, `version` | KEEP | Used by the choice or by error messages. |
| `disk_pct`, `boxes`, `mem_free_mb` | SHRINK | Reported for `box hosts` and the dashboard, but not used in the choice until a real overflow shows they matter. |
| Probe that never wakes | KEEP | The owner's "sleep when idle" depends on it. |
| Placement file in the git folder | KEEP | Stickiness is what keeps caches warm. |
| Order-first policy | KEEP | Smallest; matches the roles (build server first, laptop as overflow). |
| Awake-first policy | CUT | Owner decision; can be one setting later. |
| Lost-race retry on "no room" | KEEP | Without it, scenario 7 refuses a call while hardware is free. |
| Automatic move of a placed worktree when its host is full | CUT | Move by hand with `--host`; the error prints the command. |
| Container overflow on load or memory | CUT | The server never refuses containers; revisit with data from `choices.log`. |
| Measured network distance, weights, scoring | CUT | Order expresses it. |
| Server-side registry, central scheduler, queue | CUT | Every client decides with live status; the server lock is the authority; no daemon. |
| Status cache on the client | CUT | Probes only on first placement; nothing to cache. |
| `box stop` and cleanup on the old host after a move | CUT | The time-to-live reap and reset already clean up. |

**Smallest version that serves two hosts:**

- the order file;
- `pod status` with the kept fields;
- the probe;
- the placement file;
- order-first choice with the lost-race retry;
- the choice log.

About one server function and one client module with its pure choice function. UNVERIFIED size estimate: 150 to 250
lines with tests.

## Owner decisions (2026-11-13)

1. **Policy: order first.** A sleeping build server is woken (it counts as having room); other hosts take overflow.
2. **A placed worktree whose host is full:** refused with the exact `--host` command that would move it; never moved
   automatically.
3. **"No room" signal: a new exit code** for now (distinct from 125, which stays "refused"). Open idea from the owner:
   a queue system (a request waits for room instead of being refused). Not designed yet; it must never wait silently,
   in line with the usage monitor's goal that a request is always served or visibly refused.
4. **Order file:** a separate `~/.config/boxd/hosts.order`; `host` keeps meaning the default. Old clients unaffected.
5. **laptop takes overflow automatically**, capped by its own `BOXD_LIMITS` and `BOXD_VM_MAX`.
6. **Remote hosts are hosts like any other:** once configured, they follow the order and the room rules, overflow
   included.

Related decision the same day, for foreground calls (not load management): the client prints the `box ps` table to
standard error, every line prefixed `[box ps] `, after 15 silent minutes and again every 15 while the silence lasts;
`--ps-after <minutes>` or `BOXD_PS_AFTER` shortens it, `0` turns it off for strict parsers.

## Built (2026-11-13)

Where the code follows the owner decisions above rather than the draft's wording, and what it adds:

- **Virtual machine room is the server's word.** `pod status` prints `vm_room=yes|no`, computed by one function `vm_room` in
  `server/boxd-pod` that `pod run` also uses (under the room lock) for its refusal. Today it is the count rule (running
  machines below `BOXD_VM_MAX`). A parallel change makes room a measure of memory and `BOXD_VM_MAX` optional: that change
  rewrites the body of `vm_room` (and the numbers in its refusal text) and touches no client code. `vm_used` and `vm_max` stay in the
  line as information. The refusal text keeps its prefix `boxd-pod: no room for another virtual machine`.
- **Exit code 75 for no room** (decision 3). The server's refusal exits 75 (sysexits "temporary failure"), 125 stays every
  other refusal. The client recognises the lost race by exit 75 **and** the text prefix on stderr, since a command may exit 75
  itself. The client's own "no host has room" also exits 75 (the draft's scenario 4 said 125; one code for one meaning, an agent
  tests one number). The text of the client's refusal starts `box: no build server has room for this call`.
- **Order file** (decision 4): `hosts.order`, written by `box setup`; `host` stays the default. A registered host missing from
  the file comes last; with no file the saved default comes first.
- **No choosing with fewer than two registered hosts**: no probe, no placement file, no log line; today's behaviour exactly.
- **`box hosts`** is the shrunk version: name, `sleeps` or `always on`, state, and the status line as printed.
- **Fields.** All the draft's fields are printed, plus `vm_room` and `images` (archives of local images in the images folder;
  per-box builds are not listed). The choice uses `engines`, `vm_room`, `images`; `vm_used`, `vm_max`, `cpus`, `load1`,
  `boxes`, `disk_pct` and `mem_free_mb` are for `box hosts` and error text. `mem_free_mb` still carries the UNVERIFIED
  `inactive_file` correction.
- **Not built (cut or deferred):** awake-first policy, automatic move of a placed worktree, container overflow on load or memory,
  distance weights, a status cache, the queue idea of decision 3, the usage monitor anomaly, cleanup of the old host's box after
  a move. On a terminal (`ssh -t`) stderr is merged into stdout, so the lost-race retry and the move hint do not run there.
- **Tests.** `contract/cases.json`: `pod` cases for `pod status`, new lists `choose` and `source`. `tests/box-client.test.mts`:
  scenarios 1 to 9 of this draft against a fake ssh playing several hosts, with status lines captured from the real `boxd-pod`.
  `tests/pod-acceptance.sh` scenarios 28 to 36: the same nine against two real hosts (`BOXD_TEST_HOST2`; skipped with a printed
  reason without it).

## 2026-11-17: small machines to small hosts, admission for container boxes, a full host is left by itself

Three owner decisions of one day. They change three rules above: the choice among hosts (section 4), "never moved by itself" (decision 2
of 2026-11-13) and "container boxes are never refused for load or memory" (judged and rejected in 0.4.8). The contract text is in
`docs/pod-contract.md` ("Host choice", "Memory budget", `pod run` step 5b); this section keeps the reasoning.

**1. A machine goes to the smallest host that fits.** The choice took the host with the most free memory. That spread work, but it
also filled the big host with small machines: the free memory of the big host stays the largest until it is nearly full. A later request
for a big machine (`--size xlarge`, 12288 MB) then found no room on it, while a small host stood empty and could have taken the small
machines. Now, for `--vm`, among the awake hosts where this call fits (`vm_fit_mb` against the size asked, or `vm_room`, as before), the
one with the smallest cap for boxes (`group_mem_max_mb`, which `pod status` already printed) wins; ties keep the configured order. Hosts that
print no cap and sleeping hosts come after, and keep the old rule among themselves, so an older server loses nothing. A container keeps
"most free memory": containers have no size, so there is no big request to keep room for. The reason word in `choices.log` is `fit`, new, so
the host watcher's check of placements (`order` must be the first host with room, `overflow` must follow a first host without room) does
not call a deliberate choice of a later host a mistake; it checks only that the host named for `fit` was awake or asleep.

**2. Container boxes are admitted by a reserve.** A machine is admitted by counting sizes, because a young machine has not claimed its
memory yet (2026-11-15: twelve 4 GB machines on a 28 GB cap). A container box has no size, so it was never counted: the only limit was
the cap of the whole build group, and past it the kernel ended a process of some box, possibly another user's long run. A user about to
start ten builds at once would have hit the cap, because every one of the ten looks light the moment it is admitted. The same protection
needs no size, only one number: a reserve, 4096 MB by default (`BOXD_BOX_RESERVE`, `0` is off). A call into a box that is not busy is
admitted only when the machines' sizes, the other container boxes' memory (a busy one with a young call counts at least the reserve),
and the larger of the reserve and the asking box's own use fit `BOXD_VM_COMMIT` percent of the cap. A box already busy adds nothing,
so a second call into the same box is never refused. The young busy boxes are counted by the same function the machines use, so a
machine is not admitted into memory a container box began to claim a second ago. The room lock is held until the call holds its box busy,
or ten calls at once would all see an empty host. Not done, on purpose: idle machines are not removed for a container call (the machine rule
removes them for a machine); that can be added where the refusal is made if a host is seen refusing containers while idle machines hold the room.
`pod status` says the answer (`box_room`, `box_fit_mb`, `box_reserve_mb`) so a client does not send a call that would be refused; the client
treats the host's 75 for a container call as it treats the machine one (the next host with room on a first placement; the lost race).

**3. A box whose own host is full comes back on another host by itself.** "A placed worktree is never moved" protected the caches that
live in the box on its host. But an idle box is not worth a stuck user: when the host is full and another host has room, the worktree
moves, as `--host` would. The two guards keep it from losing anything: a machine or container of the box that still exists on the old
host (any state), or any run of it listed there (an ended run's log and results may not be fetched yet), stops the move, and so does an
old host that cannot be asked, and a call that named a host (`--host`, `BOXD_HOST`) is never redirected. The old caches stay until that
host's time limit, as after `--host`. With `--wait` moving is tried first each round, so a waiting call leaves as soon as it can.

**Compatibility.** A new client against an older server sees no new words and behaves as before. An older client against a new server
keeps working: for a container call the server may now answer 75 with `boxd-pod: no room for another busy box ...`; the older client
tests the machine text only, so it does not retry, does not wait and prints no hint: it shows the server's line and exits 75.

**Evidence.** `contract/cases.json` (choose and pod cases), `tests/contract-pod-test.sh` ("box admission"), `tests/box-client.test.mts`
(spread through the command, container admission, "moves by itself"), `tests/host-watch-test.sh` (`fit`).
