# Installing the boxd dashboard stack on the homeserver

The dashboard is a docker stack in `~/stacks/boxd-dashboard/`, like other docker stacks: `compose.yaml`, `./data` for state, the
network `proxy`, and no published port (the proxy manager reaches it as `boxd-dashboard:8377`). It reads the build hosts over ssh with a key that
may only read. It never wakes a host: it sends nothing to a host that does not answer on its port.

The bundle holds exactly what the stack needs: `Containerfile`, `compose.yaml`, `.dockerignore`, `dashboard.json.example`, `INSTALL.md`,
`dashboard/boxd-dashboard.mjs`, `dashboard/fleet.mjs` and `dashboard/web/`. Make it on the workstation from the repository (or a tag) and copy it over:

```sh
dashboard/stack/make-bundle -o boxd-dashboard.tar.gz            # or: -r <tag> to build it from a tag
scp boxd-dashboard.tar.gz homeserver:
```

## On the homeserver

1. Unpack into the stack folder.
   ```sh
   mkdir -p ~/stacks/boxd-dashboard && tar -xzf ~/boxd-dashboard.tar.gz -C ~/stacks/boxd-dashboard
   cd ~/stacks/boxd-dashboard
   ```
2. Make the key pair the service logs in with. The container runs as the fixed user id 10001, so the folder and the private key must belong to it.
   ```sh
   mkdir data && ssh-keygen -t ed25519 -N '' -C boxd-dashboard@homeserver -f data/key
   chmod 600 data/key && chmod 644 data/key.pub && chmod 755 data
   sudo chown 10001:10001 data data/key
   cat data/key.pub        # the public line the hosts need in step 3
   ```
3. Copy the settings and adjust them: the names, addresses, ports and accounts of your build hosts. `sleeps` is true for a host that suspends itself.
   `listenAnywhere` stays true: inside the container the service must listen on all addresses for the proxy to reach it, and nothing is published
   to the outside. `keyFile` and `stateDir` name the paths inside the container; leave them.
   ```sh
   cp dashboard.json.example dashboard.json
   ```

## On each build host (as root)

The dashboard needs boxd-server 0.3.0 on a host. A host still on 0.2.0 works in the reduced form the page announces ("status and box list only").

4. Put the dashboard's public line in a file and make it a key that may only read. `boxd-setup --view-key` adds the line to `/etc/boxd/view_keys` (the
   list of keys that may only read) and to the build account's allowed keys, and adds `ExposeAuthInfo yes` to `/etc/boxd/sshd_config` (sshd then
   tells boxd which key logged in). `boxctl reload` restarts only the build sshd; sessions and boxes stay.
   ```sh
   echo 'ssh-ed25519 AAAA... boxd-dashboard@homeserver' > /root/dashboard.pub      # the line printed in step 2
   boxd-setup --view-key /root/dashboard.pub
   boxctl reload
   ```
5. Stop the dashboard's polls from keeping the host awake. In `/etc/boxd/boxd.conf` set the homeserver's address on your own network, then reload (a host with the power
   module off needs this only if it is switched on later):
   ```sh
   BOXD_IDLE_IGNORE="192.0.2.50"
   ```
   ```sh
   boxctl reload
   ```
   Connections from that address on the build port no longer count as work for the power module (connections on port 22 always do). A build started
   from the homeserver itself no longer keeps the host awake by its connection alone; its load still does. If the host penalizes failed logins, also put
   the address in `BOXD_TRUSTED_NET`.

## Back on the homeserver

6. Build and start.
   ```sh
   docker compose up -d --build
   ```
7. See that it is healthy. The status reads `healthy` within about half a minute (the check asks `/api/fleet.json`, which answers only after the first poll).
   ```sh
   docker compose ps
   docker inspect --format '{{.State.Health.Status}}' boxd-dashboard
   docker logs boxd-dashboard
   docker run --rm --network proxy boxd-dashboard:local node -e "fetch('http://boxd-dashboard:8377/api/fleet.json').then(r=>r.json()).then(d=>console.log(d.hosts.map(h=>h.id+' '+h.state)))"
   ```

## In the proxy manager's web interface

Example entry in the proxy manager: host
`boxd.example.com`, behind your reverse proxy, limited to your own network, its own certificate, Force SSL.
From your own network it answers 200, from outside 403. The step below is for another server.

8. Proxy Hosts, Add Proxy Host. Domain name: a name of your choosing that your own network resolves. Scheme `http`, forward host `boxd-dashboard`, forward
   port `8377`. Leave Websockets Support off (the page only polls) and Block Common Exploits as you have it on the other hosts.
   Access List: the existing list for your own network, or a new one: allow `192.0.2.0/24`, deny all (no username needed if the list is only by address).
   SSL tab: the certificate and Force SSL as on your other hosts.

## First contact with a host, and a reinstalled host

The first time the service reaches a host it records that host's ssh key in `data/known_hosts` and trusts only that key afterwards (`accept-new`). When a
host is reinstalled its key changes and the page shows it as unreachable ("ssh refused"). Remove the old key and the next poll records the new one:

```sh
docker compose exec boxd-dashboard ssh-keygen -R 192.0.2.72 -f /state/known_hosts      # use the host's address from dashboard.json
```

If the container has stopped, edit `data/known_hosts` by hand instead: delete the line that starts with the host's address (or `[address]:port`).

## Update

Make a new bundle on the workstation, copy it, unpack over the folder (`dashboard.json` and `data/` are not in the bundle, so they stay), then:

```sh
tar -xzf ~/boxd-dashboard.tar.gz -C ~/stacks/boxd-dashboard
cd ~/stacks/boxd-dashboard && docker compose up -d --build
```

The history in `data/` is kept: the next poll continues from the stored offsets.

## Remove everything

```sh
cd ~/stacks/boxd-dashboard && docker compose down
cd ~ && sudo rm -r ~/stacks/boxd-dashboard
docker image rm boxd-dashboard:local
```

Delete the proxy manager entry by hand. `boxd-setup` has no command that removes a view key. On each host, as root, delete the dashboard's line from the two
files that hold it, then `boxctl reload`: `/etc/boxd/view_keys` and `/etc/ssh/authorized_keys/<build account>` (`build` on the tower, `boxd` on laptop).
`ExposeAuthInfo yes` in `/etc/boxd/sshd_config` and `BOXD_IDLE_IGNORE` in `/etc/boxd/boxd.conf` may stay: they change nothing without the key.
