# Develop and test

Node type definitions come from the development dependency in `package.json`: run `pnpm install` once. `tsc-rs` is a Rust port of the TypeScript compiler; the official `tsc` takes the same command line.

```sh
tsc-rs -p client                 # emits client/box.mjs and box-wake.mjs (committed)
tsc-rs -p dashboard              # emits dashboard/fleet.mjs and boxd-dashboard.mjs (committed)
bash tests/contract-pod-test.sh                          # every pod case of contract/cases.json plus reap, clear, list, detach, locks, limits, with fake podman and msb
bash tests/boxd-idle-test.sh                             # the power module, with fake ss, zzz, ethtool, iw, df
bash tests/boxd-service-test.sh                          # boxctl and the runit scripts, with fake sv and runuser
bash tests/boxd-view-key-test.sh                         # boxd-setup --view-key, in a scratch folder
node --test tests/contract-client.test.mts tests/box-client.test.mts tests/box-wake.test.mts tests/dashboard-data.test.mts tests/dashboard-service.test.mts tests/dashboard-web.test.mts tests/dashboard-bundle.test.mts
bash tests/dashboard-stack-test.sh                       # builds the dashboard image from the bundle and checks the stack (needs docker without sudo; one image build)
bash tests/dashboard-capture.sh                          # regenerates the recorded answers of tests/fixtures/dashboard/ from the real boxd-pod
```

`docs/designs/dashboard.md` is the design of the dashboard service. Its first workstream, the read-only server verbs
(server 0.3.0: `pod report`, `pod calls`, `pod log`, keys that may only read, `BOXD_IDLE_IGNORE`), and its second, the collector and the
service (`dashboard/`), and its third, the web page (`dashboard/web/`), are built and tested by the runs above. Its fourth is a docker stack for the homeserver (`dashboard/stack/`: `Containerfile`, `compose.yaml`,
`dashboard.json.example`, `INSTALL.md`, `make-bundle`); there is no system package. `dashboard/stack/make-bundle -o boxd-dashboard.tar.gz` writes the bundle to copy to the server;
`INSTALL.md` has the steps.

Open the page: the service serves it on its own address (`http://127.0.0.1:8377/` by default), so start the service with its settings
(`node dashboard/boxd-dashboard.mjs <settings.json>`) and open that address. To see it against the recorded fixtures, with no real host and no
ssh (a fake one answers from `tests/fixtures/dashboard/`): `node tests/dashboard-fixture-server.mts 8377`, then open `http://127.0.0.1:8377/`.
The page only reads. It is plain files (no build step, no dependency, no outside request) and runs under a policy that allows only its own origin.

The service asks each build host over ssh (by address and port, never through the ssh aliases, so it cannot wake a host) and serves
one JSON document on a loopback address. To start it by hand, with a settings file (`listen`, `listenAnywhere` (needed for any address that is not loopback, as inside a container), `pollSeconds`, `stateDir`, and per host
`name`, `address`, `port`, `account`, `keyFile`, `sleeps`; see "Workstream 2 as built" in the design):

```sh
node dashboard/boxd-dashboard.mjs /path/to/dashboard.json     # then: curl http://127.0.0.1:8377/api/fleet.json
```

`tests/pod-acceptance.sh` and `tests/work-acceptance.sh` need a real host (they are parametrized by environment
variables listed at the top of each); they reset the work area and sleep the host.
