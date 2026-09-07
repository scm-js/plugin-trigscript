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
  return v.kind === "number" ? sim.death(v.player!, v.unit!) : v.flag !== undefined ? sim.death(PlayerGroup.CurrentPlayer, v.flag) : sim.switches[v.switch!];
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

  it("a for with known bounds is unrolled: break and continue work, and it runs in the cycle it is reached in", () => {
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
    expect(texts(sim)).toEqual(["0:done"]);
    expect(value(sim, r, "sum")).toBe(8);
    // `i` is a value known when the script is built: no death counter, and `sum += i` is a constant addition.
    expect(r.variables.map((v) => v.name)).toEqual(["(program counter)", "sum"]);
    expect(r.costs.find((c) => c.line === 3)?.note).toMatch(/^Unrolled: 10 iterations/);
    // Halted: the program counter sits on a state no trigger tests.
    expect(sim.death(0, 181)).toBe(0xffffffff);
  });

  it("a for over a variable bound is a loop, one iteration per cycle; the code after it runs the cycle it exits", () => {
    const r = okProgram(`
      let sum = 0;
      let n = 10;
      for (let i = 0; i < n; i++) {
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
    expect(r.costs.find((c) => c.line === 4)?.note).toMatch(/one iteration per trigger cycle/);
  });

  it("a for that unrolls too far, counts down, or steps by more than one", () => {
    expect(compile(program("let s = 0; for (let i = 0; i < 1000; i++) { s += i; }")).diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/unrolls to more than 256 iterations/)]);
    const r = okProgram("let s = 0; for (let i = 10; i > 0; i -= 3) { s += i; } for (let j = 2; j <= 6; j += 2) s += j;");
    expect(value(run(r, 1), r, "s")).toBe(10 + 7 + 4 + 1 + 2 + 4 + 6);
    // Assigning the loop variable in the body makes it a variable of the game again.
    const loop = okProgram("let s = 0; for (let i = 0; i < 4; i++) { s += i; i++; }");
    expect(loop.variables.map((v) => v.name)).toContain("i");
    expect(value(run(loop, 4), loop, "s")).toBe(2);
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
      x /= y;
      x = x ** y;
      wait(x);
      let s = "text";
      function f() { f(); }
      f();
      if (bring(P1, units.AnyUnit, locations.Anywhere, ">=", x)) x = 0;
      displayText(\`\${x}\`);
      while (true) { break; }
      switch (x) { case y: break; }
    });`);
    expect(msgs).toContain("4:Division is by a constant: the game has no instruction for dividing by a variable.");
    expect(msgs).toContain("5:Expected a number: variables add, subtract, multiply, divide and take the remainder by a constant.");
    expect(msgs).toContain("6:wait's milliseconds must be known when the script is built. Only an amount with a modifier (setResources, setDeaths, setScore, setCountdownTimer) and a unit count (createUnit, killUnitAt, removeUnitAt, giveUnits) can be a variable of the program.");
    expect(msgs.some((m) => m.startsWith("7:Variables hold numbers (death counters), booleans (switches) or records of them ({ lives: 3 }); s is string"))).toBe(true);
    expect(msgs).toContain("8:Functions nest too deeply (recursion is not possible: a call is inlined).");
    expect(msgs).toContain("10:The game cannot test a condition against a variable of the program: a condition's amount is known when the script is built. Compare variables in the program's own statements.");
    expect(msgs).toContain("11:displayText's text must be known when the script is built. Only an amount with a modifier (setResources, setDeaths, setScore, setCountdownTimer) and a unit count (createUnit, killUnitAt, removeUnitAt, giveUnits) can be a variable of the program.");
    expect(msgs).toContain("13:A case value must be known when the script is built, but y is a variable of the program. Compare or assign variables in the program's own statements instead.");
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
    expect(messages(`program(() => {}, { owner: players.Foes });`)).toEqual(["1:program: the owner is a player (P1 … P12), AllPlayers, a force (players.Force1), or a list of players — the program runs once for each of them, with CurrentPlayer as that player."]);
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

describe("structured: time, edges, lists and players", () => {
  it("sleep pauses the program for that many cycles; seconds depend on hyper triggers", () => {
    const r = okProgram('displayText("a"); sleep(cycles(3)); displayText("b");');
    expect(texts(run(r, 6))).toEqual(["0:a", "3:b"]);
    expect(texts(run(okProgram('sleep(seconds(2)); displayText("x");'), 4))).toEqual(["1:x"]);
    expect(texts(run(okProgram('sleep(seconds(10)); displayText("x");'), 8))).toEqual(["5:x"]);
    const hyper = ok(`hyperTriggers(P8); ${program('sleep(seconds(1)); displayText("x");')}`);
    expect(texts(run(hyper, 20, { player: 0 }))).toEqual(["12:x"]);
    const loop = okProgram('while (true) { displayText("w"); sleep(cycles(2)); }');
    expect(texts(run(loop, 7))).toEqual(["0:w", "3:w", "6:w"]);
  });

  it("a bare duration, sleep outside a program and a bad argument are all told where they belong", () => {
    const messages = (src: string) => compile(src).diagnostics.map((d) => d.message);
    expect(messages(program("seconds(2);"))).toEqual(["A duration does nothing on its own; sleep(seconds(2)) pauses the program."]);
    expect(messages("sleep(seconds(2));")).toEqual(["sleep() pauses a program: use it inside program(), as a statement — sleep(seconds(2))."]);
    expect(messages(program("sleep(5 as any);"))).toEqual(["sleep() takes a duration from seconds(), minutes() or cycles(), got number 5."]);
  });

  it("rose() is true on the cycle its condition becomes true, once() only the first time", () => {
    const r = okProgram(`
      let n = 0;
      let up = true;
      while (true) {
        if (up) n++; else n--;
        if (n == 3) up = false;
        if (n == 0) up = true;
        if (rose(n >= 2)) displayText("rose");
        if (once(n >= 2)) displayText("once");
      }
    `);
    expect(texts(run(r, 8))).toEqual(["1:rose", "1:once", "7:rose"]);
  });

  it("for…of over a list known when the script is built is unrolled, with break and continue", () => {
    const r = ok(`
      const waves = [2, 5, 9];
      program(() => {
        let total = 0;
        for (const w of waves) { total += w; displayText(\`wave \${w}\`); }
        for (const w of waves) { if (w == 5) continue; if (w == 9) break; displayText(\`again \${w}\`); }
        for (const name of ["a", "b"]) displayText(name);
      });
    `);
    const sim = run(r, 1);
    expect(value(sim, r, "total")).toBe(16);
    expect(texts(sim)).toEqual(["0:wave 2", "0:wave 5", "0:wave 9", "0:again 2", "0:a", "0:b"]);
    expect(compile(program("let n = 0; for (const x of [n]) displayText(\"x\");")).diagnostics[0].message).toMatch(/^What a for…of loop runs over must be known when the script is built, but n is a variable/);
  });

  it("a program owned by All Players runs once per player, each with their own variables", () => {
    const r = ok(program('let kills = 0; let alive = true; kills += 2; alive = !alive; if (kills >= 2 && !alive) displayText("k"); let total = shared(0); total += 1; if (total >= 1) displayText("t");', "{ owner: AllPlayers }"));
    expect(r.programs[0]).toMatchObject({ owner: 0, owners: [PlayerGroup.AllPlayers], perPlayer: true });
    expect(r.triggers.every((t) => t.players[PlayerGroup.AllPlayers] === 1 && !t.players[0])).toBe(true);
    const by = (name: string) => r.variables.find((v) => v.name === name)!;
    expect(by("(program counter)").storage).toMatch(/^each player · /);
    expect(by("kills")).toMatchObject({ player: PlayerGroup.CurrentPlayer, storage: expect.stringMatching(/^each player/) });
    expect(by("alive")).toMatchObject({ kind: "boolean", flag: expect.any(Number) });
    expect(by("total")).toMatchObject({ kind: "number", player: 0 });
    for (const player of [0, 3]) {
      const sim = run(r, 1, { player });
      expect(texts(sim)).toEqual(["0:k", "0:t"]);
      expect(value(sim, r, "kills")).toBe(2);
      expect(value(sim, r, "alive")).toBe(0);
    }
    // Rows: twelve cells each, so three rows take three units of the pool; the shared cell is one slot of the next.
    expect(new Set([by("(program counter)").unit, by("kills").unit, by("alive").flag]).size).toBe(3);
  });

  it("a force or a list of players is per player too; one player is not", () => {
    const force = ok(program("let n = 0; n++;", "{ owner: players.Force2 }"));
    expect(force.programs[0]).toMatchObject({ owners: [PlayerGroup.Force2], perPlayer: true });
    expect(force.triggers[0].players[PlayerGroup.Force2]).toBe(1);
    expect(value(run(force, 1, { player: 5 }), force, "n")).toBe(1);
    const list = ok(program("let n = 0; n++;", "{ owner: [P1, P3] }"));
    expect(list.programs[0]).toMatchObject({ owner: 0, owners: [0, 2], perPlayer: true });
    expect(list.triggers[0].players.slice(0, 4)).toEqual([1, 0, 1, 0]);
    const one = ok(program("let n = 0; n++;", "{ owner: P4 }"));
    expect(one.programs[0]).toMatchObject({ owner: 3, owners: [3], perPlayer: false });
    expect(one.variables.find((v) => v.name === "n")).toMatchObject({ player: 1, storage: "P2 · Cantina (Unused)" });
  });

  it("per-player booleans: random(), toggling and rose() go through flags", () => {
    const r = ok(program('let f = false; f = random(); f = !f; if (rose(f)) displayText("r"); let g = shared(false); g = true; if (g) displayText("g");', "{ owner: AllPlayers }"));
    const sim = new Simulation(r.triggers, { strings: r.strings, random: () => 0.9, player: 2 }).run(1);
    expect(texts(sim)).toEqual(["0:g"]);
    expect(value(sim, r, "f")).toBe(0);
    expect(r.variables.find((v) => v.name === "g")).toMatchObject({ kind: "boolean", switch: expect.any(Number) });
  });
});

/* ── 2.4.1: the review's five findings ── */

describe("structured: exact sums, short circuits, lazy constants, storage the bodies touch", () => {
  const files = (src: Record<string, string>) => compileScript(ts, src, NAMES, { lib: LIB });

  it("a narrow variable is saturated after the whole sum, not between its parts", () => {
    const r = okProgram("let a: u8 = 250; let b: u8 = 10; a = a + b - 10; let c: u16 = 65530; let d: u16 = 10; c = c + d - 20;");
    const sim = run(r, 1);
    expect(value(sim, r, "a")).toBe(250);
    expect(value(sim, r, "c")).toBe(65520);
    // … and still saturates when the result really is over the top.
    const over = okProgram("let a: u8 = 250; let b: u8 = 10; a = a + b - 1;");
    expect(value(run(over, 1), over, "a")).toBe(255);
    // A constant, a subtraction and a copy of a narrower variable need no guard.
    const cheap = okProgram("let a: u8 = 200; let b: u8 = 10; a -= 3; a = b;");
    expect(cheap.triggers.filter((t) => t.conditions.some((c) => c.amount === 256))).toHaveLength(0);
  });

  it("the running sum of the additions is the one thing a 32-bit cell cannot promise", () => {
    // Documented: 2³² − 1 + 1 wraps to 0 before the subtraction; the source's exact sum (2³² − 1) fits, the cell does not.
    const r = okProgram("let a = 4294967295; let b = 1; let out = 0; out = a + b - 1;");
    expect(value(run(r, 1), r, "out")).toBe(0);
  });

  it("&& and || short-circuit when the right side has an effect: once() is consumed only when the left side allows", () => {
    const r = okProgram("let n = 0; let out = 0; while (n < 3) { if (n >= 1 && once(true)) out++; n++; }");
    const sim = run(r, 8);
    expect(value(sim, r, "out")).toBe(1);
    const or = okProgram("let n = 0; let out = 0; while (n < 3) { if (n == 0 || once(true)) out++; n++; }");
    // n == 0 fires without touching once(); n == 1 consumes it; n == 2 is false.
    expect(value(run(or, 8), or, "out")).toBe(2);
    const neg = okProgram("let n = 0; let out = 0; while (n < 3) { if (!(n >= 1 && rose(true))) out++; n++; }");
    // rose(true) rises once, at n == 1: the negation is true at n == 0 and n == 2.
    expect(value(run(neg, 8), neg, "out")).toBe(2);
    // A pure condition still goes through the DNF: one trigger per product.
    const pure = okProgram('let a = 0; let f = false; if (a >= 1 && !f || random()) displayText("x");');
    expect(pure.triggers.length).toBeLessThan(8);
  });

  it("a constant of the program is computed when it is needed, never inside a pruned branch", () => {
    expect(okProgram('if (false) { const unused = (() => { throw new Error("dead branch evaluated"); })(); }').triggers).toHaveLength(1);
    const later = okProgram("let x = 0; while (false) { const dead = (() => { throw new Error(\"no\"); })(); x = dead; } x = 1;");
    expect(value(run(later, 1), later, "x")).toBe(1);
    // A constant in live code runs where the source has it, and its error lands on its initializer.
    const r = compile(program('let x = 0;\nconst bad = (() => { throw new Error("boom"); })();\nx = 1;'));
    expect(r.diagnostics).toEqual([expect.objectContaining({ line: 2, column: 13, message: "boom — this constant is computed when the script is built, not in the game.", source: "script" })]);
    // A constant used before its declaration by a hoisted function still resolves, once.
    let calls = 0;
    const r2 = okProgram("let x = 0; function f() { x = limit + 1; } const limit = 4; f(); f();");
    expect(value(run(r2, 1), r2, "x")).toBe(5);
    expect(calls).toBe(0);
  });

  it("a program body's own setDeaths / deaths keep the allocator away from those cells, whichever program they are in", () => {
    const r = okProgram('let n = 1; setDeaths(P2, 181, "set", 42); n++;');
    expect(r.variables.find((v) => v.name === "n")).toMatchObject({ player: 2, unit: 181 });
    expect(value(run(r, 1), r, "n")).toBe(2);
    // The second program's body claims a cell the first would otherwise have taken.
    const two = ok('program(() => { let a = 1; a++; });\nprogram(() => { let b = 0; if (deaths(P2, 181, ">=", 1)) b = 1; }, { owner: P2 });');
    expect(two.variables.filter((v) => v.player === 1 && v.unit === 181)).toHaveLength(0);
    // CurrentPlayer in a per-player program's body means each of its owners.
    const each = ok('program(() => { let a = 1; a++; }, { owner: [P1, P2] });\nprogram(() => { setDeaths(CurrentPlayer, 179, "add", 1); }, { owner: [P3, P4] });');
    expect(each.variables.filter((v) => v.unit === 179 && (v.player === 2 || v.player === 3))).toHaveLength(0);
    // Build-time parts of the body still run once, not once per walk.
    const counted = files({ "main.ts": 'import { tick } from "./count";\nprogram(() => { let n = 0; if (bring(P1, units.AnyUnit, locations.Anywhere, ">=", tick())) n++; });', "count.ts": "let calls = 0;\nexport const tick = () => ++calls;\nexport const seen = () => calls;" });
    expect(counted.ok).toBe(true);
    expect(counted.triggers.find((t) => t.conditions.some((c) => c.type === ConditionType.Bring))?.conditions.find((c) => c.type === ConditionType.Bring)?.amount).toBe(1);
  });

  it("the map's names the files mention, resolved by the checker", () => {
    const r = files({ "main.ts": '// locations.Beacon\nconst s = "locations.Beacon";\nfunction f(locations: any) { return locations.Beacon; }\nimport * as t from "trigscript";\nimport { switches as sw } from "trigscript";\nconst a = [locations.Anywhere, locations["No Location"], t.locations.NoLocation, sw.Switch1, units.TerranMarine];' });
    expect(r.refs.map((x) => `${x.object}.${x.key}${x.quoted ? "!" : ""}@${x.line}:${x.column}`)).toEqual([
      "locations.Anywhere@6:22", "locations.No Location!@6:42", "locations.NoLocation@6:70", "switches.Switch1@6:85", "units.TerranMarine@6:100",
    ]);
    // Present even when the script does not type-check: a renamed location is exactly that case.
    const broken = files({ "main.ts": "const x = locations.Gone;" });
    expect(broken.ok).toBe(false);
    expect(broken.refs).toEqual([expect.objectContaining({ object: "locations", key: "Gone" })]);
  });
});

/* ── 2.5.0: the language ── */

describe("structured: game functions, returns and records", () => {
  const files = (src: Record<string, string>) => compileScript(ts, src, NAMES, { lib: LIB });

  it("a function of the body returns a number or a boolean, through a temp", () => {
    const r = okProgram(`
      let x = 0; let y: u8 = 7;
      function twice(n: number) { return n + n; }
      function big(n: number) { return n >= 10; }
      function pick(n: number): number { if (n >= 5) return 1; return 2; }
      x = twice(y) + 1;
      if (big(x)) x = 100;
      x = pick(x) + pick(1);
    `);
    const sim = run(r, 1);
    expect(value(sim, r, "x")).toBe(3);
    // The results are temps: no permanent storage per call site.
    expect(r.variables.filter((v) => v.name.startsWith("(temporary")).length).toBeLessThanOrEqual(4);
  });

  it("game() functions come from any file, inline at each call, and return values", () => {
    const r = files({
      "main.ts": `
        import { award, canAfford, tax } from "./shop";
        program(() => {
          let gold: u8 = 10;
          let paid = false;
          gold = tax(gold);
          award(P2, 3);
          if (canAfford(gold, 5)) { paid = true; gold -= 5; }
        });`,
      "shop.ts": `
        export const award = game((p: Player, n: number) => { setResources(p, "add", n, "ore"); });
        export const canAfford = game((have: number, price: number) => have >= price);
        export const tax = game((n: number): number => { let out = n - 1; return out; });`,
    });
    expect(r.diagnostics).toEqual([]);
    const sim = run(r, 1);
    expect(value(sim, r, "gold")).toBe(4);
    expect(value(sim, r, "paid")).toBe(1);
    expect(sim.events.map((e) => `${e.action.type}:${e.action.player}:${e.action.target}`)).toEqual([`${ActionType.SetResources}:1:3`]);
    // Its triggers are attributed to its own file and line, so the cost hints land there.
    expect(r.sources.some((s) => s?.file === "shop.ts")).toBe(true);
    expect(r.costs.some((c) => c.file === "shop.ts")).toBe(true);
    expect(r.buildTime.some((b) => b.file === "shop.ts")).toBe(true);
    // Calling one when the script is built is an error at the call.
    const built = files({ "main.ts": 'const f = game((n: number) => n + 1); const x = f(1);' });
    expect(built.diagnostics.map((d) => d.message)).toEqual(["A game() function runs in the game: call it inside program() or another game() function, not when the script is built."]);
    // game() inside a program is not allowed; a game function calling another is.
    expect(compile(program("const f = game((n: number) => n + 1);")).diagnostics[0].message).toMatch(/^game\(\) defines triggers of its own/);
    const nested = files({ "main.ts": 'const inc = game((n: number) => n + 1); const twice = game((n: number) => inc(inc(n))); program(() => { let x = 0; x = twice(x); x = twice(x); });' });
    expect(nested.diagnostics).toEqual([]);
    expect(value(run(nested, 1), nested, "x")).toBe(4);
  });

  it("game functions see only their own bindings, and their locals are per call", () => {
    const r = files({ "main.ts": 'const f = game((n: number) => { let acc = 0; acc += n; return acc; }); program(() => { let a = 0; let b = 0; a = f(2); b = f(3); });' });
    expect(r.diagnostics).toEqual([]);
    const sim = run(r, 1);
    expect(value(sim, r, "a")).toBe(2);
    expect(value(sim, r, "b")).toBe(3);
    // A missing return in a function typed to return a number is TypeScript's error; a rest parameter is ours.
    expect(files({ "main.ts": 'const f = game((...n: number[]) => 1); program(() => { let a = 0; a = f(1); });' }).diagnostics.map((d) => d.message)).toContain("Rest parameters are not supported in a game function.");
  });

  it("records: a let holding an object literal is a variable per field", () => {
    const r = okProgram(`
      let p = { lives: 3, gold: 0, alive: true, pos: { x: 1, y: 2 } };
      p.lives -= 1;
      p.gold = p.lives + p.pos.y;
      if (p.lives == 2 && p.alive) p.alive = false;
      p["pos"].x = p.pos.x + 5;
      function hit(q: { lives: number }) { q.lives -= 1; }
      hit(p);
    `);
    const sim = run(r, 1);
    expect(value(sim, r, "p.lives")).toBe(1);
    expect(value(sim, r, "p.gold")).toBe(4);
    expect(value(sim, r, "p.alive")).toBe(0);
    expect(value(sim, r, "p.pos.x")).toBe(6);
    expect(r.variables.find((v) => v.name === "p.lives")).toMatchObject({ kind: "number", at: expect.objectContaining({ line: 2 }) });
    const typed = okProgram("let p: { n: u8 } = { n: 250 }; p.n += 10;");
    expect(value(run(typed, 1), typed, "p.n")).toBe(255);
    expect(compile(program("let p = { n: 1 }; p = { n: 2 };")).diagnostics.map((d) => d.message)).toEqual(["A record is assigned field by field: p.lives = 3."]);
    expect(compile(program("const p = { n: 1 }; p.n = 2;")).diagnostics.map((d) => d.message)).toEqual(["This object is computed when the script is built. Declare it with let inside the program to make it a record of variables."]);
  });
});

describe("structured: switch, ternaries and arithmetic", () => {
  it("switch over a variable: cases in order, fall-through, default anywhere, break", () => {
    const r = okProgram(`
      let x = 2; let out = 0;
      switch (x) {
        case 1: out = 10; break;
        case 2:
        case 3: out += 1;
        default: out += 100; break;
        case 9: out = 9;
      }
      switch (x + 7) { case 9: out += 1000; }
    `);
    expect(value(run(r, 1), r, "out")).toBe(1101);
    // break inside a switch inside a loop leaves the switch; continue reaches the loop.
    const loop = okProgram("let i = 0; let out = 0; while (i < 3) { i++; switch (i) { case 2: continue; default: out += i; break; } out += 10; }");
    expect(value(run(loop, 6), loop, "out")).toBe(1 + 10 + 3 + 10);
  });

  it("?: as a number and as a condition, with a side that has effects reached only when chosen", () => {
    const r = okProgram("let a = 3; let b = 0; let c = 0; b = a > 2 ? a + 1 : 0; c = a > 5 ? 1 : b + 1; let n = 0; if (n >= 1 ? once(true) : false) c = 99; if (b == 4 ? true : false) c += 100;");
    const sim = run(r, 1);
    expect(value(sim, r, "b")).toBe(4);
    expect(value(sim, r, "c")).toBe(105);
  });

  it("multiplication by a constant, division and remainder by a constant", () => {
    const r = okProgram("let a: u8 = 7; let b = 0; let c = 0; let d = 0; b = a * 3 + 2; c = b / 4; d = b % 4; a *= 2; b /= 3; let e = 0; e = (a + 1) * 2 - a * 2;");
    const sim = run(r, 1);
    expect(value(sim, r, "b")).toBe(7);
    expect(value(sim, r, "c")).toBe(5);
    expect(value(sim, r, "d")).toBe(3);
    expect(value(sim, r, "a")).toBe(14);
    expect(value(sim, r, "e")).toBe(2);
    expect(r.costs.find((c) => c.line === 1)?.note).toMatch(/long division/);
    expect(compile(program("let a = 1; a = a / 0;")).diagnostics.map((d) => d.message)).toEqual(["Divide by a whole number of at least 1, not 0."]);
  });

  it("multiplication between variables, and its cost", () => {
    const r = okProgram("let a: u8 = 6; let b: u8 = 7; let c = 0; c = a * b; c += a * a;");
    const sim = run(r, 1);
    expect(value(sim, r, "c")).toBe(42 + 36);
    expect(value(sim, r, "a")).toBe(6);
    expect(value(sim, r, "b")).toBe(7);
    expect(r.costs.find((c) => c.line === 1)?.note).toMatch(/Multiplying two variables/);
    expect(r.triggers.length).toBeLessThan(500);
  });

  it("Math.min / max / abs, clamp(), rounding — against constants and between variables", () => {
    const r = okProgram(`
      let a: u8 = 20; let b: u8 = 5; let lo = 0; let hi = 0; let d = 0; let k = 0; let m = 0;
      lo = Math.min(a, b); hi = Math.max(a, b); d = Math.abs(b - a); k = clamp(a, 8, 12); m = Math.max(Math.min(a, 7), b, 6);
      let f = 0; f = Math.floor(a / 3) + Math.trunc(b);
      let z = 0; z = Math.min(a, 3) + Math.max(b, 30) + Math.min(a, b, 2);
    `);
    const sim = run(r, 1);
    expect(value(sim, r, "lo")).toBe(5);
    expect(value(sim, r, "hi")).toBe(20);
    expect(value(sim, r, "d")).toBe(15);
    expect(value(sim, r, "k")).toBe(12);
    expect(value(sim, r, "m")).toBe(7);
    expect(value(sim, r, "f")).toBe(11);
    expect(value(sim, r, "z")).toBe(3 + 30 + 2);
    // The operands are intact.
    expect(value(sim, r, "a")).toBe(20);
    expect(value(sim, r, "b")).toBe(5);
  });

  it("comparisons with a coefficient fold to a test against a constant", () => {
    const r = okProgram('let a = 3; let out = 0; if (a * 2 >= 5) out += 1; if (a * 2 == 7) out += 10; if (a * 2 != 7) out += 100; if (3 * a < 10) out += 1000; if (a + a == 6) out += 10000;');
    expect(value(run(r, 1), r, "out")).toBe(11101);
    // No temps: every test is one condition on `a`.
    expect(r.variables.filter((v) => v.name.startsWith("(temporary"))).toHaveLength(0);
  });
});

describe("structured: actions with a variable amount", () => {
  const eventsOf = (sim: Simulation, type: number) => sim.events.filter((e) => e.action.type === type).map((e) => e.action);

  it("setResources / setDeaths / setScore / setCountdownTimer add, subtract and set a variable amount", () => {
    const r = okProgram(`
      let n: u8 = 13; let wave = 0; wave = 3;
      setResources(P1, "add", n, "ore");
      setResources(P2, "set", wave * 10 + 5, "gas");
      setScore(P1, "subtract", n, "kills");
      setCountdownTimer("set", n + 1);
      setDeaths(P3, units.TerranMarine, "add", n);
    `);
    const sim = run(r, 1);
    const sum = (list: { target: number }[]) => list.reduce((s, a) => s + a.target, 0);
    const ore = eventsOf(sim, ActionType.SetResources).filter((a) => a.player === 0);
    expect(ore.every((a) => a.modifier === SetModifier.Add)).toBe(true);
    expect(sum(ore)).toBe(13);
    const gas = eventsOf(sim, ActionType.SetResources).filter((a) => a.player === 1);
    expect(gas[0]).toMatchObject({ modifier: SetModifier.SetTo, target: 0 });
    expect(sum(gas.slice(1))).toBe(35);
    expect(sum(eventsOf(sim, ActionType.SetScore))).toBe(13);
    expect(eventsOf(sim, ActionType.SetCountdownTimer).reduce((s, a) => s + a.time, 0)).toBe(14);
    // The deaths went to the map's counter, which the simulator models, and the variable is intact.
    expect(sim.death(2, unitName.length ? 0 : 0)).toBe(13);
    expect(value(sim, r, "n")).toBe(13);
    expect(r.costs.find((c) => c.line === 4)?.note).toMatch(/variable amount/);
  });

  it("createUnit and its kin take a variable count, saturated at 255", () => {
    const r = okProgram(`
      let n: u8 = 6; let big = 0; big = 300;
      createUnit(P2, units.ZergZergling, n, locations.Anywhere);
      killUnitAt(P2, units.ZergZergling, n + 1, locations.Anywhere);
      createUnit(P3, units.ZergZergling, big, locations.Anywhere);
    `);
    const sim = run(r, 1);
    const created = eventsOf(sim, ActionType.CreateUnit);
    expect(created.filter((a) => a.player === 1).reduce((s, a) => s + a.modifier, 0)).toBe(6);
    expect(eventsOf(sim, ActionType.KillUnitAt).reduce((s, a) => s + a.modifier, 0)).toBe(7);
    expect(created.filter((a) => a.player === 2).reduce((s, a) => s + a.modifier, 0)).toBe(255);
    expect(value(sim, r, "n")).toBe(6);
    expect(value(sim, r, "big")).toBe(300);
    expect(compile(program("let n = 0; moveLocation(P1, units.AnyUnit, locations.Anywhere, n);")).diagnostics[0].message).toMatch(/^moveLocation's \w+ must be known/);
    expect(compile(program('let a = 0; let b = 0; setResources(P1, "add", a, b);')).diagnostics[0].message).toMatch(/must be known when the script is built/);
  });
});
