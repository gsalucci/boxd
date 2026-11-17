#!/usr/bin/env bash
# tools/release-github: what it refuses, what it uploads (only the files of the version), that a second run completes
# the release instead of creating it, and that a corrupted download is an error. A fake gh plays the release in a
# scratch folder; no network, no real gh, no clock.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$2] got [$3]"; fi; }
has() { if grep -q -- "$2" <<<"$3"; then ok "$1"; else bad "$1: no \"$2\" in: $3"; fi; }

# A scratch checkout: the tool finds CHANGELOG.md and deb-out relative to itself.
C=$T/checkout; mkdir -p "$C/tools" "$T/bin" "$T/void" "$T/deb" "$T/tmp"
cp "$HERE/tools/release-github" "$C/tools/"
cat > "$C/CHANGELOG.md" <<'EOT'
# Changes

## 2.0.0

- the new thing
- another thing

## 1.9.0

- the old thing
EOT
for p in boxd boxd-server boxd-power boxd-client; do
  for ver in 1.9.0 2.0.0; do echo "$p $ver" > "$T/void/$p-${ver}_1.x86_64.xbps"; echo "sig $p $ver" > "$T/void/$p-${ver}_1.x86_64.xbps.sig2"; done
done
for ver in 0.7.9 0.7.15; do echo "msb $ver" > "$T/void/microsandbox-bin-${ver}_1.x86_64.xbps"; echo "sig msb $ver" > "$T/void/microsandbox-bin-${ver}_1.x86_64.xbps.sig2"; done
echo index > "$T/void/x86_64-repodata"
for p in boxd boxd-server boxd-client; do for ver in 1.9.0 2.0.0; do echo "deb $p $ver" > "$T/deb/${p}_$ver-1_all.deb"; done; done
for ver in 0.7.9 0.7.15; do echo "deb msb $ver" > "$T/deb/microsandbox-bin_$ver-1_amd64.deb"; done

# The fake gh: records every call; the release exists after create; download copies what was uploaded,
# and damages the file named in CORRUPT.
cat > "$T/bin/gh" <<'EOT'
#!/bin/sh
echo "$*" >> "$FAKE/calls"
case "$1 $2" in
  "release view") [ -f "$FAKE/exists" ] ;;
  "release create") touch "$FAKE/exists"; echo "$*" > "$FAKE/create"; shift 2; shift; mkdir -p "$FAKE/store"
    while [ $# -gt 0 ]; do case $1 in --repo|--title|--target) shift 2 ;; --notes-file) cp "$2" "$FAKE/notes"; shift 2 ;; *) cp "$1" "$FAKE/store/"; shift ;; esac; done ;;
  "release upload") echo "$*" > "$FAKE/upload"; shift 2; shift
    while [ $# -gt 0 ]; do case $1 in --repo) shift 2 ;; --clobber) shift ;; *) cp "$1" "$FAKE/store/"; shift ;; esac; done ;;
  "release download") shift 3; [ "$1" = --repo ] && shift 2; [ "$1" = --dir ] && cp "$FAKE"/store/* "$2/"
    [ -z "${CORRUPT:-}" ] || echo damaged > "$2/$CORRUPT" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 9 ;;
esac
EOT
chmod +x "$T/bin/gh"
export FAKE=$T/fake PATH="$T/bin:$PATH" TMPDIR=$T/tmp
reset() { rm -rf "$FAKE"; mkdir -p "$FAKE/store"; : > "$FAKE/calls"; }
run() { sh "$C/tools/release-github" "$@" >"$T/out" 2>"$T/err"; rc=$?; }
export BOXD_REPO_DIR=$T/void BOXD_DEB_OUT=$T/deb BOXD_GITHUB_REPO=owner/name
unset BOXD_GITHUB_TARGET

reset; BOXD_GITHUB_REPO="" run 2.0.0
eq "no repository named: exit 2" 2 "$rc"; has "it names the variable" BOXD_GITHUB_REPO "$(cat "$T/err")"
eq "and gh was not called" 0 "$(wc -l < "$FAKE/calls")"
reset; run 3.0.0
eq "no change log section: refused" 1 "$rc"; has "it says so" "no section" "$(cat "$T/err")"
eq "nothing was created" 0 "$(wc -l < "$FAKE/calls")"
reset; BOXD_REPO_DIR=$T/deb run 2.0.0
eq "Void packages missing: refused" 1 "$rc"
mkdir "$T/emptydeb"; reset; BOXD_DEB_OUT=$T/emptydeb run 2.0.0
eq "Debian packages missing: refused" 1 "$rc"; has "it names boxd-server" "boxd-server" "$(cat "$T/err")"
eq "no call to gh before the files are known" 0 "$(wc -l < "$FAKE/calls")"

reset; BOXD_GITHUB_TAG=v3.0.0 run 2.0.0
eq "a tag that is not of the version: refused" 1 "$rc"; has "it says so" "not v2.0.0" "$(cat "$T/err")"
eq "and gh was not called for it" 0 "$(wc -l < "$FAKE/calls")"

reset; BOXD_GITHUB_TARGET=feature run 2.0.0
eq "first run: exit 0" 0 "$rc"; has "final line" "release-github: boxd 2.0.0 published with 16 assets" "$(cat "$T/out")"
create=$(cat "$FAKE/create")
has "creates the tag of the version" "^release create v2.0.0 " "$create"
has "names the repository" "--repo owner/name" "$create"
has "titles it" "--title boxd 2.0.0" "$create"
has "points the tag at the target" "--target feature" "$create"
eq "notes are exactly the section" "$(printf '\n- the new thing\n- another thing\n')" "$(cat "$FAKE/notes")"
want=$({ printf '%s\n' x86_64-repodata SHA256SUMS microsandbox-bin-0.7.15_1.x86_64.xbps microsandbox-bin-0.7.15_1.x86_64.xbps.sig2 \
    microsandbox-bin_0.7.15-1_amd64.deb boxd_2.0.0-1_all.deb boxd-client_2.0.0-1_all.deb boxd-server_2.0.0-1_all.deb
  for p in boxd boxd-server boxd-power boxd-client; do echo "$p-2.0.0_1.x86_64.xbps"; echo "$p-2.0.0_1.x86_64.xbps.sig2"; done; } | sort)
eq "uploads exactly the current files, the index, the signatures and the sums" "$want" "$(ls "$FAKE/store" | sort)"
eq "the sums name each file with its hash" 0 "$(cd "$FAKE/store" && sha256sum -c SHA256SUMS >/dev/null 2>&1; echo $?)"
eq "the sums list every other asset" 15 "$(wc -l < "$FAKE/store/SHA256SUMS")"
eq "the temporary folder is gone" 0 "$(ls -A "$T/tmp" | wc -l)"

eq "a release of the plain tag is no prerelease" 0 "$(grep -c -e --prerelease "$FAKE/create")"
has "its title is the version" "--title boxd 2.0.0 " "$create"

: > "$FAKE/calls"; run 2.0.0
eq "second run: exit 0" 0 "$rc"
has "it uploads with --clobber" "^release upload v2.0.0 --repo owner/name --clobber " "$(cat "$FAKE/upload")"
eq "it does not create again" 0 "$(grep -c '^release create' "$FAKE/calls")"

reset; BOXD_GITHUB_TAG=v2.0.0-citest1 run 2.0.0
eq "trial tag: exit 0" 0 "$rc"; create=$(cat "$FAKE/create")
has "trial tag: the release is made for the trial tag" "^release create v2.0.0-citest1 " "$create"
has "trial tag: it is a prerelease" "--prerelease" "$create"
has "trial tag: the title carries the suffix" "--title boxd 2.0.0-citest1 " "$create"
has "trial tag: the files are those of the version" "boxd-server-2.0.0_1.x86_64.xbps" "$(ls "$FAKE/store")"
eq "trial tag: no target is passed when none is set" 0 "$(grep -c -e --target "$FAKE/create")"

reset; touch "$FAKE/exists"; CORRUPT=boxd-server_2.0.0-1_all.deb run 2.0.0
eq "corrupted download: exit 1" 1 "$rc"; has "a mismatch line" "MISMATCH after upload: boxd-server_2.0.0-1_all.deb" "$(cat "$T/err")"
eq "the temporary folder is gone after a failure" 0 "$(ls -A "$T/tmp" | wc -l)"

[ "$fails" = 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
