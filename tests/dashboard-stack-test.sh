#!/bin/bash
# The dashboard docker stack, end to end on this machine (docs/designs/dashboard.md, "Workstream 4 as built"): builds the image from the
# bundle that make-bundle writes, starts the stack exactly as INSTALL.md does (compose.yaml as shipped), with settings whose host is a closed
# loopback port inside the container (no real host is touched; the host shows as not answering), waits for the health check, then checks the
# page and the data from a second container on the same network, the user, the read-only root file system, the published ports and the limits.
# Needs docker answering without sudo; one image build (small base). Waits on the container's health state, never on a fixed time.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
IMG=boxd-dashboard:local
fail=0
ok() { echo "ok - $1"; }
no() { echo "not ok - $1"; fail=1; }
check() { local what=$1; shift; if "$@"; then ok "$what"; else no "$what"; fi; }

docker info >/dev/null 2>&1 || { echo "SKIP: docker does not answer without sudo"; exit 0; }
[ -z "$(docker ps -aq --filter name='^boxd-dashboard$')" ] || { echo "STOP: a container named boxd-dashboard exists"; exit 1; }
[ -z "$(docker images -q "$IMG")" ] || { echo "STOP: the image $IMG exists; the test would replace it"; exit 1; }

TMP=$(mktemp -d); STACK=$TMP/boxd-dashboard; MADE_NET=
cleanup() {
  [ -d "$STACK" ] && (cd "$STACK" && docker compose down -t 5 >/dev/null 2>&1)
  # files the container wrote belong to its user id: give them back before deleting
  [ -d "$STACK/data" ] && docker run --rm --user root --cap-add CHOWN --cap-add DAC_OVERRIDE -v "$STACK/data:/d" --entrypoint chown "$IMG" -R "$(id -u):$(id -g)" /d >/dev/null 2>&1
  docker rmi "$IMG" >/dev/null 2>&1
  [ -n "$MADE_NET" ] && docker network rm proxy >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

docker network inspect proxy >/dev/null 2>&1 || { docker network create proxy >/dev/null && MADE_NET=1; }

# the install steps of INSTALL.md
"$REPO/dashboard/stack/make-bundle" -o "$TMP/bundle.tar.gz" || { echo "STOP: make-bundle failed"; exit 1; }
mkdir -p "$STACK" && tar -xzf "$TMP/bundle.tar.gz" -C "$STACK" || exit 1
cd "$STACK" || exit 1
mkdir data && ssh-keygen -q -t ed25519 -N '' -C test -f data/key && chmod 600 data/key && chmod 644 data/key.pub && chmod 755 data
cat > dashboard.json <<'JSON'
{ "listen": "0.0.0.0:8377", "listenAnywhere": true, "pollSeconds": 60, "stateDir": "/state",
  "hosts": [ { "name": "closed", "address": "127.0.0.1", "port": 9, "account": "build", "keyFile": "/run/boxd/key", "sleeps": false } ] }
JSON
docker compose build -q >/dev/null || { echo "STOP: the image build failed"; exit 1; }
docker run --rm --user root --cap-add CHOWN -v "$STACK/data:/d" --entrypoint chown "$IMG" 10001:10001 /d /d/key || { echo "STOP: cannot give the key to the container user"; exit 1; }
docker compose up -d >/dev/null || { echo "STOP: compose up failed"; exit 1; }

# wait on the state: healthy, or give up when it is unhealthy or gone (bounded, no fixed sleep)
status=starting
for _ in $(seq 1 120); do
  status=$(docker inspect --format '{{if .State.Running}}{{.State.Health.Status}}{{else}}stopped{{end}}' boxd-dashboard 2>/dev/null || echo gone)
  case $status in healthy|unhealthy|stopped|gone) break ;; esac
  sleep 1
done
check "the health check reports healthy (got: $status)" test "$status" = healthy
[ "$status" = healthy ] || docker logs boxd-dashboard 2>&1 | tail -20

# fetched from a second container on the same network, the way the proxy reaches it
get() { docker run --rm --network proxy "$IMG" node -e "fetch('http://boxd-dashboard:8377'+process.argv[1]).then(async r=>{const t=await r.text();console.log(r.status+' '+r.headers.get('content-type')+' '+($1))})" "$2" 2>&1; }
page=$(get "t.includes('<title')" /); check "the page is served over the network (got: $page)" test "$page" = "200 text/html; charset=utf-8 true"
js=$(get "t.length>1000" /boxd.mjs); check "the page's script is served (got: $js)" test "$js" = "200 text/javascript; charset=utf-8 true"
fleet=$(get "JSON.parse(t).hosts.map(h=>h.id+':'+h.state+':'+h.detail).join()" /api/fleet.json)
check "fleet.json shows the host as not answering (got: $fleet)" test "$fleet" = "200 application/json; charset=utf-8 closed:unreachable:no answer"

user=$(docker exec boxd-dashboard id -u); check "the process runs as user 10001 (got: $user)" test "$user" = 10001
check "the image's own user is 10001:10001" test "$(docker inspect --format '{{.Config.User}}' "$IMG")" = 10001:10001
check "the service is the only node process (docker-init and its one child, no shell)" test "$(docker exec boxd-dashboard ps -o args | grep -c 'node /app/boxd-dashboard.mjs')" = 2
check "the root file system is read-only" test "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' boxd-dashboard)" = true
check "a write to the root file system fails" bash -c '! docker exec boxd-dashboard sh -c "touch /app/x" 2>/dev/null'
check "the state folder is writable and holds the pinned history" docker exec boxd-dashboard sh -c 'touch /state/w && rm /state/w && test -d /state/closed'
check "the key is mounted read-only" bash -c '! docker exec boxd-dashboard sh -c "touch /run/boxd/key" 2>/dev/null'
check "no port is published" bash -c '[ -z "$(docker port boxd-dashboard)" ] && [ "$(docker inspect --format "{{len .HostConfig.PortBindings}}" boxd-dashboard)" = 0 ]'
check "only the network proxy is attached" test "$(docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' boxd-dashboard)" = 'proxy '
check "all capabilities are dropped and no new privileges" bash -c '[ "$(docker inspect --format "{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}" boxd-dashboard)" = "[ALL] [no-new-privileges:true]" ]'
check "init, memory limit and process limit are set" test "$(docker inspect --format '{{.HostConfig.Init}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' boxd-dashboard)" = 'true 201326592 64'
check "the ssh client is in the image" docker exec boxd-dashboard ssh -V

echo "image: $(docker image inspect "$IMG" --format '{{.Size}} bytes, base node:26.13.1-alpine3.24')"
[ "$fail" = 0 ] && echo "ALL OK" || echo "FAILED"
exit $fail
