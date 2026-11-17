#!/usr/bin/env bash
# Server side of docs/pod-contract.md: runs every "pod" case of contract/cases.json against the real
# server/boxd-pod with fake podman, msb, pgrep, rsync, boxd-keepawake and git first on PATH, in a scratch work folder
# (/work in the cases is rewritten to it). Then the rules the cases do not cover: list, reap, detach, the
# per-box lock, snapshot, settings file. No step waits on time: blocking uses fifos and lock state.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
POD=${BOXD_POD_UNDER_TEST:-$HERE/server/boxd-pod}   # tests/deb-package-test.sh runs the installed file
CASES="$HERE/contract/cases.json"
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }

T=$(mktemp -d)
trap 'exec 3>&-; rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/vmbin"
cat > "$T/bin/podman" <<'FAKE'
#!/bin/sh
# State: one file per container, "<image> <state> [user] [kvm]" (made with --user, with --kvm). Log: one line per call.
printf "%s\n" "$*" >> "$FAKE_LOG"   # printf: the cleanup script holds a backslash-zero that the shell's echo would turn into a NUL
block() { exec 5<>"$FAKE_EV"; echo "$1" >&5; read -r _ <"$FAKE_REL"; }
last() { for a; do n=$a; done; }
case $1 in
    container)
        [ -e "$FAKE_STATE/.creating" ] && : > "$FAKE_OVERLAP"
        last "$@"; [ -f "$FAKE_STATE/$n" ] || exit 1
        read -r img st u < "$FAKE_STATE/$n"
        l=; case " $u " in *" user "*) l=" boxd.user:1" ;; esac; case " $u " in *" kvm "*) l="$l boxd.kvm:1" ;; esac
        case "$*" in   # pod report asks for the init process id too (FAKE_CPID: the id of the running container's init process)
            *State.Pid*) echo "${FAKE_CPID:-0} map[boxd.box:x$l]" ;;
            *) echo "$img $st map[boxd.box:x$l]" ;;
        esac ;;
    run)
        u=; while [ $# -gt 0 ]; do case $1 in --name) name=$2 ;; boxd.user=1) u="$u user" ;; boxd.kvm=1) u="$u kvm" ;; sleep) break ;; esac; img=$1; shift; done
        if mv "$FAKE_BLOCK" "$FAKE_BLOCK.used" 2>/dev/null; then : > "$FAKE_STATE/.creating"; block run-blocked; rm -f "$FAKE_STATE/.creating"; fi
        echo "$img running${u:+ $u}" > "$FAKE_STATE/$name" ;;
    image)
        case $2 in
            inspect) last "$@"; cat "$FAKE_IMAGES/$(echo "$n" | tr / _)" 2>/dev/null || exit 1 ;;   # the image id
            prune) ;;
            *) last "$@"; [ -e "$FAKE_IMAGES/$(echo "$n" | tr / _)" ] || exit 1 ;;
        esac ;;
    build)
        # build -f <file> -t <tag> <context>: the image id is id-<cksum of the file>; build output goes to stdout like podman's
        while [ $# -gt 0 ]; do case $1 in -f) f=$2 ;; -t) t=$2 ;; esac; shift; done
        echo "STEP 1/1: build output"
        [ "${FAKE_BUILD_EXIT:-0}" = 0 ] || exit "$FAKE_BUILD_EXIT"
        echo "id-$(cksum < "$f" | cut -d' ' -f1)" > "$FAKE_IMAGES/$(echo "$t" | tr / _)" ;;
    save) [ "$2" = -o ] || exit 1
        [ -e "$3" ] && { echo "Error: docker-archive doesn't support modifying existing images" >&2; exit 125; }   # as real podman
        : > "$3" ;;
    load)   # an archive with text in it (box image push) is "<ref> <id>": that image appears; an empty one is an image named by its file
        if [ -s "$3" ]; then read -r r i < "$3"; echo "$i" > "$FAKE_IMAGES/$(echo "$r" | tr / _)"
        else n=$(basename "$3" .tar); : > "$FAKE_IMAGES/localhost_$n:latest"; fi ;;
    start) read -r img _ u < "$FAKE_STATE/$2"; echo "$img running${u:+ $u}" > "$FAKE_STATE/$2" ;;
    rm) case $2 in -af) rm -f "$FAKE_STATE"/pod-* ;; *) last "$@"; rm -f "$FAKE_STATE/$n" ;; esac ;;
    exec)
        case "$*" in *boxd-call-cleanup*) [ -z "${FAKE_CLEAN:-}" ] || echo cleaned > "$FAKE_CLEAN"; exit 0 ;; esac
        [ -z "${FAKE_EXEC_OUT:-}" ] || echo "$FAKE_EXEC_OUT"
        [ -z "${FAKE_BLOCK_EXEC:-}" ] || block exec-blocked
        # FAKE_EXEC_CRASH=<n>: the kernel killed a process meanwhile, the out-of-memory kill counter then reads n
        [ -z "${FAKE_EXEC_CRASH:-}" ] || printf 'oom_kill %s\n' "$FAKE_EXEC_CRASH" > "$BOXD_CGROOT/boxd/memory.events"
        exit "${FAKE_EXEC_EXIT:-0}" ;;
    unshare)   # the real one enters the account's user namespace, where every file of a box is removable (retention); pod forward runs
        # nsenter ... socat under it: that call is the relay. FAKE_FWD_PROBE=<.running file>: write whether an exclusive lock on it would be refused (a shared one is held)
        [ "$2" = nsenter ] || { [ "$2" = du ] && [ -n "${FAKE_DU_EXIT:-}" ] && exit "$FAKE_DU_EXIT"; shift; exec "$@"; }   # FAKE_DU_EXIT=<n>: the size measurement fails
        [ -z "${FAKE_FWD_PROBE:-}" ] || { flock -n -x "$FAKE_FWD_PROBE" true && echo free || echo busy; } > "$FAKE_FWD_PROBE.probe"
        [ -z "${FAKE_FWD_OUT:-}" ] || printf %s "$FAKE_FWD_OUT"
        exit "${FAKE_FWD_EXIT:-0}" ;;
    images) cat "${FAKE_IMAGE_LIST:-/dev/null}" ;;   # the named images of the store, one reference per line
    ps)
        [ -z "${FAKE_PS_EXIT:-}" ] || { echo "Error: database is locked" >&2; exit "$FAKE_PS_EXIT"; }   # a failing listing
        for f in "$FAKE_STATE"/*; do
            [ -f "$f" ] || continue
            read -r img st _ < "$f"; n=${f##*/}
            printf '%s\t%s\t%s\n' "$n" "$img" "$st"   # real podman prints the container name
        done ;;
esac
FAKE
# Fake msb: one file per sandbox, "<image> <running|stopped|crashed>". A crashed box is listed as running, its
# machine process (the fake pgrep) is gone. Its own log keeps the podman log exact.
cat > "$T/vmbin/msb" <<'FAKE'
#!/bin/sh
echo "MSB_HOME=$MSB_HOME HOME=${HOME:+set}" >> "$FAKE_MSB_ENV"
block() { exec 5<>"$FAKE_EV"; echo "$1" >&5; read -r _ <"$FAKE_REL"; }
last() { for a; do n=$a; done; }
if [ "$1" = load ]; then echo "load < $(readlink /proc/$$/fd/0)" >> "$FAKE_MSB_LOG"
else printf "%s\n" "$*" | tr '\n' ' ' | sed 's/ $//' >> "$FAKE_MSB_LOG"; echo >> "$FAKE_MSB_LOG"; fi
case $1 in
    inspect)
        [ -f "$FAKE_VM_STATE/$2" ] || exit 1
        read -r img st < "$FAKE_VM_STATE/$2"; [ "$st" = crashed ] && st=running
        printf 'Name: %s\nImage: %s\nStatus: %s\n' "$2" "$img" "$st" ;;
    ls)
        [ -z "${FAKE_LS_EXIT:-}" ] || exit "$FAKE_LS_EXIT"   # a failing listing
        # FAKE_LS_FAIL_AT=<n>: only the nth listing of this call fails (a listing that fails for a moment)
        if [ -n "${FAKE_LS_FAIL_AT:-}" ]; then n=$(($(cat "$FAKE_VM_STATE/../ls-count" 2>/dev/null || echo 0) + 1)); echo $n > "$FAKE_VM_STATE/../ls-count"; [ "$n" != "$FAKE_LS_FAIL_AT" ] || exit 1; fi
        ls "$FAKE_VM_STATE"/* >/dev/null 2>&1 || echo "No sandboxes found." >&2   # as the real engine does (seen on laptop)
        echo "NAME IMAGE STATUS"
        for f in "$FAKE_VM_STATE"/*; do
            [ -f "$f" ] || continue
            read -r img st < "$f"; [ "$st" = crashed ] && st=running
            echo "${f##*/} $img $st"
        done ;;
    create)
        shift; while [ $# -gt 0 ]; do case $1 in --name) name=$2 ;; esac; img=$1; shift; done
        if mv "$FAKE_VM_BLOCK" "$FAKE_VM_BLOCK.used" 2>/dev/null; then block create-blocked; fi
        echo "$img running" > "$FAKE_VM_STATE/$name" ;;
    start) echo "$(cut -d' ' -f1 "$FAKE_VM_STATE/$2") running" > "$FAKE_VM_STATE/$2" ;;
    rm) last "$@"; rm -f "$FAKE_VM_STATE/$n" ;;
    image) case $2 in ls) cat "${FAKE_VM_IMAGE_LIST:-/dev/null}"; exit 0 ;; rm) exit 0 ;; esac   # the cached images: a header, then "<reference> <digest> <size> <created>"
        last "$@"; cat "$FAKE_VM_IMAGES/$(echo "$n" | tr / _)" 2>/dev/null || exit 1 ;;   # inspect prints the image id
    load) f=$(readlink /proc/$$/fd/0)
        if [ -s "$f" ]; then read -r r i < "$f"; echo "$i" > "$FAKE_VM_IMAGES/$(echo "$r" | tr / _)"
        else n=$(basename "$f" .tar); : > "$FAKE_VM_IMAGES/localhost_$n:latest"; fi ;;
    exec)
        case "$*" in *boxd-call-cleanup*) [ -z "${FAKE_CLEAN:-}" ] || echo cleaned > "$FAKE_CLEAN"; exit 0 ;; esac
        shift; while :; do case $1 in -t) shift ;; -e) shift 2 ;; *) break ;; esac; done
        # the docker start script runs with the working folder /, the command in /job/src
        if [ "$2" = / ]; then exit "${FAKE_STARTER_EXIT:-0}"; fi
        [ -z "${FAKE_BLOCK_EXEC:-}" ] || block exec-blocked
        [ -z "${FAKE_EXEC_OUT:-}" ] || echo "$FAKE_EXEC_OUT"
        # FAKE_EXEC_CRASH=<n>: the machine dies under the command and the out-of-memory kill counter then reads n
        if [ -n "${FAKE_EXEC_CRASH:-}" ]; then
            read -r img _ < "$FAKE_VM_STATE/$3"; echo "$img crashed" > "$FAKE_VM_STATE/$3"
            printf 'oom_kill %s\n' "$FAKE_EXEC_CRASH" > "$BOXD_CGROOT/boxd/memory.events"
        fi
        # FAKE_GUEST=<bin folder>: the command is the guest wrapper (sh -c ... _ command): run it for real with only that folder on PATH
        # (a fake dmesg there reads the file FAKE_DMESG; none there is a guest without dmesg), its exit code is the call's
        if [ -n "${FAKE_GUEST:-}" ] && [ "$5" = sh ]; then shift 4; exec env PATH="$FAKE_GUEST" "$@"; fi
        exit "${FAKE_EXEC_EXIT:-0}" ;;
esac
FAKE
cat > "$T/bin/pgrep" <<'FAKE'
#!/bin/sh
# boxd-pod asks whether the machine process of a sandbox exists: alive when the sandbox is running
name=$(echo "$2" | sed 's/.*--name \([^( ]*\).*/\1/')
[ -f "$FAKE_VM_STATE/$name" ] && [ "$(cut -d' ' -f2 "$FAKE_VM_STATE/$name")" = running ] || exit 1
[ -z "${FAKE_VM_PID:-}" ] || echo "$FAKE_VM_PID"   # pod report asks for the process id of a running machine
FAKE
cat > "$T/bin/rsync" <<'FAKE'
#!/bin/sh
echo "$*" > "$FAKE_RSYNC"; pwd > "$FAKE_RSYNC.cwd"
# FAKE_RSYNC_PROBE: is the folder of the box named in the last argument held busy right now?
for a; do p=$a; done; b=${p#jobs/}; b=${b%%/*}
[ -z "${FAKE_RSYNC_PROBE:-}" ] || { flock -n -x "jobs/$b/.running" true 2>/dev/null && echo free || echo held; } > "$FAKE_RSYNC_PROBE"
FAKE
cat > "$T/bin/nproc" <<'FAKE'
#!/bin/sh
echo 8
FAKE
# getfacl -cp <file>: the access rule boxd-setup gives the build account, unless the case sets FAKE_NO_ACL
cat > "$T/bin/getfacl" <<'FAKE'
#!/bin/sh
echo "user::rw-"
[ -n "${FAKE_NO_ACL:-}" ] || echo "user:$(id -un):rw-"
echo "group::rw-"
FAKE
cat > "$T/bin/df" <<'FAKE'
#!/bin/sh
# sizes in one-kilobyte blocks for --output=size,used (pod report), the percentage otherwise (37, or what a case wrote into FAKE_DF)
case "$*" in *size,used*) printf '1K-blocks Used\n1000000000 370000000\n' ;; *) echo "Use%"; if [ -n "${FAKE_DF:-}" ]; then sed 's/$/%/' "$FAKE_DF"; else echo " 37%"; fi ;; esac
FAKE
cat > "$T/bin/boxd-keepawake" <<'FAKE'
#!/bin/sh
echo boxd-keepawake >> "$FAKE_KEEP"
exec "$@"
FAKE
cat > "$T/bin/git" <<'FAKE'
#!/bin/sh
echo "$(basename "$PWD") $*" >> "$FAKE_GIT"
[ "$1" = init ] && mkdir -p .git
exit 0
FAKE
chmod +x "$T/bin/"* "$T/vmbin/"*
PATH_NOMSB="$T/bin:$PATH"
PATH_MSB="$T/vmbin:$PATH_NOMSB"
export PATH="$PATH_MSB" BOXD_CONF="$T/none.conf" BOXD_VIEW_KEYS="$T/none.keys"   # no settings file, no keys that may only read
unset SSH_TTY SSH_USER_AUTH FAKE_CPID FAKE_VM_PID BOXD_PROC BOXD_LIMITS BOXD_TTL BOXD_IMAGE BOXD_VM_LIMITS BOXD_VM_MAX

# Fresh scratch state for one case; fifos for the tests that block on events.
setup() {
    exec 3>&-
    rm -rf "$T/e"; mkdir -p "$T/e/state" "$T/e/work"
    W=$T/e/work
    export BOXD_WORK=$W FAKE_STATE=$T/e/state FAKE_LOG=$T/e/podman.log FAKE_RSYNC=$T/e/rsync FAKE_KEEP=$T/e/keep \
        FAKE_GIT=$T/e/git FAKE_OVERLAP=$T/e/overlap FAKE_EV=$T/e/ev FAKE_REL=$T/e/rel FAKE_BLOCK=$T/e/block \
        BOXD_KVM=$T/e/kvm   # absent unless a case makes it: the host's own /dev/kvm never leaks into a case
    mkdir -p "$T/e/imgs" "$T/e/archives" "$T/e/vmstate" "$T/e/vmimgs"
    export FAKE_IMAGES=$T/e/imgs BOXD_IMAGES_DIR=$T/e/archives FAKE_VM_STATE=$T/e/vmstate FAKE_VM_IMAGES=$T/e/vmimgs \
        FAKE_MSB_LOG=$T/e/msb.log FAKE_MSB_ENV=$T/e/msb.env FAKE_VM_BLOCK=$T/e/vmblock BOXD_POD_CLEAN=$T/e/clean \
        BOXD_CGROOT=$T/e/cg   # the build cgroup's files; absent unless a case writes them
    : > "$FAKE_MSB_LOG"; : > "$FAKE_MSB_ENV"
    mkfifo "$FAKE_EV" "$FAKE_REL"
    exec 3<>"$FAKE_EV"
    unset FAKE_EXEC_EXIT FAKE_EXEC_OUT FAKE_BLOCK_EXEC SSH_TTY FAKE_STARTER_EXIT
    export PATH=$PATH_MSB
    : > "$FAKE_LOG"
}
CASE_ENV=()
pod() { env "${CASE_ENV[@]}" SSH_ORIGINAL_COMMAND="$1" bash "$POD" <"${STDIN:-/dev/null}" >"$T/e/out" 2>"$T/e/err"; rc=$?; }
log() { paste -sd'|' "$FAKE_LOG"; }
box=boxd-2889387319
B64=Y2FyZ28AdGVzdAAtcABteSBjcmF0ZQ==

# The cases name /work and /var/lib/boxd/images; both live in the scratch folder here.
paths() { sed "s|/work|$W|g; s|/var/lib/boxd/images|$BOXD_IMAGES_DIR|g"; }

# Calls of one engine, from "<engine>_calls" and "<engine>_calls_absent": in order; "exact" means no other call
# in a log whose calls key the case lists. Uses c and name of the case loop.
calls() {
    local e=$1 log=$2 re found pos=0 ok=1 bad= l
    local -a res lines
    mapfile -t res < <(j ".${e}_calls // [] | .[]" | paths)
    mapfile -t lines < "$log"
    for re in "${res[@]}"; do
        found=
        while [ "$pos" -lt "${#lines[@]}" ]; do
            [[ ${lines[$pos]} =~ $re ]] && { found=1; pos=$((pos + 1)); break; }
            pos=$((pos + 1))
        done
        [ -n "$found" ] || { ok=0; echo "     no call matches $re in: $(paste -sd'|' "$log")"; break; }
    done
    eq "$name: $e calls in order" 1 "$ok"
    if [ "$(j ".exact // false")" = true ] && [ "$(j "has(\"${e}_calls\")")" = true ]; then
        eq "$name: no other $e calls" "${#res[@]}" "${#lines[@]}"
    fi
    mapfile -t res < <(j ".${e}_calls_absent // [] | .[]" | paths)
    for re in "${res[@]}"; do for l in "${lines[@]}"; do [[ $l =~ $re ]] && bad="$bad [$l]"; done; done
    eq "$name: forbidden $e calls absent" "" "$bad"
}

# Contract cases
n=$(jq '.pod | length' "$CASES")
for ((i = 0; i < n; i++)); do
    setup
    STDIN=$T/e/stdin
    c=$(jq -c ".pod[$i]" "$CASES")
    jq -j '.stdin // ""' <<<"$c" > "$STDIN"   # standard input of the call (box image push sends the archive)
    j() { jq -r "$1" <<<"$c"; }   # also used by calls
    name=$(j .name)
    while IFS=' ' read -r cn img st u; do [ -n "$cn" ] && echo "$img $st $u" > "$FAKE_STATE/$cn"; done < <(j '.containers // {} | to_entries[] | "\(.key) \(.value.image) \(.value.state) \(if .value.user then "user" else "" end) \(if .value.kvm then "kvm" else "" end)"')
    while IFS=' ' read -r cn img st; do [ -n "$cn" ] && echo "$img $st" > "$FAKE_VM_STATE/$cn"; done < <(j '.sandboxes // {} | to_entries[] | "\(.key) \(.value.image) \(.value.state)"')
    export FAKE_EXEC_EXIT=$(j '.exec_exit // 0') FAKE_STARTER_EXIT=$(j '.starter_exit // 0')
    [ "$(j '.ssh_tty // ""')" = "" ] || export SSH_TTY=$(j .ssh_tty)
    [ "$(j 'if has("msb") then .msb else true end')" = true ] || export PATH=$PATH_NOMSB
    CASE_ENV=(); while IFS= read -r kv; do [ -n "$kv" ] && CASE_ENV+=("$kv"); done < <(j '.env // {} | to_entries[] | "\(.key)=\(.value)"' | paths)   # this case only; /work in a value is the scratch folder
    # "cgroup": file name -> content, written byte for byte into the fake build cgroup (memory.stat, memory.max)
    while IFS= read -r f; do [ -n "$f" ] && { mkdir -p "$BOXD_CGROOT/boxd"; jq -j --arg f "$f" '.cgroup[$f]' <<<"$c" > "$BOXD_CGROOT/boxd/$f"; }; done < <(j '.cgroup // {} | keys[]')
    for im in $(j '.vm_images // [] | .[]'); do : > "$FAKE_VM_IMAGES/$(echo "$im" | tr / _)"; done
    for im in $(j '.images // [] | .[]'); do : > "$FAKE_IMAGES/$(echo "$im" | tr / _)"; done
    # image_ids and vm_image_ids: reference to image id, in the container store and in the microsandbox store
    while read -r im id; do [ -n "$im" ] && echo "$id" > "$FAKE_IMAGES/$(echo "$im" | tr / _)"; done < <(j '.image_ids // {} | to_entries[] | "\(.key) \(.value)"')
    while read -r im id; do [ -n "$im" ] && echo "$id" > "$FAKE_VM_IMAGES/$(echo "$im" | tr / _)"; done < <(j '.vm_image_ids // {} | to_entries[] | "\(.key) \(.value)"')
    for ar in $(j '.archives // [] | .[]'); do : > "$BOXD_IMAGES_DIR/$ar.tar"; done
    [ "$(j '.archives_built // false')" = true ] && mkdir -p "$W/cache/images" && : > "$W/cache/images/built-boxd-2889387319.tar"
    # files the case wants in the job folder (src_files under src), written byte for byte (-j: no newline added)
    for kind in src job; do
        d=$W/jobs/$box; [ "$kind" = src ] && d=$d/src
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            mkdir -p "$d/$(dirname "$f")"; jq -j --arg f "$f" ".${kind}_files[\$f]" <<<"$c" > "$d/$f"
        done < <(j ".${kind}_files // {} | keys[]")
    done
    # work_files: path under /work to content, written byte for byte (a call log, a settings hook's file)
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        mkdir -p "$W/$(dirname "$f")"; jq -j --arg f "$f" '.work_files[$f]' <<<"$c" > "$W/$f"
    done < <(j '.work_files // {} | keys[]')
    pod "$(j .command | paths)"
    want=$(j .exit); eq "$name: exit code" "$want" "$rc"
    if [ "$(j 'has("stdout")')" = true ]; then eq "$name: stdout" "$(j .stdout)" "$(cat "$T/e/out")"; fi
    if [ "$(j 'has("stdout_re")')" = true ]; then re=$(j .stdout_re); [[ $(cat "$T/e/out") =~ $re ]] && r=match || r="no match: $(cat "$T/e/out")"; eq "$name: stdout matches" match "$r"; fi
    if [ "$(j 'has("stderr")')" = true ]; then eq "$name: stderr" "$(j .stderr | paths)" "$(cat "$T/e/err")"; fi
    if [ "$(j 'has("stderr_re")')" = true ]; then re=$(j .stderr_re | paths); [[ $(cat "$T/e/err") =~ $re ]] && r=match || r="no match: $(cat "$T/e/err")"; eq "$name: stderr matches" match "$r"; fi
    if [ "$want" = 125 ] || [ "$want" = 75 ]; then eq "$name: one boxd-pod line on stderr" 1 "$(grep -c '^boxd-pod: ' "$T/e/err")"; fi
    if [ "$(j 'has("rsync_called_with")')" = true ]; then
        eq "$name: rsync arguments" "$(j .rsync_called_with | paths)" "$(cat "$FAKE_RSYNC")"
        eq "$name: rsync ran inside the work area" "$W" "$(cat "$FAKE_RSYNC.cwd")"
    fi
    # a refused rsync call never reaches rsync, and makes no folder
    if [ "$want" = 125 ] && [[ $(j .command) == rsync* ]]; then
        eq "$name: rsync was not run" no "$([ -e "$FAKE_RSYNC" ] && echo yes || echo no)"
        eq "$name: no jobs folder was made" no "$([ -e "$W/jobs" ] && echo yes || echo no)"
    fi
    calls podman "$FAKE_LOG"
    calls msb "$FAKE_MSB_LOG"
    # a pushed archive never stays in the work area, whatever the outcome
    [[ $(j .command) != "pod image load"* ]] || eq "$name: no archive left behind" "" "$(ls "$W/cache/images" 2>/dev/null)"
    while IFS= read -r f; do [ -n "$f" ] && eq "$name: file $f" yes "$([ -e "${f/\/work/$W}" ] && echo yes || echo no)"; done < <(j '.files // [] | .[]')
    while IFS= read -r f; do [ -n "$f" ] && eq "$name: file absent $f" no "$([ -e "${f/\/work/$W}" ] && echo yes || echo no)"; done < <(j '.files_absent // [] | .[]')
    # files_match: path to a regular expression that the file's content (without its last newline) must match
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        re=$(jq -r --arg f "$f" '.files_match[$f]' <<<"$c"); got=$(cat "${f/\/work/$W}" 2>/dev/null)
        [[ $got =~ $re ]] && r=match || r="no match: $got"; eq "$name: content of $f" match "$r"
    done < <(j '.files_match // {} | keys[]')
done

CASE_ENV=(); STDIN=   # the cases' settings and standard input end with the loop

# box image push for the vm store: microsandbox reports no image id, so the server records the pushed one
setup; R=docker.io/library/busybox:stable; I1=0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef; I2=fedcba9876540123456789ab0123456789ab0123456789ab0123456789abcdef
echo "$R $I1" | SSH_ORIGINAL_COMMAND="pod image load vm $R $I1" bash "$POD" >/dev/null 2>"$T/e/err"; eq "image load vm with an id succeeds" 0 "$?"
pod "pod image has vm $R $I1"; eq "image has vm: the pushed id is found" 0 "$rc"
pod "pod image has vm $R $I2"; eq "image has vm: another id is not" 1 "$rc"
pod "pod image has container $R $I1"; eq "image has container: a push to the vm store does not count" 1 "$rc"

# More refusals the cases do not list
setup
pod $'pod stop x\nrm -rf /'; eq "newline in the command line is refused" 125 "$rc"
pod "pod reap"; eq "reap is not reachable over ssh" 125 "$rc"
pod "pod run $box --detach bad/id -- $B64"; eq "bad run id is refused" 125 "$rc"
pod "pod run $box -- !!!!"; eq "bad base64 is refused" 125 "$rc"
pod "pod run $box -- AAA="; eq "base64 that decodes to nothing useful is refused" 125 "$rc"
pod "pod run $box --image ghcr.io/o/r:1 -- $B64"; eq "ghcr.io image is allowed" 0 "$rc"
pod "pod run b2 --image registry.example/o/r:1 -- $B64"; eq "a registry that is not listed is refused" 125 "$rc"
BOXD_REGISTRIES="docker.io ghcr.io registry.example" pod "pod run b2 --image registry.example/o/r:1 -- $B64"; eq "a registry added in the settings is allowed" 0 "$rc"
pod "pod run b3 --image localhost/a/b -- $B64"; eq "localhost image with a path is refused" 125 "$rc"
eq "refusals touched nothing but the allowed boxes" "ghcr.io/o/r:1 running" "$(cat "$FAKE_STATE/pod-$box")"
pod "pod run $box --bogus -- $B64"; eq "unknown option is refused" 125 "$rc"
SSH_ORIGINAL_COMMAND= bash "$POD" >/dev/null 2>&1 </dev/null; eq "no command (interactive login) is refused" 125 "$?"

# An image file that is a link out of the worktree is refused before any podman call (the sync keeps only safe links, this is the second check)
setup
mkdir -p "$W/jobs/$box/src"; echo "FROM scratch" > "$T/outside"; ln -s "$T/outside" "$W/jobs/$box/src/Containerfile"
pod "pod run $box --image-file Containerfile -- $B64"; eq "image file that links out of the worktree is refused" 125 "$rc"
eq "that refusal made no podman call" "" "$(log)"

# Settings: defaults, then the settings file
setup
pod "pod run $box -- $B64"
case $(log) in *"--memory 12g --memory-swap 16g --pids-limit 4096 --cpu-shares 1024"*) r=yes ;; *) r=no ;; esac
eq "default limits" yes "$r"
setup; printf 'BOXD_LIMITS="--memory 1g"\nBOXD_IMAGE=docker.io/library/alpine:3\n' > "$T/pod.conf"
BOXD_CONF="$T/pod.conf" pod "pod run $box -- $B64"
eq "settings file sets limits and default image" "--memory 1g docker.io/library/alpine:3 sleep infinity" "$(grep '^run ' "$FAKE_LOG" | grep -o -- '--memory 1g .*')"

# Interactive run gets a terminal
setup; export SSH_TTY=/dev/pts/9
pod "pod run $box -- $B64"
eq "exec asks for a terminal when ssh has one" "exec -i -t -w /job/src pod-$box cargo test -p my crate" "$(grep '^exec' "$FAKE_LOG")"

# Snapshot
setup
pod "pod run $box --snapshot -- $B64"; pod "pod run $box --snapshot -- $B64"
eq "snapshot: init once, then add and commit each time" \
    "src init -q|src add -A|src -c user.name=boxd -c user.email=boxd@localhost -c commit.gpgsign=false commit -q --allow-empty -m snapshot|src add -A|src -c user.name=boxd -c user.email=boxd@localhost -c commit.gpgsign=false commit -q --allow-empty -m snapshot" \
    "$(paste -sd'|' "$FAKE_GIT")"

# pod forward runs under boxd-keepawake (the sleep module and boxd-reset leave a live viewer alone), like a foreground call
setup; mkdir -p "$W/jobs/$box"; echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-$box"
CASE_ENV=(FAKE_CPID=4242); pod "pod forward $box 5900"; CASE_ENV=()
eq "forward: the relay runs under boxd-keepawake" boxd-keepawake "$(cat "$FAKE_KEEP" 2>/dev/null)"

# List
setup
mkdir -p "$W/jobs/a" "$W/jobs/b"; touch -d @100 "$W/jobs/a/.last-used"
echo "docker.io/library/rust:1 running" > "$FAKE_STATE/pod-a"; echo "docker.io/library/debian:stable-slim exited" > "$FAKE_STATE/pod-b"
pod "pod list"
eq "list: box, image, running or stopped, last used (0 when never), engine" \
    "$(printf 'a\tdocker.io/library/rust:1\trunning\t100\tcontainer|b\tdocker.io/library/debian:stable-slim\tstopped\t0\tcontainer')" "$(paste -sd'|' "$T/e/out")"

# Reap: ttl 1800, now 2000 -> boxes stamped at 200 or earlier go
setup
for b in old fresh edge held locked nostamp nodir; do echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-$b"; done
mkdir -p "$W/jobs"/{old,fresh,edge,held,locked,nostamp}
touch -d @100 "$W/jobs/old/.last-used" "$W/jobs/held/.last-used" "$W/jobs/locked/.last-used"
touch -d @1000 "$W/jobs/fresh/.last-used"; touch -d @200 "$W/jobs/edge/.last-used"
: > "$W/jobs/held/.running"
flock -s "$W/jobs/held/.running" sh -c "echo held >&3; read x < '$T/e/rel'" &
h1=$!; read -r _ <&3
flock -x "$W/jobs/locked/.lock" sh -c "echo held >&3; read x < '$T/e/rel'" &
h2=$!; read -r _ <&3
reapnow() { bash "$POD" reap --now "$1" </dev/null >"$T/e/out" 2>"$T/e/err"; rc=$?; }
reapnow 2000
eq "reap exits 0" 0 "$rc"
eq "reap removes stale boxes (also without a stamp or folder), spares fresh, exactly-at-limit, held and locked" \
    "pod-edge pod-fresh pod-held pod-locked" "$(ls "$FAKE_STATE" | paste -sd' ')"
eq "reap names what it removed" "reaped nodir|reaped nostamp|reaped old" "$(sort "$T/e/out" | paste -sd'|')"
exec 6>"$T/e/rel"; exec 6>&-   # one close frees both waiting readers
wait "$h1" "$h2"
reapnow 2001; eq "one second past the limit the edge box goes (holders are gone by now)" "pod-fresh" "$(ls "$FAKE_STATE" | paste -sd' ')"
reapnow 99999; eq "everything stale goes" "" "$(ls "$FAKE_STATE" | paste -sd' ')"
reapnow abc; eq "reap refuses a bad --now" 125 "$rc"
setup; echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-x"; mkdir -p "$W/jobs/x"; touch -d @100 "$W/jobs/x/.last-used"
printf 'BOXD_TTL=10\n' > "$T/pod.conf"; BOXD_CONF="$T/pod.conf" bash "$POD" reap --now 120 </dev/null >/dev/null; eq "ttl comes from the settings file" "" "$(ls "$FAKE_STATE")"

# A foreground run holds its box against reap for as long as it runs
setup
: > "$T/e/ka"; export BOXD_KEEPAWAKE_LOCK=$T/e/ka
kalock() { flock -n -x "$T/e/ka" true && echo free || echo held; }
FAKE_BLOCK_EXEC=1 SSH_ORIGINAL_COMMAND="pod run $box -- $B64" bash "$POD" </dev/null >/dev/null 2>&1 &
fg=$!; read -r ev <&3; eq "foreground run reached exec" exec-blocked "$ev"
eq "a foreground run holds the keep-awake lock itself (its connection may come from an address the sleep module ignores)" held "$(kalock)"
touch -d @100 "$W/jobs/$box/.last-used"; reapnow 99999
eq "reap spares a box with a run in progress" "pod-$box" "$(ls "$FAKE_STATE")"
echo go > "$FAKE_REL"; wait "$fg"; eq "the keep-awake lock is free once the foreground run ended" free "$(kalock)"; unset BOXD_KEEPAWAKE_LOCK
reapnow 99999999999
eq "reap takes the box once the run ended and time passed" "" "$(ls "$FAKE_STATE")"

# The shared package caches are announced to every box of both engines, also for Maven and Gradle.
setup; pod "pod run $box -- $B64"
eq "container box: the cache folders of the package tools are in its environment" 1 "$(grep -c -- '-e CARGO_HOME=/cache/cargo .*-e npm_config_store_dir=/cache/pnpm-store .*-e XDG_CACHE_HOME=/cache/xdg -e MAVEN_ARGS=-Dmaven.repo.local=/cache/m2 -e GRADLE_USER_HOME=/cache/gradle ' "$FAKE_LOG")"
setup; pod "pod run $box --vm -- $B64"
eq "machine box: the same" 1 "$(grep -c -- '-e CARGO_HOME=/cache/cargo .*-e XDG_CACHE_HOME=/cache/xdg -e MAVEN_ARGS=-Dmaven.repo.local=/cache/m2 -e GRADLE_USER_HOME=/cache/gradle ' "$FAKE_MSB_LOG")"

# BOXD_MAVEN_MIRROR: a caching repository of the home network as the mirror of Maven's central source, for every box of the host.
setup; printf 'BOXD_MAVEN_MIRROR=http://192.0.2.50:18081/maven/\n' > "$T/pod.conf"; CASE_ENV=(BOXD_CONF="$T/pod.conf")
pod "pod run $box -- $B64"
eq "maven mirror: the box's Maven reads the settings file" 1 "$(grep -c -- '-e MAVEN_ARGS=-Dmaven.repo.local=/cache/m2 -s /cache/maven-settings.xml -e GRADLE_USER_HOME' "$FAKE_LOG")"
eq "maven mirror: the settings file in the shared cache names the mirror for central, nothing else" \
    "<settings><mirrors><mirror><id>boxd-mirror</id><mirrorOf>central</mirrorOf><url>http://192.0.2.50:18081/maven/</url></mirror></mirrors></settings>" "$(cat "$W/cache/pod/maven-settings.xml")"
echo stale > "$W/cache/pod/maven-settings.xml"; pod "pod run $box -- $B64"
eq "maven mirror: a settings file that differs is written again" 1 "$(grep -c boxd-mirror "$W/cache/pod/maven-settings.xml")"
printf 'BOXD_MAVEN_MIRROR="http://x/ -Dfoo=bar"\n' > "$T/pod.conf"; pod "pod run $box -- $B64"
eq "maven mirror: a value that is not a plain address is refused" 125 "$rc"
CASE_ENV=()

# Detach: prints the run id at once, log gets output then the exit code, the box stays busy meanwhile
setup
run=20261113-030000-ab12
export FAKE_EXEC_OUT=hello FAKE_EXEC_EXIT=3 FAKE_BLOCK_EXEC=1
pod "pod run $box --detach $run -- $B64"
eq "detach: exit 0 and the run id, while the command still runs" "0 $run" "$rc $(cat "$T/e/out")"
read -r ev <&3; eq "detached command started" exec-blocked "$ev"
pg=$(cat "$W/jobs/$box/runs/$run.pid"); eq "detach: the run records its process group, a group leader" "$pg" "$(ps -o pgid= -p "$pg" | tr -d ' ')"
eq "detach: the box is held busy while it runs" no "$(flock -n -x "$W/jobs/$box/.running" true && echo yes || echo no)"
touch -d @100 "$W/jobs/$box/.last-used"
exec 4< <(tail -n +1 -f "$W/jobs/$box/runs/$run.log"); tp=$!
echo go > "$FAKE_REL"
while read -r l <&4; do [ "${l#EXIT}" != "$l" ] && break; done
kill "$tp" 2>/dev/null; exec 4<&-
eq "detach: log holds the output, then EXIT with the code" "hello|EXIT 3" "$(paste -sd'|' "$W/jobs/$box/runs/$run.log")"
eq "detach: the group record is gone once the run ended" no "$([ -e "$W/jobs/$box/runs/$run.pid" ] && echo yes || echo no)"
eq "detach: ran under boxd-keepawake" boxd-keepawake "$(cat "$FAKE_KEEP")"
eq "detach: no session marker" 0 "$(grep -c BOXD_CALL "$FAKE_LOG")"
eq "detach: exec has no -i and no terminal" "exec -w /job/src pod-$box cargo test -p my crate" "$(grep '^exec' "$FAKE_LOG")"
eq "detach: last-used refreshed when the run ends" yes "$([ "$(stat -c %Y "$W/jobs/$box/.last-used")" -gt 100 ] && echo yes || echo no)"
unset FAKE_EXEC_OUT FAKE_EXEC_EXIT FAKE_BLOCK_EXEC


# A foreground run ends with the session that started it. The starter stands for sshd's session process: killing it
# re-parents the dispatcher. Every wait is on an event (the fake engine's fifos, the dispatcher's closed error stream).
session_gone() {   # session_gone <label> <how the session goes: starter | term> [vm]
    local label=$1 how=$2 eng=${3:-} sp dp c id cid ec
    setup; export FAKE_CLEAN=$T/e/clean FAKE_BLOCK_EXEC=1; mkfifo "$FAKE_CLEAN" "$T/e/errf"
    if [ -n "$eng" ]; then echo "docker.io/library/debian:stable-slim running" > "$FAKE_VM_STATE/pod-$box"; else echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-$box"; fi
    mkdir -p "$W/jobs/$box" "$W/cache"
    cat "$T/e/errf" >"$T/e/err" & ec=$!   # opens when the dispatcher opens its error stream, ends when everything holding it is gone
    bash -c 'SSH_ORIGINAL_COMMAND="pod run $0 -- $1" BOXD_WATCH_INTERVAL=0.05 bash "$2" </dev/null >/dev/null 2>"$3" & echo $! >"$4"; wait' \
        "$box" "$B64" "$POD" "$T/e/errf" "$T/e/dpid" & sp=$!
    read -r ev <&3; eq "$label: the command is running" exec-blocked "$ev"
    dp=$(cat "$T/e/dpid")
    if [ "$how" = term ]; then kill -TERM "$dp"; else kill -9 "$sp"; fi
    exec 7<>"$FAKE_CLEAN"; read -r -t 20 c <&7; exec 7>&-   # opened read-write so it does not wait for the writer; -t only keeps a failure from hanging
    [ "$c" = cleaned ] || { kill -9 "$dp" 2>/dev/null; exec 6>"$T/e/rel"; exec 6>&-; }
    eq "$label: the cleanup command is issued in the box" cleaned "$c"
    wait "$ec"
    kill -9 "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
    id=$(grep -oh "BOXD_CALL=[0-9a-z-]*" "$FAKE_LOG" "$FAKE_MSB_LOG" | head -n 1 | cut -d= -f2)
    eq "$label: the command carries a marker" yes "$([ -n "$id" ] && echo yes || echo no)"
    cid=$(grep -h 'boxd-call-cleanup' "$FAKE_LOG" "$FAKE_MSB_LOG" | sed 's/.* _ //')
    eq "$label: the cleanup names the same marker" "$id" "$cid"
    eq "$label: the call is logged with exit 129" 129 "$(cut -f5 "$W/cache/calls.log")"
    eq "$label: the box lock is free again" yes "$(flock -n -x "$W/jobs/$box/.running" true && echo yes || echo no)"
    unset FAKE_CLEAN FAKE_BLOCK_EXEC
}
session_gone "container, session gone" starter
session_gone "container, hangup or termination" term
session_gone "vm, session gone" starter vm
session_gone "vm, hangup or termination" term vm
# the cleanup runs as the same account as the command (processes of another user hide their environment)
setup; echo "docker.io/library/debian:stable-slim running user" > "$FAKE_STATE/pod-$box"; mkdir -p "$W/jobs/$box" "$W/cache"
export FAKE_CLEAN=$T/e/clean FAKE_BLOCK_EXEC=1; mkfifo "$FAKE_CLEAN"
SSH_ORIGINAL_COMMAND="pod run $box --user -- $B64" BOXD_WATCH_INTERVAL=0.05 bash "$POD" </dev/null >/dev/null 2>&1 & dp=$!
read -r ev <&3; exec 7<>"$FAKE_CLEAN"; kill -TERM "$dp"; read -r -t 20 c <&7; exec 7>&-; wait "$dp"
eq "cleanup of a --user call runs with --user" 1 "$(grep -c "^exec --user [0-9]*:[0-9]* -e HOME=/job/home pod-$box sh -c : boxd-call-cleanup" "$FAKE_LOG")"
unset FAKE_CLEAN FAKE_BLOCK_EXEC
# a call that ends by itself, a call on a terminal and a detached run never get the cleanup
setup; pod "pod run $box -- $B64"; eq "an ordinary foreground call has no cleanup" 0 "$(grep -c boxd-call-cleanup "$FAKE_LOG")"

# Lock: two first runs at once create one container
setup
: > "$FAKE_BLOCK"
SSH_ORIGINAL_COMMAND="pod run $box -- $B64" bash "$POD" </dev/null >"$T/e/o1" 2>&1 &
p1=$!; read -r ev <&3; eq "first run is inside container creation" run-blocked "$ev"
SSH_ORIGINAL_COMMAND="pod run $box -- $B64" bash "$POD" </dev/null >"$T/e/o2" 2>&1 &
p2=$!
ino=$(stat -c %i "$W/jobs/$box/.lock")
# the second run is either queued on the lock (listed as a waiter), or it ignored the lock (overlap, or done)
until grep -q -- "->.*:$ino " /proc/locks || [ -e "$FAKE_OVERLAP" ] || ! kill -0 "$p2" 2>/dev/null; do :; done
eq "second run waits for the lock, it does not touch podman" no "$([ -e "$FAKE_OVERLAP" ] && echo yes || echo no)"
echo go > "$FAKE_REL"
wait "$p1"; r1=$?; wait "$p2"; r2=$?
eq "both runs succeed" "0 0" "$r1 $r2"
eq "one container was created" 1 "$(grep -c '^run -d' "$FAKE_LOG")"
eq "both commands ran" 2 "$(grep -c '^exec' "$FAKE_LOG")"

# Virtual machine rules ---------------------------------------------------------------------------------------

vmbox() { echo "docker.io/library/debian:stable-slim ${2:-running}" > "$FAKE_VM_STATE/pod-$1"; }

# A machine that ends under a detached run (the tower, 2026-11-15: the kernel's out-of-memory killer took it): the log says
# so before its EXIT line, and names the killer when the build cgroup's oom_kill counter rose during the run.
vmrun() {   # vmrun <run id> <oom kills before> <oom kills when the machine dies, or "alive">: the run's log, lines joined by |
    setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'oom 0\noom_kill %s\n' "$2" > "$BOXD_CGROOT/boxd/memory.events"
    export FAKE_EXEC_EXIT=1 FAKE_BLOCK_EXEC=1
    pod "pod run $box --vm --detach $1 -- $B64"; read -r _ <&3
    if [ "$3" != alive ]; then vmbox "$box" crashed; printf 'oom 1\noom_kill %s\n' "$3" > "$BOXD_CGROOT/boxd/memory.events"; fi
    exec 4< <(tail -n +1 -f "$W/jobs/$box/runs/$1.log"); tp=$!
    echo go > "$FAKE_REL"
    while read -r l <&4; do [ "${l#EXIT}" != "$l" ] && break; done
    kill "$tp" 2>/dev/null; exec 4<&-
    unset FAKE_EXEC_EXIT FAKE_BLOCK_EXEC
    paste -sd'|' "$W/jobs/$box/runs/$1.log"
}
eq "detach, machine killed by the out-of-memory killer: the log says so, then EXIT" \
    "boxd: the virtual machine of box $box ended under this run: the host's out-of-memory killer ended a process of the boxes meanwhile (kernel log: dmesg)|EXIT 1" \
    "$(vmrun 20261115-131105-0517 3 4)"
eq "detach, machine ended otherwise: the log says it ended" "boxd: the virtual machine of box $box ended under this run|EXIT 1" "$(vmrun 20261115-131105-0518 3 3)"
eq "detach, machine still alive: no note, only EXIT" "EXIT 1" "$(vmrun 20261115-131105-0519 3 alive)"
setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'oom_kill 3\n' > "$BOXD_CGROOT/boxd/memory.events"
FAKE_EXEC_CRASH=4 FAKE_EXEC_EXIT=1 pod "pod run $box --vm -- $B64"
eq "foreground, machine killed: the note on standard error, the command's code kept" \
    "1 boxd: the virtual machine of box $box ended under this run: the host's out-of-memory killer ended a process of the boxes meanwhile (kernel log: dmesg)" "$rc $(grep '^boxd:' "$T/e/err")"

# The guest kernel's kill lines of a detached machine run go into its log before EXIT (2026-11-15 and 2026-11-16: a docker
# container of a run died in a 4 GB machine, the host killed nothing, the guest's log went with the machine). The fake msb runs the
# guest wrapper for real (FAKE_GUEST), with a fake dmesg that prints $FAKE_DMESG; the "command" is a script that may add lines to it.
# guestrun <run id> <dmesg before> <script> [nodmesg]: the log of the run, lines joined by |
GB=$T/guestbin; GN=$T/guestbin-nodmesg; mkdir -p "$GB" "$GN"
for t in sh grep tail sed cat; do ln -sf "$(command -v $t)" "$GB/$t"; ln -sf "$(command -v $t)" "$GN/$t"; done
printf '#!/bin/sh\ncat "$FAKE_DMESG" 2>/dev/null\n' > "$GB/dmesg"; chmod +x "$GB/dmesg"
guestrun() {
    local cmd; cmd=$(printf 'sh\0-c\0%s' "$3" | base64 -w0)
    setup; vmbox "$box"; printf %s "$2" > "$T/e/dmesg"
    export FAKE_GUEST=$GB FAKE_DMESG=$T/e/dmesg; [ "${4:-}" != nodmesg ] || FAKE_GUEST=$GN
    pod "pod run $box --vm --detach $1 -- $cmd"
    until grep -q '^EXIT' "$W/jobs/$box/runs/$1.log" 2>/dev/null; do sleep 0.05; done   # shortcut: polls for the condition itself, never a time limit
    unset FAKE_GUEST FAKE_DMESG
    paste -sd'|' "$W/jobs/$box/runs/$1.log"
}
K0='[    3.1] Out of memory: Killed process 77 (old) total-vm:1kB'
ADD='echo "[   99.9] Out of memory: Killed process 1234 (python) total-vm:9kB" >> "$FAKE_DMESG"'
eq "guest kill during a detached machine run: the prefixed line comes before EXIT" \
    "out|[boxd] guest kernel: Out of memory: Killed process 1234 (python) total-vm:9kB|EXIT 0" "$(guestrun 20261116-100000-0001 "" "echo out; $ADD")"
eq "guest kill: the command's exit code is kept" "out|[boxd] guest kernel: Out of memory: Killed process 1234 (python) total-vm:9kB|EXIT 7" "$(guestrun 20261116-100000-0002 "" "echo out; $ADD; exit 7")"
guestrun 20261116-100000-0003 "" "echo out" >/dev/null
eq "no guest kill: the log is as before, byte for byte" $'out\nEXIT 0' "$(cat "$W/jobs/$box/runs/20261116-100000-0003.log")"
guestrun 20261116-100000-0004 "$K0"$'\n' "echo out" >/dev/null
eq "a kill line from before the run is not repeated" $'out\nEXIT 0' "$(cat "$W/jobs/$box/runs/20261116-100000-0004.log")"
eq "only the kill after the count is printed" "out|[boxd] guest kernel: Out of memory: Killed process 1234 (python) total-vm:9kB|EXIT 0" "$(guestrun 20261116-100000-0005 "$K0"$'\n' "echo out; $ADD")"
# No dmesg in the guest (the plain Void image): the kernel's own device is read, a record is "level,sequence,time,flags;text".
GK=$T/guestbin-kmsg; mkdir -p "$GK"; for x in sh grep tail sed cat dd; do ln -sf "$(command -v $x)" "$GK/$x"; done
ADDK='echo "3,7,99,-;Out of memory: Killed process 1234 (python) total-vm:9kB" >> "$BOXD_KMSG"'
export BOXD_KMSG=$T/kmsg; printf '6,1,1,-;boot\n3,2,3,-;Out of memory: Killed process 77 (old) total-vm:1kB\n' > "$BOXD_KMSG"
GN_KEEP=$GN; GN=$GK
eq "a guest without dmesg: the kill line is read from the kernel's device, an older one is not repeated" \
    "out|[boxd] guest kernel: Out of memory: Killed process 1234 (python) total-vm:9kB|EXIT 7" "$(guestrun 20261116-100000-0016 "" "echo out; $ADDK; exit 7" nodmesg)"
GN=$GN_KEEP; unset BOXD_KMSG
eq "a guest with neither dmesg nor a readable device: the command and its exit code, nothing added" "out|EXIT 7" "$(guestrun 20261116-100000-0006 "" "echo out; $ADD; exit 7" nodmesg)"
setup; vmbox "$box"; pod "pod run $box --vm -- $B64"
eq "a foreground machine call is not wrapped" 0 "$(grep '/job/src' "$FAKE_MSB_LOG" | grep -c ' sh -c ')"
setup; pod "pod run $box --detach 20261116-100000-0007 -- $B64"
until grep -q '^EXIT' "$W/jobs/$box/runs/20261116-100000-0007.log" 2>/dev/null; do sleep 0.05; done
eq "a container box run is not wrapped" 0 "$(grep -c 'sh -c' "$FAKE_LOG")"
setup; FAKE_EXEC_EXIT=2 pod "pod run $box --vm -- $B64"; eq "foreground, machine alive: no note" "2 0" "$rc $(grep -c '^boxd:' "$T/e/err")"

# pod ps on a stopped machine box: says it is a machine, stopped, and what the next call does
setup; vmbox "$box" stopped; pod "pod ps $box"
eq "pod ps: a stopped machine box" "0 boxd-pod: virtual machine box $box is stopped; the next command in it starts it again, when the host has room" "$rc $(cat "$T/e/err")"

# Reap: stale sandboxes go with msb rm -f; fresh, run-held and lock-held ones stay; none at all before the boot marker
setup
: > "$BOXD_POD_CLEAN"
for b in old fresh held locked crashedold; do vmbox $b; done
vmbox crashedold crashed
mkdir -p "$W/jobs"/{old,fresh,held,locked,crashedold}
touch -d @100 "$W/jobs/old/.last-used" "$W/jobs/held/.last-used" "$W/jobs/locked/.last-used" "$W/jobs/crashedold/.last-used"
touch -d @1000 "$W/jobs/fresh/.last-used"
: > "$W/jobs/held/.running"
flock -s "$W/jobs/held/.running" sh -c "echo held >&3; read x < '$T/e/rel'" &
h1=$!; read -r _ <&3
flock -x "$W/jobs/locked/.lock" sh -c "echo held >&3; read x < '$T/e/rel'" &
h2=$!; read -r _ <&3
reapnow 2000
eq "vm reap: stale and crashed sandboxes go, fresh, run-held and lock-held stay" "pod-fresh pod-held pod-locked" "$(ls "$FAKE_VM_STATE" | paste -sd' ')"
eq "vm reap names what it removed like containers" "reaped crashedold|reaped old" "$(sort "$T/e/out" | paste -sd'|')"
eq "vm reap removes with msb rm -f" "rm -f pod-crashedold|rm -f pod-old" "$(grep '^rm' "$FAKE_MSB_LOG" | sort | paste -sd'|')"
exec 6>"$T/e/rel"; exec 6>&-
wait "$h1" "$h2"
setup
vmbox old; echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-cold"
mkdir -p "$W/jobs"/{old,cold}; touch -d @100 "$W/jobs/old/.last-used" "$W/jobs/cold/.last-used"
reapnow 2000
eq "reap before the boot marker: sandboxes stay" "pod-old" "$(ls "$FAKE_VM_STATE")"
eq "reap before the boot marker: containers still go" "" "$(ls "$FAKE_STATE")"
eq "reap before the boot marker makes no msb call at all" "" "$(cat "$FAKE_MSB_LOG")"

# clear: both engines, local only
setup
echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-c1"; vmbox v1; vmbox v2 stopped
echo "docker.io/library/debian:stable-slim running" > "$FAKE_VM_STATE/other"   # not a box: never touched
bash "$POD" clear </dev/null >"$T/e/out" 2>&1; rc=$?
eq "clear exits 0 and prints cleared" "0 cleared" "$rc $(cat "$T/e/out")"
eq "clear: podman rm -af" "rm -af" "$(cat "$FAKE_LOG")"
eq "clear: msb rm -f once per pod-* sandbox, others untouched" "rm -f pod-v1|rm -f pod-v2" "$(grep '^rm' "$FAKE_MSB_LOG" | sort | paste -sd'|')"
eq "clear leaves no box" "other" "$(ls "$FAKE_VM_STATE")"
pod "pod clear"; eq "clear is not reachable over ssh" 125 "$rc"
# clear: a detached run gets SIGTERM before its box goes
setup
mkdir -p "$W/jobs/x/runs"
sp=$(setsid sh -c 'sleep 1000 </dev/null >/dev/null 2>&1 & echo $!')
pg=$(ps -o pgid= -p "$sp" | tr -d ' ')
echo "$pg" > "$W/jobs/x/runs/r1.pid"; echo 999999999 > "$W/jobs/x/runs/stale.pid"
bash "$POD" clear </dev/null >"$T/e/out" 2>&1; rc=$?
eq "clear: exits 0 with live and stale run records" "0 cleared" "$rc $(cat "$T/e/out")"
eq "clear: the detached run was terminated" no "$(kill -0 "$sp" 2>/dev/null && echo alive || echo no)"
eq "clear: run records removed" "" "$(ls "$W/jobs/x/runs")"

# Every msb call sees the state folder and HOME
setup
pod "pod run $box --vm -- $B64"
eq "every msb call has MSB_HOME under the work folder and a HOME" "MSB_HOME=$W/cache/msb HOME=set" "$(sort -u "$FAKE_MSB_ENV")"
eq "the state folder was made" yes "$([ -d "$W/cache/msb" ] && echo yes || echo no)"

# Settings file: vm limits and room
setup; printf 'BOXD_VM_LIMITS="-c 2 -m 1G"\nBOXD_VM_MAX=1\n' > "$T/pod.conf"
BOXD_CONF="$T/pod.conf" pod "pod run b1 --vm -- $B64"
eq "settings file sets the vm limits" "yes" "$(grep -q -- '^create .* -c 2 -m 1G docker' "$FAKE_MSB_LOG" && echo yes || echo no)"
BOXD_CONF="$T/pod.conf" pod "pod run b2 --vm -- $B64"
eq "settings file sets the vm maximum" "75 boxd-pod: no room for another virtual machine (1 of 1 running); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
BOXD_CONF="$T/pod.conf" pod "pod run b1 --vm -- $B64"; eq "the running box itself is not refused at the maximum" 0 "$rc"

# Sizes: the record in the job folder, kept by a later call, replaced by --recreate
setup
pod "pod run $box --vm --size small -- $B64"; eq "the size is recorded at creation" small "$(cat "$W/jobs/$box/.vm-size")"
pod "pod run $box --vm -- $B64"; eq "a later call without --size keeps it" "small" "$(cat "$W/jobs/$box/.vm-size")"
pod "pod run $box --vm --recreate --size medium -- $B64"; eq "--recreate with --size records the new size" medium "$(cat "$W/jobs/$box/.vm-size")"
pod "pod run $box --vm --recreate -- $B64"; eq "--recreate without --size keeps the recorded size" medium "$(cat "$W/jobs/$box/.vm-size")"
pod "pod run $box --vm --size large -- $B64"; eq "a refused size change leaves the record" "125 medium" "$rc $(cat "$W/jobs/$box/.vm-size")"
# A refused creation records nothing
setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'anon %s\n' $((30000 * 1048576)) > "$BOXD_CGROOT/boxd/memory.stat"; echo $((28672 * 1048576)) > "$BOXD_CGROOT/boxd/memory.max"
pod "pod run $box --vm --size small -- $B64"; eq "a refused creation records no size" "75 no" "$rc $([ -e "$W/jobs/$box/.vm-size" ] && echo yes || echo no)"
# memory.max "max": the cap is MemTotal of /proc/meminfo. Machine independent: an idle group admits the small size
# (a host under 2 GB is not a build server), a petabyte of use is refused and names MemTotal as the cap.
setup; mkdir -p "$BOXD_CGROOT/boxd"; echo max > "$BOXD_CGROOT/boxd/memory.max"; printf 'anon 0\nshmem 0\n' > "$BOXD_CGROOT/boxd/memory.stat"
pod "pod run $box --vm --size small -- $B64"; eq "cap max: an idle group admits a small machine" 0 "$rc"
mt=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
printf 'anon 1125899906842624\nshmem 0\n' > "$BOXD_CGROOT/boxd/memory.stat"
pod "pod run b2 --vm -- $B64"
eq "cap max: the cap is MemTotal in megabytes" "75 boxd-pod: no room for another virtual machine (1073741824 MB in use + 8192 MB asked > $mt MB cap); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
# BOXD_CGROUP names the cgroup folder itself (systemd hosts: the boxd-sshd unit's cgroup); it wins over BOXD_CGROOT/boxd
setup; mkdir -p "$T/e/unit-cg" "$BOXD_CGROOT/boxd"; printf 'anon %s\n' $((30000 * 1048576)) > "$BOXD_CGROOT/boxd/memory.stat"; echo $((28672 * 1048576)) > "$BOXD_CGROOT/boxd/memory.max"
printf 'anon 0\nshmem 0\n' > "$T/e/unit-cg/memory.stat"; echo $((28672 * 1048576)) > "$T/e/unit-cg/memory.max"
BOXD_CGROUP="$T/e/unit-cg" pod "pod run $box --vm --size small -- $B64"; eq "BOXD_CGROUP: the named cgroup is measured (idle, admits), the default folder is not" 0 "$rc"
pod "pod run b2 --vm --size small -- $B64"; eq "without BOXD_CGROUP the default folder is measured (full, refuses)" 75 "$rc"
# A machine listing that fails for a moment, at whichever of the call's listings: the count ceiling never admits on it
# Commitment: measured memory alone admits machines that have not claimed theirs yet (2026-11-15: twelve medium machines
# on a 28 GB cap). The sizes of the running machines plus the asked size must fit BOXD_VM_COMMIT percent of the cap.
cg8() { setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'anon 0\nshmem 0\n' > "$BOXD_CGROOT/boxd/memory.stat"; echo $((8192 * 1048576)) > "$BOXD_CGROOT/boxd/memory.max"; }
# Default 100 since 0.4.8: at 150 the tower admitted 36 GB of machines on its 28 GB cap and the kernel killed one.
cg8; for b in b1 b2; do pod "pod run $b --vm --size medium -- $B64"; eq "commitment: machine $b fits the cap" 0 "$rc"; done
pod "pod run b3 --vm --size small -- $B64"
eq "commitment: an idle group still refuses past the cap" "75 boxd-pod: no room for another virtual machine (8192 MB of running machines + 2048 MB asked > 8192 MB, 100% of the 8192 MB cap); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
eq "commitment: a refused machine records no size" no "$([ -e "$W/jobs/b3/.vm-size" ] && echo yes || echo no)"
pod "pod run b1 --vm -- $B64"; eq "commitment: a running machine is not counted against itself" 0 "$rc"
pod "pod stop b2"; pod "pod run b3 --vm --size small -- $B64"; eq "commitment: a stopped machine frees its size" 0 "$rc"
# Idle machines give their room back (owner, 2026-11-16: an idle 8 GB machine held a slot on a full host for the reaper's 30
# minutes). Idle: unused for BOXD_VM_IDLE_MIN seconds and no run or call in it. The longest unused goes first.
hasvm() { [ -e "$FAKE_VM_STATE/pod-$1" ] && echo yes || echo no; }
cg8; for b in b1 b2; do pod "pod run $b --vm --size medium -- $B64"; done
pod "pod run b3 --vm --size small -- $B64"; eq "idle: machines used a moment ago are not idle, the call is refused and both stay" "75 yes yes" "$rc $(hasvm b1) $(hasvm b2)"
touch -d @100 "$W/jobs/b1/.last-used"; touch -d @200 "$W/jobs/b2/.last-used"
pod "pod status"; eq "idle: pod status answers with the room idle machines would give" $'vm_room=yes\tvm_fit_mb=8192' "$(tr '\t' '\n' < "$T/e/out" | grep -E '^(vm_room|vm_fit_mb)=' | paste -sd'\t')"
eq "idle: pod status removes nothing" "yes yes" "$(hasvm b1) $(hasvm b2)"
pod "pod run b3 --vm --size small -- $B64"; eq "idle: the longest unused machine goes, no more than needed, and the call is admitted" "0 no yes" "$rc $(hasvm b1) $(hasvm b2)"
eq "idle: the caller is told in one line, in boxd's words" "boxd-pod: the idle machine of box b1 was removed to make room for this one" "$(grep -i 'removed' "$T/e/err")"
eq "idle: the removal is logged where pod report reads it" "b1	idle machine removed, b3 asked for room" "$(cut -f2- "$W/cache/evictions.log")"
eq "idle: the removed machine's folder stays" yes "$([ -d "$W/jobs/b1" ] && echo yes || echo no)"
# b2 (medium, idle) and b3 (small, just used) run. A large machine cannot fit even without b2: nothing is removed for nothing.
pod "pod run b4 --vm -- $B64"; eq "idle: no machine is removed when the busy ones alone refuse the call" "75 yes" "$rc $(hasvm b2)"
# A run in flight holds .running shared: such a machine is never idle, however old its stamp.
exec 8<"$W/jobs/b2/.running"; flock -s 8
pod "pod run b5 --vm --size medium -- $B64"; eq "idle: a machine with a run in flight is not removed" "75 yes" "$rc $(hasvm b2)"
exec 8<&-
pod "pod run b5 --vm --size medium -- $B64"; eq "idle: once its run has ended it goes" "0 no" "$rc $(hasvm b2)"
cg8; pod "pod run b1 --vm --size medium -- $B64"; touch -d @100 "$W/jobs/b1/.last-used"
CASE_ENV=(BOXD_VM_IDLE_MIN=99999999999); pod "pod run b2 --vm -- $B64"; eq "idle: BOXD_VM_IDLE_MIN sets how long unused counts as idle" "75 yes" "$rc $(hasvm b1)"
CASE_ENV=()
cg8; for b in b1 b2 b3; do BOXD_VM_COMMIT=150 pod "pod run $b --vm --size medium -- $B64"; done; eq "BOXD_VM_COMMIT=150: sizes up to 150% of the cap fit" 0 "$rc"
BOXD_VM_COMMIT=150 pod "pod run b4 --vm --size small -- $B64"; eq "BOXD_VM_COMMIT=150: nothing past 150% of the cap" 75 "$rc"
# Replay of the tower, 2026-11-15 13:38: seven medium machines on the 28 GB cap, then an 8 GB one. At 150 it was admitted
# (36864 MB of sizes) and the host ran out of memory; the default now refuses it.
setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'anon 0\nshmem 0\n' > "$BOXD_CGROOT/boxd/memory.stat"; echo $((28672 * 1048576)) > "$BOXD_CGROOT/boxd/memory.max"
for b in m1 m2 m3 m4 m5 m6 m7; do pod "pod run $b --vm --size medium -- $B64"; done; eq "replay: seven medium machines fit the 28 GB cap" 0 "$rc"
pod "pod run r2080 --vm -- $B64"
eq "replay: the eighth machine, 8 GB, is refused" "75 boxd-pod: no room for another virtual machine (28672 MB of running machines + 8192 MB asked > 28672 MB, 100% of the 28672 MB cap); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
# Swapped-out memory is still in use: the measure read anon and shmem only, which leave RAM when swapped, so a group at
# its cap with 7.7 GB in swap read 23713 MB in use and kept admitting machines.
cg8; printf 'anon %s\nshmem 0\n' $((4096 * 1048576)) > "$BOXD_CGROOT/boxd/memory.stat"; echo $((3072 * 1048576)) > "$BOXD_CGROOT/boxd/memory.swap.current"
pod "pod run b1 --vm --size small -- $B64"
eq "swapped memory counts as in use" "75 boxd-pod: no room for another virtual machine (7168 MB in use + 2048 MB asked > 8192 MB cap); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
pod "pod status"; eq "pod status: free memory counts swapped memory as used" mem_free_mb=1024 "$(tr '\t' '\n' < "$T/e/out" | grep '^mem_free_mb=')"
echo $((9000 * 1048576)) > "$BOXD_CGROOT/boxd/memory.swap.current"; pod "pod status"
eq "pod status: free memory is never below zero" mem_free_mb=0 "$(tr '\t' '\n' < "$T/e/out" | grep '^mem_free_mb=')"
# pod status carries the host's own memory next to the group's accounting (2026-11-16: mem_free_mb read 0 while 9.5 GB were available).
# The three new words have the meaning and the code of the host line of pod report; mem_free_mb stays as it was.
cg8; printf 'MemTotal: 32768000 kB\nMemAvailable: 9216000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' > "$W/meminfo"; echo $((3 * 1048576)) > "$BOXD_CGROOT/boxd/memory.swap.current"
CASE_ENV=(BOXD_MEMINFO="$W/meminfo"); pod "pod status"
eq "pod status: after images come the host's available memory and the group's used and maximum" $'mem_avail_mb=9000\tgroup_mem_used_mb=3\tgroup_mem_max_mb=8192' "$(awk -F'\t' '{ print $(NF-4) "\t" $(NF-3) "\t" $(NF-2) }' "$T/e/out")"
eq "pod status: mem_free_mb stays the group's accounting" mem_free_mb=8189 "$(tr '\t' '\n' < "$T/e/out" | grep '^mem_free_mb=')"
pod "pod report"; eq "pod report: its host line has the same three figures as pod status" $'mem_avail_mb=9000\tgroup_mem_max_mb=8192\tgroup_mem_used_mb=3' "$(head -1 "$T/e/out" | tr '\t' '\n' | grep -E '^(mem_avail_mb|group_mem_max_mb|group_mem_used_mb)=' | paste -sd'\t')"
CASE_ENV=()

# The version `pod status` prints is the release version: the one of the package template (0.4.0 was printed by a 0.4.9 package).
eq "VERSION of server/boxd-pod equals version= of srcpkgs/boxd/template" "$(sed -n 's/^version=//p' "$HERE/srcpkgs/boxd/template")" "$(sed -n 's/^VERSION=\([0-9.]*\).*/\1/p' "$HERE/server/boxd-pod")"

# pod help: one line per command, read only, also for a key that may only read; an extra word is an unknown command.
setup; pod "pod help"; eq "pod help: exit 0" 0 "$rc"
for c in run stop drop list ps status report calls log forward image help; do eq "pod help names '$c'" 1 "$(grep -c "^pod $c " "$T/e/out")"; done
eq "pod help: no stamp, no call log line, no engine call" "no|no|" "$([ -e "$W/cache/calls.log" ] && echo yes || echo no)|$(ls "$W/jobs" 2>/dev/null | grep -q . && echo yes || echo no)|$(cat "$FAKE_LOG" 2>/dev/null)"
pod "pod help me"; eq "pod help with an extra word is an unknown command" "125 boxd-pod: unknown command" "$rc $(cat "$T/e/err")"
KEYA=AAAAC3NzaC1lZDI1NTE5AAAAIviewviewviewviewviewviewviewviewviewviewview
printf 'ssh-ed25519 %s dashboard\n' "$KEYA" > "$W/view_keys"; printf 'publickey ssh-ed25519 %s\n' "$KEYA" > "$W/auth"
CASE_ENV=(BOXD_VIEW_KEYS="$W/view_keys" SSH_USER_AUTH="$W/auth"); pod "pod help"; eq "pod help: a key that may only read may ask" 0 "$rc"; CASE_ENV=()

cg8; BOXD_VM_COMMIT=lots pod "pod run b1 --vm --size small -- $B64"; eq "BOXD_VM_COMMIT must be a number" "125 boxd-pod: BOXD_VM_COMMIT must be a number" "$rc $(cat "$T/e/err")"
# Container boxes count in the commitment (2026-11-15: the build running at the kill was in a container box, outside the rule).
# ctrcg <anon MB> <swapped MB>: one running container box x whose init process 4242 has that much memory.
ctrcg() {
    echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-x"
    mkdir -p "$T/e/proc/4242" "$BOXD_CGROOT/user.slice/ctr"; echo "0::/user.slice/ctr" > "$T/e/proc/4242/cgroup"
    printf 'anon %s\nshmem 0\nfile %s\n' $(($1 * 1048576)) $((9999 * 1048576)) > "$BOXD_CGROOT/user.slice/ctr/memory.stat"   # file cache is not counted
    echo $(($2 * 1048576)) > "$BOXD_CGROOT/user.slice/ctr/memory.swap.current"
    CASE_ENV=(FAKE_CPID=4242 BOXD_PROC="$T/e/proc")
}
cg8; pod "pod run b1 --vm --size medium -- $B64"; ctrcg 3072 1024; pod "pod run b2 --vm --size small -- $B64"
eq "container memory counts in the commitment" "75 boxd-pod: no room for another virtual machine (4096 MB of running machines + 4096 MB used by container boxes + 2048 MB asked > 8192 MB, 100% of the 8192 MB cap); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
rm -f "$FAKE_STATE/pod-x"; pod "pod run b2 --vm --size small -- $B64"; eq "the same machines without container memory are admitted" 0 "$rc"
cg8; ctrcg 2048 0; pod "pod run b1 --vm --size small -- $B64"; eq "container memory alone does not refuse when everything fits" 0 "$rc"
cg8; ctrcg 1024 0; pod "pod status"; eq "pod status: no room for a large machine once a container box uses memory" vm_room=no "$(tr '\t' '\n' < "$T/e/out" | grep '^vm_room=')"
eq "pod status: vm_why comes before the last word and says why no machine fits" "vm_why=0 MB of running machines + 1024 MB used by container boxes + 8192 MB asked > 8192 MB, 100% of the 8192 MB cap" "$(awk -F'\t' '{ print $(NF-1) }' "$T/e/out")"
rm -f "$FAKE_STATE/pod-x"; pod "pod status"; eq "pod status: room for a large machine on an idle cap" vm_room=yes "$(tr '\t' '\n' < "$T/e/out" | grep '^vm_room=')"
eq "pod status: vm_why is empty when a machine fits" vm_why= "$(awk -F'\t' '{ print $(NF-1) }' "$T/e/out")"
eq "pod status: vm_fit_mb is the last word, the whole cap on an idle host" vm_fit_mb=8192 "$(awk -F'\t' '{ print $NF }' "$T/e/out")"
# vm_fit_mb: the largest machine `pod run` admits (the smaller of cap minus use and the commit share minus machines minus
# containers); the seam test runs pod run itself, with a machine of just under, exactly and just over that size.
fitword() { pod "pod status"; tr '\t' '\n' < "$T/e/out" | sed -n 's/^vm_fit_mb=//p'; }
seam() {   # seam <label>: pod run at fit-1, fit and fit+1 megabytes agrees with vm_fit_mb
    local F got="" d base=("${CASE_ENV[@]}"); F=$(fitword)
    for d in -1 0 1; do
        CASE_ENV=("${base[@]}" BOXD_VM_LIMITS="-c 2 -m $((F + d))M"); pod "pod run z --vm -- $B64"; got="$got $rc"; rm -f "$FAKE_VM_STATE/pod-z"
    done
    CASE_ENV=("${base[@]}"); eq "$1: pod run admits $((F - 1)) and $F MB and refuses $((F + 1)) MB, as vm_fit_mb=$F says" "$F 0 0 75" "$F$got"
}
cg8; ctrcg 1024 0; eq "vm_fit_mb: a container box using memory takes it from the cap" 7168 "$(fitword)"; seam "container box"
cg8; pod "pod run b1 --vm --size medium -- $B64"; eq "vm_fit_mb: a running 4096 MB machine leaves the other half of the cap" 4096 "$(fitword)"; seam "one machine"
ctrcg 1024 0; eq "vm_fit_mb: the commit rule is the smaller one beside a machine and a container box" 3072 "$(fitword)"; seam "machine and container box"
cg8; printf 'anon %s\nshmem 0\n' $((6144 * 1048576)) > "$BOXD_CGROOT/boxd/memory.stat"; eq "vm_fit_mb: the measured use is the smaller one when machines have not claimed their memory" 2048 "$(fitword)"; seam "measured use"
cg8; pod "pod run b1 --vm --size medium -- $B64"; CASE_ENV=(BOXD_VM_MAX=1); eq "vm_fit_mb: 0 at the count ceiling, however much memory is free" 0 "$(fitword)"; pod "pod run z --vm --size small -- $B64"; eq "vm_fit_mb=0 at the ceiling: pod run refuses even the smallest machine" 75 "$rc"
cg8; CASE_ENV=(BOXD_VM_COMMIT=50); eq "vm_fit_mb: BOXD_VM_COMMIT sets the share of the cap" 4096 "$(fitword)"
cg8; echo max > "$BOXD_CGROOT/boxd/memory.max"; rm "$BOXD_CGROOT/boxd/memory.stat"; CASE_ENV=()
eq "vm_fit_mb: a dash when the memory cannot be measured" - "$(fitword)"
CASE_ENV=()
cg8; ctrcg 0 0; CASE_ENV=(FAKE_CPID=4243 BOXD_PROC="$T/e/proc"); pod "pod run b1 --vm --size small -- $B64"
# A container whose memory cannot be read counts as its whole limit (12 GB by default); with no limit to assume, nothing is admitted.
eq "an unreadable running container counts as its limit" "75 boxd-pod: no room for another virtual machine (0 MB of running machines + 12288 MB used by container boxes + 2048 MB asked > 8192 MB, 100% of the 8192 MB cap); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
CASE_ENV=(FAKE_CPID=4243 BOXD_PROC="$T/e/proc" BOXD_LIMITS="--pids-limit 100"); pod "pod run b1 --vm --size small -- $B64"
eq "an unreadable running container with no limit refuses: it cannot be measured" "75 boxd-pod: no room for another virtual machine (the running container boxes cannot be measured now); wait for one to end or stop one" "$rc $(cat "$T/e/err")"
CASE_ENV=()
# Container boxes are made with a raised out-of-memory score: when the build cgroup hits its cap the kernel kills the
# grower, not a machine. The badness of a process is its memory plus score/1000 of the cgroup's limit, so 1000 adds the whole cap.
setup; pod "pod run $box -- $B64"
eq "a container box is created with a raised out-of-memory score" yes "$(grep -q '^run .* --oom-score-adj 1000 ' "$FAKE_LOG" && echo yes || echo no)"
# A command in a container box that the kernel's out-of-memory killer took (exit 137, the oom_kill counter rose): the run says so.
ctrkill() {   # ctrkill <exit code> <oom kills before> <after>: exit code and standard error of a foreground call
    setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'oom_kill %s\n' "$2" > "$BOXD_CGROOT/boxd/memory.events"
    CASE_ENV=(FAKE_EXEC_EXIT="$1" FAKE_EXEC_CRASH="$3"); pod "pod run $box -- $B64"; CASE_ENV=()
    echo "$rc $(cat "$T/e/err")"
}
eq "container, killed by the out-of-memory killer: exit 137 and the line" "137 boxd: the command in box $box was killed (exit 137): the host's out-of-memory killer ended a process of the boxes meanwhile (kernel log: dmesg)" "$(ctrkill 137 3 4)"
eq "container, exit 137 without a kill in the cgroup: no line" "137 " "$(ctrkill 137 3 3)"
eq "container, another exit code while a kill happened: no line" "1 " "$(ctrkill 1 3 4)"
setup; mkdir -p "$BOXD_CGROOT/boxd"; printf 'oom_kill 3\n' > "$BOXD_CGROOT/boxd/memory.events"
export FAKE_EXEC_EXIT=137 FAKE_EXEC_CRASH=4 FAKE_BLOCK_EXEC=1
pod "pod run $box --detach 20261115-140000-0001 -- $B64"; read -r _ <&3
exec 4< <(tail -n +1 -f "$W/jobs/$box/runs/20261115-140000-0001.log"); tp=$!
echo go > "$FAKE_REL"
while read -r l <&4; do [ "${l#EXIT}" != "$l" ] && break; done
kill "$tp" 2>/dev/null; exec 4<&-
unset FAKE_EXEC_EXIT FAKE_EXEC_CRASH FAKE_BLOCK_EXEC
eq "container, detached run killed by the out-of-memory killer: the log says so, then EXIT" "boxd: the command in box $box was killed (exit 137): the host's out-of-memory killer ended a process of the boxes meanwhile (kernel log: dmesg)|EXIT 137" "$(paste -sd'|' "$W/jobs/$box/runs/20261115-140000-0001.log")"
for k in 1 2 3 4 5 6; do
    setup; BOXD_VM_MAX=1 pod "pod run b1 --vm -- $B64"
    : > "$FAKE_MSB_LOG"; rm -f "$FAKE_VM_STATE/../ls-count"
    FAKE_LS_FAIL_AT=$k BOXD_VM_MAX=1 pod "pod run b2 --vm -- $B64"
    eq "listing $k of the call fails: no second machine is made past a ceiling of 1" "refused 0" "$([ "$rc" != 0 ] && echo refused || echo admitted) $(grep -c '^create' "$FAKE_MSB_LOG")"
done
# Unreadable cgroup with a count ceiling of its own: the ceiling is used, not 3
setup; BOXD_VM_MAX=1 pod "pod run b1 --vm -- $B64"; BOXD_VM_MAX=1 pod "pod run b2 --vm -- $B64"
eq "no cgroup files: BOXD_VM_MAX is the count limit" "75 boxd-pod: no room for another virtual machine (1 of 1 running); wait for one to end or stop one" "$rc $(cat "$T/e/err")"

# A vm box whose machine died is started again, not reused
setup; vmbox $box crashed
pod "pod run $box --vm -- $B64"
eq "crashed vm box: started, then used" "yes" "$(grep -q '^start pod-' "$FAKE_MSB_LOG" && echo yes || echo no)"

# The guest kernel's process numbers (2026-11-16): pid_max is raised to 32768 in the guest, in the call that already sets the guest
# up, at creation and at every start of a stopped machine, before the user's command; a running machine and a container box are left alone.
# pidlines: the order of the msb calls that raise it ("P") and run the user's command ("U"), joined
pidlines() { grep -E 'pid_max|/job/src' "$FAKE_MSB_LOG" | sed -E 's/.*pid_max.*/P/; s/.*\/job\/src.*/U/' | paste -sd' '; }
setup; pod "pod run $box --vm -- $B64"
eq "machine created: pid_max is raised in the guest before the user's command" "P U" "$(pidlines)"
eq "the raise is one write of 32768, in the call that also starts docker" 1 "$(grep -c 'exec -w / .*echo 32768 > /proc/sys/kernel/pid_max.*dockerd' "$FAKE_MSB_LOG")"
setup; vmbox "$box" stopped; pod "pod run $box --vm -- $B64"
eq "stopped machine started again: the raise runs again, before the command" "P U" "$(pidlines)"
setup; vmbox "$box"; pod "pod run $box --vm -- $B64"
eq "machine already running: no raise" "U" "$(pidlines)"
setup; pod "pod run $box -- $B64"
eq "container box: no raise" 0 "$(cat "$FAKE_LOG" "$FAKE_MSB_LOG" | grep -c pid_max)"
setup; FAKE_EXEC_OUT=hello FAKE_EXEC_EXIT=3 pod "pod run $box --vm -- $B64"; ok="$rc $(cat "$T/e/out") [$(cat "$T/e/err")]"
setup; FAKE_STARTER_EXIT=1 FAKE_EXEC_OUT=hello FAKE_EXEC_EXIT=3 pod "pod run $box --vm -- $B64"
eq "a guest that refuses the write: same exit code and output, nothing on standard error" "$ok" "$rc $(cat "$T/e/out") [$(cat "$T/e/err")]"

# Two first calls for two boxes with one slot left: one create, one refusal
setup; : > "$FAKE_VM_BLOCK"
export BOXD_VM_MAX=1
SSH_ORIGINAL_COMMAND="pod run b1 --vm -- $B64" bash "$POD" </dev/null >"$T/e/o1" 2>&1 &
p1=$!; read -r ev <&3; eq "first vm call is inside creation" create-blocked "$ev"
SSH_ORIGINAL_COMMAND="pod run b2 --vm -- $B64" bash "$POD" </dev/null >"$T/e/o2" 2>&1 &
p2=$!
ino=$(stat -c %i "$W/cache/vm-room.lock")
until grep -q -- "->.*:$ino " /proc/locks || ! kill -0 "$p2" 2>/dev/null; do :; done
eq "second vm call waits on the room lock, only the first has created" 1 "$(grep -c '^create' "$FAKE_MSB_LOG")"
echo go > "$FAKE_REL"
wait "$p1"; r1=$?; wait "$p2"; r2=$?
eq "one call succeeds, the other is refused for room (exit 75)" "0 75" "$r1 $r2"
eq "exactly one sandbox was created" 1 "$(grep -c '^create' "$FAKE_MSB_LOG")"
unset BOXD_VM_MAX

# Call log (read by the usage monitor): one tab separated line per pod run.
setup; mkdir -p "$W/cache"
pod "pod run $box -- $B64"
IFS=$(printf '\t') read -r t0 lb le lw lx ld lr < "$W/cache/calls.log"
eq "call log: box, engine and exit code of a run" "$box container 0" "$lb $le $lx"
eq "call log: start and duration are whole numbers" "yes yes" "$([[ $t0 =~ ^[0-9]{16}$ ]] && echo yes || echo no) $([[ $ld =~ ^[0-9]+$ ]] && echo yes || echo no)"
pod "pod run $box --image evil.example.com/x:1 -- $B64"
eq "call log: a refusal is logged with 125 and its reason" "125|image not allowed" "$(tail -1 "$W/cache/calls.log" | cut -f5,7 | tr '\t' '|')"
LC_ALL=it_IT.UTF-8 pod "pod run $box -- $B64"
eq "call log: an Italian locale (comma decimal separator) still logs" "0" "$(tail -1 "$W/cache/calls.log" | cut -f5)"
# A pushed image is logged like any call: engine, exit code, refusal reason
setup; mkdir -p "$W/cache"; STDIN=$T/e/archive; echo "docker.io/library/busybox:stable id-1" > "$STDIN"
pod "pod image load container docker.io/library/busybox:stable 0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef"
eq "call log: an image load is logged with its engine and exit code" "container 0" "$(tail -1 "$W/cache/calls.log" | cut -f3,5 | tr '\t' ' ')"
pod "pod image load container evil.example.com/x:1 0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef"
eq "call log: a refused image load is logged with 125 and its reason" "125|image not allowed" "$(tail -1 "$W/cache/calls.log" | cut -f5,7 | tr '\t' '|')"
STDIN=
setup
pod "pod run Bad_Name -- $B64"
eq "call log: a refusal before the cache folder exists makes neither the folder nor a log" "125 no" "$rc $([ -e "$W/cache" ] && echo yes || echo no)"

# pod report: what the cases cannot show. busy follows the run lock (a fifo, no clock); mem_mb comes from the box's own
# process; the dockerd log is not a run; no verb of the report writes anything.
rfield() { grep -P "^box\tbox=$1\t" "$T/e/out" | tr '\t' '\n' | sed -n "s/^$2=//p"; }   # rfield <box> <key>: one value of a box line
setup
echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-x"; echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-y"
mkdir -p "$W/jobs/x/runs" "$W/jobs/y"; : > "$W/jobs/x/.running"; echo "EXIT 0" > "$W/jobs/x/runs/dockerd.log"
flock -s "$W/jobs/x/.running" sh -c "echo held >&3; read x < '$T/e/rel'" &
h1=$!; read -r _ <&3
pod "pod list"   # makes the machine engine's own home folder, as every call that lists boxes does
before=$(find "$W" | sort | md5sum)
pod "pod report"
eq "report: a box whose run lock is held is busy" yes "$(rfield x busy)"
eq "report: a box with no run lock file is not busy" no "$(rfield y busy)"
eq "report: the dockerd log is not a run" "" "$(grep -c '^run' "$T/e/out" | sed 's/^0$//')"
eq "report, calls and log write nothing (no stamp, no lock, no folder)" "$before" "$(pod 'pod calls'; pod 'pod log x dockerd'; find "$W" | sort | md5sum)"
exec 6>"$T/e/rel"; exec 6>&-; wait "$h1"
pod "pod report"; eq "report: the box is not busy once the run ended" no "$(rfield x busy)"
recent=$(($(date +%s) - 60)); mkdir -p "$W/cache"; printf '1000\told\tunused 14 days\n%s\tws-1\tdisk 71 percent full\n' "$recent" > "$W/cache/evictions.log"
pod "pod report"; eq "report: what retention removed in the last day, one line each; older lines are left out" "evicted	at=$recent	box=ws-1	reason=disk 71 percent full" "$(grep '^evicted' "$T/e/out")"
rm -f "$W/cache/evictions.log"
setup
echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-x"; echo "docker.io/library/debian:stable-slim stopped" > "$FAKE_STATE/pod-z"
mkdir -p "$T/e/proc/4242" "$BOXD_CGROOT/user.slice/ctr"; echo "0::/user.slice/ctr" > "$T/e/proc/4242/cgroup"; printf 3145728000 > "$BOXD_CGROOT/user.slice/ctr/memory.current"
CASE_ENV=(FAKE_CPID=4242 BOXD_PROC="$T/e/proc"); pod "pod report"
eq "report: a running container's memory is its cgroup's memory.current" 3000 "$(rfield x mem_mb)"
eq "report: a stopped container has no memory" - "$(rfield z mem_mb)"
CASE_ENV=(FAKE_CPID=0 BOXD_PROC="$T/e/proc"); pod "pod report"; eq "report: a container whose process is unknown shows a dash" - "$(rfield x mem_mb)"
CASE_ENV=(FAKE_CPID=4243 BOXD_PROC="$T/e/proc"); pod "pod report"; eq "report: a container whose cgroup cannot be read shows a dash" - "$(rfield x mem_mb)"
setup
echo "localhost/toolbox:latest running" > "$FAKE_VM_STATE/pod-v"; echo "localhost/toolbox:latest stopped" > "$FAKE_VM_STATE/pod-w"
mkdir -p "$T/e/proc/4343"; printf 'Name:\tmsb\nVmRSS:\t 2097152 kB\n' > "$T/e/proc/4343/status"
CASE_ENV=(FAKE_VM_PID=4343 BOXD_PROC="$T/e/proc"); pod "pod report"
eq "report: a running machine's memory is the resident memory of its process" 2048 "$(rfield v mem_mb)"
eq "report: a machine without a size record is large" "8192 large" "$(rfield v mem_limit_mb) $(rfield v size)"
eq "report: a stopped machine has no memory" - "$(rfield w mem_mb)"
CASE_ENV=(BOXD_PROC="$T/e/proc"); pod "pod report"; eq "report: a machine whose process is not found shows a dash" - "$(rfield v mem_mb)"
CASE_ENV=()

# The call log keeps its columns: control characters and tabs in a command become spaces, the command is cut at 200 characters,
# a value handed over with --env is never in it.
setup; mkdir -p "$W/cache"
echo "docker.io/library/debian:stable-slim running" > "$FAKE_STATE/pod-$box"
pod "pod run $box -- $(printf 'a\tb\033[31mc\r\nd\0e' | base64 -w0)"
eq "call log: tabs and control characters of a command become spaces, the line stays whole" "1 9 a b [31mc  d e" "$(wc -l < "$W/cache/calls.log") $(awk -F'\t' '{ print NF }' "$W/cache/calls.log") $(cut -f9 "$W/cache/calls.log")"
: > "$W/cache/calls.log"
pod "pod run $box -- $(head -c 300 /dev/zero | tr '\0' x | base64 -w0)"
eq "call log: the command is cut at 200 characters" 200 "$(cut -f9 "$W/cache/calls.log" | tr -d '\n' | wc -c)"
: > "$W/cache/calls.log"
CASE_ENV=(BOXD_SECRET_API_TOKEN=s3cr3t-value-0042); pod "pod run $box --env API_TOKEN -- $B64"; rc1=$rc; CASE_ENV=()
eq "call log: a run with --env succeeds and logs a full line" "0 1" "$rc1 $(wc -l < "$W/cache/calls.log")"
eq "call log: the value handed over with --env is in no column" 0 "$(grep -c s3cr3t-value-0042 "$W/cache/calls.log")"
CASE_ENV=(BOXD_SECRET_API_TOKEN=s3cr3t-value-0042); pod "pod run $box --env API_TOKEN --bogus -- $B64"; CASE_ENV=()
eq "call log: a refusal after --env does not log the value either" 0 "$(grep -c s3cr3t-value-0042 "$W/cache/calls.log")"

# pod calls and pod log: whole lines, and a reader that follows next always reaches size, also over a line longer than the limit
setup; mkdir -p "$W/cache"; printf 'aaaaaaaaaaaa\nb\nc\n' > "$W/cache/calls.log"
got=$T/e/got; : > "$got"; off=0
for ((steps = 0; steps < 20; steps++)); do
    CASE_ENV=(BOXD_READ_MAX=5); pod "pod calls $off"
    tail -n +2 "$T/e/out" >> "$got"
    next=$(head -1 "$T/e/out" | sed 's/.*next=//'); [ "$next" -gt "$off" ] || break
    off=$next
done
CASE_ENV=()
eq "pod calls: a reader following next gets every byte, also over a line longer than the limit" yes "$(cmp -s "$got" "$W/cache/calls.log" && echo yes || echo no)"
eq "pod calls: an offset with leading zeros is a decimal number" "from=8" "$(pod 'pod calls 008'; head -1 "$T/e/out" | cut -f3)"
pod "pod calls 1234567890123456789"; eq "pod calls: an offset of 19 digits is refused" 125 "$rc"
pod "pod log x r1 -1"; eq "pod log: a negative offset is refused" 125 "$rc"
mkdir -p "$W/jobs/x/runs"; echo secret > "$T/e/outside"; ln -s "$T/e/outside" "$W/jobs/x/runs/link.log"; pod "pod log x link 0"; eq "pod log: a link in the runs folder is no run (a box writes that folder)" "125 boxd-pod: no run link in box x" "$rc $(cat "$T/e/err")"

# Keys that may only read: more than the cases. Only an exact match of the key limits a login; a list with no entry limits nobody.
KEYA=AAAAC3NzaC1lZDI1NTE5AAAAIviewviewviewviewviewviewviewviewviewviewview
setup; printf '# none yet\n\n' > "$W/view_keys"; printf 'publickey ssh-ed25519 %s\n' "$KEYA" > "$W/auth"
CASE_ENV=(BOXD_VIEW_KEYS="$W/view_keys" SSH_USER_AUTH="$W/auth"); pod "pod list"; eq "view keys: a list with comments only limits nobody" 0 "$rc"
printf 'ssh-ed25519 %s dashboard\n' "$KEYA" > "$W/view_keys"
for v in "pod status" "pod list" "pod report" "pod calls" "pod calls 0" "pod log boxd-2889387319 r1 0" "pod ps nobox"; do
    pod "$v"; eq "view keys: '$v' is not refused for being a write" 0 "$(grep -c 'may only read' "$T/e/err")"
done
for v in "pod clear" "pod reap" "pod image has container docker.io/library/busybox:stable 0123456789ab" "pod run x --detach r1 -- $B64" "podman ps" "ls"; do
    pod "$v"; eq "view keys: '${v:0:30}' is refused" "125 boxd-pod: this key may only read" "$rc $(cat "$T/e/err")"
done
printf 'publickey ssh-ed25519 %s\n' "${KEYA%view}" > "$W/auth"; pod "pod run $box -- $B64"; eq "view keys: a key that only begins like a listed one keeps every command" 0 "$rc"
printf 'publickey ssh-rsa %s\n' "$KEYA" > "$W/auth"; pod "pod run $box -- $B64"; eq "view keys: the same text under another key type keeps every command" 0 "$rc"
printf 'password\n' > "$W/auth"; pod "pod list"; eq "view keys: an auth file without a public key line fails closed" "125 boxd-pod: view keys are set but the login key is hidden; add ExposeAuthInfo yes to the build sshd" "$rc $(cat "$T/e/err")"
CASE_ENV=(BOXD_VIEW_KEYS="$W/view_keys" SSH_USER_AUTH="$W/nofile"); pod "pod run $box -- $B64"; eq "view keys: an auth file that does not exist fails closed, also for a write" 125 "$rc"
if [ "$(id -u)" != 0 ]; then
    chmod 000 "$W/view_keys"; CASE_ENV=(BOXD_VIEW_KEYS="$W/view_keys" SSH_USER_AUTH="$W/auth"); pod "pod list"
    eq "view keys: a list the build account cannot read fails closed" "125 boxd-pod: view keys cannot be read" "$rc $(cat "$T/e/err")"; chmod 644 "$W/view_keys"
fi
CASE_ENV=(BOXD_VIEW_KEYS="$W/missing"); pod "pod run $box -- $B64"; eq "view keys: no list file means no key is limited" 0 "$rc"
CASE_ENV=()

# Retention (owner decision 2026-11-14: boxd keeps the host clean, nobody cleans by hand). The reaper removes whole box
# folders: unused for BOXD_KEEP_DAYS (14), or, when the work area is BOXD_EVICT_AT (70) percent full, the least
# recently used idle one per pass until it is under BOXD_EVICT_TO (60). A folder in use is never taken.
folders() { ls "$W/jobs" | paste -sd' '; }
evlog() { cut -f2- "$W/cache/evictions.log" 2>/dev/null | paste -sd'|'; }
setup; day=86400
mkdir -p "$W/cache" "$W/jobs"/{ancient,recent,busy,making,bare}/src
touch -d @1000 "$W/jobs/ancient/.last-used" "$W/jobs/busy/.last-used" "$W/jobs/making/.last-used" "$W/jobs/bare"
touch -d @$((10 * day)) "$W/jobs/recent/.last-used"
echo "debian stopped" > "$FAKE_STATE/pod-ancient"
: > "$W/jobs/busy/.running"
flock -s "$W/jobs/busy/.running" sh -c "echo held >&3; read x < '$T/e/rel'" &
r1=$!; read -r _ <&3
flock -x "$W/jobs/making/.lock" sh -c "echo held >&3; read x < '$T/e/rel'" &
r2=$!; read -r _ <&3
reapnow $((99 * day))
eq "retention: before this boot's clear of the machines nothing is evicted (and microsandbox is not asked)" "ancient bare busy making recent|" "$(folders)|$(cat "$FAKE_MSB_LOG")"
: > "$BOXD_POD_CLEAN"
reapnow $((1000 + 14 * day))
eq "retention: exactly at the limit nothing goes" "ancient bare busy making recent" "$(folders)"
reapnow $((1001 + 14 * day))
eq "retention: unused past the limit goes (a folder without a stamp counts from its own date); busy, being made and recent stay" "busy making recent" "$(folders)"
eq "retention: the box of an evicted folder is removed too" "" "$(ls "$FAKE_STATE")"
eq "retention: the service log names what went, why and how much it freed (empty folders: 0 MB)" "evicted ancient (unused 14 days), 0 MB freed|evicted bare (unused 14 days), 0 MB freed" "$(grep '^evicted' "$T/e/out" | sort | paste -sd'|')"
eq "retention: evictions.log has one line per folder: time, box, reason" "ancient	unused 14 days|bare	unused 14 days" "$(sort -k2 "$W/cache/evictions.log" | cut -f2- | paste -sd'|')"
eq "retention: the line's time is the reaper's clock" "$((1001 + 14 * day))" "$(head -1 "$W/cache/evictions.log" | cut -f1)"
exec 6>"$T/e/rel"; exec 6>&-; wait "$r1" "$r2"   # one close frees both waiting readers
reapnow $((1001 + 14 * day))
eq "retention: once nobody holds them the stale ones go" "recent" "$(folders)"
printf 'BOXD_KEEP_DAYS=1\n' > "$T/pod.conf"; BOXD_CONF="$T/pod.conf" bash "$POD" reap --now $((12 * day)) </dev/null >/dev/null
eq "retention: the limit comes from the settings file" "" "$(folders)"

# Disk pressure: one folder per pass, least recently used first, from 70 percent down to under 60.
setup; export FAKE_DF=$T/e/df; : > "$BOXD_POD_CLEAN"
mkdir -p "$W/cache" "$W/jobs"/{a,b,c,d,live}/src
touch -d @300 "$W/jobs/a/.last-used"; touch -d @100 "$W/jobs/b/.last-used"; touch -d @200 "$W/jobs/c/.last-used"; touch -d @400 "$W/jobs/d/.last-used"
touch -d @99000 "$W/jobs/live/.last-used"
echo 69 > "$FAKE_DF"; reapnow 100000; eq "pressure: under 70 percent nothing goes" "a b c d live" "$(folders)"
printf '%s\n' docker.io/library/rust:1.83 localhost/built-a:latest localhost/built-zz:latest '<none>:<none>' > "$T/e/imglist"
printf '%s\n' 'REFERENCE DIGEST SIZE CREATED' 'localhost/toolbox sha256:a7 3.7 GiB 2026-11-13' 'localhost/built-a:latest sha256:67 8.3 MiB 2026-11-14' > "$T/e/vmimglist"
export FAKE_IMAGE_LIST=$T/e/imglist FAKE_VM_IMAGE_LIST=$T/e/vmimglist; : > "$W/cache/pushed-vm-123"
mkdir -p "$W/cache/pod/m2/old" "$W/cache/pod/npm"; touch -d @100 "$W/cache/pod/m2/old/a.jar"; : > "$W/cache/pod/npm/fresh.tgz"
echo 70 > "$FAKE_DF"; reapnow 100000; eq "pressure: at 70 percent the least recently used goes, one per pass" "a c d live" "$(folders)"
eq "pressure: the reason names the fill level; the images no box uses went first" "images	disk 70 percent full|b	disk 70 percent full" "$(evlog)"
eq "pressure: every named image goes except the built image of a box whose folder is here (images in use refuse by themselves), then the dangling layers" \
    "rmi docker.io/library/rust:1.83|rmi localhost/built-zz:latest|image prune -f|rmi localhost/built-b:latest" "$(grep -E '^(rmi|image prune)' "$FAKE_LOG" | paste -sd'|')"   # the last one: the built image of the folder evicted in this pass
eq "pressure: the same for the machine engine's cached images, and the records of pushed images go" "image rm localhost/toolbox|image rm localhost/built-b:latest|no" "$(grep '^image rm' "$FAKE_MSB_LOG" | paste -sd'|')|$([ -e "$W/cache/pushed-vm-123" ] && echo yes || echo no)"
eq "pressure: files of the shared package caches not written for the retention time go, fresh ones stay" "npm/fresh.tgz" "$(cd "$W/cache/pod" && find . -type f | sed 's|^\./||' | paste -sd' ')"
: > "$FAKE_LOG"
echo 65 > "$FAKE_DF"; reapnow 100000; eq "pressure: it goes on between 60 and 70 once started" "a d live" "$(folders)"
eq "pressure: images are taken once per episode, not on every pass (only the evicted folder's own built image)" "rmi localhost/built-c:latest" "$(grep -E '^rmi' "$FAKE_LOG")"
unset FAKE_IMAGE_LIST FAKE_VM_IMAGE_LIST
echo 59 > "$FAKE_DF"; reapnow 100000; eq "pressure: under 60 percent it stops" "a d live" "$(folders)"
echo 65 > "$FAKE_DF"; reapnow 100000; eq "pressure: 65 percent does not start it again" "a d live" "$(folders)"
echo 95 > "$FAKE_DF"; reapnow 100000; reapnow 100000; reapnow 100000
eq "pressure: a folder used within the box lifetime is never taken, however full the disk" "live" "$(folders)"
: > "$FAKE_DF"; reapnow 100000; eq "pressure: an unreadable fill level removes nothing and the reaper still exits 0" "0 live" "$rc $(folders)"
unset FAKE_DF

# pod drop: the client's collector removes the box and the folder of a worktree that is gone.
setup; mkdir -p "$W/cache"
pod "pod run $box -- $B64"; eq "drop: the box exists first" "pod-$box" "$(ls "$FAKE_STATE")"
pod "pod drop $box"; eq "drop: box and folder go" "0||" "$rc|$(ls "$FAKE_STATE")|$(folders)"
eq "drop: logged with its reason" "$box	worktree gone" "$(evlog)"
eq "drop: the image built for the box goes with it, on both engines" "rmi localhost/built-$box:latest|image rm localhost/built-$box:latest" "$(grep '^rmi' "$FAKE_LOG" | paste -sd'|')|$(grep '^image rm' "$FAKE_MSB_LOG" | paste -sd'|')"
pod "pod drop $box"; eq "drop: nothing there is exit 0 and no second line" "0 1" "$rc $(wc -l < "$W/cache/evictions.log")"
pod "pod drop ../x"; eq "drop: a bad name is refused" 125 "$rc"
pod "pod drop"; eq "drop: needs a box" 125 "$rc"
# The line says how many megabytes the folder held (du -smx inside the user namespace); when that fails the removal goes on and the line is the old one.
mkdir -p "$W/jobs/sized-1" "$W/jobs/unsized-1"; head -c 5242880 /dev/urandom > "$W/jobs/sized-1/data"; head -c 5242880 /dev/urandom > "$W/jobs/unsized-1/data"
want=$(du -smx "$W/jobs/sized-1" | cut -f1)
pod "pod drop sized-1"; eq "drop: the line says the measured size in megabytes (a folder holding 5 MB of data is at least 5)" "0 evicted sized-1 (worktree gone), $want MB freed yes" "$rc $(cat "$T/e/out") $([ "$want" -ge 5 ] && [ ! -e "$W/jobs/sized-1" ] && echo yes)"
eq "drop: evictions.log keeps its three fields" "sized-1	worktree gone" "$(tail -1 "$W/cache/evictions.log" | cut -f2-)"
FAKE_DU_EXIT=1 pod "pod drop unsized-1"; eq "drop: a failed measurement still removes and prints the old line" "0 evicted unsized-1 (worktree gone) no" "$rc $(cat "$T/e/out") $([ -e "$W/jobs/unsized-1" ] && echo yes || echo no)"
pod "pod run $box -- $B64"
eq "after an eviction the next call says once that the folder was removed" "boxd-pod: the folder of this box was removed on $(date +%F) (worktree gone); it starts empty" "$(grep 'folder of this box' "$T/e/err")"
pod "pod run $box -- $B64"; eq "and not again" "" "$(grep 'folder of this box' "$T/e/err")"
printf 'ssh-ed25519 AAAAviewkey dashboard\n' > "$W/view_keys"; printf 'publickey ssh-ed25519 AAAAviewkey\n' > "$W/auth"
CASE_ENV=(BOXD_VIEW_KEYS="$W/view_keys" SSH_USER_AUTH="$W/auth"); pod "pod drop $box"
eq "drop: a key that may only read cannot drop" "125 yes" "$rc $([ -d "$W/jobs/$box" ] && echo yes)"; CASE_ENV=()

# A sync is a use of the box folder: it renews the stamp and holds the folder busy while it runs.
setup; mkdir -p "$W/jobs/$box/src"; touch -d @1000 "$W/jobs/$box/.last-used"
export FAKE_RSYNC_PROBE=$T/e/probe
pod "rsync --server -logDtpre.iLsfxCIvu --delete . jobs/$box/src/"
eq "sync: renews the folder's stamp" yes "$([ "$(stat -c %Y "$W/jobs/$box/.last-used")" -gt 1000 ] && echo yes)"
eq "sync: the folder is busy while rsync runs" held "$(cat "$FAKE_RSYNC_PROBE")"
pod "rsync --server --sender -logDtpre.iLsfxCIvu . jobs/$box/src/out"
eq "pull: the folder is busy while rsync runs" held "$(cat "$FAKE_RSYNC_PROBE")"
pod "rsync --server --sender -logDtpre.iLsfxCIvu . jobs/nobox/src/out"
eq "pull from a box that has no folder makes none" "0 no" "$rc $([ -e "$W/jobs/nobox" ] && echo yes || echo no)"
unset FAKE_RSYNC_PROBE

# (The recorded cases write 1 as the group of a run that still runs: group 1 always exists for the server's liveness check.)
# A run whose process group is gone but whose record stayed (the host lost power, the box was killed): it has ended.
setup; mkdir -p "$W/jobs/x/runs"; echo "half" > "$W/jobs/x/runs/lost.log"; echo 999999999 > "$W/jobs/x/runs/lost.pid"
pod "pod log x lost 0"; eq "pod log: a run whose recorded group no longer exists is ended, without an exit code" "state=ended	exit=-" "$(head -1 "$T/e/out" | cut -f5-6)"
: > "$W/jobs/x/runs/live.log"
setsid sh -c 'echo $$ > "$1"; echo up >&3; read x < "$2"' _ "$W/jobs/x/runs/live.pid" "$FAKE_REL" & lp=$!; read -r _ <&3
echo "EXIT 0" > "$W/jobs/x/runs/done.log"; pod "pod log x done 0"
eq "pod log: an ended run (no record left) is read without a word on standard error" "state=ended	exit=0|" "$(head -1 "$T/e/out" | cut -f5-6)|$(cat "$T/e/err")"
pod "pod report"; eq "pod report: no word on standard error for ended runs either" "" "$(cat "$T/e/err")"
pod "pod log x live 0"; eq "pod log: a run whose group lives is running" "state=running	exit=-" "$(head -1 "$T/e/out" | cut -f5-)"
eq "pod log: a running run's header has neither ended nor seconds" 0 "$(head -1 "$T/e/out" | grep -c 'ended=\|seconds=')"
# An ended run's header ends with ended=<modification time> and seconds=<that minus the creation time>; the time is set with touch, never read from the clock.
born=$(stat -c %W "$W/jobs/x/runs/done.log" 2>/dev/null); [[ $born =~ ^[1-9][0-9]*$ ]] || born=
if [ -n "$born" ]; then touch -d "@$((born + 37))" "$W/jobs/x/runs/done.log"; want="state=ended	exit=0	ended=$((born + 37))	seconds=37"
else touch -d @1000000 "$W/jobs/x/runs/done.log"; want="state=ended	exit=0	ended=1000000"; fi   # no creation time on this file system: seconds must be absent
pod "pod log x done 0"; eq "pod log: an ended run's header says when it ended and how many seconds it took (no seconds without a creation time)" "$want" "$(head -1 "$T/e/out" | cut -f5-)"
eq "pod log: ended equals the log's modification time" "$(stat -c %Y "$W/jobs/x/runs/done.log")" "$(head -1 "$T/e/out" | cut -f7 | cut -d= -f2)"
if [ -n "$born" ]; then touch -d "@$((born - 5))" "$W/jobs/x/runs/done.log"; pod "pod log x done 0"; eq "pod log: a modification time before the creation time leaves seconds out" "state=ended	exit=0	ended=$((born - 5))" "$(head -1 "$T/e/out" | cut -f5-)"; fi
exec 6>"$T/e/rel"; exec 6>&-; wait "$lp"

# --clean: the client's sync may also delete what its filter leaves out
setup; pod "rsync --server -logDtpre.iLsfxCIvu --delete --delete-excluded . jobs/$box/src/"; eq "rsync: --delete-excluded passes" 0 "$rc"

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
