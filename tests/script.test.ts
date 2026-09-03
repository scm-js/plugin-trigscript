import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ActionFlag, ActionType, cloneTrigger, Comparison, ConditionFlag, ConditionType, emptyAction, emptyCondition, emptyTrigger, encodeTriggers,
  PlayerGroup, SetModifier, SwitchAction, SwitchState, TriggerFlag, UnitClass, type TriggerRecord,
} from "../vendor/triggers";
import { aiScriptCode } from "../vendor/triggerDefs";
import { generateDeclarations } from "../compiler/declarations";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames, identifier, scriptNames } from "../compiler/names";
import { printScript, printTrigger } from "../compiler/print";
import {
  buildScript, findBlock, hashTriggers, isScriptMember, readManifest, readScript, relocateManifest, resolveStrings, SCRIPT_MEMBER, scriptState, triggerAtLine, withScript,
} from "../script";
import { loadFixture } from "./fixture";

const DECLS = generateDeclarations();
const compile = (src: string, decls = DECLS) => compileScript(ts, src, decls);

function sample(): TriggerRecord {
  const t = emptyTrigger();
  t.players[PlayerGroup.Player1] = 1;
  t.players[PlayerGroup.Force2] = 1;
  t.conditions.push({ ...emptyCondition(), type: ConditionType.Bring, player: PlayerGroup.CurrentPlayer, unitId: UnitClass.Any, location: 64, comparison: Comparison.AtLeast, amount: 1, flags: ConditionFlag.UnitTypeUsed });
  t.conditions.push({ ...emptyCondition(), type: ConditionType.Switch, resource: 3, comparison: SwitchState.Set });
  t.actions.push({ ...emptyAction(), type: ActionType.DisplayText, text: 1, flags: ActionFlag.AlwaysDisplay });
  t.actions.push({ ...emptyAction(), type: ActionType.SetDeaths, player: PlayerGroup.Player1, unitId: 0, modifier: SetModifier.Add, target: 5, flags: ActionFlag.UnitTypeUsed });
  t.actions.push({ ...emptyAction(), type: ActionType.SetSwitch, target: 3, modifier: SwitchAction.Toggle });
  t.actions.push({ ...emptyAction(), type: ActionType.RunAiScript, target: aiScriptCode("TMCu") });
  t.actions.push({ ...emptyAction(), type: ActionType.PreserveTrigger, flags: ActionFlag.Disabled });
  t.flags = TriggerFlag.Preserve;
  return t;
}

describe("script names", () => {
  it("derives identifiers", () => {
    expect(identifier("Terran Siege Tank (Tank Mode)")).toBe("TerranSiegeTankTankMode");
    expect(identifier("Tassadar/Zeratul (Archon)")).toBe("TassadarZeratulArchon");
    expect(identifier("2nd base")).toBe("_2ndBase");
    expect(identifier("")).toBe("_");
  });

  it("keeps keys unique and pairs identifiers with display names", () => {
    const n = defaultScriptNames();
    const marine = n.units.entries.find((e) => e.value === 0)!;
    expect(marine.keys).toEqual(["TerranMarine", "Terran Marine"]);
    expect(n.units.entries.find((e) => e.value === UnitClass.Any)!.keys).toEqual(["AnyUnit", "Any unit", "Any Unit"]);
    const all = n.units.entries.flatMap((e) => e.keys);
    expect(new Set(all).size).toBe(all.length);
    expect(n.players.entries.find((e) => e.value === PlayerGroup.CurrentPlayer)!.keys).toEqual(["Current", "CurrentPlayer", "Current Player"]);
    expect(n.switches.entries[0].keys).toEqual(["Switch1", "Switch 1"]);
  });

  it("takes a map's forces, locations, switch names and custom unit names", () => {
    const n = scriptNames({
      forceNames: ["Rebels", null, "", "Force 4"],
      locations: [{ index: 2, name: "Beacon Alpha" }, { index: 0, name: "Location 1" }],
      switchNames: Array.from({ length: 256 }, (_, i) => (i === 3 ? "Door Open" : `Switch ${i + 1}`)),
      unitCustomName: (id) => (id === 0 ? "Grunt" : null),
    });
    expect(n.players.entries.find((e) => e.value === PlayerGroup.Force1)!.keys).toEqual(["Force1", "Force 1", "Rebels"]);
    expect(n.players.entries.find((e) => e.value === PlayerGroup.Force4)!.keys).toEqual(["Force4", "Force 4"]);
    expect(n.locations.entries.map((e) => e.value)).toEqual([0, 1, 3, 64]);
    expect(n.locations.entries[2].keys).toEqual(["BeaconAlpha", "Beacon Alpha"]);
    expect(n.locations.entries[3].keys).toEqual(["Anywhere"]);
    expect(n.switches.entries[3].keys).toEqual(["Switch4", "Switch 4", "DoorOpen", "Door Open"]);
    expect(n.switches.entries[4].keys).toEqual(["Switch5", "Switch 5"]);
    expect(n.units.entries[0].keys).toEqual(["TerranMarine", "Terran Marine", "Grunt"]);
  });
});

describe("declarations", () => {
  it("type-check on their own under noLib", () => {
    const r = compile("");
    expect(r.diagnostics).toEqual([]);
    expect(DECLS).toContain("declare function Bring(player: PlayerId, unit: UnitId, location: LocationId, comparison: Comparison | number, amount: number): Condition;");
    expect(DECLS).toContain('readonly "Terran Marine": UnitId<0>;');
  });
});

describe("compiler", () => {
  it("lowers a trigger with every argument kind", () => {
    const r = compile(`
      const five = 5;
      trigger([P1, Players.Force2], [
        Bring(CurrentPlayer, Units.AnyUnit, Locations.Anywhere, ">=", 1),
        Switch(Switches.Switch4, "set"),
      ], [
        DisplayText("Always Display", "hello"),
        SetDeaths(P1, Units.TerranMarine, "Add", five),
        SetSwitch(Switches.Switch4, "toggle"),
        RunAiScript(AiScripts.TerranCustomLevel),
        disabled(PreserveTrigger()),
      ], ["Preserve"]);
    `);
    expect(r.diagnostics).toEqual([]);
    expect(r.strings).toEqual([{ text: "hello" }]);
    expect(r.lines).toEqual([3]);
    expect(r.triggers).toEqual([sample()]);
  });

  it("folds constants, follows const chains, spreads arrays", () => {
    const r = compile(`
      const base = 60 * 1000;
      const wait = base / 2 + 7;
      const both = [Always(), Never()];
      const acts = [Wait(wait), Wait(-1 >>> 0)] as const;
      trigger(AllPlayers, [...both, Always()], [...acts, Comment("a" + "b" + \`\${1 + 1}\`)]);
    `);
    expect(r.diagnostics).toEqual([]);
    const t = r.triggers[0];
    expect(t.conditions.map((c) => c.type)).toEqual([ConditionType.Always, ConditionType.Never, ConditionType.Always]);
    expect(t.actions[0].time).toBe(30007);
    expect(t.actions[1].time).toBe(0xffffffff);
    expect(r.strings).toEqual([{ text: "ab2" }]);
    expect(t.players[PlayerGroup.AllPlayers]).toBe(1);
  });

  it("raw numbers and raw forms pass through", () => {
    const r = compile(`
      trigger(3, [Deaths(7, 45, 10, 2), Condition(99, 1, 2, 3, 4, 5, 6)], [Action(200, 1, 2, 3, 4, 5, 6, 7, 8), CreateUnit(P1, Units.TerranMarine, "All", 5)], [0x40]);
    `);
    expect(r.diagnostics).toEqual([]);
    const t = r.triggers[0];
    expect(t.players[3]).toBe(1);
    expect(t.conditions[0]).toMatchObject({ type: ConditionType.Deaths, player: 7, unitId: 45, comparison: Comparison.Exactly, amount: 2 });
    expect(t.conditions[1]).toMatchObject({ type: 99, location: 1, player: 2, amount: 3, unitId: 4, comparison: 5, resource: 6 });
    expect(t.actions[0]).toMatchObject({ type: 200, location: 1, time: 4, player: 5, target: 6, unitId: 7, modifier: 8 });
    expect(r.strings).toEqual([{ index: 2 }, { index: 3 }]);
    expect(t.actions[0].text).toBe(1);
    expect(t.actions[0].wav).toBe(2);
    expect(t.actions[1].modifier).toBe(0);
    expect(t.actions[1].location).toBe(5);
    expect(t.flags).toBe(TriggerFlag.WaitSkipDisabled);
  });

  it("reports type errors and compiler errors with positions", () => {
    const r = compile(`trigger(P1, [Bring(P1, Locations.Anywhere, Units.TerranMarine, ">=", 1)], []);\ntrigger(P1, [], [Bring(P1, Units.AnyUnit, Locations.Anywhere, ">=", 1)]);`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.source === "typescript" && d.line === 1 && /LocationId/.test(d.message))).toBe(true);
    expect(r.diagnostics.some((d) => d.source === "compiler" && d.line === 2 && /Bring is a condition/.test(d.message))).toBe(true);
  });

  it("rejects what the raw level cannot express", () => {
    const r = compile(`class C {}\nimport x from "y";\nconst s = "x";\ntrigger(P1, [Bring(P1, Units.AnyUnit, Locations.Anywhere, ">=", 1)], [Wait(s as any), DisplayText("Always Display", "" + P1)]);\ntrigger(P1, [Always()], Array);`);
    const msgs = r.diagnostics.filter((d) => d.source === "compiler").map((d) => `${d.line}:${d.message}`);
    expect(msgs).toContain("1:Imports, exports, classes, enums and namespaces are not part of the trigger script.");
    expect(msgs).toContain("2:Imports, exports, classes, enums and namespaces are not part of the trigger script.");
    expect(msgs.some((m) => m.startsWith("4:Expected a duration, got text."))).toBe(true);
    expect(msgs.some((m) => m.startsWith("5:Expected an array of actions."))).toBe(true);
    // "" + P1 folds to "0" — text is text.
    expect(r.strings).toEqual([{ text: "0" }]);
  });

  it("limits and unknown names", () => {
    const many = Array.from({ length: 17 }, () => "Always()").join(", ");
    const r = compile(`trigger(P1, [${many}], [Explode()]);\ntrigger(99, [], []);`);
    const msgs = r.diagnostics.filter((d) => d.source === "compiler").map((d) => d.message);
    expect(msgs).toContain("A trigger holds at most 16 conditions (got 17).");
    expect(msgs).toContain('Unknown action "Explode".');
    expect(msgs).toContain("Player group 99 is out of range (0–26).");
  });
});

describe("printer", () => {
  const ctx = { names: defaultScriptNames(), string: (i: number) => (i === 1 ? "hello" : null) };

  it("prints the sample as script that compiles back to itself", () => {
    const text = printTrigger(sample(), ctx);
    expect(text).toContain("trigger([P1, Players.Force2], [");
    expect(text).toContain('Bring(CurrentPlayer, Units.AnyUnit, Locations.Anywhere, "At least", 1),');
    expect(text).toContain('Switch(Switches.Switch4, "set"),');
    expect(text).toContain("disabled(PreserveTrigger()),");
    expect(text).toContain('RunAiScript(AiScripts.TerranCustomLevel),');
    expect(text).toContain('], ["Preserve"]);');
    const r = compile(printScript([sample()], ctx));
    expect(r.diagnostics).toEqual([]);
    expect(r.strings).toEqual([{ text: "hello" }]);
    expect(r.triggers).toEqual([sample()]);
  });

  it("prints unknown types and values as raw forms", () => {
    const t = emptyTrigger();
    t.actions.push({ ...emptyAction(), type: 200, location: 1, text: 2, wav: 3, time: 4, player: 5, target: 6, unitId: 7, modifier: 8 });
    t.conditions.push({ ...emptyCondition(), type: 99, location: 1, player: 2, amount: 3, unitId: 4, comparison: 5, resource: 6 });
    t.conditions.push({ ...emptyCondition(), type: ConditionType.Deaths, player: 40, unitId: 250, comparison: 7, amount: 1, flags: ConditionFlag.UnitTypeUsed });
    t.flags = 0x40 | 0x100;
    const text = printTrigger(t, ctx);
    expect(text).toContain("Condition(99, 1, 2, 3, 4, 5, 6)");
    expect(text).toContain("Action(200, 1, 2, 3, 4, 5, 6, 7, 8)");
    expect(text).toContain("Deaths(40, 250, 7, 1)");
    expect(text).toContain('["Wait Skip Disabled", 0x100]');
    const r = compile(printScript([t], ctx));
    expect(r.diagnostics).toEqual([]);
    expect(r.triggers[0].flags).toBe(t.flags);
    // Raw forms carry string-table indices as they are: nothing to intern.
    expect(encodeTriggers(resolveStrings(r, () => { throw new Error("nothing to intern"); }))).toEqual(encodeTriggers([t]));
  });
});

/** A trigger owned by the given player groups, as the editor's `newTrigger` makes one. */
function newTrigger(players: number[]): TriggerRecord {
  const t = emptyTrigger();
  for (const p of players) t.players[p] = 1;
  return t;
}

/** A string table the way `tx.strings.intern` answers: an identical entry is reused, else one is appended. */
function stringTable() {
  const strings: string[] = [""];
  return {
    strings,
    intern: (text: string) => {
      if (text === "") return 0;
      let i = strings.indexOf(text, 1);
      if (i < 0) { strings.push(text); i = strings.length - 1; }
      return i;
    },
  };
}

describe("build", () => {
  it("appends a block, then replaces it in place, then relocates it", () => {
    const table = stringTable();
    let list: TriggerRecord[] = [newTrigger([PlayerGroup.Player1])];
    const src = 'trigger(P1, [Always()], [DisplayText("Always Display", "one")]);\n\ntrigger(P2, [Always()], [Victory()]);';
    const r = compile(src);
    expect(r.ok).toBe(true);
    let plan = buildScript(list, new Map(), src, r, table.intern);
    ({ list } = plan);
    let { extras, block } = plan;
    expect(block).toEqual({ start: 1, count: 2, lines: [1, 3] });
    expect(list.length).toBe(3);
    expect(table.strings[list[1].actions[0].text]).toBe("one");
    expect(readScript(extras)).toBe(src);
    expect(readManifest(extras)).toMatchObject({ version: 1, start: 1, count: 2 });
    expect(scriptState(list, extras)).toMatchObject({ stale: false, block: { start: 1, count: 2 }, unbuilt: false });
    expect(triggerAtLine(block, 2)).toBe(1);
    expect(triggerAtLine(block, 3)).toBe(2);
    expect(triggerAtLine(block, 0)).toBe(null);

    // Rebuild with one trigger: the block shrinks in place.
    const src2 = "trigger(P3, [Always()], [Defeat()]);";
    plan = buildScript(list, extras, src2, compile(src2), table.intern);
    ({ list, extras, block } = plan);
    expect(block).toEqual({ start: 1, count: 1, lines: [1] });
    expect(list.length).toBe(2);
    expect(list[1].players[2]).toBe(1);

    // A hand trigger inserted before the block: found by content, manifest relocated.
    list = [newTrigger([PlayerGroup.Player4]), ...list];
    expect(scriptState(list, extras).block).toMatchObject({ start: 2, count: 1 });
    const moved = relocateManifest(list, extras)!;
    expect(readManifest(moved)!.start).toBe(2);
    expect(relocateManifest(list, moved)).toBe(null);

    // Editing inside the block makes it stale; the next build appends.
    list[2] = cloneTrigger(list[2]);
    list[2].players[5] = 1;
    expect(scriptState(list, moved)).toMatchObject({ stale: true, block: null });
    plan = buildScript(list, moved, src2, compile(src2), table.intern);
    ({ list, extras, block } = plan);
    expect(block).toEqual({ start: 3, count: 1, lines: [1] });
    expect(list.length).toBe(4);

    // Take-over: the whole list becomes the block.
    plan = buildScript(list, extras, src, r, table.intern, { takeOver: true });
    ({ list, extras, block } = plan);
    expect(block).toEqual({ start: 0, count: 2, lines: [1, 3] });
    expect(list.length).toBe(2);
    expect(hashTriggers(list)).toBe(readManifest(extras)!.hash);
    expect(findBlock(list, readManifest(extras)!)).toEqual({ start: 0, count: 2, lines: [1, 3] });
    // The identical text was reused rather than interned twice.
    expect(table.strings.filter((t) => t === "one")).toHaveLength(1);
  });

  it("member names match without regard to case or slash direction", () => {
    const extras = new Map([["SCMJS/Triggers.TS", new TextEncoder().encode("x")]]);
    expect(readScript(extras)).toBe("x");
    expect(isScriptMember("scmjs/triggers.json")).toBe(true);
    expect(isScriptMember("staredit\\scenario.chk")).toBe(false);
    const next = withScript(extras, "y");
    expect([...next.keys()]).toEqual([SCRIPT_MEMBER]);
    expect(readScript(next)).toBe("y");
    expect(readScript(withScript(next, null))).toBeNull();
  });

  it("an empty script keeps an empty block", () => {
    const plan = buildScript([], new Map(), "", compile(""), () => 0);
    expect(plan.block).toEqual({ start: 0, count: 0, lines: [] });
    expect(scriptState(plan.list, plan.extras)).toMatchObject({ stale: false, block: { start: 0, count: 0 } });
  });

  it("a source edit after the build is unbuilt, a broken manifest is no manifest", () => {
    const plan = buildScript([], new Map(), "// a", compile("// a"), () => 0);
    expect(scriptState(plan.list, withScript(plan.extras, "// b")).unbuilt).toBe(true);
    const broken = new Map(plan.extras);
    broken.set("scmjs\\triggers.json", new TextEncoder().encode("{not json"));
    expect(readManifest(broken)).toBeNull();
    expect(scriptState(plan.list, broken)).toMatchObject({ manifest: null, stale: false, unbuilt: true });
  });
});

const MAPS = join(import.meta.dirname, "..", "fixtures", "maps");
const mapFiles = existsSync(MAPS) ? readdirSync(MAPS).filter((f) => /\.sc[mx]$/i.test(f)) : [];

/**
 * Blizzard's own maps (gitignored copies from the install's Maps folder): every trigger
 * ejects to script and compiles back to the same record. The maps' own location and
 * switch names are not read here — unknown names print as bare numbers and parse back —
 * so this pins the record round trip, not the naming.
 */
describe.skipIf(mapFiles.length === 0)("fixture maps", () => {
  for (const file of mapFiles) {
    it(`${file}: triggers eject to script and compile back`, async () => {
      const map = await loadFixture(join(MAPS, file));
      if (!map) return;
      const names = defaultScriptNames();
      const decls = generateDeclarations(names);
      const text = printScript(map.triggers, { names, string: (i) => map.strings[i] ?? null });
      const r = compileScript(ts, text, decls);
      expect(r.diagnostics).toEqual([]);
      expect(r.triggers.length).toBe(map.triggers.length);
      const strings = map.strings.slice();
      const intern = (t: string) => {
        let i = strings.indexOf(t, 1);
        if (i < 0) { strings.push(t); i = strings.length - 1; }
        return i;
      };
      const back = resolveStrings(r, intern);
      // Hint bits are not part of the language, and a text is compared by content: a map's table may hold the same text twice.
      const hints = ConditionFlag.UnitPropertiesUsed | ConditionFlag.UnitTypeUsed | ConditionFlag.UnitIdUsed;
      const norm = (list: TriggerRecord[], table: (string | null)[]) => list.map((t) => ({
        ...t,
        conditions: t.conditions.map((c) => ({ ...c, flags: c.flags & ~hints })),
        actions: t.actions.map((a) => ({ ...a, flags: a.flags & ~hints, text: table[a.text] ?? "", wav: table[a.wav] ?? "" })),
      }));
      expect(norm(back, strings)).toEqual(norm(map.triggers, map.strings));
    });
  }
});
