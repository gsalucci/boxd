// The dashboard's pure part (docs/designs/dashboard.md, "The document the service serves"): the text the hosts answered
// goes in, the one JSON document the browser reads comes out. No clock, no file, no network: the time is an input, so
// tests/dashboard-data.test.mts can recompute the document from recorded answers. The loop that asks the hosts is
// boxd-dashboard.mts.
// The patterns of server/boxd-pod (BOX_RE, RUN_RE): anything that reaches an ssh command line must match them.
export const BOX_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const RUN_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DAY = 86_400_000;
const LOAD_WINDOW = 7_200_000;
const CALLS_MAX = 2000;
const LOCK_WAIT_MS = 10_000;
const kv = (line) => {
    const o = {};
    for (const w of line.split("\t").slice(1)) {
        const i = w.indexOf("=");
        if (i > 0)
            o[w.slice(0, i)] = w.slice(i + 1);
    }
    return o;
};
const num = (s) => (s !== undefined && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);
const dash = (s) => (s === undefined || s === "-" || s === "" ? null : s);
const gib = (mb) => (mb === null ? null : Math.round((mb / 1024) * 100) / 100);
// The header line of `pod calls` and `pod log`, then the body untouched. Anything else (an error text) is null.
export function parseAnswer(text) {
    const i = text.indexOf("\n"), head = i < 0 ? text : text.slice(0, i), body = i < 0 ? "" : text.slice(i + 1);
    const w = head.split("\t"), k = kv(head);
    const size = num(k.size), from = num(k.from), next = num(k.next);
    if ((w[0] !== "calls" && w[0] !== "log") || size === null || from === null || next === null)
        return null;
    if (w[0] === "calls")
        return { kind: "calls", size, from, next, body };
    return { kind: "log", size, from, next, state: k.state ?? "", exit: num(k.exit), body };
}
export function parseReport(text) {
    const r = { host: {}, boxes: [], runs: [], images: [], evictions: [] };
    let seen = false;
    for (const line of text.split("\n")) {
        const kind = line.slice(0, line.indexOf("\t"));
        if (kind === "host") {
            r.host = kv(line);
            seen = true;
        }
        else if (kind === "box")
            r.boxes.push(kv(line));
        else if (kind === "run")
            r.runs.push(kv(line));
        else if (kind === "image")
            r.images.push(kv(line));
        else if (kind === "evicted")
            r.evictions.push(kv(line));
    }
    return seen && r.host.version ? r : null;
}
export const parseStatus = (text) => { const l = text.split("\n").find((x) => x.startsWith("version=")); return l ? kv(`s\t${l}`) : null; };
// `pod list` of a 0.2.0 server: box, image, state, last used, engine.
export function parseList(text) {
    const out = [];
    for (const line of text.split("\n")) {
        const c = line.split("\t");
        if (c.length >= 5 && BOX_RE.test(c[0]))
            out.push({ name: c[0], image: c[1], state: c[2], lastUsed: num(c[3]) ?? 0, engine: c[4] });
    }
    return out;
}
// Seven to nine tab separated columns (server 0.2.0 wrote seven); a line that is not one is left out, and so is a column beyond the ninth.
export function parseCalls(text, host) {
    const out = [];
    for (const line of text.split("\n")) {
        const c = line.split("\t");
        if (c.length < 7 || !/^\d{13,16}$/.test(c[0]) || !c[1] || !/^\d+$/.test(c[3]) || !/^(\d+|detached)$/.test(c[4]) || !/^\d+$/.test(c[5]))
            continue;
        out.push({ at: Math.floor(Number(c[0]) / 1000), host, box: c[1].slice(0, 200), engine: (c[2] ?? "").slice(0, 20), cmd: dash(c[8])?.slice(0, 200) ?? null,
            dur: Number(c[5]), lock: Number(c[3]), exit: c[4] === "detached" ? null : Number(c[4]), reason: dash(c[6])?.slice(0, 500) ?? null, run: dash(c[7])?.slice(0, 64) ?? null });
    }
    return out;
}
const versionKey = (v) => v.split(".").map((x) => Number(x) || 0);
export const newest = (vs) => {
    let best = "";
    for (const v of vs)
        if (v) {
            const a = versionKey(v), b = versionKey(best);
            if (!best || a.some((x, i) => x !== (b[i] ?? 0) ? x > (b[i] ?? 0) : false))
                best = v;
        }
    return best;
};
// Hosts: the fields of a host that did not say are null. Stale: not awake, the values are the last known.
function hostRow(h, rep, st, now) {
    const r = rep?.host ?? {};
    const power = rep ? r.power : undefined, idleChecks = num(r.idle_checks);
    const gmax = num(r.group_mem_max_mb), gused = num(r.group_mem_used_mb);
    const diskPct = num(r.disk_pct ?? st?.disk_pct);
    const last = h.kills.length ? h.kills[h.kills.length - 1][0] : null;
    const vmMax = num((r.vm_max ?? st?.vm_max));
    const gpus = num(r.gpus ?? st?.gpus);
    const room = r.vm_room ?? st?.vm_room;
    const l1 = num(r.load1 ?? st?.load1);
    const sw = num(r.swap_total_mb), pr = num(r.pressure_some10);
    const loadHist = h.load.filter((s) => s[0] >= now - LOAD_WINDOW).map((s) => s[1]);
    return {
        id: h.name, state: h.state, detail: h.detail, sleeps: h.sleeps, addr: h.addr, version: r.version ?? st?.version ?? null, report: rep !== null,
        seenAt: h.seenAt, sinceAt: h.sinceAt, stale: h.state !== "awake",
        powerModule: power === "on" ? true : power === "off" ? false : null,
        threads: num(r.cpus ?? st?.cpus), ramGiB: gib(num(r.mem_total_mb)), bootAt: num(r.boot) === null ? null : num(r.boot) * 1000,
        load: l1 === null ? null : [l1, num(r.load5), num(r.load15)], loadHist,
        memAvailGiB: gib(num(r.mem_avail_mb)), buildMemMaxGiB: gib(gmax), buildMemUsedGiB: gib(gused),
        buildMemFreeGiB: gmax !== null && gused !== null ? gib(gmax - gused) : gib(num(st?.mem_free_mb)),
        boxMemGiB: gib(num(r.box_mem_mb)), vmMemGiB: gib(num(r.vm_mem_mb)),
        swap: sw === null ? null : { usedGiB: gib(num(r.swap_used_mb) ?? 0), totalGiB: gib(sw) },
        pressure: pr === null ? null : { some10: pr, some60: num(r.pressure_some60) ?? 0, full10: num(r.pressure_full10) ?? 0, full60: num(r.pressure_full60) ?? 0 },
        memKills: num(r.oom_kills), lastKillAt: rep ? last : null,
        vmInstalled: (r.engines ?? st?.engines ?? "").split(",").includes("vm"), vmUsed: num(r.vm_used ?? st?.vm_used), slotsMax: vmMax,
        vmRoom: room === "yes" ? true : room === "no" ? false : null,
        disk: diskPct === null ? null : { pct: diskPct, totalGiB: gib(num(r.disk_total_mb)), usedGiB: gib(num(r.disk_used_mb)), thresholdPct: num(r.reset_at) },
        ttlSec: num(r.ttl),
        idle: power === "on" && idleChecks !== null ? { timeoutSec: idleChecks * 60, quietSec: (num(r.idle_count) ?? 0) * 60, busy: dash(r.idle_last) } : null,
        ...(gpus !== null && gpus >= 1 ? { gpus } : {}), // graphics cards of the host (since server 0.4.79); no field for none or an older server
        keepawake: r.keepawake === "held" ? true : r.keepawake === "free" ? false : null,
    };
}
export function fleet(inp) {
    const now = inp.now;
    const reports = inp.hosts.map((h) => (h.report ? parseReport(h.report) : null));
    const statuses = inp.hosts.map((h) => (h.status ? parseStatus(h.status) : null));
    const hosts = inp.hosts.map((h, i) => hostRow(h, reports[i], statuses[i], now));
    const allCalls = inp.hosts.flatMap((h) => parseCalls(h.calls ?? "", h.name)).filter((c) => c.at >= now - DAY);
    allCalls.reverse(); // so the stable sort below puts a later line first among equal times
    allCalls.sort((a, b) => b.at - a.at);
    const calls = allCalls.slice(0, CALLS_MAX);
    const lastExit = (host, box) => allCalls.find((c) => c.host === host && c.box === box && c.exit !== null)?.exit ?? null;
    const startOf = (host, run) => allCalls.find((c) => c.host === host && c.run === run);
    const boxes = [], images = [], services = [];
    inp.hosts.forEach((h, i) => {
        const rep = reports[i], ttl = num(rep?.host.ttl);
        const row = (name, engine, image, state, lastUsed, extra) => {
            const lastUsedAt = lastUsed > 0 ? lastUsed * 1000 : null;
            boxes.push({ name, host: h.name, engine, image, state: state === "running" ? "running" : "stopped", userFlag: null, size: null,
                lastUsedAt, ttlAt: lastUsedAt !== null && ttl !== null ? lastUsedAt + ttl * 1000 : null, memGiB: null, memLimitGiB: null, busy: null,
                lastExit: lastExit(h.name, name), runs: [], ...extra });
        };
        if (rep) {
            for (const b of rep.boxes) {
                if (!b.box || !BOX_RE.test(b.box))
                    continue;
                const runs = rep.runs.filter((r) => r.box === b.box && RUN_RE.test(r.id ?? "")).map((r) => {
                    const call = startOf(h.name, r.id);
                    return { id: r.id, state: r.state === "running" ? "detached" : "exited", exit: num(r.exit), startedAt: call?.at ?? null, cmd: call?.cmd ?? null,
                        logBytes: num(r.bytes) ?? 0, changedAt: (num(r.changed) ?? 0) * 1000 };
                });
                row(b.box, b.engine === "vm" ? "vm" : "container", b.image ?? "", b.state ?? "", num(b.last_used) ?? 0, {
                    userFlag: b.user === "yes" ? true : b.user === "no" ? false : null, size: b.size === "small" || b.size === "medium" || b.size === "large" ? b.size : null,
                    memGiB: gib(num(b.mem_mb)), memLimitGiB: gib(num(b.mem_limit_mb)), busy: b.busy === "yes" ? true : b.busy === "no" ? false : null, runs
                });
            }
            for (const im of rep.images) {
                if (!im.name || !/^[A-Za-z0-9_.-]+$/.test(im.name))
                    continue;
                const tag = `localhost/${im.name}:latest`;
                images.push({ host: h.name, name: im.name, tag, archive: `${im.name}.tar`, sizeGiB: gib(num(im.bytes) === null ? null : num(im.bytes) / 1048576),
                    builtAt: num(im.built) === null ? null : num(im.built) * 1000, usedBy: rep.boxes.filter((b) => b.image === tag).length });
            }
        }
        else if (h.list) {
            for (const b of parseList(h.list))
                row(b.name, b.engine === "vm" ? "vm" : "container", b.image, b.state, b.lastUsed, {});
        }
        if (!rep && statuses[i]) {
            for (const name of (statuses[i].images ?? "").split(",")) {
                if (!/^[A-Za-z0-9_.-]+$/.test(name))
                    continue;
                const tag = `localhost/${name}:latest`;
                images.push({ host: h.name, name, tag, archive: `${name}.tar`, sizeGiB: null, builtAt: null, usedBy: boxes.filter((b) => b.host === h.name && b.image === tag).length });
            }
        }
        const up = h.state === "awake", v = hosts[i].version;
        const power = rep ? (rep.host.power === "on" ? "active" : "inactive") : "unknown";
        services.push({ host: h.name, name: "boxd", version: v, status: up && (rep || statuses[i]) ? "active" : "unknown" }, { host: h.name, name: "boxd-sshd", version: v, status: up && (rep || statuses[i]) ? "active" : "unknown" }, { host: h.name, name: "boxd-power", version: v, status: up ? power : "unknown" });
    });
    return { schema: 1, generatedAt: now, version: newest(hosts.map((h) => h.version)), hosts, boxes, calls, callsCut: allCalls.length > CALLS_MAX, images, services,
        alerts: alerts(inp, hosts, allCalls) };
}
// The rules of the design's "Alert rules": each one is a function of the document's own data.
function alerts(inp, hosts, calls) {
    const now = inp.now, out = [];
    const id = (kind, host, box) => `${kind}|${host}|${box ?? ""}|`;
    inp.hosts.forEach((h, i) => {
        const row = hosts[i];
        if (h.state === "unreachable") {
            out.push({ id: id("unreachable", h.name, null), kind: "unreachable", severity: "danger", host: h.name, box: null, sinceAt: h.sinceAt, lastAt: now, count: 1,
                title: `${h.name} does not answer`, detail: h.detail, action: "Check that the host is on and that boxctl status shows boxd up." });
        }
        const samples = h.load.filter((s) => s[0] >= now - DAY).sort((a, b) => a[0] - b[0]);
        if (h.state === "awake" && row.load && row.threads !== null && row.load[0] > row.threads) {
            // An episode is a run of samples above the thread count; the alert is open while the current one lasts.
            let episodes = 0, since = h.seenAt ?? now, prev = false;
            for (const s of samples) {
                const above = s[1] > row.threads;
                if (above && !prev) {
                    episodes++;
                    since = s[0];
                }
                if (!above)
                    since = h.seenAt ?? now;
                prev = above;
            }
            out.push({ id: id("load", h.name, null), kind: "load", severity: "warning", host: h.name, box: null, sinceAt: since, lastAt: h.seenAt ?? now, count: Math.max(episodes, 1),
                title: `Load on ${h.name} is above its ${row.threads} threads`, detail: `Load ${row.load[0]}: calls wait for a processor.`,
                action: "Nothing to do unless it lasts; then move a worktree to another host with box --host." });
        }
        const thr = row.disk?.thresholdPct;
        if (h.state === "awake" && row.disk && thr !== null && thr !== undefined && row.disk.pct >= thr) {
            let since = h.seenAt ?? now;
            for (let k = samples.length - 1; k >= 0; k--) {
                const d = samples[k][2];
                if (d === undefined || d < thr)
                    break;
                since = samples[k][0];
            }
            out.push({ id: id("disk", h.name, null), kind: "disk", severity: "warning", host: h.name, box: null, sinceAt: since, lastAt: h.seenAt ?? now, count: 1,
                title: `Disk of ${h.name} is ${row.disk.pct}% full`, detail: `The work area is at or above the reset threshold of ${thr}%.`,
                action: "When no session is using the host, run boxd-reset work on it; the reset view says what that loses and keeps." });
        }
        // Retention (server 0.4.0): what boxd removed by itself in the last day. Nothing to do; shown so that a missing folder is no surprise.
        const gone = ((h.report ? parseReport(h.report) : null)?.evictions ?? []).filter((e) => num(e.at) !== null && num(e.at) * 1000 >= now - DAY && e.box);
        if (gone.length) {
            out.push({ id: id("evicted", h.name, null), kind: "evicted", severity: "warning", host: h.name, box: null, sinceAt: num(gone[0].at) * 1000, lastAt: num(gone[gone.length - 1].at) * 1000,
                count: gone.length, title: `boxd removed ${gone.length} item${gone.length > 1 ? "s" : ""} on ${h.name} to keep it clean`,
                detail: gone.slice(-8).map((e) => `${e.box} (${e.reason ?? "?"})`).join(", "),
                action: "Nothing to do. A box folder goes when its worktree is gone, after 14 days without a call, or when the disk is 70 percent full; the full list is cache/evictions.log on the host." });
        }
        const kills = h.kills.filter((k) => k[0] >= now - DAY);
        if (kills.length) {
            out.push({ id: id("memory-kill", h.name, null), kind: "memory-kill", severity: "danger", host: h.name, box: null, sinceAt: kills[0][0], lastAt: kills[kills.length - 1][0],
                count: kills.reduce((n, k) => n + k[1], 0), title: `Memory kills in the build group of ${h.name}`,
                detail: "The kernel ended processes because the build group reached its memory cap.",
                action: "Find the box that fills its memory in the boxes view; use a smaller machine size or fewer builds at once." });
        }
    });
    // Calls, grouped by host and box, in time order (`calls` is newest first).
    const groups = (pick) => {
        const m = new Map();
        for (const c of [...calls].reverse())
            if (pick(c)) {
                const k = `${c.host}|${c.box}`;
                (m.get(k) ?? m.set(k, []).get(k)).push(c);
            }
        return [...m.values()];
    };
    for (const g of groups((c) => c.lock > LOCK_WAIT_MS)) {
        const f = g[0], l = g[g.length - 1];
        out.push({ id: id("lock-wait", f.host, f.box), kind: "lock-wait", severity: "warning", host: f.host, box: f.box, sinceAt: f.at, lastAt: l.at, count: g.length,
            title: `Calls of box ${f.box} waited for its lock on ${f.host}`, detail: `Longest wait ${Math.max(...g.map((c) => c.lock))} ms. One call at a time uses a box.`,
            action: "Look for a long call of the same worktree with box ps." });
    }
    // Refused: exit 125 with a reason, or exit 75 (no room). Boxes named agent-* are the acceptance tests, which refuse on purpose.
    for (const g of groups((c) => ((c.exit === 125 && c.reason !== null) || c.exit === 75) && !c.box.startsWith("agent-"))) {
        const f = g[0], l = g[g.length - 1], why = l.reason ?? "refused";
        out.push({ id: id("refused", f.host, f.box), kind: "refused", severity: "warning", host: f.host, box: f.box, sinceAt: f.at, lastAt: l.at, count: g.length,
            title: `${g.length} ${g.length === 1 ? "call" : "calls"} of box ${f.box} refused on ${f.host}`, detail: why,
            action: why.startsWith("no room") ? "Wait for a virtual machine to end, stop one, or place the worktree on another host with box --host." : "The server refused the call before anything ran; the reason above says what to change." });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt || (a.id < b.id ? -1 : 1));
}
