// CLI behaviour of client/box.mjs with fake ssh and rsync first on PATH, each recording its argv.
// Every wait is on process exit, never on a clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, openSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, lstatSync, readlinkSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { TSC, NO_TSC } from "./tsc-rs.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const TOOL = path.join(REPO, "client/box.mjs");
const { plan, gitExactRules, BASE_FILTER, psTable, duration, runAge, lastLine, roomHint } = await import(TOOL);

const root = mkdtempSync(path.join(tmpdir(), "box-client-"));
// The real rsync, found before the fakes go first on PATH: dry runs and the equality test use it.
const REAL_RSYNC = execFileSync("sh", ["-c", "command -v rsync"], { encoding: "utf8" }).trim();
const bin = path.join(root, "bin");
const log = path.join(root, "calls.log");
const home = path.join(root, "home"); // a user with no saved host and no ssh config
mkdirSync(home);
mkdirSync(bin);
// With FAKE_REMOTE set, the fake rsync then runs the real one, the folder FAKE_REMOTE standing in for the server's work area.
const rsyncRemote = `[ -z "\${FAKE_RSYNC_ERR:-}" ] || { echo "$FAKE_RSYNC_ERR" >&2; exit 12; }\n[ -n "$FAKE_REMOTE" ] || exit 0\nfor a; do shift; case $a in boxd-test:*) a="$FAKE_REMOTE/\${a#boxd-test:}";; esac; set -- "$@" "$a"; done\nexec ${REAL_RSYNC} "$@"`;
// With FAKE_PS_COUNT set, the fake ssh plays a silent run: `pod ps` answers one process and counts its calls; the
// run itself blocks on the fifo FAKE_PS_FIFO, which the second `pod ps` call writes (the second call proves the
// first report was written, since the client asks again only after writing); then it prints "done" and exits 3.
// It blocks on that event, never on a clock.
const psFake = `if [ -n "\${FAKE_PS_COUNT:-}" ]; then
  case "$*" in *" pod ps "*)
    printf '7\\t3600\\t0\\t/job/src\\tsleep 99\\n'; echo x >> "$FAKE_PS_COUNT"
    [ "$(wc -l < "$FAKE_PS_COUNT")" -eq 2 ] && echo go > "$FAKE_PS_FIFO"
    exit 0;; esac
  read -r _ < "$FAKE_PS_FIFO"
  echo done; exit 3
fi
`;
// With FAKE_HOSTS set (a folder), the fake ssh plays several build servers, one set of files per ssh alias:
// <alias>.status is what `pod status` prints (absent: the host is unreachable, exit 255), <alias>.run.exit and
// <alias>.run.err are the exit code and the stderr of `pod run`.
// With FAKE_SHARDS set (a folder), box --shards runs against a fake host that works out its answers from the calls so far (the run ids are made by the
// client): `pod report` lists every detached run started on that host, ended with the exit code in <box>.exit (default 0) and the log size of <box>.log,
// or still running while the number of reports is below the number in <box>.until; `pod log` answers the header of an ended run (seconds in <box>.seconds,
// default 7) and, from offset 0, the text of <box>.log; the <n>th `pod run` is refused for room when the file refuse_at says n.
const shardsFake = `if [ -n "\${FAKE_SHARDS:-}" ]; then
  for a; do case $a in boxd-*) h=$a; break;; esac; done
  case "$*" in
    *" pod report") echo x >> "$FAKE_SHARDS/$h.reports"; n=$(wc -l < "$FAKE_SHARDS/$h.reports" | tr -d ' ')
      sed -n "s/^ssh .*$h pod run \\([^ ]*\\) .*--detach \\([^ ]*\\) .*/\\1 \\2/p" "$CALLS" | while read -r b id; do
        u=$(cat "$FAKE_SHARDS/$b.until" 2>/dev/null || echo 0)
        if [ "$n" -lt "$u" ]; then printf 'run\\tbox=%s\\tid=%s\\tstate=running\\texit=-\\tbytes=9\\n' "$b" "$id"
        else printf 'run\\tbox=%s\\tid=%s\\tstate=ended\\texit=%s\\tbytes=%s\\n' "$b" "$id" "$(cat "$FAKE_SHARDS/$b.exit" 2>/dev/null || echo 0)" "$(wc -c < "$FAKE_SHARDS/$b.log" 2>/dev/null || echo 0)"; fi
      done; exit 0;;
    *" pod log "*) w="$*"; off=\${w##* }; r=\${w% *}; r=\${r% *}; b=\${r##* }
      sz=$(wc -c < "$FAKE_SHARDS/$b.log" 2>/dev/null || echo 0)
      printf 'log\\tsize=%s\\tfrom=0\\tnext=%s\\tstate=ended\\texit=%s\\tended=100\\tseconds=%s\\n' "$sz" "$sz" "$(cat "$FAKE_SHARDS/$b.exit" 2>/dev/null || echo 0)" "$(cat "$FAKE_SHARDS/$b.seconds" 2>/dev/null || echo 7)"
      [ "$off" != 0 ] || cat "$FAKE_SHARDS/$b.log" 2>/dev/null; exit 0;;
    *" pod run "*) echo x >> "$FAKE_SHARDS/$h.runs"
      if [ "$(wc -l < "$FAKE_SHARDS/$h.runs" | tr -d ' ')" = "$(cat "$FAKE_SHARDS/refuse_at" 2>/dev/null)" ]; then
        echo "boxd-pod: no room for another busy box (6000 MB in use); wait for one to end" >&2; exit 75
      fi;;
  esac
fi
`;
const hostFake = `if [ -n "\${FAKE_LOGDIR:-}" ]; then
  case "$*" in *" pod log "*|*" pod events "*|*" pod end "*) echo x >> "$FAKE_LOGDIR/count"; cat "$FAKE_LOGDIR/$(wc -l < "$FAKE_LOGDIR/count" | tr -d ' ')"; [ ! -f "$FAKE_LOGDIR/err" ] || cat "$FAKE_LOGDIR/err" >&2; exit "$(cat "$FAKE_LOGDIR/exit" 2>/dev/null || echo 0)";; esac
fi
${shardsFake}if [ -n "\${FAKE_BLOCK_DIR:-}" ]; then
  case "$*" in *" pod run "*)
    (read -r _ < "$FAKE_BLOCK_DIR/hold") & held=$!
    trap 'kill $held 2>/dev/null; echo term > "$FAKE_BLOCK_DIR/term"; exit 143' TERM
    echo up > "$FAKE_BLOCK_DIR/started"
    wait $held;; esac
fi
if [ -n "\${FAKE_HOSTS:-}" ]; then
  for a; do case $a in boxd-*) h=$a; break;; esac; done
  case "$*" in
    *" pod status") [ -f "$FAKE_HOSTS/$h.status" ] || exit 255
      [ -z "\${FAKE_STATUS_HOLD:-}" ] || read -r _ < "$FAKE_STATUS_HOLD"
      echo x >> "$FAKE_HOSTS/$h.probes"; n=$(wc -l < "$FAKE_HOSTS/$h.probes" | tr -d ' ')
      if [ -f "$FAKE_HOSTS/$h.status.$n" ]; then cat "$FAKE_HOSTS/$h.status.$n"; else cat "$FAKE_HOSTS/$h.status"; fi; exit 0;;
    *" pod report") echo x >> "$FAKE_HOSTS/$h.reports"; n=$(wc -l < "$FAKE_HOSTS/$h.reports" | tr -d ' ')
      [ ! -f "$FAKE_HOSTS/$h.report.fail.$n" ] || exit 1
      if [ -f "$FAKE_HOSTS/$h.report.$n" ]; then cat "$FAKE_HOSTS/$h.report.$n"; else cat "$FAKE_HOSTS/$h.report" 2>/dev/null; fi; exit 0;;
    *" pod log "*) r=\${*% *}; cat "$FAKE_HOSTS/$h.log.\${r##* }" 2>/dev/null; exit 0;;
    *" pod queue "*) echo x >> "$FAKE_HOSTS/$h.queues"; n=$(wc -l < "$FAKE_HOSTS/$h.queues" | tr -d ' ')   # the place: <alias>.queue.<n> or <alias>.queue (said, exit 75), else room
      [ ! -f "$FAKE_HOSTS/$h.queue.final" ] || { cat "$FAKE_HOSTS/$h.queue.final"; exit 125; }   # the size never fits: final refusal
      for q in "$FAKE_HOSTS/$h.queue.$n" "$FAKE_HOSTS/$h.queue"; do [ ! -f "$q" ] || { cat "$q"; exit 75; }; done; exit 0;;
    *" pod list") cat "$FAKE_HOSTS/$h.list" 2>/dev/null; exit 0;;
    *" pod ps "*) cat "$FAKE_HOSTS/$h.ps.\${*##* }" 2>/dev/null; exit 0;;
    *" pod stop "*) exit "$(cat "$FAKE_HOSTS/$h.stop.exit" 2>/dev/null || echo 0)";;
    *" pod drop "*) cat "$FAKE_HOSTS/$h.drop.out" 2>/dev/null; exit "$(cat "$FAKE_HOSTS/$h.drop.exit" 2>/dev/null || echo 0)";;
    *" pod run "*) if [ -f "$FAKE_HOSTS/$h.run.refuse" ] && [ "$(cat "$FAKE_HOSTS/$h.run.refuse")" -gt 0 ]; then
        echo $(( $(cat "$FAKE_HOSTS/$h.run.refuse") - 1 )) > "$FAKE_HOSTS/$h.run.refuse"
        [ ! -f "$FAKE_HOSTS/$h.run.pre" ] || cat "$FAKE_HOSTS/$h.run.pre" >&2
        if [ -f "$FAKE_HOSTS/$h.refuse.line" ]; then cat "$FAKE_HOSTS/$h.refuse.line" >&2; exit 75; fi
        echo "boxd-pod: no room for another virtual machine (3 of 3 running); wait for one to end or stop one" >&2; exit 75
      fi
      [ ! -f "$FAKE_HOSTS/$h.run.err" ] || cat "$FAKE_HOSTS/$h.run.err" >&2
      [ ! -f "$FAKE_HOSTS/$h.run.exit" ] || exit "$(cat "$FAKE_HOSTS/$h.run.exit")";;
  esac
fi
`;
// box image push: the fake ssh answers `pod image has` with FAKE_HAS_EXIT (default 1: not there) and keeps what `pod image load`
// reads on standard input in FAKE_LOAD_IN; a fake podman or docker (own folder, so a test can leave both out) logs its calls.
// With FAKE_FWD_DIR set, `pod forward` is a relay: the fake ssh records its process id and echoes its input (cat), or with
// FAKE_FWD_ERR prints that to stderr and exits 125 like a refusing server.
const fwdFake = `if [ -n "\${FAKE_FWD_DIR:-}" ]; then
  case "$*" in *" pod forward "*)
    [ -z "\${FAKE_FWD_ERR:-}" ] || { echo "$FAKE_FWD_ERR" >&2; exit 125; }
    echo $$ > "$FAKE_FWD_DIR/pid.$$"; exec cat;; esac
fi
`;
const imgFake = `case "$*" in *"pod image has "*) exit "\${FAKE_HAS_EXIT:-1}";; *"pod image load "*) cat > "$FAKE_LOAD_IN"; exit "\${FAKE_LOAD_EXIT:-0}";; esac\n`;
function fakeEngine(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `#!/bin/sh
[ "$1" = --version ] && exit 0
echo "${name} $*" >> "$CALLS"
case $1 in
  pull) exit "\${FAKE_PULL_EXIT:-0}";;
  image) echo "\${FAKE_IMAGE_ID:-sha256:0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef}";;
  save) printf 'ARCHIVE-OF-%s' "$2"; exit "\${FAKE_SAVE_EXIT:-0}";;
esac
`);
  chmodSync(path.join(dir, name), 0o755);
}
const withPodman = path.join(root, "with-podman"), withDocker = path.join(root, "with-docker"), withNone = path.join(root, "with-none");
fakeEngine(withPodman, "podman"); fakeEngine(withDocker, "docker"); mkdirSync(withNone);
// The fakes need a few basic tools but must not find a real podman or docker: PATH is these links, never the machine's own.
const basics = path.join(root, "basics");
mkdirSync(basics);
for (const t of ["cat", "sed", "env", "printf", "echo", "wc", "sh"]) symlinkSync(execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim(), path.join(basics, t));
for (const name of ["ssh", "rsync"]) {
  // one line per call: the tool name, then its arguments joined by single spaces; ssh exits with FAKE_SSH_EXIT
  // rsync dry runs (-n: the client asks what its filter would send) go to the real rsync and are not recorded.
  const dry = name === "rsync" ? `case " $* " in *" -n "*) exec ${REAL_RSYNC} "$@";; esac\n` : "";
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${dry}echo "${name} $*" >> "$CALLS"\n${name === "ssh" ? 'for v in $(env | sed -n "s/^\\(BOXD_SECRET_[A-Z0-9_]*\\)=.*/\\1/p"); do echo "ssh-env $v" >> "$CALLS"; done\n' + imgFake + fwdFake + hostFake + psFake + '[ -z "${FAKE_SSH_OUT:-}" ] || printf "%s\\n" "$FAKE_SSH_OUT"\nexit "${FAKE_SSH_EXIT:-0}"' : rsyncRemote}\n`);
  chmodSync(path.join(bin, name), 0o755);
}
const repo = path.join(root, "My Repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
const box = plan(top, [], ["x"]).box;

function runBox(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  rmSync(log, { force: true });
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: opts.cwd ?? repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, BOXD_HOST: "test", BOXD_GC: "0", CALLS: log, ...opts.env },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}
const b64 = (...w: string[]) => Buffer.from(w.join("\0")).toString("base64");

test("syncs with the contract recipe, then runs; no -t without terminals", () => {
  const r = runBox(["cargo", "test"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, [
    `rsync -a --delete --mkpath --safe-links --exclude=/.git --filter=:- .gitignore ${top}/ boxd-test:jobs/${box}/src/`,
    `ssh boxd-test pod run ${box} -- ${b64("cargo", "test")}`,
  ]);
});

test("the sync carries exactly git's files: force-added, negated, info/exclude and ignored outputs", () => {
  const r2 = path.join(root, "acme");
  for (const d of ["build/deep", "t", "keep", "out"]) mkdirSync(path.join(r2, d), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: r2 });
  writeFileSync(path.join(r2, ".gitignore"), "*.log\n!keep/*.log\nbuild/\nout/\n");
  writeFileSync(path.join(r2, ".git/info/exclude"), "secret.txt\n");
  for (const f of ["x.log", "t/a[1]*.log", "build/deep/k.txt", "build/other.txt", "keep/run-98.journal.log", "keep/expected.json", "other.log", "secret.txt", "out/o", "a.txt"])
    writeFileSync(path.join(r2, f), f);
  execFileSync("git", ["add", "-f", "x.log", "t/a[1]*.log", "build/deep/k.txt"], { cwd: r2 });
  execFileSync("git", ["add", "keep/run-98.journal.log"], { cwd: r2 });
  const top2 = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: r2, encoding: "utf8" }).trim();
  const gitFiles = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: top2, encoding: "utf8" }).trim().split("\n").sort();
  // The client calls the fake rsync (dry runs reach the real one); with rules it passes them as a merge file.
  const r = runBox(["true"], { cwd: r2 });
  assert.match(r.calls[0] ?? "", /^rsync -a --delete --mkpath --filter=\. \S+\/rules --safe-links --exclude=\/\.git --filter=:- \.gitignore /);
  // Run the client's real rules through the real rsync into a scratch folder, as the sync would.
  const dest = path.join(root, "dest"), rules = path.join(root, "rules");
  writeFileSync(rules, `${gitExactRules(top2).join("\n")}\n`);
  execFileSync(REAL_RSYNC, ["-a", "--delete", "--mkpath", `--filter=. ${rules}`, ...BASE_FILTER, `${top2}/`, `${dest}/`]);
  const got = execFileSync("find", [".", "-type", "f"], { cwd: dest, encoding: "utf8" }).trim().split("\n").map((p) => p.slice(2)).sort();
  assert.deepEqual(got, gitFiles);
  // A file deleted locally disappears on the next sync; an ignored output there survives.
  rmSync(path.join(r2, "a.txt")); mkdirSync(path.join(dest, "out")); writeFileSync(path.join(dest, "out", "o"), "remote build output");
  writeFileSync(rules, `${gitExactRules(top2).join("\n")}\n`);
  execFileSync(REAL_RSYNC, ["-a", "--delete", "--mkpath", `--filter=. ${rules}`, ...BASE_FILTER, `${top2}/`, `${dest}/`]);
  assert.equal(existsSync(path.join(dest, "a.txt")), false);
  assert.equal(readFileSync(path.join(dest, "out", "o"), "utf8"), "remote build output");
});

test("the client's real remote rsync command lines pass the server's allowlist", () => {
  // Real rsync, with its remote shell replaced by a script that prints the words rsync asks the server to run and fails.
  const cap = path.join(root, "cap"), words = path.join(cap, "words");
  mkdirSync(cap);
  writeFileSync(path.join(cap, "rsh"), `#!/bin/sh\nshift\necho "$*" >> ${words}\nexit 1\n`);
  chmodSync(path.join(cap, "rsh"), 0o755);
  writeFileSync(path.join(cap, "ssh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(cap, "ssh"), 0o755);
  const run = (args: string[]) => spawnSync(process.execPath, [TOOL, ...args], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${cap}:${path.dirname(REAL_RSYNC)}:${process.env.PATH ?? ""}`, HOME: home, BOXD_HOST: "test", RSYNC_RSH: path.join(cap, "rsh") },
  });
  run(["true"]); // the sync
  run(["--no-sync", "--pull", "target/out", "true"]); // a pull
  const lines = readFileSync(words, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0] ?? "", new RegExp(`^rsync --server -\\S+ --delete --safe-links --mkpath \\. jobs/${box}/src/$`));
  assert.match(lines[1] ?? "", new RegExp(`^rsync --server --sender -\\S+ \\. jobs/${box}/src/target/out$`));
  // The server side, with its own rsync replaced by a recorder: every captured line reaches rsync unchanged, inside the work area.
  const work = path.join(root, "srvwork"), rec = path.join(root, "rsync-recorded");
  mkdirSync(path.join(cap, "srv"));
  writeFileSync(path.join(cap, "srv", "rsync"), `#!/bin/sh\necho "$*" > ${rec}\npwd >> ${rec}\n`);
  chmodSync(path.join(cap, "srv", "rsync"), 0o755);
  mkdirSync(work);
  for (const line of lines) {
    const r = spawnSync("bash", [path.join(REPO, "server/boxd-pod")], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${cap}/srv:${process.env.PATH ?? ""}`, HOME: home, BOXD_CONF: "/nonexistent", BOXD_WORK: work, SSH_ORIGINAL_COMMAND: line },
    });
    assert.equal(r.status, 0, `${line}: ${r.stderr}`);
    assert.equal(readFileSync(rec, "utf8"), `${line.slice("rsync ".length)}\n${work}\n`);
  }
});

test("--no-sync skips rsync; options reach the remote line; -- ends options", () => {
  const r = runBox(["--no-sync", "--image", "rust:1.83", "--recreate", "--snapshot", "--", "--version"]);
  assert.deepEqual(r.calls, [`ssh boxd-test pod run ${box} --image rust:1.83 --recreate --snapshot -- ${b64("--version")}`]);
});

test("exit code passes through, including 125", () => {
  for (const n of ["3", "101", "125"]) assert.equal(runBox(["--no-sync", "true"], { env: { FAKE_SSH_EXIT: n } }).code, Number(n));
});

test("--pull copies each path back after a foreground run, also after a failed command", () => {
  const r = runBox(["--no-sync", "--pull", "target/out", "--pull", "a.txt", "make"], { env: { FAKE_SSH_EXIT: "2" } });
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls.slice(1), [
    `rsync -a --mkpath boxd-test:jobs/${box}/src/target/out ${top}/target/`,
    `rsync -a --mkpath boxd-test:jobs/${box}/src/a.txt ${top}/`,
  ]);
});

test("--pull of a folder, twice and with a trailing slash, gives the folder itself, never a copy inside it", () => {
  const remote = path.join(root, "remote");
  const src = path.join(remote, "jobs", box, "src");
  mkdirSync(path.join(src, "out/sub"), { recursive: true });
  writeFileSync(path.join(src, "out/sub/f"), "built");
  writeFileSync(path.join(src, "one.txt"), "file");
  for (const p of ["out", "out/", "one.txt"]) {
    assert.equal(runBox(["--no-sync", "--pull", p, "true"], { env: { FAKE_REMOTE: remote } }).code, 0);
  }
  assert.equal(readFileSync(path.join(top, "out/sub/f"), "utf8"), "built");
  assert.equal(existsSync(path.join(top, "out/out")), false);
  assert.equal(readFileSync(path.join(top, "one.txt"), "utf8"), "file");
  rmSync(path.join(top, "out"), { recursive: true }); rmSync(path.join(top, "one.txt"));
});

test("--pull is skipped when the box refused (125)", () => {
  assert.equal(runBox(["--no-sync", "--pull", "x", "true"], { env: { FAKE_SSH_EXIT: "125" } }).calls.length, 1);
});

test("--detach sends a run id, prints it and the log command", () => {
  const r = runBox(["--no-sync", "--detach", "sleep", "9"]);
  const id = /^ssh boxd-test pod run \S+ --detach (\d{8}-\d{6}-[0-9a-f]{4}) -- /.exec(r.calls[0] ?? "")?.[1];
  assert.ok(id, r.calls[0]);
  assert.match(r.out, new RegExp(`^run ${id}\\nread its log: box log ${id} \\(--follow waits for the end and exits with its code\\)\\n`));
  assert.match(r.out, /\nfiles outside \/job go when the idle box is removed \(after the host's time limit, 30 minutes by default\); keep results under \/job\/src and fetch them later with: box --no-sync --pull <path> true\n$/);
});

test("--detach: the fetch command it prints works (same host and box, --no-sync, a pull after a `true`), and --pull with --detach is said to do nothing", () => {
  const r = runBox(["--no-sync", "--host", "test", "--pod", "shared", "--detach", "--pull", "out", "sleep", "9"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /^box: --pull is ignored with --detach .*fetch later with: box --no-sync --pull <path> true\n$/);
  assert.equal(r.calls.length, 1, "no pull was tried");
  const fetch = /fetch them later with: (box .*)\n$/.exec(r.out)?.[1]?.replace("<path>", "dist/x").split(" ").slice(1);
  assert.deepEqual(fetch, ["--host", "test", "--pod", "shared", "--no-sync", "--pull", "dist/x", "true"]);
  const again = runBox(fetch ?? []);
  assert.deepEqual(again.calls, [`ssh boxd-test pod run shared -- ${b64("true")}`, `rsync -a --mkpath boxd-test:jobs/shared/src/dist/x ${top}/dist/`]);
  assert.equal(runBox(["--no-sync", "--detach", "sleep", "9"]).err, "", "nothing to warn about without --pull");
});

test("--vm reaches the remote line after --image", () => {
  const r = runBox(["--no-sync", "--vm", "--image", "localhost/toolbox", "true"]);
  assert.deepEqual(r.calls, [`ssh boxd-test pod run ${box} --image localhost/toolbox --vm -- ${b64("true")}`]);
});

test("--user reaches the remote line after --vm and --container, and is in the help", () => {
  const r = runBox(["--no-sync", "--recreate", "--user", "--container", "true"]);
  assert.deepEqual(r.calls, [`ssh boxd-test pod run ${box} --container --user --recreate -- ${b64("true")}`]);
  assert.match(runBox(["--help"]).out, /--user /);
});

test("--detach prints a box log command that repeats --pod, and none of the options that make or change a box", () => {
  const r = runBox(["--no-sync", "--pod", "shared", "--image", "localhost/toolbox", "--vm", "--detach", "true"]);
  assert.match(r.out, /read its log: box log \S+ --pod shared \(--follow/);
  assert.doesNotMatch(r.out, /--image|--vm|cat /);
  assert.doesNotMatch(r.out, /--detach|--recreate|--snapshot/);
});

test("not in a git repository: exit 2, nothing run", () => {
  const r = runBox(["true"], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.err, /not inside a git worktree/);
  assert.deepEqual(r.calls, []);
});

test("--image-file goes right after where --image goes and before --vm", () => {
  const r = runBox(["--no-sync", "--vm", "--recreate", "--image-file", "ci/Containerfile", "true"]);
  assert.deepEqual(r.calls, [`ssh boxd-test pod run ${box} --image-file ci/Containerfile --vm --recreate -- ${b64("true")}`]);
});

test("--image-file: with --image, without a value, or with a path outside the worktree is a usage error, nothing sent", () => {
  for (const args of [
    ["--image", "rust:1.83", "--image-file", "Containerfile", "true"], ["--image-file", "Containerfile", "--image", "rust:1.83", "true"],
    ["--image-file"], ["--image-file", "/etc/passwd", "true"], ["--image-file", "../x", "true"], ["--image-file", "a/../x", "true"],
    ["--image-file", "a//b", "true"], ["--image-file", "a b", "true"], ["--image-file", ".", "true"],
  ]) {
    const r = runBox(["--no-sync", ...args]);
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(r.calls, [], args.join(" "));
  }
});

test("usage errors exit 2; --help exits 0", () => {
  assert.equal(runBox([]).code, 2);
  assert.equal(runBox(["--bogus", "x"]).code, 2);
  assert.equal(runBox(["--pod", "Bad Name", "true"]).code, 2);
  assert.equal(runBox(["--image"]).code, 2);
  const h = runBox(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /--detach/);
  assert.deepEqual(h.calls, []);
});

test("the host comes from --host, then BOXD_HOST, then the host box setup saved; none is an error", () => {
  assert.deepEqual(runBox(["--no-sync", "--host", "other", "true"]).calls, [`ssh boxd-other pod run ${box} -- ${b64("true")}`]);
  mkdirSync(path.join(home, ".config/boxd"), { recursive: true });
  writeFileSync(path.join(home, ".config/boxd/host"), "saved\n");
  assert.deepEqual(runBox(["--no-sync", "true"], { env: { BOXD_HOST: "" } }).calls, [`ssh boxd-saved pod run ${box} -- ${b64("true")}`]);
  rmSync(path.join(home, ".config/boxd/host"));
  const r = runBox(["--no-sync", "true"], { env: { BOXD_HOST: "" } });
  assert.equal(r.code, 2);
  assert.match(r.err, /no build server named/);
  assert.deepEqual(r.calls, []);
  assert.equal(runBox(["--no-sync", "--host", "bad name", "true"]).code, 2);
});

test("--detach repeats --host in the log command", () => {
  const r = runBox(["--no-sync", "--host", "other", "--detach", "true"]);
  assert.match(r.out, /read its log: box log \S+ --host other /);
});

test("setup writes the ssh entry, the default host, the skill; a second run changes nothing", () => {
  const h = mkdtempSync(path.join(root, "setup-"));
  const skill = path.join(root, "SKILL.md");
  writeFileSync(skill, "---\nname: box\n---\n");
  const run = (...a: string[]) => spawnSync(process.execPath, [TOOL, "setup", ...a], { encoding: "utf8", env: { HOME: h, BOXD_SKILL: skill } });
  mkdirSync(path.join(h, ".ssh"));
  writeFileSync(path.join(h, ".ssh/config"), "Host other\n  HostName elsewhere\n");
  const r = run("srv", "--hostname", "srv.example", "--identity", "/k/id");
  assert.equal(r.status, 0, r.stderr);
  const conf = readFileSync(path.join(h, ".ssh/config"), "utf8");
  assert.equal(conf, [
    "Host other", "  HostName elsewhere", "",
    "# boxd:host:boxd-srv:begin", "Host boxd-srv", "  HostName srv.example", "  Port 2222", "  User boxd", "  IdentityFile /k/id", "  IdentitiesOnly yes", "# boxd:host:boxd-srv:end", "",
  ].join("\n"));
  assert.equal(readFileSync(path.join(h, ".config/boxd/host"), "utf8"), "srv\n");
  assert.equal(readFileSync(path.join(h, ".config/boxd/hosts.order"), "utf8"), "srv\n");
  assert.equal(readFileSync(path.join(h, ".claude/skills/box/SKILL.md"), "utf8"), "---\nname: box\n---\n");
  assert.equal(readFileSync(path.join(h, ".config/boxd/wake.json"), "utf8"), "{}\n");
  assert.equal(run("srv", "--hostname", "srv.example", "--identity", "/k/id").status, 0);
  assert.equal(readFileSync(path.join(h, ".ssh/config"), "utf8"), conf, "a second run must not add a second block");
  assert.equal(statSync(path.join(h, ".ssh/config")).mode & 0o777, 0o600);
  // a second host keeps the first as the default, --default switches
  run("lap", "--port", "22", "--user", "build");
  assert.equal(readFileSync(path.join(h, ".config/boxd/host"), "utf8"), "srv\n");
  assert.equal(readFileSync(path.join(h, ".config/boxd/hosts.order"), "utf8"), "srv\nlap\n", "a new host goes last");
  run("lap", "--default");
  assert.equal(readFileSync(path.join(h, ".config/boxd/host"), "utf8"), "lap\n");
  assert.equal(readFileSync(path.join(h, ".config/boxd/hosts.order"), "utf8"), "lap\nsrv\n", "--default puts it first");
});

test("setup with wake addresses puts the Match line at the top and the addresses in wake.json; without them both go away", () => {
  const h = mkdtempSync(path.join(root, "setup-"));
  const run = (...a: string[]) => spawnSync(process.execPath, [TOOL, "setup", ...a], { encoding: "utf8", env: { HOME: h } });
  mkdirSync(path.join(h, ".ssh"));
  writeFileSync(path.join(h, ".ssh/config"), "Host other\n  HostName elsewhere\n");
  assert.equal(run("srv", "--wake", "00:11:22:33:44:55,00:11:22:33:44:66", "--broadcast", "10.9.9.255").status, 0);
  const conf = readFileSync(path.join(h, ".ssh/config"), "utf8").split("\n");
  assert.equal(conf[0], "# boxd:wake:boxd-srv:begin");
  assert.match(conf[1] ?? "", /^Match originalhost boxd-srv exec "node \/.*box-wake\.mjs %n"$/);
  assert.ok(conf.indexOf("Host other") > conf.indexOf("# boxd:wake:boxd-srv:end"), "the hook sits before every Host block");
  assert.deepEqual(JSON.parse(readFileSync(path.join(h, ".config/boxd/wake.json"), "utf8")),
    { "boxd-srv": { target: "srv:2222", macs: ["00:11:22:33:44:55", "00:11:22:33:44:66"], broadcast: "10.9.9.255" } });
  assert.equal(run("srv").status, 0);
  assert.doesNotMatch(readFileSync(path.join(h, ".ssh/config"), "utf8"), /Match originalhost/);
  assert.equal(readFileSync(path.join(h, ".config/boxd/wake.json"), "utf8"), "{}\n");
});

test("setup refuses bad input and writes nothing", () => {
  const h = mkdtempSync(path.join(root, "setup-"));
  const run = (...a: string[]) => spawnSync(process.execPath, [TOOL, "setup", ...a], { encoding: "utf8", env: { HOME: h } });
  for (const bad of [[], ["a b"], ["srv", "--port", "0"], ["srv", "--port", "x"], ["srv", "--wake", "zz"], ["srv", "--wake", "00:11:22:33:44:55"],
    ["srv", "--broadcast", "not an address"], ["srv", "--user", "a b"], ["srv", "--bogus", "1"], ["srv", "--port"], ["srv", "two"]]) {
    assert.equal(run(...bad).status, 2, JSON.stringify(bad));
  }
  assert.equal(run("--help").status, 0);
  assert.equal(existsSync(path.join(h, ".ssh")), false);
});

test("no machine address, card name or account is written into the program", () => {
  const src = readFileSync(TOOL, "utf8") + readFileSync(path.join(REPO, "client/box-wake.mjs"), "utf8");
  assert.doesNotMatch(src, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|[0-9a-f]{2}(:[0-9a-f]{2}){5}|tower|\/work\b/i);
});

test("committed box.mjs matches a fresh tsc-rs build", { skip: NO_TSC }, () => {
  const out = mkdtempSync(path.join(tmpdir(), "box-build-"));
  try {
    execFileSync(TSC!, ["-p", path.join(REPO, "client"), "--outDir", out]);
    assert.equal(readFileSync(TOOL, "utf8"), readFileSync(path.join(out, "box.mjs"), "utf8"), "stale: run tsc-rs -p client");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("box ps asks the host for this worktree's box and prints a table, oldest first as sent", () => {
  const r = runBox(["ps"], { env: { FAKE_SSH_OUT: "4242\t7300\t65\t/job/src\tvitest run\n77\t42\t0\t?\tsleep 5" } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, [`ssh boxd-test pod ps ${box}`]);
  assert.deepEqual(r.out.trimEnd().split("\n").map((l: string) => l.split(/ {2,}/)), [
    ["PID", "AGE", "CPU", "FOLDER", "COMMAND"],
    ["4242", "2h01m", "1m05s", "/job/src", "vitest run"],
    ["77", "42s", "0s", "?", "sleep 5"],
  ]);
});

test("box ps --pod names the box; the host's exit code passes through; nothing is synced", () => {
  const r = runBox(["ps", "--pod", "other-box"], { env: { FAKE_SSH_EXIT: "125" } });
  assert.equal(r.code, 125);
  assert.deepEqual(r.calls, ["ssh boxd-test pod ps other-box"]);
  assert.equal(runBox(["ps", "--bogus"]).code, 2);
});

test("a silent foreground call gets the box ps table on stderr, every line prefixed; stdout and exit code untouched", () => {
  const count = path.join(root, "ps-count");
  const fifo = path.join(root, "ps-fifo");
  rmSync(count, { force: true }); rmSync(fifo, { force: true });
  execFileSync("mkfifo", [fifo]);
  const r = runBox(["--no-sync", "--ps-after", "0.0001", "--", "make"], { env: { FAKE_PS_COUNT: count, FAKE_PS_FIFO: fifo } });
  assert.equal(r.code, 3);
  assert.equal(r.out, "done\n");
  const lines = r.err.trimEnd().split("\n");
  assert.ok(lines.length >= 3, r.err);
  for (const l of lines.slice(0, -1)) assert.match(l, /^\[box ps\] /, l);
  assert.equal(lines.at(-1), "box: exit 3 on test", "the last line is the exit line");
  assert.match(lines[0] as string, new RegExp(`^\\[box ps\\] no output for \\d+s; processes in box ${box}, oldest first:$`));
  assert.match(r.err, /\[box ps\] PID +AGE +CPU +FOLDER +COMMAND\n\[box ps\] 7 +1h00m +0s +\/job\/src +sleep 99\n/);
  assert.ok(r.calls.includes(`ssh boxd-test pod ps ${box}`));
});

test("--ps-after 0 and BOXD_PS_AFTER=0 turn the report off; a bad value is a usage error", () => {
  for (const env of [{}, { BOXD_PS_AFTER: "0" }]) {
    const r = runBox(["--no-sync", ...("BOXD_PS_AFTER" in env ? [] : ["--ps-after", "0"]), "--", "make"], { env });
    assert.equal(r.code, 0);
    assert.equal(r.calls.filter((c: string) => c.includes(" pod ps ")).length, 0);
  }
  assert.equal(runBox(["--no-sync", "--ps-after", "soon", "--", "make"]).code, 2);
});

test("--env: the value travels only in ssh's environment (SendEnv), the name on the command line", () => {
  const r = runBox(["--no-sync", "--env", "GH_TOKEN", "--", "make"], { env: { GH_TOKEN: "s3cr3t-value" } });
  assert.equal(r.code, 0);
  assert.ok(r.calls.includes("ssh-env BOXD_SECRET_GH_TOKEN"), r.calls.join("\n"));
  const call = r.calls.find((c: string) => c.startsWith("ssh ") && c.includes("pod run")) as string;
  assert.match(call, /-o SendEnv=BOXD_SECRET_GH_TOKEN /);
  assert.match(call, / pod run \S+ --env GH_TOKEN -- /);
  assert.ok(!r.calls.join("\n").includes("s3cr3t-value"));
});

test("--env refuses a name that is not set, or not a credential name, before any call", () => {
  assert.equal(runBox(["--no-sync", "--env", "GH_TOKEN", "--", "make"]).code, 2);
  const r = runBox(["--no-sync", "--env", "PATH", "--", "make"], { env: { PATH: process.env.PATH ?? "" } });
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls, []);
});

test("duration: seconds, minutes, hours", () => {
  assert.deepEqual([0, 59, 60, 3599, 3600, 7322].map(duration), ["0s", "59s", "1m00s", "59m59s", "1h00m", "2h02m"]);
});

test("psTable keeps a line it cannot parse and says when nothing runs", () => {
  assert.equal(psTable(""), "no processes running in the box\n");
  assert.match(psTable("odd line without tabs\n"), /^PID.*\nodd line without tabs\n$/);
});

// Seam: the real server script (PS_SCRIPT in server/boxd-pod, run here on this machine's /proc as it runs in a box)
// feeds the real client formatter: every line it prints is a five-column row the client understands.
test("seam: every line the server's process report prints is a row psTable parses", () => {
  const src = readFileSync(path.join(REPO, "server/boxd-pod"), "utf8");
  const script = execFileSync("bash", ["-c", 'eval "$(sed -n "/^PS_SCRIPT=/,/sort -t/p" "$1")"; printf %s "$PS_SCRIPT"', "_", path.join(REPO, "server/boxd-pod")], { encoding: "utf8" });
  assert.ok(src.includes("PS_SCRIPT=") && script.includes("/proc/uptime"));
  const raw = execFileSync("sh", ["-c", script], { encoding: "utf8" });
  const lines = psTable(raw).trimEnd().split("\n");
  assert.ok(lines.length > 2, "the report found processes");
  for (const l of lines.slice(1)) assert.match(l, /^\d+ +\d+[hms]\S* +\d+[hms]\S* +\S/, l);
});

// ---- choosing among several build servers (docs/designs/load-management.md; acceptance scenarios 1 to 9 against the
// fake ssh; the same scenarios against real hosts are in tests/pod-acceptance.sh) ----

// Seam: a status line captured from the REAL boxd-pod (fake podman and msb first on PATH), never typed by hand.
function realStatus(vmRunning: number, capMb?: number): string {
  const d = mkdtempSync(path.join(root, "srv-")), sbin = path.join(d, "bin"), work = path.join(d, "work"), imgs = path.join(d, "images");
  for (const x of [sbin, work, imgs]) mkdirSync(x);
  writeFileSync(path.join(imgs, "toolbox.tar"), "");
  const fake = { podman: "exit 0", pgrep: "exit 0", // every listed sandbox has a machine process
    msb: `[ "$1" = ls ] || exit 0\necho "NAME IMAGE STATUS"\ni=0; while [ $i -lt ${vmRunning} ]; do echo "pod-v$i img running"; i=$((i+1)); done` };
  for (const [n, body] of Object.entries(fake)) { writeFileSync(path.join(sbin, n), `#!/bin/sh\n${body}\n`); chmodSync(path.join(sbin, n), 0o755); }
  if (capMb !== undefined) {   // a measurable build cgroup: nothing in use, so mem_free_mb is the cap
    mkdirSync(path.join(d, "cg/boxd"), { recursive: true });
    writeFileSync(path.join(d, "cg/boxd/memory.max"), `${capMb * 1048576}\n`);
    writeFileSync(path.join(d, "cg/boxd/memory.stat"), "anon 0\nshmem 0\n");
  }
  const r = spawnSync("bash", [path.join(REPO, "server/boxd-pod")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${sbin}:${process.env.PATH ?? ""}`, HOME: home, BOXD_CONF: "/nonexistent", BOXD_WORK: work, BOXD_IMAGES_DIR: imgs, BOXD_CGROOT: path.join(d, "cg"), BOXD_VM_MAX: "3", SSH_ORIGINAL_COMMAND: "pod status" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().replace(/version=[^\t]+/, "version=0.4.40");   // an old server, stated here: tests must not inherit the client's VERSION (a server from 0.4.41 gets --queued and pod queue)
}
const FULL = realStatus(3), FREE = realStatus(1);
const REFUSAL = "boxd-pod: no room for another virtual machine (3 of 3 running); wait for one to end or stop one";
const { parseStatus, choose, NO_ROOM, VERSION, register } = await import(TOOL);

type Fake = { name: string; status?: string; runExit?: number; runErr?: string };
// A user with the given build servers registered (ssh config markers, hosts.order) and one folder of fake host files.
function servers(hs: Fake[], opts: { wake?: Record<string, string>; order?: string[] } = {}) {
  const d = mkdtempSync(path.join(root, "servers-")), h = path.join(d, "home"), fh = path.join(d, "fake");
  for (const x of [path.join(h, ".ssh"), path.join(h, ".config/boxd"), fh]) mkdirSync(x, { recursive: true });
  writeFileSync(path.join(h, ".ssh/config"), hs.map((x) => `# boxd:host:boxd-${x.name}:begin\nHost boxd-${x.name}\n# boxd:host:boxd-${x.name}:end\n`).join("\n"));
  writeFileSync(path.join(h, ".config/boxd/hosts.order"), `${(opts.order ?? hs.map((x) => x.name)).join("\n")}\n`);
  writeFileSync(path.join(h, ".config/boxd/host"), `${hs[0]?.name}\n`);
  if (opts.wake) writeFileSync(path.join(h, ".config/boxd/wake.json"), JSON.stringify(Object.fromEntries(Object.entries(opts.wake).map(([n, t]) => [`boxd-${n}`, { target: t, macs: [], broadcast: "x" }]))));
  const s = { home: h, fake: fh, set(x: Fake) {
    const f = (e: string) => path.join(fh, `boxd-${x.name}.${e}`);
    for (const e of ["status", "run.exit", "run.err"]) rmSync(f(e), { force: true });
    if (x.status !== undefined) writeFileSync(f("status"), `${x.status}\n`);
    if (x.runExit !== undefined) writeFileSync(f("run.exit"), `${x.runExit}\n`);
    if (x.runErr !== undefined) writeFileSync(f("run.err"), `${x.runErr}\n`);
  } };
  hs.forEach((x) => s.set(x));
  return s;
}
let repoN = 0;
function newRepo() {
  const cwd = path.join(root, `worktree-${++repoN}`);
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  return { cwd, top, box: plan(top, [], ["x"]).box, placed: () => { try { return readFileSync(path.join(cwd, ".git/boxd-host"), "utf8"); } catch { return undefined; } } };
}
type Repo = ReturnType<typeof newRepo>;
type Servers = ReturnType<typeof servers>;
const go = (rp: Repo, s: Servers, args: string[], env: Record<string, string> = {}) => runBox(args, { cwd: rp.cwd, env: { BOXD_HOST: "", HOME: s.home, FAKE_HOSTS: s.fake, ...env } });
const probes = (calls: string[]) => calls.filter((c) => c.endsWith(" pod status")).sort();
const probe = (n: string) => `ssh -o ConnectTimeout=3 -o BatchMode=yes boxd-${n} pod status`;
const rest = (calls: string[]) => calls.filter((c) => !c.endsWith(" pod status"));
const sync = (rp: Repo, n: string) => `rsync -a --delete --mkpath --safe-links --exclude=/.git --filter=:- .gitignore ${rp.top}/ boxd-${n}:jobs/${rp.box}/src/`;
const runLine = (rp: Repo, n: string, ...opts: string[]) => `ssh boxd-${n} pod run ${rp.box} ${opts.join(" ")} -- ${b64("true")}`.replace("  --", " --");
const choices = (s: Servers) => { try { return readFileSync(path.join(s.home, ".local/state/boxd/choices.log"), "utf8").trim().split("\n").map((l) => l.split("\t")); } catch { return []; } };
const closedPort = async () => { const s = net.createServer().listen(0, "127.0.0.1"); await once(s, "listening"); const p = (s.address() as net.AddressInfo).port; s.close(); await once(s, "close"); return p; };

test("seam: the real server's status line is what the client's choice reads", () => {
  assert.deepEqual(Object.keys(parseStatus(FULL)), ["version", "engines", "cpus", "load1", "vm_used", "vm_max", "vm_room", "boxes", "disk_pct", "mem_free_mb", "images", "mem_avail_mb", "group_mem_used_mb", "group_mem_max_mb", "vm_why", "vm_fit_mb", "box_room", "box_fit_mb", "box_reserve_mb", "waiting"]);
  assert.equal(parseStatus(FULL).vm_room, "no");
  assert.equal(parseStatus(FREE).vm_room, "yes");
  assert.equal(parseStatus(FREE).images, "toolbox");
  const on = (status: string, req: object) => choose([{ name: "a", state: "awake", status }], req);
  assert.deepEqual(on(FULL, { vm: true }).refusal, ["a: 3 of 3 running"]);
  assert.equal(on(FREE, { vm: true, image: "localhost/toolbox:latest" }).host, "a");
  assert.deepEqual(on(FREE, { vm: false, image: "localhost/other" }).refusal, ["a: image other missing"]);
});

test("scenario 1 overflow: the first vm call of a worktree goes to the next host when the first is full; placement and log", () => {
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(probes(r.calls), [probe("laptop"), probe("tower")]);
  assert.deepEqual(rest(r.calls), [sync(rp, "laptop"), runLine(rp, "laptop", "--vm")]);
  assert.equal(rp.placed(), "laptop\n");
  const log = choices(s);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0]?.slice(1), [rp.box, "vm,-", "laptop", "overflow", "tower=3 of 3 running,laptop=awake"]);
  assert.match(log[0]?.[0] ?? "", /^\d{4}-\d\d-\d\dT/);
});

test("scenarios 2 and 3 stickiness and move: later calls stay, ask nobody; --host moves and records", () => {
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop", status: FREE }]), rp = newRepo();
  go(rp, s, ["--vm", "true"]);
  s.set({ name: "tower", status: FREE }); // room again on the first host: the worktree still stays where its files are
  const again = go(rp, s, ["--vm", "true"]);
  assert.deepEqual(again.calls, [sync(rp, "laptop"), runLine(rp, "laptop", "--vm")]);
  const moved = go(rp, s, ["--host", "tower", "--vm", "true"]);
  assert.deepEqual(moved.calls, [sync(rp, "tower"), runLine(rp, "tower", "--vm")]);
  assert.equal(rp.placed(), "tower\n");
  assert.deepEqual(go(rp, s, ["--vm", "true"]).calls, [sync(rp, "tower"), runLine(rp, "tower", "--vm")]);
  assert.deepEqual(choices(s).map((l) => l[4]), ["overflow", "moved"]);
  // --host naming the host it is already on records and logs nothing more
  go(rp, s, ["--host", "tower", "--vm", "true"]);
  assert.equal(choices(s).length, 2);
});

// Spread (0.4.8): the first host in order with room took every new worktree until it refused, and it refused only once it
// was out of memory (2026-11-15, the tower: eight machines, one killed by the kernel, laptop used only when asked).
// Smallest fit (owner decision 2026-11-17): a machine goes to the host with the smallest cap for boxes, so the big host stays free for big machines.
test("spread: a new container worktree goes to the host with the most free memory, a machine to the smallest cap; ties keep the box hosts order", () => {
  const small = realStatus(1, 20000), big = realStatus(1, 30000);
  assert.equal(parseStatus(big).mem_free_mb, "30000");
  assert.equal(parseStatus(big).vm_room, "yes");
  const pick = (a: string, b: string, vm: boolean) => choose([{ name: "tower", state: "awake", status: a }, { name: "laptop", state: "awake", status: b }], { vm });
  assert.deepEqual([pick(small, big, true).host, pick(small, big, true).reason], ["tower", "fit"], "a machine: the smaller cap, although the other host has more free memory");
  assert.deepEqual([pick(big, small, true).host, pick(big, small, true).reason], ["laptop", "fit"]);
  assert.deepEqual(pick(small, big, true).room, ["tower", "laptop"], "the retry after a lost race walks the rest by cap too");
  assert.deepEqual([pick(big, big, true).host, pick(big, big, true).reason], ["tower", "fit"], "equal caps keep the order");
  assert.deepEqual([pick(small, big, false).host, pick(small, big, false).reason], ["laptop", "spread"], "containers spread by free memory");
  assert.deepEqual([pick(big, small, false).host, pick(big, small, false).reason], ["tower", "order"]);
  assert.deepEqual([pick(FREE, FREE, true).host, pick(FREE, FREE, true).reason], ["tower", "order"], "no host reports a cap: the old rule");
  assert.equal(pick(FREE, big, true).host, "laptop", "a host that reports no cap comes after one that reports it");
  assert.equal(choose([{ name: "tower", state: "asleep" }, { name: "laptop", state: "awake", status: big }], { vm: true }).host, "laptop", "an asleep host comes after an awake one with a cap");
  assert.equal(choose([{ name: "tower", state: "asleep" }, { name: "laptop", state: "awake", status: big }], { vm: false }).host, "tower", "a container: an asleep host runs nothing, most room");
  assert.equal(pick(FULL, FREE, true).reason, "overflow", "the first host had no room: still overflow");
});

test("spread through the command: a container goes to the host with more free memory, a machine to the host with the smaller cap, and the choices log names the reason", () => {
  const s = servers([{ name: "tower", status: realStatus(1, 30000) }, { name: "laptop", status: realStatus(1, 20000) }]), rp = newRepo(), rc = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [sync(rp, "laptop"), runLine(rp, "laptop", "--vm")]);
  assert.equal(rp.placed(), "laptop\n");
  assert.deepEqual(choices(s)[0]?.slice(3, 5), ["laptop", "fit"]);
  assert.equal(go(rc, s, ["true"]).code, 0);
  assert.equal(rc.placed(), "tower\n");
  assert.deepEqual(choices(s)[1]?.slice(3, 5), ["tower", "order"]);
});

test("a foreground call ends with the line box: exit <code> on <host> on standard error, whatever the code; standard output has none", () => {
  const ok = runBox(["--no-sync", "true"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.err.split("\n").at(-2), "box: exit 0 on test");
  assert.equal(ok.err.endsWith("box: exit 0 on test\n"), true);
  assert.equal(ok.out.includes("box: exit"), false);
  const bad = runBox(["--no-sync", "true"], { env: { FAKE_SSH_EXIT: "3" } });
  assert.equal(bad.code, 3);
  assert.equal(bad.err.split("\n").at(-2), "box: exit 3 on test");
});

test("no box: exit line for --detach, nor for a call refused before a host was chosen", () => {
  const d = runBox(["--no-sync", "--detach", "sleep", "9"]);
  assert.equal(d.err.includes("box: exit"), false);
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop", status: FULL }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.equal(r.err.includes("box: exit"), false);
});

test("scenario 4 all full: exit 75 at once with one reason per host, nothing synced, nothing placed", () => {
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop", status: FULL }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.match(r.err, /^box: no build server has room for this call\n  tower: 3 of 3 running\n  laptop: 3 of 3 running\n  or wait for room: add --wait\n$/);
  assert.deepEqual(rest(r.calls), []);
  assert.equal(rp.placed(), undefined);
  assert.equal(choices(s).length, 0);
});

test("scenario 5 sleeping build server first: it is chosen without any ssh to it, the call itself wakes it", async () => {
  const s = servers([{ name: "tower" }, { name: "laptop", status: FREE }], { wake: { tower: `127.0.0.1:${await closedPort()}` } }), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [sync(rp, "tower"), runLine(rp, "tower", "--vm")]);
  assert.ok(!r.calls.some((c) => c.includes("boxd-tower pod status")), "a status ssh would have woken the sleeping host");
  assert.deepEqual(choices(s)[0]?.slice(3), ["tower", "order", "tower=asleep,laptop=awake"]);
});

test("scenario 6 never wake to ask: box hosts says asleep and makes no ssh to a host that does not answer", async () => {
  const up = net.createServer().listen(0, "127.0.0.1");
  await once(up, "listening");
  const upPort = (up.address() as net.AddressInfo).port;
  const s = servers([{ name: "tower" }, { name: "laptop", status: FREE }, { name: "third" }], { wake: { tower: `127.0.0.1:${await closedPort()}`, laptop: `127.0.0.1:${upPort}` } });
  const r = go(newRepo(), s, ["hosts"]);
  up.close();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trimEnd().split("\n"), ["tower\tsleeps\tasleep\t-", `laptop\tsleeps\tawake\t${FREE}`, "third\talways on\tunreachable\t-"]);
  assert.deepEqual(r.calls.sort(), [probe("third"), probe("laptop")].sort());
  assert.equal(go(newRepo(), { ...s, home: mkdtempSync(path.join(root, "bare-")) }, ["hosts"]).code, 2);
});

test("scenario 7 lost race: no room when the call arrives, so it is retried on the next host with room, and the placement follows", () => {
  const s = servers([{ name: "tower", status: FREE, runExit: NO_ROOM, runErr: REFUSAL }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [sync(rp, "tower"), runLine(rp, "tower", "--vm"), sync(rp, "laptop"), runLine(rp, "laptop", "--vm")]);
  assert.equal(rp.placed(), "laptop\n");
  assert.deepEqual(choices(s).map((l) => [l[3], l[4]]), [["tower", "order"], ["laptop", "retry"]]);
  assert.match(r.err, /no room for another virtual machine/, "the refusal of the first host is still shown");
});

test("lost race: exit 75 from the command itself (no refusal text) is never retried; a refusal with nowhere to go ends placed on nothing", () => {
  const s = servers([{ name: "tower", status: FREE, runExit: NO_ROOM }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.equal(r.calls.filter((c) => c.includes(" pod run ")).length, 1);
  assert.equal(rp.placed(), "tower\n");
  const s2 = servers([{ name: "tower", status: FREE, runExit: NO_ROOM, runErr: REFUSAL }, { name: "laptop", status: FULL }]), rp2 = newRepo();
  const r2 = go(rp2, s2, ["--vm", "true"]);
  assert.equal(r2.code, NO_ROOM);
  assert.match(r2.err, /box: no other build server has room\n  laptop: 3 of 3 running\n/);
  assert.equal(rp2.placed(), undefined, "no box was made, so the worktree is not placed");
});

test("scenario 8 host down: refused naming it when the other is full, no delay or detour when the other has room", () => {
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop" }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.match(r.err, /  tower: 3 of 3 running\n  laptop: unreachable\n/);
  s.set({ name: "tower", status: FREE });
  const ok = go(rp, s, ["--vm", "true"]);
  assert.equal(ok.code, 0);
  assert.deepEqual(rest(ok.calls), [sync(rp, "tower"), runLine(rp, "tower", "--vm")]);
});

// Since 2026-11-17 a placed worktree whose host is full moves by itself when its old host can be asked and holds nothing of it (see "moves by
// itself" below). These two keep the old behaviour: the fake host has no `pod report` to give, so nothing is known to be safe to leave.
test("a placed worktree whose host is full and cannot be asked what it holds is refused with the exact command that moves it; nothing is moved", () => {
  const s = servers([{ name: "tower", status: FULL, runExit: NO_ROOM, runErr: REFUSAL }, { name: "laptop", status: FREE }]), rp = newRepo();
  go(rp, s, ["--host", "tower", "--no-sync", "true"]); // places it on tower (the fake refuses the run; the placement stays)
  const r = go(rp, s, ["--no-sync", "--vm", "sh", "-c", "make all"]);
  assert.equal(r.code, NO_ROOM);
  assert.match(r.err, /box: tower has no room; hosts that do: laptop\. Move this worktree with: box --host laptop --no-sync --vm sh -c 'make all'\nbox: exit 75 on tower\n$/);
  assert.equal(rp.placed(), "tower\n");
  assert.equal(r.calls.filter((c) => c.includes(" pod run ")).length, 1, "no automatic move");
});

test("precedence: BOXD_HOST is for this call only and records nothing; --recreate keeps the placement; a removed host is chosen again", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]), rp = newRepo();
  const env = go(rp, s, ["--no-sync", "true"], { BOXD_HOST: "laptop" });
  assert.deepEqual(env.calls, [runLine(rp, "laptop")]);
  assert.equal(rp.placed(), undefined);
  assert.deepEqual(choices(s), []);
  go(rp, s, ["true"]); // placed on tower by order
  assert.equal(rp.placed(), "tower\n");
  const re = go(rp, s, ["--recreate", "--no-sync", "true"]);
  assert.deepEqual(re.calls, [runLine(rp, "tower", "--recreate")]);
  writeFileSync(path.join(rp.cwd, ".git/boxd-host"), "gone\n");
  const again = go(rp, s, ["--no-sync", "true"]);
  assert.equal(probes(again.calls).length, 2);
  assert.equal(rp.placed(), "tower\n");
});

test("the order is hosts.order: the first listed host with room wins, and a single registered host is not probed", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }], { order: ["laptop", "tower"] }), rp = newRepo();
  assert.deepEqual(rest(go(rp, s, ["--no-sync", "true"]).calls), [runLine(rp, "laptop")]);
  const one = servers([{ name: "solo", status: FREE }]), rp1 = newRepo();
  assert.deepEqual(go(rp1, one, ["--no-sync", "true"]).calls, [runLine(rp1, "solo")]);
  assert.equal(rp1.placed(), undefined);
});

test("box ps asks the host the worktree is placed on", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]), rp = newRepo();
  writeFileSync(path.join(rp.cwd, ".git/boxd-host"), "laptop\n");
  assert.deepEqual(go(rp, s, ["ps"]).calls, [`ssh boxd-laptop pod ps ${rp.box}`]);
});

// box image push ------------------------------------------------------------------------------------------------
const ID = "0123456789ab0123456789ab0123456789ab0123456789ab0123456789abcdef", REF = "docker.io/library/busybox:stable";
const loadIn = path.join(root, "load-in");
const push = (args: string[], env: Record<string, string> = {}, dirs = [withPodman]) =>
  runBox(["image", "push", ...args], { env: { PATH: [...dirs, bin, basics].join(":"), FAKE_LOAD_IN: loadIn, ...env } });

test("image push: pulls here, asks the host with the id, streams the saved archive into the load call, nothing else", () => {
  rmSync(loadIn, { force: true });
  const r = push([REF]);
  assert.equal(r.code, 0);
  // save and the load call run at the same time, so only the order before them is fixed
  assert.deepEqual(r.calls.slice(0, 3), [
    `podman pull ${REF}`, `podman image inspect --format {{.Id}} ${REF}`,
    `ssh boxd-test pod image has container ${REF} ${ID}`,
  ]);
  assert.deepEqual(r.calls.slice(3).sort(), [`podman save ${REF}`, `ssh boxd-test pod image load container ${REF} ${ID}`]);
  assert.equal(readFileSync(loadIn, "utf8"), `ARCHIVE-OF-${REF}`);
});

test("image push: the host already has the image: one line, no save, no load, exit 0", () => {
  rmSync(loadIn, { force: true });
  const r = push(["--vm", "--host", "other", REF], { FAKE_HAS_EXIT: "0" });
  assert.equal(r.code, 0);
  assert.match(r.out, /already on boxd-other for vm, nothing sent/);
  assert.deepEqual(r.calls.filter((l: string) => l.startsWith("ssh")), [`ssh boxd-other pod image has vm ${REF} ${ID}`]);
  assert.equal(r.calls.some((l: string) => l.startsWith("podman save")), false);
  assert.equal(existsSync(loadIn), false);
});

test("image push: the host's refusal passes through and nothing is sent", () => {
  const r = push([REF], { FAKE_HAS_EXIT: "125" });
  assert.equal(r.code, 125);
  assert.equal(r.calls.some((l: string) => l.startsWith("podman save")), false);
});

test("image push: a failed pull exits with its code and never reaches the host", () => {
  const r = push([REF], { FAKE_PULL_EXIT: "7" });
  assert.equal(r.code, 7);
  assert.equal(r.calls.some((l: string) => l.startsWith("ssh")), false);
});

test("image push: a failed save is reported and its code wins over the host's", () => {
  const r = push([REF], { FAKE_SAVE_EXIT: "4", FAKE_LOAD_EXIT: "125" });
  assert.equal(r.code, 4);
  assert.match(r.err, /podman save failed/);
});

test("image push: the host's load refusal is the exit code", () => assert.equal(push([REF], { FAKE_LOAD_EXIT: "125" }).code, 125));

test("image push: docker when podman is missing, its sha256: prefix dropped from the id", () => {
  const r = push([REF], {}, [withDocker]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.filter((l: string) => l.startsWith("ssh"))[0], `ssh boxd-test pod image has container ${REF} ${ID}`);
  assert.equal(r.calls.some((l: string) => l.startsWith("docker save")), true);
});

test("image push: neither podman nor docker is a usage error, exit 2, no ssh", () => {
  const r = runBox(["image", "push", REF], { env: { PATH: withNone } });
  assert.equal(r.code, 2);
  assert.match(r.err, /neither podman nor docker/);
  assert.deepEqual(r.calls, []);
});

test("image push: usage errors exit 2 and call nothing; no password option exists", () => {
  for (const a of [[], ["--vm", "--container", REF], ["--password", "x", REF], ["bad ref"]]) {
    const r = push(a);
    assert.equal(r.code, 2);
    assert.deepEqual(r.calls, []);
  }
  assert.equal(runBox(["image"]).code, 2);
});

// ---- a foreground call lives as long as the process that started it ----------------------------------------------------
// The starter (a small program) spawns the client and exits once the fake ssh is up; the client is then re-parented. The
// client's exit code reaches the test through a preloaded file that writes it into a fifo when the client exits: a wait
// on an event, never on a clock. BOXD_ORPHAN_CHECK_MS only sets how soon the client looks; no assertion depends on it.
const preload = path.join(root, "preload.cjs");
writeFileSync(preload, `const fs = require("fs"), first = process.ppid, e = process.env;
if (e.TEST_REPARENTED) { const t = setInterval(() => { if (process.ppid !== first) { clearInterval(t); fs.writeFileSync(e.TEST_REPARENTED, "x"); } }, 1); t.unref(); }
process.on("exit", (c) => fs.writeFileSync(e.TEST_EXITED, String(c)));
`);
const starter = path.join(root, "starter.mjs");
writeFileSync(starter, `import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
const [tool, pre, errFile, started, ...args] = process.argv.slice(2);
spawn(process.execPath, ["--require", pre, tool, ...args], { stdio: ["ignore", "ignore", openSync(errFile, "w")] });
readFileSync(started);
process.exit(0);
`);
// Lets the fake ssh finish (it waits for a writer on the hold fifo); with no reader waiting this does nothing.
function release(hold: string) {
  try { closeSync(openSync(hold, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* the fake already ended */ }
}
async function startStarter(extra: Record<string, string>, watchReparent: boolean) {
  const { readFile } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(path.join(root, "orphan-"));
  const p = (n: string) => path.join(dir, n);
  for (const n of ["hold", "started", "exited", "reparented"]) execFileSync("mkfifo", [p(n)]);
  const exited = readFile(p("exited"), "utf8");
  const reparented = watchReparent ? readFile(p("reparented"), "utf8") : undefined;
  const st = spawn(process.execPath, [starter, TOOL, preload, p("err"), p("started"), "--no-sync", "sleep", "1"], { stdio: "ignore",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, BOXD_HOST: "test", BOXD_GC: "0", CALLS: log, FAKE_BLOCK_DIR: dir, TEST_EXITED: p("exited"),
      ...(watchReparent ? { TEST_REPARENTED: p("reparented") } : {}), BOXD_ORPHAN_CHECK_MS: "1", ...extra } });
  await once(st, "exit");
  return { exited, reparented, p, err: () => readFileSync(p("err"), "utf8") };
}

test("a foreground call ends when the process that started it is gone: the message, exit 129, ssh told to end", { timeout: 30_000 }, async () => {
  const t = await startStarter({}, false);
  try {
    assert.equal(await t.exited, "129");
    assert.equal(t.err(), "box: the process that started this call is gone; ending the call (use --detach for work that must outlive its starter)\n");
    assert.equal(readFileSync(t.p("term"), "utf8"), "term\n"); // the fake ssh got its termination before the client ended
  } finally { release(t.p("hold")); } // a failing run must not leave the fake ssh waiting
});

test("BOXD_KEEP_ORPHAN=1 keeps the call going when its starter is gone", { timeout: 30_000 }, async () => {
  const t = await startStarter({ BOXD_KEEP_ORPHAN: "1" }, true);
  try {
    await t.reparented; // the client's own parent is gone for good; its interval has had every chance to fire
    writeFileSync(t.p("hold"), "go\n"); // the fake ssh finishes by itself
    assert.equal(await t.exited, "0");
    assert.equal(t.err(), "box: exit 0 on test\n");
    assert.equal(existsSync(t.p("term")), false);
  } finally { release(t.p("hold")); }
});

// ---- box stop --run: `pod end` ends one detached run ------------------------------------------------------------------------
test("box stop --run: asks pod end for that run only (resolved as box log does), says the box keeps running, exit 0, one call", () => {
  const r = logRun(["stop", "--run", "run-1"], [`ended run run-1 in box ${box}\n`]);
  assert.deepEqual([r.code, r.out, r.err, r.calls], [0, `box stop: ended run run-1 in box ${box} on test; the box keeps running\n`, "", [`ssh boxd-test pod end ${box} run-1`]]);
  const o = logRun(["stop", "--run", "run-1", "--pod", "other", "--host", "h2"], [`ended run run-1 in box other\n`]);
  assert.deepEqual([o.code, o.calls], [0, ["ssh boxd-h2 pod end other run-1"]]);
});

test("box stop --run: a run that already ended is a line and exit 0; a refusal of the server passes through with its code", () => {
  const r = logRun(["stop", "--run", "run-1"], [`run run-1 in box ${box} has already ended\n`]);
  assert.deepEqual([r.code, r.out, r.err], [0, `box stop: run run-1 in box ${box} on test has already ended; nothing to do\n`, ""]);
  const dir = mkdtempSync(path.join(root, "logdir-"));
  writeFileSync(path.join(dir, "1"), ""); writeFileSync(path.join(dir, "err"), `boxd-pod: no run run-9 in box ${box}\n`); writeFileSync(path.join(dir, "exit"), "125");
  const x = runBox(["stop", "--run", "run-9"], { env: { FAKE_LOGDIR: dir } });
  assert.deepEqual([x.code, x.out, x.err], [125, "", `boxd-pod: no run run-9 in box ${box}\n`]);
  assert.deepEqual(logRun(["stop", "--run", "run-1"], ["something else\n"]).code, 1);
});

test("box stop --run against a server that does not know the word: one line about the upgrade, exit 125", () => {
  const dir = mkdtempSync(path.join(root, "logdir-"));
  writeFileSync(path.join(dir, "1"), ""); writeFileSync(path.join(dir, "err"), "boxd-pod: unknown command\n"); writeFileSync(path.join(dir, "exit"), "125");
  const r = runBox(["stop", "--run", "run-1"], { env: { FAKE_LOGDIR: dir } });
  assert.deepEqual([r.code, r.out, r.err], [125, "", "box stop: this build server is older than run ending: box stop --run needs an upgrade\n"]);
});

test("--run belongs to box stop: box drop --run and a bad run id are usage errors (exit 2) and call nothing", () => {
  for (const v of [["drop", "--run", "run-1"], ["stop", "--run", "../x"], ["stop", "--run"]]) {
    const r = runBox(v);
    assert.deepEqual([r.code, r.out === "", r.calls], [2, true, []], v.join(" "));
  }
});

// ---- box log: a detached run's log is read without starting the box ---------------------------------------------------
function logRun(args: string[], answers: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(root, "logdir-"));
  answers.forEach((a, i) => writeFileSync(path.join(dir, String(i + 1)), a));
  return runBox(args, { env: { FAKE_LOGDIR: dir, BOXD_LOG_POLL_MS: "1", ...env } });
}
const head = (size: number, from: number, next: number, state: string, exit = "-") => `log\tsize=${size}\tfrom=${from}\tnext=${next}\tstate=${state}\texit=${exit}\n`;

test("box log reads from offset 0 with `pod log`, prints the text, starts nothing and syncs nothing", () => {
  const r = logRun(["log", "run-1"], [`${head(6, 0, 6, "ended", "0")}hello\n`]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "hello\n");
  assert.deepEqual(r.calls, [`ssh boxd-test pod log ${box} run-1 0`]);
});

test("box log --pod and --host name the box and the host; a log longer than one answer is read on at once", () => {
  const r = logRun(["log", "run-1", "--pod", "other", "--host", "h2"], [`${head(10, 0, 4, "running")}abc\n`, `${head(10, 4, 10, "ended", "0")}defgh\n`]);
  assert.equal(r.out, "abc\ndefgh\n");
  assert.deepEqual(r.calls, ["ssh boxd-h2 pod log other run-1 0", "ssh boxd-h2 pod log other run-1 4"]);
});

test("box log --follow asks again from the returned offset until the run ended and exits with the run's code", () => {
  const r = logRun(["log", "run-1", "--follow"], [`${head(2, 0, 2, "running")}a\n`, head(2, 2, 2, "running"), `${head(10, 2, 10, "ended", "3")}b\nEXIT 3\n`]);
  assert.equal(r.out, "a\nb\nEXIT 3\n");
  assert.equal(r.code, 3);
  assert.equal(r.err, "box: run run-1 exit 3 on test\n"); // the last line names the code and the host
  assert.equal(logRun(["log", "run-1"], [`${head(6, 0, 6, "ended", "3")}hello\n`]).err, ""); // not without --follow
  assert.match(logRun(["log", "run-1", "--follow"], [`${head(2, 0, 2, "ended")}a\n`]).err, /ended without an exit code.*\nbox: run run-1 exit 129 on test\n$/);
  assert.deepEqual(r.calls, [0, 2, 2].map((o) => `ssh boxd-test pod log ${box} run-1 ${o}`));
});

test("box log --state: one line with the state and the code, no log text, one call", () => {
  const a = logRun(["log", "run-1", "--state"], [`${head(9, 0, 9, "running")}a\nb\n`]);
  assert.deepEqual([a.out, a.code, a.calls.length], ["run-1\tstate=running\texit=-\n", 0, 1]);
  assert.equal(logRun(["log", "run-1", "--state"], [`${head(9, 0, 9, "ended", "3")}a\nEXIT 3\n`]).out, "run-1\tstate=ended\texit=3\n");
  assert.equal(logRun(["log", "run-1", "--state"], [`${head(2, 0, 2, "ended")}a\n`]).out, "run-1\tstate=ended\texit=-\n");
  // ended and seconds: shown in UTC without milliseconds when valid; any other header word never reaches the terminal
  const st = (words: string, state = "ended") => logRun(["log", "run-1", "--state"], [`${head(2, 0, 2, state, "3").trimEnd()}${words}\na\n`]).out;
  assert.equal(st("\tended=1794851327\tseconds=125"), "run-1\tstate=ended\texit=3\tended=2026-11-16T17:48:47Z\tseconds=125\n");
  assert.equal(st("\tended=1794851327"), "run-1\tstate=ended\texit=3\tended=2026-11-16T17:48:47Z\n");
  assert.equal(st("\tended=1794851327\tseconds=12a"), "run-1\tstate=ended\texit=3\tended=2026-11-16T17:48:47Z\n");
  assert.equal(st("\tended=1794851327\tseconds=1234567890"), "run-1\tstate=ended\texit=3\tended=2026-11-16T17:48:47Z\n");
  for (const bad of ["\tended=17a", "\tended=1234567890123", "\tended=", "\tended=-5\tseconds=3", "\tseconds=3", "\tsecret=x"]) assert.equal(st(bad), "run-1\tstate=ended\texit=3\n", bad);
  assert.equal(st("\tended=1794851327\tseconds=5", "running"), "run-1\tstate=running\texit=3\n");
  // age/quiet: a running run only, digits only; an older server sends neither
  assert.equal(st("\tage=120\tquiet=45", "running"), "run-1\tstate=running\texit=3\tage=120\tquiet=45\n");
  assert.equal(st("\tage=120", "running"), "run-1\tstate=running\texit=3\tage=120\n");
  assert.equal(st("\tage=12a\tquiet=-5", "running"), "run-1\tstate=running\texit=3\n");
  assert.equal(st("\tage=1234567890\tquiet=45", "running"), "run-1\tstate=running\texit=3\tquiet=45\n");
  assert.equal(st("\tage=120\tquiet=45"), "run-1\tstate=ended\texit=3\n");
});

test("box log without --follow does not wait for a running run and exits 0; an ended run without an EXIT code follows to 129", () => {
  assert.equal(logRun(["log", "run-1"], [`${head(2, 0, 2, "running")}a\n`]).code, 0);
  assert.equal(logRun(["log", "run-1", "--follow"], [`${head(2, 0, 2, "ended")}a\n`]).code, 129);
});

test("box log --tail <n>: the last n lines without --follow, more than the log holds prints all, a last line without a newline counts", () => {
  assert.equal(logRun(["log", "run-1", "--tail", "2"], [`${head(10, 0, 10, "ended", "0")}1\n2\n3\n4\n5\n`]).out, "4\n5\n");
  assert.equal(logRun(["log", "run-1", "--tail", "100000"], [`${head(6, 0, 6, "ended", "0")}1\n2\n3\n`]).out, "1\n2\n3\n");
  assert.equal(logRun(["log", "run-1", "--tail", "2"], [`${head(5, 0, 5, "ended", "0")}1\n2\n3`]).out, "2\n3");
  assert.equal(logRun(["log", "run-1", "--tail", "0"], [`${head(2, 0, 2, "ended", "0")}1\n`]).out, "");
});

test("box log --tail <n>: a log served in several chunks is held back and cut to its last n lines once caught up", () => {
  const r = logRun(["log", "run-1", "--tail", "4"], [`${head(12, 0, 4, "running")}1\n2\n`, `${head(12, 4, 8, "running")}3\n4\n`, `${head(12, 8, 12, "ended", "0")}5\n6\n`]);
  assert.equal(r.out, "3\n4\n5\n6\n");
  assert.equal(r.calls.length, 3);
});

test("box log --tail 0 --follow prints nothing old, only what comes in later rounds, and exits with the run's code", () => {
  const r = logRun(["log", "run-1", "--follow", "--tail", "0"], [`${head(4, 0, 4, "running")}a\nb\n`, `${head(10, 4, 10, "ended", "3")}c\nEXIT 3\n`]);
  assert.equal(r.out, "c\nEXIT 3\n");
  assert.equal(r.code, 3);
  const k = logRun(["log", "run-1", "--follow", "--tail", "1"], [`${head(4, 0, 4, "running")}a\nb\n`, `${head(10, 4, 10, "ended", "3")}c\nEXIT 3\n`]);
  assert.equal(k.out, "b\nc\nEXIT 3\n"); // the last old line, then everything after
  assert.equal(k.code, 3);
});

// box log <run> --events: `pod events` answers one line, events then key=value words; each word is printed on its own line, and the exit code says
// whether the record covers the whole window of the run (0 yes, 3 no).
const evWords = (o: Record<string, string> = {}) => "events\t" + Object.entries({ box, id: "run-1", engine: "container", state: "ended", complete: "yes", why: "-", start: "1000", end: "1100", seconds: "100", exit: "0", group_stall_ms: "5", kills: "2", others: "dt,fg", siblings: "run-2", ...o }).map(([k, v]) => `${k}=${v}`).join("\t") + "\n";
const evLines = (o: Record<string, string> = {}) => evWords(o).trimEnd().split("\t").slice(1).join("\n") + "\n";

test("box log --events: one key=value line per word of the answer, nothing else on standard output, exit 0 when complete, one call", () => {
  const r = logRun(["log", "run-1", "--events"], [evWords()]);
  assert.equal(r.out, evLines());
  assert.deepEqual([r.code, r.err, r.calls], [0, "", [`ssh boxd-test pod events ${box} run-1`]]);
  assert.ok(r.out.startsWith(`box=${box}\nid=run-1\n`));
});

test("box log --events with a record that does not cover the window: the lines are printed, the reason goes to standard error, exit 3 (not 125, 75, 2, 1, 129 or 255)", () => {
  const r = logRun(["log", "run-1", "--events"], [evWords({ complete: "no", why: "host-restarted", group_stall_ms: "-" })]);
  assert.equal(r.out, evLines({ complete: "no", why: "host-restarted", group_stall_ms: "-" }));
  assert.equal(r.err, "box: the event record of run run-1 does not cover its window (host-restarted)\n");
  assert.equal(r.code, 3);
  for (const why of ["running", "no-start-record", "no-end-record", "counter-unreadable", "calls-log-short"]) {
    const x = logRun(["log", "run-1", "--events"], [evWords({ complete: "no", why })]);
    assert.deepEqual([x.code, x.err], [3, `box: the event record of run run-1 does not cover its window (${why})\n`]);
  }
});

test("box log --events --pod and --host name the box and the host", () => {
  const r = logRun(["log", "run-1", "--events", "--pod", "other", "--host", "h2"], [evWords()]);
  assert.deepEqual(r.calls, ["ssh boxd-h2 pod events other run-1"]);
});

test("box log --events with --follow, --tail or --state is a usage error (exit 2) and calls nothing", () => {
  for (const v of [["--follow"], ["--tail", "3"], ["--state"]]) {
    const r = runBox(["log", "run-1", "--events", ...v]);
    assert.equal(r.code, 2, v.join(" "));
    assert.match(r.err, /^box log: --events goes with no other option but --pod and --host\n/);
    assert.deepEqual(r.calls, []);
  }
});

test("box log --events against a server that does not know the word: its refusal as a line about the upgrade, exit 125; an answer that is no record is exit 1", () => {
  const dir = mkdtempSync(path.join(root, "logdir-"));
  writeFileSync(path.join(dir, "1"), ""); writeFileSync(path.join(dir, "err"), "boxd-pod: unknown command\n"); writeFileSync(path.join(dir, "exit"), "125");
  const r = runBox(["log", "run-1", "--events"], { env: { FAKE_LOGDIR: dir } });
  assert.deepEqual([r.code, r.out, r.err], [125, "", "box: this build server is older than the event record: box log --events needs an upgrade\n"]);
  const x = logRun(["log", "run-1", "--events"], ["log\tsize=1\n"]);
  assert.deepEqual([x.code, x.out, x.err], [1, "", "box log: the server's answer is not an event record\n"]);
  const g = logRun(["log", "run-1", "--events"], [evWords({ complete: "maybe" })]);
  assert.deepEqual([g.code, g.out], [1, ""]);
});

test("box --help lists box log --events", () => {
  assert.match(runBox(["--help"]).out, /box log <run> --events/);
});

test("box log --tail: a value that is not a whole number from 0 to 100000 is a usage error and calls nothing", () => {
  for (const v of [["--tail"], ["--tail", "x"], ["--tail", "-1"], ["--tail", "1.5"], ["--tail", "100001"], ["--tail", ""]]) {
    const r = runBox(["log", "run-1", ...v]);
    assert.equal(r.code, 2, v.join(" "));
    assert.match(r.err, /--tail needs a whole number from 0 to 100000/);
    assert.deepEqual(r.calls, []);
  }
});

test("box log: the host's refusal passes through; an answer that is not a log is an error; usage errors call nothing", () => {
  const refused = logRun(["log", "run-1"], ["boxd-pod: no run run-1 in box x\n"], {});
  assert.equal(refused.code, 1); // an answer without the log header
  assert.match(refused.err, /not a log/);
  const dir = mkdtempSync(path.join(root, "logdir-"));
  writeFileSync(path.join(dir, "1"), ""); writeFileSync(path.join(dir, "exit"), "125\n");
  assert.equal(runBox(["log", "run-1"], { env: { FAKE_LOGDIR: dir } }).code, 125);
  const bad = logRun(["log", "run-1"], ["log\tsize=x\tfrom=0\tnext=1\tstate=ended\texit=0\nhi\n"]);
  assert.equal(bad.code, 1);
  for (const a of [["log"], ["log", "bad/run"], ["log", "a", "b"], ["log", "a", "--bogus"]]) {
    const r = runBox(a);
    assert.equal(r.code, 2, a.join(" "));
    assert.deepEqual(r.calls, []);
  }
});

// ---- the collector: box gc, the registry, and the pass after an ordinary call -------------------------------------------------
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0), MIN = 60_000, NOWHERE = path.join(root, "no-such-worktree");
const entryPath = (s: Servers, host: string, b: string) => path.join(s.home, ".local/state/boxd/boxes", `${host}.${b}`);
const putEntry = (s: Servers, host: string, b: string, worktree: string, missingSince?: number) => {
  mkdirSync(path.dirname(entryPath(s, host, b)), { recursive: true });
  writeFileSync(entryPath(s, host, b), `${JSON.stringify({ box: b, host, worktree, ...(missingSince === undefined ? {} : { missingSince }) })}\n`);
};
const getEntry = (s: Servers, host: string, b: string) => { try { return JSON.parse(readFileSync(entryPath(s, host, b), "utf8")); } catch { return undefined; } };
const hostFile = (s: Servers, host: string, ext: string, text: string) => writeFileSync(path.join(s.fake, `boxd-${host}.${ext}`), text);
const gcLog = (s: Servers) => { try { return readFileSync(path.join(s.home, ".local/state/boxd/gc.log"), "utf8").trim().split("\n").map((l) => l.split("\t")); } catch { return []; } };
const gc = (s: Servers, args: string[], now: number, env: Record<string, string> = {}) => runBox(args, { env: { BOXD_HOST: "", HOME: s.home, FAKE_HOSTS: s.fake, BOXD_NOW: String(now), ...env } });
const stops = (calls: string[]) => calls.filter((c) => c.includes(" pod drop ") || c.includes(" pod stop ")); // the calls that remove
const LINE = (b: string, st = "running") => `${b}\timg\t${st}\t1\tcontainer\n`;

test("every call that reaches a host records its box, host and worktree, in one file that is never left half written", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  assert.equal(go(rp, s, ["--no-sync", "true"], { BOXD_HOST: "test" }).code, 0);
  assert.deepEqual(getEntry(s, "test", rp.box), { box: rp.box, host: "test", worktree: rp.top });
  assert.deepEqual(readdirSync(path.join(s.home, ".local/state/boxd/boxes")), [`test.${rp.box}`]);
});

test("gc: a worktree seen missing once is not removed; seen again too soon, not removed; 15 minutes later, stopped and logged", () => {
  const s = servers([{ name: "test", status: FREE }]);
  hostFile(s, "test", "list", LINE("gone-1", "stopped")); putEntry(s, "test", "gone-1", NOWHERE);
  const first = gc(s, ["gc"], T0);
  assert.equal(first.code, 0);
  assert.match(first.out, /first sighting, nothing stopped/);
  assert.deepEqual(stops(first.calls), []);
  assert.equal(getEntry(s, "test", "gone-1").missingSince, T0);
  const soon = gc(s, ["gc"], T0 + 14 * MIN);
  assert.match(soon.out, /is missing since 14 minutes; a pass in 1 minute or later removes it\n/);
  assert.match(gc(s, ["gc", "--dry-run"], T0 + 6 * MIN).out, /is missing since 6 minutes; a pass in 9 minutes or later removes it\n/);
  assert.match(gc(s, ["gc", "--dry-run"], T0 + 6 * MIN + 30_000).out, /since 6 minutes; a pass in 9 minutes or later/); // minutes down for the past, up for the rest
  assert.deepEqual(stops(soon.calls), []);
  assert.equal(getEntry(s, "test", "gone-1").missingSince, T0); // the first sighting stays the first
  const late = gc(s, ["gc"], T0 + 15 * MIN);
  assert.deepEqual(stops(late.calls), ["ssh -o ConnectTimeout=3 -o BatchMode=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=2 boxd-test pod drop gone-1"]);
  assert.match(late.out, /removed test box gone-1 and its files: worktree .* is gone\n/);
  assert.equal(getEntry(s, "test", "gone-1"), undefined);
  assert.deepEqual(gcLog(s), [[new Date(T0 + 15 * MIN).toISOString(), "test", "gone-1", NOWHERE, "idle"]]);
});

test("gc: the size the server measured is relayed in both forms of the line; without it the line is as before", () => {
  const run = (out: string, quiet: boolean) => {
    const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
    hostFile(s, "test", "list", LINE("gone-1", "stopped")); putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN); hostFile(s, "test", "drop.out", out);
    return quiet ? go(rp, s, ["--no-sync", "true"], { BOXD_GC: "1", BOXD_NOW: String(T0), BOXD_HOST: "test" }).err : gc(s, ["gc"], T0).out;
  };
  const sized = "evicted gone-1 (worktree gone), 77 MB freed\n";
  assert.match(run(sized, false), /^box gc: removed test box gone-1 and its files, 77 MB freed: worktree .* is gone\n$/);
  assert.match(run(sized, true), /^\[box gc\] removed test box gone-1 and its files, 77 MB freed: worktree .* is gone\nbox: exit 0 on test\n$/);
  for (const bad of ["", "evicted gone-1 (worktree gone), 12a MB freed\n", "evicted gone-1 (worktree gone), 1234567890 MB freed\n", "evicted gone-1 (worktree gone), 5 MB freed!\n"])
    for (const q of [false, true]) assert.match(run(bad, q), new RegExp(`^(box gc: |\\[box gc\\] )removed test box gone-1 and its files: worktree .* is gone\\n${q ? "box: exit 0 on test\\n" : ""}$`), JSON.stringify(bad));
});

test("gc --dry-run says what it would do and changes nothing, not even a first sighting", () => {
  const s = servers([{ name: "test", status: FREE }]);
  hostFile(s, "test", "list", LINE("gone-1", "stopped") + LINE("gone-2", "stopped")); putEntry(s, "test", "gone-1", NOWHERE); putEntry(s, "test", "gone-2", NOWHERE, T0 - 20 * MIN);
  const r = gc(s, ["gc", "--dry-run"], T0);
  assert.match(r.out, /would remove test box gone-2 and its files/);
  assert.deepEqual(stops(r.calls), []);
  assert.equal(getEntry(s, "test", "gone-1").missingSince, undefined);
  assert.equal(getEntry(s, "test", "gone-2").missingSince, T0 - 20 * MIN);
  assert.deepEqual(gcLog(s), []);
});

test("gc: a run still going in the box does not save it (and the log says so); a worktree that is still here is left alone", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE("gone-1") + LINE(rp.box)); hostFile(s, "test", "ps.gone-1", "7\t100\t0\t/job/src\tsleep 99\n");
  putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN); putEntry(s, "test", rp.box, rp.top, T0 - 20 * MIN);
  const r = gc(s, ["gc"], T0);
  assert.equal(stops(r.calls).length, 1);
  assert.match(r.out, /removed test box gone-1 and its files: .* \(a run was still going\)/);
  assert.equal(gcLog(s)[0]?.[4], "run live");
  assert.equal(getEntry(s, "test", rp.box).missingSince, undefined); // it is back: the mark is cleared
});

test("gc: a server of 0.4.50 or later is asked `pod drop <box> idle`; when it keeps the box (exit 75) the record stays and the line says so; an older server gets the plain drop", () => {
  const NEW = FREE.replace(/version=[^\t]+/, "version=0.4.50"), dropCalls = (calls: string[]) => calls.filter((c) => c.includes(" pod drop ")).map((c) => c.replace(/^.* boxd-test /, ""));
  const make = (status: string) => { const s = servers([{ name: "test", status }]); hostFile(s, "test", "list", LINE("gone-1")); putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN); return s; };
  const kept = make(NEW); hostFile(kept, "test", "drop.exit", "75\n");
  const a = gc(kept, ["gc"], T0), line = `test box gone-1: worktree ${NOWHERE} is gone but a run is still going in it; kept until it ends`;
  assert.deepEqual(dropCalls(a.calls), ["pod drop gone-1 idle"]);
  assert.equal(a.out, `box gc: ${line}\n`);
  assert.equal(stops(a.calls).length, 1); // no fall back to pod stop
  assert.equal(getEntry(kept, "test", "gone-1").missingSince, T0 - 20 * MIN);
  assert.deepEqual(gcLog(kept), []);
  const q = go(newRepo(), kept, ["--no-sync", "true"], { BOXD_GC: "1", BOXD_NOW: String(T0), BOXD_HOST: "test" });
  assert.equal(q.out, ""); assert.ok(q.err.includes(`[box gc] ${line}\n`), q.err);
  const done = make(NEW), b = gc(done, ["gc"], T0);   // the server removes it: as before
  assert.deepEqual(dropCalls(b.calls), ["pod drop gone-1 idle"]);
  assert.match(b.out, /removed test box gone-1 and its files/);
  assert.equal(getEntry(done, "test", "gone-1"), undefined);
  assert.deepEqual(dropCalls(gc(make(FREE), ["gc"], T0).calls), ["pod drop gone-1"]);   // 0.4.40: the plain order
});

test("register: a box shared with --pod keeps the worktree that made it while that one is here, and goes to the next caller when it is gone", () => {
  const s = servers([{ name: "test", status: FREE }]), a = newRepo(), b = newRepo(), env = { HOME: s.home };
  register(env, "test", "shared", a.top);
  register(env, "test", "shared", b.top);
  assert.deepEqual(getEntry(s, "test", "shared"), { box: "shared", host: "test", worktree: a.top });
  putEntry(s, "test", "shared", a.top, T0);
  register(env, "test", "shared", b.top);
  assert.equal(getEntry(s, "test", "shared").missingSince, T0);   // another worktree does not clear the mark
  register(env, "test", "shared", a.top);
  assert.deepEqual(getEntry(s, "test", "shared"), { box: "shared", host: "test", worktree: a.top });   // its own worktree does
  putEntry(s, "test", "shared", NOWHERE);
  register(env, "test", "shared", b.top);
  assert.deepEqual(getEntry(s, "test", "shared"), { box: "shared", host: "test", worktree: b.top });
});

test("gc: a folder that is not a git worktree top folder counts as missing", () => {
  const s = servers([{ name: "test", status: FREE }]), plain = path.join(root, "plain-folder");
  mkdirSync(plain, { recursive: true });
  hostFile(s, "test", "list", LINE("gone-1", "stopped")); putEntry(s, "test", "gone-1", plain, T0 - 20 * MIN);
  assert.equal(stops(gc(s, ["gc"], T0).calls).length, 1);
});

test("gc: a box on the host with no record is 'unknown owner', listed with the command that stops it, never stopped", () => {
  const s = servers([{ name: "test", status: FREE }]);
  hostFile(s, "test", "list", LINE("stranger", "stopped"));
  const r = gc(s, ["gc"], T0);
  assert.match(r.out, /box stranger: unknown owner .*to stop it: ssh boxd-test pod stop stranger\n/);
  assert.deepEqual(stops(r.calls), []);
});

// The box of an idle worktree is reaped after 30 minutes, its folder stays on the host: the record must outlive the box, or
// the folder of a worktree deleted later would wait for the 14-day rule.
test("gc: a record outlives its box: the worktree here keeps it, the worktree gone drops the folder; a host that is not asked keeps its records", () => {
  const s = servers([{ name: "test", status: FREE }, { name: "down" }]), rp = newRepo();
  hostFile(s, "test", "list", ""); putEntry(s, "test", "vanished", NOWHERE, T0 - 20 * MIN); putEntry(s, "test", rp.box, rp.top); putEntry(s, "down", "kept", NOWHERE, T0 - 20 * MIN);
  const r = gc(s, ["gc"], T0);
  assert.deepEqual(stops(r.calls).map((c) => c.replace(/^.* pod /, "")), ["drop vanished"]);
  assert.equal(getEntry(s, "test", "vanished"), undefined);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
  assert.notEqual(getEntry(s, "down", "kept"), undefined);
  assert.match(r.out, /down is unreachable \(skipped\)/);
});

test("gc: a server older than 0.4.0 has no pod drop: the box is stopped as before, its folder waits for that server's upgrade", () => {
  const s = servers([{ name: "test", status: FREE }]);
  hostFile(s, "test", "list", LINE("gone-1", "stopped")); hostFile(s, "test", "drop.exit", "125"); putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN);
  const r = gc(s, ["gc"], T0);
  assert.deepEqual(stops(r.calls).map((c) => c.replace(/^.* pod /, "")), ["drop gone-1", "stop gone-1"]);
  assert.match(r.out, /stopped test box gone-1 \(this server cannot remove its files yet\): worktree .* is gone\n/);
  assert.equal(getEntry(s, "test", "gone-1"), undefined);
  hostFile(s, "test", "stop.exit", "1"); putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN);
  const bad = gc(s, ["gc"], T0);
  assert.match(bad.out, /box gc: test: removing gone-1 failed; kept\n/);
  assert.notEqual(getEntry(s, "test", "gone-1"), undefined);
});

test("gc: a sleeping host is never contacted and is named", async () => {
  const s = servers([{ name: "sleepy" }, { name: "test", status: FREE }], { wake: { sleepy: `127.0.0.1:${await closedPort()}` } });
  hostFile(s, "test", "list", ""); putEntry(s, "sleepy", "box-a", NOWHERE, T0 - 20 * MIN);
  const r = gc(s, ["gc"], T0);
  assert.equal(r.calls.filter((c) => c.includes("boxd-sleepy")).length, 0);
  assert.match(r.out, /sleepy is asleep \(not woken, not asked\)/);
  assert.notEqual(getEntry(s, "sleepy", "box-a"), undefined);
});

test("gc reports commands running longer than 6 hours (it never ends them) and says nothing of shorter ones", () => {
  const s = servers([{ name: "test", status: FREE }]);
  hostFile(s, "test", "list", LINE("busy-1")); putEntry(s, "test", "busy-1", repo);
  hostFile(s, "test", "ps.busy-1", "9\t25000\t5\t/job/src\tcargo test\n10\t21599\t0\t/job/src\tshort\n");
  const r = gc(s, ["gc"], T0);
  assert.match(r.out, /box gc: test box busy-1: running 6h56m in \/job\/src: cargo test\n/);
  assert.doesNotMatch(r.out, /short/);
  assert.deepEqual(stops(r.calls), []);
});

test("gc: bad words are a usage error", () => assert.equal(runBox(["gc", "--now"]).code, 2));

test("an ordinary call runs the collector after itself, quietly, once per 15 minutes; exit code and stdout untouched", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE("gone-1", "stopped")); putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN); hostFile(s, "test", "run.exit", "3\n");
  const env = (t: number) => ({ BOXD_GC: "1", BOXD_NOW: String(t), BOXD_HOST: "test" });
  const a = go(rp, s, ["--no-sync", "true"], env(T0));
  assert.equal(a.code, 3);
  assert.equal(a.out, "");
  assert.match(a.err, /^\[box gc\] removed test box gone-1 and its files: worktree .* is gone\nbox: exit 3 on test\n$/);
  assert.equal(a.calls.filter((c) => c.endsWith(" pod list")).length, 1);
  assert.ok(a.calls[0]?.startsWith("ssh boxd-test pod run "), "the call comes first"); // the collector runs after it
  const b = go(rp, s, ["--no-sync", "true"], env(T0 + 14 * MIN));
  assert.equal(b.calls.filter((c) => c.endsWith(" pod list") || c.endsWith(" pod status")).length, 0);
  const c = go(rp, s, ["--no-sync", "true"], env(T0 + 15 * MIN));
  assert.equal(c.calls.filter((x) => x.endsWith(" pod list")).length, 1);
});

test("the collector after a call is off with BOXD_GC=0 and never runs for ps, hosts, log or gc itself, nor after a call that did not reach its host", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", ""); hostFile(s, "test", "run.exit", "0\n");
  const lists = (r: { calls: string[] }) => r.calls.filter((c) => c.endsWith(" pod list")).length;
  assert.equal(lists(go(rp, s, ["--no-sync", "true"], { BOXD_GC: "0", BOXD_HOST: "test" })), 0);
  for (const a of [["ps"], ["hosts"], ["runs"], ["log", "r-1"]]) assert.equal(lists(go(rp, s, a, { BOXD_GC: "1", BOXD_HOST: "test", FAKE_LOGDIR: s.fake })), 0, a.join(" "));
  assert.equal(lists(go(rp, s, ["gc"], { BOXD_GC: "1" })), 1); // its own pass only, not a second one
  const down = go(rp, servers([{ name: "test" }]), ["--no-sync", "true"], { BOXD_GC: "1", BOXD_HOST: "test", FAKE_SSH_EXIT: "255" });
  assert.equal(down.code, 255);
  assert.deepEqual(down.calls.filter((c) => c.includes("pod list") || c.includes("pod status")), []);
});

// Defect report 2026-11-14: rsync's "cannot delete non-empty directory" (exit 0) was read as "not started" and a paid
// run was relaunched four times. The client now says in its own words that the sync succeeded and what stayed.
test("a folder deleted here that holds ignored files on the server: the sync says it succeeded, the run starts", () => {
  const r2 = path.join(root, "kept-repo"), remote = path.join(root, "kept-remote");
  mkdirSync(path.join(r2, "gone"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: r2 });
  writeFileSync(path.join(r2, ".gitignore"), "*.log\n");
  writeFileSync(path.join(r2, "gone", "kept.txt"), "x");
  const b2 = plan(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: r2, encoding: "utf8" }).trim(), [], ["x"]).box;
  assert.equal(runBox(["true"], { cwd: r2, env: { FAKE_REMOTE: remote } }).code, 0);
  writeFileSync(path.join(remote, "jobs", b2, "src", "gone", "build.log"), "made in the box");
  rmSync(path.join(r2, "gone"), { recursive: true });
  const r = runBox(["--detach", "true"], { cwd: r2, env: { FAKE_REMOTE: remote } });
  assert.equal(r.code, 0);
  assert.match(r.out, /^run \d{8}-\d{6}-[0-9a-f]{4}\n/);
  assert.doesNotMatch(r.out + r.err, /cannot delete/);
  assert.equal(r.err, "box: sync complete; 1 folder deleted here stays on the server because it holds files git ignores: gone\n");
  assert.equal(r.calls.filter((c) => c.startsWith("ssh ")).length, 1);
  assert.ok(existsSync(path.join(remote, "jobs", b2, "src", "gone", "build.log")));
  assert.ok(!existsSync(path.join(remote, "jobs", b2, "src", "gone", "kept.txt")));
});

test("a sync that fails starts nothing and says so in one line", () => {
  const r = runBox(["--detach", "true"], { env: { FAKE_REMOTE: "/dev/null/not-a-folder" } });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /box: sync failed \(rsync exit \d+\); nothing was started\n$/);
  assert.doesNotMatch(r.out, /^run /m);
  assert.equal(r.calls.filter((c) => c.startsWith("ssh ")).length, 0);
});

// Feedback of another project's session, 2026-11-14: its run journal was a file git ignores (*.log), so a run continued in a
// fresh box started from nothing; and ignored files of an earlier run sat in the folder of the next measurement.
function ignoringRepo(name: string) {
  const r = path.join(root, name), remote = path.join(root, `${name}-remote`);
  mkdirSync(path.join(r, "sub"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: r });
  writeFileSync(path.join(r, ".gitignore"), "*.log\ncache/\n");
  for (const f of ["a.txt", "run.log", "other.log", "sub/j.log", "sub/k.txt"]) writeFileSync(path.join(r, f), f);
  const b = plan(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: r, encoding: "utf8" }).trim(), [], ["x"]).box;
  return { r, src: path.join(remote, "jobs", b, "src"), env: { FAKE_REMOTE: remote } };
}
const tree = (d: string) => (readdirSync(d, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]).filter((e) => e.isFile()).map((e) => path.relative(d, path.join(e.parentPath, e.name))).sort();

test("--include sends the named ignored files and folders, and nothing else that git ignores", () => {
  const { r, src, env } = ignoringRepo("inc-repo");
  mkdirSync(path.join(r, "cache", "deep"), { recursive: true });
  writeFileSync(path.join(r, "cache", "deep", "x.bin"), "x"); writeFileSync(path.join(r, "cache", "y.log"), "y");
  assert.equal(runBox(["true"], { cwd: r, env }).code, 0);
  assert.deepEqual(tree(src), [".gitignore", "a.txt", "sub/k.txt"]);
  assert.equal(runBox(["--include", "run.log", "--include", "sub/", "--include", "cache/deep", "true"], { cwd: r, env }).code, 0);
  assert.deepEqual(tree(src), [".gitignore", "a.txt", "cache/deep/x.bin", "run.log", "sub/j.log", "sub/k.txt"]);
});

test("--include refuses a path outside the worktree, a missing one, and --no-sync", () => {
  const { r, env } = ignoringRepo("inc-bad");
  for (const [args, text] of [
    [["--include", "../x", "true"], "box: --include ../x: not a path inside this worktree\n"],
    [["--include", "/etc/passwd", "true"], "box: --include /etc/passwd: not a path inside this worktree\n"],
    [["--include", ".git/config", "true"], "box: --include .git/config: not a path inside this worktree\n"],
    [["--include", "nope.log", "true"], "box: --include nope.log: no such file or folder in this worktree\n"],
    [["--no-sync", "--include", "run.log", "true"], "box: --include and --clean need the sync; drop --no-sync\n"],
    [["--no-sync", "--clean", "true"], "box: --include and --clean need the sync; drop --no-sync\n"],
  ] as const) {
    const x = runBox([...args], { cwd: r, env });
    assert.equal(x.code, 2, args.join(" ")); assert.ok(x.err.startsWith(text), x.err); assert.deepEqual(x.calls, []);
  }
});

test("--clean makes the box's source tree exactly the worktree: ignored leftovers go, --include files stay", () => {
  const { r, src, env } = ignoringRepo("clean-repo");
  assert.equal(runBox(["true"], { cwd: r, env }).code, 0);
  mkdirSync(path.join(src, "results")); writeFileSync(path.join(src, "results", "old.log"), "earlier run"); writeFileSync(path.join(src, "stale.log"), "s");
  assert.equal(runBox(["true"], { cwd: r, env }).code, 0);
  assert.ok(existsSync(path.join(src, "results", "old.log")), "without --clean ignored files in the box stay");
  const x = runBox(["--clean", "--include", "run.log", "true"], { cwd: r, env });
  assert.equal(x.code, 0);
  assert.match(x.calls[0] ?? "", /^rsync -a --delete --delete-excluded --mkpath /);
  assert.deepEqual(tree(src), [".gitignore", "a.txt", "run.log", "sub/k.txt"]);
});

test("box log --follow on a run that ended without an exit code (its box or host went down): says so, exit 129", () => {
  const dir = mkdtempSync(path.join(root, "lost-"));
  writeFileSync(path.join(dir, "1"), "log\tsize=5\tfrom=0\tnext=5\tstate=ended\texit=-\nhalf\n");
  const x = runBox(["log", "run-1", "--follow"], { env: { FAKE_LOGDIR: dir, BOXD_LOG_POLL_MS: "1" } });
  assert.equal(x.code, 129);
  assert.equal(x.out, "half\n");
  assert.equal(x.err, "box log: run run-1 ended without an exit code: its box or the build server went down under it\nbox: run run-1 exit 129 on test\n");
});
// box forward / box vnc: the client is a long-running process, so these run it with spawn and wait on its output and its
// exit, never on a clock. PATH is the fakes plus basics only (no real xdg-open, no git: the box is named with --pod); the fake ssh relays with cat.
const xdgBin = path.join(root, "xdg");
mkdirSync(xdgBin);
function startClient(args: string[], env: Record<string, string>, withXdg = false) {
  const child = spawn(process.execPath, [TOOL, ...args], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${bin}:${withXdg ? xdgBin + ":" : ""}${basics}`, HOME: home, BOXD_HOST: "test", BOXD_GC: "0", CALLS: log, ...env },
  });
  let out = "", err = "";
  const waiters: Array<() => void> = [];
  child.stdout.on("data", (d: Buffer) => { out += d; waiters.splice(0).forEach((w) => w()); });
  child.stderr.on("data", (d: Buffer) => { err += d; waiters.splice(0).forEach((w) => w()); });
  let closed = false;
  const until = async (re: RegExp, pick: () => string = () => out) => {
    while (!re.test(pick())) { if (closed) assert.fail(`the client ended before ${re}: out=${out} err=${err}`); await new Promise<void>((r) => waiters.push(r)); }
    return pick().match(re) as RegExpMatchArray;
  };
  const exit = new Promise<number | null>((res) => child.on("close", (c: number | null) => { closed = true; waiters.splice(0).forEach((w) => w()); res(c); }));
  return { child, until, exit, out: () => out, err: () => err };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function viaPort(port: number, text: string) {
  const s = net.connect(port, "127.0.0.1");
  await once(s, "connect");
  s.write(text);
  const [d] = await once(s, "data");
  return { s, got: String(d) };
}

test("box forward listens on 127.0.0.1, one ssh per connection relays both ways, SIGTERM ends the channel and the listener", async () => {
  rmSync(log, { force: true });
  const dir = mkdtempSync(path.join(root, "fwd-"));
  const c = startClient(["forward", "--pod", "pbox", "0", "5900"], { FAKE_FWD_DIR: dir });
  const m = await c.until(/^forwarding 127\.0\.0\.1:(\d+) -> box (\S+) port 5900 \(Ctrl\+C stops\)\n/);
  assert.equal(m[2], "pbox");
  const port = Number(m[1]);
  const a = await viaPort(port, "hello");
  const b = await viaPort(port, "again");
  assert.deepEqual([a.got, b.got], ["hello", "again"]);
  const pids = readdirSync(dir).map((f) => Number(f.replace("pid.", "")));
  assert.equal(pids.length, 2);
  c.child.kill("SIGTERM");
  assert.equal(await c.exit, 0);
  for (const p of pids) assert.equal(alive(p), false, "a relay ssh outlived the client");
  a.s.destroy(); b.s.destroy();
  await assert.rejects(async () => { const s = net.connect(port, "127.0.0.1"); await once(s, "connect"); }, "the listener is closed");
  const calls = readFileSync(log, "utf8").trim().split("\n").filter((l) => l.startsWith("ssh"));
  assert.deepEqual(calls, [`ssh boxd-test pod forward pbox 5900`, `ssh boxd-test pod forward pbox 5900`]);
  assert.equal(calls.some((l) => /\s-L\s/.test(l)), false);
});

test("box forward --pod names the box, a closed connection ends its ssh, the server's refusal is shown", async () => {
  rmSync(log, { force: true });
  const dir = mkdtempSync(path.join(root, "fwd-"));
  const c = startClient(["forward", "--pod", "other-box", "0", "8080"], { FAKE_FWD_DIR: dir });
  const port = Number((await c.until(/forwarding 127\.0\.0\.1:(\d+) -> box other-box port 8080/))[1]);
  const a = await viaPort(port, "x");
  const pid = Number(readdirSync(dir)[0]?.replace("pid.", ""));
  a.s.destroy();
  while (alive(pid)) await new Promise((r) => setImmediate(r));
  c.child.kill("SIGINT");
  assert.equal(await c.exit, 0);
  const d2 = mkdtempSync(path.join(root, "fwd-"));
  const e = startClient(["forward", "--pod", "pbox", "0", "8080"], { FAKE_FWD_DIR: d2, FAKE_FWD_ERR: "boxd-pod: box x is not running" });
  const p2 = Number((await e.until(/forwarding 127\.0\.0\.1:(\d+)/))[1]);
  const s = net.connect(p2, "127.0.0.1"); s.on("error", () => {}); await once(s, "close");
  await e.until(/boxd-pod: box x is not running\n/, e.err);
  e.child.kill("SIGTERM");
  await e.exit;
});

test("box forward against a server older than 0.4.0 says so", async () => {
  const dir = mkdtempSync(path.join(root, "fwd-"));
  const c = startClient(["forward", "--pod", "pbox", "0", "5900"], { FAKE_FWD_DIR: dir, FAKE_FWD_ERR: "boxd-pod: unknown command" });
  const port = Number((await c.until(/forwarding 127\.0\.0\.1:(\d+)/))[1]);
  const s = net.connect(port, "127.0.0.1"); s.on("error", () => {}); await once(s, "close");
  await c.until(/older than 0\.4\.0, forward needs an upgrade\n/, c.err);
  assert.doesNotMatch(c.err(), /unknown command/);
  c.child.kill("SIGTERM");
  await c.exit;
});

test("box forward usage errors exit 2 and run no ssh", () => {
  for (const args of [["forward"], ["forward", "1"], ["forward", "1", "0"], ["forward", "1", "70000"], ["forward", "70000", "5900"], ["forward", "a", "5900"], ["forward", "1", "2", "3"], ["forward", "--bogus", "1", "2"], ["vnc", "--port", "0"], ["vnc", "--port", "x"], ["vnc", "5900"]].map((a) => [...a, "--pod", "pbox"])) {
    const r = runBox(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(r.calls, [], args.join(" "));
  }
});

test("box vnc forwards box port 5900 on a free local port and opens vnc://127.0.0.1:<port>; --port changes the box port", async () => {
  writeFileSync(path.join(xdgBin, "xdg-open"), "#!/bin/sh\necho \"xdg-open $*\" >> \"$CALLS\"\n");
  chmodSync(path.join(xdgBin, "xdg-open"), 0o755);
  rmSync(log, { force: true });
  const dir = mkdtempSync(path.join(root, "fwd-"));
  const c = startClient(["vnc", "--pod", "pbox", "--port", "5901"], { FAKE_FWD_DIR: dir }, true);
  const m = await c.until(/forwarding 127\.0\.0\.1:(\d+) -> box \S+ port 5901/);
  while (!existsSync(log) || !readFileSync(log, "utf8").includes("xdg-open")) await new Promise((r) => setTimeout(r, 5));
  assert.match(readFileSync(log, "utf8"), new RegExp(`^xdg-open vnc://127\\.0\\.0\\.1:${m[1]}$`, "m"));
  c.child.kill("SIGTERM");
  assert.equal(await c.exit, 0);
  assert.equal(c.out().includes("xdg-open not found"), false);
});

test("box vnc without xdg-open prints the address instead", async () => {
  const dir = mkdtempSync(path.join(root, "fwd-"));
  const c = startClient(["vnc", "--pod", "pbox"], { FAKE_FWD_DIR: dir }, false);
  const m = await c.until(/forwarding 127\.0\.0\.1:(\d+) -> box \S+ port 5900/);
  await c.until(new RegExp(`xdg-open not found; open a VNC viewer at 127\\.0\\.0\\.1:${m[1]}\\n`));
  c.child.kill("SIGTERM");
  assert.equal(await c.exit, 0);
});

test.after(() => rmSync(root, { recursive: true, force: true }));

// Nothing of boxd stays running on the workstation by itself: a forwarder whose starter died (an agent killed) ends too.
// The starter leaves only after the forwarder said it listens; the test then waits for the forwarder's stderr to close.
test("box forward ends when the process that started it is gone: the message, the listener closed", { timeout: 30_000 }, async (t) => {
  const { readFile } = await import("node:fs/promises");
  const dir = mkdtempSync(path.join(root, "fwd-orphan-")), errFifo = path.join(dir, "err"), outFifo = path.join(dir, "out");
  execFileSync("mkfifo", [errFifo, outFifo]);
  const err = readFile(errFifo, "utf8");
  const st = spawnSync("sh", ["-c", `"$0" "$1" forward --pod x 0 80 >"$3" 2>"$2" & echo $!; read -r line <"$3"; echo "$line"`, process.execPath, TOOL, errFifo, outFifo],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: `${bin}:${basics}`, HOME: home, BOXD_HOST: "test", BOXD_GC: "0", CALLS: log, BOXD_ORPHAN_CHECK_MS: "1" } });
  const [pid = "", line = ""] = st.stdout.split("\n");
  const end = () => { try { process.kill(Number(pid)); } catch { /* it ended, as it should */ } };
  t.signal.addEventListener("abort", end); // a forwarder that stayed would keep this test file from ending
  const port = Number(/^forwarding 127\.0\.0\.1:(\d+) /.exec(line)?.[1]);
  try {
    assert.ok(port > 0, st.stdout);
    assert.equal(await err, "box forward: the process that started it is gone; forwarding ended\n");
    const s = net.connect(port, "127.0.0.1");
    const [e] = await once(s, "error");
    assert.equal((e as NodeJS.ErrnoException).code, "ECONNREFUSED");
  } finally { end(); }
});

// ---- 0.4.10: closed pipes, options after the command, pulls of nothing, box runs, --wait --------------------------------------

test("a closed output pipe ends the program quietly: exit 0, nothing on stderr (box hosts | head -1)", async () => {
  const s = servers([{ name: "a", status: FREE }]), hold = path.join(root, `epipe-hold-${++repoN}`);
  execFileSync("mkfifo", [hold]);
  const child = spawn(process.execPath, [TOOL, "hosts"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: s.home, BOXD_GC: "0", CALLS: log, FAKE_HOSTS: s.fake, FAKE_STATUS_HOLD: hold } });
  let err = "";
  child.stderr.on("data", (d: Buffer) => { err += d; });
  child.stdout.destroy(); // the reader is gone before the fake ssh lets the probe finish, so the one line printed meets a closed pipe
  writeFileSync(hold, "go\n");
  const [code] = await once(child, "close");
  assert.equal(err, "");
  assert.equal(code, 0);
});

test("a box option after the command, with no --, is handed to the command: one warning, the call goes on as before", () => {
  const r = runBox(["--no-sync", "sh", "-c", "make", "--pull", "dist/x"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "box: --pull after the command is handed to the command, not to box; put box options before the command (or write -- before the command to silence this)\nbox: exit 0 on test\n");
  assert.deepEqual(r.calls, [`ssh boxd-test pod run ${box} -- ${b64("sh", "-c", "make", "--pull", "dist/x")}`]);
  for (const o of ["--include", "--env", "--detach", "--host", "--pod", "--no-sync"]) assert.match(runBox(["--no-sync", "true", o]).err, new RegExp(`^box: ${o} after the command`), o);
  assert.equal(runBox(["--no-sync", "--", "sh", "-c", "make", "--pull", "dist/x"]).err, "box: exit 0 on test\n", "an explicit -- silences it");
  assert.equal(runBox(["--no-sync", "cargo", "--version"]).err, "box: exit 0 on test\n", "only box's own options are named");
});

test("--pull of a path that is not in the box says so in one line; any other rsync failure keeps its words", () => {
  const remote = path.join(root, "remote-empty");
  mkdirSync(path.join(remote, "jobs", box, "src"), { recursive: true });
  const r = runBox(["--no-sync", "--pull", "dist/x", "true"], { env: { FAKE_REMOTE: remote } });
  assert.equal(r.err, "box: nothing at dist/x in the box, nothing pulled\nbox: exit 23 on test\n");
  assert.equal(r.code, 23, "the exit code is rsync's, as before");
  mkdirSync(path.join(remote, "jobs", box, "src", "dist")); // the folder is there, the file is not: rsync words it with link_stat, not change_dir
  assert.equal(runBox(["--no-sync", "--pull", "dist/x", "true"], { env: { FAKE_REMOTE: remote } }).err, "box: nothing at dist/x in the box, nothing pulled\nbox: exit 23 on test\n");
  const other = runBox(["--no-sync", "--pull", "dist/x", "true"], { env: { FAKE_RSYNC_ERR: "rsync: connection unexpectedly closed" } });
  assert.equal(other.err, "rsync: connection unexpectedly closed\nbox: pull dist/x failed\nbox: exit 12 on test\n");
  assert.equal(other.code, 12);
});

test("--help names box runs and --wait", () => {
  const out = runBox(["--help"]).out;
  assert.match(out, /box runs /);
  assert.match(out, /--wait /);
});

test("runAge reads the run id as this machine's local time; lastLine keeps one clean line of at most 120 characters", () => {
  const at = (h: number, m: number, s: number) => new Date(2026, 10, 16, h, m, s).getTime();
  assert.equal(runAge("20261116-093000-abcd", at(9, 45, 0)), "15m00s");
  assert.equal(runAge("20261116-093000-abcd", at(11, 31, 5)), "2h01m");
  assert.equal(runAge("20261116-093000-abcd", at(9, 29, 0)), "0s", "a clock a little behind is never negative");
  assert.equal(runAge("hand-made", at(9, 45, 0)), "-");
  assert.equal(lastLine("a\nb\n\n  \n"), "b");
  assert.equal(lastLine("10%\r50%\r100%\n"), "100%");
  assert.equal(lastLine("x\ty\x1b[31m\x07z\u0000\n"), "x y[31mz", "tabs become spaces, control characters go");
  assert.equal(lastLine(""), "-");
  assert.equal(lastLine("\n\n"), "-");
  assert.equal(lastLine("é".repeat(300)).length, 120);
});

test("box runs: one tab separated line per running detached run of this machine's boxes; ended runs and foreign boxes are left out", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]);
  const id = "20261116-093000-abcd", NOW = new Date(2026, 10, 16, 9, 45, 0).getTime();
  putEntry(s, "tower", "w-1", "/home/me/w1"); putEntry(s, "tower", "w-2", "/home/me/w2"); putEntry(s, "laptop", "w-3", "/home/me/w3");
  hostFile(s, "tower", "report", [
    "host\tversion=0.4.0\tengines=container",
    "box\tbox=w-1\tengine=container\tstate=running\truns=1",
    `run\tbox=w-1\tid=${id}\tstate=running\texit=-\tbytes=5000\tchanged=1`,
    "run\tbox=w-1\tid=20261116-080000-1111\tstate=ended\texit=0\tbytes=10\tchanged=1",
    "run\tbox=w-2\tid=20261116-094000-0001\tstate=running\texit=-\tbytes=100\tchanged=1",
    "run\tbox=stranger\tid=20261116-094000-0002\tstate=running\texit=-\tbytes=100\tchanged=1",
    "",
  ].join("\n"));
  hostFile(s, "tower", `log.${id}`, `${head(5000, 2952, 5000, "running")}half a li\nstep 2\t\x1b[31mred\x1b[0m\n\n`);
  hostFile(s, "tower", "log.20261116-094000-0001", head(100, 0, 100, "running"));
  hostFile(s, "laptop", "report", "run\tbox=w-3\tid=20261116-091500-0003\tstate=running\texit=-\tbytes=9\tchanged=1\n");
  hostFile(s, "laptop", "log.20261116-091500-0003", `${head(9, 0, 9, "running")}${"x".repeat(300)}\n`);
  const r = go(newRepo(), s, ["runs"], { BOXD_NOW: String(NOW) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trimEnd().split("\n"), [
    `tower\tw-1\t${id}\t15m00s\t/home/me/w1\tstep 2 [31mred[0m`,
    "tower\tw-2\t20261116-094000-0001\t5m00s\t/home/me/w2\t-",
    `laptop\tw-3\t20261116-091500-0003\t30m00s\t/home/me/w3\t${"x".repeat(120)}`,
  ]);
  const ask = "ssh -o ConnectTimeout=3 -o BatchMode=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=2";
  assert.ok(r.calls.includes(`${ask} boxd-tower pod log w-1 ${id} 2952`), "the log is read from bytes minus 2048");
  assert.ok(r.calls.includes(`${ask} boxd-tower pod log w-2 20261116-094000-0001 0`), "never below 0");
  assert.ok(!r.calls.some((c) => c.includes("stranger") || c.includes("20261116-080000-1111")), "no log is read for a run that is not listed");
  assert.deepEqual(r.calls.filter((c) => !c.includes(" pod ")), []);
});

test("box runs with nothing running says so, exit 0; a sleeping host is named and never contacted; an unreachable one is named", async () => {
  const s = servers([{ name: "tower" }, { name: "laptop", status: FREE }, { name: "third" }], { wake: { tower: `127.0.0.1:${await closedPort()}` } });
  hostFile(s, "laptop", "report", "host\tversion=0.4.0\n");
  const r = go(newRepo(), s, ["runs"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "no detached run is running\nbox runs: tower is asleep (not woken, not asked)\nbox runs: third is unreachable (skipped)\n");
  assert.ok(!r.calls.some((c) => c.includes("boxd-tower")), "a status ssh would have woken the sleeping host");
  assert.equal(go(newRepo(), s, ["runs", "now"]).code, 2);
  assert.equal(go(newRepo(), { ...s, home: mkdtempSync(path.join(root, "bare-")) }, ["runs"]).code, 2, "no build server set up");
});

// --wait: BOXD_WAIT_MS makes the interval short; nothing depends on it, the fake hosts change their answer by probe number.
const TIGHT = realStatus(1, 100);
const waits = (rp: Repo, s: Servers, args: string[]) => go(rp, s, ["--wait", ...args], { BOXD_WAIT_MS: "1" });

test("--wait: no host has room, so it says so once with the reasons, says again only when they change, and goes on when room appears", () => {
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop", status: FULL }]), rp = newRepo();
  hostFile(s, "tower", "status.2", `${TIGHT}\n`); hostFile(s, "tower", "status.3", `${FREE}\n`);
  const r = waits(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "box: waiting for room, asking every 0.001 seconds:\n  tower: 3 of 3 running\n  laptop: 3 of 3 running\n"
    + "box: the reasons changed: tower: 0 MB in use + 8192 MB asked > 100 MB cap; laptop: 3 of 3 running\nbox: exit 0 on tower\n");
  assert.equal(probes(r.calls).length, 6, "every host is asked again on each round");
  assert.deepEqual(rest(r.calls), [sync(rp, "tower"), runLine(rp, "tower", "--vm")], "nothing was synced or run while waiting");
  assert.equal(rp.placed(), "tower\n");
  assert.equal(choices(s).length, 1);
});

test("--wait: a placed worktree whose host refuses at the call and cannot be asked what it holds waits for that host, is not moved, then runs there", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]), rp = newRepo();
  writeFileSync(path.join(rp.cwd, ".git/boxd-host"), "tower\n");
  hostFile(s, "tower", "run.refuse", "1\n");
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "boxd-pod: no room for another virtual machine (3 of 3 running); wait for one to end or stop one\n"
    + "box: waiting for room, asking every 0.001 seconds:\n  tower: no room (the server refused the call)\nbox: exit 0 on tower\n");
  assert.equal(r.calls.filter((c) => c === runLine(rp, "tower", "--vm")).length, 2);
  assert.ok(!r.calls.some((c) => c.includes("boxd-laptop") && !c.endsWith(" pod status")), "the other host is only asked its status, nothing is synced or run there");
  assert.equal(rp.placed(), "tower\n");
});

test("--wait: the lost race with no host left (a placement this call made is dropped) waits and chooses again", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FULL }]), rp = newRepo();
  hostFile(s, "tower", "run.refuse", "1\n");
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.calls.filter((c) => c === runLine(rp, "tower", "--vm")).length, 2);
  assert.match(r.err, /box: waiting for room, asking every 0\.001 seconds:\n  tower: no room \(the server refused the call\)\nbox: exit 0 on tower\n$/);
  assert.deepEqual(choices(s).map((l) => [l[3], l[4]]), [["tower", "order"], ["tower", "order"]]);
  assert.equal(rp.placed(), "tower\n");
});

test("--wait never waits for what time cannot fix: a missing image everywhere, or no host reachable, exits 75 at once as without it", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = waits(rp, s, ["--image", "localhost/nothere", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.equal(r.err, "box: no build server has room for this call\n  tower: image nothere missing\n  laptop: image nothere missing\n");
  assert.equal(probes(r.calls).length, 2);
  const down = servers([{ name: "tower" }, { name: "laptop" }]);
  const d = waits(newRepo(), down, ["true"]);
  assert.equal(d.code, NO_ROOM);
  assert.equal(d.err, "box: no build server has room for this call\n  tower: unreachable\n  laptop: unreachable\n");
});

test("without --wait nothing changes: no room is still exit 75 at once, and --wait is a box option like the others (warned when late)", () => {
  const s = servers([{ name: "tower", status: FULL }, { name: "laptop", status: FULL }]);
  const r = go(newRepo(), s, ["--vm", "true"], { BOXD_WAIT_MS: "1" });
  assert.equal(r.code, NO_ROOM);
  assert.equal(probes(r.calls).length, 2);
  assert.match(runBox(["--no-sync", "true", "--wait"]).err, /^box: --wait after the command/);
});

// ---- 0.4.11: the server's reason for no room, box --version, box runs --follow ----------------------------------------------

test("a refusal for room carries the server's own reason (vm_why), whatever it holds; a server without the field keeps the client's words", () => {
  const why = "16468 MB of running machines + 3100 MB used by container boxes + 8192 MB asked > 24576 MB, 100% of the 24576 MB cap";
  const withWhy = `${FULL}\tvm_why=${why}`;
  assert.equal(parseStatus(withWhy).vm_why, why);
  const c = choose([{ name: "tower", state: "awake", status: withWhy }], { vm: true });
  assert.deepEqual(c.refusal, [`tower: ${why}`]);
  assert.equal(c.wait, true);
  assert.deepEqual(choose([{ name: "tower", state: "awake", status: `${FULL}\tvm_why=` }], { vm: true }).refusal, ["tower: 3 of 3 machines"], "empty: the old text");
  assert.deepEqual(choose([{ name: "tower", state: "awake", status: FULL.replace(/\tvm_why=.*/, "") }], { vm: true }).refusal, ["tower: 3 of 3 machines"]);
  const s = servers([{ name: "tower", status: withWhy }, { name: "laptop", status: FULL }]);   // two hosts: with one the client does not choose
  assert.ok(go(newRepo(), s, ["hosts"]).out.includes(`\tvm_why=${why}\n`), "box hosts shows the field");
  const no = go(newRepo(), s, ["--vm", "true"]);
  assert.ok(no.err.includes(`  tower: ${why}\n`), JSON.stringify([no.code, no.err]));
});

test("box --version prints the client's version and exits 0; it is the version the package template carries", () => {
  const r = runBox(["--version"]);
  assert.deepEqual([r.code, r.out, r.err], [0, `box ${VERSION}\n`, ""]);
  assert.match(runBox(["--help"]).out, /--version /);
  const template = readFileSync(path.join(REPO, "srcpkgs/boxd/template"), "utf8").match(/^version=(.*)$/m)?.[1];
  assert.equal(VERSION, template, "client VERSION and srcpkgs/boxd/template version must agree");
});

// box runs --follow: the fake hosts answer `pod report` by round (report.<n>, else report); report.fail.<n> makes round n fail.
const RUN_A = "20261116-093000-aaaa", RUN_B = "20261116-094000-bbbb", RUN_C = "20261116-091500-cccc";
const runLn = (box: string, id: string, state: string, exit: string) => `run\tbox=${box}\tid=${id}\tstate=${state}\texit=${exit}\tbytes=9\tchanged=1\n`;
function followFixture() {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]);
  putEntry(s, "tower", "w-1", "/w1"); putEntry(s, "tower", "w-2", "/w2"); putEntry(s, "laptop", "w-3", "/w3");
  return s;
}
const follow = (s: Servers) => go(newRepo(), s, ["runs", "--follow"], { BOXD_RUNS_POLL_MS: "1" });

test("box runs --follow: one line per run as it ends (two different rounds), exit 1 when one failed, a run gone from the report is exit=-", () => {
  const s = followFixture();
  hostFile(s, "tower", "report", runLn("w-1", RUN_A, "running", "-") + runLn("w-2", RUN_B, "running", "-"));
  hostFile(s, "tower", "report.2", runLn("w-1", RUN_A, "ended", "0") + runLn("w-2", RUN_B, "running", "-"));
  hostFile(s, "tower", "report.3", runLn("w-1", RUN_A, "ended", "0") + runLn("w-2", RUN_B, "ended", "3") + runLn("w-1", "20261116-100000-late", "running", "-"));
  hostFile(s, "laptop", "report", runLn("w-3", RUN_C, "running", "-"));
  hostFile(s, "laptop", "report.3", "host\tversion=0.4.11\n");
  const r = follow(s);
  assert.equal(r.code, 1, r.err);
  assert.equal(r.out, `tower\tw-1\t${RUN_A}\texit=0\ntower\tw-2\t${RUN_B}\texit=3\nlaptop\tw-3\t${RUN_C}\texit=-\n`);
  assert.equal(r.err, "");
  assert.equal(r.calls.filter((c) => c.endsWith("boxd-tower pod report")).length, 3, "asked again each round, and stopped when all had ended");
  assert.ok(!r.calls.some((c) => c.includes(" pod log ")), "following reads no log");
});

test("box runs --follow: exit 0 when every run ended with 0; a run that ended without a known code prints exit=- and fails", () => {
  const s = followFixture();
  hostFile(s, "tower", "report", runLn("w-1", RUN_A, "running", "-"));
  hostFile(s, "tower", "report.2", runLn("w-1", RUN_A, "ended", "0"));
  const ok = follow(s);
  assert.deepEqual([ok.code, ok.out], [0, `tower\tw-1\t${RUN_A}\texit=0\n`]);
  const s2 = followFixture();
  hostFile(s2, "tower", "report", runLn("w-1", RUN_A, "running", "-"));
  hostFile(s2, "tower", "report.2", runLn("w-1", RUN_A, "ended", "-"));
  const r = follow(s2);
  assert.deepEqual([r.code, r.out], [1, `tower\tw-1\t${RUN_A}\texit=-\n`]);
});

test("box runs --follow with nothing running says so and exits 0 at once; a sleeping host is named and never contacted", async () => {
  const s = servers([{ name: "tower" }, { name: "laptop", status: FREE }], { wake: { tower: `127.0.0.1:${await closedPort()}` } });
  putEntry(s, "laptop", "w-3", "/w3");
  hostFile(s, "laptop", "report", runLn("w-3", RUN_C, "ended", "0"));
  const r = follow(s);
  assert.deepEqual([r.code, r.out], [0, "no detached run is running\nbox runs: tower is asleep (not woken, not asked)\n"]);
  assert.ok(!r.calls.some((c) => c.includes("boxd-tower")));
  assert.equal(go(newRepo(), s, ["runs", "--now"]).code, 2);
});

test("box runs --follow: a host that fails rounds is skipped for them with one line on standard error, never read as ended", () => {
  const s = followFixture();
  hostFile(s, "laptop", "report", runLn("w-3", RUN_C, "running", "-"));
  for (const n of [2, 3]) hostFile(s, "laptop", `report.fail.${n}`, "");
  hostFile(s, "laptop", "report.4", runLn("w-3", RUN_C, "ended", "0"));
  const r = follow(s);
  assert.deepEqual([r.code, r.out], [0, `laptop\tw-3\t${RUN_C}\texit=0\n`]);
  assert.equal(r.err, "box runs: laptop does not answer; still waiting for its runs\n", "said once for two failed rounds");
});

// ---- 0.4.12: room for the size asked, box runs --pod --------------------------------------------------------------------------
// The server's vm_room judges the default size (8192 MB); vm_fit_mb (0.4.12) is the largest size it would admit now. Built by appending the word.
const fits = (v: string) => `${FULL}\tvm_fit_mb=${v}`;
const one = (status: string, req: Parameters<typeof choose>[1]) => choose([{ name: "tower", state: "awake", status }], req);

test("room for the size asked: a smaller size is judged by vm_fit_mb, the default and a dash or a missing word by vm_room", () => {
  assert.equal(one(fits("5000"), { vm: true, size: "medium" }).host, "tower", "medium fits 5000 MB although vm_room=no");
  assert.equal(one(fits("2048"), { vm: true, size: "small" }).host, "tower", "small fits exactly 2048");
  assert.equal(one(fits("4096"), { vm: true, size: "medium" }).host, "tower", "medium fits exactly 4096");
  const no = one(fits("3000"), { vm: true, size: "medium" });
  assert.deepEqual([no.refusal, no.wait], [["tower: 3000 MB fit, 4096 MB asked"], true], "the numbers, and time can change it");
  assert.deepEqual(one(fits("0"), { vm: true, size: "small" }).refusal, ["tower: 0 MB fit, 2048 MB asked"], "count ceiling reached");
  assert.deepEqual(one(fits("5000"), { vm: true }).refusal, one(FULL, { vm: true }).refusal, "default size: still vm_room, the same reason");
  assert.ok(one(fits("5000"), { vm: true }).refusal, "default size refused");
  for (const w of ["-", ""]) assert.ok(one(w === "" ? FULL : fits(w), { vm: true, size: "medium" }).refusal, `fit "${w}" falls back to vm_room=no`);
  assert.equal(one(FREE, { vm: true, size: "medium" }).host, "tower", "vm_room=yes still places");
  assert.equal(one(fits("0"), { vm: false, size: "medium" }).host, "tower", "a container is never judged by it");
  assert.ok(one(fits("5000").replace(/engines=[^\t]*/, "engines=container"), { vm: true, size: "medium" }).refusal, "no engine stays refused");
});

test("room for the size asked: xlarge (12288 MB) is judged by vm_fit_mb like the smaller sizes, a missing word by vm_room", () => {
  assert.equal(one(fits("12288"), { vm: true, size: "xlarge" }).host, "tower", "xlarge fits exactly 12288 although vm_room=no");
  assert.deepEqual(one(fits("8192"), { vm: true, size: "xlarge" }).refusal, ["tower: 8192 MB fit, 12288 MB asked"]);
  assert.equal(one(FREE, { vm: true, size: "xlarge" }).host, "tower", "no vm_fit_mb: vm_room=yes still places");
  const both = choose([{ name: "tower", state: "awake", status: fits("8192") }, { name: "laptop", state: "awake", status: fits("20000") }], { vm: true, size: "xlarge" });
  assert.equal(both.host, "laptop", "the host that can hold it, not the first");
});

test("room for the size asked, through the command: medium is placed on a vm_room=no host with 5000 MB fit; 3000 MB is exit 75 with the numbers; default stays refused", () => {
  const rp = newRepo(), ok = go(rp, servers([{ name: "tower", status: fits("5000") }, { name: "laptop", status: FULL }]), ["--no-sync", "--vm", "--size", "medium", "true"]);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(ok.calls.some((c) => c.includes("boxd-tower pod run") && c.includes("--size medium")), "the call ran on tower");
  const no = go(newRepo(), servers([{ name: "tower", status: fits("3000") }, { name: "laptop", status: fits("1000") }]), ["--no-sync", "--vm", "--size", "medium", "true"]);
  assert.equal(no.code, NO_ROOM);
  assert.equal(no.err, "box: no build server has room for this call\n  tower: 3000 MB fit, 4096 MB asked\n  laptop: 1000 MB fit, 4096 MB asked\n  fits now: --size small on tower (3000 MB free; a box that exists keeps its size, changing it needs --recreate)\n  or wait for room: add --wait\n");
  const def = go(newRepo(), servers([{ name: "tower", status: fits("5000") }, { name: "laptop", status: fits("5000") }]), ["--no-sync", "--vm", "true"]);
  assert.equal(def.code, NO_ROOM, "default size is judged by vm_room");
});

test("--wait keeps asking while the medium size does not fit, and goes on when it does", () => {
  const s = servers([{ name: "tower", status: fits("3000") }, { name: "laptop", status: fits("3000") }]), rp = newRepo();
  hostFile(s, "tower", "status.2", `${fits("4096")}\n`);
  const r = waits(rp, s, ["--no-sync", "--vm", "--size", "medium", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "box: waiting for room, asking every 0.001 seconds:\n  tower: 3000 MB fit, 4096 MB asked\n  laptop: 3000 MB fit, 4096 MB asked\nbox: exit 0 on tower\n");
  assert.equal(probes(r.calls).length, 4, "both hosts asked again");
});

// box runs --pod: the box column is the box name of the entry (the name given to --pod, else <folder>-<number>).
function podFixture() {
  const s = followFixture();
  putEntry(s, "tower", "rf-1", "/r1"); putEntry(s, "tower", "my-pod", "/r2"); putEntry(s, "tower", "myxpod", "/r3");
  return s;
}
const runsOf = (s: Servers, ...a: string[]) => go(newRepo(), s, ["runs", ...a], { BOXD_RUNS_POLL_MS: "1" });
const RUN_D = "20261116-095000-dddd", RUN_E = "20261116-095500-eeee";

test("box runs --pod: a glob over the whole box name keeps the matching runs in the listing; several patterns; ? is one character", () => {
  const s = podFixture();
  hostFile(s, "tower", "report", runLn("w-1", RUN_A, "running", "-") + runLn("rf-1", RUN_B, "running", "-") + runLn("w-2", RUN_C, "running", "-"));
  for (const id of [RUN_A, RUN_B, RUN_C]) hostFile(s, "tower", `log.${id}`, head(9, 0, 9, "running"));
  const boxes = (...a: string[]) => runsOf(s, ...a).out.trimEnd().split("\n").map((l) => l.split("\t")[1] ?? l);
  assert.deepEqual(boxes("--pod", "rf-*"), ["rf-1"]);
  assert.deepEqual(boxes("--pod", "rf-*", "--pod", "w-?"), ["w-1", "rf-1", "w-2"]);
  assert.deepEqual(boxes("--pod", "w-?"), ["w-1", "w-2"]);
  assert.deepEqual(boxes("--pod", "w"), ["no detached run is running"], "the whole name must match");
  assert.equal(runsOf(s, "--pod", "w").code, 0);
});

test("box runs --pod: a character of regular expressions in the pattern is literal", () => {
  const s = podFixture();
  hostFile(s, "tower", "report", runLn("my-pod", RUN_A, "running", "-") + runLn("myxpod", RUN_B, "running", "-"));
  for (const id of [RUN_A, RUN_B]) hostFile(s, "tower", `log.${id}`, head(9, 0, 9, "running"));
  const boxes = (p: string) => runsOf(s, "--pod", p).out.trimEnd().split("\n").map((l) => l.split("\t")[1] ?? l);
  assert.deepEqual(boxes("my-pod"), ["my-pod"]);
  assert.deepEqual(boxes("my-pod+"), ["no detached run is running"], "'+' is not an operator");
  assert.deepEqual(boxes("my.pod"), ["no detached run is running"], "'.' does not match any character");
  assert.deepEqual(boxes("my?pod"), ["my-pod", "myxpod"], "'?' is one character");
  assert.deepEqual(boxes("(my)*"), ["no detached run is running"]);
});

test("box runs --follow --pod: ends with the matching runs only, exit 0 when they ended with 0 although another failed or still runs", () => {
  const s = podFixture();
  hostFile(s, "tower", "report", runLn("rf-1", RUN_A, "running", "-") + runLn("w-1", RUN_B, "running", "-") + runLn("w-2", RUN_D, "running", "-"));
  hostFile(s, "tower", "report.2", runLn("rf-1", RUN_A, "ended", "0") + runLn("w-1", RUN_B, "ended", "3") + runLn("w-2", RUN_D, "running", "-"));
  const r = runsOf(s, "--follow", "--pod", "rf-*");
  assert.deepEqual([r.code, r.out, r.err], [0, `tower\trf-1\t${RUN_A}\texit=0\n`, ""]);
  assert.equal(r.calls.filter((c) => c.endsWith("boxd-tower pod report")).length, 2, "stopped when the matching run ended");
  const s2 = podFixture();
  hostFile(s2, "tower", "report", runLn("rf-1", RUN_A, "running", "-") + runLn("w-1", RUN_B, "running", "-"));
  hostFile(s2, "tower", "report.2", runLn("rf-1", RUN_A, "ended", "2") + runLn("w-1", RUN_B, "ended", "0"));
  const f = runsOf(s2, "--pod", "rf-*", "--follow");
  assert.deepEqual([f.code, f.out], [1, `tower\trf-1\t${RUN_A}\texit=2\n`], "the options may come in either order; a matching failure fails");
});

test("box runs --follow --pod: two patterns follow both; no match at the first listing says so and exits 0 at once", () => {
  const s = podFixture();
  hostFile(s, "tower", "report", runLn("rf-1", RUN_A, "running", "-") + runLn("w-1", RUN_B, "running", "-") + runLn("w-2", RUN_E, "running", "-"));
  hostFile(s, "tower", "report.2", runLn("rf-1", RUN_A, "ended", "0") + runLn("w-1", RUN_B, "ended", "0") + runLn("w-2", RUN_E, "running", "-"));
  const r = runsOf(s, "--follow", "--pod", "rf-*", "--pod", "w-1");
  assert.deepEqual([r.code, r.out], [0, `tower\trf-1\t${RUN_A}\texit=0\ntower\tw-1\t${RUN_B}\texit=0\n`]);
  const none = runsOf(s, "--follow", "--pod", "zzz*");
  assert.deepEqual([none.code, none.out], [0, "no detached run is running\n"]);
});

test("box runs --pod without a value is a usage error; so is any other argument", () => {
  const s = podFixture();
  const r = runsOf(s, "--pod");
  assert.deepEqual([r.code, r.err.includes("--pod needs a pattern")], [2, true]);
  assert.equal(runsOf(s, "--follow", "--pod").code, 2);
  assert.equal(runsOf(s, "now").code, 2);
  assert.equal(runsOf(s, "--follow", "--follow").code, 2);
});

// ---- box drop: this worktree's box removed at once, never waking a host, never under a running command -----------------------
test("drop: removes the box and its folder, the record, logs it as asked, and says so", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box, "stopped")); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["drop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 0);
  assert.equal(r.out, `box drop: removed test box ${rp.box} and its files\n`);
  assert.deepEqual(r.calls.filter((c) => !c.endsWith(" pod status")).map((c) => c.replace(/^.* boxd-/, "boxd-")), ["boxd-test pod list", `boxd-test pod drop ${rp.box}`]);
  assert.equal(getEntry(s, "test", rp.box), undefined);
  assert.deepEqual(gcLog(s).map((l) => l.slice(1)), [["test", rp.box, rp.top, "asked"]]);
});

test("drop: the size the server measured is relayed; an answer without it, or with a malformed one, prints the old line", () => {
  const old = (rp: { box: string }) => `box drop: removed test box ${rp.box} and its files\n`;
  const answer = (out: string) => {
    const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
    hostFile(s, "test", "list", LINE(rp.box, "stopped")); putEntry(s, "test", rp.box, rp.top); hostFile(s, "test", "drop.out", out);
    return { r: go(rp, s, ["drop"], { BOXD_HOST: "test" }), rp };
  };
  const ok = answer("evicted x (worktree gone), 123 MB freed\n"); assert.equal(ok.r.out, `${old(ok.rp).trimEnd()}, 123 MB freed\n`);
  const zero = answer("evicted x (worktree gone), 0 MB freed\n"); assert.equal(zero.r.out, `${old(zero.rp).trimEnd()}, 0 MB freed\n`);
  for (const bad of ["", "evicted x (worktree gone)\n", "evicted x (worktree gone), 12a MB freed\n", "evicted x (worktree gone), 1234567890 MB freed\n", "evicted x (worktree gone), 5 MB freed and more\n", "evicted x (worktree gone), -5 MB freed\n", "x, 5 MB freed\n"]) {
    const b = answer(bad); assert.equal(b.r.out, old(b.rp), JSON.stringify(bad));
  }
});

test("drop: what the box really needed is added, with advice where it helps; the collector's line carries the same words", () => {
  const answer = (out: string) => {
    const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
    hostFile(s, "test", "list", LINE(rp.box, "stopped")); putEntry(s, "test", rp.box, rp.top); hostFile(s, "test", "drop.out", out);
    return go(rp, s, ["drop"], { BOXD_HOST: "test" }).out.replace(rp.box, "BOX");
  };
  assert.equal(answer("evicted x (worktree gone), needed 2900 MB of 8192 MB (large), 512 MB freed\n"),
    "box drop: removed test box BOX and its files, 512 MB freed; it needed 2900 MB of its 8192 MB at most (--size medium would have held it)\n");
  assert.equal(answer("evicted x (worktree gone), needed 7900 MB of 8192 MB (large), 512 MB freed\n"),
    "box drop: removed test box BOX and its files, 512 MB freed; it needed 7900 MB of its 8192 MB at most (close to the limit: --size xlarge gives 12288 MB)\n");
  assert.equal(answer("evicted x (worktree gone), needed 6000 MB of 8192 MB (large)\n"), "box drop: removed test box BOX and its files; it needed 6000 MB of its 8192 MB at most\n");
  const s = servers([{ name: "test", status: FREE }]);
  hostFile(s, "test", "list", LINE("gone-1", "stopped")); putEntry(s, "test", "gone-1", NOWHERE, T0 - 20 * MIN); hostFile(s, "test", "drop.out", "evicted gone-1 (worktree gone), needed 2900 MB of 8192 MB (large), 77 MB freed\n");
  assert.match(gc(s, ["gc"], T0).out, /^box gc: removed test box gone-1 and its files, 77 MB freed; it needed 2900 MB of its 8192 MB at most \(--size medium would have held it\): worktree .* is gone\n$/);
});

test("call: the client sends no --size of its own accord, so the server can choose a machine from the past need", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "--no-sync", "true"], { BOXD_HOST: "test" });
  const runs = r.calls.filter((c) => c.includes("pod run"));
  assert.equal(runs.length > 0 && runs.every((c) => c.includes("--vm") && !c.includes("--size")), true, r.calls.join("\n"));
});

test("drop: a box the host no longer has is still cleaned (pod drop answers 0 for it)", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", ""); putEntry(s, "test", rp.box, rp.top);
  assert.equal(go(rp, s, ["drop"], { BOXD_HOST: "test" }).code, 0);
  assert.equal(getEntry(s, "test", rp.box), undefined);
});

test("drop: a command still running in the box refuses and removes nothing, record kept", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, "7\t100\t0\t/job/src\tsleep 99\n"); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["drop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`box drop: box ${rp.box} on test still has a command running in it; nothing removed\n`));
  assert.deepEqual(stops(r.calls), []);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
  assert.deepEqual(gcLog(s), []);
});

test("drop: a failed pod drop keeps the record and says the exit code", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box, "stopped")); hostFile(s, "test", "drop.exit", "1"); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["drop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, /box drop: test: removing .* failed \(exit 1\); record kept\n/);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
  assert.deepEqual(gcLog(s), []);
});

test("drop: a sleeping host is never contacted, one line, exit 1, record kept", async () => {
  const s = servers([{ name: "sleepy" }], { wake: { sleepy: `127.0.0.1:${await closedPort()}` } }), rp = newRepo();
  putEntry(s, "sleepy", rp.box, rp.top);
  const r = go(rp, s, ["drop"], { BOXD_HOST: "sleepy" });
  assert.equal(r.code, 1);
  assert.equal(r.calls.filter((c) => c.includes("boxd-sleepy")).length, 0);
  assert.match(r.err, /box drop: sleepy is asleep and is not woken; its box .* is removed by the collector when it wakes\n/);
  assert.notEqual(getEntry(s, "sleepy", rp.box), undefined);
});

test("drop --pod: a box of another worktree that still exists, or one without a record, is refused and nothing is asked", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo(), other = newRepo();
  putEntry(s, "test", other.box, other.top);
  const r = go(rp, s, ["drop", "--pod", other.box], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, /belongs to the worktree .*; run box drop from there; nothing removed\n/);
  const n = go(rp, s, ["drop", "--pod", "nobody-1"], { BOXD_HOST: "test" });
  assert.match(n.err, /box nobody-1 on test has no record on this machine; nothing removed\n/);
  assert.deepEqual([...r.calls, ...n.calls].filter((c) => c.includes(" pod drop ") || c.includes(" pod list")), []);
  assert.notEqual(getEntry(s, "test", other.box), undefined);
});

test("drop: bad words are a usage error", () => assert.equal(runBox(["drop", "--now"]).code, 2));

// ---- box stop: the same guards as drop, then pod stop; the folder and the record stay ---------------------------------------
test("stop: stops the box, keeps its files and its record, and says so", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["stop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 0);
  assert.equal(r.out, `box stop: stopped test box ${rp.box}; its files are kept\n`);
  assert.deepEqual(stops(r.calls).map((c) => c.replace(/^.* boxd-/, "boxd-")), [`boxd-test pod stop ${rp.box}`]);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
  assert.deepEqual(gcLog(s), []);
});

test("stop: a host that lists no box of that name has nothing to stop, exit 0, no stop asked", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", ""); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["stop"], { BOXD_HOST: "test" });
  assert.deepEqual([r.code, r.out, stops(r.calls)], [0, `box stop: test has no running box ${rp.box}; nothing to do\n`, []]);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
});

test("stop: a command still running in the box refuses, record kept", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, "7\t100\t0\t/job/src\tsleep 99\n"); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["stop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`box stop: box ${rp.box} on test still has a command running in it; nothing stopped\n`));
  assert.deepEqual(stops(r.calls), []);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
});

test("stop: a failed pod stop keeps the record and says the exit code", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", "stop.exit", "1"); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["stop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, /box stop: test: stopping .* failed \(exit 1\); record kept\n/);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
});

test("stop: a sleeping host is never contacted, one line, exit 1, record kept", async () => {
  const s = servers([{ name: "sleepy" }], { wake: { sleepy: `127.0.0.1:${await closedPort()}` } }), rp = newRepo();
  putEntry(s, "sleepy", rp.box, rp.top);
  const r = go(rp, s, ["stop"], { BOXD_HOST: "sleepy" });
  assert.equal(r.code, 1);
  assert.equal(r.calls.filter((c) => c.includes("boxd-sleepy")).length, 0);
  assert.match(r.err, /box stop: sleepy is asleep and is not woken; nothing stopped\n/);
  assert.notEqual(getEntry(s, "sleepy", rp.box), undefined);
});

test("stop --pod: a box of another worktree that still exists, or one without a record, is refused and nothing is asked", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo(), other = newRepo();
  putEntry(s, "test", other.box, other.top);
  const r = go(rp, s, ["stop", "--pod", other.box], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, /belongs to the worktree .*; run box stop from there; nothing stopped\n/);
  const n = go(rp, s, ["stop", "--pod", "nobody-1"], { BOXD_HOST: "test" });
  assert.match(n.err, /box nobody-1 on test has no record on this machine; nothing stopped\n/);
  assert.deepEqual([...r.calls, ...n.calls].filter((c) => c.includes(" pod stop ") || c.includes(" pod list")), []);
});

test("stop: bad words are a usage error", () => assert.equal(runBox(["stop", "--now"]).code, 2));

// ---- the refusal for room says what would work now (roomHint: only the status lines the probe returned) ----------------------
const fitLine = (size: string, host: string, mb: number) => `fits now: --size ${size} on ${host} (${mb} MB free; a box that exists keeps its size, changing it needs --recreate)`;
const WAIT_LINE = "or wait for room: add --wait";
const statusFit = (mb?: string) => `version=0.4.22\tengines=container,vm\tvm_room=no\t${mb === undefined ? "" : `vm_fit_mb=${mb}`}`;
const awake = (name: string, mb?: string) => ({ name, state: "awake", status: statusFit(mb) });
test("room hint: a smaller size fits on one host, on two the larger free one is named, nothing fits, no vm_fit_mb, called with --wait", () => {
  const xl = { vm: true, size: "xlarge" };
  assert.deepEqual(roomHint([awake("tower", "9824"), awake("laptop", "11400")], xl, false), [fitLine("large", "laptop", 11400), WAIT_LINE], "the real case: asked xlarge");
  assert.deepEqual(roomHint([awake("tower", "9824"), awake("laptop", "3000")], xl, false), [fitLine("large", "tower", 9824), WAIT_LINE], "one host fits large");
  assert.deepEqual(roomHint([awake("tower", "5000"), awake("laptop", "3000")], { vm: true }, false), [fitLine("medium", "tower", 5000), WAIT_LINE], "default size asked: the largest below it");
  assert.deepEqual(roomHint([awake("tower", "1000"), awake("laptop", "500")], xl, false), [WAIT_LINE], "nothing smaller fits anywhere");
  assert.deepEqual(roomHint([awake("tower", "9824")], { vm: true, size: "small" }, false), [WAIT_LINE], "nothing is smaller than small");
  assert.deepEqual(roomHint([awake("tower"), awake("laptop", "-")], xl, false), [WAIT_LINE], "an older server or an unmeasured host: no size is guessed");
  assert.deepEqual(roomHint([awake("tower", "9824")], xl, true), [fitLine("large", "tower", 9824)], "with --wait only the size line");
  assert.deepEqual(roomHint([awake("tower")], xl, true), [], "with --wait and nothing to say: nothing");
  assert.deepEqual(roomHint([{ name: "tower", state: "asleep" }, { name: "laptop", state: "unreachable" }], xl, false), [WAIT_LINE]);
});

test("room hint, through the command: the real case (asked xlarge, 9824 and 11400 MB fit) prints both lines after the reasons, exit 75, nothing on standard output", () => {
  const no = go(newRepo(), servers([{ name: "tower", status: fits("9824") }, { name: "laptop", status: fits("11400") }]), ["--no-sync", "--vm", "--size", "xlarge", "true"]);
  assert.equal(no.code, NO_ROOM);
  assert.equal(no.err, `box: no build server has room for this call\n  tower: 9824 MB fit, 12288 MB asked\n  laptop: 11400 MB fit, 12288 MB asked\n  ${fitLine("large", "laptop", 11400)}\n  ${WAIT_LINE}\n`);
  assert.equal(no.out, "");
});

test("room hint: a refusal that waiting cannot fix (no machines on any host) gets no hint", () => {
  const plain = FREE.replace(/engines=[^\t]*/, "engines=container");
  const none = go(newRepo(), servers([{ name: "tower", status: plain }, { name: "laptop", status: plain }]), ["--no-sync", "--vm", "true"]);
  assert.equal(none.code, NO_ROOM);
  assert.equal(none.err, "box: no build server has room for this call\n  tower: no virtual machines\n  laptop: no virtual machines\n");
});

test("room hint: a placed worktree whose host refuses and no other host has room gets the lines after the reasons", () => {
  const s = servers([{ name: "tower", status: FREE, runExit: NO_ROOM, runErr: REFUSAL }, { name: "laptop", status: fits("5000") }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.match(r.err, new RegExp(`box: no other build server has room\\n  laptop: [^\\n]*\\n  ${fitLine("medium", "laptop", 5000).replace(/[()]/g, "\\$&")}\\n  ${WAIT_LINE}\\nbox: exit 75 on tower\\n$`));
});

// ---- box drop asks the server whether the box is busy (a call or a detached run), not whether any process is in it --------------
const BOXROW = (b: string, tail: string) => `box\tbox=${b}\tengine=vm\timage=toolbox\tstate=running\tlast_used=1\tuser=-\tsize=large\tmem_limit_mb=8192\tmem_mb=100\t${tail}\n`;
const DAEMONS = "11\t900\t0\t/\tdockerd\n12\t899\t0\t/\tcontainerd --config /var/run/docker/containerd/containerd.toml\n";
test("drop: a machine whose only processes are the image's own daemons and that is not busy is removed", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, DAEMONS); hostFile(s, "test", "report", BOXROW(rp.box, "busy=no\truns=0")); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["drop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.filter((c) => !c.endsWith(" pod status")).map((c) => c.replace(/^.* boxd-/, "boxd-")), ["boxd-test pod list", "boxd-test pod report", `boxd-test pod drop ${rp.box}`]);
  assert.equal(getEntry(s, "test", rp.box), undefined);
});

test("drop: a busy machine (a call or a detached run holds it) is refused with the same words, nothing removed", () => {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, DAEMONS); hostFile(s, "test", "report", BOXROW(rp.box, "busy=yes\truns=1")); putEntry(s, "test", rp.box, rp.top);
  const r = go(rp, s, ["drop"], { BOXD_HOST: "test" });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`box drop: box ${rp.box} on test still has a command running in it; nothing removed\n`));
  assert.deepEqual(stops(r.calls), []);
  assert.notEqual(getEntry(s, "test", rp.box), undefined);
});

test("stop and drop: a busy box with running detached runs names the way out: the first running run, and how many more", () => {
  for (const [mode, nothing] of [["stop", "nothing stopped"], ["drop", "nothing removed"]]) {
    for (const [runs, hint] of [[runLn("x", "r-1", "running", "-"), "; end a detached run with: box stop --run r-1"], [runLn("x", "r-1", "ended", "0") + runLn("x", "r-2", "running", "-") + runLn("x", "r-3", "running", "-") + runLn("o", "r-4", "running", "-"), "; end a detached run with: box stop --run r-2 (and 1 more)"]] as const) {
      const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
      hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, DAEMONS); hostFile(s, "test", "report", BOXROW(rp.box, "busy=yes\truns=1") + runs.replaceAll("box=x", `box=${rp.box}`)); putEntry(s, "test", rp.box, rp.top);
      const r = go(rp, s, [mode], { BOXD_HOST: "test" });
      assert.equal(r.code, 1);
      assert.equal(r.err, `box ${mode}: box ${rp.box} on test still has a command running in it; ${nothing}${hint}\n`);
    }
  }
});

test("drop: a report that does not say busy for this box (older server, other box, failed call) keeps today's rule: any process refuses", () => {
  for (const report of [(b: string) => BOXROW(b, "runs=0"), () => BOXROW("other-1", "busy=no\truns=0"), () => ""]) {
    const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
    hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, DAEMONS); hostFile(s, "test", "report", report(rp.box)); putEntry(s, "test", rp.box, rp.top);
    const r = go(rp, s, ["drop"], { BOXD_HOST: "test" });
    assert.equal(r.code, 1, report(rp.box));
    assert.match(r.err, /still has a command running in it; nothing removed\n/);
  }
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo();
  hostFile(s, "test", "list", LINE(rp.box)); hostFile(s, "test", `ps.${rp.box}`, DAEMONS); hostFile(s, "test", "report.fail.1", ""); putEntry(s, "test", rp.box, rp.top);
  assert.equal(go(rp, s, ["drop"], { BOXD_HOST: "test" }).code, 1, "pod report failing: the process list decides");
});

// ---- --git: the box folder becomes a repository at the worktree's own commit (real repositories, the fake ssh, the real rsync) ----
const WHO = { GIT_AUTHOR_NAME: "Zed Secretname", GIT_AUTHOR_EMAIL: "zed@private.example", GIT_COMMITTER_NAME: "Zed Secretname", GIT_COMMITTER_EMAIL: "zed@private.example" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, ...WHO } }).trimEnd();
let gitN = 0;
function gitRepo() {
  const n = ++gitN, r = path.join(root, `git-repo-${n}`), remote = path.join(root, `git-remote-${n}`);
  mkdirSync(r); git(r, "init", "-q", "-b", "main");
  for (const [i, c] of ["one", "two", "three"].entries()) { writeFileSync(path.join(r, "a.txt"), c); writeFileSync(path.join(r, `f${i}.txt`), c); git(r, "add", "-A"); git(r, "commit", "-q", "-m", c); }
  return { r, remote, src: srcOf(r, remote) };
}
const srcOf = (cwd: string, remote: string) => path.join(remote, "jobs", plan(git(cwd, "rev-parse", "--show-toplevel"), [], ["x"]).box, "src");
const sendFrom = (cwd: string, remote: string, ...args: string[]) => runBox([...args, "true"], { cwd, env: { FAKE_REMOTE: remote } });
const status = (src: string) => git(src, "status", "--porcelain").split("\n").sort();
// every file of the box's repository, read as text: nothing of this machine or of its user may be in it
const gitBytes = (src: string) => (readdirSync(path.join(src, ".git"), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[]).filter((e) => e.isFile()).map((e) => ({ f: path.join(e.parentPath, e.name), b: readFileSync(path.join(e.parentPath, e.name)).toString("latin1") }));

test("--git: the box folder is a repository at the worktree's own commit, one commit, detached, uncommitted and untracked work shows as such, nothing of the user in it", () => {
  const { r, remote, src } = gitRepo();
  writeFileSync(path.join(r, "a.txt"), "edited"); writeFileSync(path.join(r, "new.txt"), "n"); git(r, "rm", "-q", "f0.txt");
  const run = sendFrom(r, remote, "--git");
  assert.equal(run.code, 0, run.err);
  assert.equal(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.equal(git(src, "rev-list", "--count", "HEAD"), "1", "no history");
  assert.equal(git(src, "rev-parse", "--is-shallow-repository"), "true");
  assert.throws(() => git(src, "symbolic-ref", "-q", "HEAD"), "detached");
  assert.deepEqual(status(src), [" M a.txt", " D f0.txt", "?? new.txt"].sort());
  assert.equal(git(src, "remote"), "", "no remote");
  assert.equal(git(src, "for-each-ref"), "", "no branches, no tags");
  assert.ok(!existsSync(path.join(src, ".git", "hooks")), "no hooks");
  for (const { f, b } of gitBytes(src)) for (const secret of ["Zed Secretname", "private.example", r]) assert.ok(!b.includes(secret), `${secret} found in ${f}`);
  assert.ok(!readFileSync(path.join(src, ".git/config"), "utf8").includes("user"), "no user in the configuration");
  assert.ok(!run.calls.some((c) => c.includes("--git")), "nothing of --git is sent to the pod");
});

test("--git: a clean worktree is clean in the box; the index is the commit, so staged work shows as unstaged there", () => {
  const { r, remote, src } = gitRepo();
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.deepEqual(status(src), [""]);
  writeFileSync(path.join(r, "a.txt"), "staged"); git(r, "add", "a.txt");
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.deepEqual(status(src), [" M a.txt"]);
});

test("--git: a linked worktree gets its own commit, whatever branch or detached head it is on", () => {
  const { r, remote } = gitRepo(), linked = path.join(root, `linked-${gitN}`);
  git(r, "worktree", "add", "-q", "-b", "side", linked);
  writeFileSync(path.join(linked, "side.txt"), "s"); git(linked, "add", "-A"); git(linked, "commit", "-q", "-m", "side");
  writeFileSync(path.join(linked, "dirty.txt"), "d");
  const run = sendFrom(linked, remote, "--git");
  assert.equal(run.code, 0, run.err);
  const src = srcOf(linked, remote);
  assert.equal(git(src, "rev-parse", "HEAD"), git(linked, "rev-parse", "HEAD"));
  assert.notEqual(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.deepEqual(status(src), ["?? dirty.txt"]);
  git(linked, "checkout", "-q", "--detach");
  assert.equal(sendFrom(linked, remote, "--git").code, 0);
  assert.equal(git(src, "rev-parse", "HEAD"), git(linked, "rev-parse", "HEAD"));
});

test("--git: a second call after a new commit moves HEAD; a later call without --git, also with --clean, leaves the repository alone", () => {
  const { r, remote, src } = gitRepo();
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  const first = git(src, "rev-parse", "HEAD");
  writeFileSync(path.join(r, "b.txt"), "b"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "four");
  assert.equal(sendFrom(r, remote).code, 0);
  assert.equal(git(src, "rev-parse", "HEAD"), first, "without --git the repository stays as it was");
  assert.deepEqual(status(src), ["?? b.txt"], "b.txt is synced and the old commit does not have it");
  assert.equal(sendFrom(r, remote, "--clean").code, 0);
  assert.equal(git(src, "rev-parse", "HEAD"), first, "--clean keeps it too");
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.equal(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.equal(git(src, "rev-list", "--count", "HEAD"), "1");
  assert.deepEqual(status(src), [""]);
});

test("--git: a commit with a submodule that is not checked out is a clean, ordinary repository in the box", () => {
  const { r, remote, src } = gitRepo();
  git(r, "update-index", "--add", "--cacheinfo", `160000,${git(r, "rev-parse", "HEAD")},vendor/lib`);
  git(r, "commit", "-q", "-m", "submodule"); mkdirSync(path.join(r, "vendor/lib"), { recursive: true });
  const run = sendFrom(r, remote, "--git");
  assert.equal(run.code, 0, run.err);
  assert.equal(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.deepEqual(status(src), [""]);
});

test("--git: refused with --snapshot and with --no-sync, one line each, nothing sent; a worktree with no commit is refused before anything starts", () => {
  const { r, remote } = gitRepo();
  const a = sendFrom(r, remote, "--git", "--snapshot");
  assert.equal(a.code, 2); assert.equal(a.err.split("\n")[0], "box: --git and --snapshot cannot go together"); assert.deepEqual(a.calls, []);
  const b = sendFrom(r, remote, "--git", "--no-sync");
  assert.equal(b.code, 2); assert.equal(b.err.split("\n")[0], "box: --git needs the sync; drop --no-sync"); assert.deepEqual(b.calls, []);
  const empty = path.join(root, "git-empty"); mkdirSync(empty); git(empty, "init", "-q");
  const c = sendFrom(empty, path.join(root, "git-empty-remote"), "--git");
  assert.equal(c.code, 1); assert.equal(c.err, "box: --git: this worktree has no commit yet; nothing was started\n");
  assert.ok(!c.calls.some((x) => x.startsWith("ssh ") && x.includes(" pod run ")), "no run");
  const outside = path.join(root, "git-outside"); mkdirSync(outside);
  assert.match(runBox(["--git", "true"], { cwd: outside }).err, /box: not inside a git worktree/);
});

// ---- the repository's times: a call that sends the same commit leaves every time under .git in the box as it was ----
// The fixed time is the commit's committer time, so the tests assert that absolute value (an old date of the test's own choosing):
// no sleep, and the old code (which stamps the time of the call) cannot produce it.
const OLD = 1_000_000_000;
const gitAt = (cwd: string, when: number, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, ...WHO, GIT_COMMITTER_DATE: `${when} +0000`, GIT_AUTHOR_DATE: `${when} +0000` } }).trimEnd();
function oldRepo(when = OLD) {
  const n = ++gitN, r = path.join(root, `git-repo-${n}`), remote = path.join(root, `git-remote-${n}`);
  mkdirSync(r); gitAt(r, when, "init", "-q", "-b", "main");
  writeFileSync(path.join(r, "a.txt"), "one"); gitAt(r, when, "add", "-A"); gitAt(r, when, "commit", "-q", "-m", "one");
  return { r, remote, src: srcOf(r, remote) };
}
const ms = (src: string, f: string) => statSync(path.join(src, ".git", f)).mtimeMs;
const WATCHED = ["HEAD", "index", "shallow", "config", "refs", "objects", "."];
for (const [name, args] of [["--git", ["--git"]], ["--commit HEAD", ["--commit", "HEAD"]], ["--git --history with a tag", ["--git", "--history"]], ["--commit HEAD --history with a tag", ["--commit", "HEAD", "--history"]]] as const) {
  test(`${name}: a second call on the same commit leaves every time under .git in the box as it was, and it is the commit's committer time`, () => {
    const { r, remote, src } = oldRepo();
    const history = args.includes("--history");
    if (history) gitAt(r, OLD, "tag", "v1");
    assert.equal(sendFrom(r, remote, ...args).code, 0);
    const files = [...WATCHED.filter((f) => !history || f !== "shallow"), ...(history ? ["refs/tags/v1"] : [])];
    const first = files.map((f) => ms(src, f));
    assert.deepEqual(first, files.map(() => OLD * 1000), "the commit's time, not the time of the call");
    assert.equal(sendFrom(r, remote, ...args).code, 0);
    assert.deepEqual(files.map((f) => ms(src, f)), first);
    // every file and folder under .git, not only the ones named above
    for (const e of readdirSync(path.join(src, ".git"), { recursive: true }) as string[]) assert.equal(ms(src, e), OLD * 1000, e);
  });
}

test("--git: a new commit changes what differs: HEAD has the new hash and the new time; two commits with the same committer date still change HEAD", () => {
  const { r, remote, src } = oldRepo();
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  const first = git(src, "rev-parse", "HEAD");
  writeFileSync(path.join(r, "b.txt"), "b"); gitAt(r, OLD + 100, "add", "-A"); gitAt(r, OLD + 100, "commit", "-q", "-m", "two");
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  const second = git(src, "rev-parse", "HEAD");
  assert.notEqual(second, first); assert.equal(second, git(r, "rev-parse", "HEAD"));
  assert.equal(ms(src, "HEAD"), (OLD + 100) * 1000);
  assert.equal(ms(src, "."), (OLD + 100) * 1000);
  // a third commit in the same second as the second: HEAD has the same size and time, only its content differs
  writeFileSync(path.join(r, "c.txt"), "c"); gitAt(r, OLD + 100, "add", "-A"); gitAt(r, OLD + 100, "commit", "-q", "-m", "three");
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.equal(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.notEqual(git(src, "rev-parse", "HEAD"), second);
  assert.equal(readFileSync(path.join(src, ".git/HEAD"), "utf8").trim(), git(r, "rev-parse", "HEAD"));
  assert.deepEqual(status(src), [""]);
});

test("--history: other tags change what arrives, the same tags change nothing", () => {
  const { r, remote, src } = oldRepo();
  gitAt(r, OLD, "tag", "v1");
  assert.equal(sendFrom(r, remote, "--git", "--history").code, 0);
  const before = ms(src, "refs/tags/v1");
  gitAt(r, OLD, "tag", "v2");
  assert.equal(sendFrom(r, remote, "--git", "--history").code, 0);
  assert.equal(git(src, "tag"), "v1\nv2");
  assert.equal(ms(src, "refs/tags/v1"), before);
  gitAt(r, OLD, "tag", "-d", "v1");
  assert.equal(sendFrom(r, remote, "--git", "--history").code, 0);
  assert.equal(git(src, "tag"), "v2");
});

test("--git: with the index and every file of .git dated by the commit, git in the box still answers: clean is clean, a changed file shows in status and diff, also a same-size change made in the box", () => {
  const { r, remote, src } = oldRepo();
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.equal(ms(src, "index"), OLD * 1000);
  assert.deepEqual(status(src), [""]);
  assert.equal(git(src, "diff"), "");
  writeFileSync(path.join(r, "a.txt"), "ONE!"); // newer than the index
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.deepEqual(status(src), [" M a.txt"]);
  assert.match(git(src, "diff"), /^-one$[^+]*^\+ONE!$/m);
  writeFileSync(path.join(r, "a.txt"), "one");
  assert.equal(sendFrom(r, remote, "--git").code, 0);
  assert.deepEqual(status(src), [""]);
  // a change made in the box after the call, with the file's time older than the index's
  writeFileSync(path.join(src, "a.txt"), "two");
  utimesSync(path.join(src, "a.txt"), OLD - 10, OLD - 10);
  assert.deepEqual(status(src), [" M a.txt"]);
});

// ---- --commit: the box's source is what a fresh clone at that commit holds (real repositories, the fake ssh, the real rsync) ----

// A repository with tracked files of every kind, a commit "main", then a working folder that differs from it in every way.
function commitRepo() {
  const { r, remote, src } = gitRepo();
  writeFileSync(path.join(r, ".gitignore"), "out/\n"); writeFileSync(path.join(r, "run.sh"), "#!/bin/sh\n"); chmodSync(path.join(r, "run.sh"), 0o755);
  symlinkSync("a.txt", path.join(r, "link")); mkdirSync(path.join(r, "docs")); writeFileSync(path.join(r, "docs", "d.txt"), "d");
  git(r, "add", "-A");
  git(r, "update-index", "--add", "--cacheinfo", `160000,${git(r, "rev-parse", "HEAD")},vendor/lib`);
  git(r, "commit", "-q", "-m", "kinds");
  return { r, remote, src };
}
const dirty = (r: string) => {
  writeFileSync(path.join(r, "a.txt"), "edited"); writeFileSync(path.join(r, "untracked.txt"), "u"); mkdirSync(path.join(r, "out")); writeFileSync(path.join(r, "out", "x.o"), "o");
  rmSync(path.join(r, "f0.txt")); mkdirSync(path.join(r, "vendor/lib"), { recursive: true }); writeFileSync(path.join(r, "vendor/lib/inside.txt"), "i");
};
// every file and link under the box's source folder, without .git, and every folder that holds nothing
const srcTree = (src: string) => (readdirSync(src, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
  .map((e) => ({ rel: path.relative(src, path.join(e.parentPath, e.name)), dir: e.isDirectory() && !e.isSymbolicLink() })).filter((e) => !e.rel.split(path.sep).includes(".git"));
const scratch = () => { const d = mkdtempSync(path.join(root, "tmp-")); return d; };

test("--commit: the box holds the commit's tracked files only, with their modes, links and an empty submodule folder; a leftover of an earlier call is gone, what is outside the source folder stays", () => {
  const { r, remote, src } = commitRepo();
  assert.equal(sendFrom(r, remote).code, 0);                                     // an ordinary call first: syncs the working folder
  mkdirSync(path.join(src, "target")); writeFileSync(path.join(src, "target", "built.o"), "b"); writeFileSync(path.join(src, "old-untracked.txt"), "x");
  const home1 = path.join(src, "..", "home"); mkdirSync(home1); writeFileSync(path.join(home1, "keep"), "k");
  dirty(r);
  const before = { status: git(r, "status", "--porcelain"), a: readFileSync(path.join(r, "a.txt"), "utf8"), index: readFileSync(path.join(r, ".git/index")), branches: git(r, "for-each-ref") };
  const t = scratch(), run = runBox(["--commit", "HEAD", "true"], { cwd: r, env: { FAKE_REMOTE: remote, TMPDIR: t } });
  assert.equal(run.code, 0, run.err);
  const sha = git(r, "rev-parse", "HEAD");
  assert.equal(run.err, `box: source is commit ${sha} (HEAD), not the working folder\nbox: exit 0 on test\n`);
  const names = srcTree(src).filter((e) => !e.dir).map((e) => e.rel).sort(), want = git(r, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter((n) => n !== "vendor/lib").sort();
  assert.deepEqual(names, want, "exactly the tracked files");
  assert.equal(readFileSync(path.join(src, "a.txt"), "utf8"), "three", "the uncommitted edit did not reach the box");
  assert.equal(readFileSync(path.join(src, "f0.txt"), "utf8"), "one", "a file deleted in the working folder is there");
  assert.ok(!existsSync(path.join(src, "untracked.txt")) && !existsSync(path.join(src, "out")), "no untracked file, no ignored output");
  assert.ok(!existsSync(path.join(src, "target")) && !existsSync(path.join(src, "old-untracked.txt")), "leftovers of the earlier call are deleted");
  assert.equal(readFileSync(path.join(home1, "keep"), "utf8"), "k", "outside the source folder nothing is touched");
  assert.ok((statSync(path.join(src, "run.sh")).mode & 0o111) !== 0, "executable");
  assert.ok((statSync(path.join(src, "a.txt")).mode & 0o111) === 0, "not executable");
  assert.ok(lstatSync(path.join(src, "link")).isSymbolicLink() && readlinkSync(path.join(src, "link")) === "a.txt", "symbolic link");
  assert.deepEqual(readdirSync(path.join(src, "vendor/lib")), [], "submodule: an empty folder");
  assert.equal(git(src, "rev-parse", "HEAD"), sha); assert.deepEqual(status(src), [""]);
  assert.equal(git(src, "rev-list", "--count", "HEAD"), "1"); assert.equal(git(src, "rev-parse", "--is-shallow-repository"), "true");
  assert.throws(() => git(src, "symbolic-ref", "-q", "HEAD"), "detached");
  assert.equal(git(src, "remote"), ""); assert.ok(!existsSync(path.join(src, ".git", "hooks")));
  for (const { f, b } of gitBytes(src)) for (const secret of ["Zed Secretname", "private.example", r]) assert.ok(!b.includes(secret), `${secret} found in ${f}`);
  // the user's working folder, index and branches are as they were
  assert.equal(git(r, "status", "--porcelain"), before.status); assert.equal(readFileSync(path.join(r, "a.txt"), "utf8"), before.a);
  assert.ok(readFileSync(path.join(r, ".git/index")).equals(before.index), "the index is byte for byte the same"); assert.equal(git(r, "for-each-ref"), before.branches);
  assert.deepEqual(readdirSync(t), [], "the temporary export is gone");
});

test("--commit: the pod line is the one of a call without it, and the client's own option goes nowhere else", () => {
  const { r, remote } = commitRepo();
  const plain = runBox(["--user", "true"], { cwd: r, env: { FAKE_REMOTE: remote } }), c = runBox(["--commit", "HEAD", "--user", "true"], { cwd: r, env: { FAKE_REMOTE: remote } });
  assert.equal(c.code, 0, c.err);
  assert.deepEqual(c.calls.filter((x) => x.startsWith("ssh ")), plain.calls.filter((x) => x.startsWith("ssh ")));
  assert.ok(!c.calls.some((x) => x.startsWith("ssh ") && x.includes("commit")));
  const sync = c.calls.find((x) => x.startsWith("rsync -a --delete")) as string;
  assert.match(sync, /^rsync -a --delete --delete-excluded --checksum --mkpath --filter=P \/\.git --safe-links --exclude=\/\.git \S+\/boxd-commit-[^/]+\/src\/ boxd-test:jobs\/\S+\/src\/$/);
});

test("--commit: a branch, a tag, a short hash and a relative name each resolve to the full hash; the message names what was asked", () => {
  const { r, remote, src } = commitRepo();
  git(r, "branch", "old", "HEAD~1"); git(r, "tag", "v1", "HEAD~2");
  const head = git(r, "rev-parse", "HEAD");
  for (const rev of ["old", "v1", git(r, "rev-parse", "--short=7", "HEAD~1"), "HEAD~2", head.slice(0, 12), "main"]) {
    const run = sendFrom(r, remote, "--commit", rev);
    assert.equal(run.code, 0, run.err);
    const full = git(r, "rev-parse", `${rev}^{commit}`);
    assert.equal(run.err, `box: source is commit ${full} (${rev}), not the working folder\nbox: exit 0 on test\n`);
    assert.equal(git(src, "rev-parse", "HEAD"), full);
    assert.equal(readFileSync(path.join(src, "a.txt"), "utf8"), git(r, "show", `${full}:a.txt`), `the files are those of ${rev}`);
    assert.deepEqual(status(src), [""]);
  }
});

test("--commit: an unknown revision is one line, exit 2, nothing started; so is a name that looks like an option", () => {
  const { r, remote } = commitRepo();
  for (const rev of ["no-such-branch", "-x", "HEAD~99", git(r, "rev-parse", "HEAD:a.txt")]) {
    const run = sendFrom(r, remote, "--commit", rev);
    assert.equal(run.code, 2); assert.equal(run.err.split("\n")[0], `box: --commit ${rev}: not a commit in this repository`); assert.deepEqual(run.calls, []);
  }
  assert.equal(runBox(["--commit"], { cwd: r, env: { FAKE_REMOTE: remote } }).err.split("\n")[0], "box: --commit needs a value");
});

test("--commit: refused with --git, --snapshot, --no-sync, --include and --clean in one grouped line, nothing sent", () => {
  const { r, remote } = commitRepo();
  for (const o of [["--git"], ["--snapshot"], ["--no-sync"], ["--include", "a.txt"], ["--clean"]]) {
    const run = sendFrom(r, remote, "--commit", "HEAD", ...o);
    assert.equal(run.code, 2, o[0]); assert.match(run.err.split("\n")[0] as string, new RegExp(`^box: --commit cannot go with ${o[0]}: [^\\n]*$`)); assert.deepEqual(run.calls, []);
  }
  const all = sendFrom(r, remote, "--commit", "HEAD", "--git", "--snapshot", "--no-sync", "--include", "a.txt", "--clean");
  assert.equal(all.code, 2); assert.ok(all.err.startsWith("box: --commit cannot go with --git, --snapshot, --no-sync, --include, --clean: ")); assert.deepEqual(all.calls, []);
});

test("--commit: in a linked worktree it is that worktree's repository and box", () => {
  const { r, remote } = commitRepo(), linked = path.join(root, `linked-commit-${gitN}`);
  git(r, "worktree", "add", "-q", "-b", "side", linked);
  writeFileSync(path.join(linked, "side.txt"), "s"); git(linked, "add", "-A"); git(linked, "commit", "-q", "-m", "side");
  writeFileSync(path.join(linked, "dirty.txt"), "d");
  const run = sendFrom(linked, remote, "--commit", "HEAD");
  assert.equal(run.code, 0, run.err);
  const src = srcOf(linked, remote);
  assert.equal(git(src, "rev-parse", "HEAD"), git(linked, "rev-parse", "HEAD"));
  assert.ok(existsSync(path.join(src, "side.txt")) && !existsSync(path.join(src, "dirty.txt")));
  assert.deepEqual(status(src), [""]);
  assert.ok(!existsSync(srcOf(r, remote)), "the main worktree's box was not made");
});

test("--commit: the export is removed after a failing sync too, and the error is the usual one", () => {
  const { r } = commitRepo(), t = scratch();
  const run = runBox(["--commit", "HEAD", "true"], { cwd: r, env: { FAKE_REMOTE: "/dev/null/not-a-folder", TMPDIR: t } });
  assert.notEqual(run.code, 0); assert.match(run.err, /box: sync failed \(rsync exit \d+\); nothing was started\n$/);
  assert.equal(run.calls.filter((c) => c.startsWith("ssh ")).length, 0);
  assert.deepEqual(readdirSync(t), []);
});

test("--commit: a signal while the sync runs removes the export", async () => {
  const { r, remote } = commitRepo(), t = scratch(), blockBin = path.join(t, "block-bin"), fifo = path.join(t, "ready"), tmpDir = path.join(t, "tmp");
  mkdirSync(blockBin); mkdirSync(tmpDir); execFileSync("mkfifo", [fifo]);
  // a rsync that says it started and then never ends; only the signal ends it. (Dry runs are not made: --commit sends every tracked file.)
  writeFileSync(path.join(blockBin, "rsync"), `#!/bin/sh\necho up > "${fifo}"\nexec sleep 3600\n`); chmodSync(path.join(blockBin, "rsync"), 0o755);
  const child = spawn(process.execPath, [TOOL, "--commit", "HEAD", "true"], { cwd: r, detached: true, stdio: "ignore", env: { PATH: `${blockBin}:${bin}:${process.env.PATH ?? ""}`, HOME: home, BOXD_HOST: "test", BOXD_GC: "0", CALLS: log, FAKE_REMOTE: remote, TMPDIR: tmpDir } });
  const closed = once(child, "close");
  readFileSync(fifo);                                  // returns when the fake rsync has started: the export exists now
  assert.ok(readdirSync(tmpDir).some((n) => n.startsWith("boxd-commit-")), "the export exists while the sync runs");
  process.kill(-(child.pid as number), "SIGTERM");     // the terminal's way: the whole group
  await closed;
  assert.deepEqual(readdirSync(tmpDir), []);
});

test("--commit: a later call without it syncs the working folder again, and the repository stays at the commit until --git or --commit replaces it", () => {
  const { r, remote, src } = commitRepo();
  assert.equal(sendFrom(r, remote, "--commit", "HEAD").code, 0);
  const sha = git(r, "rev-parse", "HEAD");
  dirty(r);
  assert.equal(sendFrom(r, remote).code, 0);
  assert.equal(readFileSync(path.join(src, "a.txt"), "utf8"), "edited"); assert.ok(existsSync(path.join(src, "untracked.txt")));
  assert.equal(git(src, "rev-parse", "HEAD"), sha);
  assert.ok(status(src).includes("?? untracked.txt") && status(src).includes(" M a.txt"));
  assert.equal(sendFrom(r, remote, "--commit", "HEAD").code, 0);
  assert.equal(readFileSync(path.join(src, "a.txt"), "utf8"), "three"); assert.ok(!existsSync(path.join(src, "untracked.txt"))); assert.deepEqual(status(src), [""]);
});

test("--commit: a file of the commit that an ignore rule matches is sent (a clone has it), and a changed file of the same size and time is replaced", () => {
  const { r, remote, src } = commitRepo();
  writeFileSync(path.join(r, "forced.out"), "1"); writeFileSync(path.join(r, ".gitignore"), "out/\n*.out\n"); git(r, "add", "-f", "forced.out", ".gitignore"); git(r, "commit", "-q", "-m", "forced");
  assert.equal(sendFrom(r, remote, "--commit", "HEAD").code, 0);
  assert.equal(readFileSync(path.join(src, "forced.out"), "utf8"), "1");
  const env = { GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" };
  for (const [i, c] of ["2", "3"].entries()) { writeFileSync(path.join(r, "forced.out"), c); execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-a", "-m", `same time ${i}`], { cwd: r, env: { PATH: process.env.PATH ?? "", HOME: home, ...env } }); assert.equal(sendFrom(r, remote, "--commit", "HEAD").code, 0); assert.equal(readFileSync(path.join(src, "forced.out"), "utf8"), c); }
});

test("--commit with --shards: the revision is resolved once and told once; each shard sends its own export of that commit", () => {
  const f = shardsFixture(2);
  writeFileSync(path.join(f.rp.cwd, "a.txt"), "x"); git(f.rp.cwd, "add", "-A"); git(f.rp.cwd, "commit", "-q", "-m", "c");
  const r = f.run(["--shards", "2", "--commit", "HEAD", "--", "t", "{shard}"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err.split("\n").filter((l) => l.startsWith("box: source is commit ")).length, 1);
  assert.equal(r.calls.filter((c) => /^rsync -a --delete --delete-excluded --checksum .*boxd-commit-/.test(c)).length, 2);
});

// ---- admission of container boxes (owner decision 2026-11-17): the host's box_room, its refusal text, and what the client does with them ----
const BUSY_TEXT = "boxd-pod: no room for another busy box (6144 MB counted + 4096 MB reserve > 8192 MB, 100% of the 8192 MB cap); wait for one to end";
const noBox = (fit: number) => `${FREE}\tbox_room=no\tbox_fit_mb=${fit}\tbox_reserve_mb=4096`;
const yesBox = `${FREE}\tbox_room=yes\tbox_fit_mb=6144\tbox_reserve_mb=4096`;
test("seam: the real server's status line says no for a container call when the cap leaves no memory for another busy box, and the client reads it", () => {
  const real = realStatus(1, 100), w = parseStatus(real);   // one 8192 MB machine on a 100 MB cap
  assert.deepEqual([w.box_room, w.box_fit_mb, w.box_reserve_mb], ["no", "0", "4096"]);
  assert.deepEqual(choose([{ name: "a", state: "awake", status: real }], { vm: false }).refusal, ["a: no memory for another busy box (0 MB fit, 4096 MB wanted)"]);
  assert.equal(parseStatus(FREE).box_room, "yes", "a host that cannot measure its memory says yes");
});

test("a container call goes past a host with box_room=no; the choices log names the reason, the host's own words and the next host", () => {
  const s = servers([{ name: "tower", status: noBox(1000) }, { name: "laptop", status: yesBox }]), rp = newRepo();
  const r = go(rp, s, ["true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [sync(rp, "laptop"), runLine(rp, "laptop")]);
  assert.deepEqual(choices(s)[0]?.slice(3), ["laptop", "overflow", "tower=no memory for another busy box (1000 MB fit, 4096 MB wanted),laptop=awake"]);
});

test("a container call with no room anywhere: exit 75 at once, one reason per host, the wait line and no size line (a container has no size)", () => {
  const withFit = (x: string) => `${x}\tvm_fit_mb=3000`;   // a machine would fit smaller, which says nothing for a container
  const s = servers([{ name: "tower", status: withFit(noBox(1000)) }, { name: "laptop", status: withFit(noBox(0)) }]), rp = newRepo();
  const r = go(rp, s, ["true"]);
  assert.equal(r.code, NO_ROOM);
  assert.equal(r.err, "box: no build server has room for this call\n  tower: no memory for another busy box (1000 MB fit, 4096 MB wanted)\n  laptop: no memory for another busy box (0 MB fit, 4096 MB wanted)\n  or wait for room: add --wait\n");
  assert.deepEqual(rest(r.calls), []);
  assert.equal(rp.placed(), undefined);
});

test("--wait for a container call: asks again until a host has memory for another busy box, then goes on", () => {
  const s = servers([{ name: "tower", status: noBox(1000) }, { name: "laptop", status: noBox(0) }]), rp = newRepo();
  hostFile(s, "laptop", "status.2", `${yesBox}\n`);
  const r = waits(rp, s, ["true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "box: waiting for room, asking every 0.001 seconds:\n  tower: no memory for another busy box (1000 MB fit, 4096 MB wanted)\n  laptop: no memory for another busy box (0 MB fit, 4096 MB wanted)\nbox: exit 0 on laptop\n");
  assert.deepEqual(rest(r.calls), [sync(rp, "laptop"), runLine(rp, "laptop")]);
});

test("lost race for a container call: the host's refusal for another busy box is retried on the next host with room, as for a machine", () => {
  const s = servers([{ name: "tower", status: yesBox, runExit: NO_ROOM, runErr: BUSY_TEXT }, { name: "laptop", status: yesBox }]), rp = newRepo();
  const r = go(rp, s, ["true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [sync(rp, "tower"), runLine(rp, "tower"), sync(rp, "laptop"), runLine(rp, "laptop")]);
  assert.equal(rp.placed(), "laptop\n");
  assert.deepEqual(choices(s).map((l) => [l[3], l[4]]), [["tower", "order"], ["laptop", "retry"]]);
  assert.match(r.err, /no room for another busy box/, "the refusal of the first host is still shown");
});

// The server prints the refusal for room last, after anything it said before (the image build of --image-file, a removed idle machine): the client must
// still know it, also when more than 2 KB of other lines come first, and must not take a command's own exit 75 for a refusal.
const BUILD = Array.from({ length: 80 }, (_, i) => `STEP ${i + 1}/80: RUN echo building the image of this box, line ${i}`).join("\n");
test("a refusal for room after 3 KB of build lines on standard error: --wait waits and then runs", () => {
  assert.ok(BUILD.length > 3000);
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]), rp = newRepo();
  writeFileSync(path.join(rp.cwd, ".git/boxd-host"), "tower\n");
  hostFile(s, "tower", "run.refuse", "1\n"); hostFile(s, "tower", "run.pre", `${BUILD}\n`);
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /box: waiting for room, asking every 0.001 seconds:\n  tower: no room \(the server refused the call\)\nbox: exit 0 on tower\n$/);
  assert.equal(r.calls.filter((c) => c === runLine(rp, "tower", "--vm")).length, 2);
});
test("a refusal for room after 3 KB of build lines, first placement without --wait: the next host with room is tried", () => {
  const s = servers([{ name: "tower", status: FREE, runExit: NO_ROOM, runErr: `${BUILD}\n${REFUSAL}` }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [sync(rp, "tower"), runLine(rp, "tower", "--vm"), sync(rp, "laptop"), runLine(rp, "laptop", "--vm")]);
  assert.equal(rp.placed(), "laptop\n");
});
test("a refusal for room after 3 KB of build lines for a placed worktree gives the hint lines", () => {
  const s = servers([{ name: "tower", status: FULL, runExit: NO_ROOM, runErr: `${BUILD}\n${REFUSAL}` }, { name: "laptop", status: FREE }]), rp = newRepo();
  go(rp, s, ["--host", "tower", "--no-sync", "true"]);
  const r = go(rp, s, ["--no-sync", "--vm", "sh", "-c", "make all"]);
  assert.equal(r.code, NO_ROOM);
  assert.match(r.err, /box: tower has no room; hosts that do: laptop\. Move this worktree with: box --host laptop --no-sync --vm sh -c 'make all'\nbox: exit 75 on tower\n$/);
});
test("a command that exits 75 by itself, with other words on standard error, is not a refusal: its code is returned and --wait does not wait", () => {
  const s = servers([{ name: "tower", status: FREE, runExit: NO_ROOM, runErr: `${BUILD}\nboxd-pod: no room for another thing was said earlier\nmy tool failed` }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = waits(rp, s, ["--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.equal(r.calls.filter((c) => c.includes(" pod run ")).length, 1);
  assert.ok(!r.err.includes("waiting for room"));
});

test("a host that does not print box_room (an older server) is never judged for a container call", () => {
  const old = FULL.replace(/\tbox_room=.*$/, "");   // a full machine host, no word about container boxes
  assert.ok(!old.includes("box_room"));
  assert.equal(choose([{ name: "tower", state: "awake", status: old }], { vm: false }).host, "tower");
});

// ---- a placed worktree whose own host is full moves by itself (owner decision 2026-11-17) ----
const MOVE_LINE = "box: tower has no room; this worktree moves to laptop (its caches on tower are kept until that host's time limit)\n";
const reportOf = (...rows: string[]) => `host\tversion=0.4.23\tengines=container,vm\n${rows.map((r) => `${r}\n`).join("")}`;
const placedOn = (rp: Repo, host: string) => writeFileSync(path.join(rp.cwd, ".git/boxd-host"), `${host}\n`);
const reports = (calls: string[], n: string) => calls.filter((c) => c.endsWith(`boxd-${n} pod report`)).length;
const otherThanReport = (calls: string[]) => rest(calls).filter((c) => !c.endsWith(" pod report"));
function movable(refused: "status" | "run" = "run") {
  const s = servers([{ name: "tower", status: refused === "status" ? FULL : FREE }, { name: "laptop", status: FREE }]), rp = newRepo();
  placedOn(rp, "tower");
  if (refused === "run") hostFile(s, "tower", "run.refuse", "1\n");
  return { s, rp };
}

test("moves by itself: the host's refusal for room, another host with room, nothing of the box on the old host: one line first, placed, logged as moved, then run there", () => {
  const { s, rp } = movable();
  hostFile(s, "tower", "report", reportOf(`box\tbox=other\tengine=container\tstate=running\tbusy=no\truns=0`, `run\tbox=other\tid=r1\tstate=ended\texit=0`));   // other boxes do not stop it
  const r = go(rp, s, ["--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, `boxd-pod: no room for another virtual machine (3 of 3 running); wait for one to end or stop one\n${MOVE_LINE}box: exit 0 on laptop\n`);
  assert.deepEqual(otherThanReport(r.calls), [sync(rp, "tower"), runLine(rp, "tower", "--vm"), sync(rp, "laptop"), runLine(rp, "laptop", "--vm")]);
  assert.equal(reports(r.calls, "tower"), 1);
  assert.equal(rp.placed(), "laptop\n");
  assert.deepEqual(choices(s).map((l) => [l[3], l[4]]), [["laptop", "moved"]]);
});

test("moves by itself when a refused call is the probe's word too: a container call, the old host answers box_room=no on the retry", () => {
  const s = servers([{ name: "tower", status: noBox(0), runExit: NO_ROOM, runErr: BUSY_TEXT }, { name: "laptop", status: yesBox }]), rp = newRepo();
  placedOn(rp, "tower"); hostFile(s, "tower", "report", reportOf());
  const r = go(rp, s, ["true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, `${BUSY_TEXT}\n${MOVE_LINE}box: exit 0 on laptop\n`);
  assert.equal(rp.placed(), "laptop\n");
});

test("moves by itself: the choice among the other hosts is the normal one (a machine goes to the smallest cap, a container to the most free memory)", () => {
  const caps = (cap: number, free: number) => realStatus(0, cap).replace(/mem_free_mb=\d+/, `mem_free_mb=${free}`);
  const three = () => servers([{ name: "tower", status: FREE }, { name: "big", status: caps(30000, 25000) }, { name: "small", status: caps(15000, 9000) }]);
  const s = three(), rp = newRepo(); placedOn(rp, "tower"); hostFile(s, "tower", "run.refuse", "1\n"); hostFile(s, "tower", "report", reportOf());
  assert.equal(go(rp, s, ["--vm", "true"]).code, 0);
  assert.equal(rp.placed(), "small\n", "a machine: the smaller cap");
  const s2 = three(), rp2 = newRepo(); placedOn(rp2, "tower"); hostFile(s2, "tower", "run.refuse", "1\n"); hostFile(s2, "tower", "report", reportOf());
  assert.equal(go(rp2, s2, ["true"]).code, 0);
  assert.equal(rp2.placed(), "big\n", "a container: the most free memory");
});

test("does not move when the old host still has a machine or container of this box, in any state, or a run of it, running or ended: the old refusal text stays", () => {
  const holds = [
    reportOf(`box\tbox=${"BOX"}\tengine=vm\tstate=running\tbusy=no\truns=0`), reportOf(`box\tbox=${"BOX"}\tengine=container\tstate=stopped\tbusy=no\truns=0`),
    reportOf(`run\tbox=${"BOX"}\tid=r1\tstate=running\texit=-`), reportOf(`run\tbox=${"BOX"}\tid=r1\tstate=ended\texit=0`),
  ];
  for (const h of holds) {
    const { s, rp } = movable();
    hostFile(s, "tower", "report", h.replaceAll("BOX", rp.box));
    const r = go(rp, s, ["--no-sync", "--vm", "true"]);
    assert.equal(r.code, NO_ROOM, h);
    assert.match(r.err, /box: tower has no room; hosts that do: laptop\. Move this worktree with: box --host laptop --no-sync --vm true\nbox: exit 75 on tower\n$/, h);
    assert.equal(rp.placed(), "tower\n");
    assert.equal(r.calls.filter((c) => c.includes(" pod run ")).length, 1, "no move: one run only");
    assert.deepEqual(choices(s), []);
  }
});

test("does not move when the old host cannot be asked: the report fails, answers nothing, or has no host line", () => {
  for (const how of ["fail", "empty", "nohost"]) {
    const { s, rp } = movable();
    if (how === "fail") hostFile(s, "tower", "report.fail.1", "");
    if (how === "nohost") hostFile(s, "tower", "report", "box\tbox=other\n");
    if (how !== "nohost") hostFile(s, "tower", "report", reportOf());
    if (how === "empty") hostFile(s, "tower", "report", "");
    const r = go(rp, s, ["--no-sync", "--vm", "true"]);
    assert.equal(r.code, NO_ROOM, how);
    assert.match(r.err, /box: tower has no room; hosts that do: laptop\. Move this worktree with:/, how);
    assert.equal(rp.placed(), "tower\n", how);
  }
});

test("does not move with BOXD_HOST set (it names a host for this call only) nor with --host; no other host is asked for it", () => {
  const { s, rp } = movable(); hostFile(s, "tower", "report", reportOf());
  const env = go(rp, s, ["--no-sync", "--vm", "true"], { BOXD_HOST: "tower" });
  assert.equal(env.code, NO_ROOM);
  assert.ok(!env.err.includes("moves to"), env.err);
  assert.equal(reports(env.calls, "tower"), 0, "the old host is not even asked");
  hostFile(s, "tower", "run.refuse", "1\n");
  const flag = go(rp, s, ["--host", "tower", "--no-sync", "--vm", "true"]);
  assert.equal(flag.code, NO_ROOM);
  assert.ok(!flag.err.includes("moves to"), flag.err);
  assert.equal(rp.placed(), "tower\n");
});

test("does not move when no other host has room: the old text with the reasons", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FULL }]), rp = newRepo();
  placedOn(rp, "tower"); hostFile(s, "tower", "run.refuse", "1\n"); hostFile(s, "tower", "report", reportOf());
  const r = go(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.match(r.err, /box: no other build server has room\n  laptop: 3 of 3 running\n/);
  assert.equal(rp.placed(), "tower\n");
});

test("--wait: moving is tried first, in the first round and in every later one; the call waits only while it cannot move", () => {
  const first = movable(); hostFile(first.s, "tower", "report", reportOf());
  const a = waits(first.rp, first.s, ["--vm", "true"]);
  assert.equal(a.code, 0, a.err);
  assert.ok(!a.err.includes("waiting for room"), "it moved at once, it did not wait");
  assert.ok(a.err.endsWith(MOVE_LINE + "box: exit 0 on laptop\n"), a.err);
  assert.equal(first.rp.placed(), "laptop\n");
  // round 1: the box still exists on tower (no move), the call waits; round 2: it is gone, the worktree moves
  const { s, rp } = movable("status");
  hostFile(s, "tower", "run.refuse", "1\n");
  hostFile(s, "tower", "report.1", reportOf(`box\tbox=${rp.box}\tengine=vm\tstate=running\tbusy=no\truns=0`)); hostFile(s, "tower", "report.2", reportOf());
  const b = waits(rp, s, ["--vm", "true"]);
  assert.equal(b.code, 0, b.err);
  assert.match(b.err, /box: waiting for room, asking every 0\.001 seconds:\n  tower: 3 of 3 running\n/);
  assert.ok(b.err.endsWith(MOVE_LINE + "box: exit 0 on laptop\n"), b.err);
  assert.equal(reports(b.calls, "tower"), 2);
  assert.equal(rp.placed(), "laptop\n");
  assert.deepEqual(choices(s).map((l) => l[4]), ["moved"]);
});

test("after a move that is refused at once (the new host lost the race) the placement is dropped, as for a placement this call made", () => {
  const s = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE, runExit: NO_ROOM, runErr: REFUSAL }]), rp = newRepo();
  placedOn(rp, "tower"); hostFile(s, "tower", "run.refuse", "1\n"); hostFile(s, "tower", "report", reportOf());
  const r = go(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, NO_ROOM);
  assert.equal(rp.placed(), undefined, "no box was made on the new host: the worktree is unplaced, the next call chooses again");
});

// ---- box --shards: the command in several boxes of this worktree side by side; box runs --follow --tail ----------------------------------------

// One host "test"; every shard box of the worktree is listed running (so the final stop reaches it). Files of the fake host (see shardsFake):
// <box>.exit, <box>.log, <box>.until, <box>.seconds, refuse_at.
function shardsFixture(n: number, base?: string) {
  const s = servers([{ name: "test", status: FREE }]), rp = newRepo(), dir = path.join(s.fake, "shards"), b = base ?? rp.box;
  mkdirSync(dir);
  hostFile(s, "test", "list", Array.from({ length: n }, (_, i) => LINE(`${b}-s${i + 1}`)).join(""));
  const set = (shard: number, ext: string, text: string) => writeFileSync(path.join(dir, `${b}-s${shard}.${ext}`), text);
  for (let i = 1; i <= n; i++) set(i, "log", `ok ${i}\n`);
  return { s, rp, set, b, dir, run: (args: string[]) => go(rp, s, args, { FAKE_SHARDS: dir, BOXD_RUNS_POLL_MS: "1" }) };
}
// The run id of each start, in order: `ssh boxd-test pod run <box> --detach <id> -- <command>`.
const starts = (calls: string[]) => calls.flatMap((c) => { const m = /^ssh (?:-o \S+ )*boxd-test pod run (\S+) (?:.* )?--detach (\S+) -- (\S+)$/.exec(c); return m ? [{ box: m[1] as string, id: m[2] as string, words: Buffer.from(m[3] as string, "base64").toString().split("\0") }] : []; });
const logCalls = (calls: string[]) => calls.filter((c) => c.includes(" pod log "));

test("box --shards: n boxes named after the worktree's box, each synced and started detached in order, {shard} and {shards} replaced in every word, one line as each ends, boxes stopped, exit 0", () => {
  const f = shardsFixture(3);
  const r = f.run(["--shards", "3", "--", "npx", "vitest", "--shard={shard}/{shards}", "--note={shard}-{shard}"]);
  assert.equal(r.code, 0, r.err);
  const st = starts(r.calls);
  assert.deepEqual(st.map((x) => x.box), [1, 2, 3].map((i) => `${f.b}-s${i}`));
  assert.deepEqual(st.map((x) => x.words), [1, 2, 3].map((i) => ["npx", "vitest", `--shard=${i}/3`, `--note=${i}-${i}`]));
  // one after the other: the sync of a shard, its start, then the next shard's sync
  const order = r.calls.filter((c) => c.startsWith("rsync ") || c.includes(" pod run "));
  assert.deepEqual(order.map((c) => c.replace(/--detach \S+ /, "").replace(/ -- \S+$/, "")), [1, 2, 3].flatMap((i) => [
    `rsync -a --delete --mkpath --safe-links --exclude=/.git --filter=:- .gitignore ${f.rp.top}/ boxd-test:jobs/${f.b}-s${i}/src/`, `ssh boxd-test pod run ${f.b}-s${i}`]));
  // each is a box of this worktree the collector and `box drop --pod` know
  for (let i = 1; i <= 3; i++) assert.deepEqual(getEntry(f.s, "test", `${f.b}-s${i}`), { box: `${f.b}-s${i}`, host: "test", worktree: f.rp.top });
  const ended = r.out.split("\n").filter((l) => l.startsWith("shard "));
  assert.deepEqual(ended, st.map((x, i) => `shard ${i + 1}/3  test  ${x.box}  run ${x.id}  exit=0  7 s`));
  assert.ok(!r.out.includes("--- shard"), "no tail for a run that ended with 0");
  assert.ok(!logCalls(r.calls).some((c) => c.endsWith(" 0")), "no log text was read");
  // stopped at the end, after the last report, once each
  assert.deepEqual(stops(r.calls).map((c) => c.replace(/^.* boxd-/, "boxd-")), [1, 2, 3].map((i) => `boxd-test pod stop ${f.b}-s${i}`));
  const firstReport = r.calls.findIndex((c) => c.endsWith(" pod report"));
  assert.ok(firstReport > r.calls.findLastIndex((c) => c.includes(" pod run ")) && firstReport < r.calls.findIndex((c) => c.includes(" pod stop ")), "all started, then followed, then stopped");
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("box stop: stopped test box ")).length, 3);
});

test("box --shards: the tail of a failed run (20 lines by default) under its own line, the exit code is 1, the boxes are stopped all the same", () => {
  const f = shardsFixture(3);
  f.set(2, "exit", "1\n"); f.set(2, "log", Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("")); f.set(3, "until", "3\n");
  const r = f.run(["--shards", "3", "--", "t", "{shard}"]);
  assert.equal(r.code, 1, r.err);
  const lines = r.out.split("\n"), at = lines.indexOf("--- shard 2 (exit 1), last lines of its log:");
  assert.ok(at > 0, r.out);
  assert.deepEqual(lines.slice(at + 1, at + 22), [...Array.from({ length: 20 }, (_, i) => `line ${i + 11}`), "box stop: stopped test box " + f.b + "-s1; its files are kept"]);
  assert.ok(!r.out.includes("--- shard 1") && !r.out.includes("--- shard 3"));
  assert.ok(lines.findIndex((l) => l.startsWith("shard 3/3")) > lines.findIndex((l) => l.startsWith("shard 1/3")), "shard 3 was still running at the first report");
  assert.equal(stops(r.calls).length, 3);
});

test("box --shards --tail <n>: n lines for every shard, 0 for none even for a failed one", () => {
  const f = shardsFixture(2);
  f.set(1, "log", "a\nb\nc\n"); f.set(2, "log", "d\ne\nf\n"); f.set(2, "exit", "5\n");
  const r = f.run(["--shards", "2", "--tail", "2", "--", "t", "{shard}"]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("--- shard 1 (exit 0), last lines of its log:\nb\nc\n--- shard 2 (exit 5), last lines of its log:\ne\nf\n"), r.out);
  const none = f.run(["--shards", "2", "--tail", "0", "--", "t", "{shard}"]);
  assert.equal(none.code, 1);
  assert.ok(!none.out.includes("---"), none.out);
});

test("box --shards: --pod <name> is the base name; a name too long to add -s<n> is refused before anything is made", () => {
  const f = shardsFixture(2, "mine");
  const r = f.run(["--shards", "2", "--pod", "mine", "--", "t", "{shard}"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(starts(r.calls).map((x) => x.box), ["mine-s1", "mine-s2"]);
  const long = "a".repeat(61), bad = f.run(["--shards", "2", "--pod", long, "--", "t", "{shard}"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, new RegExp(`box: --shards: the box name ${long} is too long to add -s2\n`));
  assert.deepEqual(bad.calls, []);
});

test("box --shards: the usual options go to every shard's own call", () => {
  const f = shardsFixture(2);
  const r = f.run(["--shards", "2", "--vm", "--size", "small", "--user", "--env", "SHARD_TOKEN", "--image", "rust:1.83", "--", "t", "{shard}"].map((x) => x));
  assert.equal(r.code, 2, "--env needs the variable set: refused like any call");
  const ok = go(f.rp, f.s, ["--shards", "2", "--vm", "--size", "small", "--user", "--env", "SHARD_TOKEN", "--image", "rust:1.83", "--", "t", "{shard}"], { FAKE_SHARDS: f.dir, BOXD_RUNS_POLL_MS: "1", SHARD_TOKEN: "x" });
  assert.equal(ok.code, 0, ok.err);
  for (const i of [1, 2]) assert.ok(ok.calls.includes(`ssh -o SendEnv=BOXD_SECRET_SHARD_TOKEN boxd-test pod run ${f.b}-s${i} --image rust:1.83 --vm --size small --user --env SHARD_TOKEN --detach ${starts(ok.calls)[i - 1]?.id} -- ${b64("t", String(i))}`), ok.calls.join("\n"));
});

test("box --shards: a command with neither {shard} nor {shards} is refused with one line and an example, nothing is started", () => {
  const f = shardsFixture(2);
  const r = f.run(["--shards", "5", "--", "npx", "vitest"]);
  assert.equal(r.code, 2);
  assert.equal(r.err.split("\n")[0], "box: --shards 5: a command with neither {shard} nor {shards} would run the same thing 5 times; give each box its part, for example: box --shards 5 -- npx vitest --shard={shard}/{shards}");
  assert.deepEqual(r.calls, []);
});

test("box --shards: --detach, --pull, --no-sync, --snapshot, forward and vnc are refused with one line each, a bad count or --tail alone too", () => {
  const f = shardsFixture(2), c = ["--", "t", "{shard}"];
  const refuse = (args: string[]) => { const r = f.run(args); assert.equal(r.code, 2, args.join(" ")); assert.deepEqual(r.calls, []); return r.err.split("\n")[0]; };
  assert.equal(refuse(["--shards", "2", "--detach", ...c]), "box: --shards cannot go with --detach: it syncs, starts detached runs, follows them and stops the boxes itself");
  assert.equal(refuse(["--shards", "2", "--pull", "out", "--snapshot", ...c]), "box: --shards cannot go with --pull, --snapshot: it syncs, starts detached runs, follows them and stops the boxes itself");
  assert.equal(refuse(["--shards", "2", "--no-sync", ...c]), "box: --shards cannot go with --no-sync: it syncs, starts detached runs, follows them and stops the boxes itself");
  assert.equal(refuse(["--shards", "2", "--", "forward", "{shard}", "80"]), "box: --shards runs a command in several boxes; it is not for forward");
  assert.equal(refuse(["--shards", "2", "--", "vnc", "{shard}"]), "box: --shards runs a command in several boxes; it is not for vnc");
  assert.equal(refuse(["forward", "--shards", "2", "80", "80"]), "box forward: unknown option --shards");
  for (const n of ["1", "33", "x", "007"]) assert.equal(refuse(["--shards", n, ...c]), "box: --shards needs a whole number from 2 to 32");
  assert.equal(refuse(["--tail", "5", "t"]), "box: --tail goes with --shards (or with box runs --follow and box log)");
});

test("box --shards: a start refused for room ends the call, the earlier runs stay running (nothing stopped, nothing followed) and the message says how to follow them and queue", () => {
  const f = shardsFixture(4);
  writeFileSync(path.join(f.dir, "refuse_at"), "3\n");
  const r = f.run(["--shards", "4", "--", "t", "{shard}"]);
  assert.equal(r.code, NO_ROOM);
  assert.ok(r.err.includes(`box: shard 3/4 did not start (exit 75); the 2 runs already started keep running. Follow them with: box runs --follow --pod '${f.b}-s*'; add --wait to queue for room instead\n`), r.err);
  assert.equal(starts(r.calls).length, 3, "the third was refused by the host, the fourth never asked");
  assert.equal(r.calls.filter((c) => c.includes(" pod run ")).length, 3);
  assert.deepEqual(stops(r.calls), []);
  assert.ok(!r.calls.some((c) => c.endsWith(" pod report")), "nothing followed");
  assert.equal(r.out.includes("shard 1/4  test"), false);
});

test("box runs --follow --tail <n>: the last n lines of each run's log under a line naming it, as each ends, for every run; --tail without --follow is refused", () => {
  const s = followFixture();
  hostFile(s, "tower", "report", runLn("w-1", RUN_A, "running", "-") + runLn("w-2", RUN_B, "running", "-"));
  hostFile(s, "tower", "report.2", runLn("w-1", RUN_A, "ended", "0") + runLn("w-2", RUN_B, "ended", "3"));
  hostFile(s, "laptop", "report", "host\tversion=0.4.11\n");
  hostFile(s, "tower", `log.${RUN_A}`, `${head(6, 0, 6, "ended", "0")}x\ny\nz\n`);
  hostFile(s, "tower", `log.${RUN_B}`, `${head(6, 0, 6, "ended", "3")}p\nq\nr\n`);
  const r = go(newRepo(), s, ["runs", "--follow", "--tail", "2"], { BOXD_RUNS_POLL_MS: "1" });
  assert.equal(r.code, 1, r.err);
  assert.equal(r.out, `tower\tw-1\t${RUN_A}\texit=0\n--- tower  w-1  run ${RUN_A} (exit 0), last lines of its log:\ny\nz\ntower\tw-2\t${RUN_B}\texit=3\n--- tower  w-2  run ${RUN_B} (exit 3), last lines of its log:\nq\nr\n`);
  assert.equal(go(newRepo(), s, ["runs", "--tail", "2"]).code, 2);
  assert.equal(go(newRepo(), s, ["runs", "--follow", "--tail", "x"]).code, 2);
});

// ---- box runs --host: only the runs of that host are listed and followed; an unknown option is one line ----
test("box runs --host: lists and follows only that host's runs, combines with --pod and --tail, never asks the other host; an unknown host or option is one line, exit 2", () => {
  const s = followFixture();
  hostFile(s, "tower", "report", runLn("w-1", RUN_A, "running", "-"));
  hostFile(s, "tower", "report.2", runLn("w-1", RUN_A, "ended", "0"));
  hostFile(s, "laptop", "report", runLn("w-3", RUN_C, "running", "-"));
  hostFile(s, "tower", `log.${RUN_A}`, head(9, 0, 9, "running")); hostFile(s, "laptop", `log.${RUN_C}`, head(9, 0, 9, "running"));
  const l = runsOf(s, "--host", "laptop");
  assert.deepEqual([l.code, l.out.split("\t").slice(0, 3)], [0, ["laptop", "w-3", RUN_C]]);
  assert.ok(!l.calls.some((c) => c.includes("boxd-tower")), "the other host is not asked");
  assert.equal(runsOf(s, "--host", "tower", "--pod", "zzz*").out, "no detached run is running\n");
  // the fake host counts rounds across calls, so every follow gets a fixture of its own
  const fixture = () => { const t = followFixture(); hostFile(t, "tower", "report", runLn("w-1", RUN_A, "running", "-")); hostFile(t, "tower", "report.2", runLn("w-1", RUN_A, "ended", "0")); hostFile(t, "laptop", "report", runLn("w-3", RUN_C, "running", "-")); return t; };
  const f = runsOf(fixture(), "--follow", "--host", "tower");
  assert.deepEqual([f.code, f.out], [0, `tower\tw-1\t${RUN_A}\texit=0\n`]);
  assert.ok(!f.calls.some((c) => c.includes("boxd-laptop")), "the other host, whose run never ends, is not waited for");
  assert.equal(runsOf(fixture(), "--pod", "w-*", "--host", "tower", "--follow", "--tail", "0").out, `tower\tw-1\t${RUN_A}\texit=0\n`);
  const bad = runsOf(s, "--host", "nowhere");
  assert.deepEqual([bad.code, bad.err, bad.calls], [2, "box runs: --host nowhere: no such build server; box hosts lists them\n", []]);
  const opt = runsOf(s, "--follow", "--frobnicate");
  assert.deepEqual([opt.code, opt.err], [2, "box runs: unknown option --frobnicate; valid: --follow, --tail <n>, --pod <pattern>, --host <name>\n"]);
  assert.equal(runsOf(s, "--host").code, 2);
});

// ---- --history: every commit reachable and the tags inside it ----
function historyRepo() {
  const g = gitRepo();   // three commits on main
  const [c1, c2] = git(g.r, "rev-list", "--reverse", "HEAD").split("\n") as [string, string];
  git(g.r, "tag", "light", c1); git(g.r, "tag", "-a", "-m", "annotated", "ann", c2);
  git(g.r, "switch", "-q", "-c", "other"); writeFileSync(path.join(g.r, "o.txt"), "o"); git(g.r, "add", "-A"); git(g.r, "commit", "-q", "-m", "other"); git(g.r, "tag", "elsewhere");
  git(g.r, "switch", "-q", "main");
  return { ...g, c1, c2 };
}
const tags = (src: string) => git(src, "tag").split("\n").filter(Boolean);

test("--git --history: every commit, exactly the tags inside the history (annotated and lightweight), detached, nothing of the user, nothing else", () => {
  const { r, remote, src } = historyRepo();
  const run = sendFrom(r, remote, "--git", "--history");
  assert.equal(run.code, 0, run.err);
  assert.equal(git(src, "log", "--oneline").split("\n").length, 3);
  assert.deepEqual(tags(src), ["ann", "light"], "the tag of the other branch stays home");
  assert.equal(git(src, "cat-file", "-t", "ann"), "tag", "annotated: a tag object");
  assert.equal(git(src, "cat-file", "-t", "light"), "commit", "lightweight: a plain reference");
  assert.match(git(src, "describe", "--tags"), /^ann-1-g[0-9a-f]+$/);
  assert.equal(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.throws(() => git(src, "symbolic-ref", "-q", "HEAD"), "detached");
  assert.equal(git(src, "for-each-ref", "--format=%(refname)").split("\n").filter((x) => !x.startsWith("refs/tags/")).join(""), "", "no branches");
  assert.equal(git(src, "remote"), "", "no remote");
  assert.ok(!existsSync(path.join(src, ".git", "hooks")) && !existsSync(path.join(src, ".git", "FETCH_HEAD")) && !existsSync(path.join(src, ".git", "logs")));
  assert.ok(!readFileSync(path.join(src, ".git/config"), "utf8").includes("user"));
  for (const { f, b } of gitBytes(src)) if (!f.includes(`${path.sep}objects${path.sep}`)) for (const secret of ["private.example", r]) assert.ok(!b.includes(secret), `${secret} found in ${f}`);
  assert.ok(!run.calls.some((c) => c.includes("--history")), "nothing of --history is sent to the pod");
});

test("--commit <older> --history: only the history up to it and the tags inside it; a second call after a new commit moves HEAD and adds it", () => {
  const { r, remote, src, c2 } = historyRepo();
  assert.equal(sendFrom(r, remote, "--commit", c2, "--history").code, 0);
  assert.equal(git(src, "log", "--oneline").split("\n").length, 2);
  assert.deepEqual(tags(src), ["ann", "light"]);
  assert.equal(git(src, "rev-parse", "HEAD"), c2);
  assert.equal(sendFrom(r, remote, "--commit", c2.slice(0, 7) + "", "--history").code, 0);
  git(r, "tag", "-d", "ann"); assert.equal(sendFrom(r, remote, "--commit", git(r, "rev-list", "--max-parents=0", "HEAD"), "--history").code, 0);
  assert.equal(git(src, "log", "--oneline").split("\n").length, 1);
  assert.deepEqual(tags(src), ["light"]);
  writeFileSync(path.join(r, "b.txt"), "b"); git(r, "add", "-A"); git(r, "commit", "-q", "-m", "four");
  assert.equal(sendFrom(r, remote, "--git", "--history").code, 0);
  assert.equal(git(src, "rev-parse", "HEAD"), git(r, "rev-parse", "HEAD"));
  assert.equal(git(src, "log", "--oneline").split("\n").length, 4);
});

test("--history: a tag deleted locally is gone from the box at the next call, a tag moved points at the new commit", () => {
  const { r, remote, src, c1, c2 } = historyRepo();
  assert.equal(sendFrom(r, remote, "--git", "--history").code, 0);
  assert.deepEqual(tags(src), ["ann", "light"]);
  assert.equal(git(src, "rev-parse", "light"), c1);
  git(r, "tag", "-d", "ann"); git(r, "tag", "-f", "light", c2);
  assert.equal(sendFrom(r, remote, "--git", "--history").code, 0);
  assert.deepEqual(tags(src), ["light"]);
  assert.equal(git(src, "rev-parse", "light"), c2);
  assert.equal(git(src, "pack-refs", "--all") + git(src, "for-each-ref", "--format=%(refname)"), "refs/tags/light", "packed and loose references alike");
});

test("--history alone is refused in one line, nothing sent; a shallow source sends what it has", () => {
  const { r, remote, src } = historyRepo();
  const a = sendFrom(r, remote, "--history");
  assert.deepEqual([a.code, a.err.split("\n")[0], a.calls], [2, "box: --history goes with --git or --commit <rev>", []]);
  const shallow = path.join(root, `git-shallow-${gitN}`);
  git(root, "clone", "-q", "--depth=2", `file://${r}`, shallow);
  const run = sendFrom(shallow, remote, "--git", "--history");
  assert.equal(run.code, 0, run.err);
  const s2 = srcOf(shallow, remote);
  assert.equal(git(s2, "log", "--oneline").split("\n").length, 2);
  assert.equal(git(s2, "rev-parse", "HEAD"), git(shallow, "rev-parse", "HEAD"));
  void src;
});

test("an option before a box word is refused before anything is asked of a host; -- and word-first forms are unchanged", () => {
  for (const [args, word] of [[["--host", "tower", "drop"], "drop"], [["--host", "tower", "stop"], "stop"], [["--pod", "x", "ps"], "ps"], [["--no-sync", "--host", "tower", "gc", "--dry-run"], "gc"]] as const) {
    const r = runBox([...args]);
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(r.calls, [], "nothing asked of the host");
    assert.equal(r.out, "");
    assert.equal(r.err.trimEnd().split("\n").length, 1);
    assert.match(r.err, new RegExp(`^box: "${word}" is a box word and must come first: box ${word} .*; to run a program named ${word} in the box, put -- before it: box .* -- ${word}`));
  }
  assert.equal(runBox(["--host", "tower", "drop"]).err, `box: "drop" is a box word and must come first: box drop --host tower; to run a program named drop in the box, put -- before it: box --host tower -- drop\n`);
  // --shards and --detach build their own command from the same first word: refused the same way
  for (const extra of [["--shards", "2"], ["--detach"], ["--wait"], ["--pull", "x"], ["--image-file", "Containerfile"]]) {
    const r = runBox([...extra, "drop", "{shard}"]);
    assert.equal(r.code, 2, extra.join(" "));
    assert.deepEqual(r.calls, []);
  }
  const ok = runBox(["--host", "test", "--", "drop"]);
  assert.equal(ok.code, 0);
  assert.ok(ok.calls.some((c) => c === `ssh boxd-test pod run ${box} -- ${b64("drop")}`), ok.calls.join("\n"));
  assert.ok(runBox(["--host", "test", "--", "ps", "aux"]).calls.some((c) => c.endsWith(b64("ps", "aux"))));
  assert.ok(runBox(["--host", "test", "dropdb"]).calls.some((c) => c.endsWith(b64("dropdb"))));
  assert.ok(runBox(["--host", "test", "./drop"]).calls.some((c) => c.endsWith(b64("./drop"))));
  const word = runBox(["drop", "--host", "test"]);
  assert.notEqual(word.code, 2);
  assert.equal(word.err.includes("is a box word"), false);
});

// ---- 0.4.41: --wait keeps its place in line ---------------------------------------------------------------------------------------
const V41 = (status: string) => status.replace(/version=[^\t]+/, "version=0.4.41");
const queued = (rp: Repo, n: string, ...opts: string[]) => runLine(rp, n, ...opts).replace(" -- ", " --queued -- ");

test("--wait sends --queued to a server of 0.4.41 or later, and to no older one; without --wait never", () => {
  const s = servers([{ name: "tower", status: V41(FREE) }, { name: "laptop", status: FREE }]), rp = newRepo();
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rest(r.calls), [queued(rp, "tower", "--vm")]);
  const old = servers([{ name: "tower", status: FREE }, { name: "laptop", status: FREE }]), rq = newRepo();
  assert.deepEqual(rest(waits(rq, old, ["--no-sync", "--vm", "true"]).calls), [runLine(rq, "tower", "--vm")], "a server of 0.4.40 does not know the word");
  const plain = go(newRepo(), s, ["--no-sync", "--vm", "true"]), rp2 = rest(plain.calls);
  assert.ok(rp2.length === 1 && !rp2[0]?.includes("--queued"), "no --wait, no word");
  const newer = servers([{ name: "tower", status: FREE.replace(/version=[^\t]+/, "version=0.10.0") }, { name: "laptop", status: FREE }]), rn = newRepo();
  assert.deepEqual(rest(waits(rn, newer, ["--no-sync", "--vm", "true"]).calls), [queued(rn, "tower", "--vm")], "versions compare by number: 0.10.0 is after 0.4.41");
});

test("--wait: while pod status shows no room the call asks the server for its place, and a change of place is shown as changed reasons", () => {
  const s = servers([{ name: "tower", status: V41(FULL) }, { name: "laptop", status: FULL }]), rp = newRepo();
  hostFile(s, "tower", "status.3", `${V41(FREE)}\n`);
  hostFile(s, "tower", "queue.1", "boxd-pod: no room for another virtual machine now; first in line; busy now: a (since 10:00)\n");
  hostFile(s, "tower", "queue.2", "boxd-pod: no room for another virtual machine now; 1 call waits ahead of this one (since 09:00); busy now: a (since 10:00)\n");
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "box: waiting for room, asking every 0.001 seconds:\n  tower: 3 of 3 running\n  laptop: 3 of 3 running\n  tower: first in line; busy now: a (since 10:00)\n"
    + "box: the reasons changed: tower: 3 of 3 running; laptop: 3 of 3 running; tower: 1 call waits ahead of this one (since 09:00); busy now: a (since 10:00)\nbox: exit 0 on tower\n");
  assert.equal(r.calls.filter((c) => c.includes(" pod queue ")).length, 2, "the older server (laptop) is not asked");
  assert.ok(r.calls.every((c) => !c.includes("boxd-laptop") || c.endsWith(" pod status")));
  assert.ok(r.calls.some((c) => c.endsWith(` pod queue ${rp.box} vm large`)));
  assert.deepEqual(rest(r.calls).filter((c) => !c.includes(" pod queue ")), [queued(rp, "tower", "--vm")]);
});

test("a size above the whole cap of a host never fits it: the host is skipped for another that fits, and alone it is a refusal that does not wait", () => {
  const cap = (st: string, mb: number) => st.replace(/group_mem_max_mb=[^\t]*/, `group_mem_max_mb=${mb}`);
  const small = cap(fits("0"), 11410), big = cap(fits("20000"), 28672);
  const both = choose([{ name: "tower", state: "awake", status: small }, { name: "laptop", state: "awake", status: big }], { vm: true, size: "xlarge" });
  assert.equal(both.host, "laptop");
  const alone = one(small, { vm: true, size: "xlarge" });
  assert.deepEqual([alone.refusal, alone.wait], [["tower: 12288 MB never fits, the cap is 11410 MB"], false]);
  assert.equal(one(cap(fits("20000"), 12288), { vm: true, size: "xlarge" }).host, "tower", "equal to the cap fits");
});

test("--wait: a server that answers the final refusal (125) to pod queue ends the wait (when every server says so) with its line and code", () => {
  const s = servers([{ name: "tower", status: V41(FULL) }, { name: "laptop", status: V41(FULL) }]), rp = newRepo(), line = "boxd-pod: a machine of size large (16384 MB) never fits this host: its cap is 8192 MB; use a smaller --size here or another host";
  for (const h of ["tower", "laptop"]) hostFile(s, h, "queue.final", `${line}\n`);
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 125, r.err + r.calls.join("\n"));
  assert.ok(r.err.endsWith(`${line}\n`), r.err);
  assert.equal(r.calls.filter((c) => c.includes(" pod queue ")).length, 2, "each server asked once, not again");
  assert.ok(r.calls.every((c) => !c.includes(" pod run ")));
});

test("--wait: a refusal at the server with a place in it shows the place, and a changed place is a changed reason", () => {
  const s = servers([{ name: "tower", status: V41(FREE) }, { name: "laptop", status: FULL }]), rp = newRepo();
  writeFileSync(path.join(rp.cwd, ".git/boxd-host"), "tower\n");
  hostFile(s, "tower", "run.refuse", "2\n");
  hostFile(s, "tower", "refuse.line", "boxd-pod: no room for another virtual machine yet: 1 earlier call waits for it (a since 09:00); it is served in turn; 1 call waits ahead of this one (since 09:00); busy now: none\n");
  const r = waits(rp, s, ["--no-sync", "--vm", "true"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.err.includes("box: waiting for room, asking every 0.001 seconds:\n  tower: no room (the server refused the call); 1 call waits ahead of this one (since 09:00); busy now: none\n"), r.err);
  assert.equal(r.calls.filter((c) => c === runLine(rp, "tower", "--vm")).length, 1, "the first ask of a placed worktree comes before any probe, so before the version is known: no word");
  assert.equal(r.calls.filter((c) => c === queued(rp, "tower", "--vm")).length, 2);
});
