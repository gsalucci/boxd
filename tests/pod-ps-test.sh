#!/usr/bin/env bash
# The process report of `pod ps` (PS_SCRIPT in server/boxd-pod) run against this machine's real /proc, as it runs
# inside a box: known processes appear with their working folder, command and age; the script and its helpers do
# not; the oldest comes first. A command name with ") " in it does not shift the fields.
# No step waits on a clock: each one checks state after the process exists.
set -u
cd "$(dirname "$0")/.."
eval "$(sed -n '/^PS_SCRIPT=/,/sort -t/p' server/boxd-pod)"
[ -n "${PS_SCRIPT:-}" ] || { echo "FAIL PS_SCRIPT not found in server/boxd-pod"; exit 1; }
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }

T=$(mktemp -d "${TMPDIR:-/tmp}/pod-ps-test.XXXXXX")
pids=()
trap 'kill "${pids[@]}" 2>/dev/null; pkill -f "^sleep 99993$"; rm -rf "$T"' EXIT   # 99993 is the child of a sh -c
mkdir -p "$T/work dir" "$T/bin"
# A program whose command name (comm in /proc/<pid>/stat) holds ") ": a copy of bash that blocks opening a pipe nobody
# writes to. Not a link to sleep: where sleep is one binary for many tools (Ubuntu 26.04), an unknown name ends at once.
cp "$(command -v bash)" "$T/bin/odd) name"; mkfifo "$T/pipe"; odd=(-c 'read x <"$0"' "$T/pipe")

start() {   # start <folder> <program> <args...>: runs it in <folder>, waits until it is there, prints its pid
    local d=$1; shift
    (cd "$d" && exec "$@") >/dev/null 2>&1 &   # not our stdout: $(start ...) would wait for it to close
    local p=$!
    until [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$d" ] && [ "$(tr '\0' ' ' <"/proc/$p/cmdline")" = "$* " ]; do
        kill -0 "$p" 2>/dev/null || { echo "FAIL $* ended before it was seen" >&2; return 1; }   # never wait for a process that is gone
    done
    echo "$p"
}
a=$(start "$T/work dir" sleep 99991) || exit 1; pids+=("$a")
b=$(start "$T" "$T/bin/odd) name" "${odd[@]}") || exit 1; pids+=("$b")
c=$(start "$T" sh -c "$(printf 'sleep 99993\n\ttrue')") || exit 1; pids+=("$c")   # newline and tab in its command

out=$(sh -c "$PS_SCRIPT")
line() { grep -P "^$1\t" <<<"$out"; }
eq "a known process: pid, working folder with a space, command" "$a|$T/work dir|sleep 99991" \
    "$(line "$a" | awk -F'\t' '{print $1 "|" $4 "|" $5}')"
eq "a command name with ') ' keeps the fields in place" "$b|$T|$T/bin/odd) name ${odd[*]}|0" \
    "$(line "$b" | awk -F'\t' '{print $1 "|" $4 "|" $5 "|" $3}')"
up=$(cut -d. -f1 /proc/uptime)
eq "elapsed is whole seconds within the uptime" yes \
    "$(line "$a" | awk -F'\t' -v up="$up" '{print ($2 ~ /^[0-9]+$/ && $2 <= up) ? "yes" : "no"}')"
eq "newlines and tabs in a command become spaces" "sh -c sleep 99993  true" "$(line "$c" | cut -f5)"
eq "nothing on standard error (processes ending mid-scan are skipped quietly)" "" "$(sh -c "$PS_SCRIPT" 2>&1 >/dev/null)"
eq "the report leaves itself out" 0 "$(grep -c 'read -r up' <<<"$out")"
eq "five tab separated fields on every line" "" "$(awk -F'\t' 'NF != 5' <<<"$out" | head -3)"
eq "oldest first (elapsed never grows down the list)" "" "$(awk -F'\t' 'NR > 1 && $2 > prev {print NR ": " $2 " after " prev} {prev = $2}' <<<"$out" | head -3)"

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
