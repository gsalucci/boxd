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

# The image archive folder (function images_subvolume): cut out of the script and run with fake btrfs, mount, mountpoint, cp
# and pgrep on a scratch folder. The fake mount puts the subvolume's content on the folder and remembers the mount point.
REALCP=$(command -v cp)
cat > "$T/bin/btrfs" <<'FAKE'
#!/bin/sh
[ "$1 $2" = "subvolume create" ] && mkdir "$3"
FAKE
cat > "$T/bin/mountpoint" <<'FAKE'
#!/bin/sh
grep -qxF "$2" "$MOUNTS" 2>/dev/null
FAKE
cat > "$T/bin/mount" <<'FAKE'
#!/bin/sh
echo "$1" >> "$MOUNTS"; $REALCP -a "$TOP/@boxd-images/." "$1/"
FAKE
cat > "$T/bin/cp" <<'FAKE'
#!/bin/sh
for a; do shift; [ "$a" = --reflink=always ] || set -- "$@" "$a"; done
$REALCP "$@" || exit 1
# FAKE_SKEW: the copy comes out with another modification time
[ -z "${FAKE_SKEW:-}" ] || touch -d @1 "$TOP/@boxd-images/a.tar"
FAKE
cat > "$T/bin/pgrep" <<'FAKE'
#!/bin/sh
[ -n "${FAKE_BUILD:-}" ]
FAKE
chmod +x "$T/bin/"*
{ sed -n '/^# begin images subvolume/,/^# end images subvolume/p' server/work-setup
  grep -m1 'fstab_line()' server/work-setup | sed "s|/etc/fstab|$T/fstab|g"; } > "$T/img.sh"
img() { PATH="$T/bin:$PATH" REALCP=$REALCP TOP=$T/top IMAGES=$T/images uuid=U1 OPT=o MOUNTS=$T/mounts sh -c '. "$1"; images_subvolume' _ "$T/img.sh"; }
fresh() { rm -rf "$T/top" "$T/images" "$T/images.moved" "$T/mounts" "$T/fstab"; mkdir "$T/top" "$T/images"; : > "$T/fstab"
  echo data > "$T/images/a.tar"; touch -d @1700000000 "$T/images/a.tar"; }
stamp() { stat -c '%s %Y' "$1"; }
lines() { [ -e "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }
has() { [ -e "$1" ] && echo yes || echo no; }

fresh; out=$(img); rc=$?
eq "a folder with a file: the file is in the subvolume with the same size and time" "0 5 1700000000" "$rc $(stamp "$T/top/@boxd-images/a.tar")"
eq "the folder is mounted with the file, the old folder is gone" "5 1700000000 no" "$(stamp "$T/images/a.tar") $(has "$T/images.moved")"
eq "one fstab line, with the subvolume" "UUID=U1 $T/images btrfs o,subvol=@boxd-images 0 2" "$(cat "$T/fstab")"
eq "one line printed" "image archives: $T/images is now the subvolume @boxd-images (snapshots of the system no longer keep a copy)" "$out"
out=$(img); eq "a second run prints nothing and changes nothing" "|1|1" "$out|$(lines "$T/fstab")|$(lines "$T/mounts")"
fresh; echo "$T/images" > "$T/mounts"; out=$(img); eq "a folder that is a mount point is left alone" "|no|0|1" "$out|$(has "$T/top/@boxd-images")|$(lines "$T/fstab")|$(lines "$T/mounts")"
fresh; rm -r "$T/images"; out=$(img); eq "a missing folder is made as the mounted subvolume" "image archives: $T/images is the new subvolume @boxd-images|1|yes" "$out|$(lines "$T/fstab")|$(has "$T/images")"
fresh; out=$(FAKE_SKEW=1 img 2>&1); rc=$?
eq "a difference between the listings stops it: old folder kept, no fstab line, no mount" "1 1700000000 0 0 no" "$rc $(stamp "$T/images/a.tar" | cut -d' ' -f2) $(lines "$T/fstab") $(lines "$T/mounts") $(has "$T/images.moved")"
eq "and says so" "work-setup: the copy of $T/images differs from the original: nothing was changed" "$out"
fresh; out=$(FAKE_BUILD=1 img); eq "a running image build skips the move with one line" "work-setup: an image build is running: the image folder $T/images stays where it is until the next setup|no|0" "$out|$(has "$T/top/@boxd-images")|$(lines "$T/fstab")"
[ "$fails" = 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
