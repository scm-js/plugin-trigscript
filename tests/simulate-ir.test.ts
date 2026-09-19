/**
 * The program interpreter's contract with the game (`python/trigscript.py`): when a program
 * gives the frame back, and how a number comes out — the places where the obvious
 * implementation would differ from what eudplib builds.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation, simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();

const compile = (body: string): CompileResult => {
  const r = compileScript(ts, { "main.ts": `program(() => {${body}});` }, NAMES, { lib: LIB });
  expect(r.diagnostics).toEqual([]);
  return r;
};
const after = (body: string, frames = 1) => { const r = compile(body); return simulatePrograms(r.ir, frames, { strings: r.strings }); };

describe("frames", () => {
  it("a game loop with a sleep runs once every that many frames", () => {
    const sim = after(`let n = 0; while (true) { n += 1; displayText("n"); sleep(frames(2)); }`, 12);
    expect(sim.events.map((e) => e.cycle)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(sim.value("n")).toBe(6);
  });
  it("loops run to completion within a frame", () => {
    const sim = after(`let i = 0; while (true) { i = 0; while (i < 5) { i += 1; } if (i == 5) { displayText("five"); } sleep(frames(1)); }`, 3);
    expect(sim.events.map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:five", "1:five", "2:five"]);
  });
  it("a sleep inside a nested loop and inside a function resumes where it left off", () => {
    const sim = after(`function pause() { sleep(frames(1)); } let i = 0; while (i < 3) { displayText("in"); pause(); i += 1; } displayText("out");`, 6);
    expect(sim.events.map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:in", "1:in", "2:in", "3:out"]);
    expect(sim.finished()).toBe(true);
  });
  it("stops when a runaway program never gives the frame back", () => {
    const r = compile(`let n = 0; let m = 0; while (n < 3) { m++; if (m > 4000000000) n++; }`);
    expect(() => new ProgramSimulation(r.ir, { strings: r.strings, maxStepsPerCycle: 1000 }).step()).toThrow(/sleep/);
  });
});

describe("numbers come out as the game computes them", () => {
  const value = (body: string, name = "out") => after(body).value(name);

  it("a number goes below zero, as TypeScript's does", () => {
    expect(value("let a = 3; let b = 10; let out = 0; out = a - b + 9;")).toBe(2);
    expect(value("let a = 3; let b = 10; let out = 0; out = a - b;")).toBe(-7);
    expect(value("let a = 3; let out = 0; out = -a * 2;")).toBe(-6);
  });
  it("a number wraps at 2³¹ as x | 0 does, a u32 at 2³² as x >>> 0 does", () => {
    expect(value("let a = 2147483647; let b = 1; let out = 0; out = a + b;")).toBe(-2147483648);
    expect(value("let a: u32 = 4294967295; let out: u32 = 5; out = a + 1;")).toBe(0);
    expect(value("let a: u32 = 0; let out: u32 = 5; out = a - 1;")).toBe(4294967295);
  });
  it("division is towards zero and the remainder takes the dividend's sign; u32s divide from 0 up; a divisor of 0 gives 0", () => {
    expect(value("let a = -7; let b = 2; let out = 0; out = a / b;")).toBe(-3);
    expect(value("let a = -7; let b = 2; let out = 0; out = a % b;")).toBe(-1);
    expect(value("let a = 7; let b = -2; let out = 0; out = a / b * 10 + a % b;")).toBe(-29);
    expect(value("let a = -7; let out = 0; out = a / 2 * 10 + a % 2;")).toBe(-31);
    expect(value("let a: u32 = 4294967295; let out: u32 = 0; out = a / 2;")).toBe(2147483647);
    expect(value("let a = -7; let z = 0; let out = 9; out = a / z + a % z;")).toBe(0);
  });
  it("comparisons are signed, exact between a number and a u32, and Math.min / max / abs follow", () => {
    expect(value("let a = -1; let b = 1; let out = 0; if (a < b) out = 1;")).toBe(1);
    expect(value("let a: u32 = 4294967295; let b: u32 = 1; let out = 0; if (a > b) out = 1;")).toBe(1);
    expect(value("let a = -1; let b: u32 = 4294967295; let out = 0; if (a < b) out += 1; if (a != b) out += 2; if (b > a) out += 4; if (a == b) out += 8;")).toBe(7);
    expect(value("let a = -5; let b = 3; let out = 0; out = Math.min(a, b) * 100 + Math.max(a, b) * 10 + Math.abs(a);")).toBe(-500 + 30 + 5);
    expect(value("let a: u32 = 4294967295; let b: u32 = 3; let out: u32 = 0; out = Math.min(a, b);")).toBe(3);
  });
  it("u32(x), i32(x) and x >>> 0 read the same bits the other way and compute nothing", () => {
    expect(value("let a = -1; let out: u32 = 0; out = u32(a) / 2;")).toBe(2147483647);
    expect(value("let a = -1; let out: u32 = 0; out = (a >>> 0) / 2;")).toBe(2147483647);
    expect(value("let a: u32 = 4294967295; let out = 0; out = i32(a) / 2;")).toBe(0);
    expect(value("let a: u32 = 4294967294; let out = 0; out = i32(a) - 1;")).toBe(-3);
    expect(compile("let a = -1; let out: u32 = 0; out = u32(a) / 2;").ir[0].body.some((s) => JSON.stringify(s).includes('"cast"'))).toBe(false);
  });
  it("where the game takes nothing below zero, a number below zero goes in as 0", () => {
    expect(value("let a = -5; let out: u8 = 9; out = a;")).toBe(0);
    expect(value("let a = 300; let out: u8 = 9; out = a;")).toBe(255);
    expect(value("let a = -5; let out: u16 = 9; out = a + 2;")).toBe(0);
  });
  it("a comparison moves what a side subtracts to the other side", () => {
    expect(value("let a = 3; let b = 5; let out = 0; if (a - b == 0) out = 1;")).toBe(0);
    expect(value("let a = 3; let b = 5; let out = 0; if (a - b < 0) out = 1;")).toBe(1);
    expect(value("let a = 3; let out = 0; if (a >= -1) out = 1;")).toBe(1);
    expect(value("let a = 3; let out = 0; if (-a < 0) out = 1;")).toBe(1);
  });
  it("Math.abs is the distance, whichever side is larger", () => {
    expect(value("let a = 20; let b = 5; let out = 0; out = Math.abs(b - a);")).toBe(15);
    expect(value("let a = 20; let b = 5; let out = 0; out = Math.abs(a - b) + Math.abs(3 - 10);")).toBe(22);
  });
  it("× wraps, ÷ and % round down, and a divisor of 0 gives 0", () => {
    expect(value("let a = 65536; let out = 0; out = a * a + 7;")).toBe(7);
    expect(value("let a = 7; let b = 2; let out = 0; out = a / b * 10 + a % b;")).toBe(31);
    expect(value("let a = 7; let z = 0; let out = 0; out = a / z + a % z + 4;")).toBe(4);
  });
  it("a negative constant is something subtracted, never its 32-bit pattern", () => {
    expect(value("let a = 10; let out = 0; out = a + -3;")).toBe(7);
    expect(value("const k = -4; let a = 10; let out = 0; out = a + k;")).toBe(6);
  });
});

describe("reads: what the game holds, as a value", () => {
  const errors = (src: string) => compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB }).diagnostics.map((d) => `${d.line}:${d.message}`);

  it("a comparing condition without its comparison is a read of what it compares", () => {
    const r = compile(`setDeaths(P1, units.TerranMarine, "set", 7); let out = deaths(P1, units.TerranMarine); let twice = deaths(P1, units.TerranMarine) * 2 + 1;`);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.value("out")).toBe(7);
    expect(sim.value("twice")).toBe(15);
    const decl = r.ir[0].body.find((s) => s.kind === "declare" && s.decl.name === "out");
    expect(decl).toMatchObject({ init: { kind: "read", read: { source: "condition", record: { type: 15, player: 0, unitId: 0, comparison: 0, amount: 0 } } } });
  });
  it("the resources a program set are what minerals() finds, in a comparison and as an action's amount", () => {
    const sim = after(`let gold = 20; let out = 0; setResources(P1, "set", 50, "ore"); if (minerals(P1) > gold * 2) out = minerals(P1) - gold; setResources(P1, "add", minerals(P1), "gas"); let both = resources(P1, "oreAndGas"); let g = gas(P1);`);
    expect(sim.value("out")).toBe(30);
    expect(sim.value("g")).toBe(50);
    expect(sim.value("both")).toBe(100);
  });
  it("the current player's own value, and what the caller says for what the simulation does not hold", () => {
    const r = compile(`let n = countUnits(CurrentPlayer, units.ZergZergling, locations.Anywhere); let all = countUnits(P2, units.ZergZergling); let k = kills(P1, units.AnyUnit); let t = countdown() + elapsed();`);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, read: (read) => (read.source === "condition" ? read.record.type : undefined) });
    expect([sim.value("n"), sim.value("all"), sim.value("k"), sim.value("t")]).toEqual([3, 2, 5, 13]);
  });
  it("player facts: the race, the slot, a person or not, left or not, the supply", () => {
    const r = compile(`let out = 0; if (isHuman(CurrentPlayer) && !hasLeft(P2) && race(P1) == races.Terran && slot(P3) == slots.Empty) out = supply(P1, "used") + supply(P1, "max", races.Zerg); let h = isHuman(P1); let n = 0; if (isHuman(P1) == true) n = 1;`);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, read: (read) => (read.source === "player" ? (read.fact === "race" ? 1 : read.fact === "slot" ? (read.player === 2 ? 0 : 2) : 0) : read.source === "supply" ? (read.of === "used" ? 12 : read.race === 0 ? 200 : 0) : undefined) });
    expect(sim.value("out")).toBe(212);
    expect(sim.value("h")).toBe(true);
    expect(sim.value("n")).toBe(1);
  });
  it("a read outside a program, a read as a statement, and a read of a variable's player are said plainly", () => {
    expect(errors(`trigger(P1, [deaths(P1, units.TerranMarine) as any], []);`)[0]).toMatch(/^1:trigger: conditions: deaths\(\) without a comparison reads the value/);
    expect(errors(`trigger(P1, [always()], [setResources(P1, "set", minerals(P1) as any, "ore")]);`)[0]).toMatch(/minerals\(\) is a value the game holds/);
    expect(errors(`const twice = minerals(P1) * 2;`)[0]).toMatch(/minerals\(\) is a value the game holds, read while the game runs/);
    expect(errors(`program(() => {\n  minerals(P1);\n});`)).toEqual(["2:minerals() reads a value and does nothing on its own: assign it to a variable, or compare it in an if."]);
    expect(errors(`program(() => {\n  let p = 0;\n  let m = minerals(p as Player);\n});`)[0]).toMatch(/^3:What to read must be known when the script is built, but p is a variable/);
    expect(errors(`program(() => {\n  let m = minerals(AllPlayers) + race(AllPlayers);\n});`)[0]).toMatch(/race: player: expected one player/);
  });
  it("a loop on a read needs a sleep unless its body acts on the game", () => {
    expect(errors(`program(() => {\n  while (minerals(P1) < 100) { }\n});`)[0]).toMatch(/^2:This loop's condition never changes inside it/);
    expect(errors(`program(() => {\n  while (countUnits(P1, units.TerranMarine) < 5) createUnit(P1, units.TerranMarine, 1, locations.Anywhere);\n});`)).toEqual([]);
  });
});

describe("random(n) and the bitwise operators", () => {
  const value = (body: string, name = "out") => after(body).value(name);
  it("random(n) is 0 … n − 1, with a variable bound too; random() stays a coin toss", () => {
    const r = compile(`let n = 6; let out = random(n); let zero = random(0); let lane = random(3); let coin = random();`);
    const rolls = [0.999, 0.5, 0.2]; // random(0) asks for none
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, random: () => rolls.shift() ?? 0 });
    expect([sim.value("out"), sim.value("zero"), sim.value("lane"), sim.value("coin")]).toEqual([5, 0, 1, true]);
  });
  it("& | ^ << >> >>> work on the 32 bits; >> keeps the sign, >>> does not, and a shift by 32 or more leaves nothing but the sign", () => {
    expect(value("let a = 12; let b = 10; let out = 0; out = (a & b) + (a | b) * 100 + (a ^ b) * 10000;")).toBe(8 + 1400 + 60000);
    expect(value("let a = 1; let s = 31; let out = 0; out = a << s;")).toBe(-2147483648);
    expect(value("let a: u32 = 1; let s = 31; let out: u32 = 0; out = a << s;")).toBe(2147483648);
    expect(value("let a: u32 = 4294967295; let s = 28; let out: u32 = 0; out = a >> s; out = out + (a >>> s);")).toBe(30);
    expect(value("let a = -16; let s = 2; let out = 0; out = a >> s;")).toBe(-4);
    expect(value("let a = -16; let out = 0; out = a >> 2;")).toBe(-4);
    expect(value("let a = -16; let s = 28; let out = 0; out = a >>> s;")).toBe(15);
    expect(value("let a = 5; let s = 32; let out = 9; out = (a << s) + (a >> s);")).toBe(0);
    expect(value("let a = -5; let s = 40; let out = 9; out = a >> s;")).toBe(-1);
    expect(value("let a = 6; let out = 0; a &= 3; a |= 8; a ^= 1; a <<= 2; a >>= 1; out = a;")).toBe(22);
  });
});

describe("text with the program's values in it", () => {
  const texts = (body: string, options = {}) => { const r = compile(body); return simulatePrograms(r.ir, 1, { strings: r.strings, ...options }).events.map((e) => `${e.action.player}:${e.text}`); };

  it("displayText with a template is printed for the current player, the numbers as they are then", () => {
    expect(texts("let gold = 5; gold += 2; displayText(`You have ${gold} gold, ${gold * 2} soon`);")).toEqual(["13:You have 7 gold, 14 soon"]);
    expect(texts("let n = 3; displayText(\"n = \" + n + \"!\");")).toEqual(["13:n = 3!"]);
    expect(texts("displayText(`ore ${minerals(P1)}`);")).toEqual(["13:ore 0"]);
  });
  it("name() and color() are filled in by the game, wherever the text was put together", () => {
    const r = compile("const banner = (p: Player) => `${color(p)}${name(p)} wins`; let n = 1; displayText(banner(P2)); displayText(`${name(CurrentPlayer)} has ${n}`);");
    const prints = r.ir[0].body.filter((s) => s.kind === "print");
    expect(prints[0]).toMatchObject({ to: 13, position: "chat", parts: [{ kind: "color", player: 1 }, { kind: "name", player: 1 }, { kind: "text", text: " wins" }] });
    expect(prints[1]).toMatchObject({ parts: [{ kind: "name", player: 13 }, { kind: "text", text: " has " }, { kind: "number" }] });
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, playerName: (p) => ["Ann", "Bob"][p] ?? "?" });
    expect(sim.events.map((e) => e.text)).toEqual(["Bob wins", "Ann has 1"]);
    // Nothing of a program's text is left for the map's string table to take.
    expect(r.triggers).toEqual([]);
  });
  it("print() shows it to someone else, or in the middle of the screen", () => {
    const r = compile("let wave = 2; print(`Wave ${wave}`, { to: AllPlayers, position: \"center\" }); print(\"plain\", { to: P2 }); print(`for me ${wave}`);");
    expect(r.ir[0].body.filter((s) => s.kind === "print").map((s) => (s.kind === "print" ? [s.to, s.position] : []))).toEqual([[17, "center"], [1, "chat"], [13, "chat"]]);
    expect(simulatePrograms(r.ir, 1, { strings: r.strings }).events.map((e) => `${e.action.player}:${e.text}`)).toEqual(["17:Wave 2", "1:plain", "13:for me 2"]);
  });
  it("what a text cannot hold is said", () => {
    const errors = (src: string) => compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB }).diagnostics.map((d) => `${d.line}:${d.message}`);
    expect(errors("trigger(P1, [always()], [displayText(`${name(P1)} wins`)]);")[0]).toMatch(/^1:name\(\) and color\(\) are filled in by a program while the game runs/);
    expect(errors("program(() => {\n  let flag = true;\n  displayText(`${flag}`);\n});")[0]).toMatch(/^3:A boolean has no text of its own/);
    expect(errors("program(() => {\n  let n = 1;\n  setMissionObjectives(`${n} left`);\n});")[0]).toMatch(/^3:setMissionObjectives's text must be known when the script is built/);
    expect(errors("program(() => {\n  print(\"x\", { to: players.Foes });\n});")[0]).toMatch(/print: to is a player/);
    expect(errors("trigger(P1, [always()], [print(\"x\") as any]);")[0]).toMatch(/print\(\) is a statement of a program/);
  });
});

describe("the numbers probe (probes/numbers.ts), which is played in the game, says the same here", () => {
  const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "numbers.ts"), "utf8") }, NAMES, { lib: LIB });
  const marine = { type: 0, owner: 0, x: 100, y: 100, hp: 40, maxHp: 40 };
  const sim = simulatePrograms(r.ir, 24 * 58, { strings: r.strings, units: [marine], playerName: () => "Ann" });
  const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]\d?: /.test(t));

  it("compiles, and every line that states what it expects shows it", () => {
    expect(r.diagnostics).toEqual([]);
    const stated = lines.map((t) => /^([A-Z]\d?): ([-\d ]+) \(expect ([-\d ]+)\)$/.exec(t)).filter((m): m is RegExpExecArray => !!m);
    expect(stated.map((m) => m[1])).toEqual(["A", "B", "C", "D", "D2", "D3", "E", "F", "G", "H", "L"]);
    for (const m of stated) expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
  });
  it("and the lines that say it in words", () => {
    expect(lines).toContain("I: a u8 of -5 is 0, of 300 is 255 (expect 0 255); your ORE was set from -50: the top bar says 0");
    expect(lines).toContain("J: while (i >= 0) ran 4 times and left i at -1 (expect 4 and -1)");
    expect(lines).toContain("K: minus one");
    expect(lines).toContain("M: one of your Marines lost 1000 hit points: it DIED");
    expect(lines).toContain("N: Ann owes -5 (expect -5)");
    // Ore was set from -50, which goes in as 0, then from 75; a count of -3 made no unit and a count of 2 made two.
    const ore = sim.events.filter((e) => e.action.type === 26).map((e) => e.action.target);
    expect(ore).toEqual([0, 75]);
    expect(sim.events.filter((e) => e.action.type === 44).map((e) => e.action.modifier)).toEqual([0, 2]);
  });
});
