/**
 * Classes (slice 8½): a class declared in a program is a record and its methods functions with the instance first,
 * everything about the class settled when the script is built. The interpreter here; `eud-build.test.ts` builds the
 * same through eudplib.
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
  it("holds one class", () => {
    expect(messages("class A { n = 0; } class B extends A { m = 0; } const xs: A[] = []; xs.push(new A()); xs.push(new B());").join("\n")).toMatch(/holds one class/);
  });
  it("of a class others extend holds the one that is put into it", () => {
    const sim = run("class A { n = 1; size() { return this.n; } } class B extends A { m = 5; size() { return this.n + this.m; } } const xs: A[] = []; xs.push(new B()); print(`${xs[0].size()}`);");
    expect(shown(sim)).toEqual(["6"]);
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
