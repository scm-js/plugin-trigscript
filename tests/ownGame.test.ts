/**
 * The game's own conditions and actions in a map of our own (TrigScript 4, step 5 of the way off eudplib): laid out as
 * the game's records, byte for byte as the map's own triggers would hold them; a condition turned around in one
 * condition where one says it; an `if` of actions under conditions that fit in one trigger, that one trigger.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { emitOwn } from "../compiler/backend/own";
import type { Graph } from "../compiler/backend/graph";
import { layout } from "../compiler/backend/layout";
import { encodeTriggers, emptyTrigger, type ActionRecord, type ConditionRecord } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

let lib: ReturnType<typeof defaultLib> | undefined;
function own(body: string) {
  lib ??= defaultLib();
  const r = compileScript(ts, { "main.ts": `program(() => {\n${body}\n});\n` }, defaultScriptNames(), { lib, emitter: false });
  expect(r.diagnostics).toEqual([]);
  const o = emitOwn(r);
  if (typeof o === "string") throw new Error(o);
  return { ...o, strings: r.strings };
}
const games = (g: Graph) => g.triggers.flatMap((t) => t.conds.filter((c) => c.game).map((c) => c.game!));

describe("a map of our own, the game's conditions and actions", () => {
  it("lays a condition and an action out as the game's records, the action's texts among the map's strings", () => {
    const { graph } = own(`if (bring(P1, units.TerranMarine, locations.Anywhere, ">=", 5)) transmission("Report in.", units.TerranMarine, locations.Anywhere, "add", 0, "sound\\\\glue\\\\mousedown2.wav", 500);`);
    const t = graph.triggers.find((t) => t.conds.some((c) => c.game) && t.acts.some((a) => a.record))!;
    expect(t).toBeDefined();
    const texts = new Map<string, number>([["Report in.", 7], ["sound\\glue\\mousedown2.wav", 8]]);
    const out = layout({ graph, strings: 0, owner: 0, text: (s) => texts.get(s)!, arrays: new Map() });
    const cond: ConditionRecord = t.conds[0].game!, act: ActionRecord = { ...t.acts[0].record!, text: 7, wav: 8 };
    const record = encodeTriggers([{ ...emptyTrigger(), conditions: [cond], actions: [act] }]);
    // (The payload's triggers in order: `@wake` and `@init` first, then the graph's, a node of 2408 bytes each, its
    // record 8 bytes in.)
    const node = 8 + 2408 * (2 + graph.triggers.indexOf(t));
    expect([...out.payload.subarray(node, node + 20)]).toEqual([...record.subarray(0, 20)]);
    expect([...out.payload.subarray(node + 320, node + 352)]).toEqual([...record.subarray(320, 352)]);
  });

  it("turns a condition around in one condition where one says the opposite, and skips past one where none does", () => {
    const flipped = (cond: string) => games(own(`if (!${cond}) setDeaths(P1, units.TerranMarine, "add", 1);`).graph);
    expect(flipped(`accumulate(P1, ">=", 500, "ore")`)).toMatchObject([{ type: 4, comparison: 1, amount: 499 }]);
    expect(flipped(`accumulate(P1, "<=", 500, "ore")`)).toMatchObject([{ type: 4, comparison: 0, amount: 501 }]);
    expect(flipped(`switchIs(switches.Switch1, "set")`)).toMatchObject([{ type: 11, comparison: 3 }]);
    // (Exactly: the condition as it is, its trigger sending the walk past what it guards.)
    expect(flipped(`deaths(P1, units.TerranMarine, "==", 5)`)).toMatchObject([{ type: 15, comparison: 10, amount: 5 }]);
    // (At least 0 always holds: turned around, the `if` is gone.)
    expect(flipped(`accumulate(P1, ">=", 0, "ore")`)).toEqual([]);
  });

  it("lays an `if` of actions and counts under conditions that fit in one trigger out as that trigger, with no branch", () => {
    const { graph } = own(`let n = 0;\nif (switchIs(switches.Switch1, "set") && accumulate(P1, ">=", 100, "ore")) { n += 1; setDeaths(P1, units.TerranMarine, "add", 1); }\nprint(\`\${n}\`);`);
    const t = graph.triggers.find((t) => t.conds.some((c) => c.game))!;
    expect(t.conds.map((c) => c.game?.type)).toEqual([11, 4]);
    expect(t.acts.some((a) => a.record?.type === 45)).toBe(true);
    // (No action of it moves a next pointer: it branches nowhere.)
    expect(t.acts.some((a) => "at" in a.dword && a.dword.field === "next")).toBe(false);
  });

  it("asks Command after an action that makes units, in a program that asks Bring, so that Bring counts again", () => {
    const { graph } = own(`createUnit(P1, units.TerranMarine, 2, locations.Anywhere);\nif (bring(P1, units.TerranMarine, locations.Anywhere, "==", 6)) print("six");`);
    const k = graph.triggers.findIndex((t) => t.acts.some((a) => a.record?.type === 44));
    expect(graph.triggers[k + 1].conds.map((c) => c.game?.type)).toEqual([2]);
    const alone = own(`createUnit(P1, units.TerranMarine, 2, locations.Anywhere);`).graph;
    expect(games(alone)).toEqual([]);
  });
});
