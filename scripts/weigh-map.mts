/**
 * What each frame of a built map costs Remastered, in time (TrigScript 4, cost step 1): the map played by the lifted
 * game with nobody at it, every trigger and record weighed by `compiler/remasteredCost.ts`.
 *
 *   npx tsx scripts/weigh-map.mts <built.scx> [--frames=N] [--json=out.json]
 *
 * Prints the frames' average and costliest, and with --json writes the series (ms, records and triggers a frame).
 * Needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MOST_MS, RemasteredWeigh, SMOOTH_MS } from "../compiler/remasteredCost";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const map = args[0];
if (!map || !existsSync(map)) { console.error("usage: weigh-map.mts <built.scx> [--frames=N] [--json=out.json]"); process.exit(2); }
const root = resolve(import.meta.dirname, "..");
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
if (!existsSync(join(sim, "src", "exact", "cost.ts"))) { console.error(`no scm-sim checkout at ${sim} (set SCM_SIM_DIR)`); process.exit(2); }
const from = (p: string) => import(pathToFileURL(join(sim, p)).href);

const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
const { exactMissing, startExactGame } = await from("src/exact/node.ts");
const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
const { installCost } = await from("src/exact/cost.ts");
const missing = exactMissing() as string[];
if (missing.length) { console.error("the lifted game cannot run here; missing:\n  " + missing.join("\n  ")); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "trigscript-weigh-"));
try {
  const chk = Archive.open(new Uint8Array(readFileSync(map))).readFile("staredit\\scenario.chk") as Uint8Array;
  const chkPath = join(dir, "scenario.chk");
  writeFileSync(chkPath, classicScenario(chk));
  const run = await startExactGame(chkPath, { game: "ums" });
  installEud(run.lifted, placeStrings(run.lifted, chk));
  const tap = installCost(run.lifted);
  if (!("weigh" in tap)) { console.error("this scm-sim's cost tap does not weigh (it needs the frame-weights change)"); process.exit(1); }
  tap.weigh = new RemasteredWeigh(run.lifted.m);
  const frames = Number(flag("frames") ?? 600);
  while (!run.engine.done && run.engine.game.frame < frames) run.engine.step([], null);
  const r = tap.report(0);
  const ms = (r.ns as number[]).map((n) => n / 1e6);
  const records = (r.conditions as number[]).map((c, i) => c + r.actions[i]);
  const ran = ms.filter((x) => x > 0), peak = Math.max(0, ...ms), at = ms.indexOf(peak);
  console.log(`${map}: ${ms.length} frames; ${(ran.reduce((a, b) => a + b, 0) / Math.max(1, ran.length)).toFixed(2)} ms a frame on average where anything ran, ${peak.toFixed(2)} ms at the most (frame ${at}: ${records[at]} records, ${r.triggers[at]} triggers)`);
  console.log(`  Remastered on a fast computer: smooth to about ${SMOOTH_MS} ms of triggers a frame, slows past ${MOST_MS.toFixed(0)} ms`);
  const out = flag("json");
  if (out) writeFileSync(out, JSON.stringify({ map, from: r.from, ms, records, triggers: r.triggers }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
