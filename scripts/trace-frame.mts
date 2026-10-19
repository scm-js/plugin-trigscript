/**
 * Every trigger the walk passed in one frame of a built map, in order (TrigScript 4, the limits): where it is, its
 * origin from the build's map of triggers, what it ran — conditions and actions by type — and what Remastered's
 * weights say it cost. To see what a statement is made of before changing what it is made of.
 *
 *   npx tsx scripts/trace-frame.mts <built.scx> --frame=N [--origin=main.ts:12] [--most=400] [--wide]
 *
 * --origin keeps the triggers whose origin starts with it and the ones run between two of them (eudplib's variables,
 * which carry no origin of their own). --wide prints each origin whole. Needs a scm-sim checkout (SCM_SIM_DIR) with its lifted game generated.
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
const frame = Number(flag("frame") ?? 30), most = Number(flag("most") ?? 400), want = flag("origin");
const root = resolve(import.meta.dirname, "..");
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
const from = (p: string) => import(pathToFileURL(join(sim, p)).href);
const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
const { startExactGame } = await from("src/exact/node.ts");
const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
const { installCost } = await from("src/exact/cost.ts");

const dir = mkdtempSync(join(tmpdir(), "trace-frame-"));
const chk = Archive.open(new Uint8Array(readFileSync(map))).readFile("staredit\\scenario.chk") as Uint8Array;
writeFileSync(join(dir, "scenario.chk"), classicScenario(chk));
const run = await startExactGame(join(dir, "scenario.chk"), { game: "ums" });
rmSync(dir, { recursive: true, force: true });
const strings = placeStrings(run.lifted, chk);
installEud(run.lifted, strings);
const tap = installCost(run.lifted);
const m: DataView = run.lifted.m;
const inner = new RemasteredWeigh(m);
const origin = new Map<number, string>();
const mapPath = map.replace(/\.scx$/, ".triggers.json");
if (existsSync(mapPath)) {
  const tm = JSON.parse(readFileSync(mapPath, "utf8")) as TriggerMap;
  const start = 0x191943c8 + strings.bytes - tm.payload;
  for (const [offset, , , o] of tm.triggers) origin.set(start + offset, o || "(none)");
}
const CONDS: Record<number, string> = { 15: "Deaths", 11: "Switch", 22: "Always", 23: "Never", 3: "Bring", 2: "Command" };
const ACTS: Record<number, string> = { 45: "SetDeaths", 13: "SetSwitch", 3: "Preserve", 9: "Text", 47: "Comment" };

interface Row { t: number; ns: number; recs: string[] }
const rows: Row[] = [];
let cur: Row | null = null;
const on = () => run.lifted.frame() === frame;
tap.weigh = {
  trigger(t: number) { const ns = inner.trigger(t); if (on()) { cur = { t, ns, recs: [] }; rows.push(cur); } return ns; },
  record(r: number, type: number, action: boolean) {
    const ns = inner.record(r, type, action);
    if (on() && cur) {
      let what = action ? ACTS[type] ?? `act${type}` : CONDS[type] ?? `cond${type}`;
      if (type === 15 || type === 45) {
        // Where a Deaths / Set Deaths reads or writes: player + 12 × unit, from 0x58A364 (EPD), and whether masked.
        const base = action ? r : r;
        const player = m.getUint32(base + (action ? 16 : 4), true), unit = m.getUint16(base + (action ? 24 : 12), true);
        const addr = (0x58a364 + 4 * (player + 12 * unit)) >>> 0;
        const amount = m.getUint32(base + (action ? 20 : 8), true);
        const mod = action ? ["", "", "", "", "", "", "", "=", "+", "-"][m.getUint8(base + 27)] ?? "?" : ["≥", "≤", "", "", "", "", "", "", "", "", "=="][m.getUint8(base + 14)] ?? "?";
        what += ` ${addr.toString(16)}${mod}${amount.toString(16)}`;
      }
      cur.recs.push(what);
      cur.ns += ns;
    }
    return ns;
  },
  reset() { inner.reset?.(); },
};
while (!run.engine.done && run.engine.game.frame <= frame) run.engine.step([], null);

let keep = !want;
let shown = 0, total = 0;
for (const r of rows) {
  const o = origin.get(r.t);
  if (want) { if (o?.startsWith(want)) keep = true; else if (o && o !== "eudplib" && !o.startsWith("fn:")) keep = false; }
  total += r.ns;
  if (!keep || shown >= most) continue;
  shown++;
  const shownOrigin = process.argv.includes("--wide") ? (o ?? "·").replace(/ /g, "_").padEnd(36) : (o ?? "·").padEnd(16).slice(0, 16);
  console.log(`${r.t.toString(16)} ${shownOrigin} ${r.ns.toFixed(1).padStart(6)}  ${r.recs.join("; ") || "(nothing)"}`);
}
console.log(`frame ${frame}: ${rows.length} triggers, ${(total / 1e3).toFixed(2)} µs`);
