# Contributing to boxd

boxd gives every git worktree its own box (a container or a virtual machine) on a build server you own. Bug reports,
fixes, documentation corrections and small, focused features are welcome. For a large change, open an issue first so the
direction can be agreed before you write code.

## Report a bug

Open an issue with the bug report form. A report is usable when it has:

- the exact `box` or `pod` command you ran;
- the exact refusal or error line, copied, not described;
- the output of `box --version`;
- the output of `box hosts`, with the machine names replaced;
- the distribution of the build server (Void Linux, Debian 13 or other) and the engine of the box.

Never paste a secret. Replace machine names and addresses you do not want public.

Security problems do not go into a public issue. Use the "Security" tab of the repository, then "Report a
vulnerability" (see `SECURITY.md`).

## Set up and run the checks

The sources are TypeScript, compiled with `tsc-rs`: a Rust port of the TypeScript compiler with the same command line
as `tsc`, so the official `tsc` works too. The compiled `.mjs` files (`client/box.mjs`, `client/box-wake.mjs`,
`dashboard/fleet.mjs`, `dashboard/boxd-dashboard.mjs` and the page modules in `dashboard/web/`) are committed. When you
change a `.mts` file, compile and commit its `.mjs` in the same change. A test checks that they are fresh when it can
find the compiler (`BOXD_TSC`, or `tsc-rs` on the path); without a compiler it is skipped.

```sh
pnpm install                  # once: the Node type definitions
tsc-rs -p client              # type check and emit the client
tsc-rs -p dashboard           # type check and emit the dashboard
node --test tests/*.test.mts  # the Node tests (the workflow uses Node 24)
sh tools/test-shell           # the shell tests that need no real host and no sudo
```

The shell tests need `jq`, `git` and `rsync`. The last two commands run on every push and pull request
(`.github/workflows/test.yml`). `docs/development.md` lists every test, including the ones that need a real host.

## Conventions

- A change ships with its tests, in the same change. A bug fix ships a test that fails while the bug is present.
- A change in behavior gets an entry at the top of `CHANGELOG.md`, in the style of the entries there.
- History is linear: rebase on `main`, no merge commits.
- Shell: the scripts in `tools/` and most of `server/` are POSIX `sh` and stay so. `server/boxd-pod`, `tools/host-watch`
  and `tests/*.sh` use bash.
- Write plain, short sentences. Spell words out. Keep names and commands exact.
- Keep machine names, addresses and secrets out of code, tests, documents and commit messages.

## Pull requests

Keep one concern in each pull request. The pull request form asks what changes, how you tested it, and whether the
changelog needs an entry.
