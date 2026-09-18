/**
 * The structured level: `program(() => { … })` bodies compile to IR, and the program
 * interpreter (`simulateIr.ts`, the model of `python/trigscript.py`) proves they behave — a
 * body runs within one frame until it sleeps or ends, loops run to completion, numbers keep
 * the one contract. A program makes no triggers: the `trigger()` records of the same script
 * run beside it in the trigger interpreter, sharing one world.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ActionType, Comparison, ConditionType, emptyTrigger, PlayerGroup, SetModifier, SwitchState, TriggerFlag, type ActionRecord, type ConditionRecord, type TriggerRecord,
} from "../vendor/triggers";
import { compileScript, DEATHS_TABLE_ADDRESS, type CompileResult } from "../compiler/compiler";
import { negateCondition } from "../compiler/lower";
import { defaultScriptNames } from "../compiler/names";
import { Simulation, type SimulationOptions } from "../compiler/simulate";
import { ProgramSimulation } from "../compiler/simulateIr";
import { buildScript, readManifest } from "../script";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();

/** A trigger owned by the given player groups. */
function newTrigger(players: number[]): TriggerRecord {
  const t = emptyTrigger();
  for (const p of players) t.players[p] = 1;
  return t;
}
const compile = (src: string) => compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
/** A body as the whole script's one program (the wrapper takes line 1, so the body's first line is 2). */
const program = (body: string, options = "") => `program(() => {${body}}${options ? `, ${options}` : ""});`;

function ok(src: string): CompileResult {
  const r = compile(src);
  expect(r.diagnostics).toEqual([]);
  return r;
}

const okProgram = (body: string) => ok(program(body));

/** A run of the whole script: the trigger() records in the trigger interpreter, the programs beside them, one world. */
interface Run { world: Simulation; programs: ProgramSimulation; events: { cycle: number; action: ActionRecord; text?: string }[] }
type RunOptions = Pick<SimulationOptions, "player" | "condition" | "random"> & { prepare?: (world: Simulation) => void };
function start(r: CompileResult, extra: RunOptions = {}): Run & { step(): void } {
  const player = extra.player ?? r.programs[0]?.owner ?? 0;
  const world = new Simulation(r.triggers, { strings: r.strings, player, condition: extra.condition, random: extra.random });
  extra.prepare?.(world);
  const programs = new ProgramSimulation(r.ir, { world, strings: r.strings, player, condition: extra.condition, random: extra.random });
  const out = { world, programs, events: programs.events, step: () => { world.step(); programs.step(); } };
  return out;
}
function run(r: CompileResult, frames: number, extra: RunOptions = {}): Run {
  const s = start(r, extra);
  for (let i = 0; i < frames; i++) s.step();
  return s;
}

/** The value of a program variable after a simulation; a boolean as 0 / 1. */
function value(sim: Run, name: string, programIndex = 0): number {
  const v = sim.programs.value(name, programIndex);
  expect(v, `the variable ${name}`).not.toBeUndefined();
  return typeof v === "boolean" ? Number(v) : (v as number);
}

const texts = (sim: Run) => sim.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`);
const messagesOf = (src: string) => compile(src).diagnostics.map((d) => d.message);

describe("structured: loops and branches", () => {
  it("a game loop runs once per frame, and costs the map nothing", () => {
    const r = okProgram(`
      let n = 0;
      while (true) {
        n += 1;
        if (n == 3) { victory(); }
        sleep(frames(1));
      }
    `);
    expect(r.programs).toEqual([{ owner: 0, owners: [0], perPlayer: false, source: { file: "main.ts", line: 1 } }]);
    expect(r.variables).toEqual([{ name: "n", kind: "number", program: 0, shared: false, at: { file: "main.ts", line: 2, column: 11 } }]);
    // No trigger, no death counter, no switch, no string: the program is IR, built into the saved map.
    expect(r.triggers).toEqual([]);
    expect(r.strings).toEqual([]);
    expect(r.ir).toHaveLength(1);
    expect(r.ir[0]).toMatchObject({ version: 2, owner: 0, owners: [0], perPlayer: false });
    const sim = run(r, 6);
    expect(sim.events.map((e) => `${e.cycle}:${ActionType.Victory === e.action.type ? "Victory" : e.action.type}`)).toEqual(["2:Victory"]);
    expect(value(sim, "n")).toBe(6);
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
        sleep(frames(1));
      }
    `);
    const sim = start(r);
    const outs: number[] = [];
    for (let i = 0; i < 4; i++) { sim.step(); outs.push(value(sim, "out")); }
    expect(outs).toEqual([10, 21, 30, 30]);
    expect(texts(sim)).toEqual(["0:tick", "1:tick", "2:tick", "3:tick"]);
  });

  it("a for with known bounds is unrolled: break and continue work, and the loop variable is no variable of the program", () => {
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
    expect(value(sim, "sum")).toBe(8);
    expect(r.variables.map((v) => v.name)).toEqual(["sum"]);
    expect(r.hints).toEqual([{ file: "main.ts", line: 3, label: "unrolled ×10", note: expect.stringMatching(/^Unrolled: 10 iterations, the loop variable a value known/) }]);
    // The body ended: the program stops for good.
    expect(sim.programs.finished()).toBe(true);
  });

  it("a for over a variable bound is a loop in the game, and runs to its end within the frame", () => {
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
    const sim = run(r, 2);
    expect(texts(sim)).toEqual(["0:done"]);
    expect(value(sim, "sum")).toBe(8);
    expect(value(sim, "i")).toBe(5);
    expect(r.hints).toEqual([]);
  });

  it("a for that unrolls too far, counts down, or steps by more than one", () => {
    expect(messagesOf(program("let s = 0; for (let i = 0; i < 1000; i++) { s += i; }"))).toEqual([expect.stringMatching(/unrolls to more than 256 iterations/)]);
    const r = okProgram("let s = 0; for (let i = 10; i > 0; i -= 3) { s += i; } for (let j = 2; j <= 6; j += 2) s += j;");
    expect(value(run(r, 1), "s")).toBe(10 + 7 + 4 + 1 + 2 + 4 + 6);
    // Assigning the loop variable in the body makes it a variable of the game again.
    const loop = okProgram("let s = 0; for (let i = 0; i < 4; i++) { s += i; i++; }");
    expect(loop.variables.map((v) => v.name)).toContain("i");
    expect(value(run(loop, 1), "s")).toBe(2);
  });

  it("do … while and while (cond) with a variable condition finish in the frame they start in", () => {
    const r = okProgram(`
      let n = 0;
      do { n++; } while (n < 3);
      let m = 10;
      while (m > 7) { m--; }
      victory();
    `);
    const sim = run(r, 3);
    expect(sim.events.map((e) => e.cycle)).toEqual([0]);
    expect(value(sim, "n")).toBe(3);
    expect(value(sim, "m")).toBe(7);
  });

  it("a loop that would never give the frame back is an error, said at the loop", () => {
    const endless = compile(program("\n  while (true) { wait(100); }\n"));
    expect(endless.diagnostics).toEqual([expect.objectContaining({ line: 2, source: "compiler", message: expect.stringMatching(/^A loop without an end needs a sleep\(\) on every path around it/) })]);
    expect(messagesOf(program('let n = 0; while (n < 3) { displayText("x"); }'))).toEqual([expect.stringMatching(/^This loop's condition never changes inside it/)]);
    // A sleep on only one path is not enough; on every path it is.
    expect(messagesOf(program("let n = 0; while (true) { n++; if (n > 3) { sleep(frames(1)); } }"))).toHaveLength(1);
    expect(messagesOf(program("let n = 0; while (true) { n++; if (n > 3) { sleep(frames(1)); } else { sleep(seconds(1)); } }"))).toEqual([]);
    // A loop that leaves, or whose condition the body moves, is fine.
    expect(messagesOf(program("while (true) { break; }"))).toEqual([]);
    expect(messagesOf(program("let n = 0; while (n < 3) { n++; }"))).toEqual([]);
    // The interpreter has a guard of its own for what the check cannot see.
    const sneaky = okProgram("let n = 0; let m = 0; while (n < 3) { m++; if (m > 100000000) n++; }");
    expect(() => new ProgramSimulation(sneaky.ir, { strings: sneaky.strings, maxStepsPerCycle: 1000 }).step()).toThrow(/sleep/);
  });
});

describe("structured: arithmetic", () => {
  it("copies, adds and subtracts between variables", () => {
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
    expect([value(sim, "a"), value(sim, "b"), value(sim, "c"), value(sim, "d")]).toEqual([7, 12, 5, 93]);
    expect(sim.events.map((e) => e.action.type)).toEqual([ActionType.Victory]);
  });

  it("x += x, x -= x, ++ / --, stopping at 0 and wrapping at 2³²", () => {
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
    expect([value(sim, "x"), value(sim, "y"), value(sim, "z"), value(sim, "w")]).toEqual([11, 0, 0, 0]);
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
    expect(value(sim, "x")).toBe(19);
    expect(sim.events.length).toBe(1);
    expect(r.variables.map((v) => v.name)).toEqual(["x"]);
  });
});

describe("structured: conditions", () => {
  it("compares variables with constants", () => {
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
    expect(texts(run(r, 1))).toEqual(["0:ge", "0:le", "0:eq", "0:flip", "0:shift", "0:unsigned", "0:neg"]);
  });

  it("compares variables with variables: what a side subtracts is added to the other, so neither stops at 0 on its own", () => {
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
      if (a - b < 0) displayText("below");
    `);
    const sim = run(r, 1);
    expect(texts(sim)).toEqual(["0:lt", "0:ne", "0:eq2", "0:gt", "0:both", "0:below"]);
    expect([value(sim, "a"), value(sim, "b")]).toEqual([3, 5]);
  });

  it("booleans, and random() as a coin toss", () => {
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
    expect(r.variables.map((v) => [v.name, v.kind])).toEqual([["x", "number"], ["f", "boolean"], ["g", "boolean"], ["r", "boolean"]]);
    expect(texts(run(r, 1, { random: () => 0.1 }))).toEqual(["0:both", "0:same", "0:differ", "0:computed", "0:heads", "0:twice"]);
    expect(texts(run(r, 1, { random: () => 0.9 }))).toEqual(["0:both", "0:same", "0:differ", "0:computed"]);
  });

  it("trigger conditions, and their opposites", () => {
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
    // No units on the map: every "at most" holds, every "at least" fails.
    const sim = run(r, 1, { condition: (c) => c.type === ConditionType.Bring && c.comparison === Comparison.AtMost });
    expect(texts(sim)).toEqual(["0:none", "0:skip", "0:notExactly"]);
    // One marine on the map, and switch 1 set.
    const marine = (c: ConditionRecord) => c.type === ConditionType.Bring && (c.unitId === 0 ? c.comparison === Comparison.AtLeast && c.amount <= 1 : c.comparison === Comparison.AtMost && c.amount >= 1);
    const sim2 = run(r, 1, { condition: marine, prepare: (world) => { world.switches[0] = 1; } });
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
    const sim = run(r, 1, { prepare: (world) => { world.switches[1] = 1; } });
    expect(sim.events.map((e) => e.text ?? e.action.type)).toEqual([ActionType.CreateUnit, "burst 2", "a", "b"]);
  });

  it("negateCondition: what one condition can say the opposite of", () => {
    expect(negateCondition({ type: ConditionType.Switch, resource: 1, comparison: SwitchState.Set } as ConditionRecord)).toEqual([expect.objectContaining({ comparison: SwitchState.Cleared })]);
    expect(negateCondition({ type: ConditionType.Always } as ConditionRecord)).toEqual([expect.objectContaining({ type: ConditionType.Never })]);
    expect(negateCondition({ type: ConditionType.CommandTheMost, unitId: 0 } as ConditionRecord)).toBe(null);
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
    expect(value(sim, "total")).toBe(28);
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

  it("locals inside functions are their own per call", () => {
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
    expect(value(run(r, 1), "out")).toBe(14);
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
        sleep(frames(1));
      }
      `)}
    `);
    const sim = run(r, 3);
    expect(sim.events.map((e) => [e.cycle, e.action.modifier])).toEqual([[1, 1], [1, 2]]);
  });
});

describe("structured: program options and layout", () => {
  it("an owner, hyper triggers beside it; the script's triggers keep the order they were defined in, and the program is not among them", () => {
    const r = ok(`
      trigger(AllPlayers, [always()], [defeat()]);
      ${program(`
      let n = 0;
      while (true) { n++; if (n == 2) victory(); sleep(frames(1)); }
      `, "{ owner: P8 }")}
      hyperTriggers(P8);
    `);
    expect(r.programs).toMatchObject([{ owner: 7, owners: [7], perPlayer: false }]);
    expect(r.triggers).toHaveLength(4);
    expect(r.triggers[0].actions[0].type).toBe(ActionType.Defeat);
    for (const t of r.triggers.slice(1)) {
      expect(t.players[7]).toBe(1);
      expect(t.actions.length).toBe(64);
      expect(t.actions.filter((a) => a.type === ActionType.Wait && a.time === 0).length).toBe(62);
      expect(t.actions[0].type).toBe(ActionType.Comment);
      expect(t.actions[63].type).toBe(ActionType.PreserveTrigger);
    }
    expect(r.strings).toEqual([{ text: "Hyper trigger" }]);
    expect(r.sources).toEqual([{ file: "main.ts", line: 2 }, null, null, null]);
    const sim = run(r, 3, { player: 7 });
    expect(sim.events.filter((e) => e.action.type === ActionType.Victory).map((e) => e.cycle)).toEqual([1]);
    // The trigger() beside it ran in the same world, for the same player.
    expect(sim.world.events.filter((e) => e.action.type === ActionType.Defeat).map((e) => e.cycle)).toEqual([0]);
  });

  it("two programs are two threads with their own variables", () => {
    const r = ok(`
      ${program(`let a = 0; while (true) { a++; sleep(frames(1)); }`, "{ owner: P1 }")}
      ${program(`let b = 0; while (true) { b += 2; sleep(frames(1)); }`, "{ owner: P2 }")}
    `);
    expect(r.programs.map((p) => p.owner)).toEqual([0, 1]);
    expect(r.variables.map((v) => [v.name, v.program])).toEqual([["a", 0], ["b", 1]]);
    const sim = run(r, 3);
    expect(value(sim, "a", 0)).toBe(3);
    expect(value(sim, "b", 1)).toBe(6);
  });

  it("the options of programs built as triggers are gone, and say why", () => {
    // TypeScript refuses them first, since the declarations no longer have them …
    expect(messagesOf(program("let n = 0;", "{ comments: false }"))).toEqual([expect.stringMatching(/'comments' does not exist in type 'ProgramOptions'/)]);
    // … and a script that gets past the checker hears why from the run.
    expect(messagesOf(program("let n = 0;", "{ comments: false } as any"))).toEqual([expect.stringMatching(/^program: "comments" was for programs built as death-counter triggers/)]);
    expect(messagesOf(program("let n = 0;", "{ variableUnits: [181] } as any"))).toEqual([expect.stringMatching(/^program: "variableUnits" was for programs/)]);
  });

  it("a program touches the map's own death counters and switches like any trigger, and takes none for itself", () => {
    const r = ok(`
      trigger(P1, [deaths(P2, 181, "==", 42)], [displayText("seen by the trigger")]);
      ${program(`let n = 1; setDeaths(P2, 181, "set", 42); n++; setSwitch(switches.Switch5, "set"); if (deaths(P2, 181, ">=", 40)) displayText("seen by the program");`)}
    `);
    const sim = run(r, 2);
    expect(sim.world.death(1, 181)).toBe(42);
    expect(sim.world.switches[4]).toBe(1);
    expect(value(sim, "n")).toBe(2);
    expect(texts(sim)).toEqual(["0:seen by the program"]);
    expect(sim.world.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`)).toEqual(["1:seen by the trigger"]);
  });

  it("applying writes the trigger() records as the block and records how many programs there are", () => {
    const src = `trigger(P1, [always()], [displayText("hello")]);\n${program('let n = 0; displayText("from the program"); n++;')}`;
    const r = ok(src);
    const hand = newTrigger([PlayerGroup.Player1]);
    const strings: string[] = [""];
    const intern = (t: string) => { strings.push(t); return strings.length - 1; };
    const { list, block, extras } = buildScript([hand], new Map(), { "main.ts": src }, r, intern);
    expect(block).toMatchObject({ start: 1, count: 1 });
    expect(list).toHaveLength(2);
    // Only what the trigger says goes into the map's string table; the program's text stays in the IR.
    expect(strings).toEqual(["", "hello"]);
    expect(readManifest(extras)).toMatchObject({ programs: 1, count: 1 });
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

  it("what a program cannot do", () => {
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
    // Dividing by a variable is fine now.
    expect(msgs.some((m) => m.startsWith("4:"))).toBe(false);
    expect(msgs).toContain("5:Expected a number: variables add, subtract, multiply, divide and take the remainder.");
    expect(msgs).toContain("6:wait's milliseconds must be known when the script is built. Only an amount with a modifier (setResources, setDeaths, setScore, setCountdownTimer) and a unit count (createUnit, killUnitAt, removeUnitAt, giveUnits) can be a variable of the program.");
    expect(msgs.some((m) => m.startsWith("7:Variables hold numbers, booleans or records of them ({ lives: 3 }); s is string"))).toBe(true);
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
    expect(r.variables.map((v) => v.name)).toEqual(["n", "next", "twice"]);
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
      t.program(() => { let n = 0; if (t.random()) t.displayText("x"); n++; if (n >= 1) t.victory(); t.sleep(t.frames(2)); });
    `);
    expect(r.sources[0]).toEqual({ file: "main.ts", line: 3 });
    expect(r.variables.map((v) => v.name)).toEqual(["n"]);
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
    expect(r.ir).toEqual([]);
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
    "let a = 7; let b = 3; let q = 0; let m = 0; q = a / b; m = a % b; a = a * b;",
  ];
  for (const body of cases) {
    it(body, () => {
      const r = okProgram(body);
      const sim = run(r, 2);
      const want = expected(body.replace(/(\w+) \/ (\w+)/g, "Math.floor($1 / $2)"));
      const got = Object.fromEntries(Object.keys(want).map((n) => [n, value(sim, n)]));
      expect(got).toEqual(want);
    });
  }
});

describe("structured: widths", () => {
  it("u8 variables stop at 255", () => {
    const narrow = okProgram("let a: u8 = 200; let b: u8 = 100; a += b;");
    const sim = run(narrow, 1);
    expect(value(sim, "a")).toBe(255);
    expect(value(sim, "b")).toBe(100);
    expect(narrow.variables.find((v) => v.name === "a")).toMatchObject({ bits: 8 });
    expect(okProgram("let a = 0;").variables[0].bits).toBeUndefined();
  });

  it("u16 stops on a constant addition too, and a constant that does not fit is an error", () => {
    const r = okProgram("let n: u16 = 65535; n++; n += 5;");
    expect(value(run(r, 1), "n")).toBe(65535);
    expect(messagesOf(program("let a: u8 = 300;"))).toEqual(["a is a u8 and holds 0 … 255, not 300."]);
  });

  it("a copied parameter keeps the argument's width; a sum through a call stays right", () => {
    const r = okProgram("let a: u8 = 250; let b: u8 = 10; let c: u8 = 0; function bump(x: number) { x += 1; c = x; } bump(a); c = a + b;");
    const sim = run(r, 1);
    expect(value(sim, "c")).toBe(255);
    expect(r.variables.find((v) => v.name === "x")).toMatchObject({ bits: 8 });
  });

  it("a narrow variable is stopped after the whole sum, not between its parts", () => {
    const r = okProgram("let a: u8 = 250; let b: u8 = 10; a = a + b - 10; let c: u16 = 65530; let d: u16 = 10; c = c + d - 20;");
    const sim = run(r, 1);
    expect(value(sim, "a")).toBe(250);
    expect(value(sim, "c")).toBe(65520);
    const over = okProgram("let a: u8 = 250; let b: u8 = 10; a = a + b - 1;");
    expect(value(run(over, 1), "a")).toBe(255);
  });

  it("the running sum of the additions is the one thing a 32-bit cell cannot promise", () => {
    // Documented: 2³² − 1 + 1 wraps to 0 before the subtraction; the source's exact sum (2³² − 1) fits, the cell does not.
    const r = okProgram("let a = 4294967295; let b = 1; let out = 0; out = a + b - 1;");
    expect(value(run(r, 1), "out")).toBe(0);
  });
});

describe("structured: time, edges, lists and players", () => {
  it("sleep gives the frame back for that long; a second is twenty-four frames", () => {
    const r = okProgram('displayText("a"); sleep(frames(3)); displayText("b");');
    expect(texts(run(r, 6))).toEqual(["0:a", "3:b"]);
    expect(texts(run(okProgram('sleep(seconds(2)); displayText("x");'), 60))).toEqual(["48:x"]);
    expect(texts(run(okProgram('sleep(minutes(1)); displayText("x");'), 1500))).toEqual(["1440:x"]);
    // cycles() is the older word for frames().
    expect(texts(run(okProgram('sleep(cycles(3)); displayText("x");'), 6))).toEqual(["3:x"]);
    const loop = okProgram('while (true) { displayText("w"); sleep(frames(2)); }');
    expect(texts(run(loop, 7))).toEqual(["0:w", "2:w", "4:w", "6:w"]);
  });

  it("a bare duration, sleep outside a program and a bad argument are all told where they belong", () => {
    expect(messagesOf(program("seconds(2);"))).toEqual(["A duration does nothing on its own; sleep(seconds(2)) pauses the program."]);
    expect(messagesOf("sleep(seconds(2));")).toEqual(["sleep() pauses a program: use it inside program(), as a statement — sleep(seconds(2))."]);
    expect(messagesOf(program("sleep(5 as any);"))).toEqual(["sleep() takes a duration from seconds(), minutes() or frames(), got number 5."]);
  });

  it("rose() is true on the frame its condition becomes true, once() only the first time", () => {
    const r = okProgram(`
      let n = 0;
      let up = true;
      while (true) {
        if (up) n++; else n--;
        if (n == 3) up = false;
        if (n == 0) up = true;
        if (rose(n >= 2)) displayText("rose");
        if (once(n >= 2)) displayText("once");
        sleep(frames(1));
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
    expect(value(sim, "total")).toBe(16);
    expect(texts(sim)).toEqual(["0:wave 2", "0:wave 5", "0:wave 9", "0:again 2", "0:a", "0:b"]);
    expect(compile(program("let n = 0; for (const x of [n]) displayText(\"x\");")).diagnostics[0].message).toMatch(/^What a for…of loop runs over must be known when the script is built, but n is a variable/);
  });

  it("a program owned by All Players runs once per player, each with their own variables", () => {
    const r = ok(program('let kills = 0; let alive = true; kills += 2; alive = !alive; if (kills >= 2 && !alive) displayText("k"); let total = shared(0); total += 1; if (total >= 1) displayText("t");', "{ owner: AllPlayers }"));
    expect(r.programs[0]).toMatchObject({ owner: 0, owners: [PlayerGroup.AllPlayers], perPlayer: true });
    expect(r.ir[0]).toMatchObject({ owners: [PlayerGroup.AllPlayers], perPlayer: true });
    expect(r.variables.map((v) => [v.name, v.shared])).toEqual([["kills", false], ["alive", false], ["total", true]]);
    for (const player of [0, 3]) {
      const sim = run(r, 1, { player });
      expect(texts(sim)).toEqual(["0:k", "0:t"]);
      expect(value(sim, "kills")).toBe(2);
      expect(value(sim, "alive")).toBe(0);
    }
  });

  it("a force or a list of players is per player too; one player is not", () => {
    const force = ok(program("let n = 0; n++;", "{ owner: players.Force2 }"));
    expect(force.programs[0]).toMatchObject({ owners: [PlayerGroup.Force2], perPlayer: true });
    expect(value(run(force, 1, { player: 5 }), "n")).toBe(1);
    const list = ok(program("let n = 0; n++;", "{ owner: [P1, P3] }"));
    expect(list.programs[0]).toMatchObject({ owner: 0, owners: [0, 2], perPlayer: true });
    const one = ok(program("let n = 0; n++;", "{ owner: P4 }"));
    expect(one.programs[0]).toMatchObject({ owner: 3, owners: [3], perPlayer: false });
  });

  it("per-player booleans: random(), toggling and rose()", () => {
    const r = ok(program('let f = false; f = random(); f = !f; if (rose(f)) displayText("r"); let g = shared(false); g = true; if (g) displayText("g");', "{ owner: AllPlayers }"));
    const sim = run(r, 1, { random: () => 0.1, player: 2 });
    expect(texts(sim)).toEqual(["0:g"]);
    expect(value(sim, "f")).toBe(0);
    expect(r.variables.find((v) => v.name === "g")).toMatchObject({ kind: "boolean", shared: true });
  });
});

describe("structured: short circuits, lazy constants, names", () => {
  const files = (src: Record<string, string>) => compileScript(ts, src, NAMES, { lib: LIB });

  it("&& and || short-circuit when the right side has an effect: once() is consumed only when the left side allows", () => {
    const r = okProgram("let n = 0; let out = 0; while (n < 3) { if (n >= 1 && once(true)) out++; n++; }");
    expect(value(run(r, 1), "out")).toBe(1);
    const or = okProgram("let n = 0; let out = 0; while (n < 3) { if (n == 0 || once(true)) out++; n++; }");
    // n == 0 fires without touching once(); n == 1 consumes it; n == 2 is false.
    expect(value(run(or, 1), "out")).toBe(2);
    const neg = okProgram("let n = 0; let out = 0; while (n < 3) { if (!(n >= 1 && rose(true))) out++; n++; }");
    // rose(true) rises once, at n == 1: the negation is true at n == 0 and n == 2.
    expect(value(run(neg, 1), "out")).toBe(2);
  });

  it("a constant of the program is computed when it is needed, never inside a pruned branch", () => {
    expect(okProgram('if (false) { const unused = (() => { throw new Error("dead branch evaluated"); })(); }').ir[0].body).toEqual([]);
    const later = okProgram("let x = 0; while (false) { const dead = (() => { throw new Error(\"no\"); })(); x = dead; } x = 1;");
    expect(value(run(later, 1), "x")).toBe(1);
    // A constant in live code runs where the source has it, and its error lands on its initializer.
    const r = compile(program('let x = 0;\nconst bad = (() => { throw new Error("boom"); })();\nx = 1;'));
    expect(r.diagnostics).toEqual([expect.objectContaining({ line: 2, column: 13, message: "boom — this constant is computed when the script is built, not in the game.", source: "script" })]);
    // A constant used before its declaration by a hoisted function still resolves.
    const r2 = okProgram("let x = 0; function f() { x = limit + 1; } const limit = 4; f(); f();");
    expect(value(run(r2, 1), "x")).toBe(5);
  });

  it("build-time parts of a body run once", () => {
    const counted = files({ "main.ts": 'import { tick } from "./count";\nprogram(() => { let n = 0; if (bring(P1, units.AnyUnit, locations.Anywhere, ">=", tick())) n++; });', "count.ts": "let calls = 0;\nexport const tick = () => ++calls;\nexport const seen = () => calls;" });
    expect(counted.ok).toBe(true);
    const stmt = counted.ir[0].body.find((s) => s.kind === "if");
    expect(stmt && stmt.kind === "if" && stmt.cond.kind === "cond" ? stmt.cond.record.amount : null).toBe(1);
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

describe("structured: game functions, returns and records", () => {
  const files = (src: Record<string, string>) => compileScript(ts, src, NAMES, { lib: LIB });

  it("a function of the body returns a number or a boolean", () => {
    const r = okProgram(`
      let x = 0; let y: u8 = 7;
      function twice(n: number) { return n + n; }
      function big(n: number) { return n >= 10; }
      function pick(n: number): number { if (n >= 5) return 1; return 2; }
      x = twice(y) + 1;
      if (big(x)) x = 100;
      x = pick(x) + pick(1);
    `);
    expect(value(run(r, 1), "x")).toBe(3);
    // A result is the call's own scratch value, not a variable of the program.
    expect(r.variables.map((v) => v.name)).toEqual(["x", "y"]);
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
    expect(value(sim, "gold")).toBe(4);
    expect(value(sim, "paid")).toBe(1);
    expect(sim.events.map((e) => `${e.action.type}:${e.action.player}:${e.action.target}`)).toEqual([`${ActionType.SetResources}:1:3`]);
    // What it does is attributed to its own file and line.
    expect(sim.programs.events[0].at).toMatchObject({ file: "shop.ts" });
    expect(r.buildTime.some((b) => b.file === "shop.ts")).toBe(true);
    // Calling one when the script is built is an error at the call.
    const built = files({ "main.ts": 'const f = game((n: number) => n + 1); const x = f(1);' });
    expect(built.diagnostics.map((d) => d.message)).toEqual(["A game() function runs in the game: call it inside program() or another game() function, not when the script is built."]);
    // game() inside a program is not allowed; a game function calling another is.
    expect(compile(program("const f = game((n: number) => n + 1);")).diagnostics[0].message).toMatch(/^game\(\) defines triggers of its own/);
    const nested = files({ "main.ts": 'const inc = game((n: number) => n + 1); const twice = game((n: number) => inc(inc(n))); program(() => { let x = 0; x = twice(x); x = twice(x); });' });
    expect(nested.diagnostics).toEqual([]);
    expect(value(run(nested, 1), "x")).toBe(4);
  });

  it("game functions see only their own bindings, and their locals are per call", () => {
    const r = files({ "main.ts": 'const f = game((n: number) => { let acc = 0; acc += n; return acc; }); program(() => { let a = 0; let b = 0; a = f(2); b = f(3); });' });
    expect(r.diagnostics).toEqual([]);
    const sim = run(r, 1);
    expect(value(sim, "a")).toBe(2);
    expect(value(sim, "b")).toBe(3);
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
    expect(value(sim, "p.lives")).toBe(1);
    expect(value(sim, "p.gold")).toBe(4);
    expect(value(sim, "p.alive")).toBe(0);
    expect(value(sim, "p.pos.x")).toBe(6);
    expect(r.variables.find((v) => v.name === "p.lives")).toMatchObject({ kind: "number", at: expect.objectContaining({ line: 2 }) });
    const typed = okProgram("let p: { n: u8 } = { n: 250 }; p.n += 10;");
    expect(value(run(typed, 1), "p.n")).toBe(255);
    expect(messagesOf(program("let p = { n: 1 }; p = { n: 2 };"))).toEqual(["A record is assigned field by field: p.lives = 3."]);
    expect(messagesOf(program("const p = { n: 1 }; p.n = 2;"))).toEqual(["This object is computed when the script is built. Declare it with let inside the program to make it a record of variables."]);
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
    expect(value(run(r, 1), "out")).toBe(1101);
    // break inside a switch inside a loop leaves the switch; continue reaches the loop.
    const loop = okProgram("let i = 0; let out = 0; while (i < 3) { i++; switch (i) { case 2: continue; default: out += i; break; } out += 10; }");
    expect(value(run(loop, 1), "out")).toBe(1 + 10 + 3 + 10);
  });

  it("?: as a number and as a condition, with a side that has effects reached only when chosen", () => {
    const r = okProgram("let a = 3; let b = 0; let c = 0; b = a > 2 ? a + 1 : 0; c = a > 5 ? 1 : b + 1; let n = 0; if (n >= 1 ? once(true) : false) c = 99; if (b == 4 ? true : false) c += 100;");
    const sim = run(r, 1);
    expect(value(sim, "b")).toBe(4);
    expect(value(sim, "c")).toBe(105);
  });

  it("multiplication, division and remainder — by constants and between variables", () => {
    const r = okProgram("let a: u8 = 7; let b = 0; let c = 0; let d = 0; b = a * 3 + 2; c = b / 4; d = b % 4; a *= 2; b /= 3; let e = 0; e = (a + 1) * 2 - a * 2;");
    const sim = run(r, 1);
    expect(value(sim, "b")).toBe(7);
    expect(value(sim, "c")).toBe(5);
    expect(value(sim, "d")).toBe(3);
    expect(value(sim, "a")).toBe(14);
    expect(value(sim, "e")).toBe(2);
    const vars = okProgram("let a = 6; let b = 7; let c = 0; c = a * b; c += a * a; let q = 0; q = c / b; let m = 0; m = c % a; let z = 0; let zero = 0; z = c / zero + 1;");
    const sim2 = run(vars, 1);
    expect(value(sim2, "c")).toBe(42 + 36);
    expect(value(sim2, "q")).toBe(11);
    expect(value(sim2, "m")).toBe(0);
    // A divisor that is 0 in the game gives 0.
    expect(value(sim2, "z")).toBe(1);
    expect(messagesOf(program("let a = 1; a = a / 0;"))).toEqual(["Divide by a whole number of at least 1, not 0."]);
    // × wraps at 2³².
    const wrap = okProgram("let a = 65536; let b = 65536; let c = 0; c = a * b + 5;");
    expect(value(run(wrap, 1), "c")).toBe(5);
  });

  it("Math.min / max / abs, clamp(), rounding — against constants and between variables", () => {
    const r = okProgram(`
      let a: u8 = 20; let b: u8 = 5; let lo = 0; let hi = 0; let d = 0; let k = 0; let m = 0;
      lo = Math.min(a, b); hi = Math.max(a, b); d = Math.abs(b - a); k = clamp(a, 8, 12); m = Math.max(Math.min(a, 7), b, 6);
      let f = 0; f = Math.floor(a / 3) + Math.trunc(b);
      let z = 0; z = Math.min(a, 3) + Math.max(b, 30) + Math.min(a, b, 2);
    `);
    const sim = run(r, 1);
    expect(value(sim, "lo")).toBe(5);
    expect(value(sim, "hi")).toBe(20);
    expect(value(sim, "d")).toBe(15);
    expect(value(sim, "k")).toBe(12);
    expect(value(sim, "m")).toBe(7);
    expect(value(sim, "f")).toBe(11);
    expect(value(sim, "z")).toBe(3 + 30 + 2);
    // The operands are intact.
    expect(value(sim, "a")).toBe(20);
    expect(value(sim, "b")).toBe(5);
  });

  it("comparisons with a coefficient", () => {
    const r = okProgram('let a = 3; let out = 0; if (a * 2 >= 5) out += 1; if (a * 2 == 7) out += 10; if (a * 2 != 7) out += 100; if (3 * a < 10) out += 1000; if (a + a == 6) out += 10000;');
    expect(value(run(r, 1), "out")).toBe(11101);
  });
});

describe("structured: actions with a variable amount", () => {
  const eventsOf = (sim: Run, type: number) => sim.events.filter((e) => e.action.type === type).map((e) => e.action);

  it("setResources / setDeaths / setScore / setCountdownTimer add, subtract and set a variable amount, one action each", () => {
    const r = okProgram(`
      let n: u8 = 13; let wave = 0; wave = 3;
      setResources(P1, "add", n, "ore");
      setResources(P2, "set", wave * 10 + 5, "gas");
      setScore(P1, "subtract", n, "kills");
      setCountdownTimer("set", n + 1);
      setDeaths(P3, units.TerranMarine, "add", n);
    `);
    const sim = run(r, 1);
    expect(eventsOf(sim, ActionType.SetResources).map((a) => [a.player, a.modifier, a.target])).toEqual([[0, SetModifier.Add, 13], [1, SetModifier.SetTo, 35]]);
    expect(eventsOf(sim, ActionType.SetScore).map((a) => [a.modifier, a.target])).toEqual([[SetModifier.Subtract, 13]]);
    expect(eventsOf(sim, ActionType.SetCountdownTimer).map((a) => a.time)).toEqual([14]);
    // The deaths went to the map's counter, which the simulator models, and the variable is intact.
    expect(sim.world.death(2, 0)).toBe(13);
    expect(value(sim, "n")).toBe(13);
  });

  it("createUnit and its kin take a variable count: that many units, whatever a byte could hold", () => {
    const r = okProgram(`
      let n: u8 = 6; let big = 0; big = 300; let none = 0;
      createUnit(P2, units.ZergZergling, n, locations.Anywhere);
      killUnitAt(P2, units.ZergZergling, n + 1, locations.Anywhere);
      createUnit(P3, units.ZergZergling, big, locations.Anywhere);
      createUnit(P4, units.ZergZergling, none, locations.Anywhere);
    `);
    const sim = run(r, 1);
    const created = eventsOf(sim, ActionType.CreateUnit);
    expect(created.map((a) => [a.player, a.modifier])).toEqual([[1, 6], [2, 300], [3, 0]]);
    expect(eventsOf(sim, ActionType.KillUnitAt).map((a) => a.modifier)).toEqual([7]);
    expect(value(sim, "n")).toBe(6);
    expect(value(sim, "big")).toBe(300);
    expect(compile(program("let n = 0; moveLocation(P1, units.AnyUnit, locations.Anywhere, n);")).diagnostics[0].message).toMatch(/^moveLocation's \w+ must be known/);
    expect(compile(program('let a = 0; let b = 0; setResources(P1, "add", a, b);')).diagnostics[0].message).toMatch(/must be known when the script is built/);
  });
});
