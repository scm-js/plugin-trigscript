/**
 * TrigScript 4, B4: `try` / `catch` / `finally` and `throw`. An error is put in flight — its class's code, its message,
 * its class's fields — and goes to the nearest `try` around it, out through inlined and called functions and recursion;
 * a finally runs on every way out. The bodies are run in JavaScript too, and compared.
 */
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
const run = (body: string, frames = 1) => { const r = compile(body); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const messages = (body: string) => raw(body).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
/** What JavaScript itself says of the same lines: the body is run as it is, `print` collecting. */
const js = (body: string): string[] => { const out: string[] = []; new Function("print", ts.transpile(body, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string) => { const sim = run(body); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body)); };

describe("throw and catch", () => {
  it("an Error thrown in the try goes to the catch, and what is after the throw does not run", () => {
    same("let n = 1; try { n = 2; throw new Error('boom'); n = 3; } catch (e) { print(`caught ${n}`); } print(`after ${n}`);");
  });
  it("the message, and the name", () => {
    same("let k = 7; try { throw new RangeError(`too far: ${k}`); } catch (e) { if (e instanceof Error) print(`${e.name}: ${e.message}`); }");
  });
  it("an error written out as a text: its name and its message", () => {
    same("let k = 3; try { throw new TypeError(`bad ${k}`); } catch (e) { print(`${e}`); print(String(e)); } try { throw new Error(); } catch (e) { print(`[${e}]`); }");
  });
  it("nothing thrown: the catch does not run", () => {
    same("let n = 0; try { n++; } catch { n = 100; } print(`${n}`);");
  });
});

describe("out through functions", () => {
  it("an inlined function's throw leaves it and the caller", () => {
    same("function check(n: number) { if (n > 3) throw new Error(`${n} is too many`); return n * 2; } let k = 5; let r = 0; try { r = check(2); r += check(k); r = 99; } catch (e) { if (e instanceof Error) print(e.message); } print(`${r}`);");
  });
  it("a called function (two calls) comes back with the error, and the call goes on to the catch", () => {
    const body = "let log = ''; function step(n: number) { log += `${n}`; if (n == 3) throw new Error('three'); log += '.'; } let k = 1; try { step(k); step(k + 1); step(k + 2); step(k + 3); } catch (e) { if (e instanceof Error) log += `!${e.message}`; } print(log);";
    expect((compile(body).ir[0].functions ?? []).some((f) => f.name === "step")).toBe(true);
    same(body);
  });
  it("a value worked out from a call that throws is never stored", () => {
    same("function half(n: number) { if (n % 2 == 1) throw new RangeError('odd'); return n / 2; } let a = 10; let k = 3; try { a = half(k) + 1; } catch { a = -a; } print(`${a}`);");
  });
  it("recursion: the error comes up through every frame, which each comes back", () => {
    same("function down(n: number, at: number): number { if (n == at) throw new Error(`hit ${n}`); if (n <= 0) return 0; return down(n - 1, at) + 1; } let k = 9; let got = 0; try { got = down(k, 4); } catch (e) { if (e instanceof Error) print(e.message); } got = down(k, -100) ; print(`${got}`);");
  });
  it("a stack that runs out is a RangeError, which a catch takes", () => {
    const body = "function deep(n: number): number { if (n > 1000000) return 0; return deep(n + 1) + 1; } let k = 0; try { k = deep(0); } catch (e) { if (e instanceof RangeError) print(`${e.name}: ${e.message}`); } print('still here');";
    same(body);
  });
});

describe("classes of error", () => {
  it("a class that extends Error, with a field, told apart with instanceof", () => {
    same(`class OutOfGold extends Error { constructor(public need: number) { super(\`need \${need} more\`); } }
      class Busy extends Error {}
      let gold = 30;
      function buy(cost: number) { if (cost > gold) throw new OutOfGold(cost - gold); if (cost == 0) throw new Busy('busy'); gold -= cost; }
      const costs = [10, 50, 0];
      for (const c of costs) {
        try { buy(c); print(\`bought \${c}\`); }
        catch (e) {
          if (e instanceof OutOfGold) print(\`\${e.message} (\${e.need})\`);
          else if (e instanceof Busy) print(\`busy: \${e.message}\`);
        }
      }`);
  });
  it("e.name is what the class gives itself, or Error", () => {
    same(`class A extends Error { name = 'A'; } class B extends A {} class C extends Error { constructor(m: string) { super(m); this.name = 'Cee'; } } class D extends Error {}
      let i = 0;
      while (i < 4) { try { if (i == 0) throw new A('a'); if (i == 1) throw new B('b'); if (i == 2) throw new C('c'); throw new D('d'); } catch (e) { if (e instanceof Error) print(\`\${e.name} \${e.message} \${e instanceof A ? 'A' : '-'}\`); } i++; }`);
  });
  it("an instance made first, and thrown later", () => {
    same("class Bad extends Error { constructor(public code: number) { super('bad'); } } let k = 4; try { const b = new Bad(k * 2); k = 0; throw b; } catch (e) { if (e instanceof Bad) print(`${e.code} ${k}`); }");
  });
});

describe("throwing on, and nesting", () => {
  it("throw e goes on to the outer catch, the same error", () => {
    same("class Mine extends Error { constructor(public n: number) { super('mine'); } } let k = 3; try { try { throw new Mine(k); } catch (e) { print('inner'); throw e; } } catch (e) { if (e instanceof Mine) print(`outer ${e.n} ${e.message}`); }");
  });
  it("an error thrown and caught inside a catch does not change the one it holds", () => {
    same("let k = 1; try { throw new Error('first'); } catch (e) { try { throw new Error('second'); } catch (f) { if (f instanceof Error) print(f.message); } if (e instanceof Error) print(e.message); }");
  });
  it("a new error thrown from a catch", () => {
    same("let k = 1; try { try { throw new Error('a'); } catch { throw new TypeError(`b${k}`); } } catch (e) { if (e instanceof TypeError) print(e.message); }");
  });
});

describe("finally", () => {
  it("runs after the try, after the catch, and on an error's way out", () => {
    same("let log = ''; let k = 0; try { log += 'a'; } finally { log += 'f'; } try { throw new Error('x'); } catch { log += 'c'; } finally { log += 'g'; } try { try { k = 1; throw new Error('y'); } finally { log += 'h'; } } catch (e) { if (e instanceof Error) log += e.message; } print(log);");
  });
  it("runs before a return, and the value is worked out before it", () => {
    same("let log = ''; let n = 5; function f(): number { try { return n * 2; } finally { n = 100; log += 'f'; } } const r = f(); print(`${r} ${n} ${log}`);");
  });
  it("runs before break and continue out of it", () => {
    same("let log = ''; let i = 0; while (i < 5) { i++; try { if (i == 2) continue; if (i == 4) break; log += `${i}`; } finally { log += '.'; } } print(log);");
  });
  it("a finally that throws its own error replaces the one in flight", () => {
    same("let k = 0; try { try { throw new Error('first'); } finally { k = 1; throw new Error('second'); } } catch (e) { if (e instanceof Error) print(`${e.message} ${k}`); }");
  });
  it("an error caught inside the finally leaves the one in flight to go on", () => {
    same("try { try { throw new RangeError('kept'); } finally { try { throw new Error('inside'); } catch { print('inner caught'); } } } catch (e) { if (e instanceof RangeError) print(e.message); }");
  });
});

describe("what nothing catches", () => {
  it("is said where it was thrown, and the program stops", () => {
    const sim = run("let k = 2; print('before'); if (k > 1) throw new RangeError(`k is ${k}`); print('after');", 3);
    expect(shown(sim)).toEqual(["before", "\x06TrigScript: uncaught RangeError: k is 2, line 1."]);
    expect(sim.faults.map((f) => [f.message, f.at.line])).toEqual([["Uncaught RangeError: k is 2", 1]]);
  });
});

const rawAsync = (body: string): CompileResult => compileScript(ts, { "main.ts": `program(async () => {${body}});` }, NAMES, { lib: LIB });
const printedAsync = (body: string, frames: number) => {
  const r = rawAsync(body);
  expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  const sim = simulatePrograms(r.ir, frames, { strings: r.strings });
  return { printed: sim.events.map((e) => `${e.cycle}:${e.text}`), faults: sim.faults.map((f) => f.message) };
};

describe("errors and waiting", () => {
  it("a try that waits: the error thrown frames later is caught", () => {
    expect(printedAsync("let n = 0; try { while (true) { n++; await sleep(frames(1)); if (n == 3) throw new Error(`at ${n}`); } } catch (e) { if (e instanceof Error) print(e.message); } print('after');", 6))
      .toEqual({ printed: ["3:at 3", "3:after"], faults: [] });
  });
  it("an error in a branch of Promise.all stops the others and goes to the catch around it", () => {
    expect(printedAsync("let a = 0; let b = 0; try { await Promise.all([(async () => { while (true) { a++; await sleep(frames(1)); } })(), (async () => { await sleep(frames(2)); throw new Error('b failed'); })()]); } catch (e) { if (e instanceof Error) print(`${e.message} ${a}`); } await sleep(frames(2)); print(`${a}`);", 8))
      .toEqual({ printed: ["2:b failed 3", "4:3"], faults: [] });
  });
  it("in a task: the task ends and says so; the program goes on", () => {
    expect(printedAsync("async function worker() { await sleep(frames(1)); throw new Error('worker failed'); } start(worker()); let n = 0; while (n < 3) { n++; await sleep(frames(1)); } print(`done ${n}`);", 6))
      .toEqual({ printed: ["1:\x06TrigScript: uncaught Error: worker failed, line 1.", "3:done 3"], faults: ["Uncaught Error: worker failed"] });
  });
  it("in a handler of an event: that turn gives up, and the next is heard", () => {
    const r = rawAsync("let n = 0; on.key('F7', (p) => { n++; if (n == 1) throw new Error('first press'); print(`press ${n}`); });");
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    const sim = new ProgramSimulation(r.ir, { strings: r.strings, players: [0] });
    sim.run(2).press("F7", 0).run(3).press("F7", 0).run(3);
    expect(sim.events.map((e) => e.text)).toEqual(["\x06TrigScript: uncaught Error: first press, line 1.", "press 2"]);
    expect(sim.faults.map((f) => f.message)).toEqual(["Uncaught Error: first press"]);
  });
});

describe("refused", () => {
  it("a throw of something that is not an error", () => {
    expect(messages("let k = 1; throw k;")).toEqual([expect.stringContaining("throw takes an error")]);
  });
  it("a return or a break out of a finally", () => {
    expect(messages("function f() { try { return 1; } finally { return 2; } } let k = f();")).toEqual([expect.stringContaining("does not return")]);
    expect(messages("let i = 0; while (i < 3) { i++; try { } finally { for (const x of [1, 2]) { if (x == i) break; } } }")).toEqual([]);
    expect(messages("let i = 0; while (i < 3) { i++; try { } finally { break; } }")).toEqual([expect.stringContaining("does not break")]);
  });
});

describe("what an error leaves behind", () => {
  it("out of a loop over a text and a loop over a Map, again and again: nothing is kept", () => {
    const body = "const seen = new Map<number, number>(); let k = 0; while (k < 3) { seen.set(k, k * 10); k++; } let s = `ab${k}`; let n = 0; let i = 0; while (i < 400) { try { for (const ch of s) { if (ch == 'b') throw new Error('b'); } } catch { n++; } try { for (const [key, v] of seen) { if (v == 10) throw new Error('ten'); } } catch { n++; } seen.delete(i % 3); seen.set(i % 3, (i % 3) * 10); i++; } print(`${n} ${seen.size}`);";
    same(body);
    // Every turn's copy of the text went back: the heap's top is where a few blocks put it, not 400 turns' worth.
    expect(run(body).heap.top).toBeLessThan(100);
  });
});
