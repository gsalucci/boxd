#!/usr/bin/env bash
# Assert-based test for power/boxd-idle and server/boxd-keepawake. Fake ss, zzz, ethtool, iw, df and
# boxd-reset sit first on PATH and read their answers from files; flock is the real one. One call of
# `boxd-idle check` is one minute of the service, so no clock is involved.
#   1. quiet checks count up and the last one arms both wake paths, then suspends
#   2. each busy signal (ssh, load, keepawake) resets the count, no suspend
#   3. boxd-keepawake blocks sleep exactly while its command runs (event fifo, no waiting on time)
#   4. a busy reason is logged once, not every minute
#   5. a sleep resets the build area first when the disk is at 85 percent or more, never below
#   6. no wake card named means it never sleeps; `status` names the busy reason or says quiet, changing nothing
#   7. BOXD_IDLE_IGNORE: build-port connections from listed addresses are not work; port 22 always is
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
IDLE="$HERE/power/boxd-idle"
KEEP="$HERE/server/boxd-keepawake"
fails=0
eq() { # eq <label> <expected> <actual>
    if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi
}

T=$(mktemp -d)
trap 'exec 3>&-; rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/ss" <<EOF
#!/bin/sh
# Honest filter: only lines whose local port is one the caller asked for (sport = :N).
ports=\$(printf %s "\$*" | grep -o "sport = :[0-9]*" | grep -o "[0-9]*\$" | paste -sd"|")
[ -n "\$ports" ] && grep -E " [^ ]+:(\$ports) " "$T/ss.out" || true
EOF
cat > "$T/bin/zzz" <<EOF
#!/bin/sh
echo "zzz \$*" >> "$T/calls"
EOF
cat > "$T/bin/ethtool" <<EOF
#!/bin/sh
echo "ethtool \$*" >> "$T/calls"
EOF
cat > "$T/bin/iw" <<EOF
#!/bin/sh
case "\$*" in *" info") echo "	wiphy 0" ;; *) echo "iw \$*" >> "$T/calls" ;; esac
EOF
cat > "$T/bin/df" <<EOF
#!/bin/sh
printf 'Use%%\n %s%%\n' "\$(cat "$T/df.pct")"
EOF
cat > "$T/bin/boxd-reset" <<EOF
#!/bin/sh
echo "boxd-reset \$*" >> "$T/calls"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" BOXD_CONF="$T/none.conf" BOXD_IDLE_STATE="$T/state" BOXD_IDLE_CHECKS=3 BOXD_LOADAVG="$T/loadavg" \
    BOXD_KEEPAWAKE_LOCK="$T/lock" BOXD_PORT=2222 BOXD_WIRED=wired0 BOXD_WIFI=wifi0
unset BOXD_IDLE_LOAD_MAX BOXD_RESET_AT
quiet() { echo 40 > "$T/df.pct"; : > "$T/ss.out"; echo "0.10 0.20 0.30 1/200 999" > "$T/loadavg"; }
check() { sh "$IDLE" check; }
count() { cat "$T/state/count"; }
calls() { cat "$T/calls" 2>/dev/null | paste -sd'|'; }
: > "$T/lock"

# 1. three quiet checks: the third arms and suspends, and the count starts over
quiet
check >/dev/null; check >/dev/null
eq "two quiet checks count up" 2 "$(count)"
eq "no suspend before the limit" "" "$(calls)"
check >/dev/null
eq "third quiet check arms both wake paths, then suspends" "ethtool -s wired0 wol g|iw phy phy0 wowlan enable magic-packet|zzz -z" "$(calls)"
eq "count starts over after the wake" 0 "$(count)"
: > "$T/calls"

# 2. every busy signal resets the count and never suspends
busy() { # busy <label> <expected reason> ; caller has set the signal
    rm -rf "$T/state"; mkdir -p "$T/state"; echo 2 > "$T/state/count"
    out=$(check)
    eq "$1: reason logged" "busy: $2" "$out"
    eq "$1: count reset" 0 "$(count)"
}
quiet; echo "ESTAB 0 0 10.0.0.2:22 10.0.0.9:51000" > "$T/ss.out"; busy "incoming ssh" ssh
quiet; echo "ESTAB 0 0 10.0.0.2:2222 10.0.0.9:51000" > "$T/ss.out"; busy "a build session on the build port" ssh
quiet; echo "0.70 0.20 0.10 2/200 999" > "$T/loadavg"; busy "load at 0.70" load
quiet; echo "0.50 0.20 0.10 2/200 999" > "$T/loadavg"; busy "load exactly at the limit" load
quiet; rm -rf "$T/state"
check >/dev/null   # processes inside boxes are never looked at
eq "a quiet check counts, whatever runs inside boxes" 1 "$(count)"
eq "no busy signal ever suspended" "" "$(calls)"

# 3. boxd-keepawake holds sleep off exactly while its command runs
quiet; rm -rf "$T/state"
mkfifo "$T/events" "$T/release"
exec 3<>"$T/events"
sh "$KEEP" sh -c "echo held >&3; read x < '$T/release'" &
holder=$!
read -r ev <&3
eq "boxd-keepawake started its command" held "$ev"
eq "held lock is a busy reason" "busy: keepawake" "$(check)"
echo go > "$T/release"
wait "$holder"
eq "after the command ends the host is idle again" "idle, sleeping after 3 quiet checks" "$(check)"
eq "boxd-keepawake passes the exit code through" 7 "$(sh "$KEEP" sh -c 'exit 7'; echo $?)"
BOXD_KEEPAWAKE_LOCK="$T/missing" sh "$KEEP" true 2>/dev/null
eq "boxd-keepawake still runs the command without the lock file" 0 "$?"

# 4. a repeated busy reason is logged once
quiet; rm -rf "$T/state"; echo "0.90 0.20 0.10 2/200 999" > "$T/loadavg"
first=$(check); second=$(check)
eq "first busy check logs" "busy: load" "$first"
eq "same reason next minute stays silent" "" "$second"

# 5. disk-full reset happens only on the way to sleep, from 85 percent up
sleep_with_disk() { quiet; echo "$1" > "$T/df.pct"; rm -rf "$T/state"; : > "$T/calls"; check >/dev/null; check >/dev/null; check >/dev/null; calls; }
eq "disk at 90: reset before arming and sleeping" "boxd-reset |ethtool -s wired0 wol g|iw phy phy0 wowlan enable magic-packet|zzz -z" "$(sleep_with_disk 90)"
eq "disk at exactly 85: reset" "boxd-reset " "$(sleep_with_disk 85 | cut -d'|' -f1)"
eq "disk at 84: no reset" "ethtool -s wired0 wol g" "$(sleep_with_disk 84 | cut -d'|' -f1)"
quiet; echo 95 > "$T/df.pct"; rm -rf "$T/state"; : > "$T/calls"; check >/dev/null
eq "full disk but not idle long enough yet: no reset" "" "$(calls)"

# 6. no wake card named, then status
quiet; rm -rf "$T/state"; : > "$T/calls"
eq "no wake card named: the check says why" "busy: no-wake-card" "$(BOXD_WIRED= BOXD_WIFI= check)"
BOXD_WIRED= BOXD_WIFI= check >/dev/null; BOXD_WIRED= BOXD_WIFI= check >/dev/null; BOXD_WIRED= BOXD_WIFI= check >/dev/null
eq "checks without a card never arm and never suspend" "" "$(calls)"
rm -rf "$T/state"; : > "$T/calls"
check >/dev/null; check >/dev/null; BOXD_WIFI= check >/dev/null
eq "only the cable named: arms the cable alone" "ethtool -s wired0 wol g|zzz -z" "$(calls)"
rm -rf "$T/state"
quiet; eq "status quiet" quiet "$(sh "$IDLE" status)"
echo "0.90 0.20 0.10 2/200 999" > "$T/loadavg"; eq "status names the busy reason" load "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:22 10.0.0.9:51000" > "$T/ss.out"; eq "status names ssh" ssh "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:2222 10.0.0.9:51000" > "$T/ss.out"; eq "a build session on the build port is busy too" ssh "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:8080 10.0.0.9:51000" > "$T/ss.out"; eq "another port is not an ssh session" quiet "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:22 10.0.0.9:51000" > "$T/ss.out"; eq "status --ignore-ssh leaves ssh out" quiet "$(sh "$IDLE" status --ignore-ssh)"
quiet; sh "$KEEP" sh -c "echo held >&3; read x < '$T/release'" & holder=$!; read -r _ <&3
eq "status names keepawake" keepawake "$(sh "$IDLE" status)"
echo go > "$T/release"; wait "$holder"
eq "status changed no state" no "$([ -e "$T/state" ] && echo yes || echo no)"

# 7. BOXD_IDLE_IGNORE names addresses whose connections on the build port are not work (the dashboard's reads), so a poll
#    can never keep the host awake (docs/designs/dashboard.md).
export BOXD_IDLE_IGNORE="10.0.0.7 10.0.0.9"
quiet; echo "ESTAB 0 0 10.0.0.2:2222 10.0.0.9:51000" > "$T/ss.out"; eq "a build-port connection from an ignored address is not work" quiet "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:2222 10.0.0.90:51000" > "$T/ss.out"; eq "an address that only begins like an ignored one is work" ssh "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:22 10.0.0.9:51000" > "$T/ss.out"; eq "the administrator port counts from every address" ssh "$(sh "$IDLE" status)"
quiet; printf 'ESTAB 0 0 10.0.0.2:2222 10.0.0.9:51000\nESTAB 0 0 10.0.0.2:2222 10.0.0.8:51000\n' > "$T/ss.out"; eq "an ignored connection does not hide a real one" ssh "$(sh "$IDLE" status)"
quiet; echo "0 0 10.0.0.2:2222 10.0.0.7:51000" > "$T/ss.out"; eq "ss without a state column: the ignored address is not work" quiet "$(sh "$IDLE" status)"
quiet; echo "0 0 10.0.0.2:2222 10.0.0.6:51000" > "$T/ss.out"; eq "ss without a state column: another address is work" ssh "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 [::ffff:10.0.0.9]:2222 [::ffff:10.0.0.7]:51000" > "$T/ss.out"; eq "an address in its mapped form is the same address" quiet "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 [::ffff:10.0.0.9]:2222 [::ffff:10.0.0.6]:51000" > "$T/ss.out"; eq "a mapped address that is not listed is work" ssh "$(sh "$IDLE" status)"
quiet; echo "ESTAB 0 0 10.0.0.2:2222 10.0.0.9:51000" > "$T/ss.out"; eq "check: an ignored poll does not reset the quiet count" "idle, sleeping after 3 quiet checks" "$(rm -rf "$T/state"; check)"
unset BOXD_IDLE_IGNORE
quiet; echo "ESTAB 0 0 10.0.0.2:2222 10.0.0.9:51000" > "$T/ss.out"; eq "no ignore list: every build-port connection is work" ssh "$(sh "$IDLE" status)"

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
