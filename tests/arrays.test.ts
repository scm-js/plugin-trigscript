/**
 * Arrays of a program (slice 6): declared, read and stored by a constant or a variable index, looped
 * over, handed to functions, kept per player — and a list known when the script was built that a
 * program looks a value up in. The interpreter here; `eud-build.test.ts` builds the same through eudplib.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { serializeIr } from "../compiler/eud";
import { HEAP_CELLS, HEAP_CELLS_MAX, HEAP_CELLS_MIN, STACK_DEPTH } from "../compiler/ir";
import { DEFAULT_SETTINGS, SETTINGS_MEMBER, readSettings, withSettings } from "../script";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, before = ""): CompileResult => compileScript(ts, { "main.ts": `${before}\nprogram(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, before = ""): CompileResult => { const r = raw(body, before); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, before = "", frames = 1) => { const r = compile(body, before); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const messages = (body: string, before = "") => raw(body, before).diagnostics.map((d) => d.message);

describe("arrays: declared, read, stored", () => {
  it("a list of values, a constant and a variable index, a compound store, ++", () => {
    const sim = run("let hp = [10, 20, 30]; let i = 1; let out = 0; hp[0] = 5; hp[i] += 7; hp[i + 1]++; out = hp[0] + hp[i] + hp[2];");
    expect(sim.list("hp")).toEqual([5, 27, 31]);
    expect(sim.value("out")).toBe(63);
    expect(sim.faults).toEqual([]);
  });
  it("values of the program in the literal, new Array(n).fill(v) with a constant and with a variable, booleans", () => {
    const sim = run("let a = 3; let xs = [a, a * 2, 0]; let zeros = new Array(6).fill(0); let full = Array(3).fill(a + 1); let seen = [false, true]; seen[0] = xs[1] == 6; let out = 0; if (seen[0] && seen[1]) out = zeros.length + full[2];");
    expect(sim.list("xs")).toEqual([3, 6, 0]);
    expect(sim.list("zeros")).toEqual([0, 0, 0, 0, 0, 0]);
    expect(sim.list("full")).toEqual([4, 4, 4]);
    expect(sim.list("seen")).toEqual([true, true]);
    expect(sim.value("out")).toBe(10);
  });
  it("a const array the body stores into is an array of the program, as TypeScript has it", () => {
    const sim = run("const hp = [1, 2, 3]; let i = 2; hp[i] = 9; let out = 0; out = hp[2];");
    expect(sim.value("out")).toBe(9);
  });
  it("cells keep their type: a u8[] stops at both ends, a u32[] reads from 0 up, a number[] goes below zero", () => {
    const sim = run("let small: u8[] = [250, 3]; let i = 0; small[i] += 10; small[i + 1] -= 5; let wide: u32[] = [0]; wide[i] -= 1; let plain = [0]; plain[i] -= 1;");
    expect(sim.list("small")).toEqual([255, 0]);
    expect(sim.list("wide")).toEqual([4294967295]);
    expect(sim.list("plain")).toEqual([-1]);
  });
  it("for…of runs over the cells within the frame, the variable a copy; break and continue are the loop's", () => {
    const sim = run("let xs = [1, 2, 3, 4, 5]; let sum = 0; for (const x of xs) { if (x == 2) continue; if (x == 5) break; sum += x; } for (let x of xs) { x = 0; }");
    expect(sim.value("sum")).toBe(8);
    expect(sim.list("xs")).toEqual([1, 2, 3, 4, 5]);
  });
  it("an array reaches a function as itself", () => {
    const sim = run("let xs = [1, 2, 3]; function bump(list: number[], by: number) { for (let i = 0; i < list.length; i++) list[i] += by; } bump(xs, 10); let n = 2; bump(xs, n);");
    expect(sim.list("xs")).toEqual([13, 14, 15]);
  });
});

describe("arrays: a list known when the script was built", () => {
  it("indexed by a value of the program it is an array nothing writes, made once however often it is read", () => {
    const r = compile("let level = 2; let cost = 0; cost = price[level] + price[level - 1]; if (open[level]) cost += 1;", "const price = [50, 100, 150]; const open = [false, false, true];");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.value("cost")).toBe(251);
    expect(r.ir[0].arrays.map((a) => [a.name, a.values])).toEqual([["price", [50, 100, 150]], ["open", [0, 0, 1]]]);
  });
  it("indexed by a constant it is just the value, and it cannot be stored into", () => {
    const r = compile("let cost = 0; cost = price[1];", "const price = [50, 100, 150];");
    expect(r.ir[0].arrays).toEqual([]);
    expect(messages("let i = 0; price[i] = 5;", "const price = [50, 100, 150];")[0]).toMatch(/price was computed when the script was built and is only read/);
  });
});

describe("arrays: the ends", () => {
  it("a constant index past the end is an error; a variable one reads 0, stores nothing, and is said", () => {
    expect(messages("let hp = [1, 2, 3]; hp[3] = 1;")).toEqual(["hp has 3 cells, 0 … 2; there is no hp[3]."]);
    const sim = run("let hp = [1, 2, 3]; let i = 3; let m = -1; let out = 9; out = hp[i]; hp[m] = 7;");
    expect(sim.value("out")).toBe(0);
    expect(sim.list("hp")).toEqual([1, 2, 3]);
    expect(sim.faults.map((f) => f.message)).toEqual([
      "hp[3] is past the end of the array (its length is 3): it reads 0.",
      "hp[-1] is past the end of the array (its length is 3): nothing is stored.",
    ]);
  });
  it("what an array cannot be", () => {
    // An array of texts is one since 3.9 (tests/leftovers.test.ts).
    expect(messages("let names = ['a', 'b']; names[0] = 'c';")).toEqual([]);
    expect(messages("let marks = [Symbol('a')];")[0]).toMatch(/An array of a program holds numbers or booleans/);
    expect(messages("let n = 3; let xs = new Array(n).fill(0);")[0]).toMatch(/An array's length has to be known when the script is built/);
    expect(messages("let xs = [1, 2]; let ys = [3, 4]; xs = ys;")[0]).toMatch(/An array is assigned cell by cell/);
  });
  it("a loop whose condition reads a cell the body stores into is not a loop that never ends", () => {
    compile("let left = [3]; let i = 0; while (left[i] > 0) { left[i] -= 1; }");
    expect(messages("let left = [3]; let i = 0; let n = 0; while (left[i] > 0) { n += 1; }")[0]).toMatch(/sleep/);
  });
});

describe("arrays: per player", () => {
  it("a per-player program has an array for every player unless it is shared", () => {
    const r = compileScript(ts, { "main.ts": "program(() => { let mine = [0, 0]; let all = shared([0, 0]); mine[1] += 1; all[1] += 1; }, { owner: AllPlayers });" }, NAMES, { lib: LIB });
    expect(r.diagnostics).toEqual([]);
    expect(r.ir[0].arrays.map((a) => [a.name, a.shared])).toEqual([["mine", false], ["all", true]]);
  });
});

describe("arrays that grow", () => {
  it("push, pop, length, xs[xs.length] = v, length = n: an array something pushes to starts as it is written and grows", () => {
    const r = compile("const queue: number[] = []; let n = 0; queue.push(5); queue.push(6, 7); n = queue.length; let last = 0; last = queue.pop()!; queue[queue.length] = 9; let i = 1; queue[i] += 1; let out = 0; for (const q of queue) out = out * 10 + q;");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(r.ir[0].arrays).toMatchObject([{ name: "queue", dynamic: true, length: 0 }]);
    expect([sim.value("n"), sim.value("last"), sim.value("out")]).toEqual([3, 7, 579]);
    expect(sim.list("queue")).toEqual([5, 7, 9]);
    const cut = run("let xs = [1, 2, 3, 4]; xs.length = 2; xs.length = 9; xs.push(8); let empty = [1]; empty.length = 0; let none = 5; none = empty.pop()!; let other = 0; other = empty.pop() ?? 42; let got = 0; got = xs.pop() ?? 42;");
    expect(cut.list("xs")).toEqual([1, 2]);
    expect([cut.value("none"), cut.value("other"), cut.value("got")]).toEqual([0, 42, 8]);
    expect(cut.faults).toEqual([]);
  });
  it("it grows past any size it was given, a block twice the size each time", () => {
    const sim = run("const xs: number[] = []; let i = 0; while (i < 1000) { xs.push(i * 2); i++; } let out = 0; out = xs[999] + xs.length;");
    expect(sim.value("out")).toBe(1998 + 1000);
    // 4, 8, … 1024: the blocks it outgrew wait in their sizes' lists; the ground taken is their sum.
    expect(sim.heap.top).toBe(1 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 512 + 1024);
  });
  it("declared again it gives back the block it held, so a loop that makes one a round does not eat the heap", () => {
    const sim = run("let round = 0; while (round < 500) { const xs: number[] = []; for (let k = 0; k < 40; k++) xs.push(k); round++; } ", "", 1);
    expect(sim.faults).toEqual([]);
    expect(sim.heap.top).toBeLessThan(200);
  });
  it("when the heap has no block left nothing is pushed, and it is said", () => {
    const sim = run("const xs: number[] = []; let i = 0; while (i < 20000) { xs.push(i); i++; } let n = 0; n = xs.length;");
    expect(sim.value("n")).toBe(8192);
    expect(sim.faults[0].message).toMatch(/^Out of memory: xs could not grow to 8193 cells/);
  });
  it("an array pushed to inside a function it was handed to grows too; a list computed at build time cannot", () => {
    const sim = run("let xs = [1]; function add(list: number[], v: number) { list.push(v); } add(xs, 2); let n = 3; add(xs, n);");
    expect(sim.list("xs")).toEqual([1, 2, 3]);
    expect(messages("let xs = []; xs.push(1);")[0]).toMatch(/Say what xs holds/);
  });
  it("fill, includes and indexOf are loops the game runs; indexOf is -1 when there is none", () => {
    const sim = run("let xs = [4, 5, 6]; let v = 5; let at = 9; let none = 9; let has = false; at = xs.indexOf(v); none = xs.indexOf(v + 9); has = xs.includes(6) && !xs.includes(v * 3); let flags = [false, true]; let f = false; f = flags.includes(true); xs.fill(v + 2);");
    expect([sim.value("at"), sim.value("none"), sim.value("has"), sim.value("f")]).toEqual([1, -1, true, true]);
    expect(sim.list("xs")).toEqual([7, 7, 7]);
    expect(messages("let xs = [1]; xs.splice(0, 1);")[0]).toMatch(/has push, pop, fill, includes, indexOf, length, for…of, and the methods that take a function .*; splice\(\) is not one of them/);
  });
});

describe("the arrays probe (probes/arrays.ts), which is played in the game, says the same here", () => {
  const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "arrays.ts"), "utf8") }, NAMES, { lib: LIB });
  it("compiles, and every line that states what it expects shows it", () => {
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    // Player 1's four Marines, as build-fixture places them, for the array of units.
    const marines = [0, 1, 2, 3].map((k) => ({ type: 0, owner: 0, x: 100 + k * 20, y: 100, hp: 40, maxHp: 40 }));
    const sim = simulatePrograms(r.ir, 24 * 62, { strings: r.strings, playerName: () => "Ann", units: marines });
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]\d?: /.test(t));
    const stated = lines.map((t) => /^([A-Z]\d?): ([-\d ]+) \(expect ([-\d ]+)\)$/.exec(t)).filter((m): m is RegExpExecArray => !!m);
    expect(stated.map((m) => m[1])).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "M", "O", "Q"]);
    expect(lines).toContain("P: 4 130 - ONE Marine is at 10 hit points (expect 4 130)");
    expect(lines).toContain("P2: two Marines died; the array has 3 left, 2 alive (expect 3 2)");
    for (const m of stated) expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
    expect(lines).toContain("L: the array holds 4096 (expect 4096)");
    // The simulation runs the second program as one player, so the shared array has that player's push alone.
    expect(lines.some((t) => t.startsWith("N: Ann: mine 1, all 1"))).toBe(true);
    // Step G's two reads and two stores past the end, and the one push the heap had no block for.
    expect(sim.faults.filter((f) => /past the end/.test(f.message))).toHaveLength(4);
    expect(sim.faults.filter((f) => /^Out of memory/.test(f.message)).length).toBeGreaterThan(0);
  });
});

describe("the heap's size is a setting of the map's script", () => {
  it("is kept in a member beside the script, within its limits, and leaves none behind when it is the default", () => {
    const none = new Map<string, Uint8Array>();
    expect(readSettings(none)).toEqual(DEFAULT_SETTINGS);
    const set = withSettings(none, { heapCells: 65536 });
    expect([...set.keys()]).toEqual([SETTINGS_MEMBER]);
    expect(readSettings(set)).toEqual({ heapCells: 65536, stackDepth: STACK_DEPTH });
    expect(readSettings(withSettings(none, { heapCells: 5 })).heapCells).toBe(HEAP_CELLS_MIN);
    expect(readSettings(withSettings(none, { heapCells: 1e12 })).heapCells).toBe(HEAP_CELLS_MAX);
    expect(withSettings(set, { heapCells: HEAP_CELLS }).size).toBe(0);
    expect(readSettings(new Map([[SETTINGS_MEMBER, new TextEncoder().encode("not json")]]))).toEqual(DEFAULT_SETTINGS);
  });
  it("goes to the lowering with the IR when an array grows and it is not the default", () => {
    const grows = compile("const xs: number[] = []; xs.push(1);");
    expect(JSON.parse(serializeIr(grows.ir, grows.strings, null, { heapCells: 65536 })).heap).toBe(65536);
    expect(JSON.parse(serializeIr(grows.ir, grows.strings, null, { heapCells: HEAP_CELLS })).heap).toBeUndefined();
    const fixed = compile("let xs = [1, 2]; xs[0] = 3;");
    expect(JSON.parse(serializeIr(fixed.ir, fixed.strings, null, { heapCells: 65536 })).heap).toBeUndefined();
  });
  it("and the interpreter runs out where the game will", () => {
    const r = compile("const xs: number[] = []; let i = 0; while (i < 70000) { xs.push(i); i++; } let n = 0; n = xs.length;");
    const at = (heapCells: number) => simulatePrograms(r.ir, 1, { strings: r.strings, heapCells, maxStepsPerCycle: 1_000_000 }).value("n");
    // 1 + 4 + 8 + … + 512 is 1021 of the 1024: alone, an array reaches half the pool.
    expect(at(1024)).toBe(512);
    expect(at(HEAP_CELLS)).toBe(8192);
    expect(at(262144)).toBe(70000);
  });
});

describe("tables keyed by an id of the game: Record, Map, Set", () => {
  // A unit of the simulation to take keys from: a Marine (type 0) of Player 2 (owner 1).
  const units = [{ type: 0, owner: 1, x: 10, y: 10, hp: 40, maxHp: 40 }];
  const withUnit = (body: string, before = "") => { const r = compile(body, before); return { r, sim: simulatePrograms(r.ir, 1, { strings: r.strings, units }) }; };

  it("a Record inside the program is an array with a cell for every id, read and written by a key of the game", () => {
    const { r, sim } = withUnit("const price: Record<UnitType, number> = { [units.TerranMarine]: 50, [units.ProtossZealot]: 100 }; const score: Record<Player, number> = { [P1]: 0 }; let cost = 0; const u = first(); if (u) { cost = price[u.type] + price[units.ProtossZealot]; score[u.owner] += 7; price[u.type] -= 1; } let p2 = 0; p2 = score[P2];");
    expect([sim.value("cost"), sim.value("p2")]).toEqual([150, 7]);
    expect(r.ir[0].arrays.map((a) => [a.name, a.length])).toEqual([["price", 228], ["score", 12]]);
    expect(sim.list("price")![0]).toBe(49);
  });
  it("a Map has get, set, has, delete, clear and size; get() ?? d is d for a key never set", () => {
    const { sim } = withUnit("const price = new Map<UnitType, number>([[units.TerranMarine, 50]]); let a = 0; let b = 0; let had = false; let n = 0; const u = first(); if (u) { a = price.get(u.type) ?? 7; b = price.get(units.ProtossZealot) ?? 7; price.set(units.ProtossZealot, 100); price.set(u.type, a + 1); had = price.has(units.ProtossZealot) && !price.has(units.ZergZergling); n = price.size; price.delete(u.type); price.delete(u.type); } let after = 0; after = price.size; let gone = 9; gone = price.get(units.TerranMarine) ?? 3; price.clear(); let none = 9; none = price.size;");
    expect([sim.value("a"), sim.value("b"), sim.value("had"), sim.value("n"), sim.value("after"), sim.value("gone"), sim.value("none")]).toEqual([50, 7, true, 2, 1, 3, 0]);
  });
  it("a Set has add, has, delete, clear and size", () => {
    const { sim } = withUnit("const seen = new Set<UnitType>(); let first1 = false; let again = false; let n = 0; const u = first(); if (u) { first1 = seen.has(u.type); seen.add(u.type); seen.add(u.type); again = seen.has(u.type); n = seen.size; seen.delete(u.type); } let left = 9; left = seen.size;");
    expect([sim.value("first1"), sim.value("again"), sim.value("n"), sim.value("left")]).toEqual([false, true, 1, 0]);
  });
  it("made when the script was built and asked with a key of the program, they are tables nothing writes", () => {
    const before = "const price: Record<UnitType, number> = { [units.TerranMarine]: 50, [units.TerranFirebat]: 75 }; const cost = new Map<UnitType, number>([[units.TerranMarine, 5]]); const elite = new Set<UnitType>([units.TerranMarine]);";
    const { r, sim } = withUnit("let a = 0; let b = 0; let c = false; const u = first(); if (u) { a = price[u.type]; b = cost.get(u.type) ?? 1; c = elite.has(u.type); }", before);
    expect([sim.value("a"), sim.value("b"), sim.value("c")]).toEqual([50, 5, true]);
    expect(r.ir[0].arrays.every((x) => x.values !== undefined)).toBe(true);
    expect(messages("const u = first(); if (u) cost.set(u.type, 1);", before)[0]).toMatch(/was made when the script was built and is only read/);
  });
  it("for…of goes through the keys that are there: a Set's keys, a Map's [key, value], keys() and values()", () => {
    const sim = run("const seen = new Set<UnitType>([units.TerranMarine, units.ZergZergling]); const lost = new Map<UnitType, number>([[units.TerranMarine, 5], [units.ProtossZealot, 7]]); let keys = 0; let pairs = 0; let ks = 0; let vs = 0; let turns = 0; for (const k of seen) { keys = keys * 100 + k; seen.delete(k); } for (const [k, v] of lost) { pairs += k * v; if (k == units.TerranMarine) continue; turns++; } for (const k of lost.keys()) ks += k; for (const v of lost.values()) vs += v; let left = 9; left = seen.size;");
    expect([sim.value("keys"), sim.value("pairs"), sim.value("turns"), sim.value("ks"), sim.value("vs"), sim.value("left")]).toEqual([37, 65 * 7, 1, 65, 12, 0]);
    expect(messages("const score: Record<Player, number> = { [P1]: 0 }; for (const p of score) {}").some((m) => /is a Record: it has a value for every key/.test(m) || /iterator|iterable/i.test(m))).toBe(true);
  });
  it("what a key cannot be", () => {
    // Any number is a key since 3.9 (tests/hash.test.ts); a text is not.
    expect(messages("const m = new Map<number, number>();")).toEqual([]);
    expect(messages("const m = new Map<string, number>();")[0]).toMatch(/keys have to be numbers, or ids of the game/);
    expect(messages("const score: Record<Player, number> = { [P1]: 0 }; score[CurrentPlayer] += 1;")[0]).toMatch(/CurrentPlayer is not a key of score/);
    expect(messages("const price = new Map<UnitType, number>(); price.forEach(() => {});")[0]).toMatch(/has get, set, has, delete, clear and size; forEach\(\) is not one of them/);
  });
});

describe("arrays of records", () => {
  it("are an array a field; a record of one is the array's own, so what is written through it stays", () => {
    const r = compile("let waves = [{ count: 4, delay: 2 }, { count: 6, delay: 1 }]; let i = 1; let a = 0; a = waves[i].count + waves[0].delay; waves[i].count += 10; waves[0] = { count: 1, delay: a }; const w = waves[i]; i = 0; w.delay = 99; let n = 0; n = waves.length; let sum = 0; for (const x of waves) { sum += x.count; x.delay += 1; }");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(r.ir[0].arrays.map((x) => x.name)).toEqual(["waves.count", "waves.delay"]);
    expect([sim.value("a"), sim.value("n"), sim.value("sum")]).toEqual([8, 2, 17]);
    expect(sim.list("waves.count")).toEqual([1, 16]);
    expect(sim.list("waves.delay")).toEqual([9, 100]);
  });
  it("grow record by record, take booleans and declared widths, and reach a function as themselves", () => {
    const sim = run("interface Hit { who: u8; hard: boolean } const log: Hit[] = []; let p = 300; log.push({ who: p, hard: true }); log.push({ who: 2, hard: false }, { who: 3, hard: p > 1 }); function soften(hits: Hit[]) { for (const h of hits) h.hard = false; } let last = 0; last = log[log.length - 1].who; log.pop(); soften(log); let n = 0; n = log.length; log.length = 1;");
    expect([sim.value("last"), sim.value("n")]).toEqual([3, 2]);
    expect(sim.list("log.who")).toEqual([255]);
    expect(sim.list("log.hard")).toEqual([false]);
  });
  it("a list of records the script made is a table a field, looked up by a value of the program", () => {
    const before = "const waves = [{ unit: units.ZergZergling, count: 4, boss: false, name: 'first' }, { unit: units.ZergHydralisk, count: 6, boss: true, name: 'second' }];";
    const r = compile("let wave = 1; let n = 0; let boss = false; n = waves[wave].count * 10 + waves[wave - 1].count; boss = waves[wave].boss; createUnit(P2, waves[wave].unit, waves[wave].count, locations.Anywhere);", before);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect([sim.value("n"), sim.value("boss")]).toEqual([64, true]);
    expect(r.ir[0].arrays.map((x) => [x.name, x.values])).toEqual([["waves.unit", [37, 38]], ["waves.count", [4, 6]], ["waves.boss", [0, 1]]]);
    expect(sim.events.map((e) => [e.action.unitId, e.action.modifier])).toEqual([[38, 6]]);
    expect(messages("let wave = 1; waves[wave].count = 9;", before)[0]).toMatch(/was computed when the script was built and is only read/);
  });
  it("what they cannot be", () => {
    expect(messages("let waves = [{ count: 4 }]; waves.push({ delay: 1 });")[0]).toMatch(/count is missing|does not exist|missing/);
    expect(messages("let waves = [{ count: 4 }]; let n = 0; n = waves;")[0]).toMatch(/is an array of records|not assignable/);
    expect(messages("let waves = [{ count: 4 }]; waves.splice(0, 1);")[0]).toMatch(/has push\(\{ … \}\), pop\(\), length, for…of, and forEach/);
  });
});

describe("arrays of units", () => {
  const units = [
    { type: 0, owner: 0, x: 10, y: 10, hp: 40, maxHp: 40 },
    { type: 0, owner: 0, x: 20, y: 10, hp: 30, maxHp: 40 },
    { type: 37, owner: 1, x: 30, y: 10, hp: 35, maxHp: 35 },
  ];
  const withUnits = (body: string) => { const r = compile(body); return { r, sim: simulatePrograms(r.ir, 1, { strings: r.strings, units }) }; };

  it("are three arrays of numbers; a unit taken out of one is the unit, push and pop move them together", () => {
    const { r, sim } = withUnits("const squad: Unit[] = []; for (const u of unitsOf(P1)) squad.push(u); const z = first({ owner: P2 }); if (z) squad.push(z); let n = 0; n = squad.length; let i = 1; let hp = 0; hp = squad[i].hp + squad[0].hp; squad[i].hp = 5; let sum = 0; for (const u of squad) sum += u.hp; const last = squad.pop(); let lastType = 0; if (last) lastType = last.type; let left = 0; left = squad.length; squad[0] = squad[i]; let same = false; same = squad[0] == squad[1];");
    expect(r.ir[0].arrays.map((a) => [a.name, a.dynamic])).toEqual([["squad (ptr)", true], ["squad (epd)", true], ["squad (uid)", true]]);
    expect([sim.value("n"), sim.value("hp"), sim.value("sum"), sim.value("lastType"), sim.value("left"), sim.value("same")]).toEqual([3, 70, 80, 37, 2, true]);
  });
  it("a unit that is gone, or a place past the end, is no unit: it reads 0 and takes no order", () => {
    const { sim } = withUnits("let pair = [first({ owner: P1 }), first({ owner: P2 })]; pair[1]?.kill(); let alive = 0; for (const u of pair) { if (u) alive++; } let past = 5; let none = 9; const gone = pair[past]; none = 0; if (gone) none = gone.hp; if (!pair[past]) none += 1; pair.length = 0; let n = 9; n = pair.length;");
    expect([sim.value("alive"), sim.value("none"), sim.value("n")]).toEqual([1, 1, 0]);
  });
  it("what they cannot be", () => {
    expect(messages("const squad: Unit[] = []; const u = first(); if (u) squad.push(u); squad.splice(0, 1);")[0]).toMatch(/An array of units has push\(unit\), pop\(\), length, for…of, and forEach/);
  });
});
