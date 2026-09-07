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
import { compileScript, type CompileResult, type ScriptFiles } from "../compiler/compiler";
import { defaultScriptNames, identifier, scriptNames } from "../compiler/names";
import { printScript, printTrigger } from "../compiler/print";
import { runtimeNames } from "../compiler/runtime";
import { mapPosition, resolveModule } from "../compiler/link";
import {
  buildScript, ENTRY_MEMBER, findBlock, hashTriggers, isScriptMember, readFiles, readManifest, relocateManifest, resolveStrings, scriptState, triggerAtLine, withFiles, staleRecords,
} from "../script";
import { defaultLib } from "../bundle/lib.mjs";
import { loadFixture } from "./fixture";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const DECLS = generateDeclarations();
const compile = (src: string | ScriptFiles, names = NAMES): CompileResult => compileScript(ts, typeof src === "string" ? { "main.ts": src } : src, names, { lib: LIB });

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
    expect([n.players.object, n.units.object, n.locations.object, n.switches.object, n.aiScripts.object]).toEqual(["players", "units", "locations", "switches", "aiScripts"]);
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
  it("type-check on their own, as globals and as the module", () => {
    expect(compile("").diagnostics).toEqual([]);
    expect(DECLS).toContain("declare function bring(player: Player, unit: Unit, location: Location, comparison: Comparison | number, amount: number): Condition;");
    expect(DECLS).toContain("declare function displayText(text: string, always?: boolean): Action;");
    expect(DECLS).toContain("declare function switchIs(switch_: Switch, state: SwitchState | number): Condition;");
    expect(DECLS).toContain('readonly "Terran Marine": Unit<0>;');
    expect(DECLS).toContain('declare module "trigscript" {');
    expect(DECLS).toContain("  export function trigger(");
    const r = compile(`import { trigger, always, victory, P1 } from "trigscript";\nimport type { Player } from "trigscript";\nconst p: Player = P1;\ntrigger(p, [always()], [victory()]);`);
    expect(r.diagnostics).toEqual([]);
    expect(r.triggers.length).toBe(1);
  });

  it("declare every name the runtime provides, and nothing else", () => {
    const declared = new Set([...DECLS.matchAll(/^declare (?:function|const) ([A-Za-z_$][A-Za-z0-9_$]*)/gm)].map((m) => m[1]));
    const provided = new Set(runtimeNames(NAMES));
    expect([...provided].filter((n) => !declared.has(n))).toEqual([]);
    expect([...declared].filter((n) => !provided.has(n))).toEqual([]);
  });

  it("the compact variant is for a language model", () => {
    const compact = generateDeclarations(NAMES, { compact: true });
    expect(compact.length).toBeLessThan(DECLS.length / 3);
    expect(compact).not.toContain('readonly "Terran Marine"');
    expect(compact).toContain("readonly TerranMarine: Unit<0>;");
    expect(compact).toContain("readonly Switch16: Switch<15>;");
    expect(compact).not.toContain("readonly Switch17:");
    expect(compact).toContain("readonly [name: string]: AiScript<number>");
    expect(compact).not.toContain("declare module");
  });
});

describe("the raw level", () => {
  it("records a trigger with every argument kind", () => {
    const r = compile(`
      const five = 5;
      trigger([P1, players.Force2], [
        bring(CurrentPlayer, units.AnyUnit, locations.Anywhere, ">=", 1),
        switchIs(switches.Switch4, "set"),
      ], [
        displayText("hello"),
        setDeaths(P1, units.TerranMarine, "add", five),
        setSwitch(switches.Switch4, "toggle"),
        runAiScript(aiScripts.TerranCustomLevel),
        disabled(preserveTrigger()),
      ], { preserve: true });
    `);
    expect(r.diagnostics).toEqual([]);
    expect(r.strings).toEqual([{ text: "hello" }]);
    expect(r.sources).toEqual([{ file: "main.ts", line: 3 }]);
    expect(r.triggers).toEqual([sample()]);
  });

  it("is ordinary TypeScript: loops, classes, the standard library; StarEdit's own words pass at run time", () => {
    const r = compile(`
      class Wave { constructor(readonly n: number) {} spawn() { return createUnit(P1, units.ZergZergling, this.n * 2, locations.Anywhere); } }
      const delay = Math.max(60 * 1000 / 2 + 7, 0);
      const both = [always(), never()];
      const acts = [wait(delay), wait(-1 >>> 0)] as const;
      trigger(AllPlayers, [...both, always()], [...acts, comment("a" + "b" + \`\${1 + 1}\`), ...[1, 2].map((n) => new Wave(n).spawn())]);
      for (const p of [P1, P2]) trigger(p, [deaths(p, units.TerranMarine, "At least" as any, 1)], [setDeaths(p, units.TerranMarine, "subtract", 1), displayText("lost one", false)]);
    `);
    expect(r.diagnostics).toEqual([]);
    const t = r.triggers[0];
    expect(t.conditions.map((c) => c.type)).toEqual([ConditionType.Always, ConditionType.Never, ConditionType.Always]);
    expect(t.actions[0].time).toBe(30007);
    expect(t.actions[1].time).toBe(0xffffffff);
    expect(t.actions.slice(3).map((a) => a.modifier)).toEqual([2, 4]);
    expect(r.strings).toEqual([{ text: "ab2" }, { text: "lost one" }]);
    expect(t.players[PlayerGroup.AllPlayers]).toBe(1);
    expect(r.triggers[1].conditions[0]).toMatchObject({ comparison: Comparison.AtLeast, player: 0 });
    expect(r.triggers[2].actions[0]).toMatchObject({ modifier: SetModifier.Subtract, player: 1 });
    expect(r.triggers[2].actions[1].flags & ActionFlag.AlwaysDisplay).toBe(0);
    expect(r.sources.map((s) => s?.line)).toEqual([6, 7, 7]);
  });

  it("raw numbers and raw forms pass through", () => {
    const r = compile(`
      trigger(3, [deaths(7, 45, 10, 2), condition(99, 1, 2, 3, 4, 5, 6)], [action(200, 1, 2, 3, 4, 5, 6, 7, 8), createUnit(P1, units.TerranMarine, "All", 5)], { flags: 0x40 });
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

  it("reports type errors from TypeScript and bad arguments from the run, with positions", () => {
    const a = compile(`trigger(P1, [bring(P1, locations.Anywhere, units.TerranMarine, ">=", 1)], []);`);
    expect(a.ok).toBe(false);
    expect(a.diagnostics.some((d) => d.source === "typescript" && d.line === 1 && /Unit/.test(d.message))).toBe(true);
    const b = compile(`\ntrigger(P1, [], [bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1) as any]);`);
    expect(b.diagnostics).toMatchObject([{ source: "script", line: 2, message: "trigger: actions: a condition belongs in the conditions list." }]);
    const c = compile(`trigger(P1, [always()], [wait("x" as any)]);`);
    expect(c.diagnostics[0].message).toMatch(/^wait: .*expected a number, got "x"\.$/);
    const d = compile(`trigger(P1, [bring(P1, units.AnyUnit, locations.Anywhere, "sometimes" as any, 1)], []);`);
    expect(d.diagnostics[0].message).toBe('bring: comparison: unknown comparison "sometimes": one of ">=", "<=", "==".');
    const e = compile(`const x: number = (undefined as any).y;`);
    expect(e.diagnostics).toMatchObject([{ source: "script", line: 1 }]);
    expect(e.diagnostics[0].message).toMatch(/undefined/);
  });

  it("limits and ranges", () => {
    const many = Array.from({ length: 17 }, () => "always()").join(", ");
    expect(compile(`trigger(P1, [${many}], [victory()]);`).diagnostics.map((d) => d.message)).toEqual(["A trigger holds at most 16 conditions (got 17)."]);
    expect(compile(`trigger(99, [], []);`).diagnostics.map((d) => d.message)).toEqual(["trigger: players: player group 99 is out of range (0–26)."]);
    expect(compile(`trigger(P1, [], [explode()]);`).diagnostics[0]).toMatchObject({ source: "typescript", message: expect.stringContaining("explode") });
    expect(compile(`trigger(P1, [], [], { preserve: true, foo: 1 } as any);`).diagnostics.map((d) => d.message)).toEqual(['trigger: unknown option "foo".']);
  });

  it("an endless loop outside program() is the script's own problem, reported where it threw", () => {
    const r = compile(`let n = 0;\nwhile (true) { if (++n > 1000) throw new Error("runaway"); }`);
    expect(r.diagnostics).toMatchObject([{ source: "script", line: 2, message: "runaway" }]);
  });
});

describe("files", () => {
  it("import between files, and an error in the second file names it", () => {
    const r = compile({
      "main.ts": `import { squad } from "./units/squad";\nimport * as s from "./units/squad.js";\ntrigger(P1, [always()], [...squad(P1), s.squad(P2)[0]]);`,
      "units/squad.ts": `import { createUnit, units, locations, type Player } from "trigscript";\nexport const squad = (p: Player) => [createUnit(p, units.TerranMarine, 4, locations.Anywhere), createUnit(p, units.TerranMedic, 1, locations.Anywhere)];`,
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.triggers[0].actions.map((a) => [a.player, a.unitId])).toEqual([[0, 0], [0, 34], [1, 0]]);
    const bad = compile({ "main.ts": `import { x } from "./other";\ntrigger(P1, [], [x]);`, "other.ts": `export const x: Action = 5 as unknown as Action;\nconst y: number = "no";` });
    expect(bad.diagnostics.map((d) => [d.file, d.line, d.source])).toEqual([["other.ts", 2, "typescript"]]);
    const missing = compile({ "main.ts": `import { x } from "./nowhere";` });
    expect(missing.diagnostics[0]).toMatchObject({ file: "main.ts", source: "typescript" });
    const none = compile({ "helpers.ts": "" });
    expect(none.diagnostics[0].message).toContain("no main.ts");
  });

  it("the linker resolves relative paths and nothing else", () => {
    const files = new Set(["main.ts", "a/b.ts", "a/c/index.ts", "d.ts"]);
    expect(resolveModule(files, "main.ts", "./a/b")).toBe("a/b.ts");
    expect(resolveModule(files, "main.ts", "./a/b.js")).toBe("a/b.ts");
    expect(resolveModule(files, "a/b.ts", "./c")).toBe("a/c/index.ts");
    expect(resolveModule(files, "a/b.ts", "../d")).toBe("d.ts");
    expect(resolveModule(files, "a/b.ts", "../../d")).toBe("d.ts");
    expect(resolveModule(files, "main.ts", "lodash")).toBeNull();
    expect(resolveModule(files, "main.ts", "./nope")).toBeNull();
  });

  it("maps a generated position back through a source map", () => {
    // Line 1 → original line 3; line 2 → original line 5 (VLQ: AAEA = [0, 0, 2, 0], AACA = [0, 0, 1, 0]).
    const map = JSON.stringify({ version: 3, sources: ["main.ts"], mappings: "AAEA;AACA,IAAI" });
    expect(mapPosition(map, 1, 1)).toEqual({ line: 3, column: 1 });
    expect(mapPosition(map, 2, 1)).toEqual({ line: 4, column: 1 });
    expect(mapPosition(map, 2, 6)).toEqual({ line: 4, column: 5 });
    expect(mapPosition(map, 9, 1)).toBeNull();
    expect(mapPosition("{", 1, 1)).toBeNull();
  });
});

describe("printer", () => {
  const ctx = { names: defaultScriptNames(), string: (i: number) => (i === 1 ? "hello" : null) };

  it("prints the sample as script that runs back to itself", () => {
    const text = printTrigger(sample(), ctx);
    expect(text).toContain("trigger([P1, players.Force2], [");
    expect(text).toContain('bring(CurrentPlayer, units.AnyUnit, locations.Anywhere, ">=", 1),');
    expect(text).toContain('switchIs(switches.Switch4, "set"),');
    expect(text).toContain('displayText("hello"),');
    expect(text).toContain('setDeaths(P1, units.TerranMarine, "add", 5),');
    expect(text).toContain("disabled(preserveTrigger()),");
    expect(text).toContain("runAiScript(aiScripts.TerranCustomLevel),");
    expect(text).toContain("], { preserve: true });");
    const script = printScript([sample()], ctx, { imports: true });
    expect(script).toContain('import { CurrentPlayer, P1, aiScripts, bring, disabled, displayText, locations, players, preserveTrigger, runAiScript, setDeaths, setSwitch, switchIs, switches, trigger, units } from "trigscript";');
    const r = compile(script);
    expect(r.diagnostics).toEqual([]);
    expect(r.strings).toEqual([{ text: "hello" }]);
    expect(r.triggers).toEqual([sample()]);
  });

  it("prints unknown types and values as raw forms", () => {
    const t = emptyTrigger();
    t.actions.push({ ...emptyAction(), type: 200, location: 1, text: 2, wav: 3, time: 4, player: 5, target: 6, unitId: 7, modifier: 8 });
    t.actions.push({ ...emptyAction(), type: ActionType.DisplayText, text: 1 });
    t.conditions.push({ ...emptyCondition(), type: 99, location: 1, player: 2, amount: 3, unitId: 4, comparison: 5, resource: 6 });
    t.conditions.push({ ...emptyCondition(), type: ConditionType.Deaths, player: 40, unitId: 250, comparison: 7, amount: 1, flags: ConditionFlag.UnitTypeUsed });
    t.flags = 0x40 | 0x100;
    const text = printTrigger(t, ctx);
    expect(text).toContain("condition(99, 1, 2, 3, 4, 5, 6)");
    expect(text).toContain("action(200, 1, 2, 3, 4, 5, 6, 7, 8)");
    expect(text).toContain('displayText("hello", false)');
    expect(text).toContain("deaths(40, 250, 7, 1)");
    expect(text).toContain("{ waitSkipDisabled: true, flags: 0x100 }");
    const r = compile(printScript([t], ctx));
    expect(r.diagnostics).toEqual([]);
    expect(r.triggers[0].flags).toBe(t.flags);
    expect(r.triggers[0].actions[1].flags & ActionFlag.AlwaysDisplay).toBe(0);
    // Raw forms carry string-table indices as they are: nothing to intern for them.
    expect(encodeTriggers(resolveStrings(r, (s) => (s === "hello" ? 1 : 0)))).toEqual(encodeTriggers([t]));
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

const main = (src: string): ScriptFiles => ({ "main.ts": src });

describe("build", () => {
  it("appends a block, then replaces it in place, then relocates it", () => {
    const table = stringTable();
    let list: TriggerRecord[] = [newTrigger([PlayerGroup.Player1])];
    const src = 'trigger(P1, [always()], [displayText("one")]);\n\ntrigger(P2, [always()], [victory()]);';
    const r = compile(src);
    expect(r.ok).toBe(true);
    let plan = buildScript(list, new Map(), main(src), r, table.intern);
    ({ list } = plan);
    let { extras, block } = plan;
    expect(block).toEqual({ start: 1, count: 2, sources: [{ file: "main.ts", line: 1 }, { file: "main.ts", line: 3 }] });
    expect(list.length).toBe(3);
    expect(table.strings[list[1].actions[0].text]).toBe("one");
    expect(readFiles(extras)).toEqual({ "main.ts": src });
    expect(readManifest(extras)).toMatchObject({ version: 2, start: 1, count: 2, files: ["main.ts"] });
    expect(scriptState(list, extras)).toMatchObject({ stale: false, block: { start: 1, count: 2 }, unbuilt: false, source: src });
    expect(triggerAtLine(block, "main.ts", 2)).toBe(1);
    expect(triggerAtLine(block, "main.ts", 3)).toBe(2);
    expect(triggerAtLine(block, "main.ts", 0)).toBe(null);
    expect(triggerAtLine(block, "other.ts", 3)).toBe(null);

    // Rebuild with one trigger: the block shrinks in place.
    const src2 = "trigger(P3, [always()], [defeat()]);";
    plan = buildScript(list, extras, main(src2), compile(src2), table.intern);
    ({ list, extras, block } = plan);
    expect(block).toEqual({ start: 1, count: 1, sources: [{ file: "main.ts", line: 1 }] });
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
    plan = buildScript(list, moved, main(src2), compile(src2), table.intern);
    ({ list, extras, block } = plan);
    expect(block).toMatchObject({ start: 3, count: 1 });
    expect(list.length).toBe(4);

    // Take-over: the whole list becomes the block.
    plan = buildScript(list, extras, main(src), r, table.intern, { takeOver: true });
    ({ list, extras, block } = plan);
    expect(block).toMatchObject({ start: 0, count: 2 });
    expect(list.length).toBe(2);
    expect(hashTriggers(list)).toBe(readManifest(extras)!.hash);
    expect(findBlock(list, readManifest(extras)!)).toMatchObject({ start: 0, count: 2 });
    // The identical text was reused rather than interned twice.
    expect(table.strings.filter((t) => t === "one")).toHaveLength(1);
  });

  it("a stale block is taken apart record by record: replace what is still the build's, keep what was edited", () => {
    const table = stringTable();
    const src = 'trigger(P1, [always()], [displayText("a")]);\ntrigger(P1, [always()], [displayText("b")]);\ntrigger(P1, [always()], [displayText("c")]);';
    let { list, extras } = buildScript([newTrigger([PlayerGroup.Player4])], new Map(), main(src), compile(src), table.intern);
    expect(readManifest(extras)!.records).toHaveLength(3);
    // The middle record is edited by hand, and a hand trigger follows the block.
    list = [...list, newTrigger([PlayerGroup.Player5])];
    list[2] = cloneTrigger(list[2]);
    list[2].players[7] = 1;
    const state = scriptState(list, extras);
    expect(state).toMatchObject({ stale: true, edited: { unchanged: 2, changed: 1 } });
    expect(staleRecords(list, state.manifest!)).toEqual({ unchanged: [1, 3], changed: [2] });
    // Replace: the two untouched records go, the new block lands where the old one was, the edited record follows it, then the hand trigger.
    const src2 = 'trigger(P2, [always()], [victory()]);';
    const plan = buildScript(list, extras, main(src2), compile(src2), table.intern, { replaceStale: true });
    expect(plan.replaced).toEqual({ removed: 2, kept: 1 });
    expect(plan.block).toMatchObject({ start: 1, count: 1 });
    expect(plan.list.map((t) => t.players.findIndex((p) => p === 1))).toEqual([3, 1, 0, 4]);
    expect(plan.list[2].players[7]).toBe(1);
    expect(scriptState(plan.list, plan.extras)).toMatchObject({ stale: false, edited: null, block: { start: 1, count: 1 } });
    // Without the option, or with a manifest that has no record hashes, the block is appended and everything stays.
    const appended = buildScript(list, extras, main(src2), compile(src2), table.intern);
    expect(appended.replaced).toBeUndefined();
    expect(appended.list).toHaveLength(6);
    const old = new Map(extras);
    old.set("trigscript\\build.json", new TextEncoder().encode(JSON.stringify({ ...readManifest(extras)!, records: undefined })));
    expect(scriptState(list, old)).toMatchObject({ stale: true, edited: null });
    expect(buildScript(list, old, main(src2), compile(src2), table.intern, { replaceStale: true }).list).toHaveLength(6);
    // A block removed or moved whole has nothing to take apart.
    expect(staleRecords([newTrigger([PlayerGroup.Player4])], state.manifest!)).toBeNull();
  });

  it("member names match without regard to case or slash direction; a build keeps every file", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const extras = new Map([["TRIGSCRIPT/Main.TS", enc("x")], ["trigscript\\lib\\a.ts", enc("y")], ["staredit\\wav\\z.wav", enc("")]]);
    expect(readFiles(extras)).toEqual({ "Main.TS": "x", "lib/a.ts": "y" });
    expect(isScriptMember("trigscript/build.json")).toBe(true);
    expect(isScriptMember("staredit\\scenario.chk")).toBe(false);
    const next = withFiles(extras, { "main.ts": "m", "lib/a.ts": "y" });
    expect([...next.keys()].sort()).toEqual(["staredit\\wav\\z.wav", "trigscript\\lib\\a.ts", ENTRY_MEMBER].sort());
    expect(readFiles(next)).toEqual({ "main.ts": "m", "lib/a.ts": "y" });
    expect(readFiles(withFiles(next, {}))).toEqual({});
    // A file the script no longer has is gone after a build; the others travel with the block.
    const files = { "main.ts": `import { a } from "./lib/a";\ntrigger(P1, [always()], [a]);`, "lib/a.ts": `export const a = victory();` };
    const plan = buildScript([], next, files, compile(files), () => 0);
    expect(readFiles(plan.extras)).toEqual(files);
    expect(readManifest(plan.extras)!.files).toEqual(["lib/a.ts", "main.ts"]);
    expect(scriptState(plan.list, plan.extras)).toMatchObject({ unbuilt: false, files });
    expect(scriptState(plan.list, withFiles(plan.extras, { ...files, "lib/a.ts": "export const a = defeat();" })).unbuilt).toBe(true);
  });

  it("keepFiles leaves the archive's files alone and the state unbuilt", () => {
    const plan = buildScript([], withFiles(new Map(), main("// newer")), main("// compiled"), compile("// compiled"), () => 0, { keepFiles: true });
    expect(readFiles(plan.extras)).toEqual(main("// newer"));
    expect(scriptState(plan.list, plan.extras)).toMatchObject({ stale: false, unbuilt: true, block: { start: 0, count: 0 } });
  });

  it("an empty script keeps an empty block", () => {
    const plan = buildScript([], new Map(), main(""), compile(""), () => 0);
    expect(plan.block).toEqual({ start: 0, count: 0, sources: [] });
    expect(scriptState(plan.list, plan.extras)).toMatchObject({ stale: false, block: { start: 0, count: 0 } });
  });

  it("a source edit after the build is unbuilt, a broken manifest is no manifest", () => {
    const plan = buildScript([], new Map(), main("// a"), compile("// a"), () => 0);
    expect(scriptState(plan.list, withFiles(plan.extras, main("// b"))).unbuilt).toBe(true);
    const broken = new Map(plan.extras);
    broken.set("trigscript\\build.json", new TextEncoder().encode("{not json"));
    expect(readManifest(broken)).toBeNull();
    expect(scriptState(plan.list, broken)).toMatchObject({ manifest: null, stale: false, unbuilt: true });
  });
});

const MAPS = join(import.meta.dirname, "..", "fixtures", "maps");
const mapFiles = existsSync(MAPS) ? readdirSync(MAPS).filter((f) => /\.sc[mx]$/i.test(f)) : [];

/**
 * Blizzard's own maps (gitignored copies from the install's Maps folder): every trigger
 * ejects to script and runs back to the same record. The maps' own location and switch
 * names are not read here — unknown names print as bare numbers and parse back — so
 * this pins the record round trip, not the naming.
 */
describe.skipIf(mapFiles.length === 0)("fixture maps", () => {
  for (const file of mapFiles) {
    it(`${file}: triggers eject to script and run back`, async () => {
      const map = await loadFixture(join(MAPS, file));
      if (!map) return;
      const names = defaultScriptNames();
      const text = printScript(map.triggers, { names, string: (i) => map.strings[i] ?? null }, { imports: true });
      const r = compileScript(ts, main(text), names, { lib: LIB });
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
