#!/usr/bin/env bash
# Assert-based test for `boxd-setup --view-key <file>` (server/boxd-setup): the key goes into the list of keys that may only
# read, into the build account's allowed keys and, as ExposeAuthInfo, into the build sshd's settings; again and again without
# duplicates; a key that a new --key run replaced comes back. Runs as an ordinary user: a fake `id` says root, and the files are
# in a scratch folder (BOXD_ETC, BOXD_AUTH_DIR). The full run of boxd-setup needs a real host and is not run here.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
SETUP="$HERE/server/boxd-setup"
fails=0
eq() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/auth" "$T/etc"
printf '#!/bin/sh\n[ "$1" = -u ] && echo 0 || echo boxd\n' > "$T/bin/id"; chmod +x "$T/bin/id"
export PATH="$T/bin:$PATH" BOXD_CONF="$T/none.conf" BOXD_ETC="$T/etc" BOXD_AUTH_DIR="$T/auth" BOXD_USER=builder
unset BOXD_VIEW_KEYS BOXD_BUILD_KEY
run() { sh "$SETUP" "$@" >"$T/out" 2>"$T/err"; rc=$?; }
echo "ssh-ed25519 AAAAagentagentagent agent@x" > "$T/auth/builder"
echo "ssh-ed25519 AAAAviewviewview dashboard@homeserver" > "$T/view.pub"

run --view-key "$T/view.pub"
eq "view key: exit 0" 0 "$rc"
eq "view key: listed" "ssh-ed25519 AAAAviewviewview dashboard@homeserver" "$(cat "$T/etc/view_keys")"
eq "view key: allowed for the build account, the agent's key kept" "ssh-ed25519 AAAAagentagentagent agent@x|ssh-ed25519 AAAAviewviewview dashboard@homeserver" "$(paste -sd'|' "$T/auth/builder")"
eq "view key: the sshd tells which key logged in" "ExposeAuthInfo yes" "$(cat "$T/etc/sshd_config")"
eq "view key: the list is readable by the build account" 644 "$(stat -c %a "$T/etc/view_keys")"
run --view-key "$T/view.pub"
eq "view key again: nothing is doubled" "1 2 1" "$(wc -l < "$T/etc/view_keys") $(wc -l < "$T/auth/builder") $(wc -l < "$T/etc/sshd_config")"
echo "ssh-ed25519 AAAAagentagentagent agent@x" > "$T/auth/builder"   # a new --key run replaced the allowed keys
run --view-key "$T/view.pub"
eq "view key: put back among the allowed keys after they were replaced" 2 "$(wc -l < "$T/auth/builder")"
echo "ssh-ed25519 AAAAotherother other@y" > "$T/view2.pub"; run --view-key "$T/view2.pub"
eq "a second view key is added beside the first" "2 3" "$(wc -l < "$T/etc/view_keys") $(wc -l < "$T/auth/builder")"
printf 'command="rm -rf /" ssh-ed25519 AAAAx evil\n' > "$T/evil.pub"; run --view-key "$T/evil.pub"
eq "a line with allowed-key options in front is refused, nothing written" "2 2" "$rc $(wc -l < "$T/etc/view_keys")"
run --view-key; eq "--view-key without a file is a usage error" 2 "$rc"
rm "$T/auth/builder"; run --view-key "$T/view.pub"; eq "before the first full run there is no allowed keys file: refused" 1 "$rc"
# --add-key / --remove-key: further keys with full run rights (another client machine), each removable on its own.
rm -rf "$T/auth" "$T/etc"; mkdir -p "$T/auth" "$T/etc"
echo "ssh-ed25519 AAAAagentagentagent agent@x" > "$T/auth/builder"
echo "ssh-ed25519 AAAArunnerrunner homeserver-runner boxd client" > "$T/runner.pub"
run --add-key "$T/runner.pub" --from 192.0.2.50
eq "add key: exit 0" 0 "$rc"
eq "add key: listed with its address limit" 'from="192.0.2.50" ssh-ed25519 AAAArunnerrunner homeserver-runner boxd client' "$(cat "$T/etc/run_keys")"
eq "add key: allowed for the build account beside the first key, with the limit" 'ssh-ed25519 AAAAagentagentagent agent@x|from="192.0.2.50" ssh-ed25519 AAAArunnerrunner homeserver-runner boxd client' "$(paste -sd'|' "$T/auth/builder")"
eq "add key: it is not a key that may only read" no "$([ -s "$T/etc/view_keys" ] && echo yes || echo no)"
run --add-key "$T/runner.pub"
eq "add key again without a limit: one line, the limit gone" 'ssh-ed25519 AAAAagentagentagent agent@x|ssh-ed25519 AAAArunnerrunner homeserver-runner boxd client' "$(paste -sd'|' "$T/auth/builder")"
eq "add key again: listed once" 1 "$(wc -l < "$T/etc/run_keys")"
echo "ssh-ed25519 AAAAnewagent agent@new" > "$T/auth/builder"   # a new --key run replaced the allowed keys
run --add-key "$T/runner.pub" --from 192.0.2.50,192.0.2.51
eq "an added key comes back after a new first key, with its new limit" 'ssh-ed25519 AAAAnewagent agent@new|from="192.0.2.50,192.0.2.51" ssh-ed25519 AAAArunnerrunner homeserver-runner boxd client' "$(paste -sd'|' "$T/auth/builder")"
echo "ssh-ed25519 AAAAnewagent agent@new" > "$T/first.pub"; run --add-key "$T/first.pub"
eq "add key: the first key cannot be added again (it would become removable)" "1|1" "$rc|$(grep -c AAAAnewagent "$T/auth/builder")"
run --remove-key "$T/first.pub"; eq "remove key: only an added key can be removed, the first key stays" "1|1" "$rc|$(grep -c AAAAnewagent "$T/auth/builder")"
run --add-key "$T/runner.pub" --from 'x" command="id'; eq "add key: a limit that is not addresses is refused" "2|1" "$rc|$(grep -c AAAArunner "$T/auth/builder")"
printf 'command="rm -rf /" ssh-ed25519 AAAAx evil\n' > "$T/evil.pub"; run --add-key "$T/evil.pub"; eq "add key: a line with options is refused" 2 "$rc"
run --remove-key "$T/runner.pub"
eq "remove key: gone from the list and from the allowed keys, the first key untouched" "0||ssh-ed25519 AAAAnewagent agent@new" "$rc|$(cat "$T/etc/run_keys")|$(cat "$T/auth/builder")"
run --add-key; eq "--add-key without a file is a usage error" 2 "$rc"

[ "$fails" -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
