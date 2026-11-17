#!/usr/bin/env bash
# Builds the Debian packages and checks them, inside a Debian 13 container as root. Rerun from the repository's top folder:
#
#   tower --image docker.io/library/debian:trixie-slim -- bash tests/deb-package-test.sh
#   tower --pull deb-out --image docker.io/library/debian:trixie-slim -- bash tests/deb-package-test.sh   # also copies the .deb files back
#
# (any boxd build server works in place of `tower`; a plain Debian 13 machine works too, as root, but it installs the
# packages and their dependencies there). The script needs network for apt and for the pinned microsandbox release.
#   1. tools/build-deb builds all four packages from this checkout; a second build, and a build from a tag archive, give byte-identical files
#   2. lintian finds no error (the warnings that remain are listed; none is hidden)
#   3. control data: names, versions, architectures, conffiles, dependencies on podman, openssh-server, rsync, uidmap
#   4. apt installs the local files and resolves the dependencies (podman 5.4 on Debian 13)
#   5. every installed path is a row of the Debian table of docs/designs/layout.md, with its mode and owner root:root,
#      every row is installed, and every installed program is byte for byte the repository file (boxd.conf: plus one line)
#   6. systemd-analyze verify accepts both units
#   7. boxctl check as far as it can go without a running systemd; work-setup and boxd-reset in directory mode (no btrfs)
#   8. the repository's pod contract suite runs against the installed /usr/bin/boxd-pod
#   9. every podman option boxd-pod uses is known to the installed podman (5.4 on Debian 13)
#  10. dpkg --purge removes what lives outside the data and leaves the build account and the work area
# Prints "ALL OK" and exits 0 only when every check passed.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
[ "$(id -u)" = 0 ] && [ -r /etc/debian_version ] || { echo "run as root on Debian, see the header" >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
OUT=${BOXD_DEB_OUT:-$HERE/deb-out}
export BOXD_DEB_OUT=$OUT
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(date +%s)}   # one value for both builds: a box has no git history to take it from
# Container images tell dpkg to skip /usr/share/doc; the packages ship documents, so this container must keep them.
rm -f /etc/dpkg/dpkg.cfg.d/docker /etc/dpkg/dpkg.cfg.d/excludes /etc/dpkg/dpkg.cfg.d/docker-excludes
rm -rf "$OUT"
LOG=$(mktemp -d)
trap 'rm -rf "$LOG"' EXIT

apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates lintian dpkg-dev systemd jq rsync git procps bash file >/dev/null 2>"$LOG/apt-tools.err" ||
    { echo "FAIL apt could not install the test tools"; cat "$LOG/apt-tools.err"; exit 1; }

# A rerun in the same box starts from nothing: packages purged, the account and the work area removed.
dpkg --purge boxd boxd-server boxd-client microsandbox-bin >/dev/null 2>&1
id boxd >/dev/null 2>&1 && userdel boxd 2>/dev/null; getent group boxd >/dev/null && groupdel boxd 2>/dev/null
rm -rf /var/lib/boxd /var/lib/boxd-work /etc/boxd /etc/ssh/authorized_keys /etc/profile.d/boxd-env.sh /etc/ssh/sshd_config.d/20-boxd.conf

# 1. build
tools/build-deb >"$LOG/build.out" 2>&1; eq "build-deb exits 0" 0 "$?"
cat "$LOG/build.out"
ver=$(sed -n 's/^version=//p' srcpkgs/boxd/template); msb=$(sed -n 's/^version=//p' srcpkgs/microsandbox-bin/template)
deb_boxd=$OUT/boxd_$ver-1_all.deb; deb_server=$OUT/boxd-server_$ver-1_all.deb; deb_client=$OUT/boxd-client_$ver-1_all.deb
deb_msb=$OUT/microsandbox-bin_$msb-1_amd64.deb
for d in "$deb_boxd" "$deb_server" "$deb_client" "$deb_msb"; do eq "built $(basename "$d")" yes "$([ -s "$d" ] && echo yes || echo no)"; done
[ "$fails" -eq 0 ] || { echo "FAIL the build failed, nothing to check"; exit 1; }
mkdir "$LOG/second"; BOXD_DEB_OUT=$LOG/second BOXD_MSB_TARBALL= tools/build-deb boxd boxd-server boxd-client >/dev/null 2>&1
eq "a second build of the three boxd packages is byte identical" "$(cd "$OUT" && sha256sum boxd_*.deb boxd-server_*.deb boxd-client_*.deb)" "$(cd "$LOG/second" && sha256sum boxd_*.deb boxd-server_*.deb boxd-client_*.deb)"

# the same packages from a tag archive (top folder boxd-<version>/, as `git archive --prefix` makes it) instead of the checkout
mkdir "$LOG/archive-out" "$LOG/tree"; ln -s "$HERE" "$LOG/tree/boxd-$ver"
tar -chzf "$LOG/boxd-$ver.tar.gz" -C "$LOG/tree" --exclude=deb-out --exclude=.git --exclude=node_modules --exclude=.claude "boxd-$ver"
BOXD_DEB_OUT=$LOG/archive-out BOXD_SOURCE_ARCHIVE=$LOG/boxd-$ver.tar.gz tools/build-deb boxd boxd-server boxd-client >/dev/null 2>&1
eq "a build from a tag archive is byte identical to the build from the checkout" "$(cd "$OUT" && sha256sum boxd_*.deb boxd-server_*.deb boxd-client_*.deb)" "$(cd "$LOG/archive-out" && sha256sum boxd_*.deb boxd-server_*.deb boxd-client_*.deb)"

# 2. lintian: errors fail, warnings are listed
lintian --no-cfg --fail-on error "$OUT"/*.deb >"$LOG/lintian.out" 2>&1; eq "lintian: no error" 0 "$?"
echo "--- lintian output (warnings and below, none hidden) ---"; cat "$LOG/lintian.out"; echo "--- end lintian ---"

# 3. control data
field() { dpkg-deb -f "$1" "$2"; }
eq "boxd-server version" "$ver-1" "$(field "$deb_server" Version)"
eq "microsandbox-bin version is the pinned release" "$msb-1" "$(field "$deb_msb" Version)"
eq "microsandbox-bin architecture" amd64 "$(field "$deb_msb" Architecture)"
eq "boxd-server architecture" all "$(field "$deb_server" Architecture)"
dep=$(field "$deb_server" Depends)
for want in podman openssh-server rsync uidmap catatonit git systemd; do
    eq "boxd-server depends on $want" 1 "$(printf '%s' "$dep" | tr ',' '\n' | sed 's/^ *//; s/ .*//' | grep -cx "$want")"
done
eq "boxd-server recommends microsandbox-bin" 1 "$(field "$deb_server" Recommends | tr ',' '\n' | sed 's/^ *//' | grep -cx microsandbox-bin)"
for want in nodejs rsync openssh-client git; do
    eq "boxd-client depends on $want" 1 "$(field "$deb_client" Depends | tr ',' '\n' | sed 's/^ *//; s/ .*//' | grep -cx "$want")"
done
eq "boxd-server conffiles" "/etc/boxd/boxd.conf /etc/boxd/containers.conf /etc/boxd/sshd_config /etc/boxd/storage.conf" \
   "$(dpkg-deb -I "$deb_server" conffiles | sort | paste -sd' ')"
for s in postinst prerm postrm; do eq "boxd-server has $s" yes "$(dpkg-deb -I "$deb_server" "$s" >/dev/null 2>&1 && echo yes || echo no)"; done

# 4. install with apt, from the local files
apt-get install -y -qq "$deb_boxd" "$deb_server" "$deb_client" "$deb_msb" >"$LOG/install.out" 2>&1; eq "apt installs the four local packages" 0 "$?"
tail -3 "$LOG/install.out"
for p in boxd boxd-server boxd-client microsandbox-bin; do eq "dpkg reports $p installed" "install ok installed" "$(dpkg-query -W -f='${Status}' "$p")"; done
echo "podman: $(podman --version 2>&1)"
eq "podman is 5.0 or newer" yes "$(podman --version | awk '{ split($3, v, "."); print (v[1] >= 5) ? "yes" : "no" }')"
eq "catatonit (podman --init) is installed" yes "$(command -v catatonit >/dev/null && echo yes || echo no)"
eq "uidmap programs are installed" yes "$([ -u /usr/bin/newuidmap ] && echo yes || echo no)"

# 5. installed files against the Debian table of layout.md
rows=$LOG/rows
awk -F'|' '/^## Debian packages/ { on = 1; next } /^## / { on = 0 } on && NF == 7 && $2 !~ /Package|---/ { for (i = 2; i <= 5; i++) gsub(/^ +| +$/, "", $i); print $2 "\t" $3 "\t" $4 "\t" $5 }' docs/designs/layout.md | sed "s|@MSB_VERSION@|$msb|g" > "$rows"
eq "the table has rows" yes "$([ "$(wc -l < "$rows")" -gt 30 ] && echo yes || echo no)"
while IFS=$'\t' read -r pkg path source mode; do
    case $path in
        *\**) n=$(ls -d $path 2>/dev/null | wc -l); eq "installed: $path (at least one)" yes "$([ "$n" -ge 1 ] && echo yes || echo no)"; continue ;;
    esac
    case $source in
        link:*) eq "link: $path -> ${source#link:}" "${source#link:}" "$(readlink "$path")"; continue ;;
        dir) eq "folder: $path" "755 root root" "$(stat -c '%a %U %G' "$path")"; continue ;;
        */) eq "tree: $path exists" yes "$([ -d "$path" ] && echo yes || echo no)"
            bad=$(cd "$source" && find . -type f | while read -r f; do cmp -s "$f" "$path/$f" || echo "$f"; done)
            eq "tree: $path equals $source" "" "$bad"
            eq "tree: $path owned by root" "" "$(find "$path" ! -user root -o ! -group root | head -3)"; continue ;;
    esac
    eq "installed: $path (mode $mode, root:root)" "$mode root root" "$(stat -c '%a %U %G' "$path")"
    case $source in
        generated:*|download:*) ;;
        server/boxd.conf) eq "$path is the repository file plus the enabled BOXD_CGROUP line" "1c1" \
              "$(diff <(sed 's|^#BOXD_CGROUP=.*|BOXD_CGROUP=/sys/fs/cgroup/boxd.slice/boxd-sshd.service|' "$source") "$path" >/dev/null && echo 1c1)" ;;
        *) eq "$path is byte for byte $source" yes "$(cmp -s "$source" "$path" && echo yes || echo no)" ;;
    esac
done < "$rows"
eq "the enabled line is the only difference of boxd.conf" "BOXD_CGROUP=/sys/fs/cgroup/boxd.slice/boxd-sshd.service" "$(diff server/boxd.conf /etc/boxd/boxd.conf | sed -n 's/^> //p')"
# nothing installed that the table does not list (folders excluded)
for pkg in boxd boxd-server boxd-client microsandbox-bin; do
    extra=$(dpkg -L "$pkg" | while read -r f; do
        [ -d "$f" ] && [ ! -L "$f" ] && continue
        awk -F'\t' -v p="$pkg" -v f="$f" '$1 == p { path = $2; if (path == f) found = 1; else if (path ~ /\*/ && system("case \"" f "\" in " path ") exit 0;; *) exit 1;; esac") == 0) found = 1; else if (substr(path, length(path)) == "/" ) {} } END { exit !found }' "$rows" ||
            case $f in /usr/share/boxd/images/toolbox/*) ;; *) echo "$f" ;; esac
    done)
    eq "$pkg installs nothing outside the table" "" "$extra"
done
eq "boxd.conf (conffile) is listed in the dpkg status as a conffile" 1 "$(dpkg-query -W -f='${Conffiles}\n' boxd-server | grep -c ' /etc/boxd/boxd.conf ')"
eq "msb runs from its release folder through the link" yes "$(/usr/bin/msb --version >/dev/null 2>&1 && echo yes || echo no)"
echo "node: $(node --version 2>&1)"
box --help >"$LOG/box-help.out" 2>&1; eq "the installed box command runs on Debian's nodejs (box --help)" 0 "$?"
eq "box --help names its usage" 1 "$(grep -c '^usage: box' "$LOG/box-help.out")"

# 6. systemd units
for u in boxd.service boxd-sshd.service; do
    out=$(systemd-analyze verify "/usr/lib/systemd/system/$u" 2>&1); rc=$?
    eq "systemd-analyze verify $u: exit 0" 0 "$rc"
    eq "systemd-analyze verify $u: no complaint about the unit" "" "$(printf '%s\n' "$out" | grep -i "$u" | grep -v 'Failed to connect to bus' | head -3)"
done

# 7. boxctl, work-setup and boxd-reset without a running systemd and without btrfs
export BOXD_MANAGER=systemd
out=$(boxctl check 2>&1); rc=$?
eq "boxctl check fails here (no account, no work area, no running systemd)" 1 "$rc"
eq "boxctl check names the missing account" 1 "$(printf '%s\n' "$out" | grep -c 'account boxd does not exist')"
eq "boxctl check names the missing work area" 1 "$(printf '%s\n' "$out" | grep -c 'work area /var/lib/boxd/work is not mounted')"
boxctl bogus 2>/dev/null; eq "boxctl with an unknown word is a usage error" 2 "$?"
echo 'ssh-ed25519 AAAATESTKEY test@example' > "$LOG/key.pub"
BOXD_WORK_FS=dir BOXD_BUILD_KEY="$(cat "$LOG/key.pub")" sh /usr/libexec/boxd/work-setup >"$LOG/ws.out" 2>&1; eq "work-setup in directory mode exits 0" 0 "$?"
tail -3 "$LOG/ws.out"
eq "work-setup made the build account" yes "$(id boxd >/dev/null 2>&1 && echo yes || echo no)"
eq "work area marker" yes "$([ -e /var/lib/boxd/work/.boxd-dir-mode ] && echo yes || echo no)"
eq "work area folders" "cache home jobs tmp" "$(cd /var/lib/boxd/work && ls | sort | paste -sd' ')"
eq "the build account owns jobs and cache" "boxd boxd" "$(stat -c '%U' /var/lib/boxd/work/jobs /var/lib/boxd/work/cache | paste -sd' ')"
eq "its ssh key is kept outside the work area" "ssh-ed25519 AAAATESTKEY test@example" "$(cat /etc/ssh/authorized_keys/boxd)"
eq "podman settings are linked as drop-ins, /etc/containers/storage.conf is untouched" "yes yes" \
   "$([ -L /etc/containers/containers.conf.d/boxd.conf ] && echo yes || echo no) $([ -L /etc/containers/storage.conf.d/boxd.conf ] && [ ! -L /etc/containers/storage.conf ] && echo yes || echo no)"
eq "boxctl check now finds the account and the work area" 0 "$(boxctl check 2>&1 | grep -c 'account boxd does not exist\|work area')"
BOXD_WORK_FS=dir sh /usr/libexec/boxd/work-setup >/dev/null 2>&1; eq "work-setup is rerunnable without a key (the key file stays)" 0 "$?"
# dirty the area and the cache, reset
echo junk > /var/lib/boxd/work/jobs/leftover; mkdir -p /var/lib/boxd/work/home/x && echo c > /var/lib/boxd/work/cache/kept
chown -R boxd:boxd /var/lib/boxd/work/jobs /var/lib/boxd/work/cache
boxd-reset work --force >"$LOG/reset.out" 2>&1; eq "boxd-reset work (directory mode) exits 0" 0 "$?"
tail -2 "$LOG/reset.out"
eq "reset work: the leftover is gone, the cache stays" "no yes" "$([ -e /var/lib/boxd/work/jobs/leftover ] && echo yes || echo no) $([ -e /var/lib/boxd/work/cache/kept ] && echo yes || echo no)"
eq "reset work: home is the pristine one again" "no" "$([ -e /var/lib/boxd/work/home/x ] && echo yes || echo no)"
boxd-reset all --force >"$LOG/reset.out" 2>&1; eq "boxd-reset all (directory mode) exits 0" 0 "$?"
eq "reset all: the cache is empty and still owned by the build account" "0 boxd" "$(ls -A /var/lib/boxd/work/cache | wc -l) $(stat -c %U /var/lib/boxd/work/cache)"
eq "the marker survives a reset" yes "$([ -e /var/lib/boxd/work/.boxd-dir-mode ] && echo yes || echo no)"
unset BOXD_MANAGER

# 8. the pod contract suite against the installed dispatcher
# The suite tests the host without virtual machines too, so the real msb must not be on the path while it runs.
mv /usr/bin/msb /usr/bin/msb.hold
BOXD_POD_UNDER_TEST=/usr/bin/boxd-pod bash tests/contract-pod-test.sh >"$LOG/contract.out" 2>&1; rc=$?
mv /usr/bin/msb.hold /usr/bin/msb
tail -1 "$LOG/contract.out"; grep '^FAIL' "$LOG/contract.out" | head
eq "contract-pod-test.sh against /usr/bin/boxd-pod exits 0" 0 "$rc"

# 9. podman options boxd-pod uses, against the installed podman: "<command words> <option>" per line
while read -r line; do
    flag=${line##* }; words=${line% *}
    [ -n "$words" ] || continue
    eq "podman $words accepts $flag" yes "$(podman $words --help 2>&1 | grep -Eq -- "(^|[ ,])$flag([ =,]|\$)" && echo yes || echo no)"
done <<'OPTIONS'
run --init
run --userns
run --pull
run --label
run --hostname
run --name
run --memory
run --memory-swap
run --pids-limit
run --cpu-shares
run -w
run -v
run -d
run -e
exec -i
exec -w
exec -e
exec --user
ps --filter
ps --format
ps -a
rm -f
rm -a
container inspect --format
image inspect --format
image prune -f
save -o
load -i
build -f
build -t
OPTIONS
eq "podman has the subcommand image exists" yes "$(podman image --help 2>&1 | grep -qw exists && echo yes || echo no)"

# 10. removal: purge takes away what the package and boxd-setup put outside the data, and leaves the account and the work area
dpkg --purge boxd-server >"$LOG/purge.out" 2>&1; eq "dpkg --purge boxd-server exits 0" 0 "$?"
eq "purge removed the programs, the settings and the podman drop-ins" "no no no" \
   "$([ -e /usr/bin/boxd-pod ] && echo yes || echo no) $([ -e /etc/boxd/boxd.conf ] && echo yes || echo no) $([ -e /etc/containers/containers.conf.d/boxd.conf ] || [ -L /etc/containers/containers.conf.d/boxd.conf ] && echo yes || echo no)"
eq "purge left the build account and the work area" "yes yes" "$(id boxd >/dev/null 2>&1 && echo yes || echo no) $([ -d /var/lib/boxd/work/jobs ] && echo yes || echo no)"

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
