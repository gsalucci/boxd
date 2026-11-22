#!/usr/bin/env bash
# Regenerates the recorded answers of tests/fixtures/dashboard/ that come from the 0.3.0 server: tower.report (`pod report`)
# and tower.calls (the body of `pod calls`) are what the REAL server/boxd-pod prints, run against a scratch work area with
# fake podman, msb, pgrep, nproc and df first on PATH (the technique of tests/contract-pod-test.sh). Nothing is typed into a
# fixture. What the script seeds is the host's state (boxes, run folders, cgroup files, the call log), never an answer.
# Two things of the real machine would change at every run and are pinned afterwards, by key name, on the host line only:
# load1, load5, load15 (read from /proc/loadavg) and boot (from /proc/stat). Usage: bash tests/dashboard-capture.sh [folder]
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$HERE/tests/fixtures/dashboard}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state" "$T/vmstate" "$T/work/cache" "$T/images" "$T/proc" "$T/cg/boxd"

# The fakes: a container engine and a machine engine that list what the state folders hold.
cat > "$T/bin/podman" <<'FAKE'
#!/bin/sh
case $1 in
  ps) for f in "$FAKE_STATE"/*; do read -r img st _ < "$f"; printf 'pod-%s\t%s\t%s\n' "${f##*/}" "$img" "$st"; done ;;
  container) for a; do n=$a; done; read -r img st u < "$FAKE_STATE/${n#pod-}"; echo "$(cat "$FAKE_STATE/../cpid-${n#pod-}" 2>/dev/null || echo 0) map[boxd.box:x${u:+ boxd.user:1}]" ;;
esac
FAKE
cat > "$T/bin/msb" <<'FAKE'
#!/bin/sh
[ "$1" = ls ] || exit 0
echo "NAME IMAGE STATUS"; for f in "$FAKE_VM_STATE"/*; do read -r img st < "$f"; echo "pod-${f##*/} $img $st"; done
FAKE
cat > "$T/bin/pgrep" <<'FAKE'
#!/bin/sh
name=$(echo "$2" | sed 's/.*--name \([^( ]*\).*/\1/'); cat "$FAKE_VM_STATE/../pid-$name" 2>/dev/null
FAKE
cat > "$T/bin/nproc" <<'FAKE'
#!/bin/sh
echo 16
FAKE
cat > "$T/bin/df" <<'FAKE'
#!/bin/sh
case "$*" in *output=source*) printf 'Filesystem\n'; case "$*" in *" /") echo /dev/fake1 ;; *) echo /dev/fake2 ;; esac ;; *size,used*) printf '1K-blocks Used\n1000204288 710145024\n' ;; *) printf 'Use%%\n 71%%\n' ;; esac
FAKE
# stat: the work area is a file system of its own on another disk than the system (work_own=yes, work_shared=no); the rest is the real stat
cat > "$T/bin/stat" <<'FAKE'
#!/bin/sh
case "$*" in
  "-c %d "*) case "$3" in */..) echo 1 ;; *) echo 2 ;; esac ;;
  *) exec /usr/bin/stat "$@" ;;
esac
FAKE
chmod +x "$T/bin/"*

W=$T/work; J=$W/jobs
mb() { echo $(($1 * 1048576)); }
# Boxes: a machine in use right now, a machine with a detached run, a container with a detached run, a stopped container.
echo "ghcr.io/void-linux/void-glibc:latest running" > "$T/vmstate/boxd-2889387319"
echo "docker.io/library/rust:1.83 running" > "$T/vmstate/harbor-admin-3340981172"
echo "docker.io/library/debian:stable-slim running user" > "$T/state/webshop-608299631"
echo "localhost/toolbox:latest stopped" > "$T/state/toolsite-1923847561"
for b in boxd-2889387319 harbor-admin-3340981172 webshop-608299631 toolsite-1923847561; do mkdir -p "$J/$b/runs"; done
echo medium > "$J/harbor-admin-3340981172/.vm-size"
echo 2900 > "$J/harbor-admin-3340981172/.mem-peak"   # the need the machine measured (mem_peak_mb)
touch -d @1794571186 "$J/boxd-2889387319/.last-used"; touch -d @1794570986 "$J/harbor-admin-3340981172/.last-used"
touch -d @1794571061 "$J/webshop-608299631/.last-used"; touch -d @1794570180 "$J/toolsite-1923847561/.last-used"
# Memory of the boxes: a machine's resident memory (its process), a container's cgroup (its init process).
echo 6001 > "$T/pid-pod-boxd-2889387319"; echo 6002 > "$T/pid-pod-harbor-admin-3340981172"; echo 4242 > "$T/cpid-webshop-608299631"
for p in 6001:6287360 6002:3250176; do mkdir -p "$T/proc/${p%%:*}"; printf 'Name:\tmsb\nVmRSS:\t %s kB\n' "${p##*:}" > "$T/proc/${p%%:*}/status"; done
mkdir -p "$T/proc/4242" "$T/cg/user.slice/ctr"; echo "0::/user.slice/ctr" > "$T/proc/4242/cgroup"; mb 1946 > "$T/cg/user.slice/ctr/memory.current"
# Detached runs: a log, a pid record while it runs, and a last line EXIT <code> when it ended.
run() { local d=$J/$1/runs f=$2 bytes=$3 at=$4; head -c "$bytes" /dev/zero | tr '\0' x > "$d/$f.log"; touch -d "@$at" "$d/$f.log"; }
run harbor-admin-3340981172 20261113-110800-9f3c 48211 1794571190; echo 1 > "$J/harbor-admin-3340981172/runs/20261113-110800-9f3c.pid"
run webshop-608299631 20261113-095000-ab12 5321 1794569000; echo 1 > "$J/webshop-608299631/runs/20261113-095000-ab12.pid"
{ head -c 904 /dev/zero | tr '\0' x; printf '\nEXIT 0\n'; } > "$J/toolsite-1923847561/runs/20261113-114300-77aa.log"; touch -d @1794570194 "$J/toolsite-1923847561/runs/20261113-114300-77aa.log"
# The build group's cgroup, the memory file of the host, the power module's state, the image archive.
CG=$T/cg/boxd
mb 27188 > "$CG/memory.max"; mb 20204 > "$CG/memory.current"
printf 'anon %s\nshmem 0\ninactive_file %s\n' "$(mb 19204)" "$(mb 1000)" > "$CG/memory.stat"
printf 'some avg10=2.31 avg60=1.12 avg300=0.5 total=1\nfull avg10=0.40 avg60=0.18 avg300=0.1 total=1\n' > "$CG/memory.pressure"
printf 'low 0\noom 1\noom_kill 1\n' > "$CG/memory.events"
printf 'MemTotal: %s kB\nMemAvailable: %s kB\nSwapTotal: %s kB\nSwapFree: %s kB\n' $((31986 * 1024)) $((9120 * 1024)) $((8191 * 1024)) $((6963 * 1024)) > "$T/meminfo"
mkdir -p "$T/idle"; echo 0 > "$T/idle/count"; echo load > "$T/idle/last"
truncate -s 3672147968 "$T/images/toolbox.tar"; touch -d @1794535440 "$T/images/toolbox.tar"
# The call log: the host's own file, with lines of both formats (seven columns of server 0.2.0, nine of 0.3.0), one that is not
# a call log line and one older than a day. The answer to the reader is what the server then prints.
printf '%s\n' \
"1794480000000000	boxd-2889387319	vm	0	0	880			cargo fmt --check" \
"1794560000000000	boxd-2889387319	vm	0	101	73100	" \
"1794563400000000	webshop-608299631	container	0	detached	25		20261113-095000-ab12	pnpm dev --host" \
"1794565800000000	acme-wave19-4007723605	vm	0	75	11	no room for another virtual machine (24100 MB in use + 8192 MB asked > 27188 MB cap); wait for one to end or stop one		pnpm playwright install" \
"1794566400000000	acme-wave19-4007723605	vm	0	75	9	no room for another virtual machine (24100 MB in use + 8192 MB asked > 27188 MB cap); wait for one to end or stop one		pnpm playwright install" \
"1794568080000000	harbor-admin-3340981172	vm	0	detached	2210		20261113-110800-9f3c	cargo test --release -p oracle" \
"not a call log line" \
"1794569500000000	image	container	0	0	2100			" \
"1794570000000000	agent-accept-1	container	0	125	3	image not allowed		" \
"1794570180000000	toolsite-1923847561	container	0	detached	12		20261113-114300-77aa	pnpm test" \
"1794570680000000	boxd-2889387319	vm	30000	0	30004			cargo clippy --workspace" \
"1794571061000000	webshop-608299631	container	0	1	9450			pnpm test auth" \
"1794571186000000	boxd-2889387319	vm	0	0	4210			cargo check -p api" > "$W/cache/calls.log"

export PATH="$T/bin:$PATH" FAKE_STATE=$T/state FAKE_VM_STATE=$T/vmstate BOXD_CONF=$T/none.conf BOXD_VIEW_KEYS=$T/none.keys \
  BOXD_WORK=$W BOXD_IMAGES_DIR=$T/images BOXD_CGROOT=$T/cg BOXD_ZRAM_SYS=$T/zram BOXD_PROC=$T/proc BOXD_MEMINFO=$T/meminfo BOXD_POD_CLEAN=$T/clean \
  BOXD_POWER=on BOXD_IDLE_STATE=$T/idle BOXD_KEEPAWAKE_LOCK=$T/keepawake.lock BOXD_ROUTE=$T/none.route BOXD_NET=$T/none.net HOME=$T
pod() { SSH_ORIGINAL_COMMAND="$1" bash "$HERE/server/boxd-pod" </dev/null; }

# A run holds the box's lock and the keepawake lock while the report is read. Both fifos are opened read-write once, here, so no
# step depends on which process opens first (no clock, no race).
: > "$T/keepawake.lock"; : > "$J/boxd-2889387319/.running"; mkfifo "$T/held" "$T/rel"; exec 8<>"$T/held" 9<>"$T/rel"
flock -s "$J/boxd-2889387319/.running" sh -c 'echo held >&8; read x <&9' & h1=$!
flock -s "$T/keepawake.lock" sh -c 'echo held >&8; read x <&9' & h2=$!
read -r _ <&8; read -r _ <&8
mkdir -p "$OUT"
pod "pod report" | sed -E '1 { s/\tload1=[^\t]*/\tload1=17.42/; s/\tload5=[^\t]*/\tload5=9.10/; s/\tload15=[^\t]*/\tload15=6.85/; s/\tboot=[^\t]*/\tboot=1794218400/ }' > "$OUT/tower.report"
echo go >&9; echo go >&9; wait "$h1" "$h2"
ans=$(pod "pod calls")
head -n 1 <<<"$ans" | grep -qE '^calls	size=[0-9]+	from=0	next=[0-9]+$' || { echo "unexpected pod calls header" >&2; exit 1; }
tail -n +2 <<<"$ans" > "$OUT/tower.calls"
echo "wrote $OUT/tower.report and $OUT/tower.calls"
