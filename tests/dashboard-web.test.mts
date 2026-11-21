// The seam between the service and the page (docs/designs/dashboard.md, workstream 3): the pure part of the page
// (dashboard/web/boxd-views.mjs: state from the document, views as functions returning strings) is built from
// tests/fixtures/dashboard/fleet.json and every view is rendered without a browser and without a `document` object.
// Each view must render, and show a value only the fixture has. The clock is an input: nothing here waits on time.
// Run: node --test tests/dashboard-web.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const WEB = path.join(REPO, "dashboard/web");
const { newState, applyDoc, renderView, chrome } = await import(path.join(WEB, "boxd-views.mjs"));
const doc = () => JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/dashboard/fleet.json"), "utf8"));
const NOW = doc().generatedAt;
const view = (S: any, v: string, id: string | null = null) => { S.route = { view: v, id }; return renderView(S, NOW); };

test("the pure part loads in node: no document, no window", () => {
  assert.equal(typeof (globalThis as any).document, "undefined");
  assert.equal(typeof newState, "function");
});

test("every view renders from the fixture and shows a value only the fixture has", () => {
  const S = newState(doc());
  const cases: [string, string | null, string[]][] = [
    ["overview", null, ["harbor-admin-3340981172", "pnpm test auth", "homeserver", "31.24 GiB"]],
    ["hosts", null, ["192.0.2.72", "192.0.2.34", "192.0.2.50", "31.24", "17.42"]],
    ["host", "tower", ["26.55", "18.75", "2.31", "1.2", "no count ceiling", "953.87", "85 %", "17.42 / 9.10 / 6.85"]],
    ["host", "laptop", ["server 0.2.0: status and box list only", "11.5 GiB"]],
    ["host", "homeserver", ["no answer", "last known"]],
    ["boxes", null, ["void-server-871234905", "rust:<wbr>1.83", "webshop-608299631"]],
    ["box", "harbor-admin-3340981172", ["cargo test --release -p oracle", "20261113-110800-9f3c", "3.1 GiB of 4.0 GiB"]],
    ["box", "toolsite-1923847561", ["20261113-114300-77aa", "pnpm test"]],
    ["box", "void-server-871234905", ["void-server-871234905", "no detached runs"]],
    ["calls", null, ["cargo clippy --workspace", "image not allowed", "30.0 s", "exit 75"]],
    ["images", null, ["toolbox.tar", "3.42 GiB", "localhost/toolbox:latest"]],
    ["services", null, ["boxd-sshd", "0.2.0", "0.4.68"]],
    ["alerts", null, ["Load on tower is above its 16 threads", "no room for another virtual machine (24100 MB", "homeserver does not answer"]],
    ["reset", null, ["boxd-reset work", "boxd-reset all", "tower"]],
  ];
  for (const [v, id, wants] of cases) {
    const html = view(S, v, id);
    assert.ok(html.length > 200, `${v} ${id ?? ""} is empty`);
    assert.ok(!html.includes("this view failed to render"), `${v} ${id ?? ""} threw`);
    for (const w of wants) assert.ok(html.includes(w), `${v} ${id ?? ""}: missing ${JSON.stringify(w)}`);
  }
});

test("every box and every host of the fixture has a detail view, and each route that is gone falls back instead of throwing", () => {
  const d = doc(), S = newState(d);
  for (const h of d.hosts) assert.ok(view(S, "host", h.id).includes(h.id));
  for (const b of d.boxes) assert.ok(view(S, "box", b.name).includes(b.name));
  assert.ok(view(S, "host", "no-such-host").length > 0);
  assert.ok(view(S, "box", "no-such-box").length > 0);
  assert.equal(S.route.view, "boxes");
});

test("the second poll replaces the data and keeps route, sorting, filters, view mode and acknowledgements", () => {
  const S = newState(doc());
  S.route = { view: "calls", id: null };
  S.sort.calls = { key: "dur", dir: "asc" };
  S.callFilter = { host: "tower", outcome: "failed", q: "pnpm" };
  S.boxView = "cards";
  S.acked["load|tower||"] = 1794571200000;
  const next = doc();
  next.generatedAt += 15000;
  next.boxes = next.boxes.slice(0, 2);
  applyDoc(S, next);
  assert.equal(S.boxes.length, 2);
  assert.deepEqual([S.route.view, S.sort.calls.key, S.callFilter.q, S.boxView], ["calls", "dur", "pnpm", "cards"]);
  assert.equal(S.alerts.find((a: any) => a.id === "load|tower||").acked, true, "acknowledged, nothing newer");
  const again = doc();
  again.alerts.find((a: any) => a.id === "load|tower||").lastAt += 60000;
  applyDoc(S, again);
  assert.equal(S.alerts.find((a: any) => a.id === "load|tower||").acked, false, "it happened again: it comes back");
});

test("the status bar reads version, time of the data and read only; a stale document says so", () => {
  const S = newState(doc());
  const c = chrome(S, NOW);
  assert.match(c.status, /^boxd 0\.4\.68, data from \d\d:\d\d:\d\d, read only$/);
  S.fetchError = "the service did not answer";
  assert.match(chrome(S, NOW + 90000).status, /the service did not answer.*data from \d\d:\d\d:\d\d.*read only/);
});

test("no view draws a button that changes a host", () => {
  const S = newState(doc());
  const acts = new Set<string>();
  const pages: [string, string | null][] = [["overview", null], ["hosts", null], ["host", "tower"], ["host", "homeserver"], ["boxes", null], ["box", "harbor-admin-3340981172"], ["calls", null], ["images", null], ["services", null], ["alerts", null], ["reset", null]];
  S.boxView = "cards";
  pages.push(["boxes", null]);
  for (const [v, id] of pages) for (const m of view(S, v, id).matchAll(/data-act="([^"]+)"/g)) acts.add(m[1]!);
  const allowed = new Set(["go", "back", "sort", "boxview", "tab", "logfollow", "logwrap", "logline", "callclear", "ack", "unack", "copy"]);
  for (const a of acts) assert.ok(allowed.has(a), `unexpected action ${a}`);
});

test("on-demand data (box ps and a run's log) renders when present and says why when absent", () => {
  const S = newState(doc());
  S.route = { view: "box", id: "harbor-admin-3340981172" };
  S.ps["tower|harbor-admin-3340981172"] = { at: NOW, ps: [[4242, 900, 0, "oracle", "cargo-only-in-this-test run"]] };
  S.logs["20261113-110800-9f3c"] = { text: "compiling oracle-only-line\nrunning 3 tests\n", size: 42, next: 42, state: "detached", exit: null, error: null };
  const html = renderView(S, NOW);
  for (const w of ["cargo-only-in-this-test run", "possibly hung", "compiling oracle-only-line", "running 3 tests"]) assert.ok(html.includes(w), w);
  S.ps["tower|harbor-admin-3340981172"] = { at: NOW, error: "the host is not awake" };
  assert.ok(renderView(S, NOW).includes("the host is not awake"));
});

test("everything that comes from a host is escaped: names, commands, reasons, images, log lines, process rows", () => {
  const evil = `<script>alert("x")</script> & 'q'`;
  const d = doc();
  const b = d.boxes.find((x: any) => x.name === "harbor-admin-3340981172");
  b.image = evil;
  b.runs[0].cmd = evil;
  for (const c of d.calls) { if (c.cmd) c.cmd = evil; if (c.reason) c.reason = evil; }
  d.alerts[0].title = evil; d.alerts[0].detail = evil; d.alerts[0].action = evil;
  d.hosts[0].detail = evil; d.hosts[2].detail = evil;
  d.images[0].name = evil; d.images[0].archive = evil; d.images[0].tag = evil;
  const S = newState(d);
  S.ps["tower|harbor-admin-3340981172"] = { at: NOW, ps: [[1, 1, 1, evil, evil]] };
  S.logs["20261113-110800-9f3c"] = { text: evil + "\n", size: 1, next: 1, state: "detached", exit: null, error: null };
  S.callFilter.q = evil;
  S.log.q = evil;
  S.fetchError = evil;
  const pages: [string, string | null][] = [["overview", null], ["hosts", null], ["host", "tower"], ["host", "homeserver"], ["boxes", null], ["box", "harbor-admin-3340981172"], ["calls", null], ["images", null], ["services", null], ["alerts", null], ["reset", null]];
  S.boxView = "cards";
  pages.push(["boxes", null]);
  let seen = 0;
  for (const [v, id] of pages) {
    const html = view(S, v, id);
    assert.ok(!html.includes("this view failed to render"), `${v}: threw`);
    assert.ok(!html.includes("<script"), `${v}: a raw <script tag`);
    assert.ok(!html.includes(`alert("x")`), `${v}: an unescaped quote`);
    if (html.includes("&lt;script&gt;")) seen++;
  }
  assert.ok(seen >= 6, `the hostile text showed in ${seen} views, expected at least 6 (so the check is not vacuous)`);
  assert.ok(!chrome(S, NOW).crumb.includes("<script"), "the crumb");
});

test("the page folder has no inline script, no inline event handler, no inline style and no external request", () => {
  for (const f of readdirSync(WEB).filter((x) => /\.(html|mjs|js|css)$/.test(x))) {
    const text = readFileSync(path.join(WEB, f), "utf8");
    if (f.endsWith(".html")) {
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(text), `${f}: inline script`);
      assert.ok(!/\son[a-z]+\s*=/i.test(text), `${f}: inline event handler`);
      assert.ok(!/\sstyle\s*=/i.test(text), `${f}: inline style attribute`);
    }
    assert.ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(text), `${f}: external reference`);
    assert.ok(!/url\(\s*["']?(?:https?:)?\/\//i.test(text), `${f}: external url()`);
    if (f.endsWith(".mjs")) {
      assert.ok(!/\sstyle="/.test(text), `${f}: a view writes a style attribute (use data-w, data-left or data-gap)`);
      assert.ok(!/\bon(?:click|input|change)=/.test(text), `${f}: an inline event handler`);
    }
  }
});
