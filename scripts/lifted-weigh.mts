/**
 * A built map played by the lifted game with nobody at it, every trigger and record weighed for Remastered
 * (`compiler/remasteredCost.ts`), and by line when the build's map of triggers is beside it (<map>.triggers.json, from
 * build-fixture with TRIGGER_MAP=1). For scripts/weigh-map.mts and scripts/bench-lowering.mts.
 * Needs a scm-sim checkout beside this repository (or SCM_SIM_DIR) with its lifted game generated.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CostLines } from "../compiler/gameCost";
import type { TriggerMap } from "../compiler/gameVariables";
import { RemasteredWeigh } from "../compiler/remasteredCost";

/** A line's sums over the run. */
export interface WeighedLine { file: string; line: number; records: number; triggers: number; ns: number; frames: number }

export interface Weighed {
  from: number;
  /** Milliseconds, records and triggers a frame, everything the triggers ran. */
  ms: number[];
  records: number[];
  triggers: number[];
  /** By line, when the map of triggers was there. */
  lines: WeighedLine[];
}

/**
 * `byOrigin`: each record under the origin the build gave its trigger ("main.tsx:33:3", "fn:f_dwread_epd", "eudplib"), not
 * carried to the line before it: where the time goes, eudplib's own functions included. A line's `file` is then the origin.
 */
export async function playWeighed(map: string, frames: number, options: { byOrigin?: boolean } = {}): Promise<Weighed> {
  const root = resolve(import.meta.dirname, "..");
  const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
  if (!existsSync(join(sim, "src", "exact", "cost.ts"))) throw new Error(`no scm-sim checkout at ${sim} (set SCM_SIM_DIR)`);
  const from = (p: string) => import(pathToFileURL(join(sim, p)).href);
  const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
  const { exactMissing, startExactGame } = await from("src/exact/node.ts");
  const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
  const { installCost } = await from("src/exact/cost.ts");
  const missing = exactMissing() as string[];
  if (missing.length) throw new Error("the lifted game cannot run here; missing:\n  " + missing.join("\n  "));
  const dir = mkdtempSync(join(tmpdir(), "trigscript-weigh-"));
  try {
    const chk = Archive.open(new Uint8Array(readFileSync(map))).readFile("staredit\\scenario.chk") as Uint8Array;
    const chkPath = join(dir, "scenario.chk");
    writeFileSync(chkPath, classicScenario(chk));
    const run = await startExactGame(chkPath, { game: "ums" });
    const strings = placeStrings(run.lifted, chk);
    installEud(run.lifted, strings);
    const tap = installCost(run.lifted);
    if (!("weigh" in tap)) throw new Error("this scm-sim's cost tap does not weigh (it needs jeany55/scm-sim#24)");
    tap.weigh = new RemasteredWeigh(run.lifted.m);
    const mapPath = map.replace(/\.scx$/, ".triggers.json");
    const triggerMap = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) as TriggerMap : null;
    const lines = triggerMap && !options.byOrigin ? new CostLines(triggerMap, 0x191943c8 + strings.bytes) : null;
    if (lines) tap.group = lines.group;
    const origins: string[] = [];
    if (triggerMap && options.byOrigin) {
      const ids = new Map<string, number>(), byRecord = new Map<number, number>();
      const start = 0x191943c8 + strings.bytes - triggerMap.payload;
      for (const [offset, conditions, actions, origin] of triggerMap.triggers) {
        const key = origin || "(no origin)";
        let id = ids.get(key);
        if (id === undefined) { id = origins.length; origins.push(key); ids.set(key, id); }
        for (let i = 0; i < conditions; i++) byRecord.set(start + offset + 8 + 20 * i, id);
        for (let i = 0; i < actions; i++) byRecord.set(start + offset + 8 + 320 + 32 * i, id);
      }
      tap.group = (record: number) => byRecord.get(record) ?? -1;
    }
    while (!run.engine.done && run.engine.game.frame < frames) run.engine.step([], null);
    const r = tap.report(0);
    const out: Weighed = { from: r.from, ms: r.ns.map((n: number) => n / 1e6), records: r.conditions.map((c: number, i: number) => c + r.actions[i]), triggers: [...r.triggers], lines: [] };
    for (const [g, k] of r.groups as Map<number, { conditions: number; actions: number; triggers: number; ns: number; frames: number }>) {
      const where = lines ? lines.places[g] : origins[g] !== undefined ? { file: origins[g], line: 0 } : undefined;
      if (where) out.lines.push({ ...where, records: k.conditions + k.actions, triggers: k.triggers, ns: k.ns, frames: k.frames });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
