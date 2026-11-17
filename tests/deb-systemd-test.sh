#!/usr/bin/env bash
# Proves the boxd Debian packages on a REAL running systemd, by dogfooding: inside one of boxd's own virtual machine boxes.
# A box machine's first process is not systemd, so this script starts a Debian 13 container whose first process is systemd
# (podman inside the machine, --systemd=always --privileged --cgroupns=private), builds and installs the packages THERE and
# checks them with `podman exec`. Run from the repository's top folder, on a machine with a boxd build server:
#
#   tower --vm --size medium --image docker.io/library/debian:trixie-slim -- bash tests/deb-systemd-test.sh
#
# (any boxd build server works in place of `tower`; the machine must be a virtual machine box with 4 GB or more, root,
# cgroups version 2, network, and /tmp on its own ext2/ext3/ext4 disk). Takes about 6 to 9 minutes, most of it apt and the
# first image pulls. It installs in the machine: podman, passt, uidmap, nftables and the Debian image it builds (a few
# hundred megabytes); inside the container: the four boxd packages and their dependencies. Safe to run twice: it removes its
# own container (name `boxd-sysd`) and the container's data folder first, and stops the container when it ends.
# Test bed notes, none of them hide a failure:
#   * the container's /var/lib/boxd is a folder of the machine's own ext4 disk (/tmp/boxd-sysd-lib): kernel overlay does not
#     nest on the container's own overlay root, and a real host has a plain disk there too. fuse-overlayfs is not used.
#   * /dev/net/tun of the machine is made world-usable (a real host has it 0666), rootless networking (pasta) needs it.
#   * the container image ships /usr/sbin/policy-rc.d (refuses every service stop in a package script); it is removed, a host has none.
#   * a virtual machine box has no /dev/kvm, so microsandbox virtual machine boxes cannot run here: out of scope, reported.
#   * the machine has no swap, so memory.swap.max does not exist in its cgroups; the check for it is not made.
# Prints `ok` / `FAIL` lines and ends with `ALL OK` or `<n> FAILED`.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
like() { if printf '%s' "$3" | grep -Eq -- "$2"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected a match of [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
note() { printf '     %s\n' "$*"; }
[ "$(id -u)" = 0 ] && [ -r /etc/debian_version ] || { echo "run as root on Debian, see the header" >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
C=boxd-sysd
LIB=/tmp/boxd-sysd-lib
PORT=2299
# inb <shell command>: runs it as root inside the systemd container; prints its output, returns its status
inb() { podman exec "$C" sh -c "$1"; }
# until <tries> <shell command>: waits (half a second between tries, at most <tries>) for the command to succeed in the container
until_in() { local n=$1; shift; while [ "$n" -gt 0 ]; do inb "$1" >/dev/null 2>&1 && return 0; n=$((n - 1)); sleep 0.5; done; return 1; }
# as_boxd <command>: the build account's own shell, in the container
as_boxd() { inb "cd /var/lib/boxd/work/home && runuser -u boxd -- sh -c '. /etc/profile.d/boxd-env.sh; $1'"; }
stop_container() { podman rm -f -t 5 "$C" >/dev/null 2>&1; }
[ -n "${BOXD_SYSD_KEEP:-}" ] || trap 'stop_container' EXIT   # BOXD_SYSD_KEEP=1 leaves the container running, for looking around with podman exec

# 0. the test bed: tools in the machine, the image with systemd, the container whose first process is systemd
apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends podman passt uidmap nftables ca-certificates crun netavark iproute2 >/dev/null 2>"/tmp/apt-sysd.err" ||
    { echo "FAIL apt could not install podman in the machine"; cat /tmp/apt-sysd.err; exit 1; }
chmod 666 /dev/net/tun
mkdir -p /tmp/boxd-sysd-img
cat > /tmp/boxd-sysd-img/Containerfile <<'EOF'
FROM docker.io/library/debian:trixie
RUN rm -f /usr/sbin/policy-rc.d /etc/dpkg/dpkg.cfg.d/docker /etc/dpkg/dpkg.cfg.d/excludes /etc/dpkg/dpkg.cfg.d/docker-excludes; \
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    systemd systemd-sysv dbus ca-certificates curl iproute2 openssh-client rsync git procps nodejs xz-utils >/dev/null
CMD ["/sbin/init"]
EOF
podman build -q -t localhost/boxd-sysd /tmp/boxd-sysd-img >/dev/null 2>/tmp/build-sysd.err || { echo "FAIL the systemd image did not build"; cat /tmp/build-sysd.err; exit 1; }
stop_container
rm -rf "$LIB"; mkdir -p "$LIB"
ss -ltn | grep -q ":$PORT " && { echo "FAIL port $PORT is in use in the machine"; exit 1; }
podman run -d --name "$C" --systemd=always --privileged --cgroupns=private -v "$HERE:/src:ro" -v "$LIB:/var/lib/boxd" localhost/boxd-sysd >/dev/null ||
    { echo "FAIL the container did not start"; exit 1; }
state=
for _ in $(seq 1 120); do
    state=$(inb 'systemctl is-system-running' 2>/dev/null); case $state in running|degraded) break ;; esac; sleep 0.5
done
like "systemd is the first process of the container and reached running" '^(running|degraded)$' "$state"
eq "the container's first process is systemd" systemd "$(inb 'cat /proc/1/comm')"
eq "the container sees cgroups version 2" cgroup2fs "$(inb 'stat -fc %T /sys/fs/cgroup')"
eq "the container's folder of the build account is on a disk file system, not overlay" ext2/ext3 "$(inb 'stat -fc %T /var/lib/boxd')"
note "systemd: $(inb 'systemctl --version | head -1'); failed units of the bare image (not boxd): $(inb 'systemctl --failed --no-legend | cut -d" " -f2 | tr "\n" " "')"
eq "/dev/kvm in the machine (virtual machine boxes inside it are out of scope)" "absent" "$([ -e /dev/kvm ] && echo present || echo absent)"

# 1. build the four packages inside Debian and install them with apt on the systemd host
inb 'rm -rf /build /root/deb-out; mkdir /build; cp -a /src/. /build/; rm -rf /build/deb-out; cd /build && BOXD_DEB_OUT=/root/deb-out tools/build-deb' >/tmp/sysd-build.out 2>&1
eq "1. build-deb exits 0" 0 "$?"
tail -4 /tmp/sysd-build.out
eq "1. four packages built" 4 "$(inb 'ls /root/deb-out/*.deb | wc -l')"
inb 'cd /root/deb-out && apt-get install -y -qq ./boxd_*.deb ./boxd-server_*.deb ./boxd-client_*.deb ./microsandbox-bin_*.deb' >/tmp/sysd-apt.out 2>&1
eq "1. apt install of the four local files exits 0" 0 "$?"
eq "1. all four packages are installed" "ii ii ii ii" "$(inb 'dpkg-query -W -f="\${db:Status-Abbrev}\n" boxd boxd-server boxd-client microsandbox-bin' | tr -s ' \n' ' ' | sed 's/ $//')"
like "1. apt resolved podman 5.4 and the other dependencies" '^podman 5\.4' "$(inb 'dpkg-query -W -f="\${Package} \${Version}\n" podman')"
eq "1. nothing left half configured" "" "$(inb 'dpkg --audit')"

# 2. boxd-setup to the end on systemd, boxctl check, start, status, log
inb "sed -i -e 's/^#BOXD_PORT=.*/BOXD_PORT=$PORT/' -e 's/^#BOXD_MEM_MAX=.*/BOXD_MEM_MAX=2G/' -e 's/^#BOXD_WORK_FS=.*/BOXD_WORK_FS=dir/' /etc/boxd/boxd.conf
rm -f /root/testkey /root/testkey.pub; ssh-keygen -q -t ed25519 -N '' -f /root/testkey"
inb 'boxd-setup --key /root/testkey.pub' >/tmp/sysd-setup.out 2>&1
eq "2. boxd-setup exits 0 on systemd" 0 "$?"
tail -3 /tmp/sysd-setup.out
eq "2. boxd.service is enabled for boot" enabled "$(inb 'systemctl is-enabled boxd.service')"
eq "2. boxd-setup did not start boxd" inactive "$(inb 'systemctl is-active boxd.service')"
inb 'boxctl check' >/tmp/sysd-check.out 2>&1; eq "2. boxctl check exits 0" 0 "$?"
like "2. boxctl check says the conditions hold" 'boxd: conditions hold' "$(cat /tmp/sysd-check.out)"
inb 'boxctl start'; eq "2. boxctl start exits 0" 0 "$?"
until_in 60 'systemctl is-active --quiet boxd-sshd && ss -ltn | grep -q ":'$PORT' "'
eq "2. boxctl start brought both units up" "active active" "$(inb 'systemctl is-active boxd boxd-sshd' | tr '\n' ' ' | sed 's/ $//')"
eq "2. the build sshd answers on port $PORT" yes "$(inb "ss -ltn | grep -q ':$PORT ' && echo yes || echo no")"
status=$(inb 'boxctl status')
eq "2. boxctl status shows both units active (running)" 2 "$(printf '%s\n' "$status" | grep -c 'Active: active (running)')"
like "2. boxctl status shows the power module line" 'power module: off' "$status"
until_in 20 'boxctl log boxd | grep -q "boxd: up"'
like "2. boxctl log boxd shows a real journal line" 'sh\[[0-9]+\]: boxd: up' "$(inb 'boxctl log boxd')"
like "2. boxctl log sshd shows the sshd listening on the port" "Server listening on 0.0.0.0 port $PORT" "$(inb 'boxctl log sshd')"

# 3. the build sshd is in the unit's cgroup, memory.max is there and survives daemon-reload and boxctl reload
CG=/sys/fs/cgroup/boxd.slice/boxd-sshd.service
pid=$(inb 'systemctl show -p MainPID --value boxd-sshd')
eq "3. sshd main process sits in a child of the unit's cgroup" "0::/boxd.slice/boxd-sshd.service/sshd" "$(inb "cat /proc/$pid/cgroup")"
eq "3. the unit's cgroup is the one systemd names" "/boxd.slice/boxd-sshd.service" "$(inb 'systemctl show -p ControlGroup --value boxd-sshd')"
eq "3. memory.max of the unit's cgroup equals BOXD_MEM_MAX (2G)" 2147483648 "$(inb "cat $CG/memory.max")"
eq "3. the controllers cpu memory pids are handed to the child cgroups" "cpu memory pids" "$(inb "cat $CG/cgroup.subtree_control")"
eq "3. the build account owns the unit's cgroup (rootless podman can manage it)" boxd "$(inb "stat -c %U $CG")"
inb 'systemctl daemon-reload'
eq "3. memory.max is still 2G after systemctl daemon-reload" 2147483648 "$(inb "cat $CG/memory.max")"
inb 'boxctl reload'; eq "3. boxctl reload exits 0" 0 "$?"
until_in 60 'systemctl is-active --quiet boxd-sshd && ss -ltn | grep -q ":'$PORT' "'
eq "3. memory.max is still 2G after boxctl reload" 2147483648 "$(inb "cat $CG/memory.max")"
eq "3. the new sshd is in the child cgroup again" "0::/boxd.slice/boxd-sshd.service/sshd" "$(inb "cat /proc/\$(systemctl show -p MainPID --value boxd-sshd)/cgroup")"
eq "3. boxd-pod would read the same cap (BOXD_CGROUP names the unit's cgroup)" "BOXD_CGROUP=$CG" "$(inb 'grep ^BOXD_CGROUP= /etc/boxd/boxd.conf')"

# 4. real calls through the build sshd: pod status, the real box client, a real rootless podman box
SSH="ssh -p $PORT -i /root/testkey -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR boxd@127.0.0.1"
like "4. pod status answers engines, version and vm_room" '^version=[0-9.]+	engines=container(,vm)?	.*vm_room=' "$(inb "$SSH 'pod status'")"
inb 'mkdir -p /root/.ssh; chmod 700 /root/.ssh; rm -rf /root/wt; mkdir /root/wt; cd /root/wt && git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m t
ssh-keyscan -p '$PORT' 127.0.0.1 >> /root/.ssh/known_hosts 2>/dev/null
box setup 127.0.0.1 --port '$PORT' --user boxd --identity /root/testkey' >/tmp/sysd-boxsetup.out 2>&1
eq "4. box setup exits 0" 0 "$?"
IMG=docker.io/library/debian:trixie-slim
BOX="cd /root/wt && box --image $IMG"
inb "$BOX -- sh -c 'echo marker > /tmp/marker; exit 7'" >/tmp/sysd-run1.out 2>&1; rc=$?
eq "4. a real pod run creates a rootless podman box and the exit code 7 passes through" 7 "$rc"
tail -3 /tmp/sysd-run1.out
eq "4. a second call reaches the same box (the file written by the first)" marker "$(inb "$BOX -- cat /tmp/marker" 2>/dev/null)"
eq "4. the box is a podman container of the build account" 1 "$(as_boxd 'podman ps -q | wc -l')"
eq "4. one podman box in pod status (boxes=1)" 1 "$(inb "$SSH 'pod status'" | sed -n 's/.*boxes=\([0-9]*\).*/\1/p')"
eq "4. podman is 5.4" 5.4 "$(as_boxd "podman version --format {{.Version}}" | cut -d. -f1,2)"
inb "cd /root/wt && box --pod usr --image $IMG --user -- sh -c 'id -u; echo \$HOME; ls -ld /job | cut -d\" \" -f3'" >/tmp/sysd-user2.out 2>&1
eq "4. --user (the keep-id path): uid 1000 not 0, home /job/home, /job owned by that user" "1000 /job/home boxd" "$(tail -3 /tmp/sysd-user2.out | tr '\n' ' ' | sed 's/ $//')"
# a long process, then box ps lists it
inb "$BOX --detach -- sleep 600" >/tmp/sysd-detach.out 2>&1
eq "4. a detached run starts" 0 "$?"
until_in 40 "cd /root/wt && box ps | grep -q 'sleep 600'"
like "4. pod ps (box ps) lists the process" 'sleep 600' "$(inb 'cd /root/wt && box ps')"

# 5. the box's processes sit inside the capped cgroup
cpid=$(as_boxd "podman inspect --format {{.State.Pid}} \$(podman ps -q | head -1)")
like "5. the container's init is inside the unit's cgroup (what the memory cap and the dashboard rely on)" '^0::/boxd\.slice/boxd-sshd\.service/' "$(inb "cat /proc/$cpid/cgroup")"
note "container cgroup: $(inb "cat /proc/$cpid/cgroup")"
bcg=$(inb "sed 's/^0:://' /proc/$cpid/cgroup")
eq "5. the box has its own memory limit below the cap (BOXD_LIMITS: 12g, cgroup path of the box has memory.max)" yes "$(inb "[ -r /sys/fs/cgroup$bcg/memory.max ] && echo yes || echo no")"
note "box memory.max: $(inb "cat /sys/fs/cgroup$bcg/memory.max") (BOXD_LIMITS, below the 2G cap of the unit above it: the smaller one applies)"
used=$(inb "cat $CG/memory.current")
like "5. the unit's cgroup accounts the box's memory (memory.current of the unit is more than 0)" '^[1-9][0-9]+$' "$used"

# 6. stop of the build sshd leaves boxes and sessions alone; boxctl stop removes the boxes; boxctl start works again
inb "cd /root/wt && box --image $IMG -- sh -c 'sleep 15; echo done > /tmp/session-done'" >/tmp/sysd-session.out 2>&1 &
sess=$!
until_in 40 "cd /root/wt && box ps | grep -q 'sleep 15'"
sshd_pid=$(inb 'systemctl show -p MainPID --value boxd-sshd')
inb 'systemctl stop boxd-sshd'; eq "6. systemctl stop boxd-sshd exits 0" 0 "$?"
eq "6. the build sshd unit is inactive" inactive "$(inb 'systemctl is-active boxd-sshd')"
eq "6. the port is closed (the main sshd is gone)" no "$(inb "ss -ltn | grep -q ':$PORT ' && echo yes || echo no")"
eq "6. KillMode=process: the boxes keep running (the root box and the --user box)" 2 "$(as_boxd 'podman ps -q | wc -l')"
eq "6. KillMode=process: the open session's process is still in the unit's cgroup" yes "$(inb "[ -n \"\$(cat $CG/cgroup.procs $CG/sshd/cgroup.procs 2>/dev/null)\" ] && echo yes || echo no")"
wait "$sess"; eq "6. the open session ran to its end, exit 0" 0 "$?"
inb 'systemctl start boxd-sshd'
until_in 60 "ss -ltn | grep -q ':$PORT '"
eq "6. boxd-sshd starts again after the plain stop" yes "$(inb "ss -ltn | grep -q ':$PORT ' && echo yes || echo no")"
eq "6. the command of the open session finished its work after the stop" done "$(inb "$BOX -- cat /tmp/session-done" 2>/dev/null)"
inb 'boxctl stop'; eq "6. boxctl stop exits 0" 0 "$?"
eq "6. boxctl stop: both units are inactive" "inactive inactive" "$(inb 'systemctl is-active boxd boxd-sshd' | tr '\n' ' ' | sed 's/ $//')"
eq "6. boxctl stop removed every box" 0 "$(as_boxd 'podman ps -aq | wc -l')"
like "6. boxctl log boxd shows the finish file ran (boxd: down)" 'boxd: down' "$(inb 'boxctl log boxd')"
inb 'boxctl start'; eq "6. boxctl start after the stop exits 0" 0 "$?"
until_in 60 "systemctl is-active --quiet boxd-sshd && ss -ltn | grep -q ':$PORT '"
like "6. the build sshd answers again after boxctl start" '^version=' "$(inb "$SSH 'pod status'")"
eq "6. memory.max is the cap again after the restart" 2147483648 "$(inb "cat $CG/memory.max")"
inb "$BOX -- true" >/dev/null 2>&1; eq "6. a new box can be made after the stop (exit 0)" 0 "$?"

# 7. boxd-reset in directory mode keeps the cache and removes the job leftovers
inb 'touch /var/lib/boxd/work/jobs/leftover /var/lib/boxd/work/home/x; mkdir -p /var/lib/boxd/work/cache; touch /var/lib/boxd/work/cache/kept; chown boxd:boxd /var/lib/boxd/work/jobs/leftover'
inb 'boxd-reset work' >/tmp/sysd-reset.out 2>&1; eq "7. boxd-reset work exits 0" 0 "$?"
tail -2 /tmp/sysd-reset.out
eq "7. the leftover is gone, the cache stays" "no yes" "$(inb '[ -e /var/lib/boxd/work/jobs/leftover ] && echo -n yes || echo -n no; echo -n " "; [ -e /var/lib/boxd/work/cache/kept ] && echo yes || echo no')"
eq "7. home is the pristine one again, the marker survives" "no yes" "$(inb '[ -e /var/lib/boxd/work/home/x ] && echo -n yes || echo -n no; echo -n " "; [ -e /var/lib/boxd/work/.boxd-dir-mode ] && echo yes || echo no')"
eq "7. boxd-reset removed the boxes" 0 "$(as_boxd 'podman ps -aq | wc -l')"

# 8. dpkg --purge leaves the account and the work area, removes units and settings; systemd drops the units
inb 'dpkg --purge boxd boxd-server boxd-client microsandbox-bin' >/tmp/sysd-purge.out 2>&1; eq "8. dpkg --purge exits 0" 0 "$?"
eq "8. the account is still there" yes "$(inb 'id boxd >/dev/null 2>&1 && echo yes || echo no')"
eq "8. the work area is still there" yes "$(inb '[ -e /var/lib/boxd/work/.boxd-dir-mode ] && echo yes || echo no')"
eq "8. units, settings and links are gone" "none" "$(inb 'for f in /usr/lib/systemd/system/boxd.service /usr/lib/systemd/system/boxd-sshd.service /etc/boxd/boxd.conf /etc/boxd /etc/systemd/system/multi-user.target.wants/boxd.service /etc/ssh/sshd_config.d/20-boxd.conf /etc/containers/containers.conf.d/boxd.conf /usr/bin/boxd-pod; do [ -e $f ] && echo -n "$f "; done; echo none' | sed 's/ none$//; s/^$/none/')"
eq "8. systemd no longer knows the units" 0 "$(inb "systemctl list-unit-files 'boxd*' --no-legend | wc -l")"
eq "8. systemd reports the unit as not found" "not-found" "$(inb 'systemctl show -p LoadState --value boxd.service')"
eq "8. nothing listens on the build port any more" no "$(inb "ss -ltn | grep -q ':$PORT ' && echo yes || echo no")"

if [ "$fails" -eq 0 ]; then echo "ALL OK"; else echo "$fails FAILED"; exit 1; fi
