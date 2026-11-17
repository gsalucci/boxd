#!/usr/bin/env bash
# Acceptance test for the box-per-agent layer (docs/pod-contract.md), run FROM workstation against the real host:
#   bash tests/pod-acceptance.sh            all scenarios
#   bash tests/pod-acceptance.sh --list     scenario names only
#   bash tests/pod-acceptance.sh <number>.. only those scenarios
# Needs a real host with boxd installed, set up and started, and the power module on (the sleep scenarios watch it sleep).
# Environment (nothing is guessed):
#   BOXD_TEST_HOST   host name; the build account is reached as ssh alias boxd-<host> (box setup <host>), the
#                    admin account as plain <host>. Overrides: BOXD_BUILD_ALIAS, BOXD_ADMIN_ALIAS
#   BOXD_TEST_IP     address that answers ping while the host is awake (to see it sleep)
#   BOXD_SUDO_PWD    the admin account's sudo password, from ~/.secrets
#   BOXD_TEST_USER   build account (default boxd); BOXD_TEST_WORK work area (default /var/lib/boxd/work)
#   BOXD_CLIENT      client program (default: client/box.mjs of this checkout)
#   BOXD_SUDO_PWD2   the second host's sudo password when it differs from the first one's
#   BOXD_TEST_HOST2  scenarios 28 to 36 only: a second host (box setup <name>); BOXD_ADMIN_ALIAS2 its admin alias (default
#                    the name), BOXD_SV_DIR the runit service folder on it (default /var/service)
#   POD_MEMORY_BYTES and POD_PIDS: the limits the boxes must carry; defaults are the contract's targets.
# The agents' worktrees are throwaway git repositories in a scratch folder; every box and job folder created
# here is removed at the end. Admin checks use ssh with sudo and the password BOXD_SUDO_PWD from ~/.secrets.
# What done means:
#   1. same worktree, two calls: file and installed package survive, same container
#   2. two worktrees: two boxes, simultaneous runs, no shared files
#   3. two simultaneous first calls for one worktree create one container
#   4. --image picks the image; another image needs --recreate (exit 125 otherwise)
#   5. exit codes and multi-line shell text pass through
#   6. --detach returns a run id at once, the log ends with EXIT 0, a running job keeps the machine awake
#   7. reap removes an old box and keeps its files; the next call recreates it
#   8. memory and process limits are set and enforced, the machine keeps answering
#   9. an idle box does not block sleep, and the same container is running after the wake
#  10. sync: deletions propagate, remote build output survives, --pull brings a file back
#  11. --vm box: own kernel (differs from the host), root inside, a microsandbox named pod-<box>
#  12. --vm, same worktree twice: same machine (boot id and process); two first calls make one
#  13. docker inside a --vm box starts by itself, also after the daemon died
#  14. podman inside a --vm box
#  15. /job syncs both ways with a --vm box; files made by the guest's root belong to build
#  16. the guest's own memory cap kills only the process; the machine and the host cgroup are untouched
#  17. the host cgroup's cap kills the whole machine, the host and the files survive, the box restarts
#  18. reap removes an idle machine, keeps its files, the next call boots a new one
#  19. an idle machine does not block sleep and is the same boot after the wake
#  20. container and machine boxes coexist; the other engine needs --recreate; the reaper treats them alike
#  21. BOXD_VM_MAX (when the host sets it): one machine too many is refused with exit 75 (no room), containers and running
#      machines are not
#  22. tests/work-acceptance.sh still passes
#  24. with BOXD_VM_NET_ALLOW set on the host: a new vm box connects to its first service, is refused on port 22 of
#      the same address (blocked connections fail at once, no clock needed), and reaches the public internet
#  25. --image-file builds the box's image from the worktree's Containerfile, in a container and in a virtual machine: an
#      unchanged call keeps the box, an edit replaces it (new image, files under /job/src stay), a broken file exits
#      125 and the last box still answers
#  26. --env GH_TOKEN: the command sees the value in a container and in a vm box, a later call without --env does not,
#      and the value is in no file under the host's work area (call log, run logs, job folders)
#  27. --size: a small machine reports 2 processors and about 2 GB inside, a call naming another size is refused (sticky),
#      --recreate --size medium gives about 4 GB, --size is refused for container boxes
#  37. box image push sends docker.io/library/busybox:stable from this machine to the host, for the container engine and for
#      the virtual machine engine: a box with --image answers, a second push says the host already has it and sends nothing,
#      no archive is left in the work area. Skipped with a reason when this machine has neither podman nor docker.
#  38. the dashboard's key (a throwaway key listed with boxd-setup --view-key) runs pod report, and pod run, pod stop, pod clear,
#      pod image load and an rsync exit 125 with "this key may only read" and make nothing; an agent's own key still runs a box
#  39. pod report agrees with pod status, pod list, nproc, /proc, df and the cgroup files; a box with a waiting detached run is busy
#      with one run, a running box has a memory figure, and the reads leave the box's stamp alone
#  40. with this machine's address in BOXD_IDLE_IGNORE (settings changed for the scenario, put back after) and one connection to the
#      build port held open, the host still goes to sleep, and its power log shows no "busy: ssh" between "idle, sleeping" and "sleeping"
#  41. a call log of more than a megabyte (appended for the scenario, taken out after): a first pod calls answers at most 1048576
#      bytes, and following next from 0 reaches size with every line once
#  42. a container box made with --kvm opens /dev/kvm for reading and writing (as root, and with --user); a box made
#      without it has no /dev/kvm
#  43. a foreground command dies with its session, in a container box and in a virtual machine box: with a `sleep` running in the
#      box, the local client and its ssh are killed; the sleep ends inside the box (box ps shows no such process) and pod report
#      shows the box no longer busy, so the reaper can take it after its time
#  46. a running container box's processes all have /proc/<pid>/oom_score_adj 1000; with BOXD_VM_COMMIT set (settings changed for the
#      scenario, put back after) to just fit the running machines and the asked size, the box's own gigabyte makes a small machine
#      be refused with exit 75 and "<n> MB of running machines + <n> MB used by container boxes + 2048 MB asked > ..."
#  23. box ps lists a detached command that waits, with its working folder and command, on both engines; nothing changes
#  28 to 36 (load management, need BOXD_TEST_HOST2, a second host set up with box setup; skipped with a reason without it):
#  27. overflow: the first host is full, the next worktree's first vm call exits 0 on the second host, which its placement names
#  28. stickiness: with a slot free again on the first host the placed worktree still goes to the second, no ssh to the first
#  29. move: --host <first host> syncs the worktree there and records it; the next plain call goes there
#  30. every host full: exit 75 at once with one reason per host, nothing placed, no call log line anywhere
#  31. a sleeping first host is chosen without any status ssh to it; the first call wakes it and runs there
#  32. box hosts says asleep and makes no ssh to a sleeping host, which is still asleep afterwards
#  33. two first calls at once for the last slots: both exit 0, one on each host, each placement names the host its box is on
#  34. second host down: refused naming it when the first is full, served on the first without detour when it has room
#  35. every placement of 27 to 34 left a line in the client's choice log (host, reason, each host's state)
# No step waits on a clock: each one waits on a process exit, a file or a state, in a bounded loop.
set -u
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CLIENT=${BOXD_CLIENT:-$REPO/client/box.mjs}
POD_MEMORY_BYTES=${POD_MEMORY_BYTES:-12884901888}
POD_PIDS=${POD_PIDS:-4096}
DEBIAN=docker.io/library/debian:stable-slim

SCENARIOS=(
  "same worktree keeps files, packages and container"
  "two worktrees get two boxes that do not see each other"
  "simultaneous first calls create one container"
  "image choice, mismatch refusal and recreate"
  "exit codes and shell text pass through"
  "detached run returns at once and keeps the machine awake"
  "reap removes an old box and keeps its files"
  "memory and process limits are set and enforced"
  "an idle box does not block sleep"
  "sync deletes, protects build output, pulls files"
  "virtual machine box has its own kernel and root"
  "virtual machine box: the same worktree reaches the same machine"
  "docker runs inside the virtual machine and starts by itself"
  "podman runs inside the virtual machine"
  "/job syncs both ways with a virtual machine"
  "memory cap inside the virtual machine kills the process only"
  "host cgroup cap kills the whole virtual machine, the host stays up"
  "reap removes an idle virtual machine and keeps its files"
  "an idle virtual machine does not block sleep"
  "container and virtual machine boxes coexist, engine change needs --recreate"
  "the virtual machine limit refuses one machine too many"
  "work-acceptance still passes"
  "box ps shows a waiting command with its folder, in a container and in a virtual machine"
  "a virtual machine box reaches the home services BOXD_VM_NET_ALLOW lists, and no other home port"
  "--image-file builds the box's image, an edit replaces the box, a broken file keeps it, in a container and in a virtual machine"
  "--env hands a credential to the command in both engines, and it lands in no host log"
  "--size gives a virtual machine 2 or 4 GB, is sticky, and needs --recreate to change"
  "load management 1: overflow to the second host when the first is full"
  "load management 2: a placed worktree stays where it is"
  "load management 3: --host moves a worktree and records it"
  "load management 4: every host full is refused at once with one reason per host"
  "load management 5: a sleeping first host is chosen and woken by the call, never asked"
  "load management 6: box hosts never wakes a sleeping host"
  "load management 7: two first calls for the last slots are both served, one per host"
  "load management 8: a host that is down is skipped, or named when nothing else has room"
  "load management 9: every placement is in the client's choice log"
  "box image push sends an image to the host's store for each engine, a second push sends nothing"
  "dashboard: a key that may only read runs the reading verbs and nothing else, an agent's key is unchanged"
  "dashboard: pod report agrees with the host, a busy box and its run are told, reads change nothing"
  "dashboard: BOXD_IDLE_IGNORE lets the host sleep while a listed address stays connected"
  "dashboard: pod calls on a call log of more than a megabyte, in windows, every line once"
  "--kvm: a container box made with it opens /dev/kvm, a box made without it has no such device"
  "a foreground command dies with its session: client and ssh killed, the process in the box ends and the box is no longer busy, in both engines"
  "box forward: a port of a container box is reached on 127.0.0.1 here, the open channel keeps the box busy, a killed client leaves no relay and a free box; refusals, no ssh -L"
  "retention: a box folder unused past the limit is removed by the reaper with files of other users in it, the next call says so; pod drop removes box and folder"
  "container boxes: every process of a box has the out-of-memory score 1000, and a box's own memory counts in the commitment of machines (a machine is refused with the three numbers)"
)

if [ "${1:-}" = "--list" ]; then
  for i in "${!SCENARIOS[@]}"; do printf '%d. %s\n' "$((i + 1))" "${SCENARIOS[$i]}"; done
  exit 0
fi

# shellcheck disable=SC1090
source ~/.secrets 2>/dev/null
[ -n "${BOXD_SUDO_PWD:-}" ] || { echo "BOXD_SUDO_PWD missing from ~/.secrets"; exit 2; }
H=${BOXD_TEST_HOST:-}; [ -n "$H" ] || { echo "set BOXD_TEST_HOST to the host name"; exit 2; }
[ -n "${BOXD_TEST_IP:-}" ] || { echo "set BOXD_TEST_IP to the address that answers ping while the host is awake"; exit 2; }
BUILD_SSH=${BOXD_BUILD_ALIAS:-boxd-$H}
ADMIN_SSH=${BOXD_ADMIN_ALIAS:-$H}
BUILD_USER=${BOXD_TEST_USER:-boxd}
W=${BOXD_TEST_WORK:-/var/lib/boxd/work}
export BOXD_HOST=$H   # the client under test talks to the same host

fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
has() { case "$3" in *"$2"*) printf 'ok   %s\n' "$1" ;; *) printf 'FAIL %s: [%s] does not contain [%s]\n' "$1" "$3" "$2"; fails=$((fails + 1)) ;; esac; }

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/pod-acceptance.XXXXXX")

# adm '<one-line command>': run it as root on the host.
adm() { printf '%s\n' "$BOXD_SUDO_PWD" | ssh $ADMIN_SSH "sudo -S -p '' bash -c $(printf %q "$1")"; }
# bp '<one-line command>': run it as the build account, with its login environment (podman needs it).
bp() { adm "runuser -l $BUILD_USER -c $(printf %q "$1")"; }
# med <worktree> <client arguments...>: the client, run from inside the worktree.
med() { local wt=$1; shift; (cd "$wt" && node "$CLIENT" "$@" </dev/null); }
# mkwt <name> [file=content]...: a throwaway git repository; prints its path. Registers its box for cleanup.
mkwt() {
  local wt="$SCRATCH/$1" f; shift
  mkdir -p "$wt" && git -C "$wt" init -q
  for f in "$@"; do printf '%s\n' "${f#*=}" > "$wt/${f%%=*}"; done
  [ -e "$wt/.gitignore" ] || : > "$wt/.gitignore"
  # stdout is the path only: on a name used before, commit prints "nothing to commit" there and the caller gets a broken path
  git -C "$wt" add -A && git -C "$wt" -c user.name=t -c user.email=t@localhost commit -qm init >/dev/null
  echo "$wt"
}
# boxof <worktree>: the box name the contract derives from the worktree path.
boxof() {
  local base
  base=$(basename "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_.-]/-/g' | cut -c1-40)
  echo "$base-$(printf %s "$1" | cksum | cut -d' ' -f1)"
}
cid() { bp "podman inspect -f '{{.Id}}' pod-$1" 2>/dev/null; }
count() { bp "podman ps -a -q --filter label=boxd.box=$1" 2>/dev/null | grep -c .; }

# Everything below runs msb the way boxd-pod does: short MSB_HOME under $W/cache, umask 022.
MSB="umask 022; MSB_HOME=$W/cache/msb msb"
CG=/sys/fs/cgroup/boxd
msbq() { bp "$MSB $1" 2>/dev/null; }
# vmprocs <box>: host processes of the box's machine (the bracket keeps pgrep from matching its own command line).
vmprocs() { bp "pgrep -fc '[m]sb .*pod-$1' || true" 2>/dev/null | tail -1; }
vmpid() { bp "pgrep -f '[m]sb .*pod-$1' | head -1" 2>/dev/null; }
# bootid <worktree> [client flags]: the guest's boot id, one per start of the machine.
bootid() { local wt=$1; shift; med "$wt" "$@" -- cat /proc/sys/kernel/random/boot_id 2>/dev/null; }
oomkills() { adm "grep '^oom_kill ' $CG/memory.events" | cut -d' ' -f2; }
# podcmd '<pod command>': a command of the box protocol, over the build account's ssh like the client.
podcmd() { ssh $BUILD_SSH "pod $1" </dev/null; }
# quiet_wait: wait on the condition itself; if it never holds the run hangs here, which is the finding.
quiet_wait() { until [ "$(adm 'boxd-idle status --ignore-ssh' | head -1)" = quiet ]; do :; done; }
# vmfree: remove the machines of every worktree made so far, so the machine limit has room.
vmfree() {
  local d cmd=""
  for d in "$SCRATCH"/*/; do [ -d "$d" ] && cmd="$cmd $MSB rm -f pod-$(boxof "${d%/}");"; done
  [ -z "$cmd" ] || bp "$cmd" >/dev/null 2>&1
}
# capback: put back the build cgroup's caps that scenario 17 lowered (also run by cleanup).
capback() {
  [ -n "${CAP_MAX:-}" ] || return 0
  adm "echo $CAP_MAX > $CG/memory.max; echo $CAP_SWAP > $CG/memory.swap.max" >/dev/null 2>&1
  CAP_MAX=""
}

# The boxes are the worktrees in SCRATCH: mkwt runs in a subshell, so it cannot keep a list of its own.
cleanup() {
  local d b
  capback
  conf_back
  vkey_off
  for d in "$SCRATCH"/*/; do
    [ -d "$d" ] || continue
    b=$(boxof "${d%/}")
    bp "podman rm -f pod-$b; $MSB rm -f pod-$b; podman rmi -f localhost/built-$b:latest" >/dev/null 2>&1
    adm "rm -f $W/cache/images/built-$b.tar" >/dev/null 2>&1
    adm "rm -rf $W/jobs/$b" >/dev/null 2>&1
    [ -z "${H2:-}" ] || adm2 "runuser -l $BUILD_USER2 -c $(printf %q "podman rm -f pod-$b; $MSB2 rm -f pod-$b"); rm -rf $W2/jobs/$b" >/dev/null 2>&1
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

s1() {
  local wt box a b
  wt=$(mkwt agent-one a.txt=hello); box=$(boxof "$wt")
  med "$wt" -- sh -c 'echo made-in-call-one > /job/src/made.txt && apt-get update -qq >/dev/null && apt-get install -y -qq jq >/dev/null'; eq "call 1 writes a file and installs jq" 0 $?
  a=$(cid "$box")
  eq "call 2 sees the file and the package" "made-in-call-one jq-" \
    "$(med "$wt" --no-sync -- sh -c 'cat /job/src/made.txt; jq --version | cut -c1-3' 2>&1 | paste -sd' ')"
  b=$(cid "$box")
  eq "same container id in both calls" "$a" "$b"
  eq "the container id is not empty" yes "$([ -n "$a" ] && echo yes || echo no)"
}

s2() {
  local wa wb ba bb pa pb ra rb oa ob
  wa=$(mkwt agent-two-a only-a=1); wb=$(mkwt agent-two-b only-b=1)
  ba=$(boxof "$wa"); bb=$(boxof "$wb")
  oa="$SCRATCH/out-a"; ob="$SCRATCH/out-b"
  med "$wa" -- sh -c 'touch /job/src/made-a; ls /job/src' >"$oa" 2>&1 & pa=$!
  med "$wb" -- sh -c 'touch /job/src/made-b; ls /job/src' >"$ob" 2>&1 & pb=$!
  wait "$pa"; ra=$?; wait "$pb"; rb=$?
  eq "both simultaneous runs succeed" "0 0" "$ra $rb"
  eq "run a sees only its own files" "made-a only-a" "$(grep -v '^\.' "$oa" | paste -sd' ')"
  eq "run b sees only its own files" "made-b only-b" "$(grep -v '^\.' "$ob" | paste -sd' ')"
  eq "two different boxes" "2" "$(printf '%s\n%s\n' "$(cid "$ba")" "$(cid "$bb")" | grep -c . )"
  eq "the two container ids differ" "no" "$([ "$(cid "$ba")" = "$(cid "$bb")" ] && echo yes || echo no)"
}

s3() {
  local wt box pa pb ra rb
  wt=$(mkwt agent-three a=1); box=$(boxof "$wt")
  med "$wt" -- true >/dev/null 2>&1 & pa=$!
  med "$wt" -- true >/dev/null 2>&1 & pb=$!
  wait "$pa"; ra=$?; wait "$pb"; rb=$?
  eq "both first calls succeed" "0 0" "$ra $rb"
  eq "exactly one container for the worktree" 1 "$(count "$box")"
}

s4() {
  local wt box err rc
  wt=$(mkwt agent-image a=1); box=$(boxof "$wt")
  has "--image rust:1.83 gives rustc 1.83" "rustc 1.83" "$(med "$wt" --image rust:1.83 -- rustc --version 2>&1)"
  err=$(med "$wt" --image debian:stable-slim -- true 2>&1 >/dev/null); rc=$?
  eq "another image without --recreate exits 125" 125 "$rc"
  has "refusal names the box, both images and the fix" "boxd-pod: box $box runs " "$err"
  has "refusal ends with the contract's hint" "; add --recreate" "$err"
  has "refusal names the old image" "rust:1.83" "$err"
  has "refusal names the new image" "debian:stable-slim" "$err"
  med "$wt" --image debian:stable-slim --recreate -- sh -c 'cat /etc/os-release' 2>&1 | grep -q '^ID=debian'
  eq "--recreate switches to the other image" 0 "${PIPESTATUS[0]}"
}

s5() {
  local wt script want got
  wt=$(mkwt agent-text a=1)
  med "$wt" -- sh -c 'exit 7' >/dev/null 2>&1; eq "exit code 7 passes through" 7 $?
  med "$wt" -- false >/dev/null 2>&1; eq "exit code 1 passes through" 1 $?
  script=$(printf '%s\n' "echo \"it's\" \$HOME" 'printf "%s\n" "a b" '"'"'$HOME'"'")
  want="it's /root
a b
\$HOME"
  got=$(med "$wt" -- sh -c "$script" 2>&1)
  eq "multi-line shell with quotes and dollar survives" "$want" "$got"
}

s6() {
  local wt box run out log n=0
  wt=$(mkwt agent-detach a=1); box=$(boxof "$wt")
  med "$wt" -- mkfifo /job/gate >/dev/null 2>&1
  out=$(med "$wt" --detach -- sh -c 'read x < /job/gate; echo job-done'); eq "--detach returns at once with exit 0" 0 $?
  run=$(printf '%s\n' "$out" | grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{4}' | head -1)
  eq "a run id comes back" yes "$([ -n "$run" ] && echo yes || echo no)"
  eq "while the job runs the machine is not quiet" "no" "$([ "$(adm 'boxd-idle status' | head -1)" = quiet ] && echo yes || echo no)"
  adm "echo go > $W/jobs/$box/gate"
  log=""
  until printf '%s' "$log" | grep -q '^EXIT '; do
    log=$(med "$wt" --no-sync -- cat "/job/runs/$run.log" 2>/dev/null)
    n=$((n + 1)); [ "$n" -lt 300 ] || break
  done
  eq "the log ends with EXIT 0" "EXIT 0" "$(printf '%s\n' "$log" | tail -1)"
  has "the log holds the job output" "job-done" "$log"
}

s7() {
  local wt box old new
  wt=$(mkwt agent-reap keep=me); box=$(boxof "$wt")
  med "$wt" -- true >/dev/null 2>&1; old=$(cid "$box")
  adm "touch -d '-31 min' $W/jobs/$box/.last-used"
  adm "runuser -u $BUILD_USER -- boxd-pod reap" >/dev/null 2>&1
  eq "the old box's container is gone" 0 "$(count "$box")"
  eq "its files are still there" me "$(adm "cat $W/jobs/$box/src/keep" 2>/dev/null)"
  med "$wt" --no-sync -- true >/dev/null 2>&1; eq "the next call works" 0 $?
  new=$(cid "$box")
  eq "the next call recreated the container" "yes" "$([ -n "$new" ] && [ "$new" != "$old" ] && echo yes || echo no)"
}

s8() {
  local wt box want got big rc
  wt=$(mkwt agent-limits a=1); box=$(boxof "$wt")
  med "$wt" -- true >/dev/null 2>&1
  want="$POD_MEMORY_BYTES $POD_PIDS"
  eq "podman inspect shows the configured limits" "$want" "$(bp "podman inspect -f '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' pod-$box" 2>/dev/null)"
  got=$(med "$wt" --no-sync -- sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max' 2>/dev/null | paste -sd' ')
  eq "the cgroup shows memory.max and pids.max" "$want" "$got"
  # tail keeps all of a line-less input: it grows past memory plus swap (zeros compress to almost nothing in
  # zram, so a fixed size just above the memory cap can fit in swap and pass), so it is always killed.
  med "$wt" --no-sync -- sh -c "tail /dev/zero" >/dev/null 2>&1; rc=$?
  eq "a process above the memory cap is killed (137)" 137 "$rc"
  med "$wt" --no-sync -- true >/dev/null 2>&1; eq "the host still answers after the kill" 0 $?
}

s9() {
  local wt box before after n=0
  wt=$(mkwt agent-sleep a=1); box=$(boxof "$wt")
  med "$wt" -- true >/dev/null 2>&1; before=$(cid "$box")
  # Wait on the condition itself: load left by earlier scenarios decays on an idle machine; if it never does,
  # the run hangs here, which is a real failure to look at, not a timeout to tune.
  until [ "$(adm 'boxd-idle status --ignore-ssh' | head -1)" = quiet ]; do read -t 2 <> <(:) || true; done
  eq "with a box running and no session the machine is quiet" quiet "$(adm 'boxd-idle status --ignore-ssh' | head -1)"
  adm 'setsid -f zzz >/dev/null 2>&1' </dev/null
  n=0; while ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 120 ] || break; done
  eq "the machine stops answering ping (it sleeps)" no "$(ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1 && echo yes || echo no)"
  med "$wt" --no-sync -- true >/dev/null 2>&1; eq "a normal client call wakes it and works" 0 $?
  after=$(cid "$box")
  eq "the same container is still running after the wake" "$before" "$after"
  eq "and it is running, not restarted" true "$(bp "podman inspect -f '{{.State.Running}}' pod-$box" 2>/dev/null)"
}

s10() {
  local wt box
  wt=$(mkwt agent-sync a.txt=1 b.txt=2 .gitignore=target/); box=$(boxof "$wt")
  med "$wt" -- sh -c 'mkdir -p target && echo out > target/o' >/dev/null 2>&1
  rm "$wt/b.txt"
  eq "deleted locally disappears remotely, ignored output survives" "a.txt target/o" \
    "$(med "$wt" -- sh -c 'ls; ls target | sed s,^,target/,' 2>/dev/null | grep -v '^$' | grep -v '^target$' | paste -sd' ')"
  med "$wt" --pull gen.txt -- sh -c 'echo from-remote > gen.txt' >/dev/null 2>&1
  eq "--pull brings a remote file back" from-remote "$(cat "$wt/gen.txt" 2>/dev/null)"
}

# Virtual machine scenarios. Each starts with vmfree: the limit BOXD_VM_MAX counts every running machine,
# so machines left by earlier scenarios would turn a working box away.
s11() {
  local wt guest host box
  vmfree
  wt=$(mkwt agent-vm-kernel a=1); box=$(boxof "$wt")
  guest=$(med "$wt" --vm -- uname -r 2>/dev/null); eq "the --vm call succeeds" 0 $?
  host=$(adm 'uname -r')
  eq "the guest runs the kernel 6.12 of microsandbox" 6.12 "$(printf %s "$guest" | cut -d. -f1,2)"
  eq "the guest kernel differs from the host kernel" no "$([ "$guest" = "$host" ] && echo yes || echo no)"
  eq "root inside the machine" 0 "$(med "$wt" --vm --no-sync -- id -u 2>/dev/null)"
  eq "the box is a microsandbox named pod-<box>" yes "$(msbq ls | grep -q "pod-$box" && echo yes || echo no)"
  eq "one machine process runs for the box" 1 "$(vmprocs "$box")"
  eq "the box is not a podman container" 0 "$(count "$box")"
}

s12() {
  local wt box a b pa pb w2 r1 r2 p1 p2
  vmfree
  wt=$(mkwt agent-vm-same a=1); box=$(boxof "$wt")
  med "$wt" --vm -- sh -c 'echo state-one > /tmp/in-guest' >/dev/null 2>&1; eq "first --vm call works" 0 $?
  a=$(bootid "$wt" --vm --no-sync); pa=$(vmpid "$box")
  eq "call 2 sees the guest file made by call 1" state-one "$(med "$wt" --vm --no-sync -- cat /tmp/in-guest 2>/dev/null)"
  b=$(bootid "$wt" --vm --no-sync); pb=$(vmpid "$box")
  eq "same boot id in every call" "$a" "$b"
  eq "same machine process in every call" "$pa" "$pb"
  eq "the boot id and the process id are not empty" yes "$([ -n "$a" ] && [ -n "$pb" ] && echo yes || echo no)"
  # /tmp is the box's own sparse disk: room for tools that need over 20 GiB free, writable by every user.
  eq "/tmp in the machine has at least 25 GiB free and mode 1777" "yes 1777" \
    "$(med "$wt" --vm --no-sync -- sh -c 'k=$(df -Pk /tmp | awk "NR==2 {print \$4}"); [ "$k" -ge 26214400 ] && echo yes || echo "no ($k KiB)"; stat -c %a /tmp' 2>/dev/null | paste -sd' ')"
  vmfree   # the race needs a free slot even where the limit is one machine
  w2=$(mkwt agent-vm-race a=1)
  med "$w2" --vm -- true >/dev/null 2>&1 & p1=$!
  med "$w2" --vm -- true >/dev/null 2>&1 & p2=$!
  wait "$p1"; r1=$?; wait "$p2"; r2=$?
  eq "both simultaneous first --vm calls succeed" "0 0" "$r1 $r2"
  eq "exactly one machine process for the worktree" 1 "$(vmprocs "$(boxof "$w2")")"
}

s13() {
  local wt out rc
  vmfree
  wt=$(mkwt agent-vm-docker a=1)
  # No dockerd in the command: the box starts it by itself (contract, "docker starts by itself").
  out=$(med "$wt" --vm --image localhost/toolbox -- docker run --rm docker.io/library/alpine:3 echo inside-docker 2>&1); rc=$?
  eq "docker run inside the machine exits 0" 0 "$rc"
  has "the container inside the machine printed its line" inside-docker "$out"
  eq "docker's storage driver is overlay2, not a slow fallback" overlay2 \
    "$(med "$wt" --vm --no-sync -- docker info -f '{{.Driver}}' 2>/dev/null)"
  # Kill the daemon and wait on its exit; the next call must bring it back.
  med "$wt" --vm --no-sync -- sh -c 'p=$(cat /var/run/docker.pid); kill -9 "$p"; while kill -0 "$p" 2>/dev/null; do :; done' >/dev/null 2>&1
  eq "after the daemon died, the next call finds docker running again" 0 \
    "$(med "$wt" --vm --no-sync -- docker info >/dev/null 2>&1; echo $?)"
  has "the daemon log is readable through the box" "Starting up" "$(med "$wt" --vm --no-sync -- cat /job/runs/dockerd.log 2>/dev/null)"
}

s14() {
  local wt out rc
  vmfree
  wt=$(mkwt agent-vm-podman a=1)
  eq "podman inside uses cgroupfs (set by the image)" cgroupfs \
    "$(med "$wt" --vm --image localhost/toolbox -- podman info -f '{{.Host.CgroupManager}}' 2>/dev/null)"
  out=$(med "$wt" --vm --no-sync -- podman run --rm docker.io/library/alpine:3 echo inside-podman 2>&1); rc=$?
  eq "podman run inside the machine exits 0" 0 "$rc"
  has "the container inside the machine printed its line" inside-podman "$out"
}

s15() {
  local wt box
  vmfree
  wt=$(mkwt agent-vm-sync a.txt=hello b.txt=2 .gitignore=target/); box=$(boxof "$wt")
  printf '#!/bin/sh\n' > "$wt/tool.sh"; chmod +x "$wt/tool.sh"
  eq "the guest sees the pushed file and its executable bit" "hello|exec" \
    "$(med "$wt" --vm -- sh -c 'cat a.txt; test -x tool.sh && echo exec' 2>/dev/null | paste -sd'|')"
  med "$wt" --vm --no-sync -- sh -c 'echo from-guest > /job/src/made && mkdir -p target && echo out > target/o' >/dev/null 2>&1
  eq "a file the guest made as root lands on the host under $W/jobs" from-guest "$(adm "cat $W/jobs/$box/src/made" 2>/dev/null)"
  eq "and it belongs to the build account" "$BUILD_USER" "$(adm "stat -c %U $W/jobs/$box/src/made" 2>/dev/null)"
  # --no-sync: a sync first would delete the guest-made file (it is not in the worktree and not ignored).
  med "$wt" --vm --no-sync --pull made -- true >/dev/null 2>&1
  eq "--pull brings the guest's file to workstation" from-guest "$(cat "$wt/made" 2>/dev/null)"
  printf 'changed\n' > "$wt/a.txt"; rm "$wt/b.txt"
  eq "a changed file arrives, a deleted one is gone, build output survives" "changed|b-gone|out" \
    "$(med "$wt" --vm -- sh -c 'cat a.txt; test -e b.txt && echo b-present || echo b-gone; cat target/o' 2>/dev/null | paste -sd'|')"
}

s16() {
  local wt box pid rc kb before after b1 b2
  vmfree
  wt=$(mkwt agent-vm-limit a=1); box=$(boxof "$wt")
  b1=$(bootid "$wt" --vm); pid=$(vmpid "$box")
  kb=$(med "$wt" --vm --no-sync -- sh -c "awk '/^MemTotal/ {print \$2}' /proc/meminfo" 2>/dev/null)
  eq "the guest has no more than the 8 GiB of BOXD_VM_LIMITS" yes "$([ -n "$kb" ] && [ "$kb" -le 8388608 ] && echo yes || echo no)"
  before=$(oomkills)
  # tail keeps all of a line-less input, so it always outgrows the guest's memory.
  med "$wt" --vm --no-sync -- sh -c "tail /dev/zero" >/dev/null 2>&1; rc=$?
  eq "a process above the guest's memory is killed inside (137)" 137 "$rc"
  after=$(oomkills)
  eq "the host cgroup of build saw no out-of-memory kill" "$before" "$after"
  b2=$(bootid "$wt" --vm --no-sync)
  eq "the machine is the same one: same boot id" "$b1" "$b2"
  eq "and the same host process" "$pid" "$(vmpid "$box")"
  eq "the host still answers a container box" 0 "$(med "$(mkwt agent-vm-limit-pod a=1)" -- true >/dev/null 2>&1; echo $?)"
}

s17() {
  local wt box before after rc b1 b2
  vmfree
  wt=$(mkwt agent-vm-hostcap keep=me); box=$(boxof "$wt")
  b1=$(bootid "$wt" --vm)
  # Lower the cgroup's own cap for this one call, so the host (not the guest) runs out of memory. Swap off:
  # zeros compress to almost nothing in zram and would hide the cap. cleanup() puts the old values back.
  # Reclaimable file cache counts in memory.current but is given back before any kill, so earlier scenarios left a
  # headroom larger than the 1.5 GB this scenario means; reclaim it first (guests here may be smaller than the 8 GB it was written for).
  adm "echo 100G > $CG/memory.reclaim" >/dev/null 2>&1
  CAP_MAX=$(adm "cat $CG/memory.max"); CAP_SWAP=$(adm "cat $CG/memory.swap.max")
  adm "echo 0 > $CG/memory.swap.max; echo \$(( \$(cat $CG/memory.current) + 1610612736 )) > $CG/memory.max"
  before=$(oomkills)
  med "$wt" --vm --no-sync -- sh -c "tail /dev/zero" >/dev/null 2>&1; rc=$?
  capback
  after=$(oomkills)
  eq "the call failed" yes "$([ "$rc" != 0 ] && echo yes || echo no)"
  eq "the host cgroup counted an out-of-memory kill" yes "$([ "$after" -gt "$before" ] && echo yes || echo no)"
  eq "the whole machine is gone" 0 "$(vmprocs "$box")"
  eq "the host still answers" 0 "$(adm true >/dev/null 2>&1; echo $?)"
  eq "the files of the box are kept" me "$(adm "cat $W/jobs/$box/src/keep" 2>/dev/null)"
  eq "the next call restarts the box and sees the files" me "$(med "$wt" --vm -- cat /job/src/keep 2>/dev/null)"
  b2=$(bootid "$wt" --vm --no-sync)
  eq "it is a new boot" yes "$([ -n "$b2" ] && [ "$b2" != "$b1" ] && echo yes || echo no)"
}

s18() {
  local wt box old new
  vmfree
  eq "the boot marker exists, so the reaper looks at machines" 0 "$(adm 'test -e /run/boxd-pod.clean'; echo $?)"
  wt=$(mkwt agent-vm-reap keep=me); box=$(boxof "$wt")
  med "$wt" --vm -- sh -c 'echo guest-state > /tmp/g' >/dev/null 2>&1; old=$(bootid "$wt" --vm --no-sync)
  adm "touch -d '-31 min' $W/jobs/$box/.last-used"
  bp 'boxd-pod reap' >/dev/null 2>&1
  eq "the machine process is gone" 0 "$(vmprocs "$box")"
  eq "msb no longer lists the box" no "$(msbq ls | grep -q "pod-$box" && echo yes || echo no)"
  eq "its files are still there" me "$(adm "cat $W/jobs/$box/src/keep" 2>/dev/null)"
  new=$(bootid "$wt" --vm --no-sync)
  eq "the next call boots a new machine" yes "$([ -n "$new" ] && [ "$new" != "$old" ] && echo yes || echo no)"
  eq "the guest's own state is gone, the folder is not" "no|me" \
    "$(med "$wt" --vm --no-sync -- sh -c 'test -e /tmp/g && echo yes || echo no; cat /job/src/keep' 2>/dev/null | paste -sd'|')"
}

s19() {
  local wt box pid before after n=0
  vmfree
  wt=$(mkwt agent-vm-sleep a=1); box=$(boxof "$wt")
  med "$wt" --vm -- sh -c 'echo alive > /tmp/g' >/dev/null 2>&1
  before=$(bootid "$wt" --vm --no-sync); pid=$(vmpid "$box")
  quiet_wait
  eq "with a machine running and no session the host is quiet" quiet "$(adm 'boxd-idle status --ignore-ssh' | head -1)"
  adm 'setsid -f zzz >/dev/null 2>&1' </dev/null
  while ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 120 ] || break; done
  eq "the host stops answering ping (it sleeps)" no "$(ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1 && echo yes || echo no)"
  med "$wt" --vm --no-sync -- true >/dev/null 2>&1; eq "a normal client call wakes it and works" 0 $?
  after=$(bootid "$wt" --vm --no-sync)
  eq "the same machine process runs after the wake" "$pid" "$(vmpid "$box")"
  eq "the same boot, not a restart" "$before" "$after"
  eq "the guest's memory state survived the suspend" alive "$(med "$wt" --vm --no-sync -- cat /tmp/g 2>/dev/null)"
}

s20() {
  local wp wv bp_ bv oa ob pa pb ra rb podid err rc
  vmfree
  wp=$(mkwt agent-mix-pod a=1); wv=$(mkwt agent-mix-vm a=1)
  bp_=$(boxof "$wp"); bv=$(boxof "$wv")
  oa="$SCRATCH/mix-pod"; ob="$SCRATCH/mix-vm"
  med "$wp" -- sh -c 'uname -r; touch /job/src/made-pod' >"$oa" 2>&1 & pa=$!
  med "$wv" --vm -- sh -c 'uname -r; touch /job/src/made-vm' >"$ob" 2>&1 & pb=$!
  wait "$pa"; ra=$?; wait "$pb"; rb=$?
  eq "both simultaneous first calls succeed" "0 0" "$ra $rb"
  eq "the two kernels differ" no "$([ "$(head -1 "$oa")" = "$(head -1 "$ob")" ] && echo yes || echo no)"
  eq "the container box is one container and no machine" "1 0" "$(count "$bp_") $(vmprocs "$bp_")"
  eq "the machine box is one machine and no container" "0 1" "$(count "$bv") $(vmprocs "$bv")"
  eq "pod list shows each box with its engine in the fifth column" "container vm" \
    "$(podcmd list | awk -v a="$bp_" -v b="$bv" '$1 == a || $1 == b {print $5}' | sort | paste -sd' ')"
  # One name, two engines: refused without --recreate, and the refusal changes nothing.
  podid=$(cid "$bp_")
  # --no-sync on refused calls too: their sync runs before the refusal and would delete made-pod.
  err=$(med "$wp" --vm --no-sync -- true 2>&1 >/dev/null); rc=$?
  eq "a container box asked for a machine exits 125" 125 "$rc"
  has "the refusal names the engines and the fix" "boxd-pod: box $bp_ is a container, asked for a virtual machine; add --recreate" "$err"
  # No engine named keeps the box as it is (sticky boxes); --container names the other engine.
  err=$(med "$wv" --container --no-sync -- true 2>&1 >/dev/null); rc=$?
  eq "a machine box asked for a container exits 125" 125 "$rc"
  has "the refusal names the engines and the fix" "boxd-pod: box $bv is a virtual machine, asked for a container; add --recreate" "$err"
  eq "both boxes are as they were" "$podid 1" "$(cid "$bp_") $(vmprocs "$bv")"
  # The switch needs a free machine slot even where the limit is one: the other box gives its slot back (files stay).
  bp "$MSB rm -f pod-$bv" >/dev/null 2>&1
  # --recreate switches the engine and keeps the files.
  # --no-sync: a sync would delete made-pod (made in the box, not in the worktree) before the switch.
  med "$wp" --vm --recreate --no-sync -- true >/dev/null 2>&1
  eq "--recreate turned the container box into a machine box" "0 1" "$(count "$bp_") $(vmprocs "$bp_")"
  eq "its files stayed" 1 "$(adm "test -e $W/jobs/$bp_/src/made-pod && echo 1 || echo 0")"
  med "$wp" --container --recreate --no-sync -- true >/dev/null 2>&1
  eq "--recreate turned it back into a container box" "1 0" "$(count "$bp_") $(vmprocs "$bp_")"
  med "$wv" --vm --no-sync -- true >/dev/null 2>&1   # the machine box back, for the reap checks
  # The reaper treats the engines alike and independently.
  adm "touch -d '-31 min' $W/jobs/$bv/.last-used"
  bp 'boxd-pod reap' >/dev/null 2>&1
  eq "reaping the idle machine leaves the container alone" "1 0" "$(count "$bp_") $(vmprocs "$bv")"
  med "$wv" --vm --no-sync -- true >/dev/null 2>&1
  adm "touch -d '-31 min' $W/jobs/$bp_/.last-used"
  bp 'boxd-pod reap' >/dev/null 2>&1
  eq "reaping the idle container leaves the revived machine alone" "0 1" "$(count "$bp_") $(vmprocs "$bv")"
}

s21() {
  local max i wt over err rc
  vmfree
  max=$(adm '. /etc/boxd/boxd.conf; echo ${BOXD_VM_MAX:-}')
  [ -n "$max" ] || { echo "skip BOXD_VM_MAX is not set on this host (machines are admitted by measured memory)"; return; }
  eq "no machine of another user runs (the limit counts every machine)" 0 "$(bp "pgrep -fc '[m]sb .*pod-' || true" 2>/dev/null | tail -1)"
  for ((i = 1; i <= max; i++)); do
    wt=$(mkwt "agent-vm-max-$i" a=1)
    med "$wt" --vm -- true >/dev/null 2>&1; eq "machine $i of $max starts" 0 $?
  done
  over=$(mkwt agent-vm-max-over a=1)
  err=$(med "$over" --vm -- true 2>&1 >/dev/null); rc=$?
  eq "one more machine is refused with exit 75 (no room)" 75 "$rc"
  has "the refusal says how many run" "boxd-pod: no room for another virtual machine ($max of $max running); wait for one to end or stop one" "$err"
  eq "the refused box has no machine" 0 "$(vmprocs "$(boxof "$over")")"
  eq "a machine that already runs still answers at the limit" 0 "$(med "$SCRATCH/agent-vm-max-1" --vm --no-sync -- true >/dev/null 2>&1; echo $?)"
  eq "a container box still starts at the limit" 0 "$(med "$(mkwt agent-vm-max-pod a=1)" -- true >/dev/null 2>&1; echo $?)"
  podcmd "stop $(boxof "$SCRATCH/agent-vm-max-1")" >/dev/null 2>&1
  med "$over" --vm -- true >/dev/null 2>&1; eq "after one machine is stopped the refused box starts" 0 $?
}

s22() {
  local rc
  scp -q "$REPO/tests/work-acceptance.sh" $ADMIN_SSH:/tmp/work-acceptance.sh || { eq "copy work-acceptance to the host" 0 1; return; }
  adm "BOXD_TEST_ALLOW_WRITE=$(printf %q "${BOXD_TEST_ALLOW_WRITE:-}") bash /tmp/work-acceptance.sh" >"$SCRATCH/work.out" 2>&1; rc=$?
  eq "tests/work-acceptance.sh passes with boxes present" "0 ALL OK" "$rc $(tail -1 "$SCRATCH/work.out")"
  [ "$rc" = 0 ] || grep -E "^FAIL" "$SCRATCH/work.out" | sed "s/^/    work-acceptance: /"
  grep "reset said" "$SCRATCH/work.out" | sed "s/^/    work-acceptance: /"   # the reset's notes, also on success
}

# s23 <engine flag>: a detached command waits on a fifo in a subfolder; box ps must show it, then it is released.
ps_check() {
  local wt=$1 box=$2 eng=$3 run out log n=0
  med "$wt" $eng -- sh -c 'mkdir -p /job/src/sub && mkfifo /job/gate' >/dev/null 2>&1
  out=$(med "$wt" $eng --no-sync --detach -- sh -c 'cd /job/src/sub && exec sh -c "read x < /job/gate"')
  run=$(printf '%s\n' "$out" | grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{4}' | head -1)
  # The waiting command exists once its fifo has a reader; the report is read until it shows it, count-bounded.
  until printf '%s' "$out" | grep -q 'read x < /job/gate'; do
    out=$(med "$wt" ps 2>&1); n=$((n + 1)); [ "$n" -lt 100 ] || break
  done
  has "$eng box ps shows the waiting command" 'sh -c read x < /job/gate' "$out"
  eq "$eng its row has the subfolder as working folder" /job/src/sub \
    "$(printf '%s\n' "$out" | grep 'read x < /job/gate' | awk '{print $4}' | head -1)"
  eq "$eng the table starts with its header" "PID AGE CPU FOLDER COMMAND" "$(printf '%s\n' "$out" | head -1 | tr -s ' ')"
  eq "$eng the box's own keep-alive is left out" 0 "$(printf '%s\n' "$out" | grep -c 'sleep infinity')"
  # Released from inside the box: a fifo belongs to one kernel, so a host write never reaches a guest reader.
  med "$wt" $eng --no-sync -- sh -c "echo go > /job/gate" >/dev/null 2>&1
  log=""; n=0
  until printf '%s' "$log" | grep -q '^EXIT '; do
    log=$(med "$wt" $eng --no-sync -- cat "/job/runs/$run.log" 2>/dev/null); n=$((n + 1)); [ "$n" -lt 300 ] || break
  done
  eq "$eng the released command ended normally" "EXIT 0" "$(printf '%s\n' "$log" | tail -1)"
}
s23() {
  local wt box
  wt=$(mkwt agent-ps a=1); box=$(boxof "$wt")
  ps_check "$wt" "$box" --container
  eq "box ps of a box on no engine exits 125" 125 "$(med "$wt" ps --pod agent-ps-none-1 >/dev/null 2>&1; echo $?)"
  vmfree
  wt=$(mkwt agent-ps-vm a=1); box=$(boxof "$wt")
  ps_check "$wt" "$box" --vm
}

s24() {
  local allow first ip port wt
  allow=$(adm '. /etc/boxd/boxd.conf 2>/dev/null; echo "${BOXD_VM_NET_ALLOW:-}"')
  if [ -z "$allow" ]; then echo "skip BOXD_VM_NET_ALLOW is not set on this host"; return; fi
  first=${allow%% *}; ip=${first%%[:/]*}; port=${first##*:}; port=${port%%-*}
  vmfree
  wt=$(mkwt agent-vm-net a=1)
  eq "a new vm box connects to $ip:$port (listed)" open \
    "$(med "$wt" --vm --image localhost/toolbox -- bash -c "exec 3<>/dev/tcp/$ip/$port && echo open || echo refused" 2>/dev/null | tail -1)"
  eq "the same address on port 22 is refused (not listed)" refused \
    "$(med "$wt" --vm --no-sync -- bash -c "(exec 3<>/dev/tcp/$ip/22) 2>/dev/null && echo open || echo refused" 2>/dev/null | tail -1)"
  eq "the public internet still works" ok \
    "$(med "$wt" --vm --no-sync -- sh -c 'curl -s -o /dev/null https://example.com && echo ok || echo no' 2>/dev/null | tail -1)"
}

# built_flow <engine flag>: one worktree, a Containerfile that writes a marker and copies note.txt.
# Identity of the box: the container id, or the guest's boot id for a machine (new box, new boot).
cf() { printf 'FROM docker.io/library/alpine:3\nRUN echo %s > /marker\nCOPY note.txt /note.txt\n' "$2" > "$1/Containerfile"; }
ident() { if [ "$3" = --vm ]; then bootid "$1" --vm --no-sync; else cid "$2"; fi; }
built_flow() {
  local eng=$1 wt box a b c
  wt=$(mkwt "agent-built${eng#--}" note.txt=the-note .gitignore=kept.txt); box=$(boxof "$wt")   # kept.txt is ignored, so the sync keeps it
  cf "$wt" v1
  eq "$eng first call: the marker and the copied note" "v1 the-note" "$(med "$wt" "$eng" --image-file Containerfile -- cat /marker /note.txt 2>/dev/null | paste -sd' ')"
  a=$(ident "$wt" "$box" "$eng")
  med "$wt" "$eng" --no-sync -- sh -c 'echo kept > /job/src/kept.txt' >/dev/null 2>&1
  eq "$eng second call, Containerfile unchanged: same box" "v1 $a" \
    "$(med "$wt" "$eng" --image-file Containerfile -- cat /marker 2>/dev/null) $(ident "$wt" "$box" "$eng")"
  cf "$wt" v2
  eq "$eng edited Containerfile: the new marker" v2 "$(med "$wt" "$eng" --image-file Containerfile -- cat /marker 2>/dev/null)"
  b=$(ident "$wt" "$box" "$eng")
  eq "$eng edited Containerfile: a different box" no "$([ -n "$b" ] && [ "$a" != "$b" ] && echo no || echo same)"
  eq "$eng the file made under /job/src before is still there" kept "$(med "$wt" "$eng" --no-sync -- cat /job/src/kept.txt 2>/dev/null)"
  printf 'FROM docker.io/library/alpine:3\nRUN false\n' > "$wt/Containerfile"
  med "$wt" "$eng" --image-file Containerfile -- cat /marker >/dev/null 2>&1; eq "$eng broken Containerfile exits 125" 125 $?
  c=$(ident "$wt" "$box" "$eng")
  eq "$eng after the broken build the v2 box still answers, unchanged" "v2 $b" "$(med "$wt" "$eng" --no-sync -- cat /marker 2>/dev/null) $c"
}
s25() {
  built_flow --container
  vmfree
  built_flow --vm
}

env_check() {
  local wt=$1 eng=$2 val=$3
  eq "$eng the command sees the credential" "$val" "$(export GH_TOKEN=$val; med "$wt" $eng --env GH_TOKEN -- sh -c 'printf %s "$GH_TOKEN"' 2>/dev/null)"
  eq "$eng a later call without --env does not see it" "" "$(med "$wt" $eng --no-sync -- sh -c 'printf %s "${GH_TOKEN:-}"' 2>/dev/null)"
  eq "$eng the value is in no file under the work area" 0 "$(adm "grep -rlF $val $W/cache/calls.log $W/jobs/$(boxof "$wt") 2>/dev/null | wc -l")"   # this box's own folder: the whole job area is many gigabytes on a used host
}
s26() {
  env_check "$(mkwt agent-env a=1)" --container "envtest-$$-c"
  vmfree
  env_check "$(mkwt agent-env-vm a=1)" --vm "envtest-$$-v"
}

# guestmb <worktree> <client arguments...>: MemTotal inside the machine, in megabytes.
guestmb() { med "$1" --vm --no-sync "${@:2}" -- sh -c 'grep MemTotal /proc/meminfo' 2>/dev/null | awk '{print int($2 / 1024)}'; }
# near <megabytes> <size>: yes when the guest total is within 25 % below and 5 % above the asked size (the guest kernel keeps some).
near() { [ -n "$1" ] && [ "$1" -ge $(($2 * 75 / 100)) ] && [ "$1" -le $(($2 * 105 / 100)) ] && echo yes || echo no; }
s27() {
  local wt box err rc
  vmfree
  wt=$(mkwt agent-vm-size a=1); box=$(boxof "$wt")
  eq "a small machine has 2 processors" 2 "$(med "$wt" --vm --size small -- nproc 2>/dev/null)"
  eq "a small machine has about 2 GB" yes "$(near "$(guestmb "$wt")" 2048)"
  eq "a call without --size keeps the small machine" 2 "$(med "$wt" --vm --no-sync -- nproc 2>/dev/null)"
  eq "the size is recorded in the job folder" small "$(adm "cat $W/jobs/$box/.vm-size")"
  err=$(med "$wt" --vm --size large --no-sync -- true 2>&1 >/dev/null); rc=$?
  eq "--size large on the small box is refused with 125" 125 "$rc"
  has "the refusal is the sticky message" "boxd-pod: box $box is small, asked for large; add --recreate" "$err"
  eq "the refused call left the small machine" 2 "$(med "$wt" --vm --no-sync -- nproc 2>/dev/null)"
  med "$wt" --vm --recreate --size medium --no-sync -- true >/dev/null 2>&1; eq "--recreate --size medium succeeds" 0 $?
  eq "a medium machine has 4 processors" 4 "$(med "$wt" --vm --no-sync -- nproc 2>/dev/null)"
  eq "a medium machine has about 4 GB" yes "$(near "$(guestmb "$wt")" 4096)"
  eq "--size with a container box is refused with 125" 125 "$(med "$(mkwt agent-vm-size-pod a=1)" --size small -- true >/dev/null 2>&1; echo $?)"
  eq "an unknown size word is refused by the client with 2" 2 "$(med "$wt" --vm --size huge -- true >/dev/null 2>&1; echo $?)"
}

# Load management (docs/designs/load-management.md), scenarios 28 to 36 = the design's scenarios 1 to 9. They need two
# real hosts: BOXD_TEST_HOST2 names a second host set up with `box setup` (build account reached as boxd-<name>, admin
# account as plain <name> or BOXD_ADMIN_ALIAS2, the same sudo password), with a small BOXD_VM_MAX so it fills quickly.
# The same scenarios against the fake ssh, which need no host, are in tests/box-client.test.mts.
# The client under test runs with a scratch HOME (ssh config markers and hosts.order for the two hosts, a copy of the
# real wake.json) and without BOXD_HOST, so it chooses; ssh itself still reads the real ~/.ssh/config. A shim in front
# of ssh records every ssh call, to prove which host was (not) asked.
H2=${BOXD_TEST_HOST2:-}
ADMIN_SSH2=${BOXD_ADMIN_ALIAS2:-$H2}
# The second host may differ from the first in its build account and work area (BOXD_TEST_USER2, BOXD_TEST_WORK2).
BUILD_USER2=${BOXD_TEST_USER2:-$BUILD_USER}
W2=${BOXD_TEST_WORK2:-$W}
MSB2="MSB_HOME=$W2/cache/msb msb"
LD_BOXES=()
adm2() { printf '%s\n' "${BOXD_SUDO_PWD2:-$BOXD_SUDO_PWD}" | ssh $ADMIN_SSH2 "sudo -S -p '' bash -c $(printf %q "$1")"; }
bp2() { adm2 "runuser -l $BUILD_USER2 -c $(printf %q "$1")"; }
ld_need() {
  [ -n "$H2" ] && return 0
  echo "skip BOXD_TEST_HOST2 is not set: these scenarios need two real hosts"; return 1
}
ld_home() {
  [ -n "${PH:-}" ] && return 0
  PH=$SCRATCH/home; SHIM=$SCRATCH/shim; SSHLOG=$SCRATCH/ssh.log
  mkdir -p "$PH/.ssh" "$PH/.config/boxd" "$SHIM"
  local h
  for h in "$H" "$H2"; do printf '# boxd:host:boxd-%s:begin\nHost boxd-%s\n# boxd:host:boxd-%s:end\n' "$h" "$h" "$h"; done > "$PH/.ssh/config"
  printf '%s\n%s\n' "$H" "$H2" > "$PH/.config/boxd/hosts.order"; printf '%s\n' "$H" > "$PH/.config/boxd/host"
  [ -r "$HOME/.config/boxd/wake.json" ] && cp "$HOME/.config/boxd/wake.json" "$PH/.config/boxd/"
  printf '#!/bin/sh\necho "$*" >> %s\nexec %s "$@"\n' "$SSHLOG" "$(command -v ssh)" > "$SHIM/ssh"; chmod +x "$SHIM/ssh"
  # "Full" must be a fact the scenario controls: a host that admits machines by measured memory never fills with idle
  # ones. For these scenarios the first host gets a ceiling of 2 machines; cleanup puts its settings back (conf_back).
  if [ -z "$(adm '. /etc/boxd/boxd.conf; echo ${BOXD_VM_MAX:-}' | tail -1)" ]; then
    [ -n "$POWER_CONF_SAVED" ] || { adm 'cp -p /etc/boxd/boxd.conf /etc/boxd/boxd.conf.acceptance'; POWER_CONF_SAVED=1; }
    adm "printf 'BOXD_VM_MAX=2\\n' >> /etc/boxd/boxd.conf"
  fi
}
# mc <worktree> <client arguments...>: the client as it chooses, from inside the worktree.
mc() { local wt=$1; shift; (cd "$wt" && env -u BOXD_HOST HOME="$PH" PATH="$SHIM:$PATH" node "$CLIENT" "$@" </dev/null); }
# ldnew <name>: a throwaway worktree in LD_NEW, its box remembered for scenario 36.
ldnew() { LD_NEW=$(mkwt "$1" a=1); LD_BOXES+=("$(boxof "$LD_NEW")"); }
placed() { cat "$(git -C "$1" rev-parse --absolute-git-dir)/boxd-host" 2>/dev/null; }
# logged <host 1|2> <box>: lines of that host's call log naming the box.
logged() { local n; if [ "$1" = 1 ]; then n=$(adm "grep -c '$2' $W/cache/calls.log 2>/dev/null || true" | tail -1); else n=$(adm2 "grep -c '$2' $W2/cache/calls.log 2>/dev/null || true" | tail -1); fi; echo "${n:-0}"; }
sshcalls() { grep -c "$1" "$SSHLOG" 2>/dev/null || true; }
vmfree2() {
  local d cmd=""
  for d in "$SCRATCH"/*/; do [ -d "$d" ] && cmd="$cmd $MSB2 rm -f pod-$(boxof "${d%/}");"; done
  [ -z "$cmd" ] || bp2 "$cmd" >/dev/null 2>&1
}
# ld_fill <host name> [keep]: worktrees pinned to the host with --host until it refuses one (exit 75); with keep, leave
# that many slots free (the last ones are stopped again).
ld_fill() {
  local h=$1 keep=${2:-0} i=0 wt out rc filled=()
  while [ "$i" -lt 12 ]; do
    i=$((i + 1)); LD_SEQ=$((${LD_SEQ:-0} + 1)); ldnew "agent-ld-fill-$h-$LD_SEQ-$$"; wt=$LD_NEW   # a fresh worktree in every fill, never one an earlier scenario placed
    out=$(mc "$wt" --host "$h" --vm -- true 2>&1 >/dev/null); rc=$?
    echo "note fill $h $i: exit $rc ${out:+($(printf '%s' "$out" | head -1 | cut -c1-120))}"   # why a fill ended is the first thing to know when a scenario fails
    [ "$rc" = 0 ] || { [ "$rc" = 75 ] || eq "fill $h $i ends on a refusal (exit 75), not on a failure" 75 "$rc"; break; }
    filled+=("$wt")
  done
  while [ "$keep" -gt 0 ] && [ ${#filled[@]} -gt 0 ]; do
    ssh "boxd-$h" "pod stop $(boxof "${filled[-1]}")" </dev/null >/dev/null 2>&1; unset 'filled[-1]'; keep=$((keep - 1))
  done
  LD_FILLED=("${filled[@]}")
}
# ld_sleep: make the first host sleep, as scenario 9 does, and wait until it stops answering ping.
ld_sleep() {
  local n=0
  quiet_wait
  adm 'setsid -f zzz >/dev/null 2>&1' </dev/null
  while ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 120 ] || break; done
  eq "the first host stopped answering ping (asleep)" no "$(ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1 && echo yes || echo no)"
}
ld_wake() { ldnew "agent-ld-wake-$$"; med "$LD_NEW" --no-sync -- true >/dev/null 2>&1; }

s28() {
  local over
  ld_need || return 0; ld_home
  vmfree; vmfree2
  ld_fill "$H"
  ldnew agent-ld-over; over=$LD_NEW; LD_OVER=$over
  mc "$over" --vm -- true >/dev/null 2>&1; eq "the next worktree's first vm call exits 0 while the first host is full" 0 $?
  eq "its placement names the second host" "$H2" "$(placed "$over")"
  eq "the first host's call log has no line for it (it was never refused there)" 0 "$(logged 1 "$(boxof "$over")")"
  eq "the second host ran it" 1 "$(logged 2 "$(boxof "$over")")"
}

s29() {
  ld_need || return 0; ld_home
  [ -n "${LD_OVER:-}" ] || { s27 >/dev/null; }
  ssh "boxd-$H" "pod stop $(boxof "${LD_FILLED[0]-}")" </dev/null >/dev/null 2>&1   # a slot is free on the first host again
  : > "$SSHLOG"
  mc "$LD_OVER" --vm --no-sync -- true >/dev/null 2>&1; eq "the next call of the placed worktree exits 0" 0 $?
  eq "it still goes to the second host" "$H2" "$(placed "$LD_OVER")"
  eq "no ssh reached the first host" 0 "$(sshcalls "boxd-$H ")"
  eq "and nothing reached its call log" 0 "$(logged 1 "$(boxof "$LD_OVER")")"
}

s30() {
  ld_need || return 0; ld_home
  [ -n "${LD_OVER:-}" ] || { s27 >/dev/null; s28 >/dev/null; }
  mc "$LD_OVER" --host "$H" --vm -- true >/dev/null 2>&1; eq "--host <first host> moves the worktree: exit 0" 0 $?
  eq "its files are on the first host" 1 "$(bp "cat $W/jobs/$(boxof "$LD_OVER")/src/a" 2>/dev/null | grep -c .)"
  eq "the placement says the first host" "$H" "$(placed "$LD_OVER")"
  : > "$SSHLOG"
  mc "$LD_OVER" --vm --no-sync -- true >/dev/null 2>&1
  eq "the next plain call goes to the first host" "0 $H" "$(sshcalls "boxd-$H2 ") $(placed "$LD_OVER")"
}

s31() {
  local new rc err
  ld_need || return 0; ld_home
  vmfree; vmfree2
  ld_fill "$H"; ld_fill "$H2"
  ldnew agent-ld-full; new=$LD_NEW
  err=$(mc "$new" --vm -- true 2>&1 >/dev/null); rc=$?
  eq "every host full: exit 75" 75 "$rc"
  has "one reason for the first host" "$H: " "$err"
  has "one reason for the second host" "$H2: " "$err"
  eq "nothing is placed" "" "$(placed "$new")"
  eq "no call log has a line for it" "0 0" "$(logged 1 "$(boxof "$new")") $(logged 2 "$(boxof "$new")")"
}

s32() {
  local wt
  ld_need || return 0; admin_login && return 0; ld_home
  vmfree; vmfree2
  ldnew agent-ld-asleep; wt=$LD_NEW
  ld_sleep
  : > "$SSHLOG"
  mc "$wt" --vm -- true >/dev/null 2>&1; eq "the first call wakes the first host and runs there" 0 $?
  eq "placed on the first host" "$H" "$(placed "$wt")"
  eq "the second host's call log has no line for it" 0 "$(logged 2 "$(boxof "$wt")")"
  eq "no status ssh was made to the sleeping host" 0 "$(sshcalls "boxd-$H .*pod status")"
}

s33() {
  local wt out
  ld_need || return 0; admin_login && return 0; ld_home
  ldnew agent-ld-hosts; wt=$LD_NEW
  ld_sleep
  : > "$SSHLOG"
  out=$(mc "$wt" hosts 2>/dev/null)
  has "box hosts says the first host is asleep" "$H"$'\t'sleeps$'\t'asleep "$out"
  eq "no ssh to the sleeping host" 0 "$(sshcalls "boxd-$H ")"
  eq "it is still asleep afterwards (no answer to ping)" no "$(ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1 && echo yes || echo no)"
  ld_wake
}

s34() {
  local a b ra rb pa pb
  ld_need || return 0; ld_home
  vmfree; vmfree2
  ld_fill "$H" 1; ld_fill "$H2" 1   # one slot left free on each host
  ldnew agent-ld-race-a; a=$LD_NEW; ldnew agent-ld-race-b; b=$LD_NEW
  mc "$a" --vm -- true >/dev/null 2>&1 & pa=$!
  mc "$b" --vm -- true >/dev/null 2>&1 & pb=$!
  wait "$pa"; ra=$?; wait "$pb"; rb=$?
  eq "both first calls exit 0" "0 0" "$ra $rb"
  eq "one placed on each host" "$(printf '%s\n%s' "$H" "$H2" | sort | paste -sd' ')" "$(printf '%s\n%s' "$(placed "$a")" "$(placed "$b")" | sort | paste -sd' ')"
  eq "each placement names the host its box is on" "1 1" "$(logged "$([ "$(placed "$a")" = "$H" ] && echo 1 || echo 2)" "$(boxof "$a")") $(logged "$([ "$(placed "$b")" = "$H" ] && echo 1 || echo 2)" "$(boxof "$b")")"
}

s35() {
  local down=${BOXD_SV_DIR:-/var/service}/boxd-sshd wt rc err
  ld_need || return 0; ld_home
  vmfree; vmfree2
  ld_fill "$H"
  adm2 "sv down $down" >/dev/null 2>&1   # the second host's build sshd stops
  ldnew agent-ld-down-full; wt=$LD_NEW
  err=$(mc "$wt" --vm -- true 2>&1 >/dev/null); rc=$?
  eq "first host full, second down: exit 75" 75 "$rc"
  has "the second host is named unreachable" "$H2: unreachable" "$err"
  ssh "boxd-$H" "pod stop $(boxof "${LD_FILLED[0]-}")" </dev/null >/dev/null 2>&1   # room on the first host again
  ldnew agent-ld-down-room; wt=$LD_NEW
  mc "$wt" --vm -- true >/dev/null 2>&1; eq "the first host has room: served there although the second is down" 0 $?
  eq "placed on the first host" "$H" "$(placed "$wt")"
  adm2 "sv up $down" >/dev/null 2>&1
}

s36() {
  local b wt p n
  ld_need || return 0; ld_home
  for b in "${LD_BOXES[@]}"; do
    wt=$(ls -d "$SCRATCH"/*/ | while read -r d; do [ "$(boxof "${d%/}")" = "$b" ] && echo "${d%/}"; done)
    p=$(placed "$wt"); [ -n "$p" ] || continue   # refused worktrees were never placed
    n=$(awk -F'\t' -v b="$b" -v p="$p" '$2 == b && $4 == p' "$PH/.local/state/boxd/choices.log" 2>/dev/null | wc -l)
    [ "$n" -ge 1 ] && n=ok || n=missing
    eq "the choice log has a line for $b on $p" ok "$n"
  done
}

push_check() {
  local eng=$1 wt=$2 out
  out=$(REGISTRY_AUTH_FILE=$SCRATCH/noauth.json med "$wt" image push $eng docker.io/library/busybox:stable 2>&1); eq "$eng the first push succeeds" 0 $?
  eq "$eng a box with the pushed image answers" busybox-ok "$(med "$wt" $eng --image docker.io/library/busybox:stable -- echo busybox-ok 2>/dev/null | tail -1)"
  out=$(REGISTRY_AUTH_FILE=$SCRATCH/noauth.json med "$wt" image push $eng docker.io/library/busybox:stable 2>&1); eq "$eng the second push succeeds" 0 $?
  has "$eng the second push says the host already has it" "already on" "$out"
  eq "$eng no pushed archive is left in the work area" 0 "$(adm "ls $W/cache/images 2>/dev/null | grep -c '^push\\.'")"
}
s37() {
  local wt
  if ! command -v podman >/dev/null && ! command -v docker >/dev/null; then echo "skip this machine has neither podman nor docker"; return; fi
  bp "podman rmi -f docker.io/library/busybox:stable" >/dev/null 2>&1   # so the first container push has to send it
  # The image is public: pull it without this machine's own registry login, whose state is not what this scenario tests
  # (a stored Docker Hub login that the registry rejects now and then failed the pull, seen 2026-11-13).
  echo '{}' > "$SCRATCH/noauth.json"
  wt=$(mkwt agent-push a=1)
  push_check --container "$wt"
  vmfree
  wt=$(mkwt agent-push-vm a=1)
  push_check --vm "$wt"
}

# Dashboard server verbs (docs/designs/dashboard.md, the design's scenarios 1, 2, 5 and 11 = 38 to 41 here).
# vkey_on: a throwaway key that may only read. The key is listed on the host with `boxd-setup --view-key`, which also sets
# ExposeAuthInfo in /etc/boxd/sshd_config; when that line was missing the build sshd is reloaded once (boxctl reload: sessions and boxes
# stay) so that it takes effect. Sets VIEW_BLOB (the key's text, for removal), returns 1 with a reason when it cannot.
VIEW_BLOB=""; POWER_CONF_SAVED=""
vkey_on() {
  local had
  command -v ssh-keygen >/dev/null || { echo "skip this machine has no ssh-keygen"; return 1; }
  VPORT=$(adm '. /etc/boxd/boxd.conf 2>/dev/null; echo ${BOXD_PORT:-2222}' | tail -1)
  ssh-keygen -q -t ed25519 -N '' -f "$SCRATCH/view" -C "acceptance-view-key" || return 1
  VIEW_BLOB=$(awk '{ print $2 }' "$SCRATCH/view.pub")
  had=$(adm 'grep -c "^ExposeAuthInfo[[:space:]]*yes" /etc/boxd/sshd_config' | tail -1)
  adm "f=\$(mktemp) && printf '%s\\n' '$(cat "$SCRATCH/view.pub")' > \$f && boxd-setup --view-key \$f; rc=\$?; rm -f \$f; exit \$rc" >/dev/null 2>&1 \
    || { echo "skip boxd-setup --view-key failed on the host (is this boxd 0.3.0 and boxd-setup run once with --key?)"; return 1; }
  [ "$had" != 0 ] || adm 'boxctl reload' >/dev/null 2>&1
}
# vkey_off: take the throwaway key out of the host's list and allowed keys (also run by cleanup).
vkey_off() {
  [ -n "$VIEW_BLOB" ] || return 0
  adm "sed -i '\\|$VIEW_BLOB|d' /etc/boxd/view_keys /etc/ssh/authorized_keys/$BUILD_USER" >/dev/null 2>&1
  VIEW_BLOB=""
}
# vssh '<command>': that command of the box protocol with the throwaway key, by address (no alias, so no wake hook).
vssh() {
  ssh -F /dev/null -i "$SCRATCH/view" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -p "$VPORT" "$BUILD_USER@$BOXD_TEST_IP" "$1" </dev/null
}

s38() {
  local out rc c g=agent-view-none wt
  vkey_on || { vkey_off; return 0; }
  out=$(vssh "pod report" 2>&1); rc=$?
  eq "the view key: pod report exits 0" 0 "$rc"
  has "the view key: pod report starts with the host line" "host	version=" "$out"
  for c in "pod run $g -- Y2FyZ28=" "pod stop $g" "pod clear" \
    "pod image load container docker.io/library/busybox:stable 0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef" \
    "rsync --server -logDtpre.iLsfxCIvu --delete . jobs/$g/src/"; do
    out=$(vssh "$c" 2>&1); rc=$?
    eq "the view key: '${c:0:28}' exits 125 with the reason" "125 boxd-pod: this key may only read" "$rc $out"
  done
  eq "the refused commands made no job folder" no "$(adm "test -e $W/jobs/$g && echo yes || echo no" | tail -1)"
  eq "and left no call log line" 0 "$(adm "grep -c $g $W/cache/calls.log 2>/dev/null || true" | tail -1)"
  wt=$(mkwt agent-view-agent a=1)
  med "$wt" -- true >/dev/null 2>&1; eq "an agent's own key still runs a box" 0 $?
  vkey_off
}

# rline <report text> <key of the first column> <box>: the line of that box.
rline() { printf '%s\n' "$1" | grep -P "^$2\tbox=$3\t"; }
# fieldof <line> <key>: the value of key=value in a tab separated line.
fieldof() { printf '%s\n' "$1" | tr '\t' '\n' | sed -n "s/^$2=//p" | head -1; }
s39() {
  rep=$(podcmd report); st=$(podcmd status); ls=$(podcmd list)
  hl=$(printf '%s\n' "$rep" | grep -m1 '^host')
  for k in version engines cpus vm_used vm_max vm_room; do
    eq "report and status agree on $k" "$(fieldof "$st" $k)" "$(fieldof "$hl" $k)"
  done
  eq "cpus is what nproc says" "$(bp nproc | tail -1)" "$(fieldof "$hl" cpus)"
  eq "mem_total_mb is MemTotal" "$(adm "awk '/^MemTotal:/ { print int(\$2 / 1024) }' /proc/meminfo" | tail -1)" "$(fieldof "$hl" mem_total_mb)"
  eq "swap_total_mb is SwapTotal" "$(adm "awk '/^SwapTotal:/ { print int(\$2 / 1024) }' /proc/meminfo" | tail -1)" "$(fieldof "$hl" swap_total_mb)"
  eq "boot is btime" "$(adm "awk '/^btime/ { print \$2 }' /proc/stat" | tail -1)" "$(fieldof "$hl" boot)"
  eq "disk_total_mb is the size of the work area" "$(adm "df --output=size $W | tail -1 | awk '{ print int(\$1 / 1024) }'")" "$(fieldof "$hl" disk_total_mb)"
  eq "oom_kills is the cgroup's counter" "$(adm "awk '/^oom_kill / { print \$2 }' $CG/memory.events" | tail -1)" "$(fieldof "$hl" oom_kills)"
  want=$(adm "awk '{ print (\$1 == \"max\") ? \"-\" : int(\$1 / 1048576) }' $CG/memory.max" | tail -1)
  eq "group_mem_max_mb is the cgroup's memory.max" "$want" "$(fieldof "$hl" group_mem_max_mb)"
  eq "ttl and power are the settings" "$(adm '. /etc/boxd/boxd.conf 2>/dev/null; echo ${BOXD_TTL:-1800} ${BOXD_POWER:-off}' | tail -1)" "$(fieldof "$hl" ttl) $(fieldof "$hl" power)"
  eq "report lists the boxes of pod list, with their engine and state" "$(printf '%s\n' "$ls" | awk -F'\t' 'NF { print $1, $5, $3 }' | sort | paste -sd'|')" \
    "$(printf '%s\n' "$rep" | grep '^box' | awk -F'\t' '{ sub(/^box=/, "", $2); sub(/^engine=/, "", $3); sub(/^state=/, "", $5); print $2, $3, $5 }' | sort | paste -sd'|')"
  # A box with a detached run that waits: busy, one run, a memory figure; the reads leave its stamp alone.
  wt=$(mkwt agent-report a=1); box=$(boxof "$wt")
  med "$wt" -- mkfifo /job/gate >/dev/null 2>&1
  run=$(med "$wt" --detach -- sh -c 'read x < /job/gate' | grep -oE '[0-9]{8}-[0-9]{6}-[0-9a-f]{4}' | head -1)
  stamp=$(adm "stat -c %Y $W/jobs/$box/.last-used" | tail -1)
  rep=$(podcmd report); line=$(rline "$rep" box "$box")
  eq "a box with a waiting detached run is busy, with one run" "yes 1" "$(fieldof "$line" busy) $(fieldof "$line" runs)"
  has "its run line says running, no exit code yet" "id=$run	state=running	exit=-" "$(printf '%s\n' "$rep" | grep "^run	box=$box")"
  eq "a running container's memory is a number of megabytes (a dash means rootless cgroups are not readable: see the design)" yes \
    "$([[ $(fieldof "$line" mem_mb) =~ ^[0-9]+$ ]] && echo yes || echo no)"
  eq "reading the report did not stamp the box" "$stamp" "$(adm "stat -c %Y $W/jobs/$box/.last-used" | tail -1)"
  adm "echo go > $W/jobs/$box/gate"
  until printf '%s\n' "$rep" | grep -q "id=$run	state=ended	exit=0"; do rep=$(podcmd report); n=$((n + 1)); [ "$n" -lt 300 ] || break; done
  eq "after the run ended: its line says ended, exit 0" yes "$(printf '%s\n' "$rep" | grep -q "id=$run	state=ended	exit=0" && echo yes || echo no)"
  eq "and the box is not busy" no "$(fieldof "$(rline "$rep" box "$box")" busy)"
  if [[ $(fieldof "$hl" engines) == *vm* ]]; then
    vmfree; wt=$(mkwt agent-report-vm a=1); box=$(boxof "$wt")
    med "$wt" --vm -- true >/dev/null 2>&1
    line=$(rline "$(podcmd report)" box "$box")
    eq "a running machine's memory is a number of megabytes" yes "$([[ $(fieldof "$line" mem_mb) =~ ^[0-9]+$ ]] && echo yes || echo no)"
    eq "its size is large (no record, no --size)" large "$(fieldof "$line" size)"
  fi
}

# conf_back: put back the settings file that scenario 40 changed (also run by cleanup).
# A login of the administrator on the host keeps it awake (its connection to port 22 is work for the power module): the
# scenarios that need the host to sleep say so and are skipped; they are the owner's terminal, not ours to close.
admin_login() { local w; w=$(ssh $ADMIN_SSH who </dev/null 2>/dev/null); [ -z "$w" ] && return 1; echo "skip someone is logged in on the host ($(printf '%s' "$w" | head -1 | tr -s ' ')): it stays awake for that login"; }
conf_back() {
  [ -n "$POWER_CONF_SAVED" ] || return 0
  adm 'mv /etc/boxd/boxd.conf.acceptance /etc/boxd/boxd.conf && boxctl reload' >/dev/null 2>&1
  POWER_CONF_SAVED=""
}
s40() {
  local addr port wt n=0 log
  admin_login && return 0
  if [ "$(adm '. /etc/boxd/boxd.conf 2>/dev/null; echo ${BOXD_POWER:-off}' | tail -1)" != on ]; then echo "skip the power module is off on this host"; return 0; fi
  addr=$(ssh $ADMIN_SSH 'echo ${SSH_CLIENT%% *}' </dev/null | tail -1)   # this machine, as the host sees it (asked without sudo, which drops the variable)
  port=$(adm '. /etc/boxd/boxd.conf 2>/dev/null; echo ${BOXD_PORT:-2222}' | tail -1)
  [ -n "$addr" ] || { echo "skip the host did not say this machine's address"; return 0; }
  [ -n "$POWER_CONF_SAVED" ] || { adm 'cp -p /etc/boxd/boxd.conf /etc/boxd/boxd.conf.acceptance'; POWER_CONF_SAVED=1; }
  adm "printf 'BOXD_IDLE_IGNORE=\"%s\"\\nBOXD_IDLE_CHECKS=2\\n' '$addr' >> /etc/boxd/boxd.conf && boxctl reload" >/dev/null
  wt=$(mkwt agent-ignore a=1)
  quiet_wait   # waits on the condition itself: load left by earlier scenarios decays
  # One connection to the build port stays open from here, as the dashboard's poll would; no other ssh meanwhile.
  exec 9<>"/dev/tcp/$BOXD_TEST_IP/$port"
  n=0; while ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 900 ] || break; done
  eq "with a connection from the ignored address held open the host still goes to sleep" no "$(ping -c1 -W1 "$BOXD_TEST_IP" >/dev/null 2>&1 && echo yes || echo no)"
  exec 9>&-
  med "$wt" -- true >/dev/null 2>&1; eq "a normal client call wakes it" 0 $?
  log=$(adm 'boxctl log power')
  eq "the power log shows idle, then sleeping, with no busy: ssh between" clean \
    "$(printf '%s\n' "$log" | awk '/idle, sleeping after/ { s = 1; bad = 0; next } s && /busy: ssh/ { bad = 1 } s && / sleeping$/ { r = bad ? "busy" : "clean"; s = 0 } END { print r }')"
  conf_back
}

# hdr <answer> <key>: a value of the answer's first line (calls, log).
hdr() { printf '%s\n' "$1" | head -1 | tr '\t' '\n' | sed -n "s/^$2=//p"; }
# s41: 30000 call log lines naming box agent-huge-log (1.6 MB) are appended, read by a first contact and by a sweep from 0, and taken out.
s41() {
  local body size from next off=0 seen=0 n=0 tab=$'\t'
  adm "awk 'BEGIN { for (i = 1; i <= 30000; i++) printf \"%.0f\\tagent-huge-log\\tcontainer\\t0\\t0\\t1\\t\\t\\ttrue\\n\", 1794571186000000 + i }' >> $W/cache/calls.log && chown $BUILD_USER $W/cache/calls.log"
  body=$(podcmd calls); from=$(hdr "$body" from); next=$(hdr "$body" next)
  eq "a first contact answers at most 1048576 bytes of lines" yes "$([ $((next - from)) -le 1048576 ] && [ "$next" -gt "$from" ] && echo yes || echo no)"
  eq "and starts at a whole line" yes "$([[ $(printf '%s\n' "$body" | sed -n 2p) =~ ^[0-9]+$tab ]] && echo yes || echo no)"
  while :; do   # from the start, following next until it reaches size
    body=$(podcmd "calls $off"); size=$(hdr "$body" size); next=$(hdr "$body" next)
    seen=$((seen + $(printf '%s\n' "$body" | grep -c agent-huge-log))); n=$((n + 1))
    eq "answer $n carries at most 1048576 bytes" yes "$([ $((next - off)) -le 1048576 ] && echo yes || echo no)"
    [ "$next" -lt "$size" ] && [ "$n" -lt 20 ] || break
    off=$next
  done
  eq "following next from 0 reaches size, in more than one answer" yes "$([ "$next" -ge "$size" ] && [ "$n" -gt 1 ] && echo yes || echo no)"
  eq "every appended line came through exactly once" 30000 "$seen"
  adm "grep -v agent-huge-log $W/cache/calls.log > $W/cache/calls.log.acceptance; cat $W/cache/calls.log.acceptance > $W/cache/calls.log; rm -f $W/cache/calls.log.acceptance"
  eq "the appended lines are taken out again" 0 "$(adm "grep -c agent-huge-log $W/cache/calls.log || true" | tail -1)"
}


s42() {
  local wt
  wt=$(mkwt agent-kvm a=1)
  eq "a --kvm container box opens /dev/kvm (closed: rerun boxd-setup on this host for the access rule)" open "$(med "$wt" --kvm sh -c '(exec 3<>/dev/kvm) && echo open || echo closed' 2>/dev/null | tail -1)"
  wt=$(mkwt agent-kvm-user a=1)
  eq "a --kvm --user box opens it too" open "$(med "$wt" --kvm --user sh -c '(exec 3<>/dev/kvm) && echo open || echo closed' 2>/dev/null | tail -1)"
  wt=$(mkwt agent-kvm-none a=1)
  eq "a box without --kvm has no /dev/kvm" absent "$(med "$wt" sh -c '[ -e /dev/kvm ] && echo present || echo absent' 2>/dev/null | tail -1)"
}

# gone_case <label> <workflow name> [client flags]: a foreground sleep in a box, then its client and ssh are killed. The checks wait
# on state in bounded loops (the session rule needs the host to notice the closed connection and run the cleanup).
gone_case() {
  local label=$1 wt cp sp i box busy
  wt=$(mkwt "$2" a=1); shift 2
  box=$(boxof "$wt")
  med "$wt" "$@" true >/dev/null 2>&1   # the box exists before the long call (a machine needs its first boot)
  (cd "$wt" && exec node "$CLIENT" "$@" -- sh -c 'sleep 100000' </dev/null >/dev/null 2>&1) & cp=$!
  for i in $(seq 1 120); do med "$wt" ps 2>/dev/null | grep -q 'sleep 100000' && break; sleep 1; done
  eq "$label: the sleep runs in the box before the kill" yes "$(med "$wt" ps 2>/dev/null | grep -q 'sleep 100000' && echo yes || echo no)"
  sp=$(pgrep -P "$cp" -x ssh | head -1)
  kill -9 "$sp" "$cp" 2>/dev/null; wait "$cp" 2>/dev/null
  for i in $(seq 1 120); do med "$wt" ps 2>/dev/null | grep -q 'sleep 100000' || break; sleep 1; done
  eq "$label: the sleep is gone from the box after the client and its ssh were killed" no "$(med "$wt" ps 2>/dev/null | grep -q 'sleep 100000' && echo yes || echo no)"
  for i in $(seq 1 60); do busy=$(podcmd report | awk -F'\t' -v b="box=$box" '$1 == "box" && $2 == b { for (i = 3; i <= NF; i++) if ($i ~ /^busy=/) print $i }'); [ "$busy" = busy=no ] && break; sleep 1; done
  eq "$label: pod report no longer shows the box busy" busy=no "$busy"
}
s43() {
  gone_case "container" agent-gone-c
  gone_case "virtual machine" agent-gone-v --vm
}

# fwd_get <port>: the body of GET / on 127.0.0.1:<port>, bash only (no curl needed).
fwd_get() { (exec 3<>/dev/tcp/127.0.0.1/"$1" && printf 'GET / HTTP/1.0\r\n\r\n' >&3 && cat <&3 | tail -1) 2>/dev/null; }
# Port 8081 inside the box is the marker: no other process on the host relays to it, so the checks can count relays by it.
s44() {
  local wt box fp port i out
  wt=$(mkwt agent-fwd a=1); box=$(boxof "$wt")
  med "$wt" --image docker.io/library/busybox:stable true >/dev/null 2>&1   # the box exists (not busy: no lock outlives the call)
  bp "podman exec -d pod-$box sh -c 'mkdir -p /tmp/www && echo forward-ok > /tmp/www/index.html && exec httpd -f -p 127.0.0.1:8081 -h /tmp/www'" >/dev/null 2>&1
  until [ "$(bp "podman exec pod-$box wget -qO- http://127.0.0.1:8081/ 2>/dev/null")" = forward-ok ]; do :; done
  # the client listens, the page comes through the relay
  (cd "$wt" && exec node "$CLIENT" forward --pod "$box" 0 8081 </dev/null >"$SCRATCH/fwd.out" 2>"$SCRATCH/fwd.err") & fp=$!
  until grep -q '^forwarding ' "$SCRATCH/fwd.out" 2>/dev/null; do kill -0 "$fp" 2>/dev/null || break; done
  port=$(sed -n 's/^forwarding 127\.0\.0\.1:\([0-9]*\) .*/\1/p' "$SCRATCH/fwd.out")
  eq "box forward prints the local port it chose" yes "$([[ $port =~ ^[0-9]+$ ]] && echo yes || echo no)"
  eq "a request to 127.0.0.1:<port> reaches the web server inside the box" forward-ok "$(fwd_get "$port")"
  eq "the listener is bound to 127.0.0.1 only" 1 "$(ss -ltnH "sport = :$port" | grep -c "127.0.0.1:$port")"
  # an open channel holds the box busy: the relay runs under the shared lock like a foreground call
  exec 4<>/dev/tcp/127.0.0.1/"$port"
  for i in $(seq 1 60); do out=$(podcmd report | awk -F'\t' -v b="box=$box" '$1 == "box" && $2 == b { for (i = 3; i <= NF; i++) if ($i ~ /^busy=/) print $i }'); [ "$out" = busy=yes ] && break; sleep 1; done
  eq "pod report shows the box busy while a channel is open" busy=yes "$out"
  # exactly the relay itself: the processes that wrap it (keep-awake, flock, podman unshare) carry the same words in a longer command line
  eq "one relay (socat in the box's network namespace) runs on the host" 1 "$(bp "pgrep -xfc 'socat - TCP:127.0.0.1:[8]081' || true" | tail -1)"
  has "the call log has a line with the command forward 8081" "forward 8081" "$(podcmd "calls 50" 2>/dev/null)"
  # the client is killed hard: the relay ends by itself and the box is no longer busy (waits on the conditions)
  kill -9 "$fp"; wait "$fp" 2>/dev/null; exec 4>&-
  until [ "$(bp "pgrep -fc 'nsenter --net=/proc/[0-9]+/ns/net socat - TCP:127.0.0.1:[8]081' || true" | tail -1)" = 0 ]; do :; done
  eq "no relay is left on the host after the client was killed" 0 "$(bp "pgrep -fc 'nsenter --net=/proc/[0-9]+/ns/net socat - TCP:127.0.0.1:[8]081' || true" | tail -1)"
  until [ "$(podcmd report | awk -F'\t' -v b="box=$box" '$1 == "box" && $2 == b { for (i = 3; i <= NF; i++) if ($i ~ /^busy=/) print $i }')" = busy=no ]; do :; done
  eq "the box is no longer busy" busy=no "$(podcmd report | awk -F'\t' -v b="box=$box" '$1 == "box" && $2 == b { for (i = 3; i <= NF; i++) if ($i ~ /^busy=/) print $i }')"
  # refusals, and the build sshd still forbids its own forwarding
  podcmd "forward $box 0" >/dev/null 2>&1; eq "port 0 is refused by the server" 125 $?
  podcmd "forward $box 65536" >/dev/null 2>&1; eq "port 65536 is refused by the server" 125 $?
  podcmd "forward no-such-box-here 8081" >/dev/null 2>&1; eq "a box that does not exist is refused" 125 $?
  eq "that call made no box" 0 "$(count no-such-box-here)"
  ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -N -L 0:127.0.0.1:8081 "$BUILD_SSH" </dev/null >/dev/null 2>&1; eq "ssh -L is still refused by the build sshd (AllowTcpForwarding no)" 255 $?
  podcmd "stop $box" >/dev/null 2>&1
  podcmd "forward $box 8081" >/dev/null 2>&1; eq "a stopped box is refused" 125 $?
  eq "and was not started" 0 "$(bp "podman ps -q --filter name=pod-$box" 2>/dev/null | grep -c .)"
  wt=$(mkwt agent-fwd-vm a=1); box=$(boxof "$wt")
  med "$wt" --vm true >/dev/null 2>&1
  out=$(podcmd "forward $box 8081" 2>&1 </dev/null); has "a vm box is refused with the reason" "forward is for container boxes" "$out"
}

# Only this scenario's own folder is aged (its stamp set back 15 days); the reaper's clock is the real one, so no other
# folder on the host is touched. The wait is for the reaper's next pass (every minute), on the folder being gone.
s45() {
  local wt box out
  wt=$(mkwt agent-retain a=1 .gitignore=keep/); box=$(boxof "$wt")
  med "$wt" -- sh -c 'mkdir -p keep && echo disk > keep/disk && chown -R 1234:1234 keep' >/dev/null 2>&1; eq "a box with ignored files owned by another user" 0 $?
  bp "touch -d '15 days ago' $W/jobs/$box/.last-used"
  until ! bp "test -d $W/jobs/$box"; do sleep 5; done
  eq "unused past the limit: the reaper removed the folder and the box" 0 "$(count "$box")"
  has "evictions.log names the box and the reason" "$box	unused 14 days" "$(bp "tail -n 20 $W/cache/evictions.log")"
  out=$(med "$wt" -- sh -c 'ls keep 2>/dev/null | wc -l' 2>&1)
  has "the next call says the folder was removed" "boxd-pod: the folder of this box was removed on $(date +%F) (unused 14 days); it starts empty" "$out"
  eq "and starts without the ignored files" 0 "$(printf '%s\n' "$out" | tail -1)"
  out=$(med "$wt" -- true 2>&1); eq "the call after that says nothing" "" "$out"
  med "$wt" -- sh -c 'mkdir -p keep && echo disk > keep/disk && chown -R 1234:1234 keep' >/dev/null 2>&1
  has "pod drop answers with what it removed and how much it freed" "evicted $box (worktree gone), " "$(podcmd "drop $box")"
  eq "pod drop: box and folder are gone" "0 no" "$(count "$box") $(bp "test -d $W/jobs/$box && echo yes || echo no")"
  eq "pod drop again: nothing there, exit 0" 0 "$(podcmd "drop $box" >/dev/null 2>&1; echo $?)"
}

# s46: a container box is made with a raised out-of-memory score, and its memory counts in the commitment of machines. The
# condition is ours: a held gigabyte in this scenario's own box, and BOXD_VM_COMMIT (settings changed for the scenario, put back
# by conf_back) set to the smallest percent that fits the running machines plus the asked size and nothing more. No box of others
# is touched, and every wait is on a condition.
s46() {
  local wt box pids hold hp v hl cap com ask pct over err rc
  wt=$(mkwt agent-oomscore a=1); box=$(boxof "$wt")
  hold='s=$(head -c 1100000000 /dev/zero | tr "\0" a); sleep 100000'
  ( med "$wt" --no-sync -- bash -c "$hold" >/dev/null 2>&1 ) & hp=$!
  until v=$(podcmd report | awk -F'\t' -v b="box=$box" '$1 == "box" && $2 == b { for (i = 3; i <= NF; i++) if ($i ~ /^mem_mb=/) print substr($i, 8) }'); [ "${v:--}" != - ] && [ "${v:-0}" -ge 1000 ]; do kill -0 "$hp" 2>/dev/null || break; done
  eq "the box holds more than a gigabyte of its own memory" yes "$([ "${v:-0}" -ge 1000 ] 2>/dev/null && echo yes || echo no)"
  pids=$(bp "podman top pod-$box hpid | tail -n +2")
  eq "the box has processes on the host" yes "$([ -n "$pids" ] && echo yes || echo no)"
  eq "every process of the box has the out-of-memory score 1000" 1000 "$(bp "for p in $(printf '%s ' $pids); do cat /proc/\$p/oom_score_adj; done | sort -u")"
  # The asked machine (small, 2048 MB) fits the measured memory and the running machines' sizes, but not those plus the box's memory.
  hl=$(podcmd report | head -1); cap=$(fieldof "$hl" group_mem_max_mb)
  com=$(podcmd report | awk -F'\t' '$1 == "box" { e = s = ""; for (i = 2; i <= NF; i++) { if ($i == "engine=vm") e = 1; if ($i == "state=running") s = 1; if ($i ~ /^mem_limit_mb=/) l = substr($i, 14) } if (e && s) t += l } END { print t + 0 }')
  ask=2048; pct=$(( (100 * (com + ask) + cap - 1) / cap ))
  eq "the cap is small enough that one percent of it is under the box's memory" yes "$([ "$cap" -lt 100000 ] && echo yes || echo no)"
  [ -n "$POWER_CONF_SAVED" ] || { adm 'cp -p /etc/boxd/boxd.conf /etc/boxd/boxd.conf.acceptance'; POWER_CONF_SAVED=1; }
  adm "printf 'BOXD_VM_COMMIT=%s\\n' $pct >> /etc/boxd/boxd.conf && boxctl reload" >/dev/null
  over=$(mkwt agent-oomscore-vm a=1)
  err=$(med "$over" --vm --size small -- true 2>&1 >/dev/null); rc=$?
  case $err in
    *"MB in use +"*) echo "skip the host's measured memory leaves no room for the asked machine now (message: $err)" ;;
    *) eq "the machine is refused with exit 75" 75 "$rc"
       has "the refusal names the machines, the container boxes and the asked size" "MB of running machines + " "$err"
       has "and the container boxes' memory" "MB used by container boxes + $ask MB asked > " "$err"
       eq "the refused box has no machine" 0 "$(vmprocs "$(boxof "$over")")" ;;
  esac
  conf_back
  podcmd "stop $box" >/dev/null 2>&1; wait "$hp" 2>/dev/null
}

# Scenario 22 resets /work, so it always runs last.
pick=("$@"); [ ${#pick[@]} -gt 0 ] || pick=(1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 22)
for n in "${pick[@]}"; do
  printf '== %s. %s\n' "$n" "${SCENARIOS[$((n - 1))]}"
  "s$n"
done

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
