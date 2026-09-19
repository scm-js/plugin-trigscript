/**
 * A Map and a Set over any number (slice 8½): the entries in the order they went in, a key found through slots that
 * are made again at twice the size. The interpreter here; `eud-build.test.ts` builds the same through eudplib.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const run = (body: string, before = "", frames = 1, heapCells?: number) => { const r = compile(body, before); return simulatePrograms(r.ir, frames, { strings: r.strings, ...(heapCells ? { heapCells } : {}) }); };
const messages = (body: string, before = "") => raw(body, before).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);

/** What JavaScript itself says of the same lines: the body is run as it is, `print` collecting. */
const js = (body: string): string[] => { const out: string[] = []; new Function("print", ts.transpile(body))((t: string) => out.push(t)); return out; };
const same = (body: string) => { const sim = run(body); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body)); };

describe("a Map over any number", () => {
  it("get, set, has, delete, size, a key below zero, a large one", () => {
    same("const m = new Map<number, number>(); let k = 70000; m.set(k, 1); m.set(-5, 2); m.set(k, 3); m.set(0, 9); const gone = m.delete(-5); const again = m.delete(-5); print(`${m.size} ${m.get(k) ?? -1} ${m.get(-5) ?? -1} ${m.has(0) ? 1 : 0} ${m.has(1) ? 1 : 0} ${gone ? 1 : 0} ${again ? 1 : 0}`);");
  });
  it("goes through its entries in the order the keys went in: set again stays, deleted and set again goes last", () => {
    same("const m = new Map<number, number>(); let a = 30; m.set(a, 1); m.set(10, 2); m.set(20, 3); m.set(a, 4); m.delete(10); m.set(10, 5); let s = ''; for (const [k, v] of m) s += `${k}=${v} `; for (const k of m.keys()) s += `${k} `; for (const v of m.values()) s += `${v} `; m.forEach((v, k) => { s += `${k}:${v} `; }); print(s);");
  });
  it("reaches what is added while a loop goes through it, and not what is deleted", () => {
    same("const m = new Map<number, number>(); let n = 3; for (let i = 0; i < n; i++) m.set(i, i); let s = ''; for (const [k] of m) { if (k == 0) { m.delete(1); m.set(7, 7); } if (k == 7) m.set(8, 8); s += `${k} `; } print(`${s}${m.size}`);");
  });
  it("grows past its first slots many times over, with keys alike in their low bits", () => {
    same("const m = new Map<number, number>(); let n = 300; for (let i = 0; i < n; i++) m.set(i * 65536, i); for (let i = 0; i < n; i += 2) m.delete(i * 65536); for (let i = 0; i < n; i += 3) m.set(i * 65536, 1000 + i); let sum = 0; let count = 0; for (const [k, v] of m) { sum += v; count++; } let first = -1; for (const k of m.keys()) { first = k / 65536; break; } print(`${m.size} ${count} ${sum} ${first} ${m.get(6 * 65536) ?? -1} ${m.get(2 * 65536) ?? -1}`);");
  });
  it("starts with what it is given, holds booleans, clears", () => {
    same("let k = 4; const m = new Map<number, boolean>([[1, true], [k, false]]); const c = new Map<number, number>([[5, 50], [6, 60]]); let s = ''; for (const [a, b] of m) s += `${a}${b ? 'y' : 'n'} `; c.clear(); c.set(9, 1); print(`${s}${(m.get(1) ?? false) ? 1 : 0} ${c.size} ${c.has(5) ? 1 : 0} ${c.get(9) ?? 0}`);");
  });
  it("gives its memory back when it is declared again, and deleted entries when it is made again", () => {
    const r = compile("let turn = 0; let total = 0; const keep = new Map<number, number>(); while (turn < 50) { const m = new Map<number, number>(); for (let i = 0; i < 20; i++) m.set(i * 7 + turn, i); total += m.size; for (let i = 0; i < 20; i++) { keep.set(turn * 100 + i, i); keep.delete(turn * 100 + i); } turn++; } print(`${total} ${keep.size}`);");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 512 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["1000 0"]);
  });
  it("is handed to a function as itself, and is a field of a class", () => {
    same("class Tally { counts = new Map<number, number>(); add(k: number) { this.counts.set(k, (this.counts.get(k) ?? 0) + 1); } } function bump(m: Map<number, number>, k: number) { m.set(k, (m.get(k) ?? 0) + 10); } const t = new Tally(); let k = 5; t.add(k); t.add(k); t.add(9); bump(t.counts, 9); let s = ''; for (const [a, b] of t.counts) s += `${a}:${b} `; print(s);");
  });
});

describe("a Map against JavaScript's own", () => {
  it("four hundred sets, deletes, reads and walks at random say what JavaScript says", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const keys = [0, 1, -1, 7, 8, 9, 16, 65536, 131072, -65536, 1000003, 2147483647, -2147483648, 255, 256, 4096];
    const lines = ["const m = new Map<number, number>(); const s = new Set<number>(); let out = ''; let k = 0;"];
    for (let i = 0; i < 400; i++) {
      const key = keys[rnd(keys.length)] + (rnd(4) === 0 ? rnd(40) : 0);
      lines.push(`k = ${key};`);
      switch (rnd(7)) {
        case 0: case 1: lines.push(`m.set(k, ${rnd(1000)}); s.add(k + 1);`); break;
        case 2: lines.push("if (m.delete(k)) out += 'd'; s.delete(k + 1);"); break;
        case 3: lines.push("out += `${m.get(k) ?? -7},`;"); break;
        case 4: lines.push("if (m.has(k)) out += 'h'; if (s.has(k + 1)) out += 'H';"); break;
        case 5: lines.push("for (const [a, b] of m) { out += `${a}:${b} `; if (a == k) m.delete(a); } out += `|${m.size} ${s.size}|`;"); break;
        default: lines.push("for (const a of s) { if (a == k + 1) break; out += `${a} `; }"); break;
      }
      if (i % 40 === 39) lines.push("print(out); out = '';");
    }
    lines.push("print(out); print(`${m.size} ${s.size}`);");
    const body = lines.join("\n");
    const r = compile(body);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 4096 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(js(body));
  });
  it("counts a loop out when a return leaves it", () => {
    const sim = run("const m = new Map<number, number>(); function firstOver(n: number): number { for (const [k, v] of m) { if (v > n) return k; } return -1; } let n = 9; for (let i = 0; i < n; i++) m.set(i, i); const a = firstOver(3); const b = firstOver(4);");
    expect(sim.value("a")).toBe(4);
    expect(sim.value("m (loops)")).toBe(0);
  });
  it("a return out of a loop through it leaves it able to close up again", () => {
    same("const m = new Map<number, number>(); function firstOver(n: number): number { for (const [k, v] of m) { if (v > n) return k; } return -1; } let n = 40; for (let i = 0; i < n; i++) m.set(i, i * 2); const a = firstOver(10); const b = firstOver(1000); for (let i = 0; i < n; i += 2) m.delete(i); for (let i = 100; i < 140; i++) m.set(i, i); let s = ''; for (const k of m.keys()) { s += `${k} `; if (k > 5) break; } print(`${a} ${b} ${m.size} ${s}`);");
  });
});

describe("a Set over any number", () => {
  it("add, has, delete, size, in the order they went in", () => {
    same("const s = new Set<number>([3, 1]); let k = 1000000; s.add(k); s.add(3); s.add(-2); s.delete(1); s.add(1); let out = ''; for (const x of s) out += `${x} `; s.forEach((x) => { out += `${x},`; }); print(`${out} ${s.size} ${s.has(k) ? 1 : 0} ${s.has(4) ? 1 : 0}`);");
  });
});

describe("what is said", () => {
  it("a key that is not a number", () => {
    expect(messages("const m = new Map<string, number>(); m.set('a', 1);").join("\n")).toMatch(/keys have to be numbers/);
  });
  it("a method it has not got", () => {
    expect(messages("const m = new Map<number, number>(); const ks = [...m.keys()];").length).toBeGreaterThan(0);
  });
  it("a table keyed by ids of the game is still one read", () => {
    const r = compile("const price = new Map<UnitType, number>(); price.set(units.TerranMarine, 50); let p = price.get(units.TerranMarine) ?? 0;");
    expect((r.ir[0].functions ?? []).length).toBe(0);
  });
});

describe("the probe", () => {
  it("says in the simulator what it expects to say in the game", () => {
    const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "map.ts"), "utf8") }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    const sim = simulatePrograms(r.ir, 24 * 40, { strings: r.strings });
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]: ?/.test(t));
    const checked: string[] = [];
    for (const line of lines) {
      const m = /^([A-Z]): ?(.*?)(?: - [^(]*)? \(expect ([^)]*)\)$/.exec(line);
      if (!m || /your name/.test(m[3])) continue;
      expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
      checked.push(m[1]);
    }
    expect(checked).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(lines.some((t) => t.startsWith("I: Player 1 2 30"))).toBe(true);
    expect(sim.faults).toEqual([]);
    expect(sim.events.some((e) => e.text === "done")).toBe(true);
  });
});
