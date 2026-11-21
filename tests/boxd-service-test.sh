#!/usr/bin/env bash
# Assert-based test for the runit side of boxd: server/boxctl, server/sv/boxd (run, finish), server/sv/boxd-sshd/run
# and power/sv/boxd-power/run. Fake sv, runuser, id, mountpoint, chown, sleep and sshd sit first on PATH and log
# their calls; nothing real is started and no step waits on time (the fake sleep ends the reaper loop at once).
#   1. boxd refuses to start while the work area is not mounted, and starts nothing
#   2. boxd starts the build sshd, then the power module only when BOXD_POWER=on, then reaps; a module that is off is stopped
#   3. finish stops the power module and the build sshd, then removes every box
#   4. boxctl start, stop, status, check, log, reload; reload never touches boxes
#   5. the build sshd caps: 85 percent of memory by default, settings win, the sshd gets the settings as options
#   6. the services ship with the right `down` files
#   7. the same programs under systemd (BOXD_MANAGER=systemd, fake systemctl and journalctl): boxctl, the boxd run and
#      finish files, the build sshd in the unit's own cgroup (BOXD_CGROUP), and a work area in directory mode
#   8. the shipped unit files name the files the Debian layout installs
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/svdir"
ln -s "$HERE/server/boxctl" "$T/bin/boxctl"
for tool in sv runuser chown; do
    cat > "$T/bin/$tool" <<EOF
#!/bin/sh
echo "$tool \$*" >> "$T/calls"
exit \${FAKE_${tool}_EXIT:-0}
EOF
done
cat > "$T/bin/id" <<'EOF'
#!/bin/sh
[ "$1" = -u ] && { echo 0; exit 0; }
exit "${FAKE_ID_EXIT:-0}"
EOF
cat > "$T/bin/mountpoint" <<'EOF'
#!/bin/sh
[ -e "$FAKE_MOUNTED" ]
EOF
cat > "$T/bin/sleep" <<EOF
#!/bin/sh
echo "sleep \$*" >> "$T/calls"
[ -n "\${FAKE_ZRAM_AFTER:-}" ] && [ "\$(grep -c "^sleep" "$T/calls")" -ge "\$FAKE_ZRAM_AFTER" ] && printf "%s\n" "\$FAKE_ZRAM_LINE" >> "\$BOXD_SWAPS"
exit 1
EOF
cat > "$T/bin/fake-sshd" <<EOF
#!/bin/sh
echo "sshd \$*" >> "$T/calls"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" BOXD_CONF="$T/none.conf" SVDIR="$T/svdir" BOXD_KEEPAWAKE_LOCK="$T/lock" BOXD_LOGDIR="$T/log" FAKE_MOUNTED="$T/mounted" \
    BOXD_POD_CLEAN="$T/clean" BOXD_SSHD="$T/bin/fake-sshd"
export BOXD_MANAGER=runit   # the host running this test may use systemd
unset BOXD_POWER BOXD_USER BOXD_WORK BOXD_MEM_MAX BOXD_SWAP_MAX BOXD_PORT BOXD_TRUSTED_NET
calls() { paste -sd'|' "$T/calls" 2>/dev/null; }
fresh() { : > "$T/calls"; rm -f "$T/lock" "$T/mounted" "$T/clean"; rm -rf "$T/svdir" "$T/cg"; mkdir -p "$T/svdir"; : > "$T/none.conf"; }
SV="$HERE/server/sv"

# 1. work area missing
fresh; touch "$T/svdir/boxd-sshd"
out=$(sh "$SV/boxd/run" 2>&1); rc=$?
eq "run refuses without the work area: exit 1" 1 "$rc"
eq "run names the missing work area" "boxctl: work area /var/lib/boxd/work is not mounted (run boxd-setup)" "$out"
eq "run started nothing" "" "$(calls)"

# 2. members, then the reaper loop
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"
out=$(sh "$SV/boxd/run" 2>&1); rc=$?
eq "run ends only when the reaper loop ends (the fake sleep fails)" 1 "$rc"
eq "power off: sshd started, then the reaper ran as the build account, then the loop waited" "sv start boxd-sshd|runuser -u boxd -- boxd-pod reap|sleep 60" "$(calls)"
eq "run created the keepawake lock" yes "$([ -e "$T/lock" ] && echo yes || echo no)"
eq "run says it is up" "boxd: up" "$(printf %s "$out" | tail -1)"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd" "$T/svdir/boxd-power"; echo 'BOXD_POWER=on' > "$T/none.conf"
sh "$SV/boxd/run" >/dev/null 2>&1
eq "power on: sshd first, then the power module" "sv start boxd-sshd|sv start boxd-power|runuser -u boxd -- boxd-pod reap|sleep 60" "$(calls)"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd" "$T/svdir/boxd-power"
sh "$SV/boxd/run" >/dev/null 2>&1
eq "power off while the module is enabled: it is stopped, never started" "sv start boxd-sshd|sv stop boxd-power|runuser -u boxd -- boxd-pod reap|sleep 60" "$(calls)"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"; export FAKE_sv_EXIT=1
out=$(sh "$SV/boxd/run" 2>&1); rc=$?
eq "a sshd that does not start stops the run" "1 boxd: boxd-sshd did not start" "$rc $(printf %s "$out" | tail -1)"
unset FAKE_sv_EXIT
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"; echo 'BOXD_USER=builder' > "$T/none.conf"
sh "$SV/boxd/run" >/dev/null 2>&1
eq "the account name is a setting" "sv start boxd-sshd|runuser -u builder -- boxd-pod reap|sleep 60" "$(calls)"

# 3. finish
fresh; touch "$T/svdir/boxd-power"
out=$(sh "$SV/boxd/finish" 2>&1)
eq "finish: power module, build sshd, then the boxes" "sv stop boxd-power|sv stop boxd-sshd|runuser -l boxd -c boxd-pod clear" "$(calls)"
fresh
sh "$SV/boxd/finish" >/dev/null 2>&1
eq "finish without the power module installed: no stop for it" "sv stop boxd-sshd|runuser -l boxd -c boxd-pod clear" "$(calls)"

# 4. boxctl
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"
boxctl start; eq "boxctl start" "sv -w 60 start boxd" "$(calls)"
fresh; boxctl stop; eq "boxctl stop" "sv -w 120 stop boxd" "$(calls)"
fresh; boxctl status >/dev/null; eq "boxctl status without the module" "sv status boxd boxd-sshd" "$(calls)"
fresh; touch "$T/svdir/boxd-power"; boxctl status | tail -1 >/dev/null
eq "boxctl status with the module" "sv status boxd boxd-sshd|sv status boxd-power" "$(calls)"
fresh; boxctl reload; eq "reload, power off: only the build sshd" "sv restart boxd-sshd" "$(calls)"
eq "reload never touched a box" 0 "$(calls | grep -c 'boxd-pod\|podman\|runuser')"
fresh; touch "$T/svdir/boxd-power"; echo 'BOXD_POWER=on' > "$T/none.conf"; boxctl reload
eq "reload, power on: the build sshd and the power module" "sv restart boxd-sshd|sv restart boxd-power" "$(calls)"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"; out=$(boxctl check); eq "check passes" "boxd: conditions hold" "$out"
fresh; touch "$T/mounted"; rm -rf "$T/svdir"; mkdir "$T/svdir"; out=$(boxctl check 2>&1); rc=$?
eq "check fails without the sshd service" "1 boxctl: service boxd-sshd is not enabled (run boxd-setup)" "$rc $out"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"; echo 'BOXD_POWER=on' > "$T/none.conf"; out=$(boxctl check 2>&1); rc=$?
eq "check fails when the power module is on but not installed" 1 "$rc"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"; echo 'BOXD_POWER=maybe' > "$T/none.conf"; boxctl check >/dev/null 2>&1
eq "check refuses a power setting that is neither off nor on" 1 "$?"
fresh; touch "$T/mounted" "$T/svdir/boxd-sshd"; FAKE_ID_EXIT=1 boxctl check >/dev/null 2>&1
eq "check fails when the account is missing" 1 "$?"
rm -rf "$T/svdir"; mkdir "$T/svdir"; touch "$T/svdir/boxd-sshd"
mkdir -p "$T/log/boxd-sshd" "$T/log/boxd" "$T/log/boxd-power"
printf 'one\ntwo\n' > "$T/log/boxd-sshd/current"; printf 'up\n' > "$T/log/boxd/current"
eq "log shows the build sshd log by default" "one|two" "$(boxctl log | paste -sd'|')"
eq "log boxd shows the service log" "up" "$(boxctl log boxd)"
boxctl log nonsense 2>/dev/null; eq "log with an unknown name is a usage error" 2 "$?"
boxctl nonsense 2>/dev/null; eq "unknown command is a usage error" 2 "$?"

# 5. the build sshd
fresh; mkdir -p "$T/cg/boxd/sshd"; printf 'MemTotal:       1000000 kB\n' > "$T/meminfo"
printf 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swap/swapfile                          file\t\t400000\t\t0\t\t100\n' > "$T/swaps"
export BOXD_CGROOT="$T/cg" BOXD_MEMINFO="$T/meminfo" BOXD_SWAPS="$T/swaps"
sh "$SV/boxd-sshd/run" >/dev/null 2>&1
eq "memory cap defaults to 85 percent of memory" 850000K "$(cat "$T/cg/boxd/memory.max")"
eq "swap cap defaults to 25 percent of memory" 250000K "$(cat "$T/cg/boxd/memory.swap.max")"
eq "no memory.high" max "$(cat "$T/cg/boxd/memory.high")"
eq "the first boot clears the boxes, then the sshd starts with port, account and no exemption" \
   "chown boxd:boxd $T/cg/boxd $T/cg/boxd/cgroup.procs $T/cg/boxd/cgroup.subtree_control $T/cg/boxd/cgroup.threads|chown boxd:boxd $T/cg/boxd/sshd $T/cg/boxd/sshd/cgroup.procs $T/cg/boxd/sshd/cgroup.threads|runuser -l boxd -c boxd-pod clear boot|sshd -D -e -f /etc/boxd/sshd_config -o Port=2222 -o AllowUsers=boxd -o MaxStartups=100:30:200" "$(calls)"
eq "the boot marker exists" yes "$([ -e "$T/clean" ] && echo yes || echo no)"
: > "$T/calls"; sh "$SV/boxd-sshd/run" >/dev/null 2>&1
eq "a second start in the same boot does not clear the boxes again" 0 "$(calls | grep -c 'boxd-pod clear')"
printf 'BOXD_MEM_MAX=3G\nBOXD_SWAP_MAX=1G\nBOXD_PORT=2200\nBOXD_USER=builder\nBOXD_TRUSTED_NET=10.1.0.0/16\n' > "$T/none.conf"; : > "$T/calls"
sh "$SV/boxd-sshd/run" >/dev/null 2>&1
eq "settings win over the computed caps" "3G 1G" "$(cat "$T/cg/boxd/memory.max") $(cat "$T/cg/boxd/memory.swap.max")"
eq "settings reach the sshd as options" "sshd -D -e -f /etc/boxd/sshd_config -o Port=2200 -o AllowUsers=builder -o MaxStartups=100:30:200 -o PerSourcePenaltyExemptList=10.1.0.0/16" "$(calls | tr '|' '\n' | grep '^sshd')"
# Swap on zram lives in RAM (the tower, 2026-11-15: 28 GiB cap plus 8 GiB swapped to zram, and the host ran out before
# the cap). What the group may swap there counts at half its size against the memory cap.
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0                              partition\t400000\t0\t32767\n' > "$T/swaps"
: > "$T/none.conf"; out=$(sh "$SV/boxd-sshd/run" 2>&1)
eq "zram swap: the default memory cap leaves room for the swap it holds" "725000K 250000K" "$(cat "$T/cg/boxd/memory.max") $(cat "$T/cg/boxd/memory.swap.max")"
eq "zram swap: no warning for the computed caps" 0 "$(grep -c 'boxd-sshd: BOXD_MEM_MAX' <<<"$out")"
printf 'BOXD_SWAP_MAX=1G\n' > "$T/none.conf"; sh "$SV/boxd-sshd/run" >/dev/null 2>&1
eq "zram swap: a swap cap larger than the zram device counts the device only" 650000K "$(cat "$T/cg/boxd/memory.max")"
printf 'BOXD_MEM_MAX=850000K\n' > "$T/none.conf"; out=$(sh "$SV/boxd-sshd/run" 2>&1)
eq "zram swap: a set memory cap is kept" 850000K "$(cat "$T/cg/boxd/memory.max")"
eq "zram swap: a set memory cap that leaves the host short is warned about" \
    "boxd-sshd: BOXD_MEM_MAX (850000 kB) plus the zram swap the boxes may fill (about 125000 kB of RAM) is over 90% of the host's 1000000 kB; the host can run out of memory before the cap, and the kernel then kills a box" \
    "$(grep 'boxd-sshd: BOXD_MEM_MAX' <<<"$out")"
printf 'BOXD_MEM_MAX=24G\nBOXD_SWAP_MAX=8G\n' > "$T/none.conf"; printf 'MemTotal:       32797696 kB\n' > "$T/meminfo"
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition\t16398332\t0\t32767\n' > "$T/swaps"
out=$(sh "$SV/boxd-sshd/run" 2>&1); eq "zram swap: the tower's 24G and 8G pass without a warning" 0 "$(grep -c 'boxd-sshd: BOXD_MEM_MAX' <<<"$out")"
printf 'BOXD_MEM_MAX=28G\nBOXD_SWAP_MAX=8G\n' > "$T/none.conf"
out=$(sh "$SV/boxd-sshd/run" 2>&1); eq "zram swap: the tower's old 28G is warned about" 1 "$(grep -c 'boxd-sshd: BOXD_MEM_MAX' <<<"$out")"
printf 'MemTotal:       1000000 kB\n' > "$T/meminfo"; : > "$T/none.conf"; printf 'Filename\tType\tSize\tUsed\tPriority\n/swap/swapfile file\t400000\t0\t100\n' > "$T/swaps"
# At boot the zram service may switch its swap on after the build sshd starts; the run file waits for it (once a second, 30 times).
ZLINE='/dev/zram0 partition\t400000\t0\t32767\n'
sleeps() { grep -c '^sleep 1$' "$T/calls"; }
: > "$T/none.conf"; printf 'Filename\tType\tSize\tUsed\tPriority\n' > "$T/swaps"; touch "$T/svdir/zramen"
: > "$T/calls"; out=$(sh "$SV/boxd-sshd/run" 2>&1)
eq "zramen enabled, no zram swap ever: 30 waits, one line, the cap computed without it" "30 1 850000K" \
   "$(sleeps) $(grep -c 'the zram swap did not come up in 30 seconds; the cap is computed without it' <<<"$out") $(cat "$T/cg/boxd/memory.max")"
printf "Filename\tType\tSize\tUsed\tPriority\n$ZLINE" > "$T/swaps"
: > "$T/calls"; out=$(sh "$SV/boxd-sshd/run" 2>&1)
eq "zramen enabled, zram swap already on: no wait, the zram part is taken off the cap" "0 0 725000K" "$(sleeps) $(grep -c 'did not come up' <<<"$out") $(cat "$T/cg/boxd/memory.max")"
rm "$T/svdir/zramen"; printf 'Filename\tType\tSize\tUsed\tPriority\n' > "$T/swaps"
: > "$T/calls"; out=$(sh "$SV/boxd-sshd/run" 2>&1)
eq "zramen not enabled: no wait, no line" "0 0 850000K" "$(sleeps) $(grep -c 'did not come up' <<<"$out") $(cat "$T/cg/boxd/memory.max")"
touch "$T/svdir/zramen"; : > "$T/calls"
out=$(FAKE_ZRAM_AFTER=3 FAKE_ZRAM_LINE="/dev/zram0 partition	400000	0	32767" sh "$SV/boxd-sshd/run" 2>&1)
eq "zram swap appears during the wait: it ends at once and the zram part is taken off the cap" "3 0 725000K" "$(sleeps) $(grep -c 'did not come up' <<<"$out") $(cat "$T/cg/boxd/memory.max")"
rm "$T/svdir/zramen"; printf 'Filename\tType\tSize\tUsed\tPriority\n/swap/swapfile file\t400000\t0\t100\n' > "$T/swaps"
unset BOXD_CGROOT BOXD_MEMINFO

# 6. down files
eq "boxd-sshd ships with a down file" yes "$([ -e "$SV/boxd-sshd/down" ] && echo yes || echo no)"
eq "boxd-power ships with a down file" yes "$([ -e "$HERE/power/sv/boxd-power/down" ] && echo yes || echo no)"
eq "boxd itself has none: it starts by itself" no "$([ -e "$SV/boxd/down" ] && echo yes || echo no)"


# 7. systemd
export BOXD_MANAGER=systemd
mkdir -p "$T/units"
for tool in systemctl journalctl; do
    cat > "$T/bin/$tool" <<EOT
#!/bin/sh
echo "$tool \$*" >> "$T/calls"
[ "\$1" = cat ] && { [ -e "$T/units/\$2" ]; exit \$?; }
exit \${FAKE_${tool}_EXIT:-0}
EOT
    chmod +x "$T/bin/$tool"
done
sysfresh() { fresh; rm -rf "$T/units"; mkdir -p "$T/units"; }
sysfresh; touch "$T/mounted" "$T/units/boxd-sshd.service"
boxctl start; eq "systemd: boxctl start" "systemctl start boxd" "$(calls)"
sysfresh; boxctl stop; eq "systemd: boxctl stop" "systemctl stop boxd" "$(calls)"
sysfresh; touch "$T/units/boxd-sshd.service"; boxctl status >/dev/null
eq "systemd: status asks about boxd and boxd-sshd" 1 "$(calls | grep -c 'systemctl status boxd boxd-sshd --no-pager')"
sysfresh; boxctl reload; eq "systemd: reload restarts only the build sshd" "systemctl restart boxd-sshd" "$(calls)"
sysfresh; echo 'BOXD_POWER=on' > "$T/none.conf"; touch "$T/units/boxd-power.service"; boxctl reload
eq "systemd: reload with the power module on" "systemctl restart boxd-sshd|systemctl restart boxd-power" "$(calls)"
sysfresh; boxctl log >/dev/null; eq "systemd: log reads the journal of the build sshd" "journalctl -u boxd-sshd.service -n 100 --no-pager" "$(calls)"
sysfresh; boxctl log boxd -f >/dev/null; eq "systemd: log boxd -f follows" "journalctl -u boxd.service -n 100 --no-pager -f" "$(calls)"
sysfresh; touch "$T/mounted" "$T/units/boxd-sshd.service"; out=$(boxctl check); eq "systemd: check passes" "boxd: conditions hold" "$out"
sysfresh; touch "$T/mounted"; out=$(boxctl check 2>&1); rc=$?
eq "systemd: check fails when the unit is not installed" "1 boxctl: service boxd-sshd is not enabled (run boxd-setup)" "$rc $out"
sysfresh; touch "$T/units/boxd-sshd.service"; mkdir -p "$T/dirwork"; : > "$T/dirwork/.boxd-dir-mode"; echo "BOXD_WORK=$T/dirwork" > "$T/none.conf"
boxctl check >/dev/null 2>&1; eq "check accepts a directory-mode work area (the marker file) without a mount" 0 "$?"
rm "$T/dirwork/.boxd-dir-mode"; boxctl check >/dev/null 2>&1; eq "check refuses a plain folder without the marker" 1 "$?"
: > "$T/none.conf"
sysfresh; touch "$T/mounted" "$T/units/boxd-sshd.service"
out=$(sh "$SV/boxd/run" 2>&1)
eq "systemd: run checks, starts the build sshd through systemctl, then reaps" "systemctl cat boxd-sshd.service|systemctl start boxd-sshd|systemctl cat boxd-power.service|runuser -u boxd -- boxd-pod reap|sleep 60" "$(calls)"
sysfresh; touch "$T/mounted" "$T/units/boxd-sshd.service" "$T/units/boxd-power.service"
sh "$SV/boxd/run" >/dev/null 2>&1
eq "systemd: power off while its unit exists: stopped, never started" "systemctl cat boxd-sshd.service|systemctl start boxd-sshd|systemctl cat boxd-power.service|systemctl stop boxd-power|runuser -u boxd -- boxd-pod reap|sleep 60" "$(calls)"
sysfresh; sh "$SV/boxd/finish" >/dev/null 2>&1
eq "systemd: finish stops the build sshd, then removes the boxes" "systemctl cat boxd-power.service|systemctl stop boxd-sshd|runuser -l boxd -c boxd-pod clear" "$(calls)"

# the build sshd in the unit's own cgroup
sysfresh; CGR="$T/cgs"; CGU=$CGR/boxd.slice/boxd-sshd.service; rm -rf "$CGR"; mkdir -p "$CGU"
printf 'MemTotal:       1000000 kB\n' > "$T/meminfo"
export BOXD_CGROOT="$CGR" BOXD_CGROUP="$CGU" BOXD_MEMINFO="$T/meminfo" BOXD_PROC_CGROUP="$T/proc-cgroup" BOXD_SWAPS="$T/swaps"
echo "0::/system.slice/other.service" > "$T/proc-cgroup"
out=$(sh "$SV/boxd-sshd/run" 2>&1); rc=$?
eq "systemd: a service outside the named cgroup refuses to start" "1" "$rc"
eq "systemd: the refusal names both cgroups" "yes" "$(case $out in *"/system.slice/other.service"*"$CGU"*) echo yes;; *) echo no;; esac)"
eq "systemd: nothing was started or capped on a mismatch" "" "$(calls)"
echo "0::/boxd.slice/boxd-sshd.service" > "$T/proc-cgroup"; mkdir -p "$CGU/sshd"
sh "$SV/boxd-sshd/run" >/dev/null 2>&1
eq "systemd: caps are written in the unit's cgroup" "850000K 250000K max" "$(cat "$CGU/memory.max") $(cat "$CGU/memory.swap.max") $(cat "$CGU/memory.high")"
eq "systemd: the sshd moves into the child cgroup" "yes" "$([ -s "$CGU/sshd/cgroup.procs" ] && echo yes || echo no)"
eq "systemd: the root cgroup is left alone" "no" "$([ -e "$CGR/cgroup.subtree_control" ] && echo yes || echo no)"
eq "systemd: the controllers are handed to the children of the unit's cgroup" "+cpu +memory +pids" "$(cat "$CGU/cgroup.subtree_control")"
unset BOXD_CGROOT BOXD_CGROUP BOXD_MEMINFO BOXD_PROC_CGROUP BOXD_SWAPS

# 8. the unit files
U1="$HERE/server/systemd/boxd.service"; U2="$HERE/server/systemd/boxd-sshd.service"
eq "boxd.service runs the shared run file with the systemd manager" 1 "$(grep -c '^ExecStart=/bin/sh /usr/libexec/boxd/boxd-run$' "$U1")"
eq "boxd.service runs the shared finish file after the service stops" 1 "$(grep -c '^ExecStopPost=/bin/sh /usr/libexec/boxd/boxd-finish$' "$U1")"
eq "boxd.service is wanted at boot" 1 "$(grep -c '^WantedBy=multi-user.target$' "$U1")"
eq "boxd-sshd.service runs the shared sshd file" 1 "$(grep -c '^ExecStart=/bin/sh /usr/libexec/boxd/sshd-run$' "$U2")"
eq "boxd-sshd.service delegates its cgroup" 1 "$(grep -c '^Delegate=yes$' "$U2")"
eq "boxd-sshd.service has no install section (boxd starts it)" 0 "$(grep -c '^\[Install\]' "$U2")"
eq "both units name the manager" 2 "$(grep -c '^Environment=BOXD_MANAGER=systemd$' "$U1" "$U2" | awk -F: '{s+=$2} END {print s}')"

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
