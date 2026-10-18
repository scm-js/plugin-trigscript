/**
 * TrigScript 4, B9: records and instances as values, and a number or nothing. A `let` record, or an instance of a class
 * nothing changes in place, given whole is a copy of its fields; `number | undefined` is the value and a flag beside
 * it. The bodies are run in JavaScript too, and compared.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, top = ""): CompileResult => compileScript(ts, { "main.ts": `${top}\nprogram(async () => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, top = ""): CompileResult => { const r = raw(body, top); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, top = "") => { const r = compile(body, top); return simulatePrograms(r.ir, 1, { strings: r.strings }); };
const messages = (body: string, top = "") => raw(body, top).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
const js = (body: string, top = ""): string[] => { const out: string[] = []; new Function("print", ts.transpile(`${top}\n${body}`, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string, top = "") => { const sim = run(body, top); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body, top)); };

const VEC = "class V { constructor(public x: number, public y: number) {} add(o: V) { return new V(this.x + o.x, this.y + o.y); } scale(k: number) { return new V(this.x * k, this.y * k); } }";

describe("a record given whole", () => {
  it("from a record written out, which may read its own fields", () => {
    same("let k = 3; let r = { x: 1, y: 2 }; r = { x: r.y, y: r.x + k }; print(`${r.x} ${r.y}`);");
  });
  it("one or the other: c ? a : b, declared and given", () => {
    same("let k = 3; const r = k > 2 ? { a: 1, s: 'big' } : { a: 2, s: 'small' }; let q = { a: 0, s: '' }; q = k > 5 ? r : { a: 9, s: 'nine' }; print(`${r.a} ${r.s} ${q.a} ${q.s}`);");
  });
  it("a field that is a record, given whole in a method", () => {
    same("class B { pos = { x: 0, y: 0 }; move(dx: number) { this.pos = { x: this.pos.x + dx, y: this.pos.y }; } } let k = 4; const b = new B(); b.move(k); b.move(1); print(`${b.pos.x} ${b.pos.y}`);");
  });
  it("another name for one given whole is a copy, as long as no field of either is written", () => {
    same("let k = 1; let p = { x: k }; const q = p; p = { x: 9 }; print(`${p.x} ${q.x}`);");
  });
  it("and is said when a field is written", () => {
    expect(messages("let k = 1; let p = { x: k }; const q = p; q.x = 5; p = { x: 9 }; print(`${p.x} ${q.x}`);").join("\n")).toMatch(/would not stay one record/);
  });
});

describe("an instance of a class nothing changes in place, given whole", () => {
  it("p = p.add(q), p = p.scale(k): copies, the class's fields variables still", () => {
    const body = `${VEC} let k = 2; let p = new V(1, 2); p = p.add(new V(1, 1)); p = p.scale(k); print(\`\${p.x} \${p.y}\`);`;
    same(body);
    expect(compile(body).ir.flatMap((p) => p.arrays).some((a) => a.name.startsWith("(objects)"))).toBe(false);
  });
  it("in a loop, with another name taken before", () => {
    same(`${VEC} let n = 3; let p = new V(0, 1); const first = p; while (n > 0) { p = p.add(new V(n, 0)); n--; } print(\`\${p.x} \${first.x}\`);`);
  });
  it("trigscript/math's Vec", () => {
    const sim = run("let v = new Vec(1, 0); let i = 0; while (i < 4) { v = v.rotate(Math.PI / 2); i++; } print(`${Math.round(v.x)} ${Math.round(v.y)}`);", `import { Vec } from "trigscript/math";`);
    expect(shown(sim)).toEqual(["1 0"]);
  });
  it("a class changed in place goes by reference instead", () => {
    const body = "class M { x = 0; constructor(x: number) { this.x = x; } bump() { this.x++; } } let k = 1; let p = new M(k); const q = p; p.bump(); p = new M(5); p.bump(); print(`${p.x} ${q.x}`);";
    same(body);
    expect(compile(body).ir.flatMap((p) => p.arrays).some((a) => a.name.startsWith("(objects)"))).toBe(true);
  });
});

describe("a number or nothing", () => {
  it("the largest so far, undefined until there is one", () => {
    same("const xs = [5, 9, 4]; let best: number | undefined = undefined; for (const x of xs) if (best === undefined || x > best) best = x; print(`${best ?? -1}`);");
  });
  it("find() gives one", () => {
    same("const xs = [3, 8, 12]; let k = 5; const f = xs.find((x) => x > k); const g = xs.find((x) => x > 100); print(`${f ?? -1} ${g ?? -1} ${f !== undefined ? 1 : 0} ${g === undefined ? 1 : 0}`);");
  });
  it("so does a Map's get()", () => {
    same("const m = new Map<number, number>(); let k = 4; m.set(k, 40); const a = m.get(4); const b = m.get(5); print(`${a ?? -1} ${b ?? -1}`);");
  });
  it("narrowed, it is a number; !, too", () => {
    same("let k = 3; let n: number | undefined = k > 2 ? k * 2 : undefined; if (n !== undefined) print(`${n + 1} ${n! * 2}`); n = undefined; print(`${n ?? 0}`);");
  });
  it("tested as itself: there, and not 0", () => {
    same("let k = 0; let n: number | undefined = k; let s = ''; if (n) s += 'a'; n = 5; if (n) s += 'b'; n = undefined; if (!n) s += 'c'; print(s);");
  });
  it("against a value: there, and that", () => {
    same("let k = 3; let n: number | undefined = k; let m: number | undefined = undefined; print(`${n === 3 ? 1 : 0}${n === 4 ? 1 : 0}${n === m ? 1 : 0}`); n = undefined; print(`${n === 3 ? 1 : 0}${n === m ? 1 : 0}`);");
  });
  it("a field of a class, and of a row; left out of a record written out", () => {
    same("class T { cooldown?: number; tick() { if (this.cooldown !== undefined) { this.cooldown--; if (this.cooldown <= 0) this.cooldown = undefined; } } } let k = 2; const t = new T(); t.cooldown = k; t.tick(); const a = t.cooldown ?? -1; t.tick(); print(`${a} ${t.cooldown ?? -1}`);");
    same("interface P { x: number; tag?: number } let k = 2; const ps: P[] = []; ps.push({ x: 1 }); ps.push({ x: 2, tag: k }); let s = 0; for (const p of ps) s = s * 10 + (p.tag ?? 9); print(`${s}`);");
  });
  it("read where it may be nothing is said", () => {
    expect(messages("let k = 3; let n: number | undefined = k > 2 ? k : undefined; const m = (n as number | undefined) as number | undefined; print(`${(m as number | undefined)}`);").join("\n")).toMatch(/may be undefined here/);
  });
});
