// Where the compiler is, for the tests that check the committed .mjs files are fresh: BOXD_TSC if set, else the owner's
// pnpm folder if the file is there, else tsc-rs on PATH. Undefined when none runs: the test is then skipped with a reason.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function find(): string | undefined {
  if (process.env.BOXD_TSC) return process.env.BOXD_TSC;
  const pnpm = path.join(process.env.HOME ?? "", ".local/share/pnpm/bin/tsc-rs");
  const c = existsSync(pnpm) ? pnpm : "tsc-rs";
  try { execFileSync(c, ["--version"], { stdio: "ignore" }); return c; } catch { return undefined; }
}

export const TSC = find();
export const NO_TSC = TSC ? false : "no tsc-rs: set BOXD_TSC to it, or put it on PATH";
