#!/usr/bin/env bash
# tools/release-version: the version of a tag, a trial suffix dropped, and what it refuses. Runs on a scratch checkout.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
eq() { if [ "$2" = "$3" ]; then echo "ok $1"; else echo "FAIL $1: expected [$2] got [$3]"; fails=$((fails + 1)); fi; }

C=$T/checkout; mkdir -p "$C/tools" "$C/srcpkgs/boxd" "$C/server" "$C/client"
cp "$HERE/tools/release-version" "$C/tools/"
printf 'pkgname=boxd\nversion=2.0.0\n' > "$C/srcpkgs/boxd/template"
printf '#!/bin/sh\nVERSION=2.0.0\n' > "$C/server/boxd-pod"
printf 'export const VERSION = "2.0.0";\n' > "$C/client/box.mts"
printf '# Changes\n\n## 2.0.0\n\n- a thing\n' > "$C/CHANGELOG.md"
rv() { sh "$C/tools/release-version" "$1" 2>"$T/err"; }

eq "a plain tag gives its version" 2.0.0 "$(rv v2.0.0)"
eq "a trial suffix is dropped" 2.0.0 "$(rv v2.0.0-citest1)"
rv v2.0.1 >/dev/null; eq "a tag of another version is refused" 1 $?
eq "and the refusal names the template" 1 "$(grep -c 'srcpkgs/boxd/template is not at version 2.0.1' "$T/err")"
for bad in 2.0.0 vx v2.0 v2.0.0. v2.0.0+x "v2.0.0 "; do rv "$bad" >/dev/null; eq "the tag [$bad] is refused" 1 $?; done
for f in server/boxd-pod client/box.mts CHANGELOG.md; do
  cp "$C/$f" "$T/keep"; echo "other" > "$C/$f"
  rv v2.0.0 >/dev/null; eq "$f out of step: refused" 1 $?
  eq "$f out of step: the refusal names it" 1 "$(grep -c "${f##*/}" "$T/err")"
  cp "$T/keep" "$C/$f"
done
eq "everything back in step: accepted" 2.0.0 "$(rv v2.0.0)"

if [ "$fails" = 0 ]; then echo "ALL OK"; else echo "$fails FAILED"; exit 1; fi
