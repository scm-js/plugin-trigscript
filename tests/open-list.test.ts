/**
 * The Open list's bugs of 2026-10-23 (docs/v4-plan.md, "The ledger" → *Open*), taken: false compile errors, gaps against
 * JavaScript, silent drops, and two cells of the deaths table the game reads as player groups. The bodies that can run
 * are run in JavaScript too, and compared.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames, scriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import type { Stmt } from "../compiler/ir";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, head = "", async = false): CompileResult => compileScript(ts, { "main.ts": `${head}\nprogram(${async ? "async " : ""}() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, head = "", async = false): CompileResult => { const r = raw(body, head, async); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, head = "", async = false, cycles = 3) => { const r = compile(body, head, async); return simulatePrograms(r.ir, cycles, { strings: r.strings }); };
const messages = (body: string, head = "", async = false) => raw(body, head, async).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
/** What JavaScript itself says of the same lines: the body is run as it is, `displayText` collecting. */
const js = (body: string, head = ""): string[] => { const out: string[] = []; new Function("displayText", ts.transpile(`${head}\n${body}`, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string, head = "") => { const sim = run(body, head); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body, head)); };
/** Every statement of a program, the nested ones too. */
function* statements(body: Stmt[]): Generator<Stmt> {
  for (const s of body) {
    yield s;
    for (const v of Object.values(s as unknown as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "kind" in v[0]) yield* statements(v as Stmt[]);
    }
  }
}

describe("false compile errors, no longer", () => {
  it("n++ as an array's index in a loop moves the loop on", () => {
    same("const xs = [0, 0, 0, 0]; let n = 0; while (n < 4) { xs[n++] = n * 10; } displayText(`${xs[0]} ${xs[3]} ${n}`);");
  });
  it("a comparison as a boolean argument", () => {
    same("function step(n: number, early: boolean) { return early ? n + 1 : n; } let turns = 1; let n = 5; n = step(n, turns < 2); n = step(n, turns > 2); displayText(`${n}`);");
  });
  it("a switch on a text known when the script is built takes its case now", () => {
    same("const MODE: string = 'fast'; let n = 0; switch (MODE) { case 'slow': n = 2; break; case 'fast': n = 1; break; default: n = 9; } displayText(`${n}`);");
    same("const MODE: string = 'odd'; let n = 0; switch (MODE) { case 'slow': n = 2; break; default: n = 9; } displayText(`${n}`);");
    // (No text is compared in the game.)
    const r = compile("const MODE: string = 'fast'; let n = 0; switch (MODE) { case 'fast': n = 1; break; } displayText(`${n}`);");
    expect(JSON.stringify(r.ir[0].body)).not.toContain("textCompare");
  });
  it("an arrow inside a method reads the instance's fields through this", () => {
    same("class M { x = 1; f() { const g = () => this.x + 1; return g() + this.x; } } const m = new M(); m.x = 5; displayText(`${m.f()}`);");
  });
  it("a field read straight off new", () => {
    same("class P { constructor(public x: number, public y: number) {} get sum() { return this.x + this.y; } } let k = 4; let n = 0; n = new P(k, 2).x + new P(1, 1).sum; displayText(`${n}`);");
  });
  it("sleep(…).then(() => 7) as a value", () => {
    const sim = run("let n = 0; n = await sleep(frames(1)).then(() => 7); displayText(`${n}`);", "", true);
    expect(shown(sim)).toEqual(["7"]);
  });
  it("a unit's field through ?. with ?? for when there is none, and a pick's method through ?.", () => {
    expect(messages("const u = first({ owner: P1 }); let hp = 0; hp = u?.hp ?? 0; displayText(`${hp}`);")).toEqual([]);
    expect(messages("first({ owner: P1 })?.order('move', locations.Anywhere); first(unitsAt(locations.Anywhere, { owner: P2 }))?.kill();")).toEqual([]);
  });
  it("rows[i].pop() ?? -1 of an array of arrays", () => {
    same("const rows = [[1, 2], [3]]; let i = 1; let a = 0; let b = 0; a = rows[i].pop() ?? -1; b = rows[i].pop() ?? -1; displayText(`${a} ${b}`);");
  });
  it("a condition kept in a const with && is asked where the const is tested", () => {
    const r = compile("const both = command(P1, units.TerranMarine, '>=', 1) && bring(P1, units.TerranMarine, locations.Anywhere, '>=', 1); if (both) displayText('x');");
    const test = [...statements(r.ir[0].body)].find((s) => s.kind === "if") as Extract<Stmt, { kind: "if" }>;
    expect(test.cond.kind).toBe("and");
    expect((test.cond as Extract<typeof test.cond, { kind: "and" }>).items.map((c) => (c as { kind: string; record?: { type: number } }).record?.type)).toEqual([2, 3]);
  });
});

describe("the program ends at a return of its own", () => {
  it("nothing after it runs, in a program and in an async one", () => {
    expect(shown(run("let n = 1; displayText('a'); if (n > 0) return; displayText('b');"))).toEqual(["a"]);
    expect(shown(run("displayText('a'); await sleep(frames(1)); return; displayText('b');", "", true))).toEqual(["a"]);
    expect(messages("let n = 1; return n;").join("\n")).toMatch(/gives nothing back/);
  });
});

describe("against JavaScript, in a program", () => {
  it("~a, a ** n, Math.pow, Math.sign, Math.log2", () => {
    same("let a = 5; let b = 0; b = ~a; displayText(`${b} ${~0} ${~-1}`);");
    same("let a = 3; let b = 0; b = a ** 2; let c = a ** 0; displayText(`${b} ${c} ${Math.pow(a, 3)} ${(a + 1) ** 2}`);");
    same("let a = -3; let b = 7; let c = 0; displayText(`${Math.sign(a)} ${Math.sign(b)} ${Math.sign(c)}`);");
    same("let a = 1024; let b = 1000; let c = 1; let d: u32 = 4294967295; let e = 2147483647; displayText(`${Math.floor(Math.log2(a))} ${Math.floor(Math.log2(b))} ${Math.floor(Math.log2(c))} ${Math.floor(Math.log2(d))} ${Math.floor(Math.log2(e))}`);");
    expect(messages("let a = 3; let n = 2; let b = 0; b = a ** n;").join("\n")).toMatch(/known when the script is built/);
  });
  it("fill(value, start, end), counted from the end when negative and cut to the array", () => {
    same("const xs = [1, 2, 3, 4, 5]; let v = 9; let s = 1; let e = 3; xs.fill(v, s, e); displayText(`${xs[0]} ${xs[1]} ${xs[2]} ${xs[3]} ${xs[4]}`);");
    same("const xs = [1, 2, 3, 4, 5]; let v = 9; xs.fill(v, -2); displayText(`${xs[2]} ${xs[3]} ${xs[4]}`); xs.fill(0, 1, 99); displayText(`${xs[0]} ${xs[1]} ${xs[4]}`); xs.fill(7, 4, 2); displayText(`${xs[2]} ${xs[3]}`);");
  });
  it("an error a build-time call throws inside a try is the program's, which the catch takes", () => {
    // (`check` outside the program: worked out when the script is built, where it throws.)
    const CHECK = "function check(n: number) { if (n > 5) throw new RangeError('too big: ' + n); return n; }";
    same("let total = 0; let m = 0; try { total += check(9); } catch (e) { total = -1; m = e instanceof RangeError ? 1 : 2; } displayText(`${total} ${m}`);", CHECK);
    // (Outside a try it is still the script's own mistake, said as such.)
    expect(messages("let total = 0; total += check(9);", CHECK).join("\n")).toMatch(/too big: 9/);
  });
});

describe("a trigger's words inside a program", () => {
  it("disabled() is refused, on a condition and on an action", () => {
    expect(messages("if (disabled(bring(P1, units.TerranMarine, locations.Anywhere, '>=', 1))) displayText('x');").join("\n")).toMatch(/disabled\(\) switches a condition/);
    expect(messages("disabled(displayText('x'));").join("\n")).toMatch(/disabled\(\) switches an action/);
  });
  it("preserve() is a remark, and nothing emitted", () => {
    const r = compile("preserve(); preserveTrigger(); displayText('x');");
    const remarks = [...statements(r.ir[0].body)].filter((s) => s.kind === "remark");
    expect(remarks.length).toBe(2);
    expect(r.ir[0].body.filter((s) => s.kind === "action").length).toBe(1);
  });
});

describe("the deaths table's cells 12 to 26", () => {
  it("memory() and setMemory() of one name it as the deaths of player e mod 12 of unit e div 12, which the game reads as the cell", () => {
    const r = compile("if (memory(0x58A364 + 4 * 17, '>=', 1)) displayText('a'); setMemory(0x58A364 + 4 * 13, 'set', 1); if (memory(0x58A364 + 4 * 26, '>=', 1)) displayText('b'); setMemory(0x58A364 + 4 * 27, 'set', 1); if (memory(0x58A364 + 4 * 11, '>=', 1)) displayText('c');");
    const body = [...statements(r.ir[0].body)];
    const records = JSON.stringify(body).match(/"record":\{[^}]*\}/g)!.map((m) => JSON.parse(`{${m}}`).record as { player: number; unitId: number; type: number }).filter((x) => x.type === 15 || x.type === 45);
    expect(records.map((x) => [x.player, x.unitId])).toEqual([[5, 1], [1, 1], [2, 2], [27, 0], [11, 0]]);
  });
});

describe("the standard library's examples", () => {
  it("the cutscene module's header example compiles as written", () => {
    const text = readFileSync(resolve(__dirname, "../stdlib/cutscene.ts"), "utf8");
    const header = text.slice(0, text.indexOf("*/")).split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim());
    const from = header.findIndex((l) => l.startsWith("import "));
    const to = header.findIndex((l, i) => i > from && l === "});");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const example = header.slice(from, to + 1).join("\n");
    // (On a map with a location named Base, as the example has it.)
    const r = compileScript(ts, { "main.ts": example }, scriptNames({ locations: [{ index: 0, name: "Base" }] }), { lib: LIB });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  });
});
