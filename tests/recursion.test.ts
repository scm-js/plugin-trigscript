/**
 * Recursion (slice 8): a function that calls itself — directly, or through another — is a called function whose
 * frame is kept on a stack around each call that may come back. `recursion.ts` takes such calls out of expressions
 * and says what each keeps; the interpreter here keeps and brings back as the game does, so a frame that is not
 * kept shows as a wrong number. `eud-build.test.ts` builds the same through eudplib.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { serializeIr } from "../compiler/eud";
import { STACK_DEPTH, eachCall, type Call, type Stmt } from "../compiler/ir";
import { largestFrame } from "../compiler/recursion";
import { readSettings, withSettings } from "../script";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, before = ""): CompileResult => compileScript(ts, { "main.ts": `${before}\nprogram(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, before = ""): CompileResult => { const r = raw(body, before); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const simulate = (r: CompileResult, options: { stackDepth?: number; heapCells?: number } = {}) => simulatePrograms(r.ir, 1, { strings: r.strings, maxStepsPerCycle: 5_000_000, ...options });
const functions = (r: CompileResult) => r.ir[0].functions ?? [];
const hint = (r: CompileResult, label: RegExp) => r.hints.find((h) => label.test(h.label));

const FIB = "function fib(n: number): number { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); }";

describe("recursion: a function that calls itself", () => {
  it("fib, called once from outside: a called function from the call inside itself on", () => {
    const r = compile(`${FIB} let k = 15; const out = fib(k);`);
    expect(functions(r).map((f) => [f.name, f.recursive])).toEqual([["fib", true]]);
    expect(simulate(r).value("out")).toBe(610);
    expect(hint(r, /calls itself/)?.note).toContain("kept on a stack");
  });

  it("every call that may come back is a statement of its own, and says what it keeps", () => {
    const r = compile(`${FIB} let k = 6; const out = fib(k);`);
    const f = functions(r)[0];
    const inside: Call[] = [];
    eachCall(f.body, (c) => inside.push(c));
    expect(inside).toHaveLength(2);
    // Statements, not operands: nothing of a backend's is half computed when the call is made.
    const asStatements: Call[] = [];
    const walk = (body: Stmt[]) => { for (const s of body) { if (s.kind === "call") asStatements.push(s.call); if (s.kind === "if") { walk(s.then); walk(s.else ?? []); } } };
    walk(f.body);
    expect(asStatements).toEqual(inside);
    // The second keeps the first one's result; neither keeps its own.
    expect(inside[1].saves!.vars).toContain(inside[0].result!.decl.id);
    expect(inside[0].saves!.vars).not.toContain(inside[0].result!.decl.id);
    expect(inside.every((c) => c.saves!.vars.includes(f.params[0].id) && c.saves!.within === "fib")).toBe(true);
    expect(largestFrame(r.ir)).toBe(1 + inside[1].saves!.vars.length);
    // The program's own call keeps nothing: only what recurses pays.
    eachCall(r.ir[0].body, (c) => expect(c.saves).toBeUndefined());
  });

  it("what JavaScript evaluates before the call is evaluated before it: ?:, &&, ||, a loop's condition", () => {
    const r = compile(`
      let calls = 0;
      function fact(n: number): number { calls++; return n <= 1 ? 1 : n * fact(n - 1); }
      function down(n: number): boolean { calls++; return n == 0 || down(n - 1); }
      function both(n: number): boolean { return n > 0 && both(n - 1); }
      function steps(n: number): number { let s = 0; while (n > 0 && steps(n - 1) >= 0) { s++; n--; } return s; }
      let k = 5;
      const a = fact(k);
      const after = calls;
      const b = down(k);
      const c = both(k);
      const d = steps(3);
    `);
    const sim = simulate(r);
    expect(sim.value("a")).toBe(120);
    expect(sim.value("after")).toBe(5);
    expect(sim.value("b")).toBe(true);
    expect(sim.value("c")).toBe(false);
    expect(sim.value("d")).toBe(3);
    expect(sim.faults).toEqual([]);
  });

  it("an operand to the left of such a call is worked out before it, a variable of the program's included", () => {
    const r = compile(`
      let total = 10;
      function drain(n: number): number { if (n == 0) return 0; total -= 1; return total + drain(n - 1); }
      let k = 3;
      const out = drain(k);
    `);
    // JavaScript: 9 + (8 + (7 + 0)).
    expect(simulate(r).value("out")).toBe(24);
  });

  it("mutual recursion: the functions of one cycle keep their frames the same way", () => {
    const r = compile(`
      function even(n: number): boolean { if (n == 0) return true; return odd(n - 1); }
      function odd(n: number): boolean { if (n == 0) return false; return even(n - 1); }
      let k = 9;
      const a = even(k); const b = odd(k); const c = even(k + 1);
    `);
    const sim = simulate(r);
    expect([sim.value("a"), sim.value("b"), sim.value("c")]).toEqual([false, true, true]);
    expect(functions(r).every((f) => f.recursive)).toBe(true);
  });

  it("a flood fill over an array of the program, and a local that outlives a call", () => {
    const r = compile(`
      const W = 8;
      let grid = new Array(64).fill(0);
      let filled = 0;
      function fill(at: number) {
        if (at < 0 || at >= 64) return;
        if (grid[at] != 0) return;
        grid[at] = 2;
        filled++;
        const x = at % W;
        if (x > 0) fill(at - 1);
        if (x < W - 1) fill(at + 1);
        fill(at - W);
        fill(at + W);
      }
      for (let i = 0; i < 8; i++) grid[24 + i] = 1;
      let start = 0;
      fill(start);
    `);
    const sim = simulate(r);
    expect(sim.value("filled")).toBe(24);
    expect(sim.faults).toEqual([]);
  });

  it("an array declared in such a function is each run's own", () => {
    const r = compile(`
      function spread(n: number): number {
        let mine = [n, n * 2, n * 3];
        let fixed = new Array(4).fill(n);
        if (n > 1) spread(n - 1);
        return mine[0] + mine[1] + mine[2] + fixed[3];
      }
      let k = 4;
      const out = spread(k);
    `);
    const sim = simulate(r);
    expect(sim.value("out")).toBe(4 + 8 + 12 + 4);
    expect(sim.faults).toEqual([]);
    const f = functions(r)[0];
    let saves: Call["saves"];
    eachCall(f.body, (c) => { saves ??= c.saves; });
    expect(saves!.arrays).toHaveLength(2);
    expect(r.ir[0].arrays.filter((a) => saves!.arrays.includes(a.id)).every((a) => a.dynamic)).toBe(true);
  });

  it("units and a do…while whose condition calls", () => {
    const r = compile(`
      function count(n: number): number { let turns = 0; do { turns++; n--; } while (n > 0 && count(0) == 1); return turns; }
      let k = 3;
      const out = count(k);
    `);
    // count(0) is one turn, so the condition holds while n > 0: three turns.
    expect(simulate(r).value("out")).toBe(3);
  });
});

describe("recursion: the depth the map allows", () => {
  const DEEP = "let reached = 0; function dive(n: number) { reached = n; if (n >= 0) dive(n + 1); } let zero = 0; dive(zero); let after = 1;";

  it("past it the program stops where it is, and the fault says which function and how deep", () => {
    const r = compile(DEEP);
    const sim = simulate(r);
    expect(sim.value("reached")).toBe(STACK_DEPTH);
    expect(sim.faults).toHaveLength(1);
    expect(sim.faults[0].message).toMatch(/Stack overflow in dive: 1,024 calls deep/);
    expect(sim.finished()).toBe(true);
    // Nothing after the call ran.
    expect(sim.value("after")).toBeUndefined();
    expect(simulate(compile(DEEP.replace("n >= 0", "n < 100"))).value("after")).toBe(1);
  });

  it("is the map's script setting, carried in the IR file only when it differs and something recurses", () => {
    const r = compile(DEEP);
    expect(simulate(r, { stackDepth: 40 }).value("reached")).toBe(40);
    expect(JSON.parse(serializeIr(r.ir, r.strings, null, { stackDepth: 40 })).stack).toBe(40);
    expect(JSON.parse(serializeIr(r.ir, r.strings, null, { stackDepth: STACK_DEPTH })).stack).toBeUndefined();
    const flat = compile("let x = 1; x++;");
    expect(JSON.parse(serializeIr(flat.ir, flat.strings, null, { stackDepth: 40 })).stack).toBeUndefined();
    const none = new Map<string, Uint8Array>();
    expect(readSettings(withSettings(none, { stackDepth: 40 }))).toMatchObject({ stackDepth: 40 });
    expect(readSettings(withSettings(none, { stackDepth: 1 })).stackDepth).toBe(16);
    expect(withSettings(withSettings(none, { stackDepth: 40 }), {}).size).toBe(0);
  });

  it("a deep recursion that ends is within it", () => {
    const r = compile("function sum(n: number): number { if (n == 0) return 0; return n + sum(n - 1); } let k = 1000; const out = sum(k);");
    const sim = simulate(r);
    expect(sim.value("out")).toBe(500500);
    expect(sim.faults).toEqual([]);
  });
});

describe("recursion: what stays as it was, and what cannot be", () => {
  it("a call with a value of the script for its argument recurses the same way", () => {
    const r = compile("let out = 0; function count(n: number) { out += n; if (n > 1) count(n - 1); } count(4);");
    expect(functions(r).map((f) => f.recursive)).toEqual([true]);
    expect(simulate(r).value("out")).toBe(10);
    const sum = compile("function sum(n: number): number { if (n == 0) return 0; return n + sum(n - 1); } const out = sum(40);");
    expect(simulate(sum).value("out")).toBe(820);
  });

  it("a function with no argument the game works out recurses on the program's variables", () => {
    const r = compile("let left = 5; let turns = 0; function spin() { if (left == 0) return; left--; turns++; spin(); } spin();");
    expect(functions(r).map((f) => f.recursive)).toEqual([true]);
    expect(simulate(r).value("turns")).toBe(5);
  });

  it("a function with no way out is said when the script is built, not when the stack runs out", () => {
    const r = raw("function spin(n: number) { n++; spin(n); } let k = 0; spin(k);");
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/spin calls itself on every path through it/);
  });

  it("a function that sleeps cannot call itself, and the error says why", () => {
    const r = raw("function wait(n: number) { if (n == 0) return; sleep(frames(1)); wait(n - 1); } let k = 3; wait(k);");
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/wait calls itself, and here it cannot be a function that is called — it sleeps/);
  });

  it("a loop over units cannot hold a call that comes back", () => {
    const r = raw("function sweep(n: number) { if (n == 0) return; for (const u of unitsOf(P1)) { u.kill(); sweep(n - 1); } } let k = 2; sweep(k);");
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/loop over units holds such a call/);
  });

  it("a function off every cycle is exactly what it was", () => {
    const r = compile(`${FIB} function twice(n: number): number { return n + n; } let k = 5; const a = twice(k); const b = twice(a); const c = fib(k);`);
    const twice = functions(r).find((f) => f.name === "twice")!;
    expect(twice.recursive).toBeUndefined();
    eachCall(twice.body, (c) => expect(c.saves).toBeUndefined());
    const sim = simulate(r);
    expect([sim.value("a"), sim.value("b"), sim.value("c")]).toEqual([10, 20, 5]);
  });
});

describe("the recursion probe (probes/recursion.ts), which is played in the game, says the same here", () => {
  const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "recursion.ts"), "utf8") }, NAMES, { lib: LIB });
  it("compiles, and every line that states what it expects shows it", () => {
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    // Player 1's four Marines, as build-fixture places them.
    const marines = [0, 1, 2, 3].map((k) => ({ type: 0, owner: 0, x: 100 + k * 20, y: 100, hp: 40, maxHp: 40 }));
    const sim = simulatePrograms(r.ir, 24 * 46, { strings: r.strings, playerName: () => "Ann", units: marines, maxStepsPerCycle: 5_000_000 });
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]\b/.test(t));
    const stated = lines.map((t) => /^([A-Z]): ([-\d ]+) \(expect ([-\d ]+)\)$/.exec(t)).filter((m): m is RegExpExecArray => !!m);
    expect(stated.map((m) => m[1])).toEqual(["A", "B", "C", "D", "E", "F", "G", "I", "J"]);
    for (const m of stated) expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
    expect(lines).toContain("H: 40 10 - ONE Marine is at 10 hit points (expect 40 10)");
    expect(lines).toContain("K: Ann 55 (expect 55)");
    // The third program ran out of stack and stopped; the first went on to its end.
    expect(lines.some((t) => t.startsWith("L:"))).toBe(false);
    expect(sim.events.some((e) => e.text === "done")).toBe(true);
    expect(sim.faults.map((f) => [f.program, /Stack overflow in dive: 1,024 calls deep/.test(f.message)])).toEqual([[2, true]]);
  });
});
