/**
 * Arrays inside things, of a fixed shape (slice 8½): an array of arrays whose rows are all one length is one flat array
 * read at `y * width + x`, a row a window on it; an array in a record is an array the record's name leads to.
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

describe("a grid", () => {
  it("is one flat array, read and stored by two indices, constants and variables", () => {
    const sim = run("let g = [[1, 2, 3], [4, 5, 6]]; let y = 1; let x = 2; let out = 0; out = g[0][1] * 100 + g[y][x] * 10 + g[y][0]; g[y][x] = 9; g[0][x - 1] += 5; g[y][0]++;");
    expect(sim.value("out")).toBe(264);
    expect(sim.list("g")).toEqual([1, 7, 3, 5, 5, 9]);
    expect(sim.faults).toEqual([]);
  });
  it("made the ways people make one, all worked out when the script is built", () => {
    const sim = run("let a = new Array(3).fill(0).map(() => new Array(4).fill(7)); let b = Array.from({ length: 2 }, (_, y) => [y, y * 2]); let n = 5; let c = [[n, 0], [0, n]]; let rows = 0; let cols = 0; rows = a.length; cols = a[0].length;");
    expect(sim.list("a")).toEqual(new Array(12).fill(7));
    expect(sim.list("b")).toEqual([0, 0, 1, 2]);
    expect(sim.list("c")).toEqual([5, 0, 0, 5]);
    expect(sim.value("rows")).toBe(3);
    expect(sim.value("cols")).toBe(4);
  });
  it("a row never reaches into the next: past its end reads 0 and stores nothing", () => {
    const sim = run("let g = [[1, 2], [3, 4]]; let x = 2; let y = 0; let out = 5; out = g[y][x]; g[y][x] = 99; let below = 5; x = -1; below = g[1][x]; y = 7; let far = 5; far = g[y][0];");
    expect(sim.value("out")).toBe(0);
    expect(sim.value("below")).toBe(0);
    expect(sim.value("far")).toBe(0);
    expect(sim.list("g")).toEqual([1, 2, 3, 4]);
    expect(sim.faults.length).toBe(4);
  });
  it("a row is an array: kept, looped, given to a method and to a function — and it is the grid's own cells", () => {
    const sim = run(`let g = [[1, 2, 3], [4, 5, 6]]; let y = 1; const row = g[y]; y = 0; row[0] = 40;
      let sum = 0; for (const c of row) sum += c;
      function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }
      let first = 0; first = total(g[0]);
      let big = 0; big = g[1].filter((c) => c > 5).length;
      g[0].fill(8); let has = false; has = g[0].includes(8);`);
    expect(sim.value("sum")).toBe(51);
    expect(sim.value("first")).toBe(6);
    expect(sim.value("big")).toBe(2);
    expect(sim.value("has")).toBe(true);
    expect(sim.list("g")).toEqual([8, 8, 8, 40, 5, 6]);
  });
  it("loops and methods over the rows, and a whole row assigned", () => {
    const sim = run(`let g = [[1, 2], [3, 4], [5, 6]]; let sum = 0; for (const row of g) for (const c of row) sum += c;
      let diag = 0; g.forEach((row, y) => { diag += row[y % 2]; });
      const sums = g.map((row) => row.reduce((s, c) => s + c, 0));
      let where = 0; where = g.findIndex((row) => row[0] == 5); let any = false; any = g.some((row) => row.includes(4));
      let a = 9; g[1] = [a, a + 1]; const [top, , bottom] = g; let corner = 0; corner = top[0] * 10 + bottom[1];`);
    expect(sim.value("sum")).toBe(21);
    expect(sim.value("diag")).toBe(10);
    expect(sim.list("sums")).toEqual([3, 7, 11]);
    expect(sim.value("where")).toBe(2);
    expect(sim.value("any")).toBe(true);
    expect(sim.list("g")).toEqual([1, 2, 9, 10, 5, 6]);
    expect(sim.value("corner")).toBe(16);
  });
  it("whole rows pushed to one that starts empty: the rows say how wide it is", () => {
    const sim = run("const path: number[][] = []; let x = 3; path.push([x, 4]); path.push([5, x * 2], [7, 8]); path.pop(); let n = 0; n = path.length; let last = 0; last = path[n - 1][1]; path.length = 1;");
    expect(sim.value("n")).toBe(2);
    expect(sim.value("last")).toBe(6);
    expect(sim.list("path")).toEqual([3, 4]);
  });
  it("three deep, and a grid handed to a function", () => {
    const sim = run("let cube = [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]; let z = 1; let out = 0; out = cube[z][0][1] * 10 + cube[0][1][0]; function corner(g: number[][]) { return g[1][1]; } let c = 0; c = corner(cube[z]); let g2 = [[1, 2], [3, 4]]; let d = 0; d = corner(g2) + corner(g2);");
    expect(sim.value("out")).toBe(63);
    expect(sim.value("c")).toBe(8);
    expect(sim.value("d")).toBe(8);
  });
  it("a loop whose condition reads the grid and whose body writes a row of it is a loop that ends", () => {
    const sim = run("let g = [[3, 0], [0, 0]]; let turns = 0; while (g[0][0] > 0) { const row = g[0]; row[0] -= 1; turns++; }");
    expect(sim.value("turns")).toBe(3);
  });
  it("a const grid the body stores into is the program's", () => {
    const sim = run("const g = [[0, 0], [0, 0]]; let y = 1; g[y][1] = 5;");
    expect(sim.list("g")).toEqual([0, 0, 0, 5]);
  });
  it("what it is not", () => {
    expect(messages("let g = [[1, 2], [3, 4]]; g[0].push(5);").join("\n")).toMatch(/one flat array/);
    expect(messages("let g = [[1, 2], [3]];").join("\n")).toMatch(/not all one length/);
    expect(messages("let g = [[1, 2], [3, 4]]; let v = 0; v = g[0][2];").join("\n")).toMatch(/there is no g\[0\]\[2\]/);
    expect(messages("let g: number[][] = []; g.push([1, 2]); g.push([1, 2, 3]);").join("\n")).toMatch(/not all one length/);
  });
});

describe("an array in a record", () => {
  it("fixed and growing, read through the record's name", () => {
    const sim = run("let p = { hp: 5, path: [1, 2, 3], seen: [] as number[] }; let i = 1; p.path[i] += 10; p.seen.push(p.path[1]); p.seen.push(p.hp); let n = 0; n = p.seen.length + p.path.length; let sum = 0; for (const s of p.seen) sum += s; const { path } = p; path[0] = 7;");
    expect(sim.value("n")).toBe(5);
    expect(sim.value("sum")).toBe(17);
    expect(sim.list("p.path")).toEqual([7, 12, 3]);
  });
});
