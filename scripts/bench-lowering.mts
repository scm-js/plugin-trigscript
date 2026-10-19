/**
 * The lowering bench (TrigScript 4, cheaper lowering): builds probes/lowering-bench.ts, plays it in the lifted game,
 * and says what one turn of each line costs Remastered — records, triggers and nanoseconds — against the numbers kept
 * in probes/lowering-bench.baseline.json.
 *
 *   npx tsx scripts/bench-lowering.mts [--frames=N] [--save]
 *
 * Built as a build is (the emitter on; EMITTER=0 for the Python side's lowering alone): a trigger of the emitter's that
 * holds several lines' work says each action's line, so a line's number is its own.
 *
 * --save writes this run's numbers as the new baseline. Needs a plugin-eudplib checkout and a scm-sim checkout beside
 * this repository (or EUDPLIB_DIR / SCM_SIM_DIR), as build-fixture and the lifted game do.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { playWeighed } from "./lifted-weigh.mts";

const root = resolve(import.meta.dirname, "..");
const flag = (n: string) => process.argv.slice(2).find((a) => a === `--${n}` || a.startsWith(`--${n}=`))?.split("=")[1] ?? (process.argv.includes(`--${n}`) ? "" : undefined);
const script = join(root, "probes", "lowering-bench.ts");
// (Built into a folder of its own: fixtures/ holds the base maps everything shares.)
const built = join(mkdtempSync(join(tmpdir(), "lowering-bench-")), "lowering-bench.scx");
const baselinePath = join(root, "probes", "lowering-bench.baseline.json");

const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), script, built], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, TRIGGER_MAP: "1" } });
if (b.status !== 0) { console.error(b.stdout.split("\n").slice(-20).join("\n"), b.stderr); process.exit(1); }

// The lines and what they are: a /* LABEL */ at a line's end; R, the turns a frame of the loop.
const source = readFileSync(script, "utf8").split("\n");
const turns = Number(/const R = (\d+)/.exec(source.join("\n"))?.[1] ?? 1);
const labels = new Map<number, string>();
source.forEach((text, i) => { const m = /\/\* ([A-Z_]+) \*\/\s*$/.exec(text); if (m) labels.set(i + 1, m[1]); });
const once = new Set(["UNITS", "LIST_LOOP", "ARRAY_LOOP", "ARRAY_LOOP_WRITE", "LIST_LOOP_WRITE", "EMPTY_LOOP"]);  // lines outside the bench's loop: once a frame

const w = await playWeighed(built, Number(flag("frames") ?? 40));
interface Row { records: number; triggers: number; ns: number }
const rows: Record<string, Row> = {};
for (const l of w.lines) {
  const label = labels.get(l.line);
  if (!label || l.file !== "main.ts" || !l.frames) continue;
  const per = l.frames * (once.has(label) ? 1 : turns);
  rows[label] = { records: l.records / per, triggers: l.triggers / per, ns: l.ns / per };
}
const base: Record<string, Row> = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const pad = (s: string, n: number) => s.padStart(n);
console.log(`a turn of each line (${turns} turns a frame; UNITS once a frame), in the lifted game, weighed for Remastered:`);
console.log(`${"line".padEnd(13)}${pad("records", 9)}${pad("triggers", 10)}${pad("ns", 9)}${pad("baseline ns", 13)}${pad("change", 9)}`);
let total = 0, totalBase = 0;
for (const label of labels.values()) {
  const r = rows[label], was = base[label];
  if (!r) { console.log(`${label.padEnd(13)}  (did not run)`); continue; }
  total += r.ns; if (was) totalBase += was.ns;
  const change = was ? `${(((r.ns - was.ns) / was.ns) * 100).toFixed(0)}%` : "";
  console.log(`${label.padEnd(13)}${pad(r.records.toFixed(1), 9)}${pad(r.triggers.toFixed(1), 10)}${pad(r.ns.toFixed(0), 9)}${pad(was ? was.ns.toFixed(0) : "", 13)}${pad(change, 9)}`);
}
if (totalBase) console.log(`all lines: ${total.toFixed(0)} ns, baseline ${totalBase.toFixed(0)} ns (${(((total - totalBase) / totalBase) * 100).toFixed(0)}%)`);
if (flag("save") !== undefined) { writeFileSync(baselinePath, JSON.stringify(rows, null, 1) + "\n"); console.log(`saved as the baseline: ${baselinePath}`); }
