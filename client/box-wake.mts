// box-wake: wakes a sleeping build server before ssh talks to it. `box setup <host> --wake ... --broadcast ...`
// writes this line at the top of ~/.ssh/config and the host's addresses into ~/.config/boxd/wake.json:
//   Match originalhost boxd-<host> exec "node /usr/lib/boxd/box-wake.mjs %n"
// The argument is the alias the user typed. If that alias's address already answers it exits at once.
// Otherwise it broadcasts a magic packet for every network card address listed for the host (the cable wakes a
// host from sleep or off, wifi from sleep) and waits until THAT address accepts a connection. Unknown or missing
// alias: exits 0. No addresses live in this code: wake.json is
//   { "boxd-<host>": { "target": "<host>:<port>", "macs": ["aa:bb:..."], "broadcast": "<addr>[:<port>]" } }
// Built with tsc-rs (see tsconfig.json); the emitted box-wake.mjs is what runs.
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const FILE = env.BOX_WAKE_FILE ?? path.join(env.HOME ?? "", ".config", "boxd", "wake.json");
const POLL_MS = Number(env.BOX_WAKE_POLL_MS ?? 1000);
const LIMIT_MS = Number(env.BOX_WAKE_LIMIT_MS ?? 120000); // a cold boot takes about 40 s

type Entry = { target: string; macs: string[]; broadcast: string };

function entryFor(alias: string): Entry | undefined {
  try {
    const all = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Entry>;
    return all[alias];
  } catch {
    return undefined; // no file, or unreadable: never block ssh
  }
}

export function magicPacket(mac: string): Buffer {
  const bytes = mac.split(":").map((h) => Number.parseInt(h, 16));
  if (bytes.length !== 6 || bytes.some((b) => !(b >= 0 && b <= 255))) throw new Error(`bad wake address: ${mac}`);
  const m = Buffer.from(bytes);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}

function answers(target: string, timeoutMs: number): Promise<boolean> {
  const i = target.lastIndexOf(":");
  return new Promise((resolve) => {
    const s = net.connect({ host: target.slice(0, i), port: Number(target.slice(i + 1)), timeout: timeoutMs });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

async function broadcast(e: Entry): Promise<void> {
  const [host = "", port = "9"] = e.broadcast.split(":");
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, r));
  sock.setBroadcast(true);
  for (const mac of e.macs) {
    await new Promise<void>((r) => sock.send(magicPacket(mac), Number(port), host, () => r()));
  }
  sock.close();
}

export async function main(alias = process.argv[2] ?? ""): Promise<number> {
  const e = entryFor(alias);
  if (!e) return 0; // never block ssh on an alias we do not know
  if (await answers(e.target, Math.min(POLL_MS, 800))) return 0;
  process.stderr.write(`box-wake: ${alias} asleep, waking it\n`);
  const start = Date.now();
  let sent = -Infinity;
  while (Date.now() - start < LIMIT_MS) {
    if (Date.now() - sent >= 10 * POLL_MS) { await broadcast(e); sent = Date.now(); } // repeat: a packet can be lost
    if (await answers(e.target, POLL_MS)) {
      process.stderr.write(`box-wake: awake after ${((Date.now() - start) / 1000).toFixed(1)} s\n`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  process.stderr.write(`box-wake: no answer after ${LIMIT_MS / 1000} s\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
