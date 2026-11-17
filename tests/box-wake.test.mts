// Test for client/box-wake.mjs (the emitted file that runs): node --test tests/box-wake.test.mts
// Localhost stands in for the build server: a TCP server is "ssh answering", a UDP socket is the broadcast address.
// Every wait is on an event (child exit, datagram arrival), never on a clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import dgram from "node:dgram";
import net from "node:net";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIR = path.join(REPO, "client");
const TOOL = path.join(DIR, "box-wake.mjs");
const { magicPacket } = await import(TOOL);

async function udpListener() {
  const sock = dgram.createSocket("udp4");
  sock.bind(0, "127.0.0.1");
  await once(sock, "listening");
  return sock;
}
async function freePort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as net.AddressInfo).port;
  s.close();
  await once(s, "close");
  return port;
}
// targets: alias -> port on localhost; the tool is asked for `alias` (ssh passes the alias typed as %n).
// The addresses come from a wake.json the test writes, as `box setup` would.
const dir = mkdtempSync(path.join(tmpdir(), "box-wake-conf-"));
function run(targetPort: number | Record<string, number>, udpPort: number, extra: Record<string, string> = {}, alias = "boxd-test") {
  const targets = typeof targetPort === "number" ? { "boxd-test": targetPort } : targetPort;
  const file = path.join(dir, `wake-${udpPort}-${Object.values(targets).join("-")}.json`);
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(targets).map(([a, p]) =>
    [a, { target: `127.0.0.1:${p}`, macs: ["00:11:22:33:44:55", "66:77:88:99:aa:bb"], broadcast: `127.0.0.1:${udpPort}` }]))));
  const child = spawn(process.execPath, [TOOL, alias], {
    env: { PATH: process.env.PATH ?? "", BOX_WAKE_FILE: file, BOX_WAKE_POLL_MS: "50", BOX_WAKE_LIMIT_MS: "15000", ...extra },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exit = once(child, "exit").then(([code]) => ({ code, err }));
  return { child, exit };
}

test("magic packet: 6 x 0xff then the address 16 times, 102 bytes", () => {
  const p = magicPacket("00:11:22:33:44:55");
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.deepEqual([...p.subarray(6 + i * 6, 12 + i * 6)], [0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
  assert.throws(() => magicPacket("00:11:22"), /bad wake/);
  assert.throws(() => magicPacket("zz:11:22:33:44:55"), /bad wake/);
});

test("already awake: exits 0 without sending anything", async (t) => {
  const server = net.createServer((c) => c.destroy()).listen(0, "127.0.0.1");
  t.after(() => server.close()); // cleanup also when an assertion fails: open sockets would hang the file
  await once(server, "listening");
  const udp = await udpListener();
  t.after(() => udp.close());
  let packets = 0;
  udp.on("message", () => packets++);
  const { exit } = run((server.address() as net.AddressInfo).port, (udp.address() as net.AddressInfo).port);
  const { code, err } = await exit;
  await new Promise((r) => setImmediate(r)); // let any queued datagram be delivered
  assert.equal(code, 0);
  assert.equal(packets, 0);
  assert.equal(err, "");
});

test("asleep: broadcasts both cards' magic packets, exits 0 once ssh answers", async (t) => {
  const port = await freePort();
  const udp = await udpListener();
  const got: Buffer[] = [];
  let server: net.Server | undefined;
  t.after(() => { server?.close(); udp.close(); });
  udp.on("message", (m) => {
    got.push(m);
    if (got.length === 2 && !server) server = net.createServer((c) => c.destroy()).listen(port, "127.0.0.1"); // "wakes up"
  });
  const { exit } = run(port, (udp.address() as net.AddressInfo).port);
  const { code, err } = await exit;
  assert.equal(code, 0);
  assert.deepEqual(got[0], magicPacket("00:11:22:33:44:55"));
  assert.deepEqual(got[1], magicPacket("66:77:88:99:aa:bb"));
  assert.match(err, /waking it/);
  assert.match(err, /awake after/);
});

test("waits for the asked alias's address, not for another one that answers first", async (t) => {
  const [cablePort, wifiPort] = [await freePort(), await freePort()];
  const udp = await udpListener();
  let packets = 0;
  let wifi: net.Server | undefined, cable: net.Server | undefined;
  t.after(() => { wifi?.close(); cable?.close(); udp.close(); });
  udp.on("message", () => {
    packets++;
    if (packets === 2 && !wifi) wifi = net.createServer((c) => c.destroy()).listen(wifiPort, "127.0.0.1"); // the other card wakes first
    // the tool repeats its packets while it waits (packets 3 and 4): only then does the asked address wake
    if (packets === 4 && !cable) cable = net.createServer((c) => c.destroy()).listen(cablePort, "127.0.0.1");
  });
  const { exit } = run({ "boxd-test": cablePort, "boxd-other": wifiPort }, (udp.address() as net.AddressInfo).port);
  const { code } = await exit;
  assert.equal(code, 0);
  assert.ok(cable, "exited 0 before the asked address answered");
});

test("unknown or missing alias: exits 0 at once, sends nothing", async (t) => {
  const udp = await udpListener();
  t.after(() => udp.close());
  let packets = 0;
  udp.on("message", () => packets++);
  const port = await freePort();
  for (const alias of ["somewhere-else", ""]) {
    const { code, err } = await run(port, (udp.address() as net.AddressInfo).port, {}, alias).exit;
    assert.equal(code, 0);
    assert.equal(err, "");
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(packets, 0);
});

test("no wake file, or a file without the alias: exits 0 at once", async () => {
  for (const file of [path.join(dir, "missing.json"), (() => { const p = path.join(dir, "empty.json"); writeFileSync(p, "{}"); return p; })()]) {
    const child = spawn(process.execPath, [TOOL, "boxd-test"], { env: { PATH: process.env.PATH ?? "", BOX_WAKE_FILE: file }, stdio: ["ignore", "ignore", "pipe"] });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  }
});

test("never answers: exits 1 at its limit", async (t) => {
  const udp = await udpListener();
  t.after(() => udp.close());
  const { exit } = run(await freePort(), (udp.address() as net.AddressInfo).port, { BOX_WAKE_LIMIT_MS: "100" });
  const { code, err } = await exit;
  assert.equal(code, 1);
  assert.match(err, /no answer after/);
});

test("committed box-wake.mjs matches a fresh tsc-rs build", () => {
  const out = mkdtempSync(path.join(tmpdir(), "box-wake-"));
  try {
    execFileSync(path.join(process.env.HOME ?? "", ".local/share/pnpm/bin/tsc-rs"), ["-p", DIR, "--outDir", out]);
    assert.equal(readFileSync(TOOL, "utf8"), readFileSync(path.join(out, "box-wake.mjs"), "utf8"), "stale: run tsc-rs -p client");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
