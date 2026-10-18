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
    expect(messages("let g = [[1, 2], [3, 4]]; let v = 0; v = g[0][2];").join("\n")).toMatch(/there is no g\[0\]\[2\]/);
    expect(messages("let g = [[1, 2], [3, 4]]; function more(xs: number[]) { xs.push(1); } more(g[0]);").join("\n")).toMatch(/one flat array/);
  });
});

describe("the end of the line says how it is kept", () => {
  it("flat, or rows that grow", () => {
    const hints = (body: string) => compile(body).hints.map((h) => h.label);
    expect(hints("let g = [[1, 2, 3], [4, 5, 6]];")).toContain("flat, 2 × 3");
    expect(hints("const path: number[][] = []; path.push([1, 2]);")).toContain("flat, rows × 2");
    expect(hints("let b = [[1, 2], [3]];")).toContain("rows that grow");
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

describe("arrays that grow, inside an array", () => {
  it("rows of different lengths, read, stored, pushed to and popped, each its own", () => {
    const sim = run("let b = [[1, 2], [], [3]]; let i = 1; b[i].push(7); b[i].push(8); b[0][1] += 10; b[2].pop(); let out = 0; out = b[0][1] * 100 + b[i][1] * 10 + b[2].length; let n = 0; n = b.length; let past = 5; past = b[2][0];");
    expect(sim.value("out")).toBe(1280);
    expect(sim.value("n")).toBe(3);
    expect(sim.value("past")).toBe(0);
  });
  it("a grid something pushes a cell to is rows that grow", () => {
    const sim = run("let g = [[1, 2], [3, 4]]; g[0].push(5); let a = 0; let b = 0; a = g[0].length; b = g[1].length;");
    expect(sim.value("a")).toBe(3);
    expect(sim.value("b")).toBe(2);
  });
  it("the outer one grows too: rows pushed, written out, empty, or copied from an array; popped rows give their blocks back", () => {
    const sim = run(`const b: number[][] = []; let xs = [4, 5, 6]; b.push([1], [], xs); b[1].push(9); xs[0] = 40;
      let sum = 0; for (const row of b) for (const c of row) sum += c;
      b.pop(); b.pop(); let n = 0; n = b.length; b.push([2, 2]); let last = 0; last = b[1].length;`);
    expect(sim.value("sum")).toBe(25);
    expect(sim.value("n")).toBe(1);
    expect(sim.value("last")).toBe(2);
    expect(sim.faults).toEqual([]);
  });
  it("the heap gets every block back: declared again in a loop, cut off, a row assigned", () => {
    const r = compile("let turns = 0; while (turns < 200) { const b: number[][] = [[], []]; b[0].push(turns); b[0].push(1); b[0].push(2); b[0].push(3); b[0].push(4); b[1].push(turns); b.push([1, 2, 3, 4, 5]); b[1] = [7, 7, 7, 7, 7]; b.length = 1; turns++; }");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 1024 });
    expect(sim.value("turns")).toBe(200);
    expect(sim.faults).toEqual([]);
  });
  it("a row is an array: kept, given to a function and to a method, taken out of a pattern", () => {
    const sim = run(`let b = [[3, 1, 2], [9]]; let i = 0; const row = b[i]; i = 1; row.sort((x, y) => x - y); row.push(4);
      function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }
      let both = 0; both = total(b[0]) * 10 + total(b[1]);
      const sizes = b.map((r) => r.length); let where = 0; where = b.findIndex((r) => r.includes(9));
      const [first, second] = b; second.push(first[0]); let s = 0; s = b[1][1];`);
    expect(sim.value("both")).toBe(109);
    expect(sim.list("sizes")).toEqual([4, 1]);
    expect(sim.value("where")).toBe(1);
    expect(sim.value("s")).toBe(1);
  });
  it("in a record, under the record's name", () => {
    const sim = run("let p = { hp: 5, lanes: [[1], [2, 3]] }; p.lanes[0].push(p.hp); let n = 0; n = p.lanes[0].length * 10 + p.lanes[1][1];");
    expect(sim.value("n")).toBe(23);
  });
  it("a row kept in a const is that place in the outer array: popped it reads nothing, and a row pushed there is what it is next", () => {
    const sim = run("const b: number[][] = []; b.push([1, 2]); b.push([3]); const kept = b[1]; b.pop(); let gone = 5; gone = kept.length; b.push([8, 9, 10]); let back = 0; back = kept.length * 10 + kept[0];");
    expect(sim.value("gone")).toBe(0);
    expect(sim.value("back")).toBe(38);
  });
});
