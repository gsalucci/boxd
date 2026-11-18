#!/usr/bin/env bash
# tools/host-watch: the checks of one `pod report`, of the placement log, and the rule that a finding is printed
# once after it held for the samples its check asks. Reports are written here; no host is contacted, no clock is read.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
W=tools/host-watch; fails=0
ok() { echo "ok $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
has() { if grep -q -- "$2" <<<"$3"; then ok "$1"; else bad "$1: no \"$2\" in: $3"; fi; }
hasnot() { if grep -q -- "$2" <<<"$3"; then bad "$1: \"$2\" in: $3"; else ok "$1"; fi; }

NOW=1000000
host() { # <group used> <vm_used> <vm_max> <disk> <pressure> <keepawake>
  printf 'host\tversion=0.4.10\tengines=container,vm\tcpus=16\tload1=1\tload5=1\tload15=1\tboot=5\tmem_total_mb=32029\tmem_avail_mb=9000\tswap_total_mb=16013\tswap_used_mb=100\tgroup_mem_max_mb=24576\tgroup_mem_used_mb=%s\tpressure_some10=0\tpressure_some60=0\tpressure_full10=0\tpressure_full60=%s\toom_kills=4\tvm_used=%s\tvm_max=%s\tvm_room=yes\tvm_mem_mb=8192\tbox_mem_mb=12288\tdisk_pct=%s\tdisk_total_mb=9\tdisk_used_mb=1\tttl=1800\tpower=on\tidle_checks=20\tidle_count=0\tidle_last=ssh\treset_at=85\tkeepawake=%s\n' "$1" "$5" "$2" "$3" "$4" "$6"
}
box() { # <name> <engine> <state> <last used> <limit> <busy> <runs>
  printf 'box\tbox=%s\tengine=%s\timage=i\tstate=%s\tlast_used=%s\tuser=-\tsize=-\tmem_limit_mb=%s\tmem_mb=1\tbusy=%s\truns=%s\n' "$@"
}
run() { printf 'run\tbox=%s\tid=%s\tstate=%s\texit=-\tbytes=0\tchanged=1\n' "$@"; }

# A healthy host: busy machines inside the cap, a box idle for less than the limit.
{ host 9000 2 none 28 0.5 held; box a vm running $((NOW - 60)) 8192 yes 1; box b vm running $((NOW - 60)) 8192 yes 0
  box c container running $((NOW - 1700)) 12288 no 0; run a r1 running; } > "$T/good"
out=$($W check tower "$T/good" $NOW)
[ -z "$out" ] && ok "a healthy report has no finding" || bad "a healthy report has no finding: $out"

# Every rule broken at once.
{ host 24000 4 3 80 12 held; box a vm running $((NOW - 60)) 8192 no 0; box b vm running $((NOW - 60)) 8192 no 0
  box c vm running $((NOW - 60)) 8192 no 0; box d vm running $((NOW - 60)) 4096 no 0
  box old container running $((NOW - 2401)) 12288 no 0; box edge container running $((NOW - 2400)) 12288 no 0
  box gone container stopped $((NOW - 60)) 12288 no 0; run gone r9 running; } > "$T/bad"
out=$($W check tower "$T/bad" $NOW)
has "machines over the cap" "add up to 28672 MB, more than the group cap of 24576" "$out"
has "group at its cap" "the boxes use 24000 of 24576 MB" "$out"
has "more machines than the ceiling" "4 machines run, the ceiling is 3" "$out"
has "memory pressure" "memory pressure of the boxes is 12 percent" "$out"
has "work area above the eviction level" "work area is 80 percent full" "$out"
has "idle box past the limit" "box old is idle for 40 minutes" "$out"
hasnot "a box exactly ten minutes over is not yet late" "box edge" "$out"
has "run in a box that does not run" "run gone/r9 is listed as running" "$out"
{ host 9000 0 none 28 0 held; box c container running $((NOW - 100)) 12288 no 0; } > "$T/awake"
has "awake without work" "6	WARN	tower:awake	tower: awake without work" "$($W check tower "$T/awake" $NOW)"
has "every finding names its host" "^[0-9]*	[A-Z]*	tower:" "$out"

# Numbers are compared as numbers: 4096 is under 13377 (seen wrong on laptop with a comparison of texts).
{ host 3000 1 1 25 0 held | sed 's/group_mem_max_mb=24576/group_mem_max_mb=13377/'; box m vm running $((NOW - 60)) 4096 yes 1; } > "$T/small"
[ -z "$($W check laptop "$T/small" $NOW)" ] && ok "one small machine under a five digit cap" || bad "one small machine under a five digit cap"

# A run that is going is work: the host may stay awake.
{ host 9000 0 none 28 0 held; box a container running $((NOW - 9000)) 12288 yes 0; } > "$T/work"
hasnot "a busy box is neither idle nor a host awake for nothing" "idle\|awake" "$($W check tower "$T/work" $NOW)"
printf 'box\tbox=a\n' > "$T/nohost"
has "a report without a host line" "no host line" "$($W check tower "$T/nohost" $NOW)"

# Placement: the first host in order with room.
{ printf 't1\tb1\tvm,-\ttower\torder\ttower=awake,laptop=awake\n'
  printf 't2\tb2\tvm,-\tlaptop\toverflow\ttower=no memory for another machine (4 running),laptop=awake\n'
  printf 't3\tb3\tvm,-\tlaptop\toverflow\ttower=awake,laptop=awake\n'
  printf 't4\tb4\tvm,-\tlaptop\tmoved\t\n'
  printf 't5\tb5\tvm,-\ttower\torder\ttower=asleep,laptop=awake\n'
  printf 't6\tb6\tvm,-\tlaptop\tspread\ttower=awake,laptop=awake\n'
  printf 't7\tb7\tvm,-\tlaptop\tfit\ttower=awake,laptop=awake\n'
  printf 't8\tb8\tvm,-\tlaptop\tfit\ttower=asleep,laptop=asleep\n'
  printf 't9\tb9\tvm,-\ttower\tfit\ttower=no memory for another machine (4 running),laptop=awake\n'; } > "$T/choices"
out=$($W choices "$T/choices" 1)
has "a placement past a host with room" "placement of b3 at t3 went to laptop as \"overflow\", but tower was first" "$out"
has "a fit placement on a host that had no room" "placement of b9 at t9 went to tower as \"fit\", but that host had no room" "$out"
[ "$(wc -l <<<"$out")" = 2 ] && ok "the right placements (fit on an awake or a sleeping host too) and a move are not findings" || bad "only b3 and b9 are wrong: $out"
[ -z "$($W choices "$T/choices" 10)" ] && [ "$($W choices "$T/choices" 9 | wc -l)" = 1 ] && ok "lines before the start line are not read again" || bad "start line ignored"

# A finding is printed when it held its samples, once, and "ended" once when it is gone.
f=$'2\tWARN\ttower:idle-box:old\ttower: box old is idle'
e=$'1\tALERT\ttower:event:oom:5\ttower: killed'
[ -z "$(printf '%s\n' "$f" | $W settle "$T/counts")" ] && ok "first sample of two: silent" || bad "first sample of two: silent"
has "second sample: printed" "WARN	tower: box old is idle" "$(printf '%s\n%s\n' "$f" "$e" | $W settle "$T/counts")"
[ -z "$(printf '%s\n' "$f" | $W settle "$T/counts")" ] && ok "third sample: not repeated, a single event does not end" || bad "third sample repeated"
has "gone: ended" "OK	ended: tower:idle-box:old" "$(: | $W settle "$T/counts")"
[ -z "$(: | $W settle "$T/counts")" ] && ok "ended is said once" || bad "ended is said once"
[ -z "$(printf '%s\n' "$f" | $W settle "$T/c2"; : | $W settle "$T/c2")" ] && ok "a finding that never held its samples does not end" || bad "unprinted finding ended"

# A recorded box whose worktree is gone for hours is a finding only while its host is awake (the collector wakes no host).
mkdir -p "$T/state/boxes"
printf '{"box":"b","host":"tower","worktree":"%s/gone","missingSince":%s}\n' "$T" $(( (NOW - 10800) * 1000 )) > "$T/state/boxes/tower.b"
has "worktree gone, host awake" "gone for 3 hours and its box is still recorded (tower.b)" "$(BOXD_STATE=$T/state $W stranded $NOW ' laptop tower')"
[ -z "$(BOXD_STATE=$T/state $W stranded $NOW ' laptop')" ] && ok "worktree gone, host asleep: not a finding" || bad "asleep host's record is a finding"

# The stall counters: two samples through `sample` with a fake `box` and `ssh`; the second sample's progress line and findings.
mkdir -p "$T/bin"
printf '#!/bin/sh\nprintf "tower\\tsleeps\\tawake\\n"\n' > "$T/bin/box"
printf '#!/bin/sh\ncat "$FAKE_REPORT"\n' > "$T/bin/ssh"
chmod +x "$T/bin/box" "$T/bin/ssh"
sample() { # <report file>: one sample of the fake host, summary line then findings
  FAKE_REPORT=$1 PATH=$T/bin:$PATH HOST_WATCH_DIR=$T/w BOXD_STATE=$T/nostate $W
  cat "$T/w/state/summary.new"; rm -f "$T/w/state/summary.new"
}
words() { host 9000 2 none 28 0 held | sed "s/\$/$1/" | sed 's/boot=5/boot='"${2:-5}"'/'; } # <extra words> [boot]
words '\tpressure_some_ms=9\tpressure_full_ms=1000\tnet_tx_timeouts=3\tnet_link_changes=7' > "$T/s1"
words '\tpressure_some_ms=9\tpressure_full_ms=1750\tnet_tx_timeouts=3\tnet_link_changes=8' > "$T/s2"
words '\tpressure_some_ms=9\tpressure_full_ms=1800\tnet_tx_timeouts=5\tnet_link_changes=8' > "$T/s3"
words '\tpressure_some_ms=9\tpressure_full_ms=10\tnet_tx_timeouts=9\tnet_link_changes=1' 6 > "$T/s4"
host 9000 2 none 28 0 held > "$T/old"
out=$(sample "$T/s1")
has "first sample: no stall time, the counts as received" "stall_ms=- tx_timeouts=3 link_changes=7 " "$out"
hasnot "first sample: no transmit finding" "network card" "$out"
out=$(sample "$T/s2")
has "stall time is the rise of pressure_full_ms since the previous sample" "stall_ms=750 tx_timeouts=3 link_changes=8 " "$out"
hasnot "same transmit count: no finding" "network card" "$out"
out=$(sample "$T/s3")
has "a rise of transmit timeouts is a warning" "WARN	tower: the network card stalled while sending (transmit timeouts 5, were 3)" "$out"
has "the stall time still counts on that sample" "stall_ms=50 tx_timeouts=5 " "$out"
out=$(sample "$T/s4")
has "after a restart: no stall time" "stall_ms=- tx_timeouts=9 link_changes=1 " "$out"
hasnot "after a restart: no transmit finding" "network card" "$out"
has "after a restart: the restart is the finding" "restarted since the last sample" "$out"
out=$(sample "$T/old")
has "a report without the new words: dashes" "stall_ms=- tx_timeouts=- link_changes=- " "$out"
out=$(sample "$T/old")
has "and again, on the same boot" "stall_ms=- tx_timeouts=- link_changes=- " "$out"

[ "$fails" = 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
