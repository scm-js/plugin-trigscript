/**
 * Classes (slice 8½): a class declared in a program is a record and its methods functions with the instance first,
 * everything about the class settled when the script is built. The interpreter here; `eud-build.test.ts` builds the
 * same through eudplib.
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
const raw = (body: string, before = ""): CompileResult => compileScript(ts, { "main.ts": `${before}\nprogram(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, before = ""): CompileResult => { const r = raw(body, before); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, before = "", frames = 1) => { const r = compile(body, before); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const messages = (body: string, before = "") => raw(body, before).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);

const COUNTER = "class Counter { n = 0; step: number; constructor(step: number) { this.step = step; } bump() { this.n += this.step; } get twice() { return this.n * 2; } set twice(v: number) { this.n = v / 2; } }";

describe("an instance", () => {
  it("is its fields: what they are declared with, then what the constructor gives them", () => {
    const sim = run(`${COUNTER} const c = new Counter(3); print(\`\${c.n} \${c.step}\`);`);
    expect(shown(sim)).toEqual(["0 3"]);
  });
  it("has methods that change it, a getter that reads it and a setter that writes it", () => {
    const sim = run(`${COUNTER} const c = new Counter(3); c.bump(); c.bump(); print(\`\${c.n} \${c.twice}\`); c.twice = 40; print(\`\${c.n}\`); if (c.twice > 39) print("big");`);
    expect(shown(sim)).toEqual(["6 12", "20", "big"]);
  });
  it("is one of many, each with cells of its own", () => {
    const sim = run(`${COUNTER} const a = new Counter(1); const b = new Counter(10); a.bump(); b.bump(); b.bump(); print(\`\${a.n} \${b.n}\`);`);
    expect(shown(sim)).toEqual(["1 20"]);
  });
  it("takes its constructor's arguments from the program's variables", () => {
    const sim = run(`${COUNTER} let s = 2; s += 5; const c = new Counter(s); s = 0; c.bump(); print(\`\${c.n}\`);`);
    expect(shown(sim)).toEqual(["7"]);
  });
  it("under another name is the same instance", () => {
    const sim = run(`${COUNTER} const a = new Counter(1); const same = a; same.bump(); print(\`\${a.n}\`);`);
    expect(shown(sim)).toEqual(["1"]);
  });
  it("is handed to a function as itself", () => {
    const sim = run(`${COUNTER} function twice(c: Counter) { c.bump(); c.bump(); } const a = new Counter(4); twice(a); print(\`\${a.n}\`);`);
    expect(shown(sim)).toEqual(["8"]);
  });
  it("declares fields in its constructor's parameters", () => {
    const sim = run("class P { constructor(public x: number, private y: number, readonly z = 9) {} sum() { return this.x + this.y + this.z; } } let k = 2; const p = new P(1, k); p.x += 10; print(`${p.sum()}`);");
    expect(shown(sim)).toEqual(["22"]);
  });
  it("keeps a #private field, and a static one that every instance shares", () => {
    const sim = run("class Id { static next = 1; #id = 0; constructor() { this.#id = Id.next; Id.next++; } get id() { return this.#id; } static made() { return Id.next - 1; } } const a = new Id(); const b = new Id(); print(`${a.id} ${b.id} ${Id.made()}`);");
    expect(shown(sim)).toEqual(["1 2 2"]);
  });
  it("holds a text, a unit, an array and a record, as a record does", () => {
    const sim = run("class Squad { name: string; members: number[] = []; pos = { x: 1, y: 2 }; leader: Unit | null = null; constructor(name: string) { this.name = name; } add(n: number) { this.members.push(n); } get size() { return this.members.length; } } let k = 3; const s = new Squad(`Alpha ${k}`); s.add(5); s.add(6); s.pos.x += 4; print(`${s.name}: ${s.size} ${s.members[1]} ${s.pos.x}`); if (!s.leader) print(\"nobody\");");
    expect(shown(sim)).toEqual(["Alpha 3: 2 6 5", "nobody"]);
    expect(sim.faults).toEqual([]);
  });
  it("holds another instance", () => {
    const sim = run("class V { constructor(public x: number, public y: number) {} add(o: V) { this.x += o.x; this.y += o.y; } } class Mover { pos = new V(1, 1); vel = new V(2, 3); step() { this.pos.add(this.vel); } } const m = new Mover(); m.step(); m.step(); print(`${m.pos.x} ${m.pos.y}`);");
    expect(shown(sim)).toEqual(["5 7"]);
  });
});

describe("a class that extends another", () => {
  const ZOO = "class Animal { legs = 4; sound = 1; constructor(public size: number) {} speak() { return this.sound * this.size; } describe() { return this.speak() + this.legs; } } class Bird extends Animal { legs = 2; constructor(size: number, public wings: number) { super(size * 2); this.sound = 5; } speak() { return super.speak() + this.wings; } }";
  it("runs what it extends first, then its own fields, then its constructor", () => {
    const sim = run(`${ZOO} const b = new Bird(3, 7); print(\`\${b.legs} \${b.size} \${b.sound} \${b.wings}\`);`);
    expect(shown(sim)).toEqual(["2 6 5 7"]);
  });
  it("overrides a method, which a method of what it extends then calls; super reaches the one overridden", () => {
    const sim = run(`${ZOO} const a = new Animal(3); const b = new Bird(3, 7); print(\`\${a.describe()} \${b.describe()}\`);`);
    // Animal: 1*3 + 4 = 7. Bird: (5*6 + 7) + 2 = 39.
    expect(shown(sim)).toEqual(["7 39"]);
  });
  it("answers instanceof when the script is built", () => {
    const sim = run(`${ZOO} function what(a: Animal) { if (a instanceof Bird) print(\`bird \${a.wings}\`); else print("animal"); } what(new Animal(1)); what(new Bird(1, 8)); const b: Animal = new Bird(2, 4); if (b instanceof Animal) what(b);`, "").events;
    expect(sim.map((e) => e.text)).toEqual(["animal", "bird 8", "bird 4"]);
  });
  it("with no constructor of its own hands its arguments on", () => {
    const sim = run("class A { constructor(public n: number) {} } class B extends A { twice = 0; double() { this.twice = this.n * 2; } } const b = new B(21); b.double(); print(`${b.twice}`);");
    expect(shown(sim)).toEqual(["42"]);
  });
});

describe("an array of instances", () => {
  const WAVE = "class Wave { left: number; constructor(public count: number, public delay: number) { this.left = count; } spawn() { if (this.left > 0) this.left--; } get done() { return this.left == 0; } }";
  it("is an array a field, a row an instance with the class's methods", () => {
    const sim = run(`${WAVE} const waves = [new Wave(2, 10), new Wave(1, 20)]; waves[0].spawn(); for (const w of waves) w.spawn(); waves.push(new Wave(5, 1)); let done = 0; waves.forEach((w) => { if (w.done) done++; }); print(\`\${waves.length} \${waves[0].left} \${waves[1].left} \${waves[2].left} \${done}\`);`);
    expect(shown(sim)).toEqual(["3 0 0 5 2"]);
  });
  it("starts empty and is pushed to, a row given a new instance", () => {
    const sim = run(`${WAVE} const waves: Wave[] = []; let n = 3; waves.push(new Wave(n, 1)); waves.push(new Wave(n + 1, 2)); waves[0] = new Wave(9, 9); const w = waves[1]; w.spawn(); print(\`\${waves[0].count} \${waves[1].left}\`);`);
    expect(shown(sim)).toEqual(["9 3"]);
  });
  it("sorts and filters by what a getter or a method says", () => {
    const sim = run(`${WAVE} const waves = [new Wave(3, 1), new Wave(1, 2), new Wave(2, 3)]; waves.sort((a, b) => a.count - b.count); waves[0].spawn(); const open = waves.filter((w) => !w.done); print(\`\${waves[0].count}\${waves[1].count}\${waves[2].count} \${open.length}\`);`);
    expect(shown(sim)).toEqual(["123 2"]);
  });
  it("is made straight on its row — and apart, then copied, when what new is handed may read the array", () => {
    const r = compile(`${WAVE} const waves: Wave[] = []; let n = 4; waves.push(new Wave(n, 2)); waves.push(new Wave(waves.length + 10, 3)); waves[0] = new Wave(waves[0].count * 2, waves.length); print(\`\${waves[0].count} \${waves[0].left} \${waves[0].delay} \${waves[1].count}\`);`);
    expect(shown(simulatePrograms(r.ir, 1, { strings: r.strings }))).toEqual(["8 8 2 11"]);
    // The first push declares no variable for a field: the constructor's assignments are stores into the row.
    const names: string[] = [];
    const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { const o = x as Record<string, unknown>; if (o.kind === "declare") names.push((o.decl as { name: string }).name); Object.values(o).forEach(walk); } };
    walk(r.ir);
    expect(names.filter((name) => name.startsWith("(new Wave)")).length).toBe(6);
    expect(names.some((name) => name.startsWith("waves[…]"))).toBe(false);
  });
  it("holds one class", () => {
    expect(messages("class A { n = 0; } class B extends A { m = 0; } const xs: A[] = []; xs.push(new A()); xs.push(new B());").join("\n")).toMatch(/holds one class/);
  });
  it("of a class others extend holds the one that is put into it", () => {
    const sim = run("class A { n = 1; size() { return this.n; } } class B extends A { m = 5; size() { return this.n + this.m; } } const xs: A[] = []; xs.push(new B()); print(`${xs[0].size()}`);");
    expect(shown(sim)).toEqual(["6"]);
  });
});

describe("what a row of an array holds", () => {
  const SQUAD = "class Vec { constructor(public x: number, public y: number) {} get sum() { return this.x + this.y; } } class Squad { seen: number[] = []; members: Unit[] = []; leader: Unit | null = null; pos = new Vec(1, 2); constructor(public id: number) {} note(n: number) { this.seen.push(n); } get total() { let t = 0; for (const n of this.seen) t += n; return t; } }";
  it("an array that grows, a row its own: pushed to through a method, read, its length", () => {
    const sim = run(`${SQUAD} const squads: Squad[] = []; squads.push(new Squad(1)); squads.push(new Squad(2)); squads[0].note(5); squads[1].note(7); squads[1].note(8); squads[0].seen.push(1); print(\`\${squads[0].seen.length} \${squads[1].seen.length} \${squads[0].total} \${squads[1].total} \${squads[1].seen[1]}\`);`);
    expect(shown(sim)).toEqual(["2 2 6 15 8"]);
    expect(sim.faults).toEqual([]);
  });
  it("an instance inside the row, with its own methods and getters", () => {
    const sim = run(`${SQUAD} const squads = [new Squad(1), new Squad(2)]; squads[1].pos.x += 10; for (const s of squads) s.pos.y *= 2; print(\`\${squads[0].pos.sum} \${squads[1].pos.sum}\`);`);
    expect(shown(sim)).toEqual(["5 15"]);
  });
  it("a unit, and an array of units", () => {
    const r = compile(`${SQUAD} const squads = [new Squad(1)]; const u = first({ owner: P1 }); squads[0].leader = u; if (u) squads[0].members.push(u); if (squads[0].leader) print("led"); print(\`\${squads[0].members.length}\`); for (const m of squads[0].members) m.kill();`);
    expect(r.diagnostics).toEqual([]);
  });
  it("sorts and reverses whole rows, the arrays they hold going with them", () => {
    const sim = run(`${SQUAD} const squads = [new Squad(3), new Squad(1), new Squad(2)]; squads[0].note(30); squads[1].note(10); squads[2].note(20); squads[2].note(21); squads.sort((a, b) => a.id - b.id); print(\`\${squads[0].total} \${squads[1].total} \${squads[2].total}\`); squads.reverse(); print(\`\${squads[0].id}\${squads[1].id}\${squads[2].id} \${squads[0].seen[0]}\`);`);
    expect(shown(sim)).toEqual(["10 41 30", "321 30"]);
  });
  it("sorts by what the arrays in a row say, the row in the hand being a row too", () => {
    const sim = run(`${SQUAD} const squads = [new Squad(1), new Squad(2), new Squad(3)]; squads[0].note(9); squads[1].note(1); squads[2].note(4); squads[2].note(1); squads.sort((a, b) => a.total - b.total); print(\`\${squads[0].id}\${squads[1].id}\${squads[2].id} \${squads.length}\`);`);
    expect(shown(sim)).toEqual(["231 3"]);
    expect(sim.faults).toEqual([]);
  });
  it("gives the blocks back when a row goes: pop, length =, a row given a new instance, the array declared again", () => {
    const r = compile(`${SQUAD} let turn = 0; while (turn < 40) { const squads: Squad[] = []; for (let i = 0; i < 5; i++) { squads.push(new Squad(i)); squads[i].note(i); squads[i].note(turn); } squads.pop(); squads[0] = new Squad(9); squads[0].note(1); squads.length = 2; turn++; } print("ok");`);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 64 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["ok"]);
  });
  it("filter makes rows with arrays of their own", () => {
    const sim = run(`${SQUAD} const squads = [new Squad(1), new Squad(2), new Squad(3)]; for (const s of squads) s.note(s.id * 10); const odd = squads.filter((s) => s.id % 2 == 1); odd[1].note(5); print(\`\${odd.length} \${odd[1].total} \${squads[2].total}\`);`);
    expect(shown(sim)).toEqual(["2 35 30"]);
  });
  it("a record written out holds them too", () => {
    const sim = run("const rows: { n: number; tags: number[]; at: { x: number; y: number } }[] = []; let k = 4; rows.push({ n: 1, tags: [k, k + 1], at: { x: 1, y: 2 } }); rows.push({ n: 2, tags: [], at: { x: 3, y: 4 } }); rows[1].tags.push(9); rows[1].tags = [7, 7, 7]; const { n, at: { y } } = rows[1]; print(`${rows[0].tags[1]} ${rows[1].tags.length} ${n} ${y}`);");
    expect(shown(sim)).toEqual(["5 3 2 4"]);
  });
  it("says what a row cannot hold", () => {
    expect(messages("class T { tags: string[] = []; n = 0; } const ts: T[] = []; ts.push(new T());").join("\n")).toMatch(/tags is an array of something other/);
  });
  it("a text: one of the map's or one that is made, read, compared, added to, the row owning its block", () => {
    const sim = run("class Wave { name: string; constructor(name: string, public n: number) { this.name = name; } get title() { return `${this.name} (${this.n})`; } } const waves: Wave[] = []; let k = 2; waves.push(new Wave(\"Scouts\", 1)); waves.push(new Wave(`Wave ${k}`, k)); waves[1].name += \"!\"; waves[0].name = waves[1].name + \"?\"; if (waves[1].name == \"Wave 2!\") print(\"same\"); for (const w of waves) print(w.title); const { name } = waves[0]; waves[0].name = \"x\"; print(`${name} ${waves[0].name.length}`);");
    expect(shown(sim)).toEqual(["same", "Wave 2!? (1)", "Wave 2! (2)", "Wave 2!? 1"]);
    expect(sim.faults).toEqual([]);
  });
  it("texts go with their rows through a sort and a filter, and their blocks go back with the rows", () => {
    const r = compile("class Line { text: string; constructor(public n: number) { this.text = `line ${n}`; } } let turn = 0; let last = \"\"; while (turn < 60) { const lines: Line[] = []; for (let i = 0; i < 4; i++) lines.push(new Line(turn * 10 + 3 - i)); lines.sort((a, b) => a.n - b.n); const even = lines.filter((l) => l.n % 2 == 0); even[0].text += \"+\"; last = `${lines[0].text} ${even[0].text} ${lines[1].text}`; lines.pop(); lines[0] = new Line(7); lines.length = 1; turn++; } print(last);");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings, heapCells: 96 });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["line 590 line 590+ line 591"]);
  });
  it("a record written out holds a text too", () => {
    const sim = run("const rows = [{ label: \"a\", n: 1 }, { label: \"b\", n: 2 }]; let k = 5; rows[1].label = `b${k}`; rows.push({ label: \"c\", n: 3 }); print(`${rows[0].label}${rows[1].label}${rows[2].label}`);");
    expect(shown(sim)).toEqual(["ab5c"]);
  });
  it("an array field starts over when it is assigned", () => {
    const sim = run("class Bag { items: number[] = []; clear() { this.items = []; } } const b = new Bag(); b.items.push(1); b.items.push(2); b.clear(); b.items.push(3); print(`${b.items.length} ${b.items[0]}`);");
    expect(shown(sim)).toEqual(["1 3"]);
  });
});

describe("a method is a function", () => {
  it("called from the second call on, one copy an instance", () => {
    const r = compile(`${COUNTER} const a = new Counter(2); a.bump(); a.bump(); a.bump(); print(\`\${a.n}\`);`);
    const fns = r.ir.flatMap((p) => p.functions ?? []);
    expect(fns.map((f) => f.name)).toEqual(["Counter.bump"]);
    expect(shown(simulatePrograms(r.ir, 1, { strings: r.strings }))).toEqual(["6"]);
  });
  it("that may call itself", () => {
    const sim = run("class M { calls = 0; fib(n: number): number { this.calls++; if (n < 2) return n; return this.fib(n - 1) + this.fib(n - 2); } } const m = new M(); let n = 10; print(`${m.fib(n)} ${m.calls}`);");
    expect(shown(sim)).toEqual(["55 177"]);
  });
  it("that gives a text, a unit or a boolean, and takes a text", () => {
    const sim = run("class Tag { label = \"?\"; n = 0; rename(to: string) { this.label = to; } get shown(): string { return `[${this.label} ${this.n}]`; } big(): boolean { return this.n > 5; } who(): Unit | null { return null; } } const t = new Tag(); let k = 7; t.rename(`w${k}`); t.n = k; print(t.shown); if (t.big() && !t.who()) print(\"big\");");
    expect(shown(sim)).toEqual(["[w7 7]", "big"]);
  });
  it("that sleeps is inlined where it is called", () => {
    const sim = run("class T { n = 0; wait() { sleep(frames(2)); this.n++; } } const t = new T(); t.wait(); t.wait(); print(`${t.n}`);", "", 8);
    expect(shown(sim)).toEqual(["2"]);
  });
});

describe("what is said when a class cannot be the program's", () => {
  it("a class declared outside the program is the script's", () => {
    expect(messages("let n = 1; const c = new Outside(n);", "class Outside { constructor(public n: number) {} }").length).toBeGreaterThan(0);
  });
  it("a method that is not there", () => {
    expect(messages("class A { n = 0; } const a = new A(); (a as any).gone();").join("\n")).toMatch(/has no method gone/);
  });
});

describe("the probe", () => {
  it("says in the simulator what it expects to say in the game", () => {
    const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "classes.ts"), "utf8") }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    // The world makes the three Marines of step J as the game does, forty hit points each.
    const sim = new ProgramSimulation(r.ir, { strings: r.strings, table: (c) => (c.name === "unit.maxHp" ? 40 : undefined), locations: { 1: { left: 0, top: 0, right: 256, bottom: 256 } } }).run(24 * 46);
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]: /.test(t));
    const checked: string[] = [];
    for (const line of lines) {
      const m = /^([A-Z]): (.*?)(?: - [^(]*)? \(expect ([^)]*)\)$/.exec(line);
      if (!m || /your name/.test(m[3])) continue;
      expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
      checked.push(m[1]);
    }
    expect(checked).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(lines.some((t) => t.startsWith("K: Player 1 2 7"))).toBe(true);
    expect(sim.faults).toEqual([]);
    expect(sim.events.some((e) => e.text === "done")).toBe(true);
  });
});
