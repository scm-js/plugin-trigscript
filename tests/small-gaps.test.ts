/**
 * The small refusals of the second sweep (2026-10-18), and its one fault: each written as a map maker would, over values
 * of the program, and run in the simulator.
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
const messages = (body: string, top = "") => raw(body, top).diagnostics.map((d) => d.message);
const run = (body: string, top = "") => { const r = raw(body, top); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return simulatePrograms(r.ir, 1, { strings: r.strings }); };
const shown = (body: string, top = "") => run(body, top).events.filter((e) => e.text).map((e) => e.text);

describe("a function that makes an instance whose fields the game gives", () => {
  it("runs in the game, not when the script is built", () => {
    const top = "class E { hp = random(5) + 10; }\nfunction mk() { return new E(); }";
    expect(messages("const e = mk(); print(`${e.hp > 9 ? 1 : 0}`);", top)).toEqual([]);
  });
  it("through a constructor, a base class, or a method", () => {
    const top = "class B { seed: number; constructor() { this.seed = random(3); } }\nclass E extends B { hp = 1; }\nfunction mk() { return new E(); }\nclass D { roll() { return random(6); } }\nfunction twice() { const d = new D(); return d.roll() + d.roll(); }";
    expect(messages("const e = mk(); print(`${e.seed < 3 ? 1 : 0} ${twice() < 11 ? 1 : 0}`);", top)).toEqual([]);
  });
});

describe("labelled break and continue", () => {
  it("break out of two loops, continue the outer one", () => {
    const body = "let n = 4; let found = -1; outer: for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { if (i * j === 6) { found = i * 10 + j; break outer; } } }\n" +
      "let s = 0; rows: for (let y = 0; y < n; y++) { let x = 0; while (x < n) { x++; if (x === 2) continue rows; s += 100; } s += 1; }\nprint(`${found} ${s}`);";
    expect(shown(body)).toEqual(["23 400"]);
  });
  it("through a switch, an unrolled loop and a while, and a break of the loop it is in", () => {
    const body = "let hits = 0; let k = 3; scan: while (true) { k--; for (let i = 0; i < 3; i++) { switch (i) { case 1: if (k === 0) break scan; continue scan; default: hits++; } } }\n" +
      "let m = 0; a: for (let i = 0; i < 5; i++) { if (i === 3) break a; m += i; }\nprint(`${hits} ${k} ${m}`);";
    expect(shown(body)).toEqual(["3 0 3"]);
  });
  it("through a try's finally", () => {
    const body = "let log = 0; out: for (let i = 0; i < 3; i++) { let j = 0; while (j < 3) { try { j++; if (j === 2) continue out; if (i === 2) break out; } finally { log++; } } }\nprint(`${log}`);";
    expect(shown(body)).toEqual(["5"]);
  });
  it("a label must name a loop", () => {
    expect(messages("let x = 1; blk: { if (x) break blk; }")[0]).toMatch(/^A label names a loop/);
  });
});

describe("rest parameters", () => {
  it("in a function of the script's and a game() function", () => {
    const top = "function sum(...xs: number[]) { return xs.reduce((a, b) => a + b, 0); }\nconst most = game((first: number, ...rest: number[]) => { let m = first; for (const r of rest) if (r > m) m = r; return m; });";
    expect(shown("let k = 5; print(`${sum(1, k, 3)} ${sum()} ${most(2, k, 4)} ${most(k)}`);", top)).toEqual(["9 0 5 5"]);
  });
});

describe("a function that gives back an array", () => {
  const top = "function evens(n: number) { const a: number[] = []; for (let i = 0; i < n; i++) a.push(i * 2); return a; }\n" +
    "function pair(x: number) { return [x, x + 1]; }\nfunction same(xs: number[]) { xs.push(9); return xs; }\n" +
    "class Bag { items: number[] = []; add(n: number) { this.items.push(n); return this; } take() { const out: number[] = []; for (const i of this.items) if (i > 1) out.push(i); return out; } }";
  it("one it made, one written out, one it was handed, a method's", () => {
    expect(shown("let k = 4; const xs = evens(k); print(`${xs.length} ${xs[3]}`); for (const x of evens(2)) print(`${x}`); print(`${evens(3).length} ${pair(k)[1]}`);\n" +
      "const mine = [1]; const back = same(mine); print(`${mine.length} ${back.length}`); const b = new Bag(); b.add(1).add(k); print(`${b.take().length}`);", top)).toEqual(["4 6", "0", "2", "3 5", "2 2", "1"]);
  });
  it("in a loop, made again each turn", () => {
    expect(shown("let total = 0; for (let r = 0; r < 4; r++) { const xs = evens(r); total += xs.length; } print(`${total}`);", top)).toEqual(["6"]);
  });
  it("of records", () => {
    expect(shown("let k = 3; const ps = spots(k); print(`${ps.length} ${ps[2].x}`);", "function spots(n: number) { const ps: { x: number; y: number }[] = []; for (let i = 0; i < n; i++) ps.push({ x: i * 10, y: 0 }); return ps; }")).toEqual(["3 20"]);
  });
});

describe("functions in a namespace, and with overloads", () => {
  it("run in the game with the program's values", () => {
    const top = "namespace Geo { export const k = 3; export function scale(x: number) { return x * k; } export namespace Deep { export function neg(x: number) { return -x; } } }\n" +
      "function f(x: number): number; function f(x: string): string; function f(x: any) { return x; }";
    expect(shown("let n = 2; print(`${Geo.scale(n)} ${Geo.Deep.neg(n)} ${f(n)} ${f('t')}`);", top)).toEqual(["6 -2 2 t"]);
  });
  it("a class and a const arrow of a namespace", () => {
    const top = "namespace Geo { export class P { constructor(public x: number) {} twice() { return this.x * 2; } } export const mk = (n: number) => n + 1; }";
    expect(shown("let n = 2; const p = new Geo.P(n); print(`${p.twice()} ${Geo.mk(n)}`);", top)).toEqual(["4 3"]);
  });
});

describe("find() of an array of instances or records", () => {
  const top = "class E { constructor(public hp: number) {} hit() { this.hp--; } }";
  it("the row found, changed through it, or none", () => {
    expect(shown("let k = 3; const es = [new E(1), new E(k), new E(5)];\n" +
      "const t = es.find((e) => e.hp > 2); print(`${t ? t.hp : -1} ${t?.hp ?? -1}`); if (t) t.hit(); print(`${es[1].hp}`);\n" +
      "const none = es.find((e) => e.hp > 9); print(`${none ? 1 : 0} ${none === undefined ? 'u' : 'd'} ${none?.hp ?? -7}`); if (none !== undefined) print('bad');\n" +
      "const last = es.findLast((e) => e.hp > 0); print(`${last ? last.hp : -1}`);", top)).toEqual(["3 3", "2", "0 u -7", "5"]);
  });
  it("of records", () => {
    expect(shown("let k = 2; const ps = [{ x: 1, y: 0 }, { x: k, y: 7 }]; const p = ps.find((q) => q.x === 2); print(`${p?.y ?? -1}`);")).toEqual(["7"]);
  });
});

describe("a Map or a Set keyed by texts of a union", () => {
  it("set, get, has, size and for…of, the keys in the union's order", () => {
    const top = 'type Team = "red" | "blue" | "green";';
    expect(shown("let k = 1; const pick: Team = k ? 'blue' : 'red';\n" +
      "const score = new Map<Team, number>(); score.set('green', 2); score.set(pick, 5); score.set(pick, (score.get(pick) ?? 0) + 1);\n" +
      "print(`${score.get('blue') ?? -1} ${score.get('red') ?? -1} ${score.size} ${score.has(pick) ? 1 : 0}`); for (const [t, v] of score) print(`${t}=${v}`);\n" +
      "const seen = new Set<Team>(); seen.add(pick); seen.add(pick); print(`${seen.size}`); for (const t of seen) print(t);", top)).toEqual(["6 -1 2 1", "blue=6", "green=2", "1", "blue"]);
  });
  it("any text is still refused", () => {
    expect(messages("const m = new Map<string, number>(); m.set('a', 1);")[0]).toMatch(/texts of a union known when the script is built/);
  });
});

describe("a record read and written at a text of a union", () => {
  const top = 'type St = "idle" | "run" | "hide";\nconst NAMES: Record<St, string> = { idle: "Idle", run: "Run", hide: "Hide" };';
  it("a table of functions keyed by states, called; numbers and texts read", () => {
    expect(shown("let k = 1; let s: St = 'idle';\nconst t: Record<St, () => St> = { idle: () => (k ? 'run' : 'idle'), run: () => 'hide', hide: () => 'idle' };\n" +
      "const cost: Record<St, number> = { idle: 1, run: 5, hide: 2 };\ns = t[s](); print(`${s} ${cost[s]} ${NAMES[s]}`); s = t[s](); print(`${s} ${cost[s]}`);", top)).toEqual(["run 5 Run", "hide 2"]);
  });
  it("written, by =, by a compound assignment, by ++", () => {
    expect(shown("let k = 1; let s: St = k ? 'run' : 'idle';\nconst cost: Record<St, number> = { idle: 1, run: 5, hide: 2 }; const on: Record<St, boolean> = { idle: false, run: false, hide: true };\n" +
      "cost[s] = 7; cost[s]++; cost[s] += 2; on[s] = true; print(`${cost.run} ${cost.idle} ${on.run ? 1 : 0} ${on[s] ? 1 : 0}`);", top)).toEqual(["10 1 1 1"]);
  });
});

describe("sort() and reverse() of texts", () => {
  it("by their characters as JavaScript does, by a function, stable", () => {
    expect(shown("let k = 1; const a = ['pear', k ? 'apple' : 'fig', 'Zed', 'banana', 'apple']; a.sort(); print(a.join(','));\n" +
      "a.sort((x, y) => x.length - y.length); print(a.join(',')); a.reverse(); print(a.join(','));\nconst b: string[] = []; b.push('b'); b.push(`a${k}`); b.sort(); print(b.join(' '));"))
      .toEqual(["Zed,apple,apple,banana,pear", "Zed,pear,apple,apple,banana", "banana,apple,apple,pear,Zed", "a1 b"]);
  });
});

describe("a boolean as a text", () => {
  it("is true or false, in a template, String(), and + ", () => {
    expect(shown("let k = 1; const f = k === 1; let g = false; print(`${f} ${g} ${k > 3}`); print(String(f)); const t = 'is ' + f; print(t);")).toEqual(["true false false", "true", "is true"]);
  });
});

describe("an enum inside a program", () => {
  it("its members are values the script has, numbers and texts", () => {
    expect(shown("enum S { A, B = 5, C } enum Dir { Up = 'up', Down = 'down' } let k = 1; let s = S.A; if (k) s = S.C; print(`${s} ${S.B}`); const d = k ? Dir.Down : Dir.Up; print(d);\n" +
      "switch (s) { case S.C: print('c'); break; default: print('other'); }")).toEqual(["6 5", "down", "c"]);
  });
});

describe("push of a record chosen by ?:", () => {
  it("of a union of records, and of instances", () => {
    const top = 'type Ev = { kind: "hit"; n: number } | { kind: "heal"; h: number };\nclass P { constructor(public x: number) {} }';
    expect(shown("let k = 1; const q: Ev[] = []; q.push(k ? { kind: 'hit', n: 3 } : { kind: 'heal', h: 2 }); q.push(k > 1 ? { kind: 'hit', n: 9 } : { kind: 'heal', h: 4 });\n" +
      "for (const e of q) { if (e.kind === 'hit') print('hit' + e.n); else print('heal' + e.h); }\nconst ps: P[] = []; ps.push(k ? new P(1) : new P(2)); print(`${ps[0].x}`);", top)).toEqual(["hit3", "heal4", "1"]);
  });
});
