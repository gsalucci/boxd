#!/usr/bin/env bash
# Acceptance test for the build area, run ON the host as root (it resets the real work area, BOXD_WORK):
#   scp -r tests <host>: && ssh -t <host> sudo bash tests/work-acceptance.sh
# Optional: BOXD_TEST_ALLOW_WRITE, an extended regular expression of world-writable paths a shared desktop host is known to have (check 1 skips them).
# What done means:
#   1. the build account can write to the disk only under the work area (everything else it can write is memory-only)
#   2. boxd-reset gives back a clean the work area: jobs and home contents gone, skeleton back, caches kept
#   3. boxd-reset all also empties the caches
#   4. it refuses while build holds boxd-keepawake, and --force stops the holder and resets; boxes are removed
#   3b. reset all works while another mount namespace holds copies of the work area (private mounts)
#   5. subvolumes the build account made inside the work area (nested, names with spaces) do not block the reset
#   0. (first) podman works rootless: root inside, plain build outside, images under $W/cache
# No step waits on a clock: each one checks state after a command has returned.
set -u
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
# Settings come from the host's own file, like the programs under test.
[ ! -r /etc/boxd/boxd.conf ] || . /etc/boxd/boxd.conf
U=${BOXD_USER:-boxd}
W=${BOXD_WORK:-/var/lib/boxd/work}
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
as_build() { runuser -l "$U" -c "W=$W; U=$U; $1"; }   # a login like ssh: home folder, ~/.bashrc and its environment

# 0. podman: root inside a container (any package installs), the plain build account outside, images in
#    $W/cache. Runs first so the write check below also covers whatever podman created.
before_pids=$(ps -u "$U" -o pid= | tr -d " " | sort)
got=$(as_build 'podman run --rm docker.io/library/alpine:3 sh -c "apk add -q --no-cache jq && id -u && jq -n 1"' 2>&1 | tail -2 | paste -sd' ')
eq "podman: root inside the container, a package installs and runs" "0 1" "$got"
eq "podman prints no mount warning" "" "$(as_build 'podman run --rm docker.io/library/alpine:3 true' 2>&1)"
eq "podman keeps images under $W/cache" "$W/cache/" "$(as_build 'podman info --format "{{.Store.GraphRoot}}"' | cut -c1-$((${#W} + 7)))"
# Only processes this container left behind count: boxes from other runs have their own helpers (fuse-overlayfs).
left=$(comm -13 <(printf "%s\n" "$before_pids") <(ps -u "$U" -o pid= | tr -d " " | sort) | while read -r p; do ps -o comm= -p "$p"; done | grep -vx -e 'podman pause' -e catatonit)
eq "only the pause process is left after the container exits" "" "$left"

# 1. every place the build account can write is under the work area or on a memory-only file system
PSEUDO='^(tmpfs|devtmpfs|proc|sysfs|devpts|cgroup2|mqueue|securityfs|pstore|efivarfs|debugfs|tracefs|bpf|configfs|fusectl|hugetlbfs|autofs|binfmt_misc)$'
leaks=$(as_build 'find / \( -path /proc -o -path /sys \) -prune -o -writable -print 2>/dev/null' | while IFS= read -r p; do
    case "$p" in "$W"|"$W"/*) continue ;; esac
    [ -z "${BOXD_TEST_ALLOW_WRITE:-}" ] || ! [[ "$p" =~ $BOXD_TEST_ALLOW_WRITE ]] || continue   # a desktop host: world-writable folders the owner knows about
    fs=$(findmnt -n -o FSTYPE --target "$p" 2>/dev/null)
    [[ "$fs" =~ $PSEUDO ]] || [ -c "$p" ] || echo "$p ($fs)"
done | head -20)
eq "build can write to disk only under the work area" "" "$leaks"
eq "build has no sudo" "no" "$(runuser -u "$U" -- sudo -n true >/dev/null 2>&1 && echo yes || echo no)"
eq "build cannot change its own ssh keys" "no" "$(as_build 'test -w /etc/ssh/authorized_keys/$U && echo yes || echo no')"
eq "build home is in the work area" "$W/home" "$(getent passwd "$U" | cut -d: -f6)"
eq "build caches point into $W/cache" "$W/cache/cargo $W/tmp" "$(as_build 'echo $CARGO_HOME $TMPDIR')"

# 2. plain reset: jobs and home contents gone, skeleton back, caches kept
as_build 'mkdir -p $W/jobs/repo && head -c 50M /dev/urandom > $W/jobs/repo/big && echo junk > ~/junk && mkdir -p $W/cache/cargo && echo keep > $W/cache/cargo/marker'
boxd-reset >/dev/null
eq "jobs emptied (only the clean copy's runs folder)" "runs" "$(ls -A $W/jobs)"
eq "home junk gone" "no" "$(test -e $W/home/junk && echo yes || echo no)"
eq "home skeleton back" "yes" "$(test -f $W/home/.bashrc && echo yes || echo no)"
eq "cache kept across a plain reset" "keep" "$(cat $W/cache/cargo/marker 2>/dev/null)"
eq "build can write in jobs after the reset" "ok" "$(as_build 'touch $W/jobs/t && echo ok')"

# 3. reset all empties the caches too
boxd-reset all >/dev/null
eq "cache emptied by reset all" "" "$(ls -A $W/cache)"
eq "build can write in the cache after reset all" "ok" "$(as_build 'mkdir -p $W/cache/x && echo ok')"

# 3b. a mount namespace of someone else (any user's rootless podman does this) holds copies of the work area while
#     reset all runs: the work area is private, so the copies are not peers and cannot block the unmount.
eq "the work area and its cache are private mounts" "" "$(grep -E " $W( |/cache )" /proc/self/mountinfo | grep -o 'shared:[0-9]*')"
rm -f /run/wa-ns.fifo; mkfifo /run/wa-ns.fifo; exec 8<>/run/wa-ns.fifo
unshare --mount --propagation unchanged sh -c 'read x' </run/wa-ns.fifo >/dev/null 2>&1 &
holder=$!
until [ "$(readlink /proc/$holder/ns/mnt 2>/dev/null)" != "$(readlink /proc/1/ns/mnt)" ]; do :; done
boxd-reset all >/dev/null 2>&1; rc=$?
eq "reset all succeeds while a foreign mount namespace holds copies of the work area" 0 "$rc"
eq "and stays private after its remount" "" "$(grep -E " $W( |/cache )" /proc/self/mountinfo | grep -o 'shared:[0-9]*')"
echo go >&8; wait "$holder"; exec 8>&-; rm -f /run/wa-ns.fifo

# 4. refuse while build holds boxd-keepawake (the lock boxd-idle watches; it exists while the service runs);
#    --force stops the holder. The holder blocks on a fifo, so no clock is involved.
mkfifo /run/work-acceptance.fifo; chmod 666 /run/work-acceptance.fifo
as_build 'cd $W/jobs && exec boxd-keepawake sh -c "exec 3<>/run/work-acceptance.fifo; read x <&3"' &
disown   # no "Killed" line when --force ends it
until ! flock -n -x /run/boxd-keepawake.lock true; do :; done   # the holder has the lock
boxd-reset >/dev/null 2>&1; rc=$?
eq "reset refuses while build holds boxd-keepawake" 1 "$rc"
boxd-reset --force >/dev/null; rc=$?
eq "reset --force stops the holder and resets" "0 none" "$rc $(pgrep -u "$U" >/dev/null && echo some || echo none)"
rm -f /run/work-acceptance.fifo
as_build 'podman run -d --name acceptance-box docker.io/library/alpine:3 sleep infinity >/dev/null'
boxd-reset >/dev/null; rc=$?
eq "reset removes boxes, nothing left of them" "0 " "$rc $(as_build 'podman ps -aq')"

# 5. a nested subvolume made by the build account does not block the reset
as_build 'btrfs subvolume create "$W/jobs/nested one" >/dev/null && btrfs subvolume create "$W/jobs/nested one/inner" >/dev/null && echo x > "$W/jobs/nested one/inner/f"'
eq "build could make two nested subvolumes (the case under test)" "yes" "$(test -f "$W/jobs/nested one/inner/f" && echo yes || echo no)"
boxd-reset >/dev/null 2>/run/wa-reset.err; rc=$?
eq "reset with nested subvolumes" "0 no" "$rc $(test -e "$W/jobs/nested one" && echo yes || echo no)"
# On success only the busy note (evidence for the kernel-release wait), on failure everything the reset said.
if [ "$rc" = 0 ]; then grep "was busy" /run/wa-reset.err; else cat /run/wa-reset.err; fi | sed "s/^/    reset said: /"; rm -f /run/wa-reset.err

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
