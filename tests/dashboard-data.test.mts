// Acceptance of the dashboard's data seam (docs/designs/dashboard.md, "The document the service serves"): the pure
// function fleet() of dashboard/fleet.mjs turns what the hosts answered (the text of `pod report`, `pod status`,
// `pod list` and of the call log, recorded in tests/fixtures/dashboard/) into the one JSON document the browser reads.
// The recorded answers of the 0.3.0 host are made by tests/dashboard-capture.sh from the real server/boxd-pod (the last test here
// checks that they are what it prints today). No clock and no network: the time is an input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const FIX = path.join(REPO, "tests/fixtures/dashboard");
const MODULE = path.join(REPO, "dashboard/fleet.mjs");

type HostInput = { name: string; state: string; seenAt: number | null; sinceAt: number; [key: string]: unknown };
type Input = { now: number; hosts: HostInput[] };
// input.json names the recorded answers by file; fleet() gets their text.
function input(): Input {
  const inp = JSON.parse(readFileSync(path.join(FIX, "input.json"), "utf8")) as Input;
  for (const h of inp.hosts) for (const k of ["report", "calls", "status", "list"]) if (typeof h[k] === "string") h[k] = readFileSync(path.join(FIX, h[k] as string), "utf8");
  return inp;
}
async function load(): Promise<{ fleet: (i: Input) => any; parseAnswer: (text: string) => any }> {
  assert.ok(existsSync(MODULE), "dashboard/fleet.mjs is missing: run tsc-rs -p dashboard");
  return await import(MODULE);
}

test("fleet(): the recorded answers of three hosts give exactly the document of fixtures/dashboard/fleet.json", async () => {
  const { fleet } = await load();
  assert.deepEqual(fleet(input()), JSON.parse(readFileSync(path.join(FIX, "fleet.json"), "utf8")));
});

test("fleet(): a host that fell asleep keeps its last known values, marked stale, and raises no alert of its own", async () => {
  const { fleet } = await load();
  const inp = input(), now = inp.now;
  const tower = inp.hosts[0] as HostInput;
  Object.assign(tower, { state: "asleep", seenAt: now - 900_000, sinceAt: now - 840_000 });
  const doc = fleet(inp), h = doc.hosts[0];
  assert.deepEqual([h.id, h.state, h.stale, h.seenAt, h.sinceAt], ["tower", "asleep", true, now - 900_000, now - 840_000]);
  assert.deepEqual(h.load, [17.42, 9.1, 6.85], "the last known load stays, for the view to show as last known");
  assert.equal(doc.boxes.filter((b: any) => b.host === "tower").length, 4, "its boxes stay listed");
  assert.deepEqual(doc.services.filter((s: any) => s.host === "tower").map((s: any) => s.status), ["unknown", "unknown", "unknown"]);
  assert.equal(doc.alerts.some((a: any) => a.host === "tower" && (a.kind === "load" || a.kind === "disk" || a.kind === "unreachable")), false,
    "a sleeping host is not loaded, not full and not down");
  assert.equal(doc.alerts.some((a: any) => a.host === "tower" && a.kind === "refused"), true, "what its call log recorded in the last 24 hours stays");
});

test("fleet(): a host that has never answered still gets a row, and an always-on one an alert", async () => {
  const { fleet } = await load();
  const doc = fleet(input()), h = doc.hosts[2];
  assert.deepEqual([h.id, h.state, h.version, h.seenAt, h.load, h.disk], ["homeserver", "unreachable", null, null, null, null]);
  assert.deepEqual(doc.alerts.filter((a: any) => a.host === "homeserver").map((a: any) => a.kind), ["unreachable"]);
});

test("fleet(): call log lines of server 0.2.0 (seven columns) and of 0.3.0 (nine) both parse; a broken line is left out", async () => {
  const { fleet } = await load();
  const calls = fleet(input()).calls;
  assert.equal(calls.length, 11, "13 lines: one is older than 24 hours, one is not a call log line");
  const old = calls.find((c: any) => c.at === 1794560000000);
  assert.deepEqual([old.exit, old.cmd, old.run], [101, null, null]);
  assert.deepEqual(calls.map((c: any) => c.at), [...calls.map((c: any) => c.at)].sort((a, b) => b - a), "newest first");
});

test("parseAnswer(): the header line of `pod calls` and `pod log`, then the body untouched", async () => {
  const { parseAnswer } = await load();
  assert.deepEqual(parseAnswer("calls\tsize=228\tfrom=66\tnext=228\nline one\nline two\n"), { kind: "calls", size: 228, from: 66, next: 228, body: "line one\nline two\n" });
  assert.deepEqual(parseAnswer("log\tsize=11\tfrom=0\tnext=4\tstate=running\texit=-\na\nb\n"), { kind: "log", size: 11, from: 0, next: 4, state: "running", exit: null, body: "a\nb\n" });
  assert.deepEqual(parseAnswer("calls\tsize=0\tfrom=0\tnext=0\n"), { kind: "calls", size: 0, from: 0, next: 0, body: "" });
});

test("the recorded answers of the 0.3.0 host are what the real server prints today (tests/dashboard-capture.sh)", () => {
  const out = mkdtempSync(path.join(tmpdir(), "boxd-capture-"));
  try {
    execFileSync("bash", [path.join(REPO, "tests/dashboard-capture.sh"), out], { stdio: "pipe" });
    for (const f of ["tower.report", "tower.calls"]) assert.equal(readFileSync(path.join(FIX, f), "utf8"), readFileSync(path.join(out, f), "utf8"), `${f} is stale: run bash tests/dashboard-capture.sh`);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("fleet(): what retention removed on a host in the last day is one alert, counted, newest time last; older removals raise none", async () => {
  const { fleet } = await load();
  const inp = input(), now = inp.now, sec = Math.floor(now / 1000), h = inp.hosts[0] as HostInput;
  h.report = `${h.report as string}evicted\tat=${sec - 90000}\tbox=old-1\treason=unused 14 days\nevicted\tat=${sec - 600}\tbox=images\treason=disk 71 percent full\nevicted\tat=${sec - 500}\tbox=ws-1\treason=disk 71 percent full\n`;
  const a = fleet(inp).alerts.filter((x: any) => x.kind === "evicted");
  assert.deepEqual(a.map((x: any) => [x.host, x.severity, x.count, x.sinceAt, x.lastAt, x.title, x.detail]), [[h.name, "warning", 2, (sec - 600) * 1000, (sec - 500) * 1000,
    `boxd removed 2 items on ${h.name} to keep it clean`, "images (disk 71 percent full), ws-1 (disk 71 percent full)"]]);
  assert.deepEqual(fleet(input()).alerts.filter((x: any) => x.kind === "evicted"), []);
});

test("fleet(): a host that reports graphics cards carries the count (from its report or its status); none, or a server that prints no word, leaves no field", async () => {
  const { fleet } = await load();
  const inp = input(), tower = inp.hosts[0] as HostInput, laptop = inp.hosts[1] as HostInput;
  assert.ok((tower.report as string).includes("\tgpus=0"), "the recorded report ends with the word");
  assert.ok(!("gpus" in fleet(inp).hosts[0]) && !("gpus" in fleet(inp).hosts[1]));
  tower.report = (tower.report as string).replace("\tgpus=0", "\tgpus=2");
  laptop.status = `${(laptop.status as string).trimEnd()}\tgpus=1\n`;
  const hosts = fleet(inp).hosts;
  assert.deepEqual([hosts[0].gpus, hosts[1].gpus], [2, 1]);
});
