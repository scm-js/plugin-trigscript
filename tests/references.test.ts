/**
 * TrigScript 4, B9: references. A class the program needs to keep by reference — a variable or a field that may be
 * none, an array or a variable of a type more than one class fits, a variable given another instance, an array of
 * instances inside an instance, a Map of them — has its instances in the object table: rows of the closures' pool, a
 * column a field, the row's class in the pool's function column. A reference is the row; a method called through one
 * that could be of several classes asks the row's class. The bodies are run in JavaScript too, and compared.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";
import type { Program } from "../compiler/ir";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, top = ""): CompileResult => compileScript(ts, { "main.ts": `${top}\nprogram(async () => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, top = ""): CompileResult => { const r = raw(body, top); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, frames = 1, top = "") => { const r = compile(body, top); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
/** What JavaScript itself says of the same lines: the body is run as it is, `print` collecting. */
const js = (body: string, top = ""): string[] => { const out: string[] = []; new Function("print", ts.transpile(`${top}\n${body}`, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string, top = "") => { const sim = run(body, 1, top); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body, top)); };
/** The arrays of a program whose name says they are the object table's columns. */
const columns = (ir: Program[]) => ir.flatMap((p) => p.arrays).filter((a) => a.name.startsWith("(objects)")).map((a) => a.name);

const NODE = "class Node { next: Node | null = null; constructor(public v: number) {} }";

describe("a reference that may be none", () => {
  it("a linked list: made, linked, walked", () => {
    same(`${NODE} let n = 3; let head: Node | null = null; while (n > 0) { const x = new Node(n); x.next = head; head = x; n--; } let s = ""; let c = head; while (c) { s += c.v; c = c.next; } print(s);`);
  });
  it("?. and ?? through none, and == null", () => {
    same(`${NODE} let a = null as Node | null; let k = 7; print(\`\${a?.v ?? -1} \${a === null ? 1 : 0}\`); a = new Node(k); print(\`\${a?.v ?? -1} \${a !== null ? 1 : 0} \${a.next == null ? 1 : 0}\`);`);
  });
  it("a field of none reads 0, and a write to one does nothing", () => {
    const sim = run(`${NODE} let a: Node | null = null; let b = new Node(4); let n = 9; if (n > 100) a = b; const v = a?.v ?? 0; print(\`\${v}\`);`);
    expect(shown(sim)).toEqual(["0"]);
  });
  it("x?.m() calls nothing when there is none", () => {
    same("class C { n = 1; bump() { this.n++; return this.n; } } let c = null as C | null; let k = 0; const got = c?.bump() ?? -1; c = new C(); c?.bump(); print(`${got} ${c.n}`);");
  });
});

describe("a reference to one of several classes", () => {
  it("an array of an interface: each its own method", () => {
    same("interface Shape { area(): number } class Sq implements Shape { constructor(public s: number) {} area() { return this.s * this.s; } } class Rect implements Shape { constructor(public w: number, public h: number) {} area() { return this.w * this.h; } } let k = 2; const shapes: Shape[] = [new Sq(k), new Rect(k, 5)]; shapes.push(new Sq(3)); let t = 0; for (const s of shapes) t += s.area(); print(`${t}`);");
  });
  it("an abstract class: overridden methods, super, a shared method, instanceof", () => {
    same("abstract class E { hp = 10; abstract name(): number; hit(n: number) { this.hp -= n; } alive() { return this.hp > 0; } } class Grunt extends E { name() { return 1; } } class Boss extends E { armor = 3; name() { return 2; } hit(n: number) { super.hit(Math.max(0, n - this.armor)); } } let d = 5; const es: E[] = [new Grunt(), new Boss(), new Grunt()]; for (const e of es) e.hit(d); let s = ''; for (const e of es) s += `${e.name()}:${e.hp}:${e instanceof Boss ? 'B' : 'g'} `; print(s);");
  });
  it("a variable given an instance of another class", () => {
    same("class A { f() { return 1; } } class B extends A { f() { return 2; } } let n = 3; let x: A = new A(); let s = 0; while (n > 0) { s = s * 10 + x.f(); x = n % 2 === 1 ? new B() : new A(); n--; } print(`${s}`);");
  });
  it("a getter and a setter of each class", () => {
    same("abstract class T { protected raw = 0; abstract get v(): number; abstract set v(n: number); } class Twice extends T { get v() { return this.raw * 2; } set v(n: number) { this.raw = n; } } class Plus extends T { get v() { return this.raw + 1; } set v(n: number) { this.raw = n + 10; } } let k = 3; const ts2: T[] = [new Twice(), new Plus()]; for (const t of ts2) t.v = k; print(`${ts2[0].v} ${ts2[1].v}`);");
  });
});

describe("what references are kept in", () => {
  it("an array of instances inside an instance", () => {
    same("class Soldier { hp = 10; } class Squad { members: Soldier[] = []; add(s: Soldier) { this.members.push(s); } total() { let t = 0; for (const m of this.members) t += m.hp; return t; } } let k = 3; const sq = new Squad(); sq.add(new Soldier()); sq.add(new Soldier()); sq.members[1].hp = k; print(`${sq.members.length} ${sq.total()}`);");
  });
  it("a Map's values and a Set's keys", () => {
    same("class P { constructor(public x: number) {} } let k = 9; const m = new Map<number, P>(); const a = new P(k); m.set(1, a); m.set(2, new P(2)); const s = new Set<P>(); s.add(a); s.add(a); s.add(new P(1)); print(`${m.get(1)?.x ?? -1} ${m.get(3)?.x ?? -1} ${s.size} ${s.has(a) ? 1 : 0}`);");
  });
  it("two names for one instance, one given another: the other keeps the first", () => {
    same("class P { x = 0; constructor(x: number) { this.x = x; } } let k = 1; let p = new P(k); const q = p; p = new P(2); q.x += 10; print(`${p.x} ${q.x} ${p === q ? 1 : 0}`);");
  });
  it("a tree: a method that calls itself on other rows is one called function", () => {
    const body = "class T { left: T | null = null; right: T | null = null; constructor(public v: number) {} sum(): number { return this.v + (this.left ? this.left.sum() : 0) + (this.right ? this.right.sum() : 0); } } let k = 4; const r = new T(1); r.left = new T(2); r.right = new T(3); r.left.left = new T(k); print(`${r.sum()}`);";
    same(body);
    expect(compile(body).ir[0].functions?.some((f) => f.name === "T.sum" && f.recursive)).toBe(true);
  });
  it("a class at the top of a file", () => {
    same("let k = 5; let a: Node | null = new Node(k); a.next = new Node(6); print(`${a.next.v}`);", NODE);
  });
});

describe("the object table", () => {
  it("one column for a field of the same name and kind, whatever class", () => {
    const r = compile("class A { hp = 1; a = 0; } class B { hp = 2; b = 0; } let k = 0; const xs: (A | B)[] = [new A(), new B()]; print(`${xs[k].hp}`);");
    expect(columns(r.ir).sort()).toEqual(["(objects) a", "(objects) b", "(objects) hp"]);
  });
  it("a class that needs nothing of it stays its fields' variables", () => {
    const r = compile("class P { x = 1; } let k = 2; const p = new P(); p.x = k; print(`${p.x}`);");
    expect(columns(r.ir)).toEqual([]);
  });
  it("two kinds for one field name are said", () => {
    const r = raw("class A { v = 1; } class B { v = 'x'; } const xs: (A | B)[] = [new A(), new B()]; print(`${xs.length}`);");
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/both have a field v, of two kinds/);
  });
});

describe("lifetime", () => {
  it("rows nothing holds are given back at the next wait, and made again", () => {
    // 1 200 made over four frames through a pool of 1 023: only the last 300 are held.
    const sim = run("class B { next: B | null = null; constructor(public x: number) {} } let head: B | null = null; for (let f = 0; f < 4; f++) { let i = 0; head = null; while (i < 300) { const b = new B(i); b.next = head; head = b; i++; } await sleep(frames(1)); } let n = 0; let c = head; while (c) { n++; c = c.next; } print(`${n}`);", 8);
    expect(shown(sim)).toEqual(["300"]);
  });
  it("an array of references emptied gives its rows back", () => {
    const sim = run("class B { constructor(public x: number) {} } const live: (B | null)[] = []; for (let f = 0; f < 5; f++) { live.length = 0; let i = 0; while (i < 300) { live.push(new B(i)); i++; } await sleep(frames(1)); } print(`${live.length} ${live[299]?.x ?? -1}`);", 8);
    expect(shown(sim)).toEqual(["300 299"]);
  });
  it("a row given back is empty when it is made again", () => {
    const sim = run("class B { x = 0; declare y: number; next: B | null = null; } let a: B | null = new B(); a.x = 5; a.y = 6; a.next = new B(); await sleep(frames(1)); a = null; await sleep(frames(1)); await sleep(frames(1)); const b = new B(); print(`${b.x} ${b.y} ${b.next === null ? 1 : 0}`);", 6);
    expect(shown(sim)).toEqual(["0 0 1"]);
  });
});
