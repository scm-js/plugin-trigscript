/**
 * Where a built map's trigger time goes, by the shape of the triggers the walk passed (TrigScript 4, the limits: what a
 * backend of our own could take away). Plays the map in the lifted game with nobody at it, weighed for Remastered
 * (`compiler/remasteredCost.ts`), and sorts every trigger the walk passed:
 *
 * - **silent**: it ran nothing — a jump (an empty trigger whose next pointer was set), or one finished;
 * - **failed**: its conditions failed, so none of its actions ran;
 * - **ran**: its actions ran; by how many, and whether it had conditions.
 *
 * and says what a packer could take: a run of triggers one after another that each ran every action and had no
 * condition, merged into one, pays one trigger, not one each (an upper bound: a trigger something jumps into cannot
 * be merged into the one before it).
 *
 *   npx tsx scripts/trigger-shapes.mts <built.scx> [--frames=N] [--from=N]
 *
 * --from: count from that frame (a script's first frames are its setup). Needs a scm-sim checkout beside this
 * repository (or SCM_SIM_DIR) with its lifted game generated.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RemasteredWeigh } from "../compiler/remasteredCost";
import type { TriggerMap } from "../compiler/gameVariables";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const map = resolve(args[0]);
const frames = Number(flag("frames") ?? 40), countFrom = Number(flag("from") ?? 0);
const root = resolve(import.meta.dirname, "..");
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
const from = (p: string) => import(pathToFileURL(join(sim, p)).href);
const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
const { startExactGame } = await from("src/exact/node.ts");
const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
const { installCost } = await from("src/exact/cost.ts");

const dir = mkdtempSync(join(tmpdir(), "trigger-shapes-"));
const chk = Archive.open(new Uint8Array(readFileSync(map))).readFile("staredit\\scenario.chk") as Uint8Array;
writeFileSync(join(dir, "scenario.chk"), classicScenario(chk));
const run = await startExactGame(join(dir, "scenario.chk"), { game: "ums" });
rmSync(dir, { recursive: true, force: true });
const strings = placeStrings(run.lifted, chk);
installEud(run.lifted, strings);
const tap = installCost(run.lifted);
const m: DataView = run.lifted.m;
const inner = new RemasteredWeigh(m);

// Each trigger's origin, from the build's map of triggers when it is beside the map.
const mapPath = map.replace(/\.scx$/, ".triggers.json");
const origin = new Map<number, string>();
if (existsSync(mapPath)) {
  const tm = JSON.parse(readFileSync(mapPath, "utf8")) as TriggerMap;
  const start = 0x191943c8 + strings.bytes - tm.payload;
  for (const [offset, , , o] of tm.triggers) origin.set(start + offset, o || "(none)");
}

/** A trigger's own slots as they are in memory: conditions up to the first empty one, actions likewise. */
const shape = (t: number): { conds: number; acts: number } => {
  let conds = 0, acts = 0;
  if (t + 2400 > m.byteLength) return { conds, acts };
  while (conds < 16 && m.getUint8(t + 8 + 20 * conds + 15) !== 0) conds++;
  while (acts < 64 && m.getUint8(t + 8 + 320 + 32 * acts + 26) !== 0) acts++;
  return { conds, acts };
};

interface Visit { t: number; conds: number; acts: number; ns: number; trigNs: number }
/** Every Set Deaths run, by the address it wrote and what it cost, sorted afterwards into routing and data. */
const writes = new Map<number, { n: number; ns: number }>();
const visited = new Set<number>();
const counting = () => run.lifted.frame() >= countFrom;
let visit: Visit | null = null;
const totals = { triggers: 0, records: 0, ns: 0, trigNs: 0 };
const kinds = new Map<string, { n: number; ns: number; trigNs: number }>();
const byOrigin = new Map<string, { triggers: number; silent: number; ns: number; trigNs: number }>();
let runLen = 0, mergeable = 0, mergeableNs = 0;
const bump = (k: string, v: Visit) => { const x = kinds.get(k) ?? { n: 0, ns: 0, trigNs: 0 }; x.n++; x.ns += v.ns; x.trigNs += v.trigNs; kinds.set(k, x); };
const finish = (v: Visit) => {
  const s = shape(v.t);
  totals.triggers++; totals.records += v.conds + v.acts; totals.ns += v.ns; totals.trigNs += v.trigNs;
  const silent = v.conds + v.acts === 0;
  const kind = silent ? "silent" : v.acts === 0 ? "failed" : `ran ${v.acts === 1 ? "1 action" : v.acts <= 4 ? "2-4 actions" : v.acts <= 16 ? "5-16 actions" : "17+ actions"}${s.conds ? ", with conditions" : ""}`;
  bump(kind, v);
  const o = origin.get(v.t) ?? "(outside the map of triggers)";
  const k = byOrigin.get(o) ?? { triggers: 0, silent: 0, ns: 0, trigNs: 0 };
  k.triggers++; if (silent) k.silent++; k.ns += v.ns; k.trigNs += v.trigNs;
  byOrigin.set(o, k);
  // A run of unconditional triggers that each ran all their actions: all but the first could be merged into it.
  const plain = !silent && s.conds === 0 && v.acts === s.acts;
  if (plain) { if (runLen > 0) { mergeable++; mergeableNs += v.trigNs; } runLen++; } else runLen = 0;
};
tap.weigh = {
  trigger(t: number) {
    const ns = inner.trigger(t);
    if (!counting()) return ns;
    if (visit) finish(visit);
    visited.add(t);
    visit = { t, conds: 0, acts: 0, ns, trigNs: ns };
    return ns;
  },
  record(record: number, type: number, action: boolean) {
    const ns = inner.record(record, type, action);
    if (visit && counting()) {
      if (action) visit.acts++; else visit.conds++;
      visit.ns += ns;
      if (action && type === 45) {
        const addr = (0x58a364 + 4 * (m.getUint32(record + 16, true) + 12 * m.getUint16(record + 24, true))) >>> 0;
        const w = writes.get(addr) ?? { n: 0, ns: 0 };
        w.n++; w.ns += ns;
        writes.set(addr, w);
      }
    }
    return ns;
  },
  reset() { inner.reset?.(); },
};
while (!run.engine.done && run.engine.game.frame < frames) run.engine.step([], null);
if (visit) finish(visit);

const n = Math.max(1, frames - countFrom);
const ms = (ns: number) => (ns / 1e6 / n).toFixed(3);
console.log(`${map}: frames ${countFrom}–${frames}, a frame on average:`);
console.log(`  ${ms(totals.ns)} ms; ${(totals.triggers / n).toFixed(0)} triggers, ${(totals.records / n).toFixed(0)} records; the walk alone ${ms(totals.trigNs)} ms (${((totals.trigNs / totals.ns) * 100).toFixed(0)}%)`);
console.log(`  merging runs of plain triggers would save at most ${ms(mergeableNs)} ms (${(mergeable / n).toFixed(0)} triggers)`);
// A write into another trigger: its next pointer (+4), the first action's destination (+344, a cell's: eudplib's
// variables are triggers of one action), its modifier (+352, the byte at +355); its value (+348) is data.
const routing = { next: { n: 0, ns: 0 }, dest: { n: 0, ns: 0 }, mod: { n: 0, ns: 0 } }, data = { cell: { n: 0, ns: 0 }, other: { n: 0, ns: 0 } };
const into = (k: { n: number; ns: number }, w: { n: number; ns: number }) => { k.n += w.n; k.ns += w.ns; };
for (const [a, w] of writes) {
  if (visited.has(a - 4)) into(routing.next, w);
  else if (visited.has(a - 344)) into(routing.dest, w);
  else if (visited.has(a - 352)) into(routing.mod, w);
  else if (visited.has(a - 348)) into(data.cell, w);
  else into(data.other, w);
}
console.log("Set Deaths by what it wrote:");
for (const [k, v] of Object.entries({ "routing: a next pointer": routing.next, "routing: a cell's destination": routing.dest, "routing: a cell's modifier": routing.mod, "data: a cell's value": data.cell, "data: anything else": data.other })) console.log(`  ${k.padEnd(34)} ${(v.n / n).toFixed(0).padStart(8)} a frame  ${ms(v.ns).padStart(7)} ms`);
console.log("by what the trigger did:");
for (const [k, v] of [...kinds].sort((a, b) => b[1].ns - a[1].ns)) console.log(`  ${k.padEnd(34)} ${(v.n / n).toFixed(0).padStart(8)} a frame  ${ms(v.ns).padStart(7)} ms (walk ${ms(v.trigNs)})`);
console.log("by origin, the costliest:");
for (const [k, v] of [...byOrigin].sort((a, b) => b[1].ns - a[1].ns).slice(0, 20)) console.log(`  ${k.slice(0, 40).padEnd(40)} ${ms(v.ns).padStart(7)} ms  ${(v.triggers / n).toFixed(0).padStart(7)} triggers (${(v.silent / n).toFixed(0)} silent), walk ${ms(v.trigNs)}`);
