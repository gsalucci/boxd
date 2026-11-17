// Opens the dashboard page by hand against the recorded fixtures: the real service (dashboard/boxd-dashboard.mjs) polling three hosts that
// are made here, a fake `ssh` first on PATH that answers from tests/fixtures/dashboard/ (the tower on 0.3.0 and awake, laptop on 0.2.0,
// the homeserver not answering). No real host, no real ssh, nothing but loopback. The clock is the fixtures' own, so the times on the page
// are those of the fixtures (days ago, for a browser of today). Stop it with Ctrl-C.
//   node tests/dashboard-fixture-server.mts [port]      then open the address it prints
import net from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const FIX = path.join(REPO, "tests/fixtures/dashboard");
const { startService, parseSettings } = await import(path.join(REPO, "dashboard/boxd-dashboard.mjs"));
const T0 = 1794571200000;
const root = mkdtempSync(path.join(tmpdir(), "boxd-dashboard-fixture-"));
const bin = path.join(root, "bin"), answers = path.join(root, "answers");
mkdirSync(bin); mkdirSync(answers);
writeFileSync(path.join(root, "key"), "not a key\n");
writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
for a; do cmd=$a; done
port=; prev=; for a; do [ "$prev" = -p ] && port=$a; prev=$a; done
f="${answers}/$port/$(echo "$cmd" | tr ' ' '_')"
[ -f "$f.err" ] && cat "$f.err" >&2
[ -f "$f.out" ] && cat "$f.out"
exit "$(cat "$f.exit" 2>/dev/null || echo 0)"
`);
chmodSync(path.join(bin, "ssh"), 0o755);

const listeners: net.Server[] = [];
const listen = () => new Promise<number>((resolve) => { const s = net.createServer((c) => c.destroy()).listen(0, "127.0.0.1", () => { listeners.push(s); resolve((s.address() as net.AddressInfo).port); }); });
const reply = (port: number, cmd: string, o: { out?: string; err?: string; exit?: number }) => {
  const d = path.join(answers, String(port)), f = path.join(d, cmd.replaceAll(" ", "_"));
  mkdirSync(d, { recursive: true });
  for (const [e, v] of [["out", o.out], ["err", o.err], ["exit", o.exit === undefined ? undefined : String(o.exit)]] as const) if (v !== undefined) writeFileSync(`${f}.${e}`, v);
};
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");

const tower = await listen(), xps = await listen(), homeserver = await listen();
await new Promise((r) => listeners[2]!.close(r)); // the homeserver does not answer
const calls = read("tower.calls");
reply(tower, "pod report", { out: read("tower.report") });
reply(tower, "pod calls", { out: `calls\tsize=${Buffer.byteLength(calls)}\tfrom=0\tnext=${Buffer.byteLength(calls)}\n${calls}` });
reply(tower, "pod ps harbor-admin-3340981172", { out: "4121\t900\t35\t/job/src\tcargo test --release -p oracle\n4188\t640\t0\t/job/src\toracle-tests --nocapture\n" });
reply(tower, "pod log harbor-admin-3340981172 20261113-110800-9f3c", { out: "log\tsize=84\tfrom=0\tnext=84\tstate=running\texit=-\n   Compiling oracle v0.4.1\n    Finished release profile\n     Running unittests\ntest result: ok. 3 passed\n" });
reply(xps, "pod report", { exit: 125, err: "boxd-pod: unknown command\n" });
reply(xps, "pod status", { out: read("laptop.status") });
reply(xps, "pod list", { out: read("laptop.list") });

const settings = parseSettings(JSON.stringify({ listen: `127.0.0.1:${process.argv[2] ?? 0}`, stateDir: path.join(root, "state"), hosts: [
  { name: "tower", address: "127.0.0.1", port: tower, account: "build", keyFile: path.join(root, "key"), sleeps: true },
  { name: "laptop", address: "127.0.0.1", port: xps, account: "build", keyFile: path.join(root, "key") },
  { name: "homeserver", address: "127.0.0.1", port: homeserver, account: "build", keyFile: path.join(root, "key") },
] }));
const svc = await startService(settings, { env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, now: () => T0, log: () => {} });
await svc.poll();
process.stdout.write(`dashboard on the fixtures: http://127.0.0.1:${svc.port}/   (Ctrl-C to stop)\n`);
const stop = () => void svc.close().then(() => { listeners.forEach((s) => s.close()); rmSync(root, { recursive: true, force: true }); process.exit(0); });
process.on("SIGINT", stop); process.on("SIGTERM", stop);
