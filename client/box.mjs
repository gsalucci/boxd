// box: runs a command in the calling worktree's own box on a boxd build server (see docs/pod-contract.md).
//   box [--host <name>] [--pod <name>] [--image <ref> | --image-file <path>] [--vm|--container] [--size small|medium|large|xlarge] [--user] [--kvm] [--recreate] [--no-sync] [--snapshot | --git | --commit <rev>] [--history] [--detach] [--wait] [--pull <path>]... [--] <command...>
//   box --shards <n> [--tail <n>] [the usual run options] -- <command with {shard} and {shards}...>
//   box image push [--host <name>] [--vm|--container] <ref>
//   box setup <host> [--hostname <name>] [--port <n>] [--user <name>] [--identity <file>] [--wake <mac>,<mac> --broadcast <addr>] [--default]
//   box hosts
//   box runs [--follow [--tail <n>]] [--pod <pattern>]... [--host <name>]
//   box --version
//   box log <run> [--pod <name>] [--host <name>] [--follow] [--tail <n>] [--state]
//   box log <run> --events [--pod <name>] [--host <name>]
//   box forward [--host <name>] [--pod <name>] <local-port> <box-port>
//   box vnc [--host <name>] [--pod <name>] [--port <box-port>]
//   box drop [--pod <name>] [--host <name>]
//   box stop [--pod <name>] [--host <name>]
//   box stop --run <run> [--pod <name>] [--host <name>]
//   box gc [--dry-run]
// Built with tsc-rs (see tsconfig.json); the emitted box.mjs is what runs.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
export const VERSION = "0.4.61";
const BOX = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
export const HELP = `usage: box [options] [--] <command...>
       box --shards <n> [--tail <n>] [options] -- <command...>   (the command in <n> boxes side by side; see --shards below)
       box setup <host> [options]      (once per build server; box setup --help)
       box hosts                       the registered build servers in order: asleep, awake (with its \`pod status\` line) or unreachable
       box image push [--host <name>] [--vm|--container] <ref>
                                       send an image from your machine to the build server's store for that engine (default
                                       container): for images of private registries, whose login stays on your machine. Pulls
                                       <ref> here with your own login (podman, else docker), then streams it over ssh; nothing is
                                       sent when the server already has the same image. <ref> must be one a box may ask for by name
                                       (an allowed registry); then \`box --image <ref>\` uses the pushed copy
       box runs                        the detached runs still running on the build servers (those of this machine's boxes): host, box,
                                       run id, age, worktree and the last line of the output, tab separated; a sleeping server is
                                       not woken, only named; changes nothing
       box runs --host <name>          only the runs on that build server (not woken if asleep); combines with --pod, --follow and --tail
       box runs --pod <pattern>        only the runs of boxes whose name matches <pattern> (\`*\` any characters, \`?\` one, the rest literal; repeatable)
       box runs --follow [--tail <n>]  the same, then waits until all of those runs have ended and prints one line for each as it
                                       ends: host, box, run id and exit=<code> (exit=- when the server knows none), tab separated;
                                       exits 0 when every one ended with 0, else 1 (with --pod only the matching runs count); asks every 30 s ($BOXD_RUNS_POLL_MS in ms);
                                       runs that start later are not followed; ends (exit 129) with the process that started it;
                                       --tail <n> (0 to 100000) also prints the last <n> lines of each run's log when it ends, under a line naming the run
       box ps [--pod <name>] [--host <name>]   processes running in this worktree's box, oldest first, with their
                                       age, processor time and working folder: spots a hung command; changes nothing
       box log <run> [--pod <name>] [--host <name>] [--follow] [--tail <n>] [--state]
                                       the log of a --detach run, read from the server without starting the box (a stopped box
                                       stays stopped); --follow keeps reading until the run ended and exits with its code (last line on standard error then: "box: run <run> exit <code> on <host>"); --tail <n> (0 to 100000) prints only the
                                       last <n> lines of what the log holds at first (then, with --follow, all that comes after); --state prints no log, only one line
                                       <run> state=running|ended exit=<code> (exit=- while running or when the run ended without a code), tab separated; an ended run adds
                                       ended=<time in UTC, like 2026-11-16T17:48:47Z> and, when the server knows when the run began, seconds=<wall seconds>; for a running run also age (seconds since it started) and quiet (seconds since the run last printed to standard output or standard error; files it writes do not count):
                                       "box log <run> --follow --tail 20" shows how an ended run ended, and exits with its code
       box log <run> --events [--pod <name>] [--host <name>]
                                       after a --detach run ended: the server's own record of what could have disturbed it (memory stalls, kills
                                       for memory, in a machine box guest_kills and machine_size and machine_mb (the size the run began with), a full /job: disk_full, network card stalls, other boxes busy, other runs of the same box: siblings), one key=value per line; exit 0 when the record covers the
                                       whole run, 3 when it does not (the reason on standard error, the lines still printed); excludes --follow, --tail, --state
       box forward [--host <name>] [--pod <name>] <local-port> <box-port>
                                       reach a port of this worktree's running container box (loopback inside it) on the loopback address here
                                       (0 picks a free local port); one ssh per connection, no sync, starts nothing; Ctrl+C stops
       box vnc [--host <name>] [--pod <name>] [--port <box-port>]
                                       forward (default box port 5900) and open vnc://<loopback>:<port> with xdg-open
       box drop [--pod <name>] [--host <name>]
                                       removes this worktree's box and its files on the build server now, and its record here, for a worktree you
                                       delete yourself (run it from inside the worktree, before deleting it): the collector would wait 15 minutes
                                       for its second pass. Refuses while a command runs in the box; a sleeping server is not woken (exit 1); with --pod only a box this
                                       machine recorded for this worktree, or for a worktree that is gone, is removed
       box stop [--pod <name>] [--host <name>]
                                       stops this worktree's box on the build server and frees its memory, and keeps its files and its record: the
                                       next call makes the box again on the same files (build outputs stay). Same guards as box drop
       box stop --run <run> [--pod <name>] [--host <name>]
                                       ends that one detached run and nothing else: the box keeps running, with its files and its other runs
                                       (a run that already ended: nothing to do, exit 0). Not for box drop
       box gc [--dry-run]              the collector: removes the boxes and server files of this machine's worktrees that no longer exist (a worktree
                                       must be found missing by two passes 15 minutes apart; a box with a run still going is kept until it ends), lists boxes that no worktree here
                                       owns ("unknown owner", nothing is touched) and reports commands running over 6 hours;
                                       --dry-run only says what it would do. Runs by itself after an ordinary call, at most every
                                       15 minutes ($BOXD_GC=0 turns that off); records in ~/.local/state/boxd
The words setup, runs, hosts, image, ps, log, forward, vnc, drop, stop and gc must come first (box drop --host <name>): after an option, as in box --host <name> drop,
they are refused (exit 2); to run a program of that name in the box, write -- before it.
Syncs the git worktree you are in to the build server, runs <command> in this worktree's own box (a podman
container or, with --vm, a small virtual machine; the same box on every call) and passes its exit code through; once the command was handed to a server, the last line on standard error is "box: exit <code> on <host>" (not with --detach or --shards). Use sh -c '...' for shell syntax.
  --image <ref>    image for a new box (default debian:stable-slim); an existing box keeps its image when you
                   leave this out, naming another one needs --recreate
  --image-file <path>  build the box's image from this Containerfile (path inside the worktree, relative to its top
                   folder; not with --image). The box is replaced by itself when the built image changes (files
                   stay); FROM lines and downloads in the build are not limited to the allowed registries
  --vm             a new box is a small virtual machine (own kernel, root, docker or podman inside); an existing
                   box keeps its engine when you leave this out, switching needs --recreate
  --container      ask for a container box explicitly (to switch a virtual machine back, with --recreate)
  --size <size>    size of a new virtual machine box: small (2 processors, 2 GB), medium (4 processors, 4 GB),
                   large (the server's default machine, also what no --size means) or xlarge (8 processors, 12 GB). An
                   existing box keeps its size; naming another one needs --recreate. Virtual machine boxes only
  --env <NAME>     hand the credential NAME from your environment to the command (repeatable; names ending in
                   _TOKEN, _KEY, _SECRET or _PASSWORD); sent by ssh's own environment passing, never on the command
                   line, in a file or a log
  --user           the box runs every command as an unprivileged user that owns the synced files (container and
                   virtual machine boxes; a machine's account has the number 1000 and may run docker); an existing box keeps
                   it once made with it, adding it to a root box needs --recreate. A hosted CI runner is --vm --user --git
  --kvm            the box gets the host's /dev/kvm, so QEMU inside runs on hardware virtualization (container boxes
                   only; the same virtualization the build account has); kept like --user, adding it needs --recreate
  --recreate       replace the box with a fresh one (files stay; same engine and image unless you name others)
  --detach         run in the background; prints a run id and the command that reads its log (box log); --pull does nothing
                   with it. Files outside /job go when the idle box is removed: keep results under /job/src. Only a detached
                   run outlives its starter: a foreground call ends with the process that started it (it ends when that
                   process is gone, exit 129; $BOXD_KEEP_ORPHAN=1 turns that off)
  --shards <n>     (2 to 32) run the command in <n> boxes of this worktree side by side and wait for all of them: boxes named like this
                   worktree's box with -s1 to -s<n> appended (with --pod <name>: <name>-s1 ...), each synced and started detached one
                   after the other, every {shard} in the command's words replaced by the box's number and every {shards} by <n> (a command
                   with neither is refused: box --shards 5 -- npx vitest --shard={shard}/{shards}). It then follows the runs, prints
                   one line as each ends (shard, host, box, run, exit code, seconds), then the last 20 lines of the log of each run that did not
                   end with 0 (--tail <n> changes the 20: 0 for none, and with --tail the tails are printed for every shard), stops the <n>
                   boxes (files and caches stay) and exits 0 only when every run ended with 0. Each shard is an ordinary box: admitted like
                   any box and with its own installed dependencies. A start refused for room ends the call and leaves the runs already
                   started running (follow them with box runs --follow --pod '<name>-s*'; --wait queues instead). Not with --detach, --pull,
                   --no-sync, --snapshot, forward or vnc
  --wait           when no build server has room (for a machine, or memory for another busy container box), wait and ask
                   again every 30 seconds ($BOXD_WAIT_MS) until the call can be placed, instead of exit 75 at once; a
                   worktree whose server is full moves first when it can. From server 0.4.41 the call keeps its place in
                   line: waiting callers are served in the order they first asked as far as memory allows, and the waiting line
                   tells its place and what holds the room. A refusal that waiting cannot fix (no server with the image or with virtual machines, none
                   reachable) still ends at once
  --pull <path>    after a foreground run, copy <path> (relative to the worktree) back; repeatable. Only changed
                   files travel (rsync)
  --host <name>    build server to use (ssh alias boxd-<name>) and the one this worktree stays on from now on. Without
                   it: $BOXD_HOST (this call only), else the host this worktree was placed on, else (first call, two or
                   more servers set up) the server with room that has the most free memory (ties: \`box hosts\` order; a
                   sleeping one counts as empty); for a machine (--vm) the awake server with room that has the smallest
                   memory cap for boxes, so the big server stays free for big machines; never waking a sleeping one just
                   to ask; no server with room: exit 75 with one reason per server. A worktree whose server has no room
                   moves to one that has by itself (one line says so), unless its box still holds a machine, a container
                   or a run there, or the call named a server (--host, $BOXD_HOST); then exit 75 and the command that moves it
  --pod <name>     use this box instead of the one derived from the worktree. For box gc the box belongs to the
                   worktree that made it, until that one is gone
  --no-sync        skip the sync
  --include <path> also send <path> (file or folder, relative to the worktree) although git ignores it; repeatable.
                   The sync sends what git counts as the worktree, so an ignored journal or state file needs this
  --clean          the box's source folder becomes exactly the worktree (plus --include): files git ignores that
                   earlier runs left there are deleted first. For measurements that must not see old results
  --ps-after <min> when a foreground call prints nothing for this many minutes (default 15, $BOXD_PS_AFTER), print the
                   box ps table to stderr, every line prefixed "[box ps] ", and again while the silence lasts;
                   0 turns it off (for callers that parse stderr strictly). Not on a terminal you are watching.
  --snapshot       commit the synced files to a git repository in the box first (a new commit named snapshot)
  --git            make /job/src a git repository at this worktree's own commit (same hash, one commit, no history, detached
                   head, no remote, no hooks, no name or mail); git status there shows what differs between the synced
                   files and that commit, so uncommitted work stays uncommitted. It stays in the box until the next call
                   with --git replaces it. Not with --snapshot or --no-sync
  --commit <rev>   run on what a fresh clone checked out at <rev> (a hash, branch, tag or HEAD) holds, not on your working folder:
                   only that commit's tracked files (modes and symbolic links kept, a submodule an empty folder), none of your
                   uncommitted edits, untracked or ignored files or build outputs, and /job/src is a git repository at that commit
                   (as --git makes it, so git status there is clean). For a check before a release, or to reproduce a hosted run;
                   use --git for everyday work on uncommitted changes. The box is the worktree's usual one (caches and /job/home stay)
                   but its source folder is replaced: builds start from a clean tree, files that earlier calls left in /job/src are
                   deleted (only /job/src changes; --pull still copies into your working folder). With --image-file the Containerfile
                   is the one of the commit. A later call without --commit syncs the working folder again, and the repository stays
                   until a --git or --commit call replaces it: mixing the two in one box alternates the source. Unknown <rev>: exit 2.
                   Not with --git, --snapshot, --no-sync, --include or --clean
  --history        with --git or --commit <rev>: the repository in the box holds every commit reachable from that commit (not one) and
                   every tag of your repository that points inside that history (annotated ones as tag objects), exactly as they are
                   at this call: a tag deleted or moved since the last call is gone or moved there. Still detached, no branches, no
                   remote, no hooks, no reflog. The history carries the names and mail addresses of its commits' authors: that is
                   in the commits, and sending them is your choice. For tests that run git describe, git tag or git log over several commits
  --version        print the version of this client
  --help           this text`;
export const SETUP_HELP = `usage: box setup <host> [options]
Writes this user's ssh entry \`Host boxd-<host>\` (in ~/.ssh/config), installs the Claude skill, remembers <host>
as the default and, when wake addresses are given, makes ssh wake the sleeping host first. Safe to run again.
  --hostname <name>      address or name ssh connects to (default: <host>)
  --port <n>             port of the build sshd (default 2222, BOXD_PORT on the server)
  --user <name>          build account (default boxd, BOXD_USER on the server)
  --identity <file>      ssh key to use for this host
  --wake <mac>,<mac>     network card addresses to send wake packets to (only for hosts that sleep)
  --broadcast <addr>     broadcast address of the host's network (needed with --wake)
  --default              make <host> the default host even when one is saved already
The order servers are tried in is ~/.config/boxd/hosts.order (one name per line; a new host goes last, --default puts it first).`;
// POSIX cksum: what the contract uses to tell worktrees with equal names apart.
function cksum(s) {
    const bytes = Buffer.from(s);
    let crc = 0;
    const feed = (b) => {
        crc ^= b << 24;
        for (let i = 0; i < 8; i++)
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
        crc >>>= 0;
    };
    for (const b of bytes)
        feed(b);
    for (let n = bytes.length; n > 0; n = Math.floor(n / 256))
        feed(n & 255);
    return ~crc >>> 0;
}
export function boxFor(toplevel) {
    // Leading characters outside a-z0-9 are dropped (".dotfiles" -> "dotfiles"): a box name must start with one.
    const base = (toplevel.split("/").filter(Boolean).pop() ?? "").toLowerCase().replace(/[^a-z0-9_.-]/g, "-")
        .replace(/^[^a-z0-9]+/, "").slice(0, 40) || "worktree";
    return `${base}-${cksum(toplevel)}`;
}
// --env names: credentials only (the server checks the same pattern before putting the value in the engine's environment).
export const SECRET = /^[A-Z][A-Z0-9_]{0,62}_(TOKEN|KEY|SECRET|PASSWORD)$/;
// flags: --git (the client's own, never sent), --pod <name>, --image <ref>, --image-file <path>, --vm, --container, --size <word>, --user, --kvm, --env <name>, --recreate, --snapshot, --detach <run>; other flags are the client's own.
export function plan(toplevel, flags, argv) {
    let pod, image, imageFile, run, recreate = false, snapshot = false, vm = false, container = false, user = false, kvm = false, size;
    const envs = [];
    for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if (f === "--pod")
            pod = flags[++i];
        else if (f === "--image")
            image = flags[++i];
        else if (f === "--image-file")
            imageFile = flags[++i];
        else if (f === "--detach")
            run = flags[++i];
        else if (f === "--vm")
            vm = true;
        else if (f === "--container")
            container = true;
        else if (f === "--size")
            size = flags[++i];
        else if (f === "--user")
            user = true;
        else if (f === "--kvm")
            kvm = true;
        else if (f === "--env")
            envs.push(flags[++i]);
        else if (f === "--recreate")
            recreate = true;
        else if (f === "--snapshot")
            snapshot = true;
    }
    const box = pod ?? boxFor(toplevel);
    if (flags.includes("--git") && snapshot)
        return { error: "box: --git and --snapshot cannot go together", exit: 2 };
    if (!BOX.test(box))
        return { error: `box: bad box name ${JSON.stringify(box)}`, exit: 2 };
    if (argv.length === 0 || argv.some((w) => w.includes("\0")))
        return { error: "box: no command given", exit: 2 };
    if (flags.includes("--image") && !image)
        return { error: "box: --image needs a value", exit: 2 };
    if (flags.includes("--image-file") && !imageFile)
        return { error: "box: --image-file needs a value", exit: 2 };
    if (image && imageFile)
        return { error: "box: --image and --image-file cannot go together", exit: 2 };
    // A plain relative path inside the worktree, as the server checks it again: no leading slash, no . or .. component.
    if (imageFile && (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(imageFile) || imageFile.length > 200 || imageFile.split("/").some((c) => c === "." || c === "..")))
        return { error: "box: --image-file must be a relative path inside the worktree", exit: 2 };
    if (vm && container)
        return { error: "box: --vm and --container cannot go together", exit: 2 };
    if (flags.includes("--size") && !["small", "medium", "large", "xlarge"].includes(size))
        return { error: "box: --size needs small, medium, large or xlarge", exit: 2 };
    const badEnv = envs.find((n) => !SECRET.test(n));
    if (badEnv !== undefined)
        return { error: `box: --env ${badEnv}: only names ending in _TOKEN, _KEY, _SECRET or _PASSWORD`, exit: 2 };
    if (run !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(run))
        return { error: "box: bad run id", exit: 2 };
    const opts = [image && `--image ${image}`, imageFile && `--image-file ${imageFile}`, vm && "--vm", container && "--container", size && `--size ${size}`, user && "--user", kvm && "--kvm", ...envs.map((n) => `--env ${n}`), recreate && "--recreate", snapshot && "--snapshot", run && `--detach ${run}`].filter(Boolean);
    if (image && /\s/.test(image))
        return { error: "box: bad image", exit: 2 };
    return { box, remote: ["pod run", box, ...opts, "--", Buffer.from(argv.join("\0")).toString("base64")].join(" ") };
}
// The sync must carry exactly the files git counts as part of the worktree: tracked ones (also force-added under an
// ignore rule) and untracked ones git does not ignore. rsync's own .gitignore reading misses git's negations
// (!pattern), .git/info/exclude and the global excludes, so the base filter is corrected: a local dry run shows what
// it would send, and each difference with git's list becomes a rule in a merge file read before the base filter.
// Files the base filter drops but git keeps are included (with their folders, whose other content stays excluded);
// files it would send but git ignores are excluded. Deletions keep working because the base filter stays.
const esc = (s) => s.replace(/[*?[\\]/g, (c) => "\\" + c);
export const BASE_FILTER = ["--safe-links", "--exclude=/.git", "--filter=:- .gitignore"];
// include: paths (relative to the top folder) sent although git ignores them; a folder stands for every file under it.
export function gitExactRules(toplevel, include = []) {
    const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: toplevel, encoding: "utf8", maxBuffer: 1 << 28 });
    if (git.status !== 0)
        return [];
    const want = new Set(git.stdout.split("\0").filter(Boolean));
    for (const p of include) {
        if (!statSync(path.join(toplevel, p)).isDirectory()) {
            want.add(p);
            continue;
        }
        for (const e of readdirSync(path.join(toplevel, p), { recursive: true, withFileTypes: true }))
            if (!e.isDirectory())
                want.add(path.relative(toplevel, path.join(e.parentPath, e.name)));
    }
    const dry = spawnSync("rsync", ["-a", "-n", "--out-format=%n", ...BASE_FILTER, `${toplevel}/`, path.join(tmpdir(), `boxd-dry-run-${process.pid}-never-created/`)], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (dry.status !== 0)
        return [];
    const sent = new Set(), dirs = new Set();
    for (const l of dry.stdout.split("\n"))
        if (l && l !== "./")
            (l.endsWith("/") ? dirs.add(l.slice(0, -1)) : sent.add(l));
    const inc = new Set(), exc = new Set(), sib = new Set();
    for (const f of want) {
        if (sent.has(f))
            continue;
        const parts = f.split("/").slice(0, -1);
        for (let i = 0; i < parts.length; i++) {
            const d = parts.slice(0, i + 1).join("/");
            if (!dirs.has(d)) {
                inc.add(`+ /${esc(d)}/`);
                sib.add(`- /${esc(d)}/*`);
            }
        }
        inc.add(`+ /${esc(f)}`);
    }
    for (const f of sent)
        if (!want.has(f))
            exc.add(`- /${esc(f)}`);
    return [...exc, ...inc, ...sib];
}
const pad = (n, w = 2) => String(n).padStart(w, "0");
export function newRunId(d = new Date(), hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex}`;
}
export function imagePlan(args) {
    let host, vm = false, container = false;
    const refs = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--vm")
            vm = true;
        else if (a === "--container")
            container = true;
        else if (a === "--host") {
            host = args[++i];
            if (!host)
                return { error: "box image push: --host needs a value", exit: 2 };
        }
        else if (a.startsWith("--"))
            return { error: `box image push: unknown option ${a}`, exit: 2 };
        else
            refs.push(a);
    }
    if (vm && container)
        return { error: "box image push: --vm and --container cannot go together", exit: 2 };
    const ref = refs[0];
    if (refs.length !== 1 || !ref)
        return { error: "box image push: give exactly one image reference", exit: 2 };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/.test(ref))
        return { error: "box image push: bad image reference", exit: 2 };
    const engine = vm ? "vm" : "container";
    return { host, engine, ref, has: `pod image has ${engine} ${ref}`, load: `pod image load ${engine} ${ref}` };
}
// The image is pulled here, with this machine's own registry login, which never leaves it: the host gets the image only,
// as a stream into ssh's standard input (no archive file here), and is asked first whether it has the same image.
function imagePush(args, env) {
    if (args[0] === "--help" || args[0] === "-h") {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const p = imagePlan(args);
    if ("error" in p)
        return usage(p.error);
    const HOST = hostAlias(p.host, env);
    if (!HOST)
        return usage("box: no build server named; run box setup <host>, or give --host <name>, or set BOXD_HOST");
    const tool = ["podman", "docker"].find((t) => !spawnSync(t, ["--version"], { stdio: "ignore" }).error);
    if (!tool)
        return usage("box image push: neither podman nor docker is installed here");
    const pulled = spawnSync(tool, ["pull", p.ref], { stdio: ["ignore", process.stderr, "inherit"] });
    if (pulled.status !== 0)
        return pulled.status ?? 1;
    // docker prints the id as sha256:<hex>, podman as <hex>; the server compares the hex.
    const id = spawnSync(tool, ["image", "inspect", "--format", "{{.Id}}", p.ref], { encoding: "utf8" }).stdout?.trim().replace(/^sha256:/, "");
    if (!id || !/^[a-f0-9]{12,64}$/.test(id))
        return usage(`box image push: cannot read the id of ${p.ref}`);
    const has = spawnSync("ssh", [HOST, `${p.has} ${id}`], { stdio: "inherit" }).status ?? 1;
    if (has === 0) {
        process.stdout.write(`box: ${p.ref} is already on ${HOST} for ${p.engine}, nothing sent\n`);
        return 0;
    }
    if (has !== 1)
        return has; // the server refused (the reference, the engine) or ssh failed
    return new Promise((resolve) => {
        const ssh = spawn("ssh", [HOST, `${p.load} ${id}`], { stdio: ["pipe", "inherit", "inherit"] });
        const save = spawn(tool, ["save", p.ref], { stdio: ["ignore", "pipe", "inherit"] });
        ssh.stdin.on("error", () => { });
        save.stdout.pipe(ssh.stdin);
        let saved, sent;
        const end = () => { if (sent === undefined || saved === undefined)
            return; resolve(saved || sent); };
        save.on("close", (c) => { saved = c ?? 1; if (saved)
            process.stderr.write(`box: ${tool} save failed\n`); end(); });
        ssh.on("close", (c) => { sent = c ?? 1; end(); });
    });
}
function usage(msg, help = HELP) {
    process.stderr.write(`${msg}\n${help}\n`);
    return 2;
}
const configDir = (env) => path.join(env.HOME ?? "", ".config", "boxd");
function readOr(file) {
    try {
        return readFileSync(file, "utf8").trim() || undefined;
    }
    catch {
        return undefined;
    }
}
// The ssh alias of the build server: --host, else $BOXD_HOST, else the host `box setup` saved.
export function hostAlias(flag, env) {
    const name = flag || env.BOXD_HOST || readOr(path.join(configDir(env), "host"));
    return name && NAME.test(name) ? `boxd-${name}` : undefined;
}
// ---- choosing a build host (docs/designs/load-management.md, docs/pod-contract.md "Host choice") ----
// Exit code of "no room": the host's refusal of a virtual machine or of a call into a container box that is not busy (with
// the stderr text below, which both refusals start with) and the client's own refusal when no host has room. 125 stays
// "refused for another reason".
export const NO_ROOM = 75;
const NO_ROOM_TEXT = "boxd-pod: no room for another";
const PROBE_SECONDS = 3; // network timeout of one probe, in parallel for every host
// The registered hosts: the marker blocks `box setup` wrote into ~/.ssh/config.
export function registered(env) {
    const conf = readOr(path.join(env.HOME ?? "", ".ssh", "config")) ?? "";
    return [...conf.matchAll(/^# boxd:host:boxd-(\S+):begin$/gm)].map((m) => m[1]);
}
// The order hosts are tried in: hosts.order, else the saved default host; registered hosts not listed come last.
export function hostOrder(env) {
    const reg = registered(env), dir = configDir(env);
    const listed = (readOr(path.join(dir, "hosts.order")) ?? readOr(path.join(dir, "host")) ?? "").split("\n").map((l) => l.trim());
    return [...new Set([...listed, ...reg])].filter((n) => reg.includes(n));
}
// Which host this call uses: --host (recorded), $BOXD_HOST (this call only), the recorded placement while that host is
// still registered, otherwise the client chooses.
export function source(flag, envHost, placed, reg) {
    if (flag)
        return { how: "flag", host: flag, record: true };
    if (envHost)
        return { how: "env", host: envHost, record: false };
    if (placed && reg.includes(placed))
        return { how: "placed", host: placed, record: false };
    return { how: "choose" };
}
// "key=value" words of a `pod status` line.
export const parseStatus = (line) => Object.fromEntries(line.trim().split("\t").filter((w) => w.includes("=")).map((w) => [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]));
// The host with room for this request that has the most free memory (`mem_free_mb`), ties in the given order. A machine
// (`--vm`) goes to the awake host with room that has the smallest cap for boxes (`group_mem_max_mb`) instead, so the big host
// stays free for big machines (reason `fit`); a host that reports no cap, and a sleeping one, come after those. Asleep
// counts as room and as the most free (nothing runs there; the call itself wakes it). Awake: a container
// has room unless the server says `box_room=no` (a call that starts work in a box needs the reserve of memory it prints;
// a server that prints no such word never refuses one), a virtual machine needs the engine and the server's own `vm_room=yes`, and a
// local image must be on the host; one whose memory is unknown comes after those that report it. An awake host that
// printed no status (a server older than `pod status`) is the last resort. Spreading by free memory, not filling the
// first host: on 2026-11-15 the first host took every new worktree until its kernel killed a machine, the second stayed idle.
// `room` lists every host that can take the call, best first (the retry after a lost race walks it); `notes` is one
// "<host>=<state or reason>" per host.
const SIZE_MB = { small: 2048, medium: 4096, xlarge: 12288 };
export function choose(hosts, req) {
    const want = req.image?.startsWith("localhost/") ? req.image.slice("localhost/".length).split(":")[0] : undefined;
    const room = [], late = [], why = [];
    const need = req.size ? SIZE_MB[req.size] : undefined;
    let waitable = false; // a host said no for room, which time can change (a missing image or engine, a host that is down: not)
    for (const h of hosts) {
        const s = h.status === undefined ? undefined : parseStatus(h.status);
        let no;
        if (h.state === "unreachable")
            no = "unreachable";
        else if (h.state === "asleep")
            room.push({ name: h.name, free: Infinity });
        else if (!s)
            late.push(h.name);
        else if (req.vm && !(s.engines ?? "").split(",").includes("vm"))
            no = "no virtual machines";
        else if (req.vm && need !== undefined && /^\d+$/.test(s.group_mem_max_mb ?? "") && need > Number(s.group_mem_max_mb))
            no = `${need} MB never fits, the cap is ${s.group_mem_max_mb} MB`; // from 0.4.52 the server refuses such a size for good; a wait could never end
        else if (req.vm && (need !== undefined && /^\d+$/.test(s.vm_fit_mb ?? "") ? Number(s.vm_fit_mb) < need : s.vm_room !== "yes")) {
            no = need !== undefined && /^\d+$/.test(s.vm_fit_mb ?? "") ? `${s.vm_fit_mb} MB fit, ${need} MB asked` : s.vm_why || (Number(s.vm_used) >= Number(s.vm_max) ? `${s.vm_used} of ${s.vm_max} machines` : `no memory for another machine (${s.vm_used} running)`);
            waitable = true;
        } // the server's own reason (0.4.11), else the count ceiling, else the memory rule
        else if (want && !(s.images ?? "").split(",").includes(want))
            no = `image ${want} missing`;
        else if (!req.vm && s.box_room === "no") {
            no = `no memory for another busy box (${s.box_fit_mb} MB fit, ${s.box_reserve_mb} MB wanted)`;
            waitable = true;
        }
        else
            room.push({ name: h.name, free: /^\d+$/.test(s.mem_free_mb ?? "") ? Number(s.mem_free_mb) : -1, ...(req.vm && /^\d+$/.test(s.group_mem_max_mb ?? "") ? { cap: Number(s.group_mem_max_mb) } : {}) });
        why.push(no ?? (h.state === "awake" && !s ? "awake, no status" : h.state));
    }
    const notes = hosts.map((h, i) => `${h.name}=${why[i]}`);
    room.sort((a, b) => (a.cap !== undefined || b.cap !== undefined ? (a.cap ?? Infinity) - (b.cap ?? Infinity) : a.free === b.free ? 0 : b.free > a.free ? 1 : -1)); // stable: ties keep the order
    const order = [...room.map((r) => r.name), ...late];
    const host = order[0];
    if (host === undefined)
        return { refusal: hosts.map((h, i) => `${h.name}: ${why[i]}`), notes, wait: waitable };
    const first = hosts[0]?.name;
    return { host, reason: room[0]?.cap !== undefined ? "fit" : host === first ? "order" : room.some((r) => r.name === first) ? "spread" : "overflow", room: order, notes };
}
// --git: a repository at this worktree's own commit, made here and sent next to the synced files. A shallow fetch of exactly
// that commit (git sends only what the one commit needs) into an empty temporary repository; HEAD is detached on it (no branch
// name of this machine is carried over, and a branch checked out in another worktree cannot clash); the index is read from
// the commit, so git status in the box lists exactly what differs from it. Made with an empty template (no hooks), no remote,
// no reflog (it would carry this account's name and mail) and no FETCH_HEAD (it names this machine's path). Returns the reason
// it failed. --checksum: HEAD, the index and shallow have the same size and, made within one second, the same time on a new commit. The files in the box are left alone: the sync's own filter keeps /.git, and this replaces the whole folder.
// --history: the same fetch without --depth (every commit reachable from the commit; a shallow source sends what it has) plus exactly
// the tags of the worktree's repository that point into that history (`git tag --merged`; annotated ones as tag objects), named in the
// one fetch with --no-tags. The repository is made new at every call, so it holds only the tags that exist now, at the commits they
// have now: a tag deleted or moved since the last call is gone or moved, because rsync --delete replaces the box's whole .git (loose
// references and packed-refs alike). Cost: a new pack of the whole history per call, and git names a pack by its content, which differs
// between two fetches of the same history, so each call sends the whole pack (measured: 141 commits, 1.2 MB).
function sendGit(toplevel, dest, rev = "HEAD", history = false) {
    const head = spawnSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: toplevel, encoding: "utf8" });
    if (head.status !== 0)
        return "this worktree has no commit yet";
    const sha = head.stdout.trim(), tmp = mkdtempSync(path.join(tmpdir(), "boxd-git-"));
    const git = (...a) => spawnSync("git", ["-C", tmp, "-c", "core.logAllRefUpdates=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...a], { encoding: "utf8" });
    try {
        let fetch = ["fetch", "-q", "--depth=1", "--no-write-fetch-head", toplevel, sha];
        if (history) {
            const t = spawnSync("git", ["tag", "--merged", sha], { cwd: toplevel, encoding: "utf8" });
            if (t.status !== 0)
                return `git tag failed: ${t.stderr.trim().split("\n")[0]}`;
            fetch = ["fetch", "-q", "--no-tags", "--update-shallow", "--no-write-fetch-head", toplevel, sha, ...t.stdout.split("\n").filter(Boolean).map((n) => `refs/tags/${n}:refs/tags/${n}`)];
        }
        for (const a of [["init", "-q", "--template="], fetch, ["update-ref", "--no-deref", "HEAD", sha], ["read-tree", "HEAD"]]) {
            const r = git(...a);
            if (r.status !== 0)
                return `git ${a[0]} failed: ${r.stderr.trim().split("\n")[0]}`;
        }
        // One fixed time for everything under .git (the commit's committer time), so a call that sends the same commit leaves every
        // time in the box as it was: rsync -a keeps an equal file (--checksum) and sets the same time anyway. Build scripts that watch
        // .git/HEAD, the index or a reference (cargo:rerun-if-changed) then do not rerun.
        const when = Number(spawnSync("git", ["show", "-s", "--format=%ct", sha], { cwd: toplevel, encoding: "utf8" }).stdout.trim());
        for (const e of [".", ...readdirSync(path.join(tmp, ".git"), { recursive: true })])
            utimesSync(path.join(tmp, ".git", e), when, when);
        const r = spawnSync("rsync", ["-a", "--checksum", "--delete", `${tmp}/.git/`, dest], { stdio: ["inherit", "inherit", "inherit"] });
        return r.status === 0 ? undefined : `rsync exit ${r.status ?? "none"}`;
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
// --commit: the commit's files exactly as a fresh clone checks them out, in a new temporary folder (returned; the caller removes it).
// git checkout-index from a temporary index (the user's own index is never read or written) because it writes what a checkout writes:
// modes, symbolic links, an empty folder for a submodule, and the same line ending and filter rules, with nothing that only a working
// folder has. git archive would honour export-ignore and export-subst, which a clone does not. core.sparseCheckout is off so a sparse
// worktree does not thin the export. Cost: one pass over the commit's files, no history, no network, nothing in the repository.
function exportCommit(toplevel, sha, env) {
    const dir = mkdtempSync(path.join(tmpdir(), "boxd-commit-"));
    const gitEnv = { ...env, GIT_INDEX_FILE: path.join(dir, "index") };
    const src = path.join(dir, "src");
    mkdirSync(src);
    for (const a of [["read-tree", sha], ["checkout-index", "-a", `--prefix=${src}/`]]) {
        const r = spawnSync("git", ["-c", "core.sparseCheckout=false", ...a], { cwd: toplevel, env: gitEnv, encoding: "utf8" });
        if (r.status !== 0) {
            rmSync(dir, { recursive: true, force: true });
            return { error: `git ${a[0]} failed: ${r.stderr.trim().split("\n")[0]}` };
        }
    }
    return { dir };
}
// What to try after a "no room" refusal, from the status lines the probe already returned (no new request): the largest size
// below the one asked that fits on the host with the most room (`vm_fit_mb`; a host without it is not guessed at), and the
// `--wait` line when the call was not made with it. A box keeps its size, so an existing box needs --recreate to take another.
const SIZES = [["xlarge", SIZE_MB.xlarge], ["large", 8192], ["medium", SIZE_MB.medium], ["small", SIZE_MB.small]];
export function roomHint(hosts, req, waiting) {
    let best;
    for (const h of hosts) {
        const s = h.state === "awake" && h.status !== undefined ? parseStatus(h.status) : undefined;
        if (s && (s.engines ?? "").split(",").includes("vm") && /^\d+$/.test(s.vm_fit_mb ?? "") && (!best || Number(s.vm_fit_mb) > best.fit))
            best = { name: h.name, fit: Number(s.vm_fit_mb) };
    }
    const asked = req.size ? SIZE_MB[req.size] : 8192, size = req.vm && best && SIZES.find(([, mb]) => mb < asked && mb <= best.fit);
    return [...(size && best ? [`fits now: --size ${size[0]} on ${best.name} (${best.fit} MB free; a box that exists keeps its size, changing it needs --recreate)`] : []), ...(waiting ? [] : ["or wait for room: add --wait"])];
}
function answers(target, ms) {
    const i = target.lastIndexOf(":");
    return new Promise((resolve) => {
        const s = net.connect({ host: target.slice(0, i), port: Number(target.slice(i + 1)), timeout: ms });
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.once("connect", () => done(true));
        s.once("timeout", () => done(false));
        s.once("error", () => done(false));
    });
}
// ~/.config/boxd/wake.json: the target of a host that sleeps; absent for an always-on host.
function wakeTarget(env, name) {
    try {
        return JSON.parse(readFileSync(path.join(configDir(env), "wake.json"), "utf8"))[`boxd-${name}`]?.target;
    }
    catch {
        return undefined;
    }
}
// One host's state, asked without waking it: a host that sleeps is first tried with a plain connection to its wake
// target (what box-wake does), and only an answer lets the ssh through; no answer means asleep and no ssh is made.
// What each host's last `pod status` said its version is: a call made with --wait keeps its place in line only on a server that knows it.
const hostVersion = new Map(), PLACE_FROM = "0.4.41", IDLE_DROP_FROM = "0.4.50";
const atLeast = (v, min) => { const a = (v ?? "").split(".").map(Number), b = min.split(".").map(Number), i = b.findIndex((x, j) => (a[j] ?? 0) !== x); return i < 0 || (a[i] ?? 0) > b[i]; };
// The place and the busy boxes the server tells a waiting call, at the end of its last line (docs/pod-contract.md, "The waiting line").
const placeOf = (text) => /; (first in line|\d+ calls? waits? ahead of this one).*$/.exec(text.trimEnd().split("\n").pop() ?? "")?.[0].slice(2);
export async function probe(name, env) {
    const target = wakeTarget(env, name);
    if (target && !(await answers(target, PROBE_SECONDS * 1000)))
        return { name, state: "asleep" };
    const r = await new Promise((resolve) => {
        const c = spawn("ssh", ["-o", `ConnectTimeout=${PROBE_SECONDS}`, "-o", "BatchMode=yes", `boxd-${name}`, "pod status"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        c.stdout.on("data", (d) => { out += d; });
        c.on("error", () => resolve({ code: 255, out }));
        c.on("close", (code) => resolve({ code: code ?? 255, out }));
    });
    if (r.code === 0 && r.out.includes("version=")) {
        hostVersion.set(name, parseStatus(r.out).version ?? "");
        return { name, state: "awake", status: r.out.trim() };
    }
    return { name, state: r.code === 125 ? "awake" : "unreachable" }; // 125: a server too old to know `pod status`
}
// The placement of a worktree: one line with a host name in its own git folder (a linked worktree has its own).
// keepFirst (a choice): the first writer wins, a second call of the same worktree reads what won. Otherwise
// (--host, a retry) the new name replaces the old atomically. shortcut: a git folder that cannot be written leaves the worktree unplaced, not failed.
function place(gitDir, name, keepFirst) {
    const file = path.join(gitDir, "boxd-host"), tmp = `${file}.${process.pid}`;
    try {
        writeFileSync(tmp, `${name}\n`);
        if (keepFirst)
            linkSync(tmp, file);
        else
            renameSync(tmp, file);
    }
    catch {
        return readOr(file) ?? name;
    }
    finally {
        rmSync(tmp, { force: true });
    }
    return name;
}
// ~/.local/state/boxd/choices.log: one tab separated line per placement decision (not per call): time, box, request
// (engine,image), host, reason (order, spread, overflow, retry, moved), and what each probed host said.
function logChoice(env, box, req, host, reason, notes) {
    const dir = path.join(env.HOME ?? "", ".local", "state", "boxd");
    try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(path.join(dir, "choices.log"), `${[new Date().toISOString(), box, `${req.vm ? "vm" : "container"},${req.image ?? "-"}`, host, reason, notes.join(",")].join("\t")}\n`);
    }
    catch { /* evidence only: never a reason to fail a call */ }
}
async function hosts(env) {
    const order = hostOrder(env);
    if (!order.length)
        return usage("box hosts: no build server is set up; run box setup <host>");
    for (const h of await Promise.all(order.map((n) => probe(n, env)))) {
        process.stdout.write(`${[h.name, wakeTarget(env, h.name) ? "sleeps" : "always on", h.state, h.status ?? "-"].join("\t")}\n`);
    }
    return 0;
}
// The managed parts of an ssh config, each between marker lines so a second run replaces instead of adding.
// The wake hook (a Match line) goes to the top: Match blocks must come before the Host blocks they should see first.
export function sshConfig(conf, o) {
    const alias = `boxd-${o.host}`;
    const region = (kind, body) => [`# boxd:${kind}:${alias}:begin`, ...body, `# boxd:${kind}:${alias}:end`];
    const strip = (text, kind) => {
        const begin = `# boxd:${kind}:${alias}:begin`, end = `# boxd:${kind}:${alias}:end`;
        const out = [];
        let skip = false;
        for (const line of text.split("\n")) {
            if (line === begin)
                skip = true;
            else if (line === end)
                skip = false;
            else if (!skip)
                out.push(line);
        }
        return out.join("\n");
    };
    const rest = strip(strip(conf, "wake"), "host").replace(/^\n+/, "").replace(/\n+$/, "");
    const host = region("host", [
        `Host ${alias}`, `  HostName ${o.hostname ?? o.host}`, `  Port ${o.port}`, `  User ${o.user}`,
        ...(o.identity ? [`  IdentityFile ${o.identity}`, "  IdentitiesOnly yes"] : []),
    ]);
    const top = o.wake.length ? region("wake", [`Match originalhost ${alias} exec "node ${o.wakeTool} %n"`]) : [];
    return `${[...(top.length ? [...top, ""] : []), ...(rest ? [rest, ""] : []), ...host].join("\n")}\n`;
}
// ~/.config/boxd/wake.json: per ssh alias, what box-wake needs (addresses are never in the code).
export function wakeFile(old, o) {
    let all = {};
    try {
        all = JSON.parse(old);
    }
    catch { /* no file yet */ }
    const alias = `boxd-${o.host}`;
    if (o.wake.length)
        all[alias] = { target: `${o.hostname ?? o.host}:${o.port}`, macs: o.wake, broadcast: o.broadcast };
    else
        delete all[alias];
    return `${JSON.stringify(all, null, 2)}\n`;
}
export function setup(args, env) {
    const o = { host: "", port: 2222, user: "boxd", wake: [], wakeTool: path.join(import.meta.dirname, "box-wake.mjs") };
    let makeDefault = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--help" || a === "-h") {
            process.stdout.write(`${SETUP_HELP}\n`);
            return 0;
        }
        if (a === "--default") {
            makeDefault = true;
            continue;
        }
        if (!a.startsWith("--")) {
            if (o.host)
                return usage("box setup: one host only", SETUP_HELP);
            o.host = a;
            continue;
        }
        const v = args[++i];
        if (v === undefined)
            return usage(`box setup: ${a} needs a value`, SETUP_HELP);
        if (a === "--hostname")
            o.hostname = v;
        else if (a === "--port")
            o.port = Number(v);
        else if (a === "--user")
            o.user = v;
        else if (a === "--identity")
            o.identity = v;
        else if (a === "--wake")
            o.wake = v.split(",");
        else if (a === "--broadcast")
            o.broadcast = v;
        else
            return usage(`box setup: unknown option ${a}`, SETUP_HELP);
    }
    if (!NAME.test(o.host))
        return usage("box setup: give a host name (letters, digits, - _ .)", SETUP_HELP);
    if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)
        return usage("box setup: bad port", SETUP_HELP);
    if (!NAME.test(o.user))
        return usage("box setup: bad account name", SETUP_HELP);
    if (o.hostname !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(o.hostname))
        return usage("box setup: bad --hostname", SETUP_HELP);
    if (o.identity !== undefined && /\s/.test(o.identity))
        return usage("box setup: the identity file path cannot hold spaces", SETUP_HELP);
    if (o.wake.some((m) => !MAC.test(m)))
        return usage("box setup: --wake wants card addresses (six hex pairs with colons), comma separated", SETUP_HELP);
    if (o.wake.length && !o.broadcast)
        return usage("box setup: --wake needs --broadcast <addr>", SETUP_HELP);
    if (o.broadcast !== undefined && !/^[0-9.]+(:[0-9]+)?$/.test(o.broadcast))
        return usage("box setup: bad broadcast address", SETUP_HELP);
    const home = env.HOME ?? "";
    const sshDir = path.join(home, ".ssh"), conf = path.join(sshDir, "config"), cfg = configDir(env);
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    writeFileSync(conf, sshConfig(readFileSync(conf, { encoding: "utf8", flag: "a+" }), o));
    chmodSync(conf, 0o600);
    mkdirSync(cfg, { recursive: true });
    const wakePath = path.join(cfg, "wake.json");
    writeFileSync(wakePath, wakeFile(readFileSync(wakePath, { encoding: "utf8", flag: "a+" }), o));
    if (makeDefault || !existsSync(path.join(cfg, "host")))
        writeFileSync(path.join(cfg, "host"), `${o.host}\n`);
    const order = hostOrder(env); // a new host goes last; --default puts it first
    writeFileSync(path.join(cfg, "hosts.order"), `${(makeDefault ? [o.host, ...order.filter((n) => n !== o.host)] : order).join("\n")}\n`);
    const skill = env.BOXD_SKILL ?? "/usr/share/boxd/skill/SKILL.md";
    if (existsSync(skill)) {
        const dir = path.join(home, ".claude", "skills", "box");
        mkdirSync(dir, { recursive: true });
        copyFileSync(skill, path.join(dir, "SKILL.md"));
    }
    process.stdout.write(`box: host boxd-${o.host} saved in ${conf}${o.wake.length ? ", wake hook installed" : ""}\n`);
    return 0;
}
// Seconds as 1h02m, 3m05s or 42s.
export function duration(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const two = (n) => String(n).padStart(2, "0");
    return h ? `${h}h${two(m)}m` : m ? `${m}m${two(s)}s` : `${s}s`;
}
// The lines of `pod ps` (pid, elapsed seconds, processor seconds, folder, command; tab separated, oldest first) as
// an aligned table. A line that is not five fields is shown as it came, never dropped.
export function psTable(raw) {
    const rows = raw.split("\n").filter(Boolean).map((l) => {
        const f = l.split("\t");
        return f.length === 5 && /^\d+$/.test(f[1]) && /^\d+$/.test(f[2])
            ? [f[0], duration(Number(f[1])), duration(Number(f[2])), f[3], f[4]] : [l];
    });
    if (!rows.length)
        return "no processes running in the box\n";
    const all = [["PID", "AGE", "CPU", "FOLDER", "COMMAND"], ...rows];
    const w = [0, 1, 2, 3].map((c) => Math.max(...all.map((r) => (r.length === 5 ? r[c].length : 0))));
    return all.map((r) => r.length === 5 ? r.map((v, c) => c < 4 ? v.padEnd(w[c]) : v).join("  ") : r[0]).join("\n") + "\n";
}
// The host and box of a reading call (box ps, box log): --pod or this worktree's box, on the host this worktree was placed on.
// No choosing here (a status query is no reason to place a worktree). A usage message when something is missing.
function readTarget(hostFlag, pod, env) {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { encoding: "utf8" });
    if (git.status !== 0 && !pod)
        return "box: not inside a git worktree (or name the box with --pod)";
    const gitDir = git.status === 0 ? git.stdout.trim().split("\n")[1] ?? "" : "";
    const src = source(hostFlag || undefined, env.BOXD_HOST || undefined, gitDir ? readOr(path.join(gitDir, "boxd-host")) : undefined, registered(env));
    const HOST = hostAlias(src.how === "choose" ? undefined : src.host, env);
    if (!HOST)
        return "box: no build server named; run box setup <host>, or give --host <name>, or set BOXD_HOST";
    const p = plan((git.status === 0 ? git.stdout.trim().split("\n")[0] : "") || "/", pod ? ["--pod", pod] : [], ["true"]);
    return "error" in p ? p.error : { HOST, box: p.box };
}
function ps(args, env) {
    let hostFlag, pod;
    for (let i = 0; i < args.length; i++) {
        const a = args[i], v = args[i + 1];
        if (a === "--help" || a === "-h") {
            process.stdout.write(`${HELP}\n`);
            return 0;
        }
        if ((a === "--host" || a === "--pod") && v !== undefined) {
            if (a === "--host")
                hostFlag = v;
            else
                pod = v;
            i++;
        }
        else
            return usage(`box ps: unknown option ${a}`);
    }
    const t = readTarget(hostFlag, pod, env);
    if (typeof t === "string")
        return usage(t);
    const r = spawnSync("ssh", [t.HOST, `pod ps ${t.box}`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (r.status === 0)
        process.stdout.write(psTable(r.stdout));
    return r.status ?? 1;
}
// box log <run>: `pod log <box> <run> [<offset>]` answers one header line (log, size, from, next, state=running|ended, exit=<code>|-)
// and then whole lines of the log, read from the job folder without starting the box. Printed from offset 0 until the log is
// caught up; with --follow it asks again from the returned offset (every BOXD_LOG_POLL_MS, default 2000) until the run ended,
// then exits with the run's code (1 when the log has no EXIT line). --tail <n> holds the output back until the first catch-up and prints only its last <n> lines. Every number from the host is checked before it is used.
// The last n lines of buf; a last line without a newline counts as a line.
const lastLines = (buf, n) => {
    let p = buf.length - (buf.at(-1) === 10 ? 1 : 0);
    for (let k = 0; k < n; k++) {
        p = p > 0 ? buf.lastIndexOf(10, p - 1) : -1;
        if (p < 0)
            return buf;
    }
    return n === 0 ? Buffer.alloc(0) : buf.subarray(p + 1);
};
// box log <run> --events: `pod events <box> <run>` answers one line (events, then key=value words); each word is printed on its own line.
// Exit 0 when the record covers the whole window of the run (complete=yes), else 3 with the reason on standard error: 3 is none of 125 (the
// server refused), 75 (no room), 2 (usage), 1 (the answer is no record), 129 (ended from outside) or 255 (ssh failed), and the call runs no command that could give it.
function eventsCall(HOST, box, run) {
    const r = spawnSync("ssh", [HOST, `pod events ${box} ${run}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 20 });
    if (r.status !== 0) {
        process.stderr.write(/unknown command/.test(r.stderr) ? "box: this build server is older than the event record: box log --events needs an upgrade\n" : r.stderr);
        return r.status ?? 1;
    }
    const words = r.stdout.trimEnd().split("\t"), kv = Object.fromEntries(words.slice(1).map((w) => w.split("=", 2)));
    if (words[0] !== "events" || !words.slice(1).every((w) => /^[a-z_]+=[A-Za-z0-9_.,-]*$/.test(w)) || !/^(yes|no)$/.test(kv.complete ?? "")) {
        process.stderr.write("box log: the server's answer is not an event record\n");
        return 1;
    }
    process.stdout.write(`${words.slice(1).join("\n")}\n`);
    if (kv.complete === "yes")
        return 0;
    process.stderr.write(`box: the event record of run ${run} does not cover its window (${kv.why})\n`);
    return 3;
}
export async function logCall(args, env) {
    let run, hostFlag, pod, follow = false, state = false, events = false, tail;
    for (let i = 0; i < args.length; i++) {
        const a = args[i], v = args[i + 1];
        if (a === "--help" || a === "-h") {
            process.stdout.write(`${HELP}\n`);
            return 0;
        }
        if (a === "--follow")
            follow = true;
        else if (a === "--state")
            state = true;
        else if (a === "--events")
            events = true;
        else if (a === "--tail") {
            if (!/^\d{1,6}$/.test(v ?? "") || Number(v) > 100000)
                return usage("box log: --tail needs a whole number from 0 to 100000");
            tail = Number(v);
            i++;
        }
        else if ((a === "--host" || a === "--pod") && v !== undefined) {
            if (a === "--host")
                hostFlag = v;
            else
                pod = v;
            i++;
        }
        else if (!a.startsWith("--") && run === undefined)
            run = a;
        else
            return usage(`box log: unknown option ${a}`);
    }
    if (run === undefined || !/^[A-Za-z0-9_.-]{1,64}$/.test(run))
        return usage("box log: give the run id (the one box --detach printed)");
    if (events && (follow || state || tail !== undefined))
        return usage("box log: --events goes with no other option but --pod and --host");
    const t = readTarget(hostFlag, pod, env);
    if (typeof t === "string")
        return usage(t);
    if (events)
        return eventsCall(t.HOST, t.box, run);
    const poll = Number(env.BOXD_LOG_POLL_MS ?? 2000);
    let held = tail === undefined ? undefined : Buffer.alloc(0); // --tail: only the last lines are kept until the log is caught up
    for (let off = 0;;) {
        const r = spawnSync("ssh", [t.HOST, `pod log ${t.box} ${run} ${off}`], { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 24 });
        if (r.status !== 0)
            return r.status ?? 1;
        const nl = r.stdout.indexOf(10), head = (nl < 0 ? "" : r.stdout.subarray(0, nl).toString()).split("\t");
        const kv = Object.fromEntries(head.slice(1).map((w) => w.split("=", 2)));
        if (head[0] !== "log" || ![kv.size, kv.next].every((n) => /^\d{1,18}$/.test(n ?? "")) || !/^(running|ended)$/.test(kv.state ?? "")) {
            process.stderr.write("box log: the server's answer is not a log\n");
            return 1;
        }
        if (state) {
            // ended/seconds: only digits are believed (an older server sends neither); the instant is printed in UTC without milliseconds.
            const ended = kv.state === "ended" && /^\d{1,12}$/.test(kv.ended ?? "") ? `\tended=${new Date(Number(kv.ended) * 1000).toISOString().replace(".000Z", "Z")}` : "", secs = ended && /^\d{1,9}$/.test(kv.seconds ?? "") ? `\tseconds=${kv.seconds}` : "";
            // age/quiet: a running run only, digits only (an older server sends neither).
            const live = kv.state === "running" ? ["age", "quiet"].map((k) => (/^\d{1,9}$/.test(kv[k] ?? "") ? `\t${k}=${kv[k]}` : "")).join("") : "";
            process.stdout.write(`${run}\tstate=${kv.state}\texit=${/^\d{1,3}$/.test(kv.exit ?? "") ? kv.exit : "-"}${ended}${secs}${live}\n`);
            return 0;
        }
        const body = r.stdout.subarray(nl + 1);
        if (held)
            held = lastLines(Buffer.concat([held, body]), tail);
        else
            process.stdout.write(body);
        const next = Number(kv.next);
        if (next < Number(kv.size)) {
            off = next;
            continue;
        } // not caught up: read on at once
        if (held) {
            process.stdout.write(held);
            held = undefined;
        }
        off = next;
        if (!follow)
            return 0;
        if (kv.state === "ended") {
            // The last line, as a foreground call ends with its own: a wrapper that loses the exit code still shows it in its log.
            const last = (code) => { process.stderr.write(`box: run ${run} exit ${code} on ${t.HOST.replace(/^boxd-/, "")}\n`); return code; };
            if (/^\d{1,3}$/.test(kv.exit ?? ""))
                return last(Number(kv.exit));
            // 129 as for a call ended from outside: the command did not end by itself.
            process.stderr.write(`box log: run ${run} ended without an exit code: its box or the build server went down under it\n`);
            return last(129);
        }
        await new Promise((res) => setTimeout(res, poll));
    }
}
// box forward <local-port> <box-port>: listens on the loopback address only; each accepted connection runs one `ssh <host> pod forward <box> <port>`
// whose standard input and output are the connection (the server relays them to the loopback address inside the box; no ssh -L,
// the build sshd forbids it). Nothing is synced, no box is made or registered, no collector pass. Local port 0 picks a free port.
// Ends on SIGINT or SIGTERM: the listener closes, every channel's ssh is ended and waited for. shortcut: a connection is relayed
// by one ssh each (about 0.3 s to open), when a viewer opens many connections at once: one multiplexed channel.
// Built from parts: tests/box-client.test.mts forbids a dotted address written into the program.
const LOOPBACK = ["127", "0", "0", "1"].join(".");
const OLDER = "box: this build server is older than 0.4.0, forward needs an upgrade";
function startForward(HOST, box, boxPort, localPort) {
    const socks = new Set(), kids = new Set();
    const gone = [];
    const server = net.createServer((sock) => {
        socks.add(sock);
        const child = spawn("ssh", [HOST, `pod forward ${box} ${boxPort}`], { stdio: ["pipe", "pipe", "pipe"] });
        kids.add(child);
        let err = "";
        child.stderr?.on("data", (d) => { err += d; });
        for (const s of [sock, child.stdin, child.stdout])
            s?.on("error", () => { });
        sock.pipe(child.stdin);
        child.stdout.pipe(sock);
        sock.on("close", () => { socks.delete(sock); child.kill("SIGTERM"); });
        gone.push(new Promise((done) => child.on("close", () => {
            kids.delete(child);
            sock.destroy();
            done();
            const msg = err.trim();
            if (/unknown command/.test(msg))
                process.stderr.write(`${OLDER}\n`);
            else if (msg)
                process.stderr.write(`${msg}\n`);
        })));
        child.on("error", (e) => { err += `box: cannot run ssh: ${e.message}`; });
    });
    return new Promise((resolve) => {
        server.once("error", (e) => resolve(`box forward: cannot listen on ${LOOPBACK}:${localPort}: ${e.message}`));
        server.listen(localPort, LOOPBACK, () => resolve({
            port: server.address().port,
            stop: async () => { server.close(); for (const s of socks)
                s.destroy(); for (const k of kids)
                k.kill("SIGTERM"); await Promise.all(gone); },
        }));
    });
}
// Parses --host, --pod and (vnc) --port, and the positional words; the host and box come from readTarget like box ps.
async function forwardCall(verb, args, env) {
    let hostFlag, pod, boxPort = 5900;
    const pos = [], starter = process.ppid;
    for (let i = 0; i < args.length; i++) {
        const a = args[i], v = args[i + 1];
        if (a === "--help" || a === "-h") {
            process.stdout.write(`${HELP}\n`);
            return 0;
        }
        if ((a === "--host" || a === "--pod" || (verb === "vnc" && a === "--port")) && v !== undefined) {
            if (a === "--host")
                hostFlag = v;
            else if (a === "--pod")
                pod = v;
            else if (/^\d{1,5}$/.test(v))
                boxPort = Number(v);
            else
                return usage(`box vnc: --port needs a port number, got ${v}`);
            i++;
        }
        else if (!a.startsWith("--") && verb === "forward")
            pos.push(a);
        else
            return usage(`box ${verb}: unknown option ${a}`);
    }
    let localPort = 0;
    if (verb === "forward") {
        if (pos.length !== 2 || !pos.every((p) => /^\d{1,5}$/.test(p)))
            return usage("usage: box forward [--host <name>] [--pod <name>] <local-port> <box-port>");
        localPort = Number(pos[0]);
        boxPort = Number(pos[1]);
        if (localPort > 65535)
            return usage(`box forward: ${pos[0]} is not a port (0 picks a free one)`);
    }
    if (boxPort < 1 || boxPort > 65535)
        return usage(`box ${verb}: ${boxPort} is not a box port (1-65535)`);
    const t = readTarget(hostFlag, pod, env);
    if (typeof t === "string")
        return usage(t);
    const f = await startForward(t.HOST, t.box, boxPort, localPort);
    if (typeof f === "string") {
        process.stderr.write(`${f}\n`);
        return 1;
    }
    process.stdout.write(`forwarding ${LOOPBACK}:${f.port} -> box ${t.box} port ${boxPort} (Ctrl+C stops)\n`);
    if (verb === "vnc") {
        const url = `vnc://${LOOPBACK}:${f.port}`;
        const open = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
        open.on("error", () => process.stdout.write(`xdg-open not found; open a VNC viewer at ${LOOPBACK}:${f.port}\n`));
        open.unref();
    }
    // Like a foreground call, the forwarder lives as long as its starter: nothing of boxd stays running here by itself.
    const orphanMs = env.BOXD_KEEP_ORPHAN === "1" ? 0 : Number(env.BOXD_ORPHAN_CHECK_MS ?? 1000);
    let look;
    const orphaned = await new Promise((res) => {
        for (const s of ["SIGINT", "SIGTERM"])
            process.once(s, () => res(false));
        if (orphanMs > 0)
            look = setInterval(() => { if (process.ppid !== starter)
                res(true); }, orphanMs);
    });
    clearInterval(look);
    await f.stop();
    if (orphaned)
        process.stderr.write(`box ${verb}: the process that started it is gone; forwarding ended\n`);
    return orphaned ? 129 : 0;
}
// ---- the collector (docs/pod-contract.md "The collector"): lives in the client, runs only when a person or an ordinary call
// runs it. State in ~/.local/state/boxd: boxes/<host>.<box> (one small file per box: the worktree it belongs to and, once
// seen missing, when), gc.log, gc.stamp.
const plural = (m) => `${m} minute${m === 1 ? "" : "s"}`;
export const GC_GAP_MS = 15 * 60_000, GC_OLD_SECONDS = 6 * 3600;
const stateDir = (env) => path.join(env.HOME ?? "", ".local", "state", "boxd");
const entryFile = (env, host, box) => path.join(stateDir(env), "boxes", `${host}.${box}`);
// Every call that reaches a host records its box: a fresh name, renamed over the old record (also clears a missing mark: the
// worktree is here). A box shared by several worktrees (--pod) keeps the worktree that made it for as long as that one is here; only
// when it is gone does the next caller's worktree take the record over. shortcut: a state folder that cannot be written means no record,
// never a failed call; a box shared by worktrees is removed when its first worktree is deleted, though others still use it (the next call makes it again).
export function register(env, host, box, worktree) {
    const file = entryFile(env, host, box), tmp = `${file}.${process.pid}`;
    try {
        const old = entries(env).find((e) => e.host === host && e.box === box);
        if (old && old.worktree !== worktree && worktreeHere(old.worktree))
            return;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify({ box, host, worktree })}\n`);
        renameSync(tmp, file);
    }
    catch {
        rmSync(tmp, { force: true });
    }
}
function entries(env) {
    const dir = path.join(stateDir(env), "boxes");
    let names = [];
    try {
        names = readdirSync(dir);
    }
    catch { /* none yet */ }
    const out = [];
    for (const n of names) {
        try {
            const e = JSON.parse(readFileSync(path.join(dir, n), "utf8"));
            if (NAME.test(e.host) && BOX.test(e.box) && typeof e.worktree === "string" && path.isAbsolute(e.worktree) && n === `${e.host}.${e.box}`)
                out.push(e);
        }
        catch { /* not ours or half written: ignored */ }
    }
    return out;
}
// The worktree is still a worktree top folder here. A git that cannot be started counts as present: never remove on doubt.
function worktreeHere(dir) {
    if (!existsSync(dir))
        return false;
    const g = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (g.error)
        return true;
    try {
        return g.status === 0 && realpathSync(g.stdout.trim()) === realpathSync(dir);
    }
    catch {
        return false;
    }
}
// One ssh call to a host the collector already knows is awake, bounded: a host that stops answering is given up on.
function ask(host, words) {
    return new Promise((resolve) => {
        const c = spawn("ssh", ["-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", `boxd-${host}`, words], { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
        let out = "";
        c.stdout.on("data", (d) => { out += d; });
        c.on("error", () => resolve({ code: 255, out }));
        c.on("close", (code) => resolve({ code: code ?? 255, out }));
    });
}
// quiet (the pass after an ordinary call): nothing on stdout, one "[box gc] " line on stderr per removed box.
export async function collect(env, opts) {
    const say = (l) => { if (!opts.quiet)
        process.stdout.write(`${l}\n`); };
    const all = entries(env);
    const hosts = [...new Set([...hostOrder(env), ...all.map((e) => e.host)])];
    if (!hosts.length) {
        say("box gc: no build server is set up");
        return 0;
    }
    const states = await Promise.all(hosts.map((h) => probe(h, env)));
    for (const h of states)
        if (h.state !== "awake")
            say(`box gc: ${h.name} is ${h.state === "asleep" ? "asleep (not woken, not asked)" : "unreachable (skipped)"}`);
    for (const h of states.filter((x) => x.state === "awake")) {
        const listed = await ask(h.name, "pod list");
        if (listed.code !== 0) {
            say(`box gc: ${h.name}: pod list failed (exit ${listed.code}); skipped`);
            continue;
        }
        const present = new Map(listed.out.split("\n").filter(Boolean).map((l) => { const f = l.split("\t"); return [f[0], f[2]]; }));
        const mine = all.filter((e) => e.host === h.name);
        // A record outlives its box: the reaper removes an idle box after 30 minutes and leaves its folder, which is
        // removed here once the worktree is gone (pod drop).
        for (const e of mine) {
            const procs = present.get(e.box) === "running" ? await ask(h.name, `pod ps ${e.box}`) : { code: 0, out: "" };
            const rows = procs.out.split("\n").filter(Boolean).map((l) => l.split("\t"));
            if (worktreeHere(e.worktree)) {
                if (e.missingSince !== undefined && !opts.dry)
                    register(env, e.host, e.box, e.worktree);
                for (const r of rows)
                    if (r.length === 5 && /^\d+$/.test(r[1]) && Number(r[1]) >= GC_OLD_SECONDS)
                        say(`box gc: ${h.name} box ${e.box}: running ${duration(Number(r[1]))} in ${r[3]}: ${r[4]}`);
                continue;
            }
            const live = rows.length > 0;
            if (e.missingSince === undefined || opts.now - e.missingSince < GC_GAP_MS) {
                say(`box gc: ${h.name} box ${e.box}: worktree ${e.worktree} is missing${e.missingSince === undefined ? "; first sighting, nothing stopped (a second pass at least 15 minutes later stops it)" : ` since ${plural(Math.floor(Math.max(0, opts.now - e.missingSince) / 60_000))}; a pass in ${plural(Math.ceil((GC_GAP_MS - (opts.now - e.missingSince)) / 60_000))} or later removes it`}`);
                if (e.missingSince === undefined && !opts.dry) {
                    const file = entryFile(env, e.host, e.box), tmp = `${file}.${process.pid}`;
                    try {
                        writeFileSync(tmp, `${JSON.stringify({ ...e, missingSince: opts.now })}\n`);
                        renameSync(tmp, file);
                    }
                    catch {
                        rmSync(tmp, { force: true });
                    }
                }
                continue;
            }
            if (opts.dry) {
                say(`box gc: would remove ${h.name} box ${e.box} and its files (worktree ${e.worktree} is gone${live ? ", a run is still going" : ""})`);
                continue;
            }
            // pod drop removes the box and its folder; a server older than 0.4.0 does not know it and only stops the box.
            // A server that knows "idle" keeps a box that has a run or a call going (exit 75): the list of runs above is a guess and is not trusted.
            const drop = await ask(h.name, `pod drop ${e.box}${atLeast(h.status === undefined ? undefined : parseStatus(h.status).version, IDLE_DROP_FROM) ? " idle" : ""}`), dropped = drop.code === 0;
            if (drop.code === 75) {
                const kept = `${h.name} box ${e.box}: worktree ${e.worktree} is gone but a run is still going in it; kept until it ends`;
                if (opts.quiet)
                    process.stderr.write(`[box gc] ${kept}\n`);
                else
                    say(`box gc: ${kept}`);
                continue;
            }
            if (!dropped && (await ask(h.name, `pod stop ${e.box}`)).code !== 0) {
                say(`box gc: ${h.name}: removing ${e.box} failed; kept`);
                continue;
            }
            rmSync(entryFile(env, e.host, e.box), { force: true });
            try {
                appendFileSync(path.join(stateDir(env), "gc.log"), `${[new Date(opts.now).toISOString(), e.host, e.box, e.worktree, live ? "run live" : "idle"].join("\t")}\n`);
            }
            catch { /* evidence only */ }
            const line = `${dropped ? `removed ${h.name} box ${e.box} and its files${removedWords(drop.out)}` : `stopped ${h.name} box ${e.box} (this server cannot remove its files yet)`}: worktree ${e.worktree} is gone${live ? " (a run was still going)" : ""}`;
            if (opts.quiet)
                process.stderr.write(`[box gc] ${line}\n`);
            else
                say(`box gc: ${line}`);
        }
        for (const [b] of present)
            if (!mine.some((e) => e.box === b))
                say(`box gc: ${h.name} box ${b}: unknown owner (made before the collector or from another machine), left alone; to stop it: ssh boxd-${h.name} pod stop ${b}`);
    }
    return 0;
}
// The size the server measured before it removed a folder: only the one strict form (`evicted <box> (<reason>), <n> MB freed`) is believed; an older server, a box without a folder or any other text gives "".
const freed = (out) => { const m = /^evicted .*, (\d{1,9}) MB freed$/m.exec(out); return m ? `, ${m[1]} MB freed` : ""; };
// What a machine box really needed (the server's `pod drop` answer carries `, needed <peak> MB of <size> MB (<name>)` before the freed words;
// an older server says nothing, and an older client ignores it, its pattern reads only the ending). The advice (pure): above 80 percent of its
// size the box was close to its limit, and the next size up is named when there is one; otherwise the smallest size that holds the need with a
// quarter to spare is named, and left out when that is the size the box had. `mb` is the box's own size (what its size word means on that host).
export function sizeAdvice(peak, name, mb) {
    const ladder = SIZES.map(([n, m]) => [n, n === name ? mb : m]).reverse(), up = ladder[ladder.findIndex(([n]) => n === name) + 1];
    if (peak * 100 > mb * 80)
        return up && up[1] > mb ? `close to the limit: --size ${up[0]} gives ${up[1]} MB` : "close to the limit";
    const fit = ladder.find(([, m]) => m * 4 >= peak * 5);
    return fit && fit[0] !== name ? `--size ${fit[0]} would have held it` : "";
}
export function removedWords(out) {
    const m = /^evicted .*, needed (\d{1,9}) MB of (\d{1,9}) MB \((small|medium|large|xlarge)\)(, \d{1,9} MB freed)?$/m.exec(out), a = m && sizeAdvice(Number(m[1]), m[3], Number(m[2]));
    return `${freed(out)}${m ? `; it needed ${m[1]} MB of its ${m[2]} MB at most${a ? ` (${a})` : ""}` : ""}`;
}
// box stop --run <id>: `pod end <box> <run>` ends that one detached run; the box and its other runs go on. Resolved as box log does, no probe, no wake.
function endRunCall(HOST, box, run) {
    const host = HOST.replace(/^boxd-/, ""), r = spawnSync("ssh", [HOST, `pod end ${box} ${run}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 20 });
    if (r.status !== 0) {
        if (/unknown command/.test(r.stderr)) {
            process.stderr.write("box stop: this build server is older than run ending: box stop --run needs an upgrade\n");
            return 125;
        }
        process.stderr.write(r.stderr);
        return r.status ?? 1;
    }
    const out = r.stdout.trim();
    if (out === `ended run ${run} in box ${box}`)
        process.stdout.write(`box stop: ended run ${run} in box ${box} on ${host}; the box keeps running\n`);
    else if (out === `run ${run} in box ${box} has already ended`)
        process.stdout.write(`box stop: run ${run} in box ${box} on ${host} has already ended; nothing to do\n`);
    else {
        process.stderr.write("box stop: the server's answer is not an ending\n");
        return 1;
    }
    return 0;
}
// box drop and box stop share this: drop is the collector's removal for this worktree's box, asked for. Never wakes a host, never removes a box with a command in it
// (no force: the collector removes a box under a live run only after the worktree is gone, this is a person's call from inside it).
// pod drop answers 0 for a box the host no longer has (only the folder, or nothing, to remove), so a reaped box is cleaned too.
// box stop (mode "stop") asks pod stop instead: the box goes, its folder and the record here stay, and a host that lists no box has nothing to stop.
async function dropCall(args, env, mode = "drop") {
    const cmd = `box ${mode}`, nothing = mode === "stop" ? "nothing stopped" : "nothing removed";
    let hostFlag, pod, run;
    for (let i = 0; i < args.length; i++) {
        const a = args[i], v = args[i + 1];
        if (a === "--help" || a === "-h") {
            process.stdout.write(`${HELP}\n`);
            return 0;
        }
        if ((a === "--host" || a === "--pod") && v !== undefined) {
            if (a === "--host")
                hostFlag = v;
            else
                pod = v;
            i++;
        }
        else if (a === "--run" && v !== undefined && mode === "stop") {
            run = v;
            i++;
        }
        else if (a === "--run" && mode === "drop")
            return usage("box drop: --run belongs to box stop (box stop --run <id> ends one detached run)");
        else
            return usage(`${cmd}: unknown option ${a}`);
    }
    if (run !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(run))
        return usage("box stop: --run needs the run id (the one box --detach printed)");
    const t = readTarget(hostFlag, pod, env);
    if (typeof t === "string")
        return usage(t);
    if (run !== undefined)
        return endRunCall(t.HOST, t.box, run);
    const host = t.HOST.replace(/^boxd-/, ""), refuse = (m) => { process.stderr.write(`${cmd}: ${m}\n`); return 1; };
    const worktree = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() || "-";
    // --pod can name any box: only one this machine recorded, for this worktree or for one that is gone, is removed (its files go with it).
    const owner = entries(env).find((e) => e.host === host && e.box === t.box);
    if (pod !== undefined && !owner)
        return refuse(`box ${t.box} on ${host} has no record on this machine; ${nothing}`);
    if (pod !== undefined && owner && owner.worktree !== worktree && worktreeHere(owner.worktree))
        return refuse(`box ${t.box} on ${host} belongs to the worktree ${owner.worktree}; run ${cmd} from there; ${nothing}`);
    const state = (await probe(host, env)).state;
    if (state === "asleep")
        return refuse(`${host} is asleep and is not woken; ${mode === "stop" ? nothing : `its box ${t.box} is removed by the collector when it wakes`}`);
    if (state !== "awake")
        return refuse(`${host} is unreachable; ${nothing}`);
    const listed = await ask(host, "pod list");
    if (listed.code !== 0)
        return refuse(`${host}: pod list failed (exit ${listed.code}); ${nothing}`);
    if (mode === "stop" && !listed.out.split("\n").some((l) => l.split("\t")[0] === t.box)) {
        process.stdout.write(`box stop: ${host} has no running box ${t.box}; nothing to do\n`);
        return 0;
    }
    if (listed.out.split("\n").some((l) => l.split("\t")[0] === t.box && l.split("\t")[2] === "running")) {
        // Busy is the server's own notion (a call or a detached run holds the box: `busy=` of its `pod report` line). An image's own
        // daemons (dockerd, containerd in a machine) are processes but not work. A server that does not say keeps the process list.
        const rep = await ask(host, "pod report"), row = rep.code === 0 ? rep.out.split("\n").filter((l) => l.startsWith("box\t")).map(parseStatus).find((k) => k.box === t.box && k.busy !== undefined) : undefined;
        const procs = row ? { code: 0, out: row.busy === "yes" ? "busy" : "" } : await ask(host, `pod ps ${t.box}`);
        if (procs.code !== 0)
            return refuse(`${host}: pod ps failed (exit ${procs.code}); ${nothing}`);
        if (procs.out.trim()) {
            // The server's report names the box's running detached runs: the way out is to end one of them.
            const live = rep.code === 0 ? rep.out.split("\n").filter((l) => l.startsWith("run\t")).map(parseStatus).filter((k) => k.box === t.box && k.state === "running" && /^[A-Za-z0-9_.-]{1,64}$/.test(k.id ?? "")) : [];
            const hint = live.length ? `; end a detached run with: box stop --run ${live[0].id}${live.length > 1 ? ` (and ${live.length - 1} more)` : ""}` : "";
            return refuse(`box ${t.box} on ${host} still has a command running in it; ${nothing}${hint}`);
        }
    }
    const dropped = await ask(host, `pod ${mode} ${t.box}`);
    if (dropped.code !== 0)
        return refuse(`${host}: ${mode === "stop" ? "stopping" : "removing"} ${t.box} failed (exit ${dropped.code}); record kept`);
    if (mode === "stop") {
        process.stdout.write(`box stop: stopped ${host} box ${t.box}; its files are kept\n`);
        return 0;
    }
    rmSync(entryFile(env, host, t.box), { force: true });
    try {
        appendFileSync(path.join(stateDir(env), "gc.log"), `${[new Date().toISOString(), host, t.box, worktree, "asked"].join("\t")}\n`);
    }
    catch { /* evidence only */ }
    process.stdout.write(`box drop: removed ${host} box ${t.box} and its files${removedWords(dropped.out)}\n`);
    return 0;
}
// After an ordinary call: at most once per GC_GAP_MS per machine (the stamp is written first, so two calls do not both run it).
async function collectInPassing(env, now) {
    if (env.BOXD_GC === "0")
        return;
    const stamp = path.join(stateDir(env), "gc.stamp");
    try {
        if (existsSync(stamp) && now - statSync(stamp).mtimeMs < GC_GAP_MS)
            return;
        mkdirSync(path.dirname(stamp), { recursive: true });
        writeFileSync(stamp, `${now}\n`);
        utimesSync(stamp, new Date(now), new Date(now));
        await collect(env, { dry: false, quiet: true, now });
    }
    catch { /* the call's own result stands */ }
}
async function gcCall(args, env) {
    if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    if (args.some((a) => a !== "--dry-run"))
        return usage("box gc: only --dry-run exists");
    return collect(env, { dry: args.length > 0, quiet: false, now: Number(env.BOXD_NOW) || Date.now() });
}
// Age of a run from its id <YYYYmmdd-HHMMSS>-<hex>: newRunId wrote the time of this machine's own clock (local time, not the host's
// and not UTC), and only this machine's boxes are listed, so the id is read back the same way. "-" for an id that is not that shape.
export function runAge(id, now) {
    const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-/.exec(id);
    return m ? duration(Math.max(0, Math.round((now - new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()) / 1000))) : "-";
}
// The last line of a log tail for one table cell: the text after the last carriage return or newline that has any, tabs as spaces,
// control and other non-printable characters removed, 120 characters at most; "-" for an empty log.
export function lastLine(tail) {
    const lines = tail.split(/[\r\n]/).map((l) => l.replace(/\t/g, " ").replace(/[\p{C}�]/gu, "")).filter((l) => l.trim());
    return (lines.at(-1) ?? "-").slice(0, 120);
}
// One pass: the `run` lines of `pod report` of every awake host, for this machine's boxes; a host not read (asleep, unreachable or
// failing) has a note and no rows. Never wakes a host.
async function readRuns(env, all, names) {
    return Promise.all((await Promise.all(names.map((n) => probe(n, env)))).map(async (h) => {
        if (h.state !== "awake")
            return { host: h.name, note: `box runs: ${h.name} is ${h.state === "asleep" ? "asleep (not woken, not asked)" : "unreachable (skipped)"}` };
        const rep = await ask(h.name, "pod report");
        if (rep.code !== 0)
            return { host: h.name, note: `box runs: ${h.name}: pod report failed (exit ${rep.code}); skipped` };
        const runs = [];
        for (const l of rep.out.split("\n")) {
            const k = parseStatus(l), e = all.find((x) => x.host === h.name && x.box === k.box);
            if (l.startsWith("run\t") && e && /^[A-Za-z0-9_.-]{1,64}$/.test(k.id ?? "") && /^\d{1,18}$/.test(k.bytes ?? ""))
                runs.push({ box: e.box, worktree: e.worktree, id: k.id, running: k.state === "running", exit: /^\d+$/.test(k.exit ?? "") ? k.exit : "-", bytes: k.bytes });
        }
        return { host: h.name, runs };
    }));
}
// box runs: one line per detached run still running on an awake host, for the boxes this machine registered. Asks `pod report`
// (its `run` lines) and then the end of each log (`pod log <box> <run> <bytes - 2048>`), probing as `box hosts` does: never wakes a host.
// --follow: takes the runs running now, asks again every BOXD_RUNS_POLL_MS (default 30000) and prints "host box id exit=<code>" as
// each ends; exit 0 when all ended with 0, else 1. A run gone from a report that was read (its box removed) ended with exit=-.
async function runsCall(args, env) {
    if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    let follow = false, tail, hostFlag;
    const pats = []; // shell-style glob over the whole box name, escaped into a regular expression
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--follow" && !follow)
            follow = true;
        else if (args[i] === "--tail") {
            const v = args[++i];
            if (!/^\d{1,6}$/.test(v ?? "") || Number(v) > 100000)
                return usage("box runs: --tail needs a whole number from 0 to 100000");
            tail = Number(v);
        }
        else if (args[i] === "--pod" && args[i + 1] !== undefined)
            pats.push(new RegExp(`^${args[++i].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s"));
        else if (args[i] === "--host" && args[i + 1] !== undefined && hostFlag === undefined)
            hostFlag = args[++i];
        else if (args[i] === "--pod" || args[i] === "--host")
            return usage(`box runs: ${args[i]} needs ${args[i] === "--pod" ? "a pattern" : "a host name"}`);
        else {
            process.stderr.write(`box runs: unknown option ${args[i]}; valid: --follow, --tail <n>, --pod <pattern>, --host <name>\n`);
            return 2;
        }
    }
    if (tail !== undefined && !follow)
        return usage("box runs: --tail goes with --follow");
    const all = entries(env), known = [...new Set([...hostOrder(env), ...all.map((e) => e.host)])];
    if (!known.length)
        return usage("box runs: no build server is set up; run box setup <host>");
    if (hostFlag !== undefined && !known.includes(hostFlag)) {
        process.stderr.write(`box runs: --host ${hostFlag}: no such build server; box hosts lists them\n`);
        return 2;
    }
    const names = hostFlag === undefined ? known : [hostFlag];
    const now = Number(env.BOXD_NOW) || Date.now(), out = [], pending = new Set();
    for (const h of await readRuns(env, all, names)) {
        if (h.note)
            out.push(h.note);
        for (const r of h.runs ?? []) {
            if (!r.running || (pats.length && !pats.some((p) => p.test(r.box))))
                continue;
            if (follow) {
                pending.add([h.host, r.box, r.id].join("\t"));
                continue;
            }
            const tail = await ask(h.host, `pod log ${r.box} ${r.id} ${Math.max(0, Number(r.bytes) - 2048)}`);
            const body = tail.code === 0 ? tail.out.slice(tail.out.indexOf("\n") + 1) : "";
            out.push([h.host, r.box, r.id, runAge(r.id, now), r.worktree, lastLine(body)].join("\t"));
        }
    }
    if (follow && pending.size)
        process.stderr.write(out.map((l) => `${l}\n`).join(""));
    else
        process.stdout.write(`${out.some((l) => l.includes("\t")) ? "" : "no detached run is running\n"}${out.map((l) => `${l}\n`).join("")}`);
    if (!follow || !pending.size)
        return 0;
    let failed = false;
    const orphaned = await followRuns(env, all, names, pending, async (key, code) => {
        if (code !== "0")
            failed = true;
        process.stdout.write(`${key}\texit=${code}\n`);
        const [host, box, id] = key.split("\t");
        if (tail !== undefined)
            await printTail(env, host, box, id, tail, `--- ${host}  ${box}  run ${id} (exit ${code}), last lines of its log:`);
    });
    return orphaned ? 129 : failed ? 1 : 0;
}
// The one waiting loop of box runs --follow and box --shards: asks every BOXD_RUNS_POLL_MS (default 30000) until every key in
// `pending` ("host<tab>box<tab>run") has ended (or its box is gone: exit "-"), calls `ended` once for each as it ends, and answers true
// when the process that started the call is gone (nothing more is waited for).
async function followRuns(env, all, names, pending, ended) {
    const starter = process.ppid, poll = Number(env.BOXD_RUNS_POLL_MS ?? 30_000), silent = new Set();
    while (pending.size) {
        await new Promise((res) => setTimeout(res, poll));
        if (env.BOXD_KEEP_ORPHAN !== "1" && process.ppid !== starter) {
            process.stderr.write("box: the process that started this call is gone; no longer following\n");
            return true;
        }
        for (const h of await readRuns(env, all, names)) {
            if (!h.runs) {
                if (h.note && !silent.has(h.host) && [...pending].some((k) => k.startsWith(`${h.host}\t`))) {
                    silent.add(h.host);
                    process.stderr.write(`box runs: ${h.host} does not answer; still waiting for its runs\n`);
                }
                continue;
            }
            silent.delete(h.host);
            for (const key of [...pending].filter((k) => k.startsWith(`${h.host}\t`))) {
                const r = h.runs.find((x) => key === [h.host, x.box, x.id].join("\t"));
                if (r?.running)
                    continue;
                pending.delete(key);
                await ended(key, r?.exit ?? "-", r);
            }
        }
    }
    return false;
}
// The last `n` lines of an ended run's log (box log --tail, read from the server) under the line `title`; nothing for n = 0.
async function printTail(env, host, box, id, n, title) {
    if (n === 0)
        return;
    process.stdout.write(`${title}\n`);
    await logCall(["--host", host, "--pod", box, id, "--tail", String(n)], env);
}
// How long an ended run took, as the server measured it (`seconds=` in the header of `pod log`, read at the end of the log); "-" when it says none.
async function runSeconds(host, box, id, bytes) {
    const r = bytes === undefined ? undefined : await ask(host, `pod log ${box} ${id} ${bytes}`);
    return /^log\t.*\tseconds=(\d{1,9})(\t|$)/.exec(r?.out.split("\n")[0] ?? "")?.[1] ?? "-";
}
// box --shards <n>: `keep` are the options of the call without --shards, --tail and --pod, `words` the command. Each box is made by an ordinary
// call of this program (sync, then the detached start), one after the other, so the admission of each sees the runs before it.
async function shardsCall(keep, words, base, n, tail, env) {
    const started = [];
    for (let i = 1; i <= n; i++) {
        const box = `${base}-s${i}`, run = newRunId(), inner = { run };
        const code = await main([...keep, "--pod", box, "--", ...words.map((w) => w.replaceAll("{shards}", String(n)).replaceAll("{shard}", String(i)))], env, inner);
        if (code !== 0 || !inner.host) {
            const many = started.length > 1;
            if (started.length)
                process.stderr.write(`box: shard ${i}/${n} did not start (exit ${code}); the ${started.length} run${many ? "s" : ""} already started keep${many ? "" : "s"} running. Follow ${many ? "them" : "it"} with: box runs --follow --pod '${base}-s*'${code === NO_ROOM ? "; add --wait to queue for room instead" : ""}\n`);
            return code || 1;
        }
        started.push({ i, host: inner.host, box, run });
        process.stderr.write(`box: shard ${i}/${n} started on ${inner.host} as box ${box}, run ${run}\n`);
    }
    const all = entries(env), names = [...new Set([...hostOrder(env), ...all.map((e) => e.host)])];
    const key = (s) => [s.host, s.box, s.run].join("\t"), codes = new Map();
    const orphaned = await followRuns(env, all, names, new Set(started.map(key)), async (k, code, row) => {
        const s = started.find((x) => key(x) === k);
        codes.set(k, code);
        process.stdout.write(`shard ${s.i}/${n}  ${s.host}  ${s.box}  run ${s.run}  exit=${code}  ${await runSeconds(s.host, s.box, s.run, row?.bytes)} s\n`);
    });
    if (orphaned)
        return 129;
    for (const s of started) {
        const code = codes.get(key(s)) ?? "-";
        if (code !== "0" || tail !== undefined)
            await printTail(env, s.host, s.box, s.run, tail ?? 20, `--- shard ${s.i} (exit ${code}), last lines of its log:`);
    }
    for (const s of started)
        await dropCall(["--pod", s.box, "--host", s.host], env, "stop");
    return started.every((s) => codes.get(key(s)) === "0") ? 0 : 1;
}
// The words box handles itself, dispatched on args[0] in main: they must come first. Keep this list in step with that dispatch.
const BOX_WORDS = ["setup", "runs", "ps", "hosts", "log", "forward", "vnc", "drop", "stop", "gc", "image"];
// `inner`: set by box --shards for each of its own calls: the call is detached with this run id, is never on a terminal, prints no run lines
// and says the host it ran on.
export function main(args, env = process.env, inner) {
    if (args[0] === "setup")
        return setup(args.slice(1), env);
    if (args[0] === "runs")
        return runsCall(args.slice(1), env);
    if (args[0] === "ps")
        return ps(args.slice(1), env);
    if (args[0] === "hosts")
        return hosts(env);
    if (args[0] === "log")
        return logCall(args.slice(1), env);
    if (args[0] === "forward" || args[0] === "vnc")
        return forwardCall(args[0], args.slice(1), env);
    if (args[0] === "drop" || args[0] === "stop")
        return dropCall(args.slice(1), env, args[0]);
    if (args[0] === "gc")
        return gcCall(args.slice(1), env);
    if (args[0] === "image")
        return args[1] === "push" ? imagePush(args.slice(2), env) : usage("box image: only \"box image push\" exists");
    const flags = [], pulls = [], includes = [];
    let commit, history = false, sync = true, clean = false, detach = inner !== undefined, wait = false, shards, tail, i = 0, hostFlag, psAfter = env.BOXD_PS_AFTER ?? "15";
    for (; i < args.length; i++) {
        const a = args[i];
        if (a === "--") {
            i++;
            break;
        }
        if (a === "--help" || a === "-h") {
            process.stdout.write(`${HELP}\n`);
            return 0;
        }
        if (a === "--version") {
            process.stdout.write(`box ${VERSION}\n`);
            return 0;
        }
        if (!a.startsWith("--"))
            break;
        if (a === "--no-sync")
            sync = false;
        else if (a === "--detach")
            detach = true;
        else if (a === "--wait")
            wait = true;
        else if (a === "--clean")
            clean = true;
        else if (a === "--history")
            history = true;
        else if (a === "--recreate" || a === "--snapshot" || a === "--git" || a === "--vm" || a === "--container" || a === "--user" || a === "--kvm")
            flags.push(a);
        else if (a === "--shards") {
            const v = args[++i];
            if (!/^\d{1,2}$/.test(v ?? "") || Number(v) < 2 || Number(v) > 32)
                return usage("box: --shards needs a whole number from 2 to 32");
            shards = Number(v);
        }
        else if (a === "--tail") {
            const v = args[++i];
            if (!/^\d{1,6}$/.test(v ?? "") || Number(v) > 100000)
                return usage("box: --tail needs a whole number from 0 to 100000");
            tail = Number(v);
        }
        else if (a === "--pod" || a === "--size" || a === "--image" || a === "--image-file" || a === "--pull" || a === "--host" || a === "--ps-after" || a === "--env" || a === "--include" || a === "--commit") {
            const v = args[++i];
            if (v === undefined)
                return usage(`box: ${a} needs a value`);
            if (a === "--env" && env[v] === undefined)
                return usage(`box: --env ${v}: not set in your environment`);
            if (a === "--commit")
                commit = v;
            else if (a === "--pull")
                pulls.push(v);
            else if (a === "--include")
                includes.push(v);
            else if (a === "--host")
                hostFlag = v;
            else if (a === "--ps-after")
                psAfter = v;
            else
                flags.push(a, v);
        }
        else
            return usage(`box: unknown option ${a}`);
    }
    const argv = args.slice(i);
    // An option before one of box's own words would run that word in the box (exit 127, nothing dropped): refuse, unless -- says it is a command.
    if (args[i - 1] !== "--" && BOX_WORDS.includes(argv[0])) {
        const w = argv[0], o = args.slice(0, i).join(" ");
        process.stderr.write(`box: "${w}" is a box word and must come first: box ${w} ${o}; to run a program named ${w} in the box, put -- before it: box ${o} -- ${argv.join(" ")}\n`);
        return 2;
    }
    if (tail !== undefined && shards === undefined)
        return usage("box: --tail goes with --shards (or with box runs --follow and box log)");
    if (shards !== undefined) {
        const bad = [detach && "--detach", pulls.length > 0 && "--pull", !sync && "--no-sync", flags.includes("--snapshot") && "--snapshot"].filter(Boolean);
        if (bad.length)
            return usage(`box: --shards cannot go with ${bad.join(", ")}: it syncs, starts detached runs, follows them and stops the boxes itself`);
        if (argv[0] === "forward" || argv[0] === "vnc")
            return usage(`box: --shards runs a command in several boxes; it is not for ${argv[0]}`);
        if (!argv.some((w) => w.includes("{shard}") || w.includes("{shards}")))
            return usage(`box: --shards ${shards}: a command with neither {shard} nor {shards} would run the same thing ${shards} times; give each box its part, for example: box --shards 5 -- npx vitest --shard={shard}/{shards}`);
    }
    // Without an explicit --, a box option after the command is part of the command; say so once (people wrote `box sh -c '...' --pull x`).
    const late = args[i - 1] === "--" ? undefined : argv.find((w) => ["--pull", "--include", "--env", "--detach", "--host", "--pod", "--no-sync", "--wait"].includes(w));
    // A late --host naming one of box's own servers was never meant for the command (`box ls --host <server>` made a box on another server
    // and moved the worktree there): refuse before anything is made or moved.
    const lateHost = late === undefined ? undefined : argv[argv.indexOf("--host") + 1];
    if (argv.includes("--host") && late !== undefined && hostOrder(env).includes(lateHost)) {
        process.stderr.write(`box: --host ${lateHost} after the command would be handed to "${argv[0]}", not to box, and ${lateHost} is one of your build servers: nothing was run. Write box --host ${lateHost} ${argv.filter((w, k) => w !== "--host" && argv[k - 1] !== "--host").join(" ")} (boxes are listed by box ps, runs by box runs); to hand it to the command, put -- before the command\n`);
        return 2;
    }
    if (late)
        process.stderr.write(`box: ${late} after the command is handed to the command, not to box; put box options before the command (or write -- before the command to silence this)\n`);
    if (!/^\d+(\.\d+)?$/.test(psAfter))
        return usage(`box: --ps-after needs minutes (a number, 0 = off), got ${psAfter}`);
    const git = spawnSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { encoding: "utf8" });
    if (git.status !== 0)
        return usage("box: not inside a git worktree");
    const [toplevel = "", gitDir = ""] = git.stdout.trim().split("\n");
    if (history && commit === undefined && !flags.includes("--git"))
        return usage("box: --history goes with --git or --commit <rev>");
    if (commit !== undefined) {
        const bad = [flags.includes("--git") && "--git", flags.includes("--snapshot") && "--snapshot", !sync && "--no-sync", includes.length > 0 && "--include", clean && "--clean"].filter(Boolean);
        if (bad.length)
            return usage(`box: --commit cannot go with ${bad.join(", ")}: it already sends the commit's own files and repository and makes the box's source folder exactly them`);
        const rv = commit.startsWith("-") ? undefined : spawnSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: toplevel, encoding: "utf8" });
        if (!rv || rv.status !== 0)
            return usage(`box: --commit ${commit}: not a commit in this repository`);
        if (!inner)
            process.stderr.write(`box: source is commit ${rv.stdout.trim()} (${commit}), not the working folder\n`);
        commit = rv.stdout.trim();
        clean = true;
    }
    if (shards !== undefined) {
        const bp = plan(toplevel, flags, argv);
        if ("error" in bp)
            return usage(bp.error);
        if (!BOX.test(`${bp.box}-s${shards}`))
            return usage(`box: --shards: the box name ${bp.box} is too long to add -s${shards}`);
        // The options of this call for each shard's own call: everything but --shards, --tail and --pod (each shard has its own name).
        const keep = [], opts = args.slice(0, args[i - 1] === "--" ? i - 1 : i);
        for (let j = 0; j < opts.length; j++) {
            if (["--shards", "--tail", "--pod"].includes(opts[j]))
                j++;
            else if (opts[j] === "--commit") {
                keep.push("--commit", commit);
                j++;
            }
            else
                keep.push(opts[j]);
        }
        return shardsCall(keep, argv, bp.box, shards, tail, env);
    }
    if (!sync && flags.includes("--git"))
        return usage("box: --git needs the sync; drop --no-sync");
    if (!sync && (clean || includes.length))
        return usage("box: --include and --clean need the sync; drop --no-sync");
    for (let j = 0; j < includes.length; j++) {
        const given = includes[j], rel = path.relative(toplevel, path.resolve(toplevel, given));
        if (path.isAbsolute(given) || rel === "" || rel.split(path.sep)[0] === ".." || rel.split(path.sep)[0] === ".git")
            return usage(`box: --include ${given}: not a path inside this worktree`);
        if (!existsSync(path.join(toplevel, rel)))
            return usage(`box: --include ${given}: no such file or folder in this worktree`);
        includes[j] = rel;
    }
    const NOHOST = "box: no build server named; run box setup <host>, or give --host <name>, or set BOXD_HOST";
    const order = hostOrder(env), placedFile = path.join(gitDir, "boxd-host");
    const placed = readOr(placedFile);
    const src = source(hostFlag || undefined, env.BOXD_HOST || undefined, placed, registered(env));
    // One server (or none registered through box setup): no choosing, no placement file, as before.
    const fixed = src.how !== "choose" ? src.host : order.length < 2 ? hostAlias(undefined, env)?.slice("boxd-".length) : undefined;
    if (src.how !== "choose" || order.length < 2) {
        if (!fixed || !NAME.test(fixed))
            return usage(NOHOST);
    }
    const run = detach ? inner?.run ?? newRunId() : undefined;
    const p = plan(toplevel, run ? [...flags, "--detach", run] : flags, argv);
    if ("error" in p)
        return usage(p.error);
    // A detached call returns before the command ends, so nothing is there to pull yet (finish() never reaches the pulls).
    if (run && pulls.length)
        process.stderr.write("box: --pull is ignored with --detach (the run has not ended when box returns); fetch later with: box --no-sync --pull <path> true\n");
    const stdio = { stdio: "inherit" };
    const tty = !inner && process.stdin.isTTY && process.stdout.isTTY;
    const minutes = Number(psAfter), { box, remote } = p;
    const image = flags[flags.indexOf("--image") + 1];
    const sz = flags[flags.indexOf("--size") + 1];
    const req = { vm: flags.includes("--vm"), ...(flags.includes("--image") && image ? { image } : {}), ...(flags.includes("--size") && (sz === "small" || sz === "medium" || sz === "xlarge") ? { size: sz } : {}) };
    // --env: the value rides in ssh's own environment passing (SendEnv / the host's AcceptEnv BOXD_SECRET_*), never in
    // the command line, a file or a log.
    const names = flags.flatMap((f, j) => f === "--env" ? [flags[j + 1]] : []);
    const sshEnv = { ...env, ...Object.fromEntries(names.map((n) => [`BOXD_SECRET_${n}`, env[n]])) };
    const sendEnv = names.flatMap((n) => ["-o", `SendEnv=BOXD_SECRET_${n}`]);
    // One try on one host: sync, then the call. err is the end of its stderr (not kept on a terminal).
    // shortcut: with a terminal ssh -t merges stderr into stdout, so a refusal for room is not recognised there: no retry, no hint.
    async function attempt(name) {
        const HOST = `boxd-${name}`;
        // Remote paths are relative: the server's dispatcher runs the sync inside its work area (see docs/pod-contract.md).
        // --commit: the source is a temporary export, sent whole (no ignore rules: a clone has every tracked file), compared by content
        // (--checksum: every file of the export has the commit's time, so size and time alone could keep a stale file), removed when the sync ends.
        let exp;
        const drop = () => { if (exp)
            rmSync(exp, { recursive: true, force: true }); };
        const onSignal = (s) => { drop(); process.kill(process.pid, s); };
        if (commit) {
            const e = exportCommit(toplevel, commit, env);
            if ("error" in e) {
                process.stderr.write(`box: --commit: ${e.error}; nothing was started\n`);
                return { code: 1, err: "", stop: true };
            }
            exp = e.dir;
            for (const s of ["SIGINT", "SIGTERM", "SIGHUP"])
                process.once(s, onSignal);
        }
        try {
            if (sync) {
                const rules = exp ? [] : gitExactRules(toplevel, includes);
                const rulesFile = rules.length ? path.join(mkdtempSync(path.join(tmpdir(), "boxd-sync-")), "rules") : "";
                if (rulesFile)
                    writeFileSync(rulesFile, `${rules.join("\n")}\n`);
                // --clean: what the filter leaves out is deleted in the box too, except the history --snapshot keeps there.
                const r = spawnSync("rsync", ["-a", "--delete", ...(clean ? ["--delete-excluded"] : []), ...(exp ? ["--checksum"] : []), "--mkpath", ...(clean ? ["--filter=P /.git"] : []), ...(rulesFile ? [`--filter=. ${rulesFile}`] : []), ...(exp ? BASE_FILTER.filter((x) => !x.includes(".gitignore")) : BASE_FILTER), `${exp ? path.join(exp, "src") : toplevel}/`, `${HOST}:jobs/${box}/src/`], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 28 });
                if (rulesFile)
                    rmSync(path.dirname(rulesFile), { recursive: true, force: true });
                // rsync prints "cannot delete non-empty directory" and exits 0 when a folder deleted here still holds ignored files
                // on the server. That is a successful sync; said in the client's own words, because the raw line was read as a failure.
                const kept = [];
                process.stdout.write((r.stdout ?? "").split("\n").filter((l) => { const m = /^cannot delete non-empty directory: (.*)$/.exec(l); if (m)
                    kept.push(m[1]); return !m; }).join("\n"));
                if (r.status !== 0) {
                    process.stderr.write(`box: sync failed (rsync exit ${r.status ?? "none"}); nothing was started\n`);
                    return { code: r.status ?? 1, err: "", stop: true };
                }
                if (kept.length)
                    process.stderr.write(`box: sync complete; ${kept.length} folder${kept.length > 1 ? "s" : ""} deleted here stay${kept.length > 1 ? "" : "s"} on the server because ${kept.length > 1 ? "they hold" : "it holds"} files git ignores: ${kept.slice(0, 5).join(", ")}${kept.length > 5 ? ", ..." : ""}\n`);
            }
            if (flags.includes("--git") || commit) {
                const bad = sendGit(toplevel, `${HOST}:jobs/${box}/src/.git/`, commit, history);
                if (bad) {
                    process.stderr.write(`box: --git: ${bad}; nothing was started\n`);
                    return { code: 1, err: "", stop: true };
                }
            }
        }
        finally {
            drop();
            for (const s of ["SIGINT", "SIGTERM", "SIGHUP"])
                process.removeListener(s, onSignal);
        }
        register(env, name, box, toplevel);
        const sent = wait && atLeast(hostVersion.get(name), PLACE_FROM) ? remote.replace(" -- ", " --queued -- ") : remote; // --queued goes before the "--" that ends the options, and only to a server that knows it
        if (tty)
            return { code: spawnSync("ssh", ["-t", ...sendEnv, HOST, sent], { ...stdio, env: sshEnv }).status ?? 1, err: "" };
        // A foreground call ends with its starter (BOXD_ORPHAN_CHECK_MS is how often the client looks; a test hook).
        const orphanMs = run || env.BOXD_KEEP_ORPHAN === "1" ? 0 : Number(env.BOXD_ORPHAN_CHECK_MS ?? 1000);
        return watched(HOST, sent, box, run ? 0 : minutes * 60_000, sendEnv, sshEnv, orphanMs);
    }
    // The server writes the refusal as the last line before it exits 75 (an image build or a removal note may come first), so the last non-empty line decides.
    const refused = (r) => r.code === NO_ROOM && (r.err.trimEnd().split("\n").pop() ?? "").startsWith(NO_ROOM_TEXT);
    const quote = (w) => /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
    return (async () => {
        let name = fixed, spare = [], fresh = false, waiting = false, shown = "";
        // --wait: said once with the reasons, again (one line) only when the reasons change; holds nothing on any host. Like a foreground
        // call it also ends with its starter (looked at after each sleep). Returns true when it did.
        const starter = process.ppid, waitMs = Number(env.BOXD_WAIT_MS ?? 30_000);
        const hold = async (lines) => {
            if (final)
                return true;
            const text = lines.join("; ");
            if (!waiting)
                process.stderr.write(`box: waiting for room, asking every ${waitMs / 1000} seconds:\n${lines.map((l) => `  ${l}\n`).join("")}`);
            else if (text !== shown)
                process.stderr.write(`box: the reasons changed: ${text}\n`);
            waiting = true;
            shown = text;
            await new Promise((res) => setTimeout(res, waitMs));
            if (run || env.BOXD_KEEP_ORPHAN === "1" || process.ppid === starter)
                return false;
            process.stderr.write("box: the process that started this call is gone; no longer waiting\n");
            return true;
        };
        // While pod status shows no room (it cannot write), the call asks each such server for its place with pod queue, which keeps its ticket
        // alive; the answer is told with the reasons. Only servers from 0.4.41; one that fails or has room adds no line.
        // A server that answers 125 (the size never fits that host, 0.4.52) ends the wait when every server asked said so: the line is passed on.
        let final = 0;
        // The last line of a foreground call that handed its command to a host: the code box exits with, and the host, for a wrapper that loses the code.
        const last = (code, host) => { if (!run && !inner)
            process.stderr.write(`box: exit ${code} on ${host}\n`); return code; };
        const queueLines = async (seen) => {
            let asked = 0, never = [];
            const lines = wait ? (await Promise.all(seen.map(async (h) => {
                const c = h.state === "awake" && h.status !== undefined && atLeast(parseStatus(h.status).version, PLACE_FROM) ? choose([h], req) : undefined;
                if (!c || !("refusal" in c) || !c.wait)
                    return "";
                const r = await ask(h.name, `pod queue ${box} ${req.vm ? `vm ${req.size ?? "large"}` : "box"}`), told = r.code === 75 ? placeOf(r.out) : undefined;
                asked++;
                if (r.code === 125)
                    never.push(r.out.trim().split("\n").pop() ?? "");
                return told ? `${h.name}: ${told}` : "";
            }))).filter(Boolean) : [];
            if (asked && never.length === asked) {
                final = 125;
                process.stderr.write(never[0] + "\n");
            }
            return lines;
        };
        // A placed worktree whose own host has no room moves by itself (owner decision 2026-11-17), as --host would: the placement is
        // recorded and "moved" logged. Only when another host has room for this call and nothing of this box would be lost or stranded
        // on the old host: a machine or container of it in any state, or a run of it, running or ended (its log and results are there),
        // as the old host's `pod report` lists them. An old host that cannot be asked keeps the worktree. Never with --host or
        // $BOXD_HOST: src.how is then not "placed". The worktree then counts as placed by this call (a refusal there removes the placement).
        const autoMove = async (from) => {
            if (src.how !== "placed")
                return false;
            const [seen, rep] = await Promise.all([Promise.all(order.filter((n) => n !== from).map((n) => probe(n, env))), ask(from, "pod report")]);
            const c = choose(seen, req);
            if (!("host" in c) || rep.code !== 0 || !rep.out.startsWith("host\t"))
                return false;
            if (rep.out.split("\n").some((l) => (l.startsWith("box\t") || l.startsWith("run\t")) && parseStatus(l).box === box))
                return false;
            process.stderr.write(`box: ${from} has no room; this worktree moves to ${c.host} (its caches on ${from} are kept until that host's time limit)\n`);
            place(gitDir, c.host, false);
            logChoice(env, box, req, c.host, "moved", []);
            name = c.host;
            spare = c.room.slice(1);
            fresh = true;
            return true;
        };
        if (src.how === "flag" && order.length > 1 && readOr(placedFile) !== name) {
            place(gitDir, name, false);
            logChoice(env, box, req, name, "moved", []);
        }
        for (;;) {
            if (wait && waiting && name !== undefined) { // a placed worktree stays on its host: ask that one only
                const seen = await probe(name, env), c = choose([seen], req);
                if ("refusal" in c) {
                    if (!c.wait) {
                        process.stderr.write(`box: no build server has room for this call\n${c.refusal.map((l) => `  ${l}\n`).join("")}`);
                        return NO_ROOM;
                    }
                    if (await autoMove(name))
                        continue; // moving is tried first, each round
                    if (await hold([...c.refusal, ...await queueLines([seen])]))
                        return final || 129;
                    continue;
                }
            }
            if (name === undefined) {
                fresh = false;
                if (placed !== undefined)
                    rmSync(placedFile, { force: true }); // it names a host that is no longer registered
                const seen = await Promise.all(order.map((n) => probe(n, env))), c = choose(seen, req);
                if ("refusal" in c) {
                    if (wait && c.wait) {
                        if (await hold([...c.refusal, ...await queueLines(seen)]))
                            return final || 129;
                        continue;
                    }
                    process.stderr.write(`box: no build server has room for this call\n${[...c.refusal, ...(c.wait ? roomHint(seen, req, wait) : [])].map((l) => `  ${l}\n`).join("")}`);
                    return NO_ROOM;
                }
                name = place(gitDir, c.host, true);
                if (name === c.host) {
                    fresh = true;
                    spare = c.room.slice(1);
                    logChoice(env, box, req, name, c.reason, c.notes);
                }
            }
            let r = await attempt(name);
            // Lost race: the host had room when asked and none when the call arrived. Nothing ran, so the next host with room is tried.
            while (refused(r) && spare.length) {
                name = spare.shift();
                place(gitDir, name, false);
                logChoice(env, box, req, name, "retry", []);
                r = await attempt(name);
            }
            if (r.stop)
                return r.code;
            if (refused(r)) {
                if (fresh)
                    rmSync(placedFile, { force: true }); // this call placed the worktree and no box was made
                else if (await autoMove(name))
                    continue;
                if (wait) { // ask again: everybody for a worktree this call placed, only its own host for a placed one
                    const refusedBy = name, seen = await Promise.all((fresh ? order : [name]).map((n) => probe(n, env))), c = choose(seen, req), told = placeOf(r.err);
                    if (fresh) {
                        name = undefined;
                        spare = [];
                    }
                    if (await hold("refusal" in c ? [...c.refusal, ...await queueLines(seen)] : [`${refusedBy}: no room (the server refused the call)${told ? `; ${told}` : ""}`]))
                        return final || 129;
                    continue;
                }
                const others = await Promise.all(order.filter((n) => n !== name).map((n) => probe(n, env)));
                const c = others.length ? choose(others, req) : undefined;
                const move = ["box", "--host", ...(c && "host" in c ? [c.host] : []), ...args.filter((a, j) => a !== "--host" && args[j - 1] !== "--host")].map(quote).join(" ");
                if (c && "host" in c)
                    process.stderr.write(`box: ${name} has no room; hosts that do: ${c.room.join(", ")}. Move this worktree with: ${move}\n`);
                else if (c)
                    process.stderr.write(`box: no other build server has room\n${[...c.refusal, ...(c.wait ? roomHint(others, req, wait) : [])].map((l) => `  ${l}\n`).join("")}`);
                return last(r.code, name);
            }
            if (inner && r.code === 0) {
                inner.host = name;
                return 0;
            }
            const code = finish(r.code, name);
            if (r.code !== 255)
                await collectInPassing(env, Number(env.BOXD_NOW) || Date.now()); // 255: ssh itself failed, the host was not reached
            return last(code, name);
        }
    })();
    function finish(code, host) {
        if (run) {
            // box log reads the log from the server without starting the box (a stopped box stays stopped).
            const same = [...(hostFlag ? ["--host", hostFlag] : []), ...flags.flatMap((f, j) => f === "--pod" ? [f, flags[j + 1]] : [])];
            if (code === 0)
                process.stdout.write(`run ${run}\nread its log: ${["box", "log", run, ...same].join(" ")} (--follow waits for the end and exits with its code)\n`
                    + `files outside /job go when the idle box is removed (after the host's time limit, 30 minutes by default); keep results under /job/src and fetch them later with: ${["box", ...same, "--no-sync", "--pull", "<path>", "true"].join(" ")}\n`);
            return code;
        }
        if (code === 125)
            return code; // the box never ran the command
        for (const given of pulls) {
            // Into the parent folder: rsync copies a folder INTO an existing destination, so `--pull out` gave out/out.
            const rel = given.replace(/\/+$/, "");
            const r = spawnSync("rsync", ["-a", "--mkpath", `boxd-${host}:jobs/${box}/src/${rel}`, `${path.dirname(`${toplevel}/${rel}`)}/`], { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
            // A path that is not in the box is one plain line; any other output of rsync is passed on as it came.
            const missing = r.status !== 0 && /(link_stat|change_dir) ".*" failed: No such file or directory/.test(r.stderr);
            if (missing)
                process.stderr.write(`box: nothing at ${rel} in the box, nothing pulled\n`);
            else
                process.stderr.write(r.stderr);
            if (r.status !== 0) {
                if (!missing)
                    process.stderr.write(`box: pull ${rel} failed\n`);
                return code || (r.status ?? 1);
            }
        }
        return code;
    }
}
// A call whose output is passed through, watched for silence: after `afterMs` with nothing on stdout or
// stderr, the box's processes (pod ps) go to stderr, every line prefixed, and the wait starts again (afterMs 0: never).
// Reports only: the call is never ended or changed. Owner decision 2026-11-13 (default 15 minutes, --ps-after 0 = off).
// Resolves with the exit code and the last 4 KB of stderr (the client tells a refusal for room from its last line).
// Also ends the call when the process that started it is gone (the parent process id changed): a foreground call lives as
// long as its starter, so an agent that was killed leaves no command running in the box. orphanMs is how often that is
// looked at (0: never, for --detach and $BOXD_KEEP_ORPHAN=1). Ending: ssh gets a termination, the server's session rule
// ends the command inside the box, the exit code is 129 and `stop` tells main to go no further (no pulls, no collector).
export function watched(host, remote, box, afterMs, sshArgs = [], sshEnv = process.env, orphanMs = 0) {
    return new Promise((resolve) => {
        const child = spawn("ssh", [...sshArgs, host, remote], { stdio: ["inherit", "pipe", "pipe"], env: sshEnv });
        let timer, silentMs = 0, done = false, err = "", orphaned = false;
        const starter = process.ppid;
        const look = orphanMs > 0 ? setInterval(() => {
            if (process.ppid === starter)
                return;
            orphaned = true;
            clearInterval(look);
            process.stderr.write("box: the process that started this call is gone; ending the call (use --detach for work that must outlive its starter)\n");
            child.kill("SIGTERM");
        }, orphanMs) : undefined;
        const arm = () => { clearTimeout(timer); if (!done && afterMs > 0)
            timer = setTimeout(report, afterMs); };
        const report = () => {
            silentMs += afterMs;
            const ps = spawn("ssh", [host, `pod ps ${box}`], { stdio: ["ignore", "pipe", "ignore"] });
            let out = "";
            ps.stdout.on("data", (d) => { out += d; });
            ps.on("close", () => {
                if (done)
                    return;
                const head = `no output for ${duration(Math.round(silentMs / 1000))}; processes in box ${box}, oldest first:`;
                process.stderr.write([head, ...psTable(out).trimEnd().split("\n")].map((l) => `[box ps] ${l}\n`).join(""));
                timer = setTimeout(report, afterMs);
            });
        };
        const pass = (to) => (d) => { silentMs = 0; arm(); to.write(d); };
        child.stdout.on("data", pass(process.stdout));
        child.stderr.on("data", pass(process.stderr));
        child.stderr.on("data", (d) => { err = (err + d).slice(-4096); });
        child.on("close", (c) => { done = true; clearTimeout(timer); clearInterval(look); resolve(orphaned ? { code: 129, err, stop: true } : { code: c ?? 1, err }); });
        arm();
    });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    // A closed output pipe (`box hosts | head -1`) ends the program quietly, for every subcommand.
    for (const s of [process.stdout, process.stderr])
        s.on("error", (e) => { if (e.code === "EPIPE")
            process.exit(0); throw e; });
    void Promise.resolve(main(process.argv.slice(2))).then((c) => { process.exitCode = c; });
}
