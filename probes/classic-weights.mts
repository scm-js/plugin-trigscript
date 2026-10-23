/**
 * The classic weights probe (TrigScript 4, the limits): what a condition, an action and a trigger cost Remastered in a
 * map that is not an EUD map — the same yardsticks as probes/frame-weights.py, without the emulator.
 *
 *   npx tsx probes/classic-weights.mts [out.scx] [base map.scx]     (default fixtures/eud/classic-weights.scx)
 *   npx tsx probes/classic-weights.mts --json                        (the phase table, for the report)
 *
 * Why (read in Ghidra, Remastered 1.23.10.13515, 2026-10-19): a map is an EUD map when, as it loads (+0x358C0A, every
 * trigger 0x960 bytes apart), some Deaths condition or Set Deaths action of it names a player above 26 or 12 itself,
 * or a unit above 232 (+0x2E17E0; bit 1 for conditions, bit 2 for actions, at +0x105423C). Only then does the trigger
 * walk (+0x41B350) go through the emulator for each trigger and its next pointer, and Deaths / Set Deaths through its
 * regions. Otherwise the walk follows the game's own list and Set Deaths writes the deaths table straight, refusing
 * players above 8 and units above 227 (+0x288240). Nothing loops in such a map: what a pass runs is what the map has,
 * so the mixes are blocks of triggers turned on and off, and a pass comes every other frame (hyper triggers).
 *
 * Built from the editor's own code (a scm-js checkout beside this repository, or SCMJS_DIR) — no eudplib. Play it alone,
 * single player, at Fastest, with remastered/profile.py --marks-player=8 (scm-sim-reader) running; press nothing.
 *
 * Marks, as deaths of Player 8 (the highest player a map that is not EUD may write):
 *   unit 220: MAGIC     unit 221: the phase (DONE when the schedule is over)     unit 222: the passes since the start
 *   unit 223: passes into this phase     units 200-205: a block on (1) or off (0)     unit 206: actions on (1) or off
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ActionType, Comparison, ConditionType, emptyAction, emptyCondition, emptyTrigger, SetModifier, SwitchAction,
  type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { hyperTriggers } from "../compiler/lower";

const PASSES = 96; // a phase: 96 passes, 8 game seconds at a pass every other frame
const MAGIC = 0x57e16475, DONE = 0xffff;
const P1 = 0, P2 = 1, P7 = 6, P8 = 7;
const MARK = { magic: 220, phase: 221, passes: 222, inPhase: 223, actions: 206 };
/** The blocks: the cond/act block in two halves, the switch block in two halves. */
const BLOCK = { x1: 200, x2: 201, s1: 202, s2: 203 };
const X_HALF = 1500, S_HALF = 1000;

/** Each phase: what is on. `x` is the cond/act block: its halves, and whether its actions run. */
interface Phase { name: string; on: number[]; actions?: boolean }
const idle = (): Phase => ({ name: "idle", on: [] });
const PHASES: Phase[] = [
  idle(), idle(),
  { name: "cond16 1500", on: [BLOCK.x1] }, { name: "cond16 3000", on: [BLOCK.x1, BLOCK.x2] },
  { name: "act62 1500", on: [BLOCK.x1], actions: true }, { name: "act62 3000", on: [BLOCK.x1, BLOCK.x2], actions: true },
  idle(),
  { name: "switch62 1000", on: [BLOCK.s1] }, { name: "switch62 2000", on: [BLOCK.s1, BLOCK.s2] },
  idle(),
];

if (process.argv.includes("--json")) {
  // Records a pass of each phase, as designed: the cond/act block evaluates 16 conditions a trigger (the last fails while
  // actions are off), then 62 Set Deaths and a Preserve Trigger; the switch block 1 condition, 62 Set Switch, a Preserve.
  const rows = PHASES.map((p, phase) => {
    const x = p.on.filter((b) => b === BLOCK.x1 || b === BLOCK.x2).length * X_HALF;
    const s = p.on.filter((b) => b === BLOCK.s1 || b === BLOCK.s2).length * S_HALF;
    return { phase, name: p.name, triggersOn: x + s, conditions: x * 16 + s, actions: (p.actions ? x * 63 : 0) + s * 63 };
  });
  console.log(JSON.stringify({ passes: PASSES, magic: MAGIC, done: DONE, markPlayer: 8, phases: rows }));
  process.exit(0);
}

const deaths = (player: number, unitId: number, comparison: number, amount: number): ConditionRecord =>
  ({ ...emptyCondition(), type: ConditionType.Deaths, player, unitId, comparison, amount });
const setDeaths = (player: number, unitId: number, modifier: number, amount: number): ActionRecord =>
  ({ ...emptyAction(), type: ActionType.SetDeaths, player, unitId, modifier, target: amount });
const preserve = (): ActionRecord => ({ ...emptyAction(), type: ActionType.PreserveTrigger });
const trigger = (conditions: ConditionRecord[], actions: ActionRecord[], preserved = true): TriggerRecord => {
  const t = emptyTrigger();
  t.players[P1] = 1;
  t.conditions = conditions;
  t.actions = preserved ? [...actions, preserve()] : actions;
  return t;
};
const mark = (unit: number) => [P8, unit] as const;

const root = resolve(import.meta.dirname, "..");
const outPath = resolve(process.argv[2] ?? join(root, "fixtures", "eud", "classic-weights.scx"));
const mapPath = resolve(process.argv[3] ?? join(root, "fixtures", "maps", "(2)Binary Burghs.scx"));
const EDITOR = resolve(process.env.SCMJS_DIR ?? join(root, "..", "scm-js"));
const { loadMap, saveMap, readExtras } = await import(join(EDITOR, "src", "formats", "mpq", "scm.ts"));
const { parseScenario, serializeScenario, markDirty, setMapVersion } = await import(join(EDITOR, "src", "formats", "chk", "scenario.ts"));
const { internString, patchPlayer } = await import(join(EDITOR, "src", "editor", "settings.ts"));
const loaded = await loadMap(new Uint8Array(readFileSync(mapPath)));
const scn = parseScenario(loaded.chk);
// A Remastered file (VER 206, STRx), as the EUD probes are: the lifted game's runner places the strings from STRx.
setMapVersion(scn, "remastered");
patchPlayer(scn, 0, { type: 6, race: 1, force: 0 });
patchPlayer(scn, 1, { type: 5, race: 0, force: 1 });
const text = (s: string) => internString(scn, s);
const display = (s: string): ActionRecord => ({ ...emptyAction(), type: ActionType.DisplayText, text: text(s), flags: 4 });

const triggers: TriggerRecord[] = [];
// The clock, first: the marks, a pass counted, the phase moved on after PASSES of them.
triggers.push(trigger([{ ...emptyCondition(), type: ConditionType.Always }], [
  setDeaths(...mark(MARK.magic), SetModifier.SetTo, MAGIC),
  setDeaths(...mark(MARK.passes), SetModifier.Add, 1),
  setDeaths(...mark(MARK.inPhase), SetModifier.Add, 1),
]));
triggers.push(trigger([deaths(...mark(MARK.inPhase), Comparison.AtLeast, PASSES + 1), deaths(...mark(MARK.phase), Comparison.AtMost, PHASES.length - 1)], [
  setDeaths(...mark(MARK.inPhase), SetModifier.SetTo, 1),
  setDeaths(...mark(MARK.phase), SetModifier.Add, 1),
]));
triggers.push(trigger([deaths(...mark(MARK.phase), Comparison.Exactly, PHASES.length)], [
  setDeaths(...mark(MARK.phase), SetModifier.SetTo, DONE),
  display("\x04Classic weights probe: done. The profiler stops by itself."),
], false));
// Player 2 is a computer only because a Use Map Settings game needs one: its units go at once.
triggers.push(trigger([{ ...emptyCondition(), type: ConditionType.Always }], [
  { ...emptyAction(), type: ActionType.RemoveUnit, player: P2, unitId: 229 },
  display("\x04Classic weights probe: it runs by itself for about two minutes. Keep the profiler going; play nothing."),
], false));
// Each phase, on its first pass: the blocks on or off, and its name on the screen. Not preserved: once a phase.
PHASES.forEach((p, phase) => {
  triggers.push(trigger([deaths(...mark(MARK.phase), Comparison.Exactly, phase), deaths(...mark(MARK.inPhase), Comparison.Exactly, 1)], [
    ...Object.values(BLOCK).map((b) => setDeaths(P8, b, SetModifier.SetTo, p.on.includes(b) ? 1 : 0)),
    setDeaths(...mark(MARK.actions), SetModifier.SetTo, p.actions ? 1 : 0),
    display(`\x04classic weights ${phase + 1}/${PHASES.length}: ${p.name}`),
  ], false));
});
// The cond/act block: 14 Deaths conditions that hold (Player 7's deaths, nobody else's business), then whether actions
// are on — false in a cond phase, so the 62 Set Deaths after are skipped; true in an act phase.
for (const [b, n] of [[BLOCK.x1, X_HALF], [BLOCK.x2, X_HALF]] as const) {
  for (let t = 0; t < n; t++) {
    const conds = [deaths(P8, b, Comparison.Exactly, 1)];
    for (let c = 0; c < 14; c++) conds.push(deaths(P7, (t * 14 + c) % 200, Comparison.AtLeast, 0));
    conds.push(deaths(...mark(MARK.actions), Comparison.Exactly, 1));
    triggers.push(trigger(conds, Array.from({ length: 62 }, (_, a) => setDeaths(P7, (t * 62 + a) % 200, SetModifier.Add, 1))));
  }
}
// The switch block: one condition, 62 Set Switch.
for (const [b, n] of [[BLOCK.s1, S_HALF], [BLOCK.s2, S_HALF]] as const) {
  for (let t = 0; t < n; t++) {
    triggers.push(trigger([deaths(P8, b, Comparison.Exactly, 1)], Array.from({ length: 62 }, (_, a) => ({ ...emptyAction(), type: ActionType.SetSwitch, target: (t * 62 + a) % 256, modifier: SwitchAction.Set }))));
  }
}
// The hyper triggers last, owned by Player 1, whose triggers never wait.
triggers.push(...hyperTriggers(P1));
scn.triggers = triggers;
markDirty(scn, "TRIG");
const extras = loaded.archive ? await readExtras(loaded.archive, loaded.files) : new Map();
writeFileSync(outPath, await saveMap(serializeScenario(scn), { extras, compress: "pkware", listfile: true }));
console.log(`${triggers.length} triggers, ${outPath}`);
