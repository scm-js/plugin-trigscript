/**
 * The structured level: `program(() => { … })` bodies compile to death-counter state
 * machines, and the simulator (a trigger-cycle interpreter) proves they behave — one loop
 * iteration per cycle, straight-line code within a cycle, saturating counters, switches
 * as booleans.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ActionType, Comparison, ConditionType, emptyTrigger, PlayerGroup, SetModifier, SwitchState, TriggerFlag, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { compileScript, DEATHS_TABLE_ADDRESS, type CompileOptions, type CompileResult } from "../compiler/compiler";
import { negateCondition, toDnf, cond, not, and, or, TRUE, FALSE, VARIABLE_UNITS } from "../compiler/lower";
import { defaultScriptNames } from "../compiler/names";
import { Simulation } from "../compiler/simulate";
import { buildScript, reservedStorage, resolveStrings } from "../script";
import { unitName } from "../vendor/units";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();

/** A trigger owned by the given player groups. */
function newTrigger(players: number[]): TriggerRecord {
  const t = emptyTrigger();
  for (const p of players) t.players[p] = 1;
  return t;
}
type Reserved = Pick<CompileOptions, "reservedDeaths" | "reservedSwitches">;
const compile = (src: string, options: Reserved = {}) => compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB, ...options });
/** A body as the whole script's one program (the wrapper takes line 1, so the body's first line is 2). */
const program = (body: string, options = "") => `program(() => {${body}}${options ? `, ${options}` : ""});`;

function ok(src: string, options?: Reserved): CompileResult {
  const r = compile(src, options);
  expect(r.diagnostics).toEqual([]);
  return r;
}

const okProgram = (body: string, options?: Reserved) => ok(program(body), options);

function run(r: CompileResult, cycles: number, extra: ConstructorParameters<typeof Simulation>[1] = {}): Simulation {
  return new Simulation(r.triggers, { strings: r.strings, ...extra }).run(cycles);
}

/** The value of a program variable after a simulation. */
function value(sim: Simulation, r: CompileResult, name: string): number {
  const v = r.variables.find((x) => x.name === name)!;
  return v.kind === "number" ? sim.death(v.player!, v.unit!) : sim.switches[v.switch!];
}

const texts = (sim: Simulation) => sim.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`);

describe("structured: loops and branches", () => {
  it("a game loop runs once per cycle", () => {
    const r = okProgram(`
      let n = 0;
      while (true) {
        n += 1;
        if (n == 3) { victory(); }
      }
    `);
    expect(r.programs).toMatchObject([{ owner: 0, start: 0, source: { file: "main.ts", line: 1 } }]);
    expect(r.variables.map((v) => v.name)).toEqual(["(program counter)", "n"]);
    expect(r.variables[0]).toMatchObject({ kind: "number", player: 0, unit: 181, storage: "P1 · Cantina (Unused)" });
    expect(r.variables[1]).toMatchObject({ player: 1, unit: 181 });
    // Every trigger is preserved, owned by P1, and tests the program counter first.
    for (const t of r.triggers) {
      expect(t.flags).toBe(TriggerFlag.Preserve);
      expect(t.players[PlayerGroup.Player1]).toBe(1);
      expect(t.conditions[0]).toMatchObject({ type: ConditionType.Deaths, player: 0, unitId: 181, comparison: Comparison.Exactly });
      expect(t.actions[0].type).toBe(ActionType.Comment);
    }
    expect(r.strings.map((s) => "text" in s && s.text)).toContain("L4: n += 1");
    expect(r.sources.every((s) => s?.file === "main.ts")).toBe(true);
    const sim = run(r, 6);
    expect(sim.events.map((e) => `${e.cycle}:${ActionType.Victory === e.action.type ? "Victory" : e.action.type}`)).toEqual(["2:Victory"]);
    expect(value(sim, r, "n")).toBe(6);
  });

  it("if / else if / else, nested", () => {
    const r = okProgram(`
      let n = 0;
      let out = 0;
      while (true) {
        if (n == 0) { out = 10; }
        else if (n == 1) { out = 20; if (out >= 20) { out += 1; } }
        else { out = 30; }
        displayText("tick");
        n++;
      }
    `);
    const sim = new Simulation(r.triggers, { strings: r.strings });
    const outs: number[] = [];
    for (let i = 0; i < 4; i++) { sim.step(); outs.push(value(sim, r, "out")); }
    expect(outs).toEqual([10, 21, 30, 30]);
    expect(texts(sim)).toEqual(["0:tick", "1:tick", "2:tick", "3:tick"]);
  });

  it("for with break and continue; the code after the loop runs the cycle it exits", () => {
    const r = okProgram(`
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        if (i == 2) continue;
        if (i == 5) break;
        sum += i;
      }
      displayText("done");
    `);
    const sim = run(r, 8);
    expect(texts(sim)).toEqual(["5:done"]);
    expect(value(sim, r, "sum")).toBe(8);
    expect(value(sim, r, "i")).toBe(5);
    // Halted: the program counter sits on a state no trigger tests.
    expect(sim.death(0, 181)).toBe(0xffffffff);
  });

  it("do … while and while (cond) with a variable condition", () => {
    const r = okProgram(`
      let n = 0;
      do { n++; } while (n < 3);
      let m = 10;
      while (m > 7) { m--; }
      victory();
    `);
    const sim = run(r, 10);
    expect(sim.events.map((e) => e.cycle)).toEqual([5]);
    expect(value(sim, r, "n")).toBe(3);
    expect(value(sim, r, "m")).toBe(7);
  });

  it("an endless loop needs no halt and the first loop needs no jump", () => {
    const r = okProgram(`while (true) { wait(100); }`);
    expect(r.triggers.length).toBe(1);
    expect(r.triggers[0].conditions).toEqual([expect.objectContaining({ amount: 0 })]);
    expect(r.triggers[0].actions.map((a) => a.type)).toEqual([ActionType.Comment, ActionType.Wait, ActionType.SetDeaths]);
    expect(run(r, 3).events.length).toBe(3);
  });
});

describe("structured: arithmetic", () => {
  it("copies, adds and subtracts between variables within one cycle", () => {
    const r = okProgram(`
      let a = 5;
      let b = 0;
      b = a;
      a += b;
      a = a - b + 2;
      b = a + b;
      let c = b - a;
      let d = a;
      d = 100 - d;
      if (a == 7 && b == 12 && c == 5 && d == 93) { victory(); }
    `);
    const sim = run(r, 1);
    expect([value(sim, r, "a"), value(sim, r, "b"), value(sim, r, "c"), value(sim, r, "d")]).toEqual([7, 12, 5, 93]);
    expect(sim.events.map((e) => e.action.type)).toEqual([ActionType.Victory]);
    // Temporaries are zero again.
    for (const v of r.variables) if (v.name.startsWith("(temporary")) expect(sim.death(v.player!, v.unit!)).toBe(0);
  });

  it("x += x, x -= x, ++ / --, saturation and wrap", () => {
    const r = okProgram(`
      let x = 6;
      x += x;
      let y = x;
      y -= y;
      let z = 3;
      z -= 5;
      let w = 4294967295;
      w += 1;
      x++;
      x--;
      x--;
    `);
    const sim = run(r, 1);
    expect([value(sim, r, "x"), value(sim, r, "y"), value(sim, r, "z"), value(sim, r, "w")]).toEqual([11, 0, 0, 0]);
  });

  it("build-time values fold: consts inside and outside the program, arithmetic, the standard library", () => {
    const r = ok(`
      const outer = 3;
      const table = { bonus: 4 };
      ${program(`
      const k = outer * 2;
      let x = k + 1;
      x += Math.max(k * 2, table.bonus);
      if (x >= k * 3) { victory(); }
      `)}
    `);
    const sim = run(r, 1);
    expect(value(sim, r, "x")).toBe(19);
    expect(sim.events.length).toBe(1);
    // No temporaries were needed.
    expect(r.variables.map((v) => v.name)).toEqual(["(program counter)", "x"]);
  });
});

describe("structured: conditions", () => {
  it("compares variables with constants through one Deaths condition each", () => {
    const r = okProgram(`
      let x = 4;
      if (x >= 4) displayText("ge");
      if (x > 4) displayText("gt");
      if (x <= 4) displayText("le");
      if (x < 4) displayText("lt");
      if (x == 4) displayText("eq");
      if (x != 4) displayText("ne");
      if (5 > x) displayText("flip");
      if (x + 1 == 5) displayText("shift");
      if (x >= -1) displayText("unsigned");
      if (!(x < 4)) displayText("neg");
    `);
    expect(r.variables.map((v) => v.name)).toEqual(["(program counter)", "x"]);
    expect(texts(run(r, 1))).toEqual(["0:ge", "0:le", "0:eq", "0:flip", "0:shift", "0:unsigned", "0:neg"]);
    const ge = r.triggers.find((t) => t.conditions[1]?.amount === 4 && t.conditions[1].comparison === Comparison.AtLeast);
    expect(ge).toBeDefined();
  });

  it("compares variables with variables through saturating differences", () => {
    const r = okProgram(`
      let a = 3;
      let b = 5;
      if (a < b) displayText("lt");
      if (a >= b) displayText("ge");
      if (a == b) displayText("eq");
      if (a != b) displayText("ne");
      if (a + 2 == b) displayText("eq2");
      if (b - a > 1) displayText("gt");
      if (a <= b && b >= a) displayText("both");
      if (a - b == 0) displayText("never");
    `);
    const sim = run(r, 1);
    expect(texts(sim)).toEqual(["0:lt", "0:ne", "0:eq2", "0:gt", "0:both"]);
    expect([value(sim, r, "a"), value(sim, r, "b")]).toEqual([3, 5]);
  });

  it("booleans are switches; random() is a randomized switch", () => {
    const r = okProgram(`
      let x = 2;
      let f = false;
      let g = true;
      f = !f;
      if (f && g) displayText("both");
      if (f == g) displayText("same");
      g = x < 2;
      if (f != g) displayText("differ");
      if (!(f || g)) displayText("neither");
      g = x >= 2 || f;
      if (g) displayText("computed");
      let r = random();
      if (r) displayText("heads");
      if (random() && random()) displayText("twice");
      f = random();
    `);
    const f = r.variables.find((v) => v.name === "f")!;
    expect(f).toMatchObject({ kind: "boolean", switch: 255, storage: "Switch 256" });
    expect(r.variables.filter((v) => v.name.startsWith("(scratch")).length).toBe(2);
    expect(texts(run(r, 1, { random: () => 0.9 }))).toEqual(["0:both", "0:same", "0:differ", "0:computed", "0:heads", "0:twice"]);
    expect(texts(run(r, 1, { random: () => 0.1 }))).toEqual(["0:both", "0:same", "0:differ", "0:computed"]);
    const toggle = r.triggers.flatMap((t) => t.actions).find((a) => a.type === ActionType.SetSwitch && a.target === 255 && a.modifier === 6);
    expect(toggle).toBeDefined();
  });

  it("trigger conditions, negated where the game can and skipped where it cannot", () => {
    const r = ok(`
      const marines = bring(P1, units.TerranMarine, locations.Anywhere, ">=", 1);
      ${program(`
      const most = commandTheMost(units.TerranMarine);
      if (!marines) displayText("none");
      if (marines) displayText("some");
      if (!most && always()) displayText("skip");
      if (commandTheMost(units.TerranMarine) || switchIs(switches.Switch1, "set")) displayText("or");
      if (!(bring(P1, units.AnyUnit, locations.Anywhere, "==", 3))) displayText("notExactly");
      `)}
    `);
    const flipped = r.triggers.flatMap((t) => t.conditions).find((c) => c.type === ConditionType.Bring && c.comparison === Comparison.AtMost);
    expect(flipped).toMatchObject({ amount: 0, unitId: 0 });
    const exactly = r.triggers.flatMap((t) => t.conditions).filter((c) => c.type === ConditionType.Bring && c.unitId === 228);
    expect(exactly.map((c) => [c.comparison, c.amount])).toEqual([[Comparison.AtMost, 2], [Comparison.AtLeast, 4]]);
    // No units on the map: every "at most" holds, every "at least" fails.
    const sim = run(r, 1, { condition: (c) => c.type === ConditionType.Bring && c.comparison === Comparison.AtMost });
    expect(texts(sim)).toEqual(["0:none", "0:skip", "0:notExactly"]);
    // One marine on the map, and switch 1 set.
    const marine = (c: ConditionRecord) => c.type === ConditionType.Bring && (c.unitId === 0 ? c.comparison === Comparison.AtLeast && c.amount <= 1 : c.comparison === Comparison.AtMost && c.amount >= 1);
    const sim2 = new Simulation(r.triggers, { strings: r.strings, condition: marine });
    sim2.switches[0] = 1;
    sim2.run(1);
    expect(texts(sim2)).toEqual(["0:some", "0:skip", "0:or", "0:notExactly"]);
  });

  it("a list of conditions is all of them; arrays of actions run in order", () => {
    const r = ok(`
      const guard = [always(), switchIs(switches.Switch2, "set")];
      const burst = (n: number) => [createUnit(P1, units.ZergZergling, n, locations.Anywhere), displayText(\`burst \${n}\`)];
      ${program(`
      if (guard) burst(2);
      [displayText("a"), displayText("b")];
      `)}
    `);
    const sim = new Simulation(r.triggers, { strings: r.strings });
    sim.switches[1] = 1;
    sim.run(1);
    expect(sim.events.map((e) => e.text ?? e.action.type)).toEqual([ActionType.CreateUnit, "burst 2", "a", "b"]);
  });

  it("DNF: negation pushes to leaves, and/or distribute", () => {
    const a = cond({ type: ConditionType.Switch, resource: 1, comparison: SwitchState.Set } as ConditionRecord);
    const b = cond({ type: ConditionType.Always } as ConditionRecord);
    expect(toDnf(and([or([a, b]), or([a, b])])).length).toBe(4);
    expect(toDnf(not(and([a, b])))).toEqual([[{ cond: expect.objectContaining({ comparison: SwitchState.Cleared }), negative: false }], [{ cond: expect.objectContaining({ type: ConditionType.Never }), negative: false }]]);
    expect(toDnf(TRUE)).toEqual([[]]);
    expect(toDnf(not(FALSE))).toEqual([[]]);
    expect(toDnf(and([a, FALSE]))).toEqual([]);
    const most = { type: ConditionType.CommandTheMost, unitId: 0 } as ConditionRecord;
    expect(negateCondition(most)).toBe(null);
    expect(toDnf(not(cond(most)))).toEqual([[{ cond: most, negative: true }]]);
    expect(negateCondition({ type: ConditionType.Deaths, comparison: Comparison.AtLeast, amount: 0 } as ConditionRecord)).toEqual([expect.objectContaining({ type: ConditionType.Never })]);
  });
});

describe("structured: functions", () => {
  it("inline with parameters by value, defaults and return; values reach library calls", () => {
    const r = okProgram(`
      let total = 0;
      function add(v: number, n: number = 2) {
        if (n == 0) return;
        v += n;      // v is a copy of the argument: total is not changed by this line
        total += v;  // the program's own variable is
      }
      function spawn(p: Player, count: number) {
        createUnit(p, units.ZergZergling, count + 1, locations.Anywhere);
        displayText(\`spawned \${count} for \${p}\`);
        add(total, count);
      }
      function show(x: number) {
        if (x >= 1) displayText("some");
      }
      add(total, 5);
      add(total);
      spawn(P2, 4);
      show(total);
      if (total == 28) victory();
    `);
    const sim = run(r, 1);
    expect(value(sim, r, "total")).toBe(28);
    expect(sim.events.map((e) => e.text ?? e.action.type)).toEqual([ActionType.CreateUnit, "spawned 4 for 1", "some", ActionType.Victory]);
    expect(sim.events[0].action).toMatchObject({ player: 1, unitId: 37, modifier: 5 });
    // `v` is assigned, so each call copies its argument; `x` only reads, so it is the caller's variable itself.
    expect(r.variables.filter((v) => v.name === "v")).toHaveLength(3);
    expect(r.variables.filter((v) => v.name === "x")).toHaveLength(0);
  });

  it("a boolean parameter that is assigned is a copy too", () => {
    const r = okProgram(`
      let f = false;
      function flip(b: boolean) { b = !b; if (b) displayText("in"); }
      flip(f);
      if (!f) displayText("still false");
    `);
    expect(texts(run(r, 1))).toEqual(["0:in", "0:still false"]);
    expect(r.variables.find((v) => v.name === "b")).toMatchObject({ kind: "boolean" });
  });

  it("locals inside functions get their own storage per call", () => {
    const r = okProgram(`
      let out = 0;
      function twice(n: number) {
        let t = n;
        t += t;
        out += t;
      }
      twice(3);
      twice(4);
    `);
    expect(value(run(r, 1), r, "out")).toBe(14);
    expect(r.variables.filter((v) => v.name === "t").length).toBe(2);
  });

  it("helpers outside the program run when the script is built", () => {
    const r = ok(`
      function waves(n: number) { return Array.from({ length: n }, (_, i) => createUnit(P1, units.ZergZergling, i + 1, locations.Anywhere)); }
      const level = { size: 2 };
      ${program(`
      let go = 0;
      while (true) {
        if (go >= 1) { waves(level.size); break; }
        go++;
      }
      `)}
    `);
    const sim = run(r, 3);
    expect(sim.events.map((e) => e.action.modifier)).toEqual([1, 2]);
  });
});

describe("structured: program options and layout", () => {
  it("owner, comments off, hyper triggers; triggers keep the order they were defined in", () => {
    const r = ok(`
      trigger(AllPlayers, [always()], [defeat()]);
      ${program(`
      let n = 0;
      while (true) { n++; if (n == 2) victory(); }
      `, "{ owner: P8, comments: false }")}
      hyperTriggers(P8);
    `);
    expect(r.programs).toMatchObject([{ owner: 7, start: 1 }]);
    expect(r.triggers[0].actions[0].type).toBe(ActionType.Defeat);
    const hyper = r.triggers.slice(-3);
    for (const t of hyper) {
      expect(t.players[7]).toBe(1);
      expect(t.actions.length).toBe(64);
      expect(t.actions.filter((a) => a.type === ActionType.Wait && a.time === 0).length).toBe(62);
      expect(t.actions[0].type).toBe(ActionType.Comment);
      expect(t.actions[63].type).toBe(ActionType.PreserveTrigger);
    }
    for (const t of r.triggers.slice(1, -3)) {
      expect(t.players[7]).toBe(1);
      expect(t.actions.some((a) => a.type === ActionType.Comment)).toBe(false);
    }
    expect(r.strings).toEqual([{ text: "Hyper trigger" }]);
    expect(r.sources.length).toBe(r.triggers.length);
    expect(r.sources.slice(-3)).toEqual([null, null, null]);
    const sim = run(r, 3, { player: 7 });
    expect(sim.events.filter((e) => e.action.type === ActionType.Victory).map((e) => e.cycle)).toEqual([1]);
  });

  it("two programs are two threads with their own counters; variableUnits override per program", () => {
    const r = ok(`
      ${program(`let a = 0; while (true) { a++; }`, "{ owner: P1 }")}
      ${program(`let b = 0; while (true) { b += 2; }`, "{ owner: P2, variableUnits: [units.ZergBeacon, units.TerranBeacon] }")}
    `);
    expect(r.programs.map((p) => [p.owner, p.start])).toEqual([[0, 0], [1, 2]]);
    expect(r.variables.map((v) => [v.name, v.unit, v.player])).toEqual([["(program counter)", 181, 0], ["a", 181, 1], ["(program counter)", 194, 0], ["b", 194, 1]]);
    const one = run(r, 3, { player: 0 });
    const two = run(r, 3, { player: 1 });
    expect(one.death(1, 181)).toBe(3);
    expect(two.death(1, 194)).toBe(6);
  });

  it("variables avoid the death counters and switches hand triggers use", () => {
    const hand = emptyTrigger();
    hand.players[PlayerGroup.Player1] = 1;
    hand.conditions.push({ type: ConditionType.Deaths, player: 0, unitId: 181, comparison: 0, amount: 1, location: 0, resource: 0, flags: 0, mask: 0 });
    hand.actions.push({ type: ActionType.SetSwitch, target: 255, modifier: 4, location: 0, text: 0, wav: 0, time: 0, player: 0, unitId: 0, flags: 0, padding: 0, mask: 0 });
    const switchNames = Array.from({ length: 256 }, (_, i) => `Switch ${i + 1}`);
    const reserved = reservedStorage([hand], switchNames, null);
    expect(reserved).toEqual({ reservedDeaths: [[0, 181]], reservedSwitches: [255] });
    // A switch the map names counts as used too; the block's own records do not.
    switchNames[7] = "Door";
    expect(reservedStorage([hand], switchNames, null).reservedSwitches).toEqual([7, 255]);
    expect(reservedStorage([hand], switchNames, { start: 0, count: 1, sources: [] }).reservedDeaths).toEqual([]);
    const src = program("let n = 0;\nlet f = true;");
    const r = ok(src, reserved);
    expect(r.variables.map((v) => [v.player, v.unit, v.switch])).toEqual([[1, 181, undefined], [2, 181, undefined], [undefined, undefined, 254]]);
    // The whole thing builds into the map: comments intern, the block is the program.
    const strings: string[] = [""];
    const intern = (t: string) => { strings.push(t); return strings.length - 1; };
    const { list, block } = buildScript([hand], new Map(), { "main.ts": src }, r, intern);
    expect(block).toMatchObject({ start: 1, count: r.triggers.length });
    expect(list[1].actions[0].type).toBe(ActionType.Comment);
    expect(resolveStrings(r, intern)[0].actions[0].text).toBeGreaterThan(0);
  });

  it("the default storage pool is made of units that cannot die", () => {
    for (const u of VARIABLE_UNITS) expect(unitName(u)).toMatch(/Unused/);
  });

  it("memory / setMemory are Deaths at the EPD player", () => {
    const r = ok(`trigger(P1, [memory(${DEATHS_TABLE_ADDRESS} + 8, ">=", 1)], [setMemory(0x6509B0, "set", 5)]);`);
    expect(r.triggers[0].conditions[0]).toMatchObject({ type: ConditionType.Deaths, player: 2, unitId: 0, comparison: Comparison.AtLeast, amount: 1 });
    expect(r.triggers[0].actions[0]).toMatchObject({ type: ActionType.SetDeaths, player: (0x6509b0 - DEATHS_TABLE_ADDRESS) / 4, unitId: 0, modifier: SetModifier.SetTo, target: 5 });
    const bad = compile("trigger(P1, [memory(3, \">=\", 1)], []);");
    expect(bad.diagnostics.map((d) => d.message)).toEqual(["memory: address: expected a 4-byte-aligned memory address."]);
  });
});

describe("structured: diagnostics", () => {
  const messages = (src: string) => compile(src).diagnostics.filter((d) => d.source !== "typescript").map((d) => `${d.line}:${d.message}`);

  it("what the game cannot do", () => {
    const msgs = messages(`program(() => {
      let x = 1;
      let y = 2;
      x *= 2;
      x = x * y;
      wait(x);
      let s = "text";
      function f() { f(); }
      f();
      function g() { return 1; }
      g();
      while (true) { break; }
      switch (x) { default: }
    });`);
    expect(msgs).toContain("4:The game can only add and subtract: there is no multiplication or division between variables.");
    expect(msgs).toContain("5:The game can only add and subtract variables; * / % work on values known when the script is built.");
    expect(msgs).toContain("6:A call's arguments must be known when the script is built, but x is a variable of the program. Compare or assign variables in the program's own statements instead.");
    expect(msgs.some((m) => m.startsWith("7:Variables hold numbers (death counters) or booleans (switches); s is string"))).toBe(true);
    expect(msgs).toContain("8:Functions nest too deeply (recursion is not possible: a call is inlined).");
    expect(msgs).toContain("10:Functions in a program cannot return values; write the result into a variable instead.");
    expect(msgs).toContain("13:switch is not supported in a program; use if / else if.");
  });

  it("a const computed from the variables is a variable the checker keeps constant", () => {
    const r = okProgram(`
      let n = 3;
      const next = n + 1;
      const twice = next + next;
      if (next == 4) displayText("four");
      if (twice == 8) displayText("eight");
      const label = "fixed";
      displayText(label);
    `);
    expect(texts(run(r, 1))).toEqual(["0:four", "0:eight", "0:fixed"]);
    expect(r.variables.map((v) => v.name).filter((n) => !n.startsWith("(temporary"))).toEqual(["(program counter)", "n", "next", "twice"]);
    const bad = compile(program("let n = 3;\nconst next = n + 1;\nnext = 5;"));
    expect(bad.diagnostics.map((d) => [d.line, d.source])).toEqual([[3, "typescript"]]);
  });

  it("a branch known false when the script is built is pruned, and what is inside never runs", () => {
    const r = ok(`
      function bad(): Action { throw new Error("unreachable"); }
      program(() => {
        if (false) bad();
        while (false) { bad(); }
        for (let i = 0; false; i++) bad();
        if (true) displayText("yes"); else bad();
        let n = 0;
        if (n == 0) displayText("live");
      });
    `);
    expect(texts(run(r, 1))).toEqual(["0:yes", "0:live"]);
    const live = compile(`function bad(): Action { throw new Error("unreachable"); }\nprogram(() => {\n  let n = 0;\n  if (n == 0) bad();\n});`);
    expect(live.diagnostics).toEqual([expect.objectContaining({ line: 4, column: 15, source: "script", message: "unreachable — this expression is computed when the script is built, not in the game." })]);
  });

  it("a condition or an action tested as a boolean outside a program is an error", () => {
    const msgs = messages(`
      const c = bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1);
      if (c) victory();
      trigger(P1, [c && deaths(P1, units.AnyUnit, ">=", 1)], [!displayText("x") ? victory() : defeat()]);
      program(() => { if (c && !c) victory(); });
    `);
    expect(msgs).toEqual([
      "3:c is a condition — a value the game tests, not a boolean. Put it in a trigger's conditions list (several conditions there must all hold), or test it in an if inside program().",
      "4:c is a condition — a value the game tests, not a boolean. Put it in a trigger's conditions list (several conditions there must all hold), or test it in an if inside program().",
      "4:deaths(…) is a condition — a value the game tests, not a boolean. Put it in a trigger's conditions list (several conditions there must all hold), or test it in an if inside program().",
      "4:displayText(…) is an action, not a boolean: nothing happens until a trigger runs it. Put it in a trigger's actions list, or write it as a statement inside program().",
    ]);
  });

  it("the library through a namespace import", () => {
    const r = ok(`
      import * as t from "trigscript";
      t.trigger(t.P1, [t.always()], [t.displayText("raw")]);
      t.program(() => { let n = 0; if (t.random()) t.displayText("x"); n++; if (n >= 1) t.victory(); });
    `);
    expect(r.sources[0]).toEqual({ file: "main.ts", line: 3 });
    expect(r.variables.map((v) => v.name)).toEqual(["(program counter)", "n", "(scratch switch 1)"]);
    expect(run(r, 1).events.some((e) => e.action.type === ActionType.Victory)).toBe(true);
    expect(messages(`import * as t from "trigscript";\nt.program(() => { t.trigger(t.P1, [], []); });`)).toEqual(["2:trigger() defines triggers of its own and cannot be used inside program(); inside, write conditions in an if and actions as statements."]);
  });

  it("not() flips a condition where one condition can say it", () => {
    const r = ok(`trigger(P1, [not(bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1)), not(switchIs(switches.Switch1, "set")), not(always())], [victory()]);`);
    expect(r.triggers[0].conditions.map((c) => [c.type, c.comparison, c.amount])).toEqual([[ConditionType.Bring, Comparison.AtMost, 0], [ConditionType.Switch, SwitchState.Cleared, 0], [ConditionType.Never, 0, 0]]);
    expect(messages(`trigger(P1, [not(deaths(P1, units.AnyUnit, "==", 3))], []);`)).toEqual(["1:The game has no single condition for the opposite of this one; inside program(), if (!…) can test it."]);
  });

  it("reports what is computed when the script is built, and where each variable is declared", () => {
    const src = `program(() => {\n  let n = 0;\n  if (n == 3) displayText("x");\n});`;
    const r = ok(src);
    const col = (needle: string) => src.split("\n")[2].indexOf(needle) + 1;
    expect(r.buildTime).toEqual([
      { file: "main.ts", line: 2, column: 11, endLine: 2, endColumn: 12 },
      { file: "main.ts", line: 3, column: col("3)"), endLine: 3, endColumn: col("3)") + 1 },
      { file: "main.ts", line: 3, column: col("displayText"), endLine: 3, endColumn: col("displayText") + 'displayText("x")'.length },
    ]);
    expect(r.variables.find((v) => v.name === "n")?.at).toEqual({ file: "main.ts", line: 2, column: 7 });
    expect(r.variables[0].at).toBeUndefined();
  });

  it("what belongs outside a program, and options the run rejects", () => {
    expect(messages(`program(() => {\n  let x = 1;\n  if (x) { trigger(P1, [], []); }\n});`)).toEqual(["3:trigger() defines triggers of its own and cannot be used inside program(); inside, write conditions in an if and actions as statements."]);
    expect(messages(`program(() => {\n  program(() => {});\n});`)).toEqual(["2:program() defines triggers of its own and cannot be used inside program(); inside, write conditions in an if and actions as statements."]);
    expect(messages(`program(() => {}, { owner: AllPlayers });`)).toEqual(["1:program: the owner is a single player, P1 … P12: the program is one thread running as that player."]);
    expect(messages(`const body = () => {};\nprogram(body);`)).toEqual(["2:program() takes an arrow function written directly in the call: program(() => { … })."]);
    expect(messages(`program(() => {\n  const f = () => { let n = 0; n++; };\n  let m = 0;\n  const g = () => m;\n  [1].forEach(() => m++);\n});`)).toEqual(["4:g is a function that uses the program's variables; declare it with function so it is inlined at each call.", "5:A function written inside program() cannot use the program's variables; declare it with function so it is inlined, or move it outside."]);
    expect(messages(`program(() => {\n  displayText("x");\n  random();\n});`)).toEqual(["3:random() does nothing on its own; test it in an if, or assign it to a boolean."]);
    expect(messages(`trigger(P1, [random() as any], []);`)).toEqual(["1:random() is a coin toss the game makes: use it inside program(), in an if, a while or an assignment."]);
  });

  it("type errors still come from TypeScript", () => {
    const r = compile("program(() => {\nlet n = 0;\nn = true;\nif (n == \"3\") victory();\n});");
    expect(r.diagnostics.filter((d) => d.source === "typescript").map((d) => d.line)).toEqual([3, 4]);
  });

  it("a script with only raw triggers has no program", () => {
    const r = ok("trigger(P1, [always()], [victory()]);");
    expect(r.programs).toEqual([]);
    expect(r.variables).toEqual([]);
    expect(r.triggers.length).toBe(1);
  });
});

describe("simulator", () => {
  it("runs a trigger once unless preserved, honours disabled and All Players", () => {
    const once = newTrigger([PlayerGroup.Player1]);
    once.conditions.push({ type: ConditionType.Always, location: 0, player: 0, amount: 0, unitId: 0, comparison: 0, resource: 0, flags: 0, mask: 0 });
    once.actions.push({ type: ActionType.Victory, location: 0, text: 0, wav: 0, time: 0, player: 0, target: 0, unitId: 0, modifier: 0, flags: 0, padding: 0, mask: 0 });
    const kept: TriggerRecord = { ...once, conditions: once.conditions.map((c) => ({ ...c })), actions: once.actions.map((a) => ({ ...a })), players: once.players.slice(), flags: TriggerFlag.Preserve };
    const off: TriggerRecord = { ...kept, players: kept.players.slice(), flags: TriggerFlag.Preserve | TriggerFlag.Disabled };
    const all = newTrigger([PlayerGroup.AllPlayers]);
    all.conditions.push({ ...once.conditions[0] });
    all.actions.push({ ...once.actions[0], type: ActionType.Defeat });
    const sim = new Simulation([once, kept, off, all], { player: 3 }).run(3);
    expect(sim.events.map((e) => `${e.cycle}:${e.trigger}`)).toEqual(["0:3"]);
    const sim2 = new Simulation([once, kept, off, all]).run(3);
    expect(sim2.player).toBe(0);
    expect(sim2.events.map((e) => `${e.cycle}:${e.trigger}`)).toEqual(["0:0", "0:1", "0:3", "1:1", "2:1"]);
  });
});

describe("structured: one allocator for the whole compile", () => {
  const texts = (r: CompileResult, cycles = 3) => run(r, cycles).events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => e.text);
  const pc = (r: CompileResult, i: number) => { const v = r.variables.filter((x) => x.name === "(program counter)")[i]; return [v.player, v.unit]; };

  it("two programs asking for the same variableUnits get different cells, so both run", () => {
    const r = ok(`
      ${program(`let a = 1; displayText("A");`, "{ variableUnits: [181] }")}
      ${program(`let b = 2; displayText("B");`, "{ variableUnits: [181] }")}
    `);
    expect(pc(r, 0)).toEqual([0, 181]);
    expect(pc(r, 1)).toEqual([2, 181]);
    expect(texts(r)).toEqual(["A", "B"]);
  });

  it("a raw trigger's cells are taken before any program allocates, wherever it stands in the text", () => {
    const before = ok(`trigger(P1, [always()], [setDeaths(P1, 181, "set", 99)]); ${program(`displayText("program");`)}`);
    expect(pc(before, 0)).toEqual([1, 181]);
    expect(texts(before)).toEqual(["program"]);
    const after = ok(`${program(`displayText("program");`)} trigger(P1, [always()], [setDeaths(P1, 181, "set", 99)]);`);
    expect(pc(after, 0)).toEqual([1, 181]);
    expect(texts(after)).toEqual(["program"]);
  });

  it("a raw trigger's switches are taken too", () => {
    const r = ok(`trigger(P1, [always()], [setSwitch(switches.Switch256, "set")]); ${program(`let flag = false; if (switchIs(switches.Switch256, "set")) displayText("set");`)}`);
    expect(r.variables.find((v) => v.name === "flag")).toMatchObject({ switch: 254 });
    expect(texts(r)).toEqual(["set"]);
  });

  it("a raw memory write into the death table takes the cell it aliases", () => {
    const r = ok(`trigger(P1, [always()], [setMemory(${DEATHS_TABLE_ADDRESS} + 4 * (181 * 12 + 0), "set", 1)]); ${program(`displayText("x");`)}`);
    expect(pc(r, 0)).toEqual([1, 181]);
  });

  it("a hand trigger writing CurrentPlayer's counter reserves it for each of its owners", () => {
    const hand = newTrigger([PlayerGroup.Player1, PlayerGroup.Player3]);
    hand.actions.push({ type: ActionType.SetDeaths, player: PlayerGroup.CurrentPlayer, unitId: 181, modifier: SetModifier.SetTo, target: 99, location: 0, text: 0, wav: 0, time: 0, flags: 0, padding: 0, mask: 0 });
    const reserved = reservedStorage([hand], [], null);
    expect(reserved.reservedDeaths).toEqual([[0, 181], [2, 181]]);
    const r = ok(program(`let n = 1;`), reserved);
    expect(r.variables.map((v) => [v.player, v.unit])).toEqual([[1, 181], [3, 181]]);
  });
});

describe("structured: arithmetic means what the source says", () => {
  /** The body run as plain JavaScript, each variable then stored the way the game stores it: below 0 → 0, 2³² and above wraps. */
  function expected(body: string): Record<string, number> {
    const names = [...body.matchAll(/let (\w+)/g)].map((m) => m[1]);
    const values = new Function(`${body}\nreturn { ${names.join(", ")} };`)() as Record<string, number>;
    return Object.fromEntries(names.map((n) => [n, values[n] < 0 ? 0 : values[n] >>> 0]));
  }
  const cases = [
    "let a = 0; let b = 10; a = a + b - 5;",
    "let a = 0; let b = 10; a += b - 5;",
    "let a = 0; let b = 3; a += b - 5;",
    "let a = 10; let b = 0; let c = 5; let out = 0; out = a - (b - c);",
    "let y = 20; let x = 0; x = 5 - y + 10;",
    "let a = 7; let b = 3; a = b - a;",
    "let a = 3; let b = 7; a = b - a;",
    "let a = 3; a = 3 - 10;",
    "let a = 10; a -= 20;",
    "let a = 4294967295; a++;",
    "let a = 1; let b = 2; let c = 3; a = a - b + c;",
    "let a = 1; let b = 2; let c = 3; a = c - b - a;",
    "let a = 5; let b = 2; let c = 3; a = a - b - c;",
    "let a = 5; let b = 2; let c = 9; a = a - b + c;",
    "let a = 5; let b = 2; a = a - b - 4;",
    "let a = 5; let b = 2; a = a - 4 - b + 1;",
    "let a = 2; a = a + a - 3;",
    "let a = 2; let b = 1; a = b - a - a;",
  ];
  for (const body of cases) {
    it(body, () => {
      const r = okProgram(body);
      const sim = run(r, 2);
      const want = expected(body);
      const got = Object.fromEntries(Object.keys(want).map((n) => [n, value(sim, r, n)]));
      expect(got).toEqual(want);
    });
  }
});

describe("structured: widths and costs", () => {
  it("u8 variables decompose over 8 bits and saturate at 255", () => {
    const wide = okProgram("let a = 0; let b = 100; a = b;");
    const narrow = okProgram("let a: u8 = 200; let b: u8 = 100; a += b;");
    expect(wide.triggers).toHaveLength(66);
    expect(narrow.triggers).toHaveLength(19);
    const sim = run(narrow, 1);
    expect(value(sim, narrow, "a")).toBe(255);
    expect(value(sim, narrow, "b")).toBe(100);
    expect(narrow.variables.find((v) => v.name === "a")).toMatchObject({ bits: 8 });
    expect(wide.variables.find((v) => v.name === "a")?.bits).toBeUndefined();
  });

  it("u16 saturates on a constant addition too, and a constant that does not fit is an error", () => {
    const r = okProgram("let n: u16 = 65535; n++; n += 5;");
    expect(value(run(r, 1), r, "n")).toBe(65535);
    expect(compile(program("let a: u8 = 300;")).diagnostics.map((d) => d.message)).toEqual(["a is a u8 and holds 0 … 255, not 300."]);
  });

  it("a comparison between narrow variables is much cheaper", () => {
    const wide = okProgram('let a = 1; let b = 2; if (a < b) displayText("yes");');
    const narrow = okProgram('let a: u8 = 1; let b: u8 = 2; if (a < b) displayText("yes");');
    expect(wide.triggers).toHaveLength(134);
    expect(narrow.triggers.length).toBeLessThan(50);
    expect(texts(run(narrow, 1))).toEqual(["0:yes"]);
  });

  it("a copied parameter keeps the argument's width; a sum through a temp stays right", () => {
    const r = okProgram("let a: u8 = 250; let b: u8 = 10; let c: u8 = 0; function bump(x: number) { x += 1; c = x; } bump(a); c = a + b;");
    const sim = run(r, 1);
    expect(value(sim, r, "c")).toBe(255);
    expect(r.variables.find((v) => v.name === "x")).toMatchObject({ bits: 8 });
  });

  it("reports the triggers each line generated, with a note where a decomposition is the reason", () => {
    const r = ok(`for (let i = 0; i < 3; i++) trigger(P1, [always()], [victory()]);
program(() => {
  let a = 0;
  let b = 1;
  a = b;
  displayText("x");
});`);
    const at = (line: number) => r.costs.find((c) => c.line === line);
    expect(at(1)).toEqual({ file: "main.ts", line: 1, triggers: 3 });
    expect(at(5)).toMatchObject({ triggers: 64, note: expect.stringContaining("u8 or u16") });
    expect(at(6)?.note).toBeUndefined();
    expect(r.costs.reduce((n, c) => n + c.triggers, 0)).toBe(r.triggers.length);
  });
});
