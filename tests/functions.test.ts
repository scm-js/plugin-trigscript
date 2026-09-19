/**
 * Functions that are called (slice 7): a function met a second time is one copy in the built map, its
 * parameters variables every call sets — when it never sleeps, keeps no edge and compiles that way. The
 * rest stay inlined, and the end of the function's line says which. The interpreter here;
 * `eud-build.test.ts` builds the same through eudplib.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { serializeIr } from "../compiler/eud";
import type { Call } from "../compiler/ir";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, before = ""): CompileResult => compileScript(ts, { "main.ts": `${before}\nprogram(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, before = ""): CompileResult => { const r = raw(body, before); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const simulate = (r: CompileResult, frames = 1) => simulatePrograms(r.ir, frames, { strings: r.strings });
const functions = (r: CompileResult) => r.ir[0].functions ?? [];
const hint = (r: CompileResult, label: RegExp) => r.hints.find((h) => label.test(h.label));

/** Every call of a program, by the name of what it calls: "called" or "inlined". */
function calls(r: CompileResult): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (root: unknown) => {
    if (Array.isArray(root)) { root.forEach(walk); return; }
    if (!root || typeof root !== "object") return;
    const o = root as Record<string, unknown>;
    if (o.kind === "call" && o.call) { const c = o.call as Call; if (c.name) (out[c.name] ??= []).push(c.fn ? "called" : "inlined"); }
    Object.values(o).forEach(walk);
  };
  walk(r.ir[0].body);
  walk(r.ir[0].functions ?? []);
  return out;
}

describe("functions: called or inlined", () => {
  it("a function met twice is one copy that both calls run; its parameter is a variable each call sets", () => {
    const r = compile("let out = 0; function twice(n: number) { let t = n; t += t; out += t; } twice(3); let k = 4; twice(k); twice(k + 1);");
    expect(functions(r).map((f) => [f.name, f.params.map((p) => p.name)])).toEqual([["twice", ["n"]]]);
    expect(calls(r)).toEqual({ twice: ["called", "called", "called"] });
    expect(simulate(r).value("out")).toBe(6 + 8 + 10);
    expect(hint(r, /^called ×3$/)?.note).toContain("one copy");
    // The first call was inlined when it was met, with n the value 3; nothing of that is left.
    expect(r.variables.filter((v) => v.name === "t")).toHaveLength(1);
  });

  it("a function met once is inlined as it always was, a parameter bound to a value being that value", () => {
    const r = compile("function spawn(n: number) { for (let i = 0; i < n; i++) createUnit(P1, units.TerranMarine, 1, locations.Anywhere); } spawn(3);");
    expect(functions(r)).toEqual([]);
    expect(calls(r)).toEqual({ spawn: ["inlined"] });
    expect(hint(r, /^unrolled ×3$/)).toBeTruthy();
    expect(hint(r, /called|inlined/)).toBeUndefined();
  });

  it("returns a number, a boolean, a unit; an argument that is a call of the same function is worked out first", () => {
    const r = compile(`
      let out = 0; let yes = false; let left = 0;
      function add(a: number, b: number) { return a + b; }
      function big(n: number) { return n >= 10; }
      function weakest(p: number): Unit | null { let best: Unit | null = null; for (const u of unitsOf(P1)) { if (u.hp < p) best = u; } return best; }
      out = add(add(1, 2), add(3, 4));
      yes = big(out) && !big(out - 1);
      const a = weakest(30); const b = weakest(100);
      if (a) left += 1; if (b) left += 2;
    `);
    expect(functions(r).map((f) => [f.name, f.result?.kind])).toEqual([["add", "number"], ["big", "boolean"], ["weakest", "unit"]]);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, units: [{ type: 0, owner: 0, hp: 40 }] });
    expect(sim.value("out")).toBe(10);
    expect(sim.value("yes")).toBe(true);
    expect(sim.value("left")).toBe(2);
  });

  it("a default and a value of the script are what the parameter is set to; a u8 parameter stops at its top", () => {
    const r = compile("let total = 0; function add(by = 2, small: u8 = 0) { total += by + small; } add(); add(5); add(1, 300 - 50); let n = 400; add(0, n);");
    expect(functions(r)).toHaveLength(1);
    expect(simulate(r).value("total")).toBe(2 + 5 + 251 + 255);
  });

  it("a function that sleeps stays inlined, and its line says why", () => {
    const r = compile("let n = 0; function wait(f: number) { n += f; sleep(frames(1)); } wait(1); wait(2);");
    expect(functions(r)).toEqual([]);
    expect(calls(r)).toEqual({ wait: ["inlined", "inlined"] });
    expect(simulate(r, 3).value("n")).toBe(3);
    expect(hint(r, /^inlined ×2$/)?.note).toContain("sleeps");
  });

  it("a parameter that reaches a field only the script can fill keeps the function inlined", () => {
    const r = compile("function pay(p: Player, n: number) { setResources(p, 'add', n, 'ore'); } let k = 5; pay(P1, k); pay(P2, k);");
    expect(functions(r)).toEqual([]);
    expect(hint(r, /^inlined ×2$/)?.note).toMatch(/does not compile/);
    expect(simulate(r).events.map((e) => e.action.player)).toEqual([0, 1]);
  });

  it("an argument only the script has — text, a list — keeps that call inlined", () => {
    const r = compile("function say(t: string) { displayText(t); } say('a'); say('b');");
    expect(functions(r)).toEqual([]);
    expect(hint(r, /^inlined ×2$/)?.note).toContain("only the script has");
  });

  it("rose() and once() keep a latch a call, so such a function stays inlined", () => {
    const r = compile("let n = 0; function first(c: number) { if (once(n >= c)) n += 10; } first(0); first(0);");
    expect(functions(r)).toEqual([]);
    expect(simulate(r).value("n")).toBe(20);
  });

  it("what the function closes over is the program's: a loop whose condition a called function moves is no frozen loop", () => {
    const r = compile("let i = 0; function bump() { i += 1; } bump(); while (i < 5) { bump(); }");
    expect(functions(r)).toHaveLength(1);
    expect(simulate(r).value("i")).toBe(5);
  });

  it("a call inside a loop unrolled three times is three calls of one copy", () => {
    const r = compile("let sum = 0; function add(n: number) { sum += n; } for (const v of [1, 2, 3]) add(v);");
    expect(functions(r)).toHaveLength(1);
    expect(hint(r, /^called ×3$/)).toBeTruthy();
    expect(simulate(r).value("sum")).toBe(6);
  });

  it("a function that calls itself is a called one (recursion.test.ts has the rest)", () => {
    const r = compile("let turns = 0; function down(n: number) { turns++; if (n > 0) down(n - 1); } let k = 3; down(k); down(k);");
    expect(functions(r).map((f) => [f.name, f.recursive])).toEqual([["down", true]]);
    expect(simulate(r).value("turns")).toBe(8);
  });
});

describe("functions: arrays, and functions inside functions", () => {
  it("a function that takes an array is one copy an array passed", () => {
    const r = compile(`
      let hp = [1, 2, 3]; let shields = [10, 20]; let out = 0;
      function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }
      out = total(hp) + total(hp) + total(shields) + total(shields) + total(hp);
    `);
    expect(functions(r).map((f) => f.name)).toEqual(["total", "total"]);
    expect(simulate(r).value("out")).toBe(6 * 3 + 30 * 2);
    expect(hint(r, /^called ×5, 2 copies$/)?.note).toContain("one for each array");
  });

  it("an array passed once is an inlined call beside the called copy of another", () => {
    const r = compile("let a = [1, 2]; let b = [5]; let out = 0; function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; } out = total(a) + total(a) + total(b);");
    expect(calls(r).total.sort()).toEqual(["called", "called", "inlined"]);
    expect(simulate(r).value("out")).toBe(3 + 3 + 5);
  });

  it("a function only a called function calls is met once after all, and inlined in it", () => {
    const r = compile("let out = 0; function inner(n: number) { out += n; } function outer(n: number) { inner(n + 1); } outer(1); outer(2);");
    expect(functions(r).map((f) => f.name)).toEqual(["outer"]);
    expect(calls(r)).toEqual({ outer: ["called", "called"], inner: ["inlined"] });
    expect(simulate(r).value("out")).toBe(5);
  });

  it("a called function calls another", () => {
    const r = compile("let out = 0; function inner(n: number) { out += n; } function outer(n: number) { inner(n + 1); inner(n + 2); } outer(1); outer(2); inner(100);");
    expect(functions(r).map((f) => f.name).sort()).toEqual(["inner", "outer"]);
    expect(simulate(r).value("out")).toBe(2 + 3 + 3 + 4 + 100);
  });

  it("a game() function from another file is called the same way", () => {
    const r = compileScript(ts, {
      "lib.ts": "export const clampTo = game((n: number, top: number) => { if (n > top) return top; return n; });",
      "main.ts": "import { clampTo } from './lib';\nprogram(() => { let a = 50; let b = 5; let out = 0; out = clampTo(a, 10) + clampTo(b, 10); });",
    }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(functions(r).map((f) => f.name)).toEqual(["clampTo"]);
    expect(simulate(r).value("out")).toBe(15);
    expect(r.hints.find((h) => /^called ×2$/.test(h.label))?.file).toBe("lib.ts");
  });

  it("the functions go to the lowering with the program, their text written out", () => {
    const r = compile("function say(n: number) { displayText(`n`); setDeaths(P1, units.TerranMarine, 'set', n); } let k = 1; say(k); say(k + 1);");
    const ir = JSON.parse(serializeIr(r.ir, r.strings));
    expect(ir.version).toBe(13);
    expect(ir.programs[0].functions).toHaveLength(1);
    expect(JSON.stringify(ir.programs[0].functions)).toContain('"text":"n"');
  });

  it("an array only a thrown-away copy of a body declared is not kept", () => {
    const r = compile("let out = 0; function sum3(n: number) { let xs = [n, n, n]; let i = 0; xs[i] += 1; out += xs[0] + xs[1] + xs[2]; } sum3(1); let k = 2; sum3(k);");
    expect(r.ir[0].arrays.map((a) => a.name)).toEqual(["xs"]);
    expect(simulate(r).value("out")).toBe(4 + 7);
  });
});

describe("the functions probe (probes/functions.ts), which is played in the game, says the same here", () => {
  const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "functions.ts"), "utf8") }, NAMES, { lib: LIB });
  it("compiles, and every line that states what it expects shows it", () => {
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    // Player 1's four Marines, as build-fixture places them.
    const marines = [0, 1, 2, 3].map((k) => ({ type: 0, owner: 0, x: 100 + k * 20, y: 100, hp: 40, maxHp: 40 }));
    const sim = simulatePrograms(r.ir, 24 * 46, { strings: r.strings, playerName: () => "Ann", units: marines, maxStepsPerCycle: 100_000 });
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]\d?\b/.test(t));
    const stated = lines.map((t) => /^([A-Z]): ([-\d ]+) \(expect ([-\d ]+)\)$/.exec(t)).filter((m): m is RegExpExecArray => !!m);
    expect(stated.map((m) => m[1])).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "J", "L"]);
    for (const m of stated) expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
    expect(lines).toContain("I: 40 10 - ONE Marine is at 10 hit points (expect 40 10)");
    expect(lines).toContain("M: Ann 3 6 (expect 3 6)");
    expect(lines.filter((t) => /^K\d$/.test(t))).toEqual(["K1", "K2"]);
    expect(sim.faults).toEqual([]);
  });
  it("calls what can be called and inlines the rest, as the lines of the probe say", () => {
    const called = (r.ir[0].functions ?? []).map((f) => f.name).sort();
    // `total` twice over (hp, shields); `wait` sleeps; `raise` and `keep` are each met twice with one array.
    expect(called).toEqual(["add", "big", "bump", "clampTo", "early", "either", "hpOf", "hurt", "inner", "keep", "outer", "raise", "small", "total", "total", "twice", "weakest"]);
    expect(r.hints.find((h) => h.label === "inlined ×2")?.note).toContain("sleeps");
    expect((r.ir[1].functions ?? []).map((f) => f.name)).toEqual(["earn"]);
  });
});
