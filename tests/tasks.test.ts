/**
 * TrigScript 4, slice B1's second part: tasks. `start(wave(n))` runs a copy of an async function's body beside the program,
 * its parameters copies of the arguments; each start has slots, a row of the body's cells each (`start` in the IR). The
 * interpreter here; `eud-build.test.ts` builds the same through eudplib, and `probes/game-tasks.ts` runs it in the game.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, options = ""): CompileResult => compileScript(ts, { "main.ts": `program(async () => {${body}}${options ? `, ${options}` : ""});` }, NAMES, { lib: LIB });
const compile = (body: string, options = ""): CompileResult => { const r = raw(body, options); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const messages = (body: string): string[] => raw(body).diagnostics.map((d) => d.message);
const run = (r: CompileResult, frames: number) => simulatePrograms(r.ir, frames, { strings: r.strings });
/** What the program printed, as "frame:text", over that many frames. */
const printed = (r: CompileResult, frames: number): string[] =>
  run(r, frames).events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`);

describe("tasks", () => {
  it("start() runs a task beside the program, from the frame it starts in, after the program's turn", () => {
    const r = compile(`
      async function tick(name: string, n: number) { for (let i = 0; i < n; i++) { print(\`\${name} \${i}\`); await sleep(frames(2)); } }
      start(tick("a", 3));
      print("program");
      await sleep(frames(1));
      start(tick("b", 2));
      print("started b");`);
    expect(printed(r, 10)).toEqual(["0:program", "0:a 0", "1:started b", "1:b 0", "2:a 1", "3:b 1", "4:a 2"]);
  });

  it("the arguments are worked out at the start: each task keeps its own copy, and its own variables", () => {
    const r = compile(`
      async function count(n: number) { let left = n; while (left > 0) { await sleep(frames(1)); left--; } print(\`done \${n}\`); }
      for (let n = 3; n >= 1; n--) start(count(n));`);
    expect(printed(r, 10)).toEqual(["1:done 1", "2:done 2", "3:done 3"]);
  });

  it("the tasks run on after the program ends", () => {
    const r = compile(`
      start(async () => { await sleep(frames(5)); print("later"); });
      print("end");`);
    const sim = run(r, 10);
    expect(sim.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:end", "5:later"]);
    expect(sim.finished()).toBe(true);
  });

  it("void wave() starts a task too, as JavaScript leaves a promise running that nothing keeps", () => {
    const r = compile(`
      async function later() { await sleep(frames(2)); print("later"); }
      void later();
      print("now");`);
    expect(printed(r, 5)).toEqual(["0:now", "2:later"]);
  });

  it("a Task: running, cancel() and await", () => {
    const r = compile(`
      async function forever() { let i = 0; while (true) { i++; await sleep(frames(1)); } }
      async function short() { await sleep(frames(3)); }
      const f = start(forever());
      const s = start(short());
      print(\`\${f.running ? 1 : 0} \${s.running ? 1 : 0}\`);
      await s;
      print(\`short ended \${s.running ? 1 : 0}\`);
      f.cancel();
      print(\`cancelled \${f.running ? 1 : 0}\`);
      await f;
      print("awaited");`);
    expect(printed(r, 10)).toEqual(["0:1 1", "4:short ended 0", "4:cancelled 0", "4:awaited"]);
  });

  it("a start with every slot running starts nothing and says so; a slot is free again once its task ends", () => {
    const r = compile(`
      async function wait() { await sleep(frames(2)); print("ended"); }
      let k = 3;
      for (let i = 0; i < k; i++) { const t = start(wait(), { max: 2 }); print(\`\${t.running ? 1 : 0}\`); }
      await sleep(frames(3));
      start(wait(), { max: 2 });`);
    const sim = run(r, 10);
    expect(sim.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:1", "0:1", "0:0", "2:ended", "2:ended", "5:ended"]);
    expect(sim.faults.map((f) => f.message)).toEqual(["wait did not start: all 2 of this start's tasks are running. start(…, { max: … }) lets more run at once."]);
  });

  it("a task awaits Promise.all of its own, and starts tasks of its own", () => {
    const r = compile(`
      async function inner(n: number) { await sleep(frames(n)); print(\`inner \${n}\`); }
      async function outer() {
        await Promise.all([sleep(frames(1)), (async () => { await sleep(frames(2)); print("branch"); })()]);
        start(inner(1));
        print("outer");
      }
      start(outer());
      start(outer());`);
    expect(printed(r, 10)).toEqual(["2:branch", "2:outer", "2:branch", "2:outer", "3:inner 1", "3:inner 1"]);
  });

  it("each player's tasks are their own in a per-player program", () => {
    const r = compile(`
      async function hello(n: number) { await sleep(frames(n)); print(\`hello \${n}\`); }
      let mine = 0;
      start((async () => { for (let i = 0; i < 3; i++) { mine++; await sleep(frames(1)); } })());
      start(hello(2));
      await sleep(frames(4));
      print(\`mine \${mine}\`);`, "{ owner: AllPlayers }");
    const sim = simulatePrograms(r.ir, 10, { strings: r.strings, players: [0, 1] });
    const lines = sim.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.player}:${e.text}`);
    expect(lines).toEqual(["2:0:hello 2", "2:1:hello 2", "4:0:mine 3", "4:1:mine 3"]);
  });

  it("what the language says", () => {
    expect(messages(`async function w() { await sleep(frames(1)); } w();`)).toEqual(["w() gives a promise, and nothing waits for it here: await w() — or, to leave it running beside the program, start(w())."]);
    expect(messages(`start(sleep(frames(1)));`)[0]).toContain("start() takes a call of an async function");
    expect(messages(`async function w(n: number) { await sleep(frames(n)); start(w(n)); } start(w(1));`)[0]).toContain("calls itself");
    expect(messages(`async function a() { let mine = 1; await sleep(frames(1)); start(async () => { print(\`\${mine}\`); }); } start(a());`)).toEqual(["This task uses mine, a variable of the task it is started from: which of that task's copies it would find is not settled. Hand it over as an argument instead — start(f(mine))."]);
    expect(messages(`async function show(n: number) { print(\`\${n}\`); } async function a() { let mine = 1; await sleep(frames(1)); start(show(mine)); } start(a());`)).toEqual([]);
    expect(messages(`let n = 3; for (let i = 0; i < n; i++) start(async () => { await sleep(frames(1)); print(\`\${i}\`); });`)).toEqual(["This task reads i, which the loop around the start() changes: JavaScript gives each turn its own, and here the task would find it as it is when it reads it. Hand it over as an argument instead — an async function that takes it, start(f(i))."]);
    expect(messages(`for (const i of [1, 2]) start(async () => { await sleep(frames(i)); print(\`\${i}\`); });`)).toEqual([]);
    expect(messages(`start(async () => {}, { max: 0 });`)).toEqual(["start()'s options are written out, as { max: 40 }: how many of this start's tasks can run at once, a whole number from 1 to 255."]);
  });
});
