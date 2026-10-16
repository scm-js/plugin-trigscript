/**
 * TrigScript 4, slice B1: async functions and await. An async function is inlined where it is awaited, so where it waits
 * the program waits; `Promise.all` / `race` / `any` run their branches side by side, each a coroutine of its own inside
 * the program's frame (`parallel` in the IR). The interpreter here; `eud-build.test.ts` builds the same through eudplib.
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
const messages = (body: string, source?: string): string[] => (source !== undefined ? compileScript(ts, { "main.ts": source }, NAMES, { lib: LIB }) : raw(body)).diagnostics.map((d) => d.message);
/** What the program printed, as "frame:text", over that many frames. */
const printed = (r: CompileResult, frames: number): string[] =>
  simulatePrograms(r.ir, frames, { strings: r.strings }).events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.text}`);

describe("async functions and await", () => {
  it("an awaited async function waits where it sleeps and gives back its value", () => {
    const r = compile(`
      async function wave(n: number): Promise<number> { print(\`wave \${n}\`); await sleep(frames(2)); return n * 10; }
      const a = await wave(1);
      print(\`got \${a}\`);
      const b = await wave(2);
      print(\`got \${b}\`);`);
    expect(printed(r, 10)).toEqual(["0:wave 1", "2:got 10", "2:wave 2", "4:got 20"]);
  });

  it("an async function is never one called copy: it is inlined at each await, as a function that sleeps always was", () => {
    const r = compile(`
      async function pause(): Promise<void> { await sleep(frames(1)); }
      await pause(); await pause(); print("done");`);
    expect(r.ir[0].functions ?? []).toEqual([]);
    expect(printed(r, 5)).toEqual(["2:done"]);
  });

  it("until() asks every frame and goes on in the frame its answer is true — at once when it already is", () => {
    const r = compile(`
      let n = 0;
      await until(() => n === 0);
      print("at once");
      await Promise.all([
        (async () => { for (let i = 0; i < 3; i++) { n++; await sleep(frames(1)); } })(),
        (async () => { await until(() => n >= 3); print(\`n \${n}\`); })(),
      ]);
      print("both");`);
    expect(printed(r, 10)).toEqual(["0:at once", "2:n 3", "3:both"]);
  });

  it("Promise.all goes on in the frame its last branch ends; the branches run in order, each with its own sleeps", () => {
    const r = compile(`
      await Promise.all([
        (async () => { print("a0"); await sleep(frames(3)); print("a3"); })(),
        (async () => { print("b0"); await sleep(frames(1)); print("b1"); await sleep(frames(1)); print("b2"); })(),
        sleep(frames(2)),
      ]);
      print("all");`);
    expect(printed(r, 10)).toEqual(["0:a0", "0:b0", "1:b1", "2:b2", "3:a3", "3:all"]);
  });

  it("Promise.race gives the value of the first branch to end, and the others stop where they are", () => {
    const r = compile(`
      async function wave(n: number): Promise<number> { await sleep(frames(n)); return n; }
      const a = await Promise.race([wave(5), sleep(frames(3)).then(() => -1)]);
      print(\`a \${a}\`);
      const b = await Promise.race([wave(2), sleep(frames(3)).then(() => -1), (async () => { await sleep(frames(4)); print("late"); return 0; })()]);
      print(\`b \${b}\`);`);
    expect(printed(r, 20)).toEqual(["3:a -1", "5:b 2"]);
  });

  it("a race of booleans, and Promise.any as a race (nothing in a program fails)", () => {
    const r = compile(`
      let hp = 3;
      const ok = await Promise.any([until(() => hp <= 0).then(() => false), sleep(frames(2)).then(() => true)]);
      if (ok) print("held");`);
    expect(printed(r, 5)).toEqual(["2:held"]);
  });

  it("the plan's wave loop: a race in a for loop, the lost wave stopped each time", () => {
    const r = compile(`
      let left = 0;
      async function wave(n: number): Promise<boolean> {
        left = n;
        print(\`wave \${n}\`);
        while (left > 0) { left--; await sleep(frames(1)); }
        return true;
      }
      for (let n = 1; n <= 3; n++) {
        const done = await Promise.race([wave(n * 2), sleep(frames(5)).then(() => false)]);
        if (!done) { print(\`lost \${n}\`); break; }
        print(\`cleared \${n}\`);
      }`);
    expect(printed(r, 30)).toEqual(["0:wave 2", "2:cleared 1", "2:wave 4", "6:cleared 2", "6:wave 6", "11:lost 3"]);
  });

  it("each player of a per-player program has its own branches and its own place in them", () => {
    const r = compile(`
      let mine = 0;
      await Promise.all([
        (async () => { for (let i = 0; i < 3; i++) { mine++; await sleep(frames(1)); } })(),
        sleep(frames(1)),
      ]);
      print(\`mine \${mine}\`);`, "{ owner: AllPlayers }");
    const sim = simulatePrograms(r.ir, 10, { strings: r.strings, players: [0, 1] });
    const lines = sim.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${e.player}:${e.text}`);
    expect(lines).toEqual(["3:0:mine 3", "3:1:mine 3"]);
  });

  it("sleep() on its own still pauses a program that is not async", () => {
    const r = compileScript(ts, { "main.ts": `program(() => { sleep(frames(2)); print("on"); });` }, NAMES, { lib: LIB });
    expect(r.diagnostics).toEqual([]);
    expect(printed(r, 5)).toEqual(["2:on"]);
  });
});

describe("async functions and await: what is said", () => {
  it("a promise nothing waits for", () => {
    expect(messages(`sleep(frames(1));`)).toEqual(["sleep() gives a promise, and nothing waits for it here: await sleep(frames(1)). A program cannot yet start something and leave it running beside it."]);
    expect(messages(`async function f(): Promise<void> { await sleep(frames(1)); } f();`)).toEqual(["f() gives a promise, and nothing waits for it here: await f(). A program cannot yet start something and leave it running beside it."]);
    expect(messages("", `program(() => { async function f(): Promise<void> { await sleep(frames(1)); } f(); });`)).toEqual(["f() waits, and a program waits in an async function: program(async () => { … await f(); … })."]);
  });

  it("what Promise.all and race take, and what they give", () => {
    expect(messages(`await Promise.all([]);`)).toEqual(["Promise.all([]) has nothing to wait for."]);
    expect(messages(`const ps = [sleep(frames(1))]; await Promise.all(ps);`)).toContain("Promise.all() takes a list written where it is called: Promise.all([wave(1), sleep(seconds(90))]).");
    expect(messages(`const v = await Promise.race([sleep(frames(1)), sleep(frames(2)).then(() => 1)]); print(\`\${v}\`);`)).toContain("v would be number | void: Promise.race gives the value of the branch that ends first, so every branch gives one. Give a sleep() or an until() a value with .then(() => …).");
    expect(messages(`const v: number = await Promise.all([sleep(frames(1)).then(() => 1)]) as never; print(\`\${v}\`);`)).toEqual(["Promise.all() gives no value yet: await it as a statement, and keep what each branch finds in variables of the program."]);
  });

  it("await where the game cannot leave and come back", () => {
    expect(messages(`for (const u of unitsAt(locations.Anywhere, { owner: P1 })) { await sleep(frames(1)); u.kill(); }`).join("\n")).toContain("sleep() inside a loop over units");
    expect(messages(`[1, 2].forEach(async (x) => { await sleep(frames(x)); });`).join("\n")).toContain("An async function given to forEach()");
  });
});
