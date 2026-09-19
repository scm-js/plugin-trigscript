/**
 * Units on the map and the game's tables (slice 3): what the front end makes of them, what it
 * refuses, and what the interpreter — whose model is the Python lowering's — does with them.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation, type ProgramSimulationOptions, type SimUnitInit } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";
import type { Stmt } from "../compiler/ir";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const MARINE = 0, ZERGLING = 37, COMMAND_CENTER = 106;

const compileFile = (src: string): CompileResult => compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
const compile = (body: string, options = ""): CompileResult => {
  const r = compileFile(`program(() => {${body}}${options});`);
  expect(r.diagnostics.map((d) => `${d.line}:${d.message}`)).toEqual([]);
  return r;
};
const errors = (body: string): string[] => compileFile(`program(() => {\n${body}\n});`).diagnostics.map((d) => `${d.line}:${d.message}`);

const WORLD: SimUnitInit[] = [
  { type: MARINE, owner: 0, x: 100, y: 100, hp: 40 },
  { type: MARINE, owner: 0, x: 500, y: 100, hp: 25, maxHp: 40 },
  { type: ZERGLING, owner: 1, x: 120, y: 110, hp: 35 },
  { type: ZERGLING, owner: 1, x: 900, y: 900, hp: 35, burrowed: true },
  { type: COMMAND_CENTER, owner: 0, x: 300, y: 300, hp: 1500 },
];
const LOCATIONS = { 1: { left: 0, top: 0, right: 256, bottom: 256 }, 2: { left: 480, top: 80, right: 520, bottom: 120 } };
const run = (body: string, frames = 1, options: Partial<ProgramSimulationOptions> = {}, programOptions = "") => {
  const r = compile(body, programOptions);
  return new ProgramSimulation(r.ir, { strings: r.strings, units: WORLD, locations: LOCATIONS, ...options }).run(frames);
};
const at = (n: number) => `(${n} as Location)`;

describe("units: the front end", () => {
  it("a loop over units, a pick and their fields arrive as IR", () => {
    const r = compile(`for (const u of unitsAt(${at(1)}, { owner: P2 })) u.hp = u.maxHp / 2; const t = nearest(units.TerranMarine, ${at(2)}, { owner: P1 }); if (t) t.order("move", ${at(1)});`);
    const [loop, decl, test] = r.ir[0].body as Stmt[];
    expect(loop).toMatchObject({ kind: "unitLoop", filter: { at: 1, owner: 1 }, decl: { kind: "unit", name: "u" } });
    expect((loop as Extract<Stmt, { kind: "unitLoop" }>).body[0]).toMatchObject({ kind: "unitWrite", field: "hp", unit: { kind: "unitVar" }, value: { kind: "binary", op: "/", left: { kind: "unitField", field: "maxHp" } } });
    expect(decl).toMatchObject({ kind: "declare", decl: { kind: "unit", name: "t" }, init: { kind: "pick", by: "nearest", near: 2, filter: { type: MARINE, owner: 0 } } });
    expect(test).toMatchObject({ kind: "if", cond: { kind: "unitAlive" }, then: [{ kind: "unitDo", verb: { do: "order", order: "move", target: 1 } }] });
    expect(r.variables.map((v) => `${v.name}:${v.kind}`)).toEqual(["u:unit", "t:unit"]);
  });
  it("Anywhere and Any Unit are no filter at all", () => {
    const r = compile(`for (const u of unitsAt(locations.Anywhere, { type: units.AnyUnit })) u.kill();`);
    expect(r.ir[0].body[0]).toMatchObject({ kind: "unitLoop", filter: {} });
    expect((r.ir[0].body[0] as Extract<Stmt, { kind: "unitLoop" }>).filter).toEqual({});
  });
  it("a scan is worth a word at the end of its line", () => {
    const r = compile(`while (true) {\n for (const u of allUnits()) u.heal(1);\n const r = randomUnit();\n if (r) r.kill();\n sleep(seconds(1)); }`, ", { owner: AllPlayers }");
    expect(r.hints.map((h) => `${h.line}:${h.label}`)).toEqual(["2:scans units", "3:scans units ×2"]);
    expect(r.hints[0].note).toContain("once for each player");
  });
  it("stats() is told apart by what its argument is", () => {
    const r = compile(`stats(units.TerranMarine).minerals = 25; stats(upgrades.TerranInfantryArmor).minerals = 50; stats(P3).color = "teal"; stats(units.TerranMarine).speed = 6.5; stats(units.ZergZergling).supplyUsed = 0.5; stats(units.ZergZergling).name = "Dog";`);
    const cells = (r.ir[0].body as Extract<Stmt, { kind: "tableWrite" }>[]).map((s) => [s.cell.name, s.cell.index, s.value]);
    expect(cells).toEqual([
      ["unit.minerals", 0, { kind: "const", value: 25 }],
      ["upgrade.minerals", 0, { kind: "const", value: 50 }],
      ["player.color", 2, { kind: "const", value: 159 }],
      ["unit.speed", 0, { kind: "const", value: 1664 }],
      ["unit.supplyUsed", ZERGLING, { kind: "const", value: 1 }],
      ["unit.name", ZERGLING, { kind: "text", text: "Dog" }],
    ]);
  });

  it("says what cannot be done", () => {
    expect(errors(`for (const u of allUnits()) { u.kill(); sleep(seconds(1)); }`)[0]).toMatch(/^2:sleep\(\) inside a loop over units/);
    // TypeScript says it first: the declarations have what the game keeps for itself as readonly.
    expect(errors(`const u = first(); if (u) u.x = 5;`)).toEqual(["2:Cannot assign to 'x' because it is a read-only property."]);
    expect(errors(`let n = 0; n = stats(units.TerranMarine).speed;`)[0]).toMatch(/can be set but not read/);
    expect(errors(`stats(upgrades.TerranInfantryArmor).maxLevel = 5;`).join()).toMatch(/read.?only/i);
    expect(errors(`stats(P1).color = "mauve";`)[0]).toMatch(/"mauve"' is not assignable/);
    expect(errors(`stats(P1).color = "mauve" as ColorName;`)[0]).toMatch(/Unknown colour "mauve"/);
    expect(errors(`stats(units.TerranMarine).minerals = 70000;`)[0]).toMatch(/holds 0 … 65535/);
    expect(errors(`let p = 1; for (const u of unitsOf(P1, { at: p as Location })) u.kill();`)[0]).toMatch(/must be known when the script is built, but p is a variable/);
    expect(errors(`const u = first(); if (u) u.order("dance" as "move", locations.Anywhere);`)[0]).toMatch(/order\(\) takes "move", "patrol" or "attack"/);
    expect(errors(`let n = 5; n = first();`).length).toBeGreaterThan(0);
  });
  it("a plain number says nothing about which table", () => {
    const r = compileFile(`program(() => { stats(5 as number as UnitType).minerals = 1; const n: number = 5; stats(n as never).minerals = 1; });`);
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/stats\(\) takes a unit type, a weapon/);
  });
  it("units exist in the game only", () => {
    const r = compileFile(`for (const u of allUnits()) { } `);
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/allUnits\(\) is about the units in the game/);
  });
  it("a unit needs its null check, as TypeScript has it", () => {
    const r = compileFile(`program(() => { const u = first(); u.kill(); });`);
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/possibly 'null'/);
  });
});

describe("units: in the simulated game", () => {
  it("a loop runs for the units that match, in table order, within the frame", () => {
    const sim = run(`let n = 0; for (const u of unitsAt(${at(1)})) { n++; u.hp = u.maxHp / 2; }`);
    expect(sim.value("n")).toBe(2);
    expect(sim.units.map((u) => u.hp)).toEqual([20, 25, 17, 35, 1500]);
  });
  it("filters: owner, type, the trigger classes, the current player", () => {
    expect(run(`let n = 0; for (const u of unitsOf(P1, { type: units.Men })) n++;`).value("n")).toBe(2);
    expect(run(`let n = 0; for (const u of allUnits({ type: units.Buildings })) n++;`).value("n")).toBe(1);
    expect(run(`let n = 0; for (const u of unitsOf(CurrentPlayer)) n++;`, 1, { player: 1 }, ", { owner: P2 }").value("n")).toBe(2);
  });
  it("break and continue are the loop's", () => {
    const sim = run(`let n = 0; for (const u of allUnits()) { if (u.burrowed) continue; if (u.type == units.TerranCommandCenter) break; n++; }`);
    expect(sim.value("n")).toBe(3);
  });
  it("picks: the first, the nearest, one at random, none", () => {
    const sim = run(`const a = first({ owner: P2 }); const b = nearest(units.TerranMarine, ${at(2)}); const c = randomUnit({ type: units.ZergZergling }); const d = first({ owner: P5 }); let ax = 0; let bx = 0; let cx = 0; let none = 0; if (a) ax = a.x; if (b) bx = b.x; if (c) cx = c.x; if (d == null) none = 1;`, 1, { random: () => 0.99 });
    expect([sim.value("ax"), sim.value("bx"), sim.value("cx"), sim.value("none")]).toEqual([120, 500, 900, 1]);
  });
  it("a unit that is gone reads 0 and takes no write; if (u) asks", () => {
    const sim = run(`let kept = first({ owner: P2 }); let before = 0; let after = 9; let there = true; if (kept) before = kept.hp; if (kept) kept.kill(); sleep(frames(1)); if (kept) { there = true; } else { there = false; } after = kept ? kept.hp : 0; if (kept) kept.hp = 99;`, 3);
    expect([sim.value("before"), sim.value("after"), sim.value("there")]).toEqual([35, 0, false]);
    expect(sim.units[2]).toMatchObject({ alive: false, hp: 35 });
    expect(sim.events.map((e) => e.text)).toEqual(["unit 2 (type 37, P2)"]);
  });
  it("first() after a kill is the next one: a loop that ends", () => {
    const sim = run(`let n = 0; let u = first({ owner: P2 }); while (u) { u.kill(); n++; u = first({ owner: P2 }); }`);
    expect(sim.value("n")).toBe(2);
  });
  it("damage, heal and the percent forms; hit points at 0 are a death", () => {
    const sim = run(`for (const u of unitsOf(P1, { type: units.TerranMarine })) { u.damage({ percent: 50 }); } const cc = first({ type: units.TerranCommandCenter }); if (cc) { cc.damage(2000); } const z = first({ owner: P2 }); if (z) { z.damage(5); z.heal(100); }`);
    expect(sim.units.map((u) => [u.hp, u.alive])).toEqual([[20, true], [5, true], [35, true], [35, true], [0, false]]);
  });
  it("fields stop at what the game's cell holds", () => {
    const sim = run(`const u = first(); if (u) { u.energy = 900; u.kills += 300; u.stim = 1000; u.invincible = true; u.cooldown = 24; }`);
    expect(sim.units[0]).toMatchObject({ energy: 255, kills: 255, stim: 255, invincible: true, cooldown: 24 });
  });
  it("give, locate and order", () => {
    const sim = run(`const u = first({ owner: P2 }); if (u) { u.give(P1); u.locate(${at(2)}); u.order("attack", ${at(1)}); } let n = 0; for (const v of unitsAt(${at(2)}, { owner: P1 })) n++;`);
    expect(sim.units[2].owner).toBe(0);
    expect(sim.locations.get(2)).toEqual({ left: 100, top: 90, right: 140, bottom: 130 });
    // The box, moved onto the Zergling, holds it and the Marine beside it.
    expect(sim.value("n")).toBe(2);
    expect(sim.events.map((e) => e.text)).toEqual(["attack: unit 2 (type 37, P1)"]);
  });
  it("functions take and return units; == says whether two are one", () => {
    const sim = run(`function weakest(): Unit | null { let best: Unit | null = null; let least = 9999; for (const u of unitsOf(P1, { type: units.Men })) { if (u.hp < least) { least = u.hp; best = u; } } return best; }
      function hurt(u: Unit, by: number) { u.damage(by); }
      const w = weakest(); let same = 0; let other = 0;
      if (w) { hurt(w, 5); if (w == first({ type: units.TerranMarine, at: ${at(2)} })) same = 1; if (w != first()) other = 1; }`);
    expect(sim.units[1].hp).toBe(20);
    expect([sim.value("same"), sim.value("other")]).toEqual([1, 1]);
  });
  it("a unit in a text is its numbers", () => {
    const sim = run(`const u = first(); if (u) print(\`\${u.hp} of \${u.maxHp} at \${u.x}\`);`);
    expect(sim.events.map((e) => e.text)).toEqual(["40 of 40 at 100"]);
  });
  it("each player of a per-player program keeps a unit of their own", () => {
    const r = compile(`let mine: Unit | null = null; if (!mine) mine = first({ owner: CurrentPlayer }); if (mine) mine.heal(1);`, ", { owner: AllPlayers }");
    expect(r.ir[0].perPlayer).toBe(true);
  });
});

describe("stats(): the game's tables", () => {
  it("what a program writes is what it reads, in the script's units", () => {
    const sim = run(`stats(units.TerranMarine).minerals = 25; stats(units.TerranMarine).minerals += 5; stats(units.TerranMarine).buildTime = 1.5; stats(units.TerranGhost).permanentCloak = true;
      let cost = stats(units.TerranMarine).minerals; let time = stats(units.TerranMarine).buildTime; let cloaked = stats(units.TerranGhost).permanentCloak; let other = stats(units.TerranFirebat).minerals;
      stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3; let level = stats(P1).upgrades[upgrades.TerranInfantryWeapons]; stats(P1).researched[techs.Lockdown] = true; let has = stats(P1).researched[techs.Lockdown];`, 1, { table: (c) => (c.name === "unit.minerals" ? 50 : undefined) });
    expect([sim.value("cost"), sim.value("time"), sim.value("cloaked"), sim.value("other"), sim.value("level"), sim.value("has")]).toEqual([30, 1, true, 50, 3, true]);
    expect(sim.tables.get("unit.buildTime:0")).toBe(23);
  });
  it("a cell holds what its width allows", () => {
    const sim = run(`let big = 300; stats(units.TerranMarine).armor = big; stats(units.ZergZergling).name = "Dog"; stats(CurrentPlayer).color = colors.green;`);
    expect(sim.tables.get("unit.armor:0")).toBe(255);
    expect(sim.tables.get("unit.name:37")).toBe("Dog");
    expect(sim.tables.get("player.color:0")).toBe(117);
  });
});

describe("units: the methods that take a function (slice 8½)", () => {
  it("the units of the game: forEach, some, every, find, filter, reduce", () => {
    const sim = run(`let n = 0; unitsOf(P1, { type: units.TerranMarine }).forEach((u) => { n++; u.hp = u.hp + 1; });
      let hurt = false; hurt = unitsOf(P1).some((u) => u.hp < 30);
      let all = false; all = allUnits({ type: units.TerranMarine }).every((u) => u.hp > 20);
      const weak = unitsOf(P1, { type: units.TerranMarine }).find((u) => u.hp < 30); let weakHp = 0; if (weak) weakHp = weak.hp;
      const none = unitsOf(P1).find((u) => u.hp > 5000); let found = true; found = none != null;
      const squad = unitsOf(P1).filter((u) => u.hp < 100); let size = 0; size = squad.length;
      let total = 0; total = unitsOf(P1, { type: units.TerranMarine }).reduce((sum, u) => sum + u.hp, 0);`);
    expect(sim.value("n")).toBe(2);
    expect(sim.value("hurt")).toBe(true);
    expect(sim.value("all")).toBe(true);
    expect(sim.value("weakHp")).toBe(26);
    expect(sim.value("found")).toBe(false);
    expect(sim.value("size")).toBe(2);
    expect(sim.value("total")).toBe(67);
    expect(sim.faults).toEqual([]);
  });
  it("an array of units: filter, find, sort by a field, reverse, map to numbers", () => {
    const sim = run(`const mine = allUnits().filter((u) => u.owner == P1);
      mine.sort((a, b) => a.hp - b.hp);
      const lowest = mine[0]; let low = 0; if (lowest) low = lowest.hp;
      mine.reverse(); const top = mine[0]; let high = 0; if (top) high = top.hp;
      const healthy = mine.find((u) => u.hp == 40); let h = 0; if (healthy) h = healthy.x;
      const hps = mine.map((u) => u.hp); let where = 0; where = mine.findIndex((u) => u.hp == 25);`);
    expect(sim.value("low")).toBe(25);
    expect(sim.value("high")).toBe(1500);
    expect(sim.value("h")).toBe(100);
    expect(sim.list("hps")).toEqual([1500, 40, 25]);
    expect(sim.value("where")).toBe(2);
  });
  it("the units of the game have no place and no order", () => {
    expect(errors("let n = 0; n = unitsOf(P1).findIndex((u) => u.hp > 1);").join("\n")).toMatch(/findIndex|no order/);
    expect(errors("unitsOf(P1).forEach((u) => { sleep(seconds(1)); });").join("\n")).toMatch(/for…of over the same list can sleep|loop over units/);
  });
});
