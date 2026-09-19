/**
 * The array methods that take a function (slice 8½): the function is inlined into the loop the method becomes, so what
 * it uses from outside is the program's own cell and no function exists when the map is played. The interpreter here;
 * `eud-build.test.ts` builds the same through eudplib.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, before = ""): CompileResult => compileScript(ts, { "main.ts": `${before}\nprogram(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, before = ""): CompileResult => { const r = raw(body, before); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, before = "", frames = 1) => { const r = compile(body, before); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const messages = (body: string, before = "") => raw(body, before).diagnostics.map((d) => d.message);

describe("forEach, and what the function sees", () => {
  it("runs the function for every cell, with the place; a variable from outside is the program's own", () => {
    const sim = run("let hp = [5, 30, 12]; let total = 0; let places = 0; hp.forEach((h, i) => { total += h; places += i; });");
    expect(sim.value("total")).toBe(47);
    expect(sim.value("places")).toBe(3);
    expect(sim.faults).toEqual([]);
  });
  it("an expression for a body, a return that ends the turn only, and a parameter the function assigns is its own", () => {
    const sim = run("let xs = [1, 2, 3, 4]; let sum = 0; xs.forEach((x) => sum += x); let odd = 0; xs.forEach((x) => { if (x % 2 == 0) return; odd += x; }); xs.forEach((x) => { x = 0; });");
    expect(sim.value("sum")).toBe(10);
    expect(sim.value("odd")).toBe(4);
    expect(sim.list("xs")).toEqual([1, 2, 3, 4]);
  });
  it("the third argument is the array itself, and what is pushed during the loop is not visited", () => {
    const sim = run("let xs: number[] = [1, 2, 3]; let turns = 0; xs.forEach((x, i, all) => { turns++; if (i == 0) all.push(9); all[i] = x * 2; });");
    expect(sim.value("turns")).toBe(3);
    expect(sim.list("xs")).toEqual([2, 4, 6, 9]);
  });
  it("a function declared in the program by its name", () => {
    const sim = run("let xs = [1, 2, 3]; let sum = 0; function add(x: number) { sum += x; } xs.forEach(add);");
    expect(sim.value("sum")).toBe(6);
  });
  it("an array of records: the row is the array's own, so what the function writes stays", () => {
    const sim = run("let waves = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]; waves.forEach((w) => { w.count += w.delay; }); let a = 0; let b = 0; a = waves[0].count; b = waves[1].count;");
    expect(sim.value("a")).toBe(6);
    expect(sim.value("b")).toBe(7);
  });
  it("a list the script has, with a function that touches the program: unrolled, the item a value of the script", () => {
    const sim = run("let total = 0; waves.forEach((w, i) => { total += w.n * (i + 1); });", "const waves = [{ n: 4 }, { n: 6 }];");
    expect(sim.value("total")).toBe(16);
  });
});

describe("a list the script has, and a function that only does things", () => {
  it("forEach with nothing of the program in it still runs in the game: it is there for what its function does", () => {
    const r = compile("waves.forEach((w) => createUnit(P2, w.unit, w.n, locations.Anywhere)); waves.forEach((w) => { createUnit(P2, w.unit, w.n, locations.Anywhere); });", "const waves = [{ unit: units.ZergZergling, n: 4 }, { unit: units.ZergHydralisk, n: 2 }];");
    const actions: number[] = [];
    const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { const o = x as Record<string, unknown>; if (o.kind === "action") actions.push((o.record as { unitId: number }).unitId); Object.values(o).forEach(walk); } };
    walk(r.ir);
    expect(actions).toEqual([37, 38, 37, 38]);
  });
  it("a map of one with nothing of the program in it is still the script's", () => {
    const sim = run("let n = 0; n = twice[2];", "const twice = [1, 2, 3].map((x) => x * 2);");
    expect(sim.value("n")).toBe(6);
  });
});

describe("some, every, find, findIndex, reduce", () => {
  it("some and every stop at the first answer", () => {
    const sim = run("let xs = [1, 5, 9]; let looked = 0; let any = false; let all = false; any = xs.some((x) => { looked++; return x > 3; }); all = xs.every((x) => x > 0); let none = true; none = xs.some((x) => x > 100);");
    expect(sim.value("any")).toBe(true);
    expect(sim.value("all")).toBe(true);
    expect(sim.value("none")).toBe(false);
    expect(sim.value("looked")).toBe(2);
  });
  it("in a condition, and again every turn of a loop", () => {
    const sim = run("let xs = [3, 2, 1]; let turns = 0; while (xs.some((x) => x > 0)) { xs.forEach((x, i, all) => { if (x > 0) all[i] = x - 1; }); turns++; }");
    expect(sim.value("turns")).toBe(3);
    expect(sim.list("xs")).toEqual([0, 0, 0]);
  });
  it("findIndex and findLastIndex give the place, or -1", () => {
    const sim = run("let xs = [4, 8, 8, 2]; let a = 0; let b = 0; let c = 0; a = xs.findIndex((x) => x == 8); b = xs.findLastIndex((x) => x == 8); c = xs.findIndex((x) => x > 50);");
    expect(sim.value("a")).toBe(1);
    expect(sim.value("b")).toBe(2);
    expect(sim.value("c")).toBe(-1);
  });
  it("find with what it is when nothing is found", () => {
    const sim = run("let xs = [4, 8, 15]; let a = 0; let b = 0; let c = 0; a = xs.find((x) => x > 5) ?? -1; b = xs.find((x) => x > 50) ?? -1; c = xs.findLast((x) => x > 5) ?? -1;");
    expect(sim.value("a")).toBe(8);
    expect(sim.value("b")).toBe(-1);
    expect(sim.value("c")).toBe(15);
  });
  it("reduce, of numbers and to a boolean, over records too", () => {
    const sim = run("let xs = [1, 2, 3, 4]; let sum = 0; sum = xs.reduce((s, x) => s + x, 10); let most = 0; most = xs.reduce((m, x) => Math.max(m, x), 0); let waves = [{ count: 4 }, { count: 6 }]; let units = 0; units = waves.reduce((n, w) => n + w.count, 0);");
    expect(sim.value("sum")).toBe(20);
    expect(sim.value("most")).toBe(4);
    expect(sim.value("units")).toBe(10);
  });
  it("a truthy number answers as it does in JavaScript", () => {
    const sim = run("let xs = [0, 0, 7]; let at = 0; at = xs.findIndex((x) => x);");
    expect(sim.value("at")).toBe(2);
  });
});

describe("map, filter, and chains", () => {
  it("map of a fixed array is a fixed array; of one that grows, one that grows", () => {
    const sim = run("let xs = [1, 2, 3]; const twice = xs.map((x) => x * 2); const even = xs.map((x) => x % 2 == 0); let ys: number[] = []; ys.push(5); ys.push(6); const more = ys.map((y, i) => y + i);");
    expect(sim.list("twice")).toEqual([2, 4, 6]);
    expect(sim.list("even")).toEqual([false, true, false]);
    expect(sim.list("more")).toEqual([5, 7]);
  });
  it("filter keeps what answers true, in order, and can be pushed to after", () => {
    const sim = run("let xs = [5, 30, 12, 8]; const big = xs.filter((x) => x > 7); big.push(1); let n = 0; n = big.length;");
    expect(sim.list("big")).toEqual([30, 12, 8, 1]);
    expect(sim.value("n")).toBe(4);
  });
  it("filter of records keeps whole rows", () => {
    const sim = run("let waves = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }, { count: 9, delay: 5 }]; const slow = waves.filter((w) => w.delay > 1); let n = 0; let c = 0; n = slow.length; c = slow[1].count;");
    expect(sim.value("n")).toBe(2);
    expect(sim.value("c")).toBe(9);
  });
  it("a chain makes the arrays in the middle as written, and for…of runs over what a method made", () => {
    const sim = run("let xs = [5, 30, 12, 8]; let out: number[] = []; xs.filter((x) => x < 20).map((x) => x + 1).forEach((x) => out.push(x)); let sum = 0; for (const x of xs.filter((x) => x > 10)) sum += x; let n = 0; n = xs.filter((x) => x > 100).length;");
    expect(sim.list("out")).toEqual([6, 13, 9]);
    expect(sim.value("sum")).toBe(42);
    expect(sim.value("n")).toBe(0);
  });
  it("made again every time the line runs, so a loop does not pile them up", () => {
    const sim = run("let xs = [1, 2, 3]; let n = 0; for (let t = 0; t < 40; t++) { const kept = xs.filter((x) => x > t); n += kept.length; }");
    expect(sim.value("n")).toBe(6);
    expect(sim.faults).toEqual([]);
  });
  it("a const list that only a function given to a method writes to is the program's", () => {
    const sim = run("const out: number[] = []; let xs = [1, 2, 3]; xs.forEach((x) => out.push(x * 3)); let n = 0; n = out.length;");
    expect(sim.list("out")).toEqual([3, 6, 9]);
  });
  it("a list the script has: map and filter make arrays of the program from it", () => {
    const sim = run("let bonus = 2; const paid = prices.map((p) => p + bonus); const dear = prices.filter((p) => p > bonus * 40);", "const prices = [50, 100, 150];");
    expect(sim.list("paid")).toEqual([52, 102, 152]);
    expect(sim.list("dear")).toEqual([100, 150]);
  });
});

describe("sort and reverse", () => {
  it("sorts in place by the function, keeps equals in order, and gives the same array", () => {
    const sim = run("let xs = [5, 30, 12, 8, 12]; xs.sort((a, b) => a - b); let ys = [1, 2, 3]; ys.sort((a, b) => b - a); let first = 0; first = ys.sort((a, b) => a - b)[0];");
    expect(sim.list("xs")).toEqual([5, 8, 12, 12, 30]);
    expect(sim.list("ys")).toEqual([1, 2, 3]);
    expect(sim.value("first")).toBe(1);
  });
  it("records are sorted row by row, the function reading their fields", () => {
    const sim = run("let waves = [{ count: 9, delay: 5 }, { count: 4, delay: 2 }, { count: 6, delay: 1 }]; waves.sort((a, b) => a.delay - b.delay); let order = 0; order = waves[0].count * 100 + waves[1].count * 10 + waves[2].count;");
    expect(sim.value("order")).toBe(649);
  });
  it("reverse, of an odd and an even length", () => {
    const sim = run("let xs = [1, 2, 3]; xs.reverse(); let ys = [1, 2, 3, 4]; ys.reverse();");
    expect(sim.list("xs")).toEqual([3, 2, 1]);
    expect(sim.list("ys")).toEqual([4, 3, 2, 1]);
  });
  it("64 cells the wrong way round, within the frame", () => {
    const sim = run("let xs = new Array(64).fill(0); for (let i = 0; i < 64; i++) xs[i] = 64 - i; xs.sort((a, b) => a - b); let ok = true; for (let i = 0; i < 64; i++) if (xs[i] != i + 1) ok = false;");
    expect(sim.value("ok")).toBe(true);
  });
});

describe("what is refused, and how", () => {
  it("a function kept as a value", () => {
    expect(messages("let xs = [1]; let f = (x: number) => x > 0; let any = false; any = xs.some(f);").join("\n")).toMatch(/function/);
  });
  it("sleep inside", () => {
    expect(messages("let xs = [1]; xs.forEach((x) => { sleep(seconds(1)); });")).toEqual([expect.stringMatching(/for…of over the same list can sleep/)]);
  });
  it("sort without its function, and with one that answers true or false", () => {
    expect(messages("let xs = [2, 1]; xs.sort();")).toEqual([expect.stringMatching(/\(a, b\) => a - b/)]);
    expect(messages("let xs = [2, 1]; xs.sort((a, b) => a > b);").join("\n")).toMatch(/'boolean' is not assignable to type 'number'/);
  });
  it("find of a number on its own, and of a record", () => {
    expect(messages("let xs = [2, 1]; const a = xs.find((x) => x > 1);").join("\n")).toMatch(/\?\? 0/);
    expect(messages("let ws = [{ n: 1 }]; const w = ws.find((w) => w.n > 0);").join("\n")).toMatch(/findIndex/);
  });
  it("reduce without what it starts from", () => {
    expect(messages("let xs = [2, 1]; let a = 0; a = xs.reduce((s, x) => s + x);")).toEqual([expect.stringMatching(/starts from/)]);
  });
  it("an array made in a loop's condition", () => {
    expect(messages("let xs = [2, 1]; while (xs.filter((x) => x > 0).length > 0) { xs[0] = 0; xs[1] = 0; }")).toContainEqual(expect.stringMatching(/before the loop, or inside it/));
  });
  it("what a method is not handed", () => {
    expect(messages("let xs = [2, 1]; let a = 0; a = xs.reduce((s, x, i, all, extra) => s + x, 0);").join("\n")).toMatch(/would be undefined|Expected|arguments/);
  });
});
