// The install bundle of the dashboard stack (dashboard/stack/make-bundle): its exact file list, that nothing private or test-only is inside,
// that two runs give the same bytes, and that the example settings and the compose file agree with the real settings parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseSettings } = await import(path.join(REPO, "dashboard/boxd-dashboard.mjs"));
const tmp = mkdtempSync(path.join(tmpdir(), "boxd-bundle-test-"));
const make = (out: string) => execFileSync(path.join(REPO, "dashboard/stack/make-bundle"), ["-o", out], { encoding: "utf8" });
const list = (file: string) => execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).split("\n").filter(Boolean);

const webFiles = (d: string, base = ""): string[] => readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? webFiles(path.join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]);

test("the bundle holds exactly the files the stack needs, and nothing private or test-only", () => {
  const out = path.join(tmp, "a.tar.gz");
  make(out);
  const got = list(out).map((f) => f.replace(/^\.\//, "")).filter((f) => f !== "." && f !== "" && !f.endsWith("/")).sort();
  const want = ["Containerfile", "compose.yaml", ".dockerignore", "dashboard.json.example", "INSTALL.md", "dashboard/boxd-dashboard.mjs", "dashboard/fleet.mjs",
    ...webFiles("dashboard/web").map((f) => `dashboard/web/${f}`)].sort();
  assert.deepEqual(got, want);
  for (const f of got) {
    assert.ok(!/\.mts$|^tests\/|^dashboard\.json$|^data\/|(^|\/)key(\.pub)?$|\.env$|node_modules|\.git/.test(f), `${f} must not be in the bundle`);
  }
});

test("two runs give the same bytes, with owner 0 and a fixed time", () => {
  const a = path.join(tmp, "r1.tar.gz"), b = path.join(tmp, "r2.tar.gz");
  make(a); make(b);
  assert.ok(readFileSync(a).equals(readFileSync(b)));
  const rows = execFileSync("tar", ["-tvzf", a, "--numeric-owner"], { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(rows.every((r) => /^\S+ 0\/0 /.test(r)), "owner 0/0");
  assert.equal(new Set(rows.map((r) => r.split(/\s+/).slice(3, 5).join(" "))).size, 1, "one time for every entry");
});

test("dashboard.json.example passes the real settings parser and names the paths compose.yaml mounts", () => {
  const ex = JSON.parse(readFileSync(path.join(REPO, "dashboard/stack/dashboard.json.example"), "utf8"));
  const keyFile = path.join(tmp, "key");
  writeFileSync(keyFile, "x"); // the parser wants the key file to exist; in the container it is /run/boxd/key
  const s = parseSettings(JSON.stringify({ ...ex, hosts: ex.hosts.map((h: any) => ({ ...h, keyFile })) }));
  assert.deepEqual(s.listen, { host: "0.0.0.0", port: 8377 });
  assert.deepEqual(s.hosts.map((h: any) => [h.name, h.address, h.port, h.account, h.sleeps]),
    [["tower", "192.0.2.72", 2222, "build", true], ["laptop", "192.0.2.65", 2222, "boxd", false]]);
  assert.equal(s.pollSeconds, 60);
  assert.throws(() => parseSettings(JSON.stringify({ ...ex, listenAnywhere: undefined, hosts: [{ ...ex.hosts[0], keyFile }] })), /loopback/);
  const compose = readFileSync(path.join(REPO, "dashboard/stack/compose.yaml"), "utf8");
  for (const p of [ex.hosts[0].keyFile, ex.stateDir]) assert.ok(compose.includes(`:${p}`), `compose.yaml mounts ${p}`);
  assert.ok(compose.includes("./data/key:/run/boxd/key:ro") && compose.includes("/config/dashboard.json:ro"));
  assert.ok(!/^\s+ports:/m.test(compose), "no published port");
});
