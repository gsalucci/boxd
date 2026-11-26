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
  printf 'host\tversion=0.4.10\tengines=container,vm\tcpus=16\tload1=1\tload5=1\tload15=1\tboot=5\tmem_total_mb=32029\tmem_avail_mb=9000\tswap_total_mb=16013\tswap_used_mb=100\tgroup_mem_max_mb=24576\tgroup_mem_used_mb=%s\tpressure_some10=0\tpressure_some60=0\tpressure_full10=0\tpressure_full60=%s\toom_kills=4\tvm_used=%s\tvm_max=%s\tvm_room=yes\tvm_mem_mb=8192\tbox_mem_mb=12288\tdisk_pct=%s\tdisk_total_mb=9\tdisk_used_mb=1\tttl=1800\tpower=on\tidle_checks=20\tidle_count=0\tidle_last=idle\treset_at=85\tkeepawake=%s\n' "$1" "$5" "$2" "$3" "$4" "$6"
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

# The group's swap nearly full (90 percent of its limit) with its memory at 85 percent of the cap is a finding; with less of either, or with no limit known, it is not.
sed '1s/$/\tgroup_swap_used_mb=8139\tgroup_swap_max_mb=8192/' "$T/good" > "$T/swap"
out=$($W check tower "$T/swap" $NOW); [ -z "$out" ] && ok "full swap with memory far from the cap is no finding" || bad "full swap with memory far from the cap is no finding: $out"
sed -i '1s/group_mem_used_mb=9000/group_mem_used_mb=21000/' "$T/swap"
has "swap cushion full" "the boxes have 8139 of their 8192 MB of swap in use" "$($W check tower "$T/swap" $NOW)"
sed '1s/group_mem_used_mb=9000/group_mem_used_mb=21000/; 1s/$/\tgroup_swap_used_mb=7372\tgroup_swap_max_mb=8192/' "$T/good" > "$T/swap"
out=$($W check tower "$T/swap" $NOW); [ -z "$out" ] && ok "swap below 90 percent is no finding" || bad "swap below 90 percent is no finding: $out"
sed '1s/group_mem_used_mb=9000/group_mem_used_mb=21000/; 1s/$/\tgroup_swap_used_mb=8139\tgroup_swap_max_mb=-/' "$T/good" > "$T/swap"
out=$($W check tower "$T/swap" $NOW); [ -z "$out" ] && ok "swap with no limit is no finding" || bad "swap with no limit is no finding: $out"

# zram: the peak of the zram devices above the swap limit that the cap leaves for it is a finding; below it, with the words missing, or with no limit, it is not.
sed '1s/$/\tgroup_swap_used_mb=0\tgroup_swap_max_mb=8192\tzram_used_mb=100\tzram_peak_mb=8193/' "$T/good" > "$T/zram"
has "zram peak above the swap limit" "zram held 8193 MB of memory at its peak since boot, more than the 8192 MB swap limit of the boxes" "$($W check tower "$T/zram" $NOW)"
sed '1s/$/\tgroup_swap_used_mb=0\tgroup_swap_max_mb=8192\tzram_used_mb=100\tzram_peak_mb=8192/' "$T/good" > "$T/zram"
out=$($W check tower "$T/zram" $NOW); [ -z "$out" ] && ok "zram peak at the swap limit is no finding" || bad "zram peak at the swap limit is no finding: $out"
sed '1s/$/\tgroup_swap_used_mb=0\tgroup_swap_max_mb=8192/' "$T/good" > "$T/zram"
out=$($W check tower "$T/zram" $NOW); [ -z "$out" ] && ok "a report without the zram words is no finding" || bad "a report without the zram words is no finding: $out"
sed '1s/$/\tgroup_swap_used_mb=0\tgroup_swap_max_mb=-\tzram_used_mb=-\tzram_peak_mb=-/' "$T/good" > "$T/zram"
out=$($W check tower "$T/zram" $NOW); [ -z "$out" ] && ok "dashes for zram and the swap limit are no finding" || bad "dashes for zram and the swap limit are no finding: $out"
sed '1s/$/\tgroup_swap_used_mb=0\tgroup_swap_max_mb=-\tzram_used_mb=9000\tzram_peak_mb=9000/' "$T/good" > "$T/zram"
out=$($W check tower "$T/zram" $NOW); [ -z "$out" ] && ok "zram peak with swap limit a dash is no finding" || bad "zram peak with swap limit a dash is no finding: $out"
sed '1s/$/\tgroup_swap_used_mb=0\tgroup_swap_max_mb=3934\tzram_used_mb=9\tzram_peak_mb=24/' "$T/good" > "$T/zram"
out=$($W check tower "$T/zram" $NOW); [ -z "$out" ] && ok "a small zram peak is no finding (numbers compared as numbers, not as text)" || bad "a small zram peak is no finding: $out"

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
# A login left open (the sleep module's last busy reason is ssh) with no work is a finding after 24 samples; with a run going,
# with the lock held (that finding names it already) or with another reason, it is not.
login() { sed '1s/idle_last=idle/idle_last=ssh/'; }
{ host 9000 0 none 28 0 free | login; box c container running $((NOW - 100)) 12288 no 0; } > "$T/login"
has "a login left open keeps the host awake" "24	WARN	tower:login	tower: awake without work for 24 samples because an ssh connection stays open" "$($W check tower "$T/login" $NOW)"
{ host 9000 0 none 28 0 free | login; box a container running $((NOW - 100)) 12288 yes 1; run a r1 running; } > "$T/loginwork"
hasnot "a login while a run goes is no finding" "login" "$($W check tower "$T/loginwork" $NOW)"
{ host 9000 0 none 28 0 held | login; } > "$T/loginheld"
out=$($W check tower "$T/loginheld" $NOW); has "a held lock with a login is the lock finding" "tower:awake" "$out"; hasnot "a held lock with a login gives no second finding" "tower:login" "$out"
{ host 9000 0 none 28 0 free | sed '1s/idle_last=idle/idle_last=load/'; } > "$T/loginload"
[ -z "$($W check tower "$T/loginload" $NOW)" ] && ok "awake for load is no login finding" || bad "awake for load is no login finding"
{ host 9000 0 none 28 0 free | login | sed '1s/power=on/power=off/'; } > "$T/loginoff"
[ -z "$($W check tower "$T/loginoff" $NOW)" ] && ok "a host without the power module is no login finding" || bad "a host without the power module is no login finding"
has "every finding names its host" "^[0-9]*	[A-Z]*	tower:" "$out"

# The words of the disk budget (work_own, work_shared, evict_at): a report without them, from an older server, gives neither finding.
budget_words() { sed "s/\\tttl=1800\\t/\\tttl=1800\\twork_own=$1\\twork_shared=$2\\tevict_at=$3\\tevict_to=60\\tkeep_days=14\\t/"; }
{ host 9000 0 none 28 0 free | budget_words no yes 70; box c container running $((NOW - 100)) 12288 no 0; } > "$T/budget"
out=$($W check tower "$T/budget" $NOW)
has "a work area that is no file system of its own" "1	WARN	tower:workfs	tower: the work area is not a file system of its own: the system.s snapshots keep build data; run boxd-setup" "$out"
has "a work area on the system disk with cleanup from 70 percent" "1	WARN	tower:budget	tower: the work area shares its disk with the system and cleanup starts only at 70 percent of that disk; set BOXD_EVICT_AT and BOXD_EVICT_TO in /etc/boxd/boxd.conf" "$out"
{ host 9000 0 none 28 0 free | budget_words yes yes 60; } > "$T/budget60"
out=$($W check tower "$T/budget60" $NOW)
has "cleanup from exactly 60 percent still counts" "tower:budget" "$out"
hasnot "a work area of its own raises no file system finding" "workfs" "$out"
{ host 9000 0 none 28 0 free | budget_words yes yes 40; } > "$T/budget40"
[ -z "$($W check tower "$T/budget40" $NOW)" ] && ok "levels under 60 percent on a shared disk are no finding" || bad "levels under 60 percent on a shared disk are no finding"
{ host 9000 0 none 28 0 free | budget_words folder yes 40; } > "$T/budgetfolder"
[ -z "$($W check tower "$T/budgetfolder" $NOW)" ] && ok "a plain folder in directory mode (work_own=folder) is no finding" || bad "a plain folder in directory mode (work_own=folder) is no finding"
{ host 9000 0 none 28 0 free | budget_words yes no 70; } > "$T/budgetown"
[ -z "$($W check tower "$T/budgetown" $NOW)" ] && ok "a disk of its own with the default levels is no finding" || bad "a disk of its own with the default levels is no finding"
{ host 9000 0 none 28 0 free | budget_words - - -; } > "$T/budgetdash"
[ -z "$($W check tower "$T/budgetdash" $NOW)" ] && ok "words that could not be read are no finding" || bad "words that could not be read are no finding"

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
  printf 't9\tb9\tvm,-\ttower\tfit\ttower=no memory for another machine (4 running),laptop=awake\n'
  printf 't10\tb10\tvm,-\tlaptop\tfit\ttower=busy, load 25.90 on 16 processors,laptop=busy, load 21.01 on 12 processors\n'; } > "$T/choices"
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
[ -z "$(BOXD_STATE=$T/state $W stranded $NOW ' laptop tower')" ] && ok "no collector pass ever: not a finding" || bad "finding without a collector pass"
touch -d @$(( NOW - 10800 )) "$T/state/gc.stamp"
[ -z "$(BOXD_STATE=$T/state $W stranded $NOW ' laptop tower')" ] && ok "worktree gone, the last pass only marked it: waits for the next call, not a finding" || bad "marked record is a finding"
touch -d @$(( NOW - 10800 + 899 )) "$T/state/gc.stamp"
[ -z "$(BOXD_STATE=$T/state $W stranded $NOW ' laptop tower')" ] && ok "a pass under 15 minutes after the mark: not a finding" || bad "pass under 15 minutes is a finding"
touch -d @$(( NOW - 10800 + 900 )) "$T/state/gc.stamp"
has "worktree gone, host awake, a pass 15 minutes after the mark left it" "gone for 3 hours and its box is still recorded (tower.b)" "$(BOXD_STATE=$T/state $W stranded $NOW ' laptop tower')"
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

# Load: the sample line carries load1 and cpus; one host over its processors while another has room and is under half
# of its own is a finding (key <busy host>:lopsided, after two samples, once). Two fake hosts, each with a status line.
out=$(sample "$T/s1")
has "the sample line shows the load and the processors" "load1=1 " "$out"
has "the sample line shows the processors" "cpus=16 " "$out"
mkdir -p "$T/bin2"
printf '#!/bin/sh\ncat "$FAKE_HOSTS"\n' > "$T/bin2/box"; cp "$T/bin/ssh" "$T/bin2/ssh"; chmod +x "$T/bin2/box" "$T/bin2/ssh"
hosts2() { # <tower cpus> <tower load1> <tower box_room> <laptop cpus> <laptop load1> <laptop box_room>
  printf 'tower\tsleeps\tawake\tversion=0.4.10\tcpus=%s\tload1=%s\tbox_room=%s\n' "$1" "$2" "$3"
  printf 'laptop\tsleeps\tawake\tversion=0.4.10\tcpus=%s\tload1=%s\tbox_room=%s\n' "$4" "$5" "$6"
}
lop() { # <case name> <hosts2 words>: three samples of a fresh watch directory, the findings of each
  hosts2 "${@:2}" > "$T/hosts-$1"; rm -rf "$T/l-$1"
  for n in 1 2 3; do FAKE_HOSTS=$T/hosts-$1 FAKE_REPORT=$T/s1 PATH=$T/bin2:$PATH HOST_WATCH_DIR=$T/l-$1 BOXD_STATE=$T/nostate $W > "$T/l-$1.$n"; done
}
lop busy 16 29.6 yes 12 0.3 yes
[ -z "$(cat "$T/l-busy.1")" ] && ok "lopsided load: silent at the first sample" || bad "lopsided load at the first sample: $(cat "$T/l-busy.1")"
has "lopsided load: the warning at the second sample" "WARN	tower: load 29.6 on 16 processors while laptop has room and load 0.3 on 12; builds are not spreading (a caller pinning with --host, placements made while laptop had no room, or calls placed seconds apart before the load average rose)" "$(cat "$T/l-busy.2")"
[ -z "$(cat "$T/l-busy.3")" ] && ok "lopsided load: shown once" || bad "lopsided load repeated: $(cat "$T/l-busy.3")"
lop reverse 16 1.3 yes 12 21 yes
has "the reverse: the other host is the busy one" "WARN	laptop: load 21 on 12 processors while tower has room and load 1.3 on 16" "$(cat "$T/l-reverse.2")"
lop balanced 16 12 yes 12 9 yes
lop nobusy 16 17 yes 12 7 yes
lop noroom 16 29.6 yes 12 0.3 no
lop blank 16 29.6 yes 12 - yes
lop words 16 29.6 yes 12 many yes
for c in balanced nobusy noroom blank words; do
  out=$(cat "$T/l-$c".[123]); hasnot "no lopsided warning: $c" "lopsided\|builds are not spreading" "$out"
done

[ "$fails" = 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
