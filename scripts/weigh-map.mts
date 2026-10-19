/**
 * What each frame of a built map costs Remastered, in time (TrigScript 4, cost step 1): the map played by the lifted
 * game with nobody at it, every trigger and record weighed by `compiler/remasteredCost.ts`.
 *
 *   npx tsx scripts/weigh-map.mts <built.scx> [--frames=N] [--json=out.json]
 *
 * Prints the frames' average and costliest, and the costliest lines when the build's map of triggers is beside the
 * map; with --json writes the series (ms, records and triggers a frame) and the lines.
 * Needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated.
 */
import { existsSync, writeFileSync } from "node:fs";
import { MOST_MS, SMOOTH_MS } from "../compiler/remasteredCost";
import { playWeighed } from "./lifted-weigh.mts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const map = args[0];
if (!map || !existsSync(map)) { console.error("usage: weigh-map.mts <built.scx> [--frames=N] [--json=out.json]"); process.exit(2); }
const w = await playWeighed(map, Number(flag("frames") ?? 600));
const ran = w.ms.filter((x) => x > 0), peak = Math.max(0, ...w.ms), at = w.ms.indexOf(peak);
console.log(`${map}: ${w.ms.length} frames; ${(ran.reduce((a, b) => a + b, 0) / Math.max(1, ran.length)).toFixed(2)} ms a frame on average where anything ran, ${peak.toFixed(2)} ms at the most (frame ${at}: ${w.records[at]} records, ${w.triggers[at]} triggers)`);
console.log(`  Remastered on a fast computer: smooth to about ${SMOOTH_MS} ms of triggers a frame, slows past ${MOST_MS.toFixed(0)} ms`);
for (const l of [...w.lines].sort((a, b) => b.ns - a.ns).slice(0, 8)) console.log(`  ${l.file}:${l.line}: ${(l.ns / 1e6 / Math.max(1, l.frames)).toFixed(3)} ms a frame it ran in (${l.frames} frames; ${Math.round(l.records / Math.max(1, l.frames))} records, ${Math.round(l.triggers / Math.max(1, l.frames))} triggers)`);
const out = flag("json");
if (out) writeFileSync(out, JSON.stringify(w));
