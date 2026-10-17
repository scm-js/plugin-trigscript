/**
 * A script played in the lifted game and held against what Remastered is known to allow (TrigScript 4, A1):
 * built as Save builds it with the map of triggers on (scripts/build-fixture.mts, TRIGGER_MAP=1), played with nobody
 * at it by a scm-sim checkout's scripts/exact-eud.ts (its lifted game, EUD let through, nothing drawn), and every
 * dword the run read or wrote checked against data/allowlist.json, line by line.
 *
 *   npx tsx scripts/game-check.mts <script.ts | built.scx> [--frames=N] [--allowlist=path] [--cost=out.json] [map.scx]
 *
 * A built map is taken as it is, with its <name>.triggers.json beside it when there is one. Needs a scm-sim
 * checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated; says so when it is not there.
 * Exits 1 when the run touched something Remastered ends the game on, or a probe line came out not as expected.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { checkTrace, describeFinding, type Allowlist, type Trace } from "../compiler/allowlist";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [input, baseMap] = args.filter((a) => !a.startsWith("--"));
if (!input || !existsSync(input)) { console.error("usage: game-check.mts <script.ts | built.scx> [--frames=N] [--allowlist=path] [map.scx]"); process.exit(2); }
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "scripts", "exact-eud.ts"))) { console.error(`no scm-sim checkout with scripts/exact-eud.ts at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }
const list = JSON.parse(readFileSync(flag("allowlist") ?? join(root, "data", "allowlist.json"), "utf8")) as Allowlist;

const dir = mkdtempSync(join(tmpdir(), "trigscript-game-"));
try {
  let map = resolve(input);
  if (/\.tsx?$/.test(input)) {
    map = join(dir, basename(input).replace(/\.tsx?$/, "") + ".scx");
    const built = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), resolve(input), map, ...(baseMap ? [resolve(baseMap)] : [])], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, TRIGGER_MAP: "1" } });
    if (built.status !== 0) { console.error(built.stdout.split("\n").slice(-20).join("\n"), built.stderr); process.exit(1); }
  }
  const tracePath = join(dir, "trace.json");
  const run = spawnSync("node", ["--experimental-strip-types", join(sim, "scripts", "exact-eud.ts"), map, `--frames=${flag("frames") ?? 3000}`, "--quiet", `--trace=${tracePath}`, ...(flag("cost") ? [`--cost=${resolve(flag("cost")!)}`] : [])], { cwd: sim, encoding: "utf8", maxBuffer: 256 << 20 });
  process.stdout.write(run.stdout.split("\n").filter((l) => !/^pages (read|written):/.test(l)).join("\n"));
  if (!existsSync(tracePath)) { console.error(run.stderr || "the run left no trace"); process.exit(1); }
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as Trace;
  const { findings, counted } = checkTrace(trace, list);
  console.log(`\nRemastered: ${trace.rows.length} distinct accesses — ${counted.own} the map's own memory, ${counted.heap} eudplib in the game's heap, ${counted.allowed} known allowed, ${counted.ends} ending the game, ${counted.ignored} ignored, ${counted.unknown} never seen`);
  for (const f of findings) console.log(`  ${f.verdict === "ends" ? "ENDS THE GAME" : f.verdict === "ignored" ? "IGNORED" : "not seen"}  ${describeFinding(f)}`);
  if (findings.some((f) => f.verdict === "ends") || run.status !== 0) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
