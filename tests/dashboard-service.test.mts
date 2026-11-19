// The dashboard service (dashboard/boxd-dashboard.mts, docs/designs/dashboard.md section 2): the poll loop, the stored state,
// the http side and the settings, against a fake `ssh` first on PATH and real loopback sockets made here. Nothing waits on
// time: every poll is started by the test, every wait is on an event (a reply, a file, a fifo), and the service's clock is an
// input. No real host, no real ssh. Run: node --test tests/dashboard-service.test.mts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { TSC, NO_TSC } from "./tsc-rs.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIX = path.join(REPO, "tests/fixtures/dashboard");
const { startService, parseSettings } = await import(path.join(REPO, "dashboard/boxd-dashboard.mjs"));
const REPORT = readFileSync(path.join(FIX, "tower.report"), "utf8");
const CALLS = readFileSync(path.join(FIX, "tower.calls"), "utf8");
// What the service keeps of it: the line that is not a call log line is not stored (it is dropped by the daily trim, which also runs at start).
const KEPT = CALLS.replace("not a call log line\n", "");
const T0 = 1794571200000; // the fixtures' "now"

const root = mkdtempSync(path.join(tmpdir(), "boxd-dashboard-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = path.join(root, "bin"), answers = path.join(root, "answers"), logFile = path.join(root, "ssh.log"), key = path.join(root, "key");
mkdirSync(bin); mkdirSync(answers); writeFileSync(key, "not a key\n"); writeFileSync(logFile, "");
// The fake ssh: logs "<port> <all arguments>", then answers from answers/<port>/<remote command with _ for spaces>.{out,err,exit}.
// A file <command>.block that is a fifo holds the call until the test writes to it (after saying "entered" on the event fifo).
// A second call of the same host while one is inside makes the log say OVERLAP.
writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
for a; do cmd=$a; done
port=; prev=; for a; do [ "$prev" = -p ] && port=$a; prev=$a; done
echo "$port $*" >> "${logFile}"
f="${answers}/$port/$(echo "$cmd" | tr ' ' '_')"
if [ -e "$f.block" ]; then
  mkdir "${root}/inside-$port" 2>/dev/null || echo "OVERLAP $port" >> "${logFile}"
  echo entered > "${root}/events"
  read -r _ < "$f.block"
  rmdir "${root}/inside-$port"
fi
[ -f "$f.err" ] && cat "$f.err" >&2
[ -f "$f.out" ] && cat "$f.out"
exit "$(cat "$f.exit" 2>/dev/null || echo 0)"
`);
chmodSync(path.join(bin, "ssh"), 0o755);
const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

const calls = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean);
const commands = () => calls().filter((l) => /^\d+ /.test(l)).map((l) => l.replace(/^.* -- \S+ /, ""));
const reply = (port: number, cmd: string, o: { out?: string; err?: string; exit?: number }) => {
  const d = path.join(answers, String(port)), f = path.join(d, cmd.replaceAll(" ", "_"));
  mkdirSync(d, { recursive: true });
  for (const [e, v] of [["out", o.out], ["err", o.err], ["exit", o.exit === undefined ? undefined : String(o.exit)]] as const) if (v !== undefined) writeFileSync(`${f}.${e}`, v);
};
const callsAnswer = (body: string, from: number, size: number) => `calls\tsize=${size}\tfrom=${from}\tnext=${from + Buffer.byteLength(body)}\n${body}`;
const callLine = (atMs: number, box: string) => `${atMs}000\t${box}\tcontainer\t0\t0\t10\t\t\ttrue\n`;

const listeners: net.Server[] = [];
const listen = () => new Promise<{ server: net.Server; port: number }>((resolve) => { const s = net.createServer((c) => c.destroy()).listen(0, "127.0.0.1", () => { listeners.push(s); resolve({ server: s, port: (s.address() as net.AddressInfo).port }); }); });
const closePort = async () => { const { server, port } = await listen(); await new Promise((r) => server.close(r)); return port; };
after(() => listeners.forEach((s) => s.close()));

let n = 0;
type Spec = { name: string; port: number; sleeps?: boolean };
function rig(hosts: Spec[], state = path.join(root, `state-${n++}`)) {
  const clock = { t: T0 };
  const settings = parseSettings(JSON.stringify({ listen: "127.0.0.1:0", stateDir: state,
    hosts: hosts.map((h) => ({ name: h.name, address: "127.0.0.1", port: h.port, account: "build", keyFile: key, sleeps: h.sleeps === true })) }));
  const services: any[] = [];
  const start = async (extra: Record<string, unknown> = {}) => { const s = await startService(settings, { env, now: () => clock.t, log: () => {}, ...extra }); services.push(s); return s; };
  after(async () => { for (const s of services) await s.close(); });
  const get = async (svc: any, p: string, init: RequestInit = {}) => {
    const r = await fetch(`http://127.0.0.1:${svc.port}${p}`, init);
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) };
  };
  return { clock, settings, state, start, get };
}
const tower = async (sleeps = true) => {
  const l = await listen();
  reply(l.port, "pod report", { out: REPORT });
  reply(l.port, "pod calls", { out: callsAnswer(CALLS, 0, Buffer.byteLength(CALLS)) });
  return { l, spec: { name: "tower", port: l.port, sleeps } };
};

test("a host whose port does not answer gets no ssh at all: asleep when it sleeps, unreachable with an alert when it does not", async () => {
  const p1 = await closePort(), p2 = await closePort(), before = calls().length;
  const r = rig([{ name: "sleeper", port: p1, sleeps: true }, { name: "always", port: p2 }]);
  const svc = await r.start();
  assert.equal((await r.get(svc, "/api/fleet.json")).status, 503, "no data before the first poll");
  await svc.poll();
  assert.equal(calls().length, before, "no ssh was spawned");
  const d = (await r.get(svc, "/api/fleet.json")).json();
  assert.deepEqual(d.hosts.map((h: any) => [h.id, h.state, h.detail, h.stale]), [["sleeper", "asleep", "no answer", true], ["always", "unreachable", "no answer", true]]);
  assert.deepEqual(d.alerts.map((a: any) => [a.kind, a.host]), [["unreachable", "always"]]);
});

test("a poll of an awake host asks by address and port, with no alias, no shared connection and no wake: the six words of the contract only", async () => {
  const { l, spec } = await tower();
  const r = rig([spec]), start = calls().length;
  const svc = await r.start();
  await svc.poll();
  const mine = calls().slice(start);
  assert.deepEqual(mine, [
    `${l.port} -F /dev/null -i ${key} -o BatchMode=yes -o ConnectTimeout=3 -o IdentitiesOnly=yes -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${r.settings.stateDir}/known_hosts -p ${l.port} -- build@127.0.0.1 pod report`,
    `${l.port} -F /dev/null -i ${key} -o BatchMode=yes -o ConnectTimeout=3 -o IdentitiesOnly=yes -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${r.settings.stateDir}/known_hosts -p ${l.port} -- build@127.0.0.1 pod calls`,
  ]);
  const d = (await r.get(svc, "/api/fleet.json")).json();
  assert.deepEqual([d.hosts[0].state, d.hosts[0].version, d.boxes.length, d.calls.length, d.version], ["awake", "0.4.56", 4, 11, "0.4.56"]);
});

test("exit 125 from pod report (a server on 0.2.0) falls back to pod status and pod list, reads no call log, and says so", async () => {
  const l = await listen();
  reply(l.port, "pod report", { exit: 125, err: "boxd-pod: unknown command\n" });
  reply(l.port, "pod status", { out: readFileSync(path.join(FIX, "laptop.status"), "utf8") });
  reply(l.port, "pod list", { out: readFileSync(path.join(FIX, "laptop.list"), "utf8") });
  const r = rig([{ name: "laptop", port: l.port }]), start = calls().length;
  const svc = await r.start();
  await svc.poll();
  assert.deepEqual(commands().slice(start), ["pod report", "pod status", "pod list"]);
  const d = (await r.get(svc, "/api/fleet.json")).json(), h = d.hosts[0];
  assert.deepEqual([h.state, h.report, h.detail, h.version, d.boxes.length, d.calls.length], ["awake", false, "server 0.2.0: status and box list only", "0.2.0", 1, 0]);
});

test("exit 125 with another reason (view keys with an old sshd settings file) shows that reason as the host's detail", async () => {
  const l = await listen();
  reply(l.port, "pod report", { exit: 125, err: "boxd-pod: view keys are set but the login key is hidden; add ExposeAuthInfo yes to the build sshd\n" });
  const r = rig([{ name: "m", port: l.port }]);
  const svc = await r.start();
  await svc.poll();
  const h = (await r.get(svc, "/api/fleet.json")).json().hosts[0];
  assert.deepEqual([h.state, h.detail], ["unreachable", "view keys are set but the login key is hidden; add ExposeAuthInfo yes to the build sshd"]);
});

test("the call log cursor survives a restart: the next poll continues from it, nothing twice, and the history is served before any poll", async () => {
  const { l, spec } = await tower();
  const r = rig([spec]);
  const first = await r.start();
  await first.poll();
  await first.close();
  const size = Buffer.byteLength(CALLS), start = calls().length;
  assert.equal(readFileSync(path.join(r.state, "tower/cursor"), "utf8"), `${size} ${Buffer.byteLength(KEPT)}\n`, "the cursor is the host's offset and the length of our copy");
  const newer = callLine(T0 - 1000, "boxd-2889387319");
  reply(l.port, `pod calls ${size}`, { out: callsAnswer(newer, size, size + Buffer.byteLength(newer)) });
  r.clock.t = T0 + 60_000;
  const second = await r.start();
  const before = (await r.get(second, "/api/fleet.json")).json();
  assert.deepEqual([before.calls.length, before.hosts[0].loadHist.length, before.boxes.length], [11, 1, 4], "history is there before the first poll");
  await second.poll();
  assert.deepEqual(commands().slice(start), ["pod report", `pod calls ${size}`]);
  assert.equal(readFileSync(path.join(r.state, "tower/calls.log"), "utf8"), KEPT + newer, "no line twice, none missing");
  assert.equal((await r.get(second, "/api/fleet.json")).json().calls.length, 12);
});

test("a window written to the call log whose cursor never was (a stop in between) is cut back at the next start, not stored twice", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const a = await r.start();
  await a.poll();
  await a.close();
  appendFileSync(path.join(r.state, "tower/calls.log"), callLine(T0 - 500, "stray"));
  const b = await r.start();
  assert.equal(readFileSync(path.join(r.state, "tower/calls.log"), "utf8"), KEPT);
  assert.equal((await r.get(b, "/api/fleet.json")).json().calls.some((c: any) => c.box === "stray"), false);
});

test("a host that stops answering is served with its last known values, marked stale, and nothing is sent to it", async () => {
  const { l, spec } = await tower(true);
  const r = rig([spec]);
  const svc = await r.start();
  await svc.poll();
  const seen = r.clock.t, start = calls().length;
  await new Promise((res) => l.server.close(res));
  r.clock.t = T0 + 120_000;
  await svc.poll();
  assert.equal(calls().length, start, "no ssh to a host that does not answer");
  const d = (await r.get(svc, "/api/fleet.json")).json(), h = d.hosts[0];
  assert.deepEqual([h.state, h.stale, h.seenAt, h.sinceAt, h.load, h.version, d.boxes.length], ["asleep", true, seen, r.clock.t, [17.42, 9.1, 6.85], "0.4.56", 4]);
  assert.equal(d.alerts.some((a: any) => a.kind === "unreachable"), false);
});

test("a huge call log is read in windows: each answer is asked for from its next, in order, until next reaches size", async () => {
  const l = await listen();
  const w = [callLine(T0 - 3000, "a"), callLine(T0 - 2000, "b"), callLine(T0 - 1000, "c")], len = Buffer.byteLength(w[0]!), size = len * 3;
  reply(l.port, "pod report", { out: REPORT });
  reply(l.port, "pod calls", { out: callsAnswer(w[0]!, 0, size) });
  reply(l.port, `pod calls ${len}`, { out: callsAnswer(w[1]!, len, size) });
  reply(l.port, `pod calls ${2 * len}`, { out: callsAnswer(w[2]!, 2 * len, size) });
  const r = rig([{ name: "big", port: l.port }]), start = calls().length;
  const svc = await r.start();
  await svc.poll();
  assert.deepEqual(commands().slice(start), ["pod report", "pod calls", `pod calls ${len}`, `pod calls ${2 * len}`]);
  assert.equal(readFileSync(path.join(r.state, "big/calls.log"), "utf8"), w.join(""));
  assert.deepEqual((await r.get(svc, "/api/fleet.json")).json().calls.map((c: any) => c.box), ["c", "b", "a"]);
});

test("a failing host never stops the polling of the others: one answers ssh refused, one cannot be stored, one is read", async () => {
  const a = await listen(), b = await listen(), { l, spec } = await tower();
  reply(a.port, "pod report", { exit: 255, err: "Permission denied (publickey).\n" });
  reply(b.port, "pod report", { out: REPORT });
  const r = rig([{ name: "refused", port: a.port }, { name: "broken", port: b.port }, spec]);
  mkdirSync(r.state, { recursive: true });
  writeFileSync(path.join(r.state, "broken"), "a file where the host's folder should be");
  const lines: string[] = [];
  const svc = await startService(r.settings, { env, now: () => r.clock.t, log: (x: string) => lines.push(x) });
  after(() => svc.close());
  await svc.poll();
  const d = (await r.get(svc, "/api/fleet.json")).json();
  assert.deepEqual(d.hosts.map((h: any) => [h.id, h.state, h.detail]).filter((h: any) => h[0] !== "broken"), [["refused", "unreachable", "ssh refused"], ["tower", "awake", ""]]);
  assert.match(lines.join("\n"), /poll of broken failed/);
  void l;
});

test("the kill counter rising between two polls is recorded once and raises the memory-kill alert", async () => {
  const { l, spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  await svc.poll();
  assert.equal(existsSync(path.join(r.state, "tower/events.log")) && readFileSync(path.join(r.state, "tower/events.log"), "utf8").includes("kill"), false, "the first poll only learns the counter");
  reply(l.port, "pod report", { out: REPORT.replace("oom_kills=1", "oom_kills=3") });
  r.clock.t = T0 + 60_000;
  await svc.poll();
  assert.match(readFileSync(path.join(r.state, "tower/events.log"), "utf8"), new RegExp(`^${T0 + 60_000}\tkill\t2$`, "m"));
  const d = (await r.get(svc, "/api/fleet.json")).json();
  assert.deepEqual([d.hosts[0].memKills, d.hosts[0].lastKillAt, d.alerts.find((a: any) => a.kind === "memory-kill").count], [3, T0 + 60_000, 2]);
});

test("history is bounded: lines older than 7 days leave the files at start, and the cursor records the shorter copy", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const a = await r.start();
  await a.poll();
  await a.close();
  r.clock.t = 1794560000000 + 7 * 86_400_000 - 1000; // the 1794480000000 line is older than 7 days, the next one is not
  await r.start();
  const kept = readFileSync(path.join(r.state, "tower/calls.log"), "utf8").split("\n").filter(Boolean);
  assert.equal(kept.length, 11, "13 lines: the old one and the broken one are gone");
  assert.ok(!kept.some((l) => l.startsWith("1794480000000000")));
  assert.match(readFileSync(path.join(r.state, "tower/cursor"), "utf8"), new RegExp(`^${Buffer.byteLength(CALLS)} ${Buffer.byteLength(readFileSync(path.join(r.state, "tower/calls.log"), "utf8"))}\n$`));
});

test("state files are written to a fresh name and renamed: no file of a poll is left half named", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  await svc.poll();
  const left = execFileSync("find", [r.state, "-name", "*.new-*"], { encoding: "utf8" });
  assert.equal(left, "");
  assert.match(readFileSync(path.join(r.state, "tower/host.json"), "utf8"), /"state":"awake"/);
});

// ---- the http side ----
test("only GET and HEAD, only three paths; a POST anywhere is 405; the document has an entity tag and answers 304", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  await svc.poll();
  for (const p of ["/api/fleet.json", "/api/ps?host=tower&box=x", "/", "/index.html", "/api/other"]) {
    const x = await r.get(svc, p, { method: "POST", body: "x" });
    assert.equal(x.status, 405, `POST ${p}`);
    assert.equal(x.headers.get("allow"), "GET, HEAD");
  }
  assert.equal((await r.get(svc, "/api/fleet.json", { method: "DELETE" })).status, 405);
  for (const p of ["/api/other", "/api/fleet.json/x", "/api", "/nothing.html"]) assert.equal((await r.get(svc, p)).status, 404, p);
  const g = await r.get(svc, "/api/fleet.json");
  assert.deepEqual([g.status, g.headers.get("content-type")], [200, "application/json; charset=utf-8"]);
  assert.equal(g.json().schema, 1);
  const etag = g.headers.get("etag")!;
  assert.equal((await r.get(svc, "/api/fleet.json", { headers: { "if-none-match": etag } })).status, 304);
  const head = await r.get(svc, "/api/fleet.json", { method: "HEAD" });
  assert.deepEqual([head.status, head.text], [200, ""]);
});

test("the service listens on the loopback address, and only a loopback address is accepted in the settings", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  assert.equal((svc.server.address() as net.AddressInfo).address, "127.0.0.1");
  assert.throws(() => parseSettings(JSON.stringify({ listen: "0.0.0.0:8377", hosts: [] })), /loopback/);
});

test("listenAnywhere: without the key a non-loopback address stays refused; with it any address is accepted, and the service listens there", async () => {
  const h = good().hosts, wide = { listen: "0.0.0.0:0", hosts: h };
  assert.throws(() => parseSettings(JSON.stringify(wide)), /loopback/);
  assert.throws(() => parseSettings(JSON.stringify({ ...wide, listenAnywhere: false })), /loopback/);
  assert.throws(() => parseSettings(JSON.stringify({ ...wide, listenAnywhere: "yes" })), /"listenAnywhere" must be true or false/);
  const s = parseSettings(JSON.stringify({ ...wide, listenAnywhere: true }));
  assert.deepEqual(s.listen, { host: "0.0.0.0", port: 0 });
  const svc = await startService({ ...s, stateDir: path.join(root, "wide") }, { log: () => {} });
  assert.equal((svc.server.address() as net.AddressInfo).address, "0.0.0.0");
  await svc.close();
});

test("on-demand reads: box ps and a run's log are shaped for the page, asked once for five seconds, and only for an awake host", async () => {
  const { l, spec } = await tower();
  const sleeperPort = await closePort();
  reply(l.port, "pod ps webshop-608299631", { out: "4121\t900\t35\t/job/src\tnode server.js\n77\t12\t1\t?\tsh -c a\tb\n" });
  reply(l.port, "pod log harbor-admin-3340981172 20261113-110800-9f3c", { out: "log\tsize=11\tfrom=0\tnext=4\tstate=running\texit=-\na\nb\n" });
  reply(l.port, "pod log harbor-admin-3340981172 20261113-110800-9f3c 4", { exit: 125, err: "boxd-pod: no run 20261113-110800-9f3c in box harbor-admin-3340981172\n" });
  const r = rig([spec, { name: "asleep", port: sleeperPort, sleeps: true }]);
  const svc = await r.start();
  await svc.poll();
  const start = calls().length;
  const ps = await r.get(svc, "/api/ps?host=tower&box=webshop-608299631");
  assert.deepEqual(ps.json(), { at: T0, ps: [[4121, 900, 35, "/job/src", "node server.js"], [77, 12, 1, "?", "sh -c a\tb"]] });
  await r.get(svc, "/api/ps?host=tower&box=webshop-608299631");
  assert.equal(calls().length - start, 1, "the second read within five seconds is answered from memory");
  r.clock.t = T0 + 5001;
  await r.get(svc, "/api/ps?host=tower&box=webshop-608299631");
  assert.equal(calls().length - start, 2, "after five seconds it asks again");
  assert.deepEqual((await r.get(svc, "/api/log?host=tower&box=harbor-admin-3340981172&run=20261113-110800-9f3c")).json(), { size: 11, from: 0, next: 4, state: "running", exit: null, text: "a\nb\n" });
  const gone = await r.get(svc, "/api/log?host=tower&box=harbor-admin-3340981172&run=20261113-110800-9f3c&from=4");
  assert.deepEqual([gone.status, gone.json().error], [404, "no run 20261113-110800-9f3c in box harbor-admin-3340981172"]);
  assert.equal((await r.get(svc, "/api/ps?host=asleep&box=x")).status, 409, "a host that is not awake is not asked");
  assert.equal((await r.get(svc, "/api/ps?host=nobody&box=x")).status, 404);
});

test("nothing from a request reaches ssh unless it matches the server's own patterns", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  await svc.poll();
  const start = calls().length;
  const bad = ["/api/ps?host=tower&box=x;touch%20pwned", "/api/ps?host=tower&box=..%2F..%2Fetc", "/api/ps?host=tower&box=UPPER", "/api/ps?host=tower&box=a%20b", "/api/ps?host=tower",
    "/api/ps?host=-oProxyCommand%3Dx&box=x", "/api/ps?host=med%0Aion&box=x", `/api/ps?host=tower&box=${"a".repeat(64)}`,
    "/api/log?host=tower&box=x&run=a%20b", "/api/log?host=tower&box=x&run=$(id)", "/api/log?host=tower&box=x&run=r1&from=12x", "/api/log?host=tower&box=x&run=r1&from=1234567890123456789", "/api/log?host=tower&box=x&run=&from=1"];
  for (const p of bad) assert.equal((await r.get(svc, p)).status, 400, p);
  assert.equal(calls().length, start, "no ssh was spawned for any of them");
});

test("two on-demand reads of one host never run at once: the second ssh waits for the first", async () => {
  const { l, spec } = await tower();
  reply(l.port, "pod ps one", { out: "1\t1\t1\t/\tx\n" });
  reply(l.port, "pod ps two", { out: "2\t2\t2\t/\ty\n" });
  const events = path.join(root, "events"), release = path.join(answers, String(l.port), "pod_ps_one.block");
  execFileSync("mkfifo", [events, release]);
  const r = rig([spec]);
  const svc = await r.start();
  await svc.poll();
  const first = r.get(svc, "/api/ps?host=tower&box=one"); // the fake holds it inside ssh
  await promisify(execFile)("sh", ["-c", `read -r _ < ${events}`]);
  const second = r.get(svc, "/api/ps?host=tower&box=two");
  assert.equal((await r.get(svc, "/api/fleet.json")).status, 200, "the service answers others while the first read is held");
  await promisify(execFile)("sh", ["-c", `echo go > ${release}`]);
  assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  assert.ok(!calls().some((x) => x.startsWith("OVERLAP")), "the fake saw two ssh of one host at once");
  rmSync(release);
});

// ---- settings and start ----
const good = () => ({ listen: "127.0.0.1:0", stateDir: path.join(root, "s"), hosts: [{ name: "tower", address: "192.0.2.72", port: 22, account: "build", keyFile: key, sleeps: true }] });
test("settings: a good file parses, with the defaults the design names", () => {
  const s = parseSettings(JSON.stringify({ hosts: good().hosts }));
  assert.deepEqual([s.listen, s.pollSeconds, s.stateDir, s.hosts[0]!.sleeps], [{ host: "127.0.0.1", port: 8377 }, 60, "/var/lib/boxd-dashboard", true]);
});
test("settings: every bad file is refused with a message that names the setting", () => {
  const bad = (mut: (s: any) => void, re: RegExp) => { const s = good(); mut(s); assert.throws(() => parseSettings(JSON.stringify(s)), re); };
  assert.throws(() => parseSettings("{nope"), /not valid JSON/);
  assert.throws(() => parseSettings("[]"), /one JSON object/);
  bad((s) => (s.hosts = []), /"hosts"/);
  bad((s) => (s.extra = 1), /unknown setting "extra"/);
  bad((s) => (s.listen = "127.0.0.1"), /"listen"/);
  bad((s) => (s.listen = "10.0.0.5:80"), /loopback/);
  bad((s) => (s.pollSeconds = 1), /pollSeconds/);
  bad((s) => (s.stateDir = "relative/dir"), /stateDir/);
  bad((s) => (s.hosts[0].name = "Bad Name"), /hosts\[0\]: "name"/);
  bad((s) => s.hosts.push({ ...s.hosts[0] }), /used twice/);
  bad((s) => (s.hosts[0].address = "-oProxyCommand=touch /tmp/x"), /"address"/);
  bad((s) => (s.hosts[0].address = "a b"), /"address"/);
  bad((s) => (s.hosts[0].port = 0), /"port"/);
  bad((s) => (s.hosts[0].port = "22"), /"port"/);
  bad((s) => (s.hosts[0].account = "-x"), /"account"/);
  bad((s) => (s.hosts[0].keyFile = "key"), /"keyFile" must be an absolute path/);
  bad((s) => (s.hosts[0].keyFile = path.join(root, "no-such-key")), /cannot be read \(ENOENT\)/);
  bad((s) => (s.hosts[0].keyFile = root), /is not a file/);
  bad((s) => (s.hosts[0].sleeps = "yes"), /"sleeps"/);
  bad((s) => (s.hosts[0].colour = "red"), /unknown setting "colour"/);
});

test("the program refuses to start on a bad settings file (exit 2, one clear line), and starts, serves and stops on a good one", async () => {
  const badFile = path.join(root, "bad.json");
  writeFileSync(badFile, JSON.stringify({ ...good(), hosts: [{ ...good().hosts[0], port: 0 }] }));
  const program = path.join(REPO, "dashboard/boxd-dashboard.mjs");
  const run = (args: string[]) => spawn(process.execPath, [program, ...args], { env: { ...env, HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
  const refused = run([badFile]);
  let err = "";
  refused.stderr.on("data", (c) => (err += c));
  assert.equal(await new Promise((r) => refused.on("close", r)), 2);
  assert.match(err, /^boxd-dashboard: settings .*bad\.json: hosts\[0\]: "port" must be a whole number from 1 to 65535\n$/);
  const missing = run([path.join(root, "missing.json")]);
  let err2 = "";
  missing.stderr.on("data", (c) => (err2 += c));
  assert.equal(await new Promise((r) => missing.on("close", r)), 2);
  assert.match(err2, /the settings file does not exist/);

  const goodFile = path.join(root, "good.json"), dead = await closePort();
  writeFileSync(goodFile, JSON.stringify({ ...good(), stateDir: path.join(root, "cli-state"), hosts: [{ ...good().hosts[0], address: "127.0.0.1", port: dead }] }));
  const p = run([goodFile]);
  const port = await new Promise<string>((resolve) => { let o = ""; p.stdout.on("data", (c) => { o += c; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\n/.exec(o); if (m) resolve(m[1]!); }); });
  const res = await fetch(`http://127.0.0.1:${port}/nothing`);
  assert.equal(res.status, 404);
  p.kill("SIGTERM");
  assert.equal(await new Promise((r) => p.on("close", r)), 0);
});

test("committed dashboard/*.mjs match a fresh tsc-rs build", { skip: NO_TSC }, () => {
  const out = mkdtempSync(path.join(root, "build-"));
  execFileSync(TSC!, ["-p", path.join(REPO, "dashboard"), "--outDir", out]);
  for (const f of ["fleet.mjs", "boxd-dashboard.mjs"]) assert.equal(readFileSync(path.join(REPO, "dashboard", f), "utf8"), readFileSync(path.join(out, f), "utf8"), `${f} is stale: run tsc-rs -p dashboard`);
});

test("the box name and run id patterns are the server's own, character for character", async () => {
  const pod = readFileSync(path.join(REPO, "server/boxd-pod"), "utf8"), { BOX_RE, RUN_RE } = await import(path.join(REPO, "dashboard/fleet.mjs"));
  assert.equal(BOX_RE.source, /^BOX_RE='(.*)'$/m.exec(pod)![1]);
  assert.equal(RUN_RE.source, /^RUN_RE='(.*)'$/m.exec(pod)![1]);
});

// ---- the page (workstream 3): the files of dashboard/web/, a fixed allow-list ----
const WEB = path.join(REPO, "dashboard/web");
const raw = (port: number, rawPath: string) => new Promise<number>((resolve, reject) => {
  // http.request sends the path exactly as given (fetch would tidy "/../" away before it left the test)
  http.get({ host: "127.0.0.1", port, path: rawPath }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }).on("error", reject);
});

test("the page and its files are served with their types, no-cache for html and scripts, and a policy that allows only the same origin", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  const want: [string, string][] = [
    ["/", "text/html; charset=utf-8"], ["/index.html", "text/html; charset=utf-8"], ["/boxd.css", "text/css; charset=utf-8"],
    ["/boxd.mjs", "text/javascript; charset=utf-8"], ["/boxd-views.mjs", "text/javascript; charset=utf-8"], ["/boxd-theme.js", "text/javascript; charset=utf-8"],
    ["/assets/fonts/ibm-plex-sans-latin-400.woff2", "font/woff2"], ["/assets/fonts/OFL.txt", "text/plain; charset=utf-8"],
  ];
  for (const [p, type] of want) {
    const g = await r.get(svc, p);
    assert.equal(g.status, 200, p);
    assert.equal(g.headers.get("content-type"), type, p);
    assert.equal(g.headers.get("x-content-type-options"), "nosniff", p);
    if (/\.(html|mjs|js|css)$|^\/$/.test(p)) assert.equal(g.headers.get("cache-control"), "no-cache", p);
    const csp = g.headers.get("content-security-policy") ?? "";
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "connect-src 'self'"]) assert.ok(csp.split("; ").includes(d), `${p}: policy lacks ${d}`);
    assert.ok(!/unsafe-|https?:|\*/.test(csp), `${p}: the policy opens something: ${csp}`);
  }
  assert.equal((await r.get(svc, "/")).text, readFileSync(path.join(WEB, "index.html"), "utf8"));
  const head = await r.get(svc, "/boxd.css", { method: "HEAD" });
  assert.deepEqual([head.status, head.text, head.headers.get("content-length")], [200, "", String(readFileSync(path.join(WEB, "boxd.css")).length)]);
  assert.equal((await r.get(svc, "/", { method: "POST", body: "x" })).status, 405);
});

test("every file the page names is served, and the page names nothing else", async () => {
  const { spec } = await tower();
  const r = rig([spec]);
  const svc = await r.start();
  const html = readFileSync(path.join(WEB, "index.html"), "utf8");
  const named = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]!);
  assert.ok(named.includes("boxd.css") && named.includes("boxd.mjs") && named.includes("boxd-theme.js"), named.join(" "));
  for (const f of named) assert.equal((await r.get(svc, "/" + f)).status, 200, f);
  const mod = readFileSync(path.join(WEB, "boxd.mjs"), "utf8");
  for (const m of mod.matchAll(/from '\.\/([^']+)'/g)) assert.equal((await r.get(svc, "/" + m[1])).status, 200, m[1]);
  const css = readFileSync(path.join(WEB, "boxd.css"), "utf8");
  for (const m of css.matchAll(/url\("([^"]+)"\)/g)) assert.equal((await r.get(svc, "/" + m[1])).status, 200, m[1]);
});

test("no path from a request reaches the file system unchecked: traversal, absolute, encoded, hidden, linked, unknown and later files answer 404", async () => {
  const { spec } = await tower();
  const dir = path.join(root, `web-${n++}`);
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(root, "secret.txt"), "TOP SECRET");
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(path.join(dir, "sub", "a.css"), "a{}");
  writeFileSync(path.join(dir, ".hidden.css"), "h{}");
  writeFileSync(path.join(dir, "blob.bin"), "bin");
  symlinkSync(path.join(root, "secret.txt"), path.join(dir, "link.txt"));
  const r = rig([spec]);
  const svc = await r.start({ webDir: dir });
  assert.equal(await raw(svc.port, "/sub/a.css"), 200);
  assert.equal(await raw(svc.port, "/"), 200);
  writeFileSync(path.join(dir, "late.css"), "l{}");
  const bad = ["/../secret.txt", "/sub/../../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt", "/sub/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt", "/sub/..%5c..%5csecret.txt",
    "//etc/passwd", "/etc/passwd", dir + "/index.html", "/" + dir + "/index.html", "/%00", "/index.html%00.css", "/.hidden.css", "/blob.bin", "/link.txt", "/secret.txt", "/sub", "/sub/", "/index.html/", "/late.css", "/INDEX.HTML", "/a.css", "/%2fetc%2fpasswd"];
  for (const p of bad) assert.equal(await raw(svc.port, p), 404, p);
  // a folder that does not exist serves no page and still serves the data
  const none = await r.start({ webDir: path.join(root, "no-such-folder") });
  assert.equal(await raw(none.port, "/"), 404);
  assert.equal(await raw(none.port, "/api/fleet.json"), 503);
});
