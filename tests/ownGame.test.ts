/**
 * The game's own conditions and actions in a map of our own (TrigScript 4, step 5 of the way off eudplib): laid out as
 * the game's records, byte for byte as the map's own triggers would hold them; a condition turned around in one
 * condition where one says it; an `if` of actions under conditions that fit in one trigger, that one trigger.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { emitOwn, type Own } from "../compiler/backend/own";
import type { MapPlayers } from "../compiler/backend/emit";
import type { TextPart } from "../compiler/ir";
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
  return { ...o, graph: o.runs[0].graph, strings: r.strings };
}
const games = (g: Graph) => g.triggers.flatMap((t) => t.conds.filter((c) => c.game).map((c) => c.game!));

describe("a map of our own, the game's conditions and actions", () => {
  it("lays a condition and an action out as the game's records, the action's texts among the map's strings", () => {
    const { graph } = own(`if (bring(P1, units.TerranMarine, locations.Anywhere, ">=", 5)) transmission("Report in.", units.TerranMarine, locations.Anywhere, "add", 0, "sound\\\\glue\\\\mousedown2.wav", 500);`);
    // (A Transmission is the first action of a trigger of its own: the condition is the branch's before it.)
    const c = graph.triggers.find((t) => t.conds.some((c) => c.game))!, a = graph.triggers.find((t) => t.acts[0]?.record)!;
    const texts = new Map<string, number>([["Report in.", 7], ["sound\\glue\\mousedown2.wav", 8]]);
    const out = layout({ graph, strings: 0, owner: 0, text: (s) => texts.get(s)!, arrays: new Map() });
    const cond: ConditionRecord = c.conds[0].game!, act: ActionRecord = { ...a.acts[0].record!, text: 7, wav: 8 };
    const record = encodeTriggers([{ ...emptyTrigger(), conditions: [cond], actions: [act] }]);
    // (A trigger's record is 8 bytes into its node.)
    const node = (t: typeof c) => out.triggers.get(t.label)! - out.address + 8;
    expect([...out.payload.subarray(node(c), node(c) + 20)]).toEqual([...record.subarray(0, 20)]);
    expect([...out.payload.subarray(node(a) + 320, node(a) + 352)]).toEqual([...record.subarray(320, 352)]);
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

  it("throws the game's counts away after an action that makes units, in a program that asks Bring or Command", () => {
    // (The game keeps Command's and Bring's counts until a query of the other kind or an action that kills or removes
    // units: Kill Unit of Player 12's units of type 228, which no unit is, in the same trigger.)
    for (const ask of [`bring(P1, units.TerranMarine, locations.Anywhere, "==", 6)`, `command(P1, units.TerranMarine, "==", 6)`]) {
      const { graph } = own(`createUnit(P1, units.TerranMarine, 2, locations.Anywhere);\nif (${ask}) print("six");`);
      const t = graph.triggers.find((t) => t.acts.some((a) => a.record?.type === 44))!;
      expect(t.acts.map((a) => a.record?.type)).toEqual([44, 22]);
      expect(t.acts[1].record).toMatchObject({ player: 11, unitId: 228 });
    }
    const alone = own(`createUnit(P1, units.TerranMarine, 2, locations.Anywhere);`).graph;
    expect(alone.triggers.flatMap((t) => t.acts).filter((a) => a.record).map((a) => a.record!.type)).toEqual([44]);
  });
});

describe("a map of our own, the game's actions with fields from values", () => {
  it("makes a field from a value a place of its variable, written with what else shares its dword", () => {
    const { graph } = own(`let kind: UnitType = units.TerranMarine;\nlet n = 3;\nif (n > 2) kind = units.TerranFirebat;\nsetDeaths(P1, kind, "add", 1);`);
    const t = graph.triggers.find((t) => t.acts.some((a) => a.record?.type === 45))!;
    const k = t.acts.findIndex((a) => a.record?.type === 45);
    expect(t.acts[k].record!.unitId).toBe(0);
    // (The unit type, the action's kind and its modifier share a dword: a write of the variable is the three.)
    const writes = graph.triggers.flatMap((x) => x.acts).filter((a) => "at" in a.dword && a.dword.at === t.label && typeof a.dword.field === "object" && "act" in a.dword.field && a.dword.field.part === "modifier");
    expect(writes.map((a) => a.value)).toContain(32 + 45 * 2 ** 16 + 8 * 2 ** 24);
  });

  it("does a unit count 255 at a time only where its range goes past 255, and nothing at 0 or below only where it may be", () => {
    const loops = (count: string) => {
      const { graph } = own(`${count}\ncreateUnit(P1, units.TerranMarine, count, locations.Anywhere);`);
      return graph.triggers.filter((t) => t.acts.some((a) => a.record?.type === 44)).length;
    };
    // (Known to be 3: one Create Unit, its count in its field. Anything: one in the loop of 255 and one for the rest.)
    expect(loops(`let count = 3;`)).toBe(1);
    expect(loops(`let count = 3;\nif (elapsedTime(">=", 1)) count = 400;`)).toBe(2);
  });

  it("puts a Transmission's started mark and its trigger's current action back after it, so that it shows each time", () => {
    const { graph } = own(`transmission("Report in.", units.TerranMarine, locations.Anywhere, "add", 0, "sound\\\\glue\\\\mousedown2.wav", 500);\nprint("after");`);
    const k = graph.triggers.findIndex((t) => t.acts[0]?.record?.type === 7);
    expect(graph.triggers[k].acts).toHaveLength(1);
    expect(graph.triggers[k + 1].acts.slice(0, 2).map((a) => ("at" in a.dword ? a.dword.field : null))).toEqual([{ act: 0, part: "flags" }, "current"]);
  });

  it("fills a template for a text made while the game runs, the action's text field naming it", () => {
    const { graph } = own(`let wave = 2;\nwave += 1;\nsetMissionObjectives(\`Survive wave \${wave}\`);`);
    const a = graph.triggers.flatMap((t) => t.acts).find((a) => a.record?.type === 12)!;
    expect(graph.templates?.map((t) => t.id)).toContain(a.textOf);
  });
});

describe("a map of our own, the game's numbers read as values", () => {
  it("reads one player's ore where the game keeps it, a bit at a time, entered at its highest group of eight bits", () => {
    const { graph } = own(`const n = minerals(P1);\nprint(\`\${n}\`);`);
    const ORE = 0x57f0f0;
    const bits = graph.triggers.flatMap((t) => t.conds).filter((c) => "game" in c.dword && c.dword.game === ORE && c.mask !== undefined);
    expect(bits).toHaveLength(32);
    // (Below 2^8, 2^16 and 2^24, a branch past the higher bits.)
    const entries = graph.triggers.flatMap((t) => t.conds).filter((c) => "game" in c.dword && c.dword.game === ORE && c.mask === undefined);
    expect(entries.map((c) => c.value)).toEqual([255, 65535, 2 ** 24 - 1]);
  });

  it("asks a count of units a bit at a time from the top, 12 bits, the condition's amount what is found so far", () => {
    const { graph } = own(`const n = countUnits(P1, units.TerranMarine);\nprint(\`\${n}\`);`);
    const asks = graph.triggers.flatMap((t) => t.conds).filter((c) => c.game?.type === 2);
    expect(asks).toHaveLength(12);
    expect(asks.every((c) => c.game!.comparison === 0)).toBe(true);
  });

  it("compares a number of the game's with a value as the condition itself, its amount a place of the value", () => {
    const { graph } = own(`let cost = 50;\ncost += 25;\nif (minerals(P1) >= cost) print("rich");\nif (minerals(P1) < 300) print("poor");`);
    const asks = graph.triggers.flatMap((t) => t.conds).filter((c) => c.game?.type === 4);
    // (No read: two Accumulate conditions, each turned around for the branch past its print — at most the value less
    // one, at least 300.)
    expect(asks.map((c) => c.game!.comparison).sort()).toEqual([0, 1]);
    expect(graph.triggers.flatMap((t) => t.conds).some((c) => "game" in c.dword && c.dword.game === 0x57f0f0)).toBe(false);
  });

  it("reads a player's race as its byte of the player table, and supply from its race's table", () => {
    const race = own(`if (race(P2) == races.Zerg) print("Zerg");`).graph;
    // (Player 2's race is the second byte of the dword at 0x57F1C0: its eight bits, moved down eight.)
    const masks = race.triggers.flatMap((t) => t.conds).filter((c) => "game" in c.dword && c.dword.game === 0x57f1c0).map((c) => c.mask);
    expect(masks).toEqual([0x8000, 0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100]);
    const supply = own(`const n = supply(P1, "used", races.Terran);\nprint(\`\${n}\`);`).graph;
    expect(supply.triggers.flatMap((t) => t.conds).some((c) => "game" in c.dword && c.dword.game === 0x582174 + 4 * 36)).toBe(true);
  });
});

describe("a map of our own, a print at the centre of the screen", () => {
  it("writes the text into the game's line of errors on the player's own computer, after raising the error", () => {
    const { graph } = own(`let n = 0;\nwhile (n < 12) n += 5;\nprint(\`Wave \${n}\`, { position: "center" });`);
    // (The template is the line itself; the Create Unit with the first free unit taken away comes before it.)
    expect(graph.templates?.find((t) => t.at === 0x640b60 + 218 * 12)).toBeDefined();
    expect(graph.triggers.some((t) => t.acts.some((a) => a.record?.type === 44) && t.acts.some((a) => "game" in a.dword && a.dword.game === 0x628438))).toBe(true);
    expect(graph.triggers.some((t) => t.conds.some((c) => "game" in c.dword && c.dword.game === 0x512684))).toBe(true);
  });
});

describe("a map of our own, the game's tables", () => {
  const actions = (g: Graph) => g.triggers.flatMap((t) => t.acts).filter((a) => a.record?.type === 45).map((a) => a.record!);
  it("writes a byte of a player's row as a masked Set Deaths into its dword", () => {
    // (Player 2's upgrade level: the second byte of a dword — its mask in the record's location, 'SC' in its last.)
    const [w] = actions(own(`stats(P2).upgrades[upgrades.TerranInfantryWeapons] = 3;`).graph);
    expect(w.mask).toBe(0x4353);
    expect([0xff, 0xff00, 0xff0000, 0xff000000]).toContain(w.location);
    expect(w.target).toBe(3 * (w.location / 0xff));
  });

  it("writes a flag as its bit, and reads a scaled field divided by its scale", () => {
    const [w] = actions(own(`stats(units.TerranMarine).detector = true;`).graph);
    expect(w.location.toString(2).replace(/0/g, "")).toBe("1");
    expect(w.target).toBe(w.location);
    // (Hit points are kept 256 to a point: the read divided by 256 — a quotient by a constant.)
    const r = own(`const hp = stats(units.TerranMarine).maxHp;\nprint(\`\${hp}\`);`).graph;
    expect(r.triggers.flatMap((t) => t.conds).filter((c) => "game" in c.dword && c.mask !== undefined).length).toBeGreaterThanOrEqual(24);
  });
});

describe("a map of our own, programs, owners and players", () => {
  const script = (source: string, players?: MapPlayers) => {
    lib ??= defaultLib();
    const r = compileScript(ts, { "main.ts": source }, defaultScriptNames(), { lib, emitter: false });
    expect(r.diagnostics).toEqual([]);
    return emitOwn(r, players);
  };
  const runsOf = (o: Own | string) => {
    if (typeof o === "string") throw new Error(o);
    return o.runs;
  };
  const ids = (g: Graph) => {
    const out = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) k === "var" && typeof v === "string" ? out.add(v) : walk(v);
    };
    walk(g.triggers);
    return out;
  };

  it("has a run for each program, and one for each player of a per-player program in the order of the slots", () => {
    const map = { slots: [0, 2, 5], forces: [0, 1, 0, 0, 0, 1, 0, 0] };
    const runs = runsOf(script(`program(() => { print("a"); });\nprogram(() => { print("b"); }, { owner: [P3, P1] });\nprogram(() => { print("c"); }, { owner: AllPlayers });\nprogram(() => { print("d"); }, { owner: players.Force2 });\nprogram(() => { print("e"); }, { owner: [P6, P3] });`, map));
    // (A list of owners, All Players and a force each run once for each of their players the map gives a slot.)
    expect(runs.map((r) => [r.program, r.player])).toEqual([[0, 0], [1, 0], [1, 2], [2, 0], [2, 2], [2, 5], [3, 5], [4, 2], [4, 5]]);
  });

  it("gives each run variables of its own, but for the shared ones, which are its program's", () => {
    const runs = runsOf(script(`program(() => {\n  let mine = 0;\n  let total = shared(0);\n  mine += 1;\n  total += mine;\n  print(\`\${mine} \${total}\`);\n}, { owner: [P1, P2] });\nprogram(() => {\n  let total = shared(0);\n  total += 2;\n  print(\`\${total}\`);\n}, { owner: [P1, P2] });`));
    const [a, b, c, d] = runs.map((r) => [...ids(r.graph)].filter((id) => !id.startsWith("@")));
    const named = (xs: string[], name: string) => xs.filter((id) => id.startsWith(`${name}#`)).sort();
    // (The first program's `total` the same cell in its two runs, its `mine` not; the second's `total` its own.)
    expect(named(a, "total")).toEqual(named(b, "total"));
    expect(named(a, "mine")).not.toEqual(named(b, "mine"));
    expect(named(c, "total")).toEqual(named(d, "total"));
    expect(named(c, "total")).not.toEqual(named(a, "total"));
    // (And no label of one run is another's.)
    const labels = runs.map((r) => new Set(r.graph.triggers.map((t) => t.label)));
    expect(labels.every((l, i) => labels.every((m, j) => i === j || [...l].every((x) => !m.has(x))))).toBe(true);
  });

  it("refuses a program owned by Players 9 to 12, and one the map gives nobody to run", () => {
    expect(script(`program(() => { print("x"); }, { owner: P9 });`)).toMatch(/a program owned by P9: a program runs for players 1 to 8, All Players or a force/);
    expect(script(`program(() => { print("x"); }, { owner: players.Force3 });`, { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] })).toMatch(/no human or computer player of this map is among the program's owners/);
  });

  it("asks whether a player has left in one condition: their list's first node exactly the list's own end", () => {
    const runs = runsOf(script(`program(() => {\n  if (hasLeft(P2)) print("gone");\n});`));
    const conds = runs[0].graph.triggers.flatMap((t) => t.conds).filter((c) => c.game);
    expect(conds.map((c) => c.game)).toMatchObject([{ type: 15, comparison: 10, player: (0x51a28c + 8 - 0x58a364) / 4 + 2 ** 32, amount: (~0x51a290 >>> 0) }]);
    // (A slot the map gives nobody has not left: no condition.)
    const none = runsOf(script(`program(() => {\n  if (hasLeft(P3)) print("gone");\n});`, { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }));
    expect(none[0].graph.triggers.flatMap((t) => t.conds).filter((c) => c.game)).toEqual([]);
  });

  it("links each player's list to an entry of their own, alone in it, its next pointer at the list's end", () => {
    const runs = runsOf(script(`program(() => { print("a"); });\nprogram(() => { print("b"); }, { owner: P2 });`));
    const players = [0, 1, 3];
    const texts = new Map<string, number>([["a", 7], ["b", 8]]);
    const out = layout({ runs: runs.map((r) => ({ graph: r.graph, owner: r.player })), players, strings: 0, text: (s) => texts.get(s)!, arrays: new Map() });
    // The start-up: each player's first and last trigger, the 61 between every player's.
    const records = out.trig.length / 2400;
    expect(records).toBe(2 * players.length + 61);
    const owners = (k: number) => [...out.trig.subarray(2400 * k + 2372, 2400 * k + 2380)].flatMap((b, p) => (b ? [p] : []));
    expect([owners(0), owners(1), owners(2), owners(3), owners(records - 1)]).toEqual([[0], [1], [3], players, [3]]);
    const tv = new DataView(out.trig.buffer, out.trig.byteOffset);
    const pv = new DataView(out.payload.buffer, out.payload.byteOffset);
    const node = (addr: number, at: number) => pv.getUint32(addr - out.address + at, true);
    for (const [k, p] of players.entries()) {
      // (The last per-player trigger sets the list's last node's next pointer — the current player — to the entry.)
      const entry = tv.getUint32(2400 * (records - players.length + k) + 320 + 20, true);
      const list = 0x51a280 + 12 * p;
      expect([node(entry, 0), node(entry, 4)]).toEqual([list + 4, ~(list + 4) >>> 0]);
      // Its actions: the list made the entry alone, the entry's next pointer the gate's.
      expect([0, 1].map((a) => (node(entry, 328 + 32 * a + 16) * 4 + 0x58a364) >>> 0)).toEqual([list + 8, list + 4]);
      expect([node(entry, 328 + 20), node(entry, 328 + 32 + 20)]).toEqual([entry, entry]);
      // The gate: one condition for each player before this one, their list empty.
      const gate = node(entry, 328 + 64 + 20);
      const conds = [0, 1, 2, 3].filter((c) => pv.getUint8(gate - out.address + 8 + 20 * c + 15) === 15);
      expect(conds.length).toBe(players.filter((q) => q < p).length);
    }
  });
});

describe("a map of our own, texts known when built chosen while the game runs", () => {
  const ownOf = (body: string, base = 1) => {
    lib ??= defaultLib();
    const r = compileScript(ts, { "main.ts": `program(() => {\n  let n = 0;\n  let i = 0;\n  while (n < 12) n += 5;\n  while (i < 3) i += 1;\n${body}\n});\n` }, defaultScriptNames(), { lib, emitter: false });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r, undefined, base);
    if (typeof o === "string") throw new Error(o);
    return o;
  };
  const acts = (o: Own) => o.runs.flatMap((r) => r.graph.triggers.flatMap((t) => t.acts));

  it("numbers the pool's texts in the order texts compare, from the string it is given", () => {
    const o = ownOf(`  print(n > 10 ? "b" : "ab");\n  print(i > 2 ? "a" : "é");`, 40);
    expect(o.texts).toEqual(["a", "ab", "b", "é"]);
    // (A chosen text alone is Display Text of the string its number names: the base added to the number.)
    const shown = acts(o).filter((a) => a.record?.type === 9);
    expect(shown.length).toBe(2);
    expect(shown.every((a) => !a.display)).toBe(true);
  });

  it("compares two chosen texts as their numbers, and looks up what a function of one gives", () => {
    const o = ownOf(`  const a = n > 10 ? "Medic" : "Marine";\n  if (a < "Mf" && a.length == 5 && a.includes("ed")) print("yes");`);
    // No text is compared byte by byte: no condition reads a template or the strings.
    expect(o.runs[0].graph.templates ?? []).toEqual([]);
    expect(o.texts).toEqual(["Marine", "Medic", "Mf", "ed"]);
  });

  it("reads a function of a known text at a variable from a table within the variable's range", () => {
    const o = ownOf(`  const s = "Terran Marine";\n  print(\`\${s.charCodeAt(i)}\`);`);
    // (i is 0 to 3 as the loop leaves it — its range — so the table has no more cells than that.)
    const table = o.programs[0].arrays.find((a) => a.id.startsWith("@text.table"))!;
    expect(table.values!.length).toBeLessThanOrEqual(5);
    expect(table.values!.slice(0, 4)).toEqual([84, 101, 114, 114]);
  });

  it("writes a choice of many texts into a printed text's field whole, a case for each run of places with one text", () => {
    const o = ownOf(`  const s = "Terran Marine";\n  print(\`[\${s[i + 3]}]\`);`);
    const picks = o.programs[0].body.flatMap((s) => (s.kind === "print" ? s.parts.filter((p) => p.kind === "pick") : []));
    expect(picks.length).toBe(1);
    const cases = (picks[0] as Extract<TextPart, { kind: "pick" }>).cases;
    // (i is 0 to 3: the characters 3 to 6.)
    expect(cases.map((c) => c.text).join("")).toBe("ran ");
  });
});
