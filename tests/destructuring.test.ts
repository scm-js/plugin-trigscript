/**
 * Destructuring and spread (slice 8½): all of it the front end's — a name in a pattern is a variable of its own holding a
 * copy, a record or a list inside one stays itself, a spread copies cell by cell. The IR is what it was.
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

describe("patterns in a declaration", () => {
  it("the fields of a record, renamed, and a copy: changing the name does not change the record", () => {
    const sim = run("let p = { x: 3, y: 4 }; let { x, y: py } = p; x = 50; let out = 0; out = x * 100 + py * 10 + p.x;");
    expect(sim.value("out")).toBe(5043);
  });
  it("the items of an array, a hole, a default for what is past a fixed end, and the rest", () => {
    const sim = run("let xs = [1, 2, 3, 4]; const [a, , c, d, e = 9, ...none] = xs; const [first, ...tail] = xs; let out = 0; out = a * 1000 + c * 100 + d * 10 + e; let n = 0; n = tail.length;");
    expect(sim.value("out")).toBe(1349);
    expect(sim.list("tail")).toEqual([2, 3, 4]);
    expect(sim.value("n")).toBe(3);
  });
  it("the rest of an array that grows is one that grows", () => {
    const sim = run("let xs: number[] = []; xs.push(5); xs.push(6); xs.push(7); const [head, ...tail] = xs; tail.push(8); let h = 0; h = head;");
    expect(sim.value("h")).toBe(5);
    expect(sim.list("tail")).toEqual([6, 7, 8]);
  });
  it("nested, and a row of an array of records — which stays the array's own when it is not taken apart", () => {
    const sim = run("let ws = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]; const [{ count }, second] = ws; second.delay = 7; let out = 0; out = count * 10 + ws[1].delay;");
    expect(sim.value("out")).toBe(47);
  });
  it("the rest of a record is a record of its own", () => {
    const sim = run("let p = { x: 1, y: 2, z: 3 }; const { x, ...others } = p; others.y = 20; let out = 0; out = x * 1000 + others.y * 10 + others.z + p.y * 100;");
    expect(sim.value("out")).toBe(1403);
  });
  it("values the script has: a constant taken out of a pattern is still the script's", () => {
    const sim = run("const { n, d = 5 } = waves[0]; const [a, b] = pair; let out = 0; out = n * 1000 + d * 100 + a * 10 + b;", "const waves: { n: number; d?: number }[] = [{ n: 4 }]; const pair = [7, 9];");
    expect(sim.value("out")).toBe(4579);
  });
  it("what for…of hands out, taken apart at the top of each turn", () => {
    const sim = run("let ws = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]; let sum = 0; for (const { count, delay } of ws) { if (delay == 0) continue; sum += count * delay; }");
    expect(sim.value("sum")).toBe(14);
  });
});

describe("patterns in a parameter", () => {
  it("of a function, inlined and called, and of a function given to a method", () => {
    const sim = run(`let p = { x: 3, y: 4 }; let q = { x: 1, y: 1 };
      function len({ x, y }: { x: number; y: number }) { return x * x + y * y; }
      let a = 0; let b = 0; a = len(p); b = len(q) + len(p);
      let ws = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]; let sum = 0; ws.forEach(({ count, delay }) => { sum += count * delay; });
      let big = 0; big = ws.findIndex(({ count }) => count > 5);`);
    expect(sim.value("a")).toBe(25);
    expect(sim.value("b")).toBe(27);
    expect(sim.value("sum")).toBe(14);
    expect(sim.value("big")).toBe(1);
  });
  it("the rest of the arguments is an array made at the call", () => {
    const sim = run("function sum(scale: number, ...ns: number[]) { let s = 0; for (const n of ns) s += n; return s * scale; } let a = 2; let out = 0; let none = 0; out = sum(10, a, 3, 4); none = sum(10);");
    expect(sim.value("out")).toBe(90);
    expect(sim.value("none")).toBe(0);
  });
});

describe("patterns that are assigned", () => {
  it("a swap, of variables and of cells; every value is taken before any is stored", () => {
    const sim = run("let a = 1; let b = 2; [a, b] = [b, a]; let xs = [10, 20, 30]; let i = 0; [xs[i], xs[2]] = [xs[2], xs[i]]; let c = 0; [a, b, c] = [b, a + b, a];");
    expect(sim.value("a")).toBe(1);
    expect(sim.value("b")).toBe(3);
    expect(sim.value("c")).toBe(2);
    expect(sim.list("xs")).toEqual([30, 20, 10]);
  });
  it("a const array only a pattern stores into is an array of the program", () => {
    const sim = run("const xs = [1, 2]; [xs[0], xs[1]] = [xs[1], xs[0]];");
    expect(sim.list("xs")).toEqual([2, 1]);
  });
  it("from a record and from an array, into fields", () => {
    const sim = run("let p = { x: 3, y: 4 }; let q = { x: 0, y: 0 }; ({ x: q.y, y: q.x } = p); let xs = [7, 8]; let m = 0; let n = 0; [m, n] = xs;");
    expect(sim.value("q.x")).toBe(4);
    expect(sim.value("q.y")).toBe(3);
    expect(sim.value("m")).toBe(7);
    expect(sim.value("n")).toBe(8);
  });
});

describe("spread", () => {
  it("into an array: fixed from fixed, and one that grows from one that grows", () => {
    const sim = run("let xs = [1, 2]; let n = 9; const ys = [0, ...xs, n, ...xs]; let zs: number[] = []; zs.push(5); const all = [...zs, ...xs, n + 1];", "");
    expect(sim.list("ys")).toEqual([0, 1, 2, 9, 1, 2]);
    expect(sim.list("all")).toEqual([5, 1, 2, 10]);
  });
  it("a list the script has spread into an array of the program", () => {
    const sim = run("let n = 1; const ys = [...base, n];", "const base = [7, 8];");
    expect(sim.list("ys")).toEqual([7, 8, 1]);
  });
  it("into a record: a copy, and what is written after the spread replaces its own", () => {
    const sim = run("let p = { x: 3, y: 4 }; const q = { ...p, y: 9 }; q.x = 30; let out = 0; out = q.x * 100 + q.y * 10 + p.x;");
    expect(sim.value("out")).toBe(3093);
  });
  it("into a row that is pushed or stored", () => {
    const sim = run("let ws = [{ count: 4, delay: 2 }]; const w = ws[0]; ws.push({ ...w, count: 9 }); ws[0] = { ...w, delay: 5 }; let out = 0; out = ws[1].count * 100 + ws[1].delay * 10 + ws[0].delay;");
    expect(sim.value("out")).toBe(925);
  });
});

describe("what is refused, and how", () => {
  it("a name with nothing to take and no default", () => {
    expect(messages("let xs = [1, 2]; const [a, b, c] = xs;").join("\n")).toMatch(/no item 2|undefined/);
  });
  it("a spread of another kind, and rest in an assignment", () => {
    expect(messages("let flags = [true]; const ys = [1, ...flags];").join("\n")).toMatch(/booleans|not assignable/);
    expect(messages("let xs = [1, 2, 3]; let a = 0; let rest = [0]; [a, ...rest] = xs;").join("\n")).toMatch(/declared, not assigned/);
  });
});
