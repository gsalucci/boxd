// The dashboard service (docs/designs/dashboard.md, section 2): every poll it asks each build host over ssh for its state,
// keeps what history needs in plain files, and serves one JSON document and the page (dashboard/web/) on the loopback address. Read only: it runs the
// six reading verbs of boxd-pod and nothing else, never wakes a host (no ssh alias, no wake packet: it has no code for one)
// and has no authentication, because the reverse proxy in front of it is the door. The decisions are in fleet.mts.
//
//   node boxd-dashboard.mjs [settings.json]      (default: $BOXD_DASHBOARD_SETTINGS, else /etc/boxd/dashboard.json)
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOX_RE, RUN_RE, fleet, parseAnswer, parseReport, parseStatus } from "./fleet.mjs";
const DAY = 86_400_000;
const KEEP_MS = 7 * DAY; // the history that stays on disk
const CACHE_MS = 5_000; // an on-demand answer is reused this long
const MAX_WINDOWS = 64; // calls windows of one poll (64 MiB); the next poll goes on from the cursor
const HOST_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/; // no leading dash: an address is never read as an ssh option
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
// ---- settings: one JSON file, checked completely before anything starts ----
export function parseSettings(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (e) {
        throw new Error(`not valid JSON: ${e.message}`);
    }
    const bad = (m) => { throw new Error(m); };
    const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!isObj(raw))
        bad("the file must hold one JSON object");
    for (const k of Object.keys(raw))
        if (!["listen", "listenAnywhere", "pollSeconds", "stateDir", "hosts"].includes(k))
            bad(`unknown setting "${k}"`);
    const listen = String(raw.listen ?? "127.0.0.1:8377"), i = listen.lastIndexOf(":");
    const lhost = listen.slice(0, i).replace(/^\[(.*)\]$/, "$1"), lport = Number(listen.slice(i + 1));
    if (i < 0 || !/^\d{1,5}$/.test(listen.slice(i + 1)) || lport > 65535)
        bad(`"listen" must be <address>:<port>, got "${listen}"`);
    // The service has no login of its own: only a loopback address is allowed, the reverse proxy is the way in. A container is the one place a
    // loopback address cannot be reached by the proxy: there (and only there) "listenAnywhere": true allows any address.
    if (raw.listenAnywhere !== undefined && typeof raw.listenAnywhere !== "boolean")
        bad(`"listenAnywhere" must be true or false`);
    if (raw.listenAnywhere !== true && !(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lhost) || lhost === "::1" || lhost === "localhost"))
        bad(`"listen" must be a loopback address (127.x.x.x, ::1 or localhost) unless "listenAnywhere" is true, got "${lhost}"`);
    const pollSeconds = raw.pollSeconds === undefined ? 60 : raw.pollSeconds;
    if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600)
        bad(`"pollSeconds" must be a whole number from 5 to 3600`);
    const stateDir = raw.stateDir === undefined ? "/var/lib/boxd-dashboard" : raw.stateDir;
    if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || stateDir.includes("\0"))
        bad(`"stateDir" must be an absolute path`);
    if (!Array.isArray(raw.hosts) || raw.hosts.length === 0)
        bad(`"hosts" must be a list with at least one host`);
    const names = new Set(), hosts = [];
    for (const [n, h] of raw.hosts.entries()) {
        const at = `hosts[${n}]`;
        if (!isObj(h)) {
            bad(`${at} must be an object`);
            continue;
        }
        for (const k of Object.keys(h))
            if (!["name", "address", "port", "account", "keyFile", "sleeps"].includes(k))
                bad(`${at}: unknown setting "${k}"`);
        if (typeof h.name !== "string" || !HOST_RE.test(h.name))
            bad(`${at}: "name" must match ${HOST_RE}`);
        if (names.has(h.name))
            bad(`${at}: the name "${h.name}" is used twice`);
        names.add(h.name);
        if (typeof h.address !== "string" || !ADDRESS_RE.test(h.address))
            bad(`${at}: "address" must be a host name or an address, not an ssh option`);
        if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535)
            bad(`${at}: "port" must be a whole number from 1 to 65535`);
        if (typeof h.account !== "string" || !ACCOUNT_RE.test(h.account))
            bad(`${at}: "account" must match ${ACCOUNT_RE}`);
        if (typeof h.keyFile !== "string" || !path.isAbsolute(h.keyFile) || h.keyFile.includes("\0"))
            bad(`${at}: "keyFile" must be an absolute path`);
        try {
            if (!statSync(h.keyFile).isFile())
                bad(`${at}: "keyFile" ${h.keyFile} is not a file`);
        }
        catch (e) {
            if (e.code)
                bad(`${at}: "keyFile" ${h.keyFile} cannot be read (${e.code})`);
            throw e;
        }
        if (h.sleeps !== undefined && typeof h.sleeps !== "boolean")
            bad(`${at}: "sleeps" must be true or false`);
        hosts.push({ name: h.name, address: h.address, port: h.port, account: h.account, keyFile: h.keyFile, sleeps: h.sleeps === true });
    }
    return { listen: { host: lhost, port: lport }, pollSeconds, stateDir, hosts };
}
// ---- files: written to a fresh name and renamed, so a reader never sees half a file ----
let counter = 0;
function writeAtomic(file, text) {
    const tmp = `${file}.new-${process.pid}-${counter++}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
}
const readText = (file) => { try {
    return readFileSync(file, "utf8");
}
catch {
    return undefined;
} };
// Rewrites a file keeping the lines `keep` accepts (a line has no newline).
function trimFile(file, keep) {
    const t = readText(file);
    if (t === undefined)
        return false;
    const lines = t.split("\n").filter((l) => l !== "" && keep(l));
    const out = lines.length ? `${lines.join("\n")}\n` : "";
    if (out === t)
        return false;
    writeAtomic(file, out);
    return true;
}
// ---- the page: the files of the web folder, a fixed allow-list made at start ----
// Only same-origin scripts, styles, fonts and connections: the page has no inline script, event handler or style, and asks nothing elsewhere.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
};
// The request path is only ever a key of this map: it is looked up as a whole, never joined to a folder, so no "..", no absolute path and no
// encoded trick can reach a file that was not listed here. A file of an unknown type, a hidden file and a link are not listed.
export function pageFiles(dir) {
    const files = new Map();
    if (!existsSync(dir))
        return files;
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!e.isFile())
            continue;
        const full = path.join(e.parentPath, e.name), rel = path.relative(dir, full).split(path.sep);
        const type = TYPES[path.extname(e.name)];
        if (!type || rel.some((x) => x.startsWith(".")))
            continue;
        files.set("/" + rel.join("/"), { file: full, type });
    }
    const index = files.get("/index.html");
    if (index)
        files.set("/", index);
    return files;
}
export async function startService(settings, opts = {}) {
    const now = opts.now ?? Date.now, env = opts.env ?? process.env, log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
    const connectMs = opts.connectTimeoutMs ?? 3000, sshMs = opts.sshTimeoutMs ?? 20_000;
    mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
    const webDir = opts.webDir ?? env.BOXD_DASHBOARD_WEB ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
    const pages = pageFiles(webDir);
    if (!pages.has("/"))
        log(`boxd-dashboard: no page in ${webDir}: only the data is served`);
    const dirOf = (h) => path.join(settings.stateDir, h.name);
    const states = new Map();
    const lastTrim = new Map();
    let doc = null;
    // A plain connection to the address and port: the only thing sent to a host that may be asleep. Nothing is written to it.
    const answers = (h) => new Promise((resolve) => {
        const s = net.connect({ host: h.address, port: h.port });
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(connectMs, () => done(false));
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
    });
    const ssh = (h, command) => new Promise((resolve) => {
        const args = ["-F", "/dev/null", "-i", h.keyFile, "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "IdentitiesOnly=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
            "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${path.join(settings.stateDir, "known_hosts")}`, "-p", String(h.port), "--", `${h.account}@${h.address}`, command];
        const child = execFile("ssh", args, { env, timeout: sshMs, maxBuffer: 4 * 1048576, encoding: "utf8" }, (err, out, errText) => resolve({ code: err ? (err.code ?? (err.killed ? "timeout" : null)) : 0, out: String(out ?? ""), err: String(errText ?? "") }));
        child.stdin?.end();
    });
    // ---- stored state of one host ----
    function load(h) {
        const t = readText(path.join(dirOf(h), "host.json"));
        try {
            return t ? JSON.parse(t) : undefined;
        }
        catch {
            return undefined;
        }
    }
    const callsFile = (h) => path.join(dirOf(h), "calls.log");
    const cursorFile = (h) => path.join(dirOf(h), "cursor");
    // The cursor says how far the host's log was read and how long our copy was then: a copy longer than that holds a window
    // whose cursor was never written (a stop in between), and is cut back so the next read does not store it twice.
    function readCursor(h) {
        const m = /^(\d+) (\d+)\n$/.exec(readText(cursorFile(h)) ?? "");
        if (!m) {
            rmSync(callsFile(h), { force: true });
            return null;
        }
        try {
            if (statSync(callsFile(h)).size > Number(m[2]))
                truncateSync(callsFile(h), Number(m[2]));
        }
        catch { /* no copy yet */ }
        return Number(m[1]);
    }
    const saveCursor = (h, next) => writeAtomic(cursorFile(h), `${next} ${(() => { try {
        return statSync(callsFile(h)).size;
    }
    catch {
        return 0;
    } })()}\n`);
    function trim(h, t) {
        const cut = t - KEEP_MS, ms = (div) => (l) => { const v = Number(l.split("\t")[0]); return Number.isFinite(v) && v / div >= cut; };
        const cursor = readText(cursorFile(h));
        trimFile(callsFile(h), (l) => /^\d{13,16}\t/.test(l) && ms(1000)(l));
        trimFile(path.join(dirOf(h), "load.log"), ms(1));
        trimFile(path.join(dirOf(h), "events.log"), ms(1));
        const m = /^(\d+) /.exec(cursor ?? "");
        if (m)
            saveCursor(h, Number(m[1])); // the copy got shorter: the cursor records the new length
        lastTrim.set(h.name, t);
    }
    // ---- the document ----
    function lines(file) { return (readText(file) ?? "").split("\n").filter(Boolean).map((l) => l.split("\t")); }
    function rebuild() {
        const t = now();
        const hosts = settings.hosts.map((h) => {
            const s = states.get(h.name), d = dirOf(h);
            const samples = lines(path.join(d, "load.log")).filter((c) => /^\d+$/.test(c[0]) && Number.isFinite(Number(c[1]))).map((c) => c[2] !== undefined && /^\d+$/.test(c[2]) ? [Number(c[0]), Number(c[1]), Number(c[2])] : [Number(c[0]), Number(c[1])]);
            const kills = lines(path.join(d, "events.log")).filter((c) => c[1] === "kill" && /^\d+$/.test(c[0]) && /^\d+$/.test(c[2] ?? "")).map((c) => [Number(c[0]), Number(c[2])]);
            const text = (f) => readText(path.join(d, f));
            const input = { name: h.name, sleeps: h.sleeps, addr: h.address, state: s.state, detail: s.detail, seenAt: s.seenAt, sinceAt: s.sinceAt, load: samples, kills };
            const calls = text("calls.log"), report = text("last.report"), status = text("last.status"), list = text("last.list");
            if (calls)
                input.calls = calls;
            if (s.kind === "report" && report)
                input.report = report;
            if (s.kind === "status" && status) {
                input.status = status;
                if (list)
                    input.list = list;
            }
            return input;
        });
        const body = JSON.stringify(fleet({ now: t, hosts }));
        doc = { body, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"` };
    }
    // ---- one poll of one host (design: "One poll of one host") ----
    async function pollHost(h) {
        const d = dirOf(h), prev = states.get(h.name);
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const t = now();
        let state = "awake", detail = "", kind = prev?.kind ?? "none", oom = prev?.lastOom ?? null;
        let l1 = null, disk;
        if (!(await answers(h))) {
            state = h.sleeps ? "asleep" : "unreachable";
            detail = "no answer"; // nothing else is sent
        }
        else {
            const rep = await ssh(h, "pod report");
            if (rep.code === 0 && parseReport(rep.out)) {
                const parsed = parseReport(rep.out);
                writeAtomic(path.join(d, "last.report"), rep.out);
                kind = "report";
                l1 = Number(parsed.host.load1);
                disk = parsed.host.disk_pct;
                const now_ = Number(parsed.host.oom_kills);
                if (Number.isFinite(now_)) {
                    if (oom !== null && now_ > oom)
                        appendFileSync(path.join(d, "events.log"), `${t}\tkill\t${now_ - oom}\n`);
                    oom = now_;
                }
                await readCalls(h);
            }
            else if (rep.code === 125 && /unknown command/.test(rep.err)) {
                const st = await ssh(h, "pod status"), li = await ssh(h, "pod list"), parsed = st.code === 0 ? parseStatus(st.out) : null;
                if (parsed && li.code === 0) {
                    writeAtomic(path.join(d, "last.status"), st.out);
                    writeAtomic(path.join(d, "last.list"), li.out);
                    kind = "status";
                    detail = `server ${parsed.version}: status and box list only`;
                    l1 = Number(parsed.load1);
                    disk = parsed.disk_pct;
                }
                else {
                    state = "unreachable";
                    detail = "ssh refused";
                }
            }
            else if (rep.code === 125) {
                // The server refused the verb with a reason (a view key list with an old sshd settings file): show it.
                state = "unreachable";
                detail = (rep.err.split("\n").find((x) => x.trim()) ?? "refused").replace(/^boxd-pod: /, "").trim().slice(0, 200);
            }
            else {
                state = "unreachable";
                detail = rep.code === 255 ? "ssh refused" : rep.code === "timeout" ? "ssh timed out" : "ssh failed";
            }
        }
        if (state === "awake" && l1 !== null && Number.isFinite(l1))
            appendFileSync(path.join(d, "load.log"), `${t}\t${l1}${disk !== undefined && /^\d+$/.test(disk) ? `\t${disk}` : ""}\n`);
        const changed = !prev || prev.state !== state;
        if (changed)
            appendFileSync(path.join(d, "events.log"), `${t}\tstate\t${state}\n`);
        const next = { state, detail, kind, lastOom: oom, seenAt: state === "awake" ? t : (prev?.seenAt ?? null), sinceAt: changed ? t : prev.sinceAt };
        writeAtomic(path.join(d, "host.json"), JSON.stringify(next));
        states.set(h.name, next);
        if (now() - (lastTrim.get(h.name) ?? 0) >= DAY)
            trim(h, now());
    }
    // The call log from the cursor, window by window while the host says more is waiting; a failure leaves the cursor where it was.
    async function readCalls(h) {
        let off = readCursor(h);
        for (let i = 0; i < MAX_WINDOWS; i++) {
            const r = await ssh(h, off === null ? "pod calls" : `pod calls ${off}`);
            const a = r.code === 0 ? parseAnswer(r.out) : null;
            if (!a || a.kind !== "calls")
                return;
            if (a.body)
                appendFileSync(callsFile(h), a.body, { mode: 0o600 });
            saveCursor(h, a.next);
            if (a.next >= a.size || a.next <= (off ?? -1))
                return;
            off = a.next;
        }
    }
    // ---- poll all hosts: in parallel, independent; a poll that is running is not started twice ----
    let running = null;
    const poll = () => running ??= (async () => {
        await Promise.all(settings.hosts.map((h) => pollHost(h).catch((e) => log(`boxd-dashboard: poll of ${h.name} failed: ${e.message}`))));
        rebuild();
    })().finally(() => { running = null; });
    // ---- on demand: one ssh per host at a time, an answer reused for a few seconds, only while the host is awake ----
    const chain = new Map(), cache = new Map();
    function onDemand(h, key, command, shape) {
        const fresh = () => { const c = cache.get(key); return c && now() - c.at < CACHE_MS ? c.res : undefined; };
        const hit = fresh();
        if (hit)
            return Promise.resolve(hit);
        const run = (chain.get(h.name) ?? Promise.resolve()).then(async () => {
            const again = fresh();
            if (again)
                return again;
            const res = shape(await ssh(h, command));
            if (res.status === 200) {
                for (const [k, c] of cache)
                    if (now() - c.at >= CACHE_MS)
                        cache.delete(k);
                cache.set(key, { at: now(), res });
            }
            return res;
        });
        chain.set(h.name, run.catch(() => undefined));
        return run;
    }
    const fail = (r) => ({ status: 502, body: { error: r.code === "timeout" ? "the host did not answer in time" : "the host did not answer" } });
    // ---- http: the data paths, the page's own files, nothing else ----
    async function sendPage(page, head, res) {
        try {
            const body = await readFile(page.file);
            res.writeHead(200, {
                "content-type": page.type, "content-length": body.length, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
                "content-security-policy": CSP, "x-frame-options": "DENY",
                // a script or a page that changed must be noticed at once; a font never changes under its name
                "cache-control": page.type === "font/woff2" ? "public, max-age=86400" : "no-cache",
            });
            res.end(head ? undefined : body);
        }
        catch {
            res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
            res.end('{"error":"not found"}');
        }
    }
    const server = createServer((req, res) => {
        const send = (status, body, extra = {}) => {
            const text = typeof body === "string" ? body : JSON.stringify(body);
            res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", ...extra });
            res.end(text);
        };
        if (req.method !== "GET" && req.method !== "HEAD")
            return send(405, { error: "read only: GET and HEAD only" }, { allow: "GET, HEAD" });
        let url;
        try {
            url = new URL(req.url ?? "/", "http://localhost");
        }
        catch {
            return send(400, { error: "bad request" });
        }
        const q = (k) => url.searchParams.get(k);
        if (url.pathname === "/api/fleet.json") {
            if (!doc)
                return send(503, { error: "no data yet: the first poll has not finished" }, { "retry-after": "5" });
            if (req.headers["if-none-match"] === doc.etag) {
                res.writeHead(304, { etag: doc.etag, "cache-control": "no-cache" });
                return res.end();
            }
            return send(200, doc.body, { etag: doc.etag });
        }
        const page = pages.get(url.pathname);
        if (page)
            return void sendPage(page, req.method === "HEAD", res);
        if (url.pathname !== "/api/ps" && url.pathname !== "/api/log")
            return send(404, { error: "not found" });
        const hostName = q("host") ?? "", box = q("box") ?? "", run = q("run") ?? "", from = q("from");
        if (!HOST_RE.test(hostName) || !BOX_RE.test(box))
            return send(400, { error: "bad host or box name" });
        const isLog = url.pathname === "/api/log";
        if (isLog && !RUN_RE.test(run))
            return send(400, { error: "bad run id" });
        if (isLog && from !== null && !/^\d{1,18}$/.test(from))
            return send(400, { error: "bad offset" });
        const h = settings.hosts.find((x) => x.name === hostName);
        if (!h)
            return send(404, { error: "no such host" });
        if (states.get(h.name)?.state !== "awake")
            return send(409, { error: "the host is not awake" });
        const p = isLog
            ? onDemand(h, `log|${h.name}|${box}|${run}|${from ?? ""}`, `pod log ${box} ${run}${from === null ? "" : ` ${BigInt(from)}`}`, (r) => {
                if (r.code === 125)
                    return { status: 404, body: { error: r.err.replace(/^boxd-pod: /, "").trim().split("\n")[0] ?? "no such run" } };
                const a = r.code === 0 ? parseAnswer(r.out) : null;
                return a && a.kind === "log" ? { status: 200, body: { size: a.size, from: a.from, next: a.next, state: a.state, exit: a.exit, text: a.body } } : fail(r);
            })
            : onDemand(h, `ps|${h.name}|${box}`, `pod ps ${box}`, (r) => {
                if (r.code !== 0)
                    return r.code === 125 ? { status: 404, body: { error: r.err.replace(/^boxd-pod: /, "").trim().split("\n")[0] ?? "no such box" } } : fail(r);
                const ps = r.out.split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 5 && /^\d+$/.test(c[0])).map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), c[3], c.slice(4).join("\t")]);
                return { status: 200, body: { at: now(), ps } };
            });
        p.then((r) => send(r.status, r.body), () => send(502, { error: "the host did not answer" }));
    });
    // ---- start: stored state first, so a restart serves its history at once ----
    let any = false;
    for (const h of settings.hosts) {
        const s = load(h);
        if (s) {
            any = true;
            states.set(h.name, s);
            readCursor(h);
            trim(h, now());
        }
        else
            states.set(h.name, { state: h.sleeps ? "asleep" : "unreachable", detail: "no data yet", seenAt: null, sinceAt: now(), lastOom: null, kind: "none" });
    }
    if (any)
        rebuild();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(settings.listen.port, settings.listen.host, resolve); });
    let timer;
    if (opts.intervalMs)
        timer = setInterval(() => void poll(), opts.intervalMs);
    return {
        port: server.address().port, poll, server,
        close: async () => { if (timer)
            clearInterval(timer); await running; await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }); },
    };
}
async function main() {
    const file = process.argv[2] ?? process.env.BOXD_DASHBOARD_SETTINGS ?? "/etc/boxd/dashboard.json";
    let settings;
    try {
        const text = existsSync(file) ? readFileSync(file, "utf8") : undefined;
        if (text === undefined)
            throw new Error("the settings file does not exist");
        settings = parseSettings(text);
    }
    catch (e) {
        process.stderr.write(`boxd-dashboard: settings ${file}: ${e.message}\n`);
        process.exit(2);
    }
    let svc;
    try {
        svc = await startService(settings, { intervalMs: settings.pollSeconds * 1000 });
    }
    catch (e) {
        process.stderr.write(`boxd-dashboard: cannot start: ${e.message}\n`);
        process.exit(1);
    }
    process.stdout.write(`boxd-dashboard: listening on http://${settings.listen.host}:${svc.port}\n`);
    for (const sig of ["SIGTERM", "SIGINT"])
        process.on(sig, () => void svc.close().then(() => process.exit(0)));
    void svc.poll();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    void main();
