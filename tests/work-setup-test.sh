#!/usr/bin/env bash
# The disk budget step of server/work-setup (function disk_budget): on a work area that shares its disk with the system the
# cleanup levels are written to the settings file once; on a disk of its own, or with levels already set, nothing is. The
# function is cut out of the script and run against a fake df; no setup runs, nothing outside the scratch folder changes.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
fails=0
eq() { if [ "$2" = "$3" ]; then echo "ok $1"; else echo "FAIL $1: expected [$2] got [$3]"; fails=$((fails + 1)); fi; }
cat > "$T/bin/df" <<'FAKE'
#!/bin/sh
case "$*" in *output=source*) printf 'Filesystem\n'; case "$*" in *" /") echo /dev/fake1 ;; *) echo "$FAKE_SRC" ;; esac ;; *) printf 'Use%% 1K-blocks\n%s%% 1000341504\n' "$FAKE_PCT" ;; esac
FAKE
chmod +x "$T/bin/"*
sed -n '/^# begin disk budget/,/^# end disk budget/p' server/work-setup > "$T/fn.sh"
run() { # <settings file content or -> <used percent> [block device of the work area]
  if [ "$1" = - ]; then rm -f "$T/conf"; else printf '%s\n' "$1" > "$T/conf"; fi
  PATH="$T/bin:$PATH" FAKE_PCT=$2 FAKE_SRC=${3:-/dev/fake1} CONF=$T/conf WORK=$T/work sh -c '. "$1"; disk_budget' _ "$T/fn.sh"
}
levels() { grep -E '^BOXD_' "$T/conf" 2>/dev/null | paste -sd' '; }

out=$(run '#BOXD_EVICT_AT=70' 20)
eq "a shared disk 20 percent full: levels 40, 30 and 3 days" "BOXD_EVICT_AT=40 BOXD_EVICT_TO=30 BOXD_KEEP_DAYS=3" "$(levels)"
eq "it says what was written and what it means in gigabytes" "boxd-setup: the work area shares its disk with the system: idle box folders are removed from 40 percent of the disk (about 381 GB) down to 30; change BOXD_EVICT_AT and BOXD_EVICT_TO in $T/conf" "$out"
eq "the written block has a two line comment" 2 "$(grep -c '^# ' "$T/conf")"
before=$(cat "$T/conf"); out=$(PATH="$T/bin:$PATH" FAKE_PCT=20 FAKE_SRC=/dev/fake1 CONF=$T/conf WORK=$T/work sh -c '. "$1"; disk_budget' _ "$T/fn.sh")
eq "a second run changes nothing and prints nothing" "$before|" "$(cat "$T/conf")|$out"
run - 20 >/dev/null; eq "a settings file that does not exist yet is made" "BOXD_EVICT_AT=40 BOXD_EVICT_TO=30 BOXD_KEEP_DAYS=3" "$(levels)"
run - 21 >/dev/null; eq "the level is rounded up to the next five (21 + 20 = 41 gives 45)" "BOXD_EVICT_AT=45 BOXD_EVICT_TO=35 BOXD_KEEP_DAYS=3" "$(levels)"
run - 25 >/dev/null; eq "a multiple of five stays (25 + 20 = 45)" "BOXD_EVICT_AT=45 BOXD_EVICT_TO=35 BOXD_KEEP_DAYS=3" "$(levels)"
run - 60 >/dev/null; eq "never above 70" "BOXD_EVICT_AT=70 BOXD_EVICT_TO=60 BOXD_KEEP_DAYS=3" "$(levels)"
out=$(run - 20 /dev/fake2); eq "a work area on a disk of its own gets nothing written" "|" "$(levels)|$out"
for v in BOXD_EVICT_AT=80 BOXD_EVICT_TO=50 BOXD_KEEP_DAYS=9 'export BOXD_KEEP_DAYS=9'; do
  out=$(run "$v" 20); eq "a settings file that sets $v is left alone" "$v|" "$(cat "$T/conf")|$out"
done
[ "$fails" = 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
