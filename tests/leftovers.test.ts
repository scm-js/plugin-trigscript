/**
 * What slice 8½ first left out and then took in: copies of arrays, a Map's keys as an array, a row variable given
 * another row, a method that returns its instance, a function that makes one, the methods that take a function on an
 * array of arrays, a spread into a call, and an array of texts. The bodies are run in JavaScript too, and compared.
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
const raw = (body: string): CompileResult => compileScript(ts, { "main.ts": `program(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string): CompileResult => { const r = raw(body); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, heapCells?: number) => { const r = compile(body); return simulatePrograms(r.ir, 1, { strings: r.strings, ...(heapCells ? { heapCells } : {}) }); };
const messages = (body: string) => raw(body).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
/** What JavaScript itself says of the same lines: the body is run as it is, `print` collecting. */
const js = (body: string): string[] => { const out: string[] = []; new Function("print", ts.transpile(body, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string, heapCells?: number) => { const sim = run(body, heapCells); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body)); };
const JOIN = "function join(xs: number[]) { let s = ''; for (const x of xs) s += `${x},`; return s; }";

describe("copies of an array", () => {
  it("slice, with places counted from the end and past either end", () => {
    same(`${JOIN} const xs = [1, 2, 3, 4, 5]; let a = 1; let b = -1; let far = 99; print(join(xs.slice(a)) + ' ' + join(xs.slice(a, b)) + ' ' + join(xs.slice(-2)) + ' ' + join(xs.slice(far)) + ' ' + join(xs.slice(0, far)) + ' ' + join(xs.slice()) + ' ' + join(xs.slice(3, 1)));`);
  });
  it("concat, toSorted and toReversed leave what they were called on as it was", () => {
    same(`${JOIN} let n = 9; const xs = [3, 1, 2]; const ys = xs.concat([n, 8], 7, xs); const zs = xs.toSorted((a, b) => a - b); const ws = xs.toReversed(); ys[0] = 0; print(join(xs) + ' ' + join(ys) + ' ' + join(zs) + ' ' + join(ws) + ' ' + join(xs.toSorted((a, b) => b - a).slice(0, 2)));`);
  });
  it("a Map's keys and values, and a Set, as arrays", () => {
    same(`${JOIN} const m = new Map<number, number>([[5, 50], [-1, 10]]); const s = new Set<number>([9, 8]); let k = 7; m.set(k, 70); m.delete(5); const ks = [...m.keys()]; const vs = Array.from(m.values()); const all = [...s, ...m.keys(), 1]; ks.push(0); print(join(ks) + ' ' + join(vs) + ' ' + join(all) + ' ' + join(Array.from(s)) + ' ' + m.size);`);
  });
});

describe("a variable that is a row", () => {
  it("is given another row of the same array, and writes through to whichever it is", () => {
    same("class Wave { constructor(public n: number, public left: number) {} hit() { this.left--; } } const waves = [new Wave(1, 5), new Wave(2, 9), new Wave(3, 7)]; let cur = waves[0]; let best = waves[0]; for (let i = 0; i < waves.length; i++) { cur = waves[i]; cur.hit(); if (cur.left > best.left) best = cur; } best.left = 0; print(`${waves[0].left} ${waves[1].left} ${waves[2].left} ${cur.n} ${best.n}`);");
  });
  it("of plain records too; a row of another array is refused", () => {
    same("let rows = [{ a: 1 }, { a: 2 }]; let r = rows[0]; let k = 1; r = rows[k]; r.a += 10; print(`${rows[0].a} ${rows[1].a}`);");
    expect(messages("let xs = [{ a: 1 }]; let ys = [{ a: 2 }]; let r = xs[0]; let k = 0; r = ys[k]; r.a = k;").join("\n")).toMatch(/can be given another row of it/);
  });
});

describe("a call that gives an instance", () => {
  const VEC = "class Vec { constructor(public x: number, public y: number) {} add(o: Vec) { this.x += o.x; this.y += o.y; return this; } scale(k: number) { this.x *= k; this.y *= k; return this; } get sum() { return this.x + this.y; } }";
  it("return this: methods in a chain, as a statement, in a declaration, as a value", () => {
    same(`${VEC} let k = 3; const v = new Vec(1, 2); const w = new Vec(10, 20); v.add(w).scale(k); const same = v.add(w); same.scale(2); v.scale(1); print(\`\${v.x} \${v.y} \${w.x} \${v.add(w).scale(2).sum}\`);`);
  });
  it("a function that makes one, and one that hands back what it was given", () => {
    same(`${VEC} function make(n: number) { return new Vec(n, n * 2); } function doubled(v: Vec) { v.scale(2); return v; } function total(v: Vec) { return v.sum; } let n = 4; const a = make(n); const b = doubled(a); b.x += 1; const c = make(n + 1).add(a); print(\`\${a.x} \${a.y} \${c.x} \${c.y} \${total(make(7))}\`);`);
  });
  it("says so when which instance comes back would only be known in the game", () => {
    expect(messages(`${VEC} function pick(a: Vec, b: Vec, first: boolean) { if (first) return a; return b; } let f = true; const p = pick(new Vec(1, 1), new Vec(2, 2), f); p.x = 0;`).join("\n")).toMatch(/has to give the same instance/);
  });
});

describe("the methods that take a function, on an array of arrays", () => {
  const ROWS = "function show(g: number[][]) { let s = ''; for (const r of g) { for (const x of r) s += `${x},`; s += '|'; } return s; }";
  it("a grid: sort by a cell, reverse, filter", () => {
    same(`${ROWS} let n = 3; let pts = [[5, 1], [2, 2], [9, 3], [n, 4]]; pts.sort((a, b) => a[0] - b[0]); const s1 = show(pts); pts.reverse(); const far = pts.filter((p) => p[0] > n); print(s1 + ' ' + show(pts) + ' ' + show(far) + ' ' + far.length);`);
  });
  it("rows that grow: sort by length, reverse, filter into rows of their own", () => {
    same(`${ROWS} let n = 7; const b: number[][] = [[1, 2, 3], [], [4, 5]]; b[1].push(n); b[1].push(8); b[1].push(9); b[1].push(10); b.sort((x, y) => x.length - y.length); const s1 = show(b); b.reverse(); const long = b.filter((r) => r.length > 2); print(s1 + ' ' + show(b) + ' ' + show(long));`, 256);
  });
  it("filter's rows are copies of their own, where JavaScript's are the same rows: said in the guide", () => {
    const sim = run("const b: number[][] = [[1, 2, 3], [4]]; const long = b.filter((r) => r.length > 2); long[0].push(99); let pts = [[5, 1], [2, 2]]; const far = pts.filter((p) => p[0] > 3); far[0][1] = 77; print(`${b[0].length} ${long[0].length} ${pts[0][1]} ${far[0][1]}`);", 256);
    expect(shown(sim)).toEqual(["3 4 1 77"]);
  });
});

describe("a spread into a call", () => {
  it("of an array of a fixed length (a tuple, which is what TypeScript asks of one), of a list the script has, into a rest of arguments", () => {
    same("function vol(a: number, b: number, c: number) { return a * b * c; } function sum(...ns: number[]) { let t = 0; for (const n of ns) t += n; return t; } const dims: [number, number, number] = [2, 3, 4]; let box: [number, number, number] = [1, 1, 1]; let k = 5; box[1] = k; box[2] = k + 1; print(`${vol(...box)} ${vol(...dims)} ${sum(1, ...box, ...dims)} ${vol(k, ...([2, 3] as [number, number]))}`);");
  });
  it("of an array that grows is refused, since the call's arguments are counted when the script is built", () => {
    expect(messages("function f(a: number, b: number) { return a + b; } const xs: number[] = []; xs.push(1); xs.push(2); let n = f(...(xs as [number, number]));").join("\n")).toMatch(/An array that grows is handed over as itself/);
  });
});

describe("an array of texts", () => {
  it("is filled, read, written, searched, joined and gone through", () => {
    same("const names: string[] = []; let n = 3; names.push('red'); names.push(`wave ${n}`, 'blue'); names[0] += '!'; names[2] = names[1] + '?'; let s = ''; for (const t of names) s += `[${t}]`; names.forEach((t, i) => { s += `${i}${t.length}`; }); const last = names.pop() ?? ''; print(`${s} ${names.length} ${last} ${names.join(', ')} ${names.indexOf('wave 3')} ${names.includes('red!') ? 1 : 0} ${names.includes('red') ? 1 : 0} ${names.join()}`);");
  });
  it("starts with what it is given, is a field of a class, is handed to a function", () => {
    same("class Log { lines: string[] = []; add(t: string) { this.lines.push(t); } } function count(xs: string[], what: string) { let c = 0; for (const x of xs) if (x == what) c++; return c; } let k = 2; const tags = ['a', `b${k}`, 'a']; const log = new Log(); log.add('x'); log.add(`y${k}`); log.add(log.lines[0]); tags[0] = 'c'; print(`${count(tags, 'a')} ${count(log.lines, 'x')} ${tags.join('')} ${log.lines.join('-')}`);");
  });
  it("gives its blocks back: popped, cut off, written over, declared again", () => {
    const r = compile("let turn = 0; let last = ''; while (turn < 80) { const lines: string[] = []; for (let i = 0; i < 6; i++) lines.push(`line ${turn} ${i}`); lines[0] = `again ${turn}`; lines[1] += '!'; lines.pop(); lines.length = 2; last = lines.join('|'); turn++; } print(last);");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 128 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["again 79|line 79 1!"]);
  });
});

describe("a function that takes or returns a text", () => {
  it("is called from its second call on, as any function is", () => {
    const body = "function tag(s: string, n: number): string { return `[${s}:${n}]`; } function shout(s: string) { s += '!'; print(s); } let k = 2; const a = tag('a', k); const b = tag(a, k + 1); const c = tag(`w${k}`, 0); shout(a); shout(c); shout('x'); print(`${a} ${b} ${c} ${tag(tag('q', 1), 2).length}`);";
    const r = compile(body);
    expect((r.ir[0].functions ?? []).map((f) => f.name).sort()).toEqual(["shout", "tag"]);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(js(body));
  });
  it("and gives its blocks back however often it is called", () => {
    const r = compile("function tag(s: string, n: number): string { return `[${s}:${n}]`; } let last = ''; let i = 0; while (i < 300) { last = tag(tag(`t${i}`, i), 1); i++; } print(last);");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 64 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["[[t299:299]:1]"]);
  });
});

describe("a function that calls itself and works with texts", () => {
  it("keeps its own text across the call, takes one and gives one back", () => {
    same("function path(n: number): string { const here = `${n}`; if (n <= 0) return here; const rest = path(n - 1); return `${here}>${rest}`; } function bars(n: number, s: string): string { if (n <= 0) return s; return bars(n - 1, s + '|'); } function count(n: number): number { let label = `c${n}`; if (n > 0) count(n - 1); return label.length; } let k = 5; print(`${path(k)} ${bars(k, '')} ${count(12)} ${path(2).length}`);");
  });
  it("gives every block back, however deep it went", () => {
    const r = compile("function path(n: number): string { const here = `${n}`; if (n <= 0) return here; const rest = path(n - 1); return `${here}>${rest}`; } let i = 0; let last = ''; while (i < 40) { last = path(i % 7); i++; } print(last);");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 96 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["4>3>2>1>0"]);
  });
  it("a loop over a text that holds such a call is refused", () => {
    expect(messages("function f(s: string, n: number): number { let t = 0; for (const ch of s) { if (n > 0) t += f(ch, n - 1); } return t; } let k = 2; k = f('ab', k);").join("\n")).toMatch(/this loop over a text holds such a call/);
  });
});

describe("the probe", () => {
  it("says in the simulator what it expects to say in the game", () => {
    const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "leftovers.ts"), "utf8") }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    // The simulator makes no units for createUnit: the three Marines of step G are there from the start, and step H's fourth never comes.
    const marines = [0, 1, 2].map((i) => ({ type: 0, owner: 0, x: 100 + i * 10, y: 100, hp: 40 }));
    const sim = new ProgramSimulation(r.ir, { strings: r.strings, units: marines, locations: { 1: { left: 0, top: 0, right: 256, bottom: 256 } } }).run(24 * 36);
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]: /.test(t));
    const checked: string[] = [];
    for (const line of lines) {
      const m = /^([A-Z]): (.*?)(?: - [^(]*)? \(expect ([^)]*)\)$/.exec(line);
      if (!m || m[1] === "H") continue;
      expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
      checked.push(m[1]);
    }
    expect(checked).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(sim.faults).toEqual([]);
    expect(sim.events.some((e) => e.text === "done")).toBe(true);
    // The functions that take and give texts are called, the one that calls itself among them.
    expect((r.ir[0].functions ?? []).map((f) => f.name)).toEqual(expect.arrayContaining(["tag", "path", "bars", "kept"]));
  });
});
