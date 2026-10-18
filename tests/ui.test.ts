/**
 * TrigScript 4, S2: a text as JSX, and `ui.lines`. A JSX text is put together piece by piece in a buffer of its own
 * (`buildText` / `built` in the IR); `ui.lines(P1, () => …)` is a task that shows it in the player's text lines every
 * frame. The interpreter here; `eud-build.test.ts` builds the same through eudplib. The simulator's log keeps the words
 * of a text and drops its colour codes, as it does for a player's colour.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { jsxAtBuild, JSX_FRAGMENT, builtText } from "../compiler/jsx";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (source: string): CompileResult => compileScript(ts, { "main.tsx": source }, NAMES, { lib: LIB });
const compile = (source: string): CompileResult => { const r = raw(source); expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]); return r; };
const messages = (source: string): string[] => raw(source).diagnostics.map((d) => d.message);
const run = (r: CompileResult, frames: number) => simulatePrograms(r.ir, frames, { strings: r.strings });
/** What was shown, as "frame:text", over that many frames; `codes` keeps the colour codes a text says itself. */
const printed = (r: CompileResult, frames: number, codes = false): string[] =>
  run(r, frames).events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => `${e.cycle}:${codes ? e.text : e.text?.replace(/[\x01-\x08\x0e-\x1f]/g, "")}`);
const program = (body: string) => `program(async () => {${body}});`;

describe("JSX texts", () => {
  it("an element is a text: its children, the program's values among them", () => {
    const r = compile(program(`
      let wave = 3;
      print(<line color="yellow">Wave {wave} of {wave * 2 + 4}</line>);
      wave++;
      print(<line>Wave {wave}</line>);`));
    expect(printed(r, 1)).toEqual(["0:Wave 3 of 10", "0:Wave 4"]);
    // Each line says its colour at its start: yellow, and white when it says none.
    expect(printed(r, 1, true)).toEqual(["0:\x03Wave 3 of 10", "0:\x04Wave 4"]);
  });

  it("lines are put one under another, and text between elements reads as React reads it", () => {
    const r = compile(program(`
      const score = 120;
      print(
        <>
          <line>Score {score}</line>
          <line>
            Lines   cleared:
            {4}
          </line>
        </>
      );`));
    expect(printed(r, 1)).toEqual(["0:Score 120\nLines   cleared:4"]);
  });

  it("&& and ?: are the program's if; true, false, null and undefined write nothing", () => {
    const r = compile(program(`
      for (let n = 0; n < 3; n++) {
        print(<>{n > 0 && <line>more</line>}<line>{n === 2 ? "two" : <span color="red">not two</span>}</line>{null}{false}</>);
      }`));
    expect(printed(r, 1)).toEqual(["0:not two", "0:more\nnot two", "0:more\ntwo"]);
  });

  it("map over the program's array is a loop; over a list of the script it is unrolled", () => {
    const r = compile(program(`
      const board = [1, 0, 8, 0];
      board[1] = 17;
      print(<line>{board.map((c) => <cell color={c} />)}</line>);
      print(<>{[0, 1, 2].map((y) => <line>row {y}</line>)}</>);
      const rows = [5, 6];
      rows.push(7);
      print(<>{rows.map((r, i) => <line>{i}: {r}</line>)}</>);`));
    expect(printed(r, 1)).toEqual(["0:■■■□", "0:row 0\nrow 1\nrow 2", "0:0: 5\n1: 6\n2: 7"]);
  });

  it("a cell known when the script is built, and a bar", () => {
    const r = compile(program(`
      let hp = 30;
      print(<line><cell color="orange" /><cell /> <bar value={hp} max={100} width={10} /></line>);
      hp = 250;
      print(<line><bar value={hp} max={100} width={4} color="red" /></line>);`));
    expect(printed(r, 1)).toEqual(["0:■□ ■■■□□□□□□□", "0:■■■■"]);
  });

  it("a JSX text kept in a variable is a copy: the next build does not change it", () => {
    const r = compile(program(`
      let n = 1;
      const first = <line>n is {n}</line>;
      n = 2;
      const second = <line>n is {n}</line>;
      print(first + " / " + second);`));
    expect(printed(r, 1)).toEqual(["0:n is 1 / n is 2"]);
  });
});

describe("ui.lines", () => {
  it("shows the text every frame, from the program's variables as they are", () => {
    const r = compile(program(`
      let score = 0;
      ui.lines(P1, () => <line>Score {score}</line>);
      for (let i = 0; i < 3; i++) { await sleep(frames(1)); score += 10; }`));
    expect(printed(r, 4)).toEqual(["0:Score 0", "1:Score 10", "2:Score 20", "3:Score 30"]);
  });

  it("gives back a Task that stops it", () => {
    const r = compile(program(`
      const board = ui.lines(P1, () => <line>up</line>);
      await sleep(frames(30));
      board.cancel();`));
    expect(printed(r, 60)).toEqual(["0:up", "24:up"]);
  });

  it("is put together again only when something it reads was written, and shown again every 24 frames before it fades", () => {
    const r = compile(program(`
      const cells = [0, 0, 0];
      let unrelated = 0;
      ui.lines(P1, () => <line>{cells.map((c) => <cell color={c} />)}</line>);
      start(async () => { await sleep(frames(3)); cells[1] = textColors.red; });
      for (let i = 0; i < 40; i++) { unrelated++; await sleep(frames(1)); }
      cells[2] = textColors.blue;`));
    // The task that writes was started after the view's, so the view has had its turn that frame: it shows the next.
    expect(printed(r, 50)).toEqual(["0:□□□", "4:□■□", "28:□■□", "40:□■■"]);
  });

  it("a view that reads the game is put together every frame", () => {
    const r = compile(program(`
      ui.lines(P1, () => <line>{random(1)}</line>);`));
    expect(printed(r, 3)).toEqual(["0:0", "1:0", "2:0"]);
  });

  it("shows to the player it is for", () => {
    const r = compile(program(`ui.lines(P3, () => <line>three</line>);`));
    const shown = run(r, 1).events.filter((e) => e.action.type === ActionType.DisplayText);
    expect(shown.map((e) => e.action.player)).toEqual([2]);
  });

  it("says what is wrong", () => {
    expect(messages(`program(() => { ui.lines(P1, () => <line>x</line>); });`).join("\n")).toMatch(/inside program\(async/);
    expect(messages(program(`ui.lines(P1, async () => <line>x</line>);`)).join("\n")).toMatch(/Promise<string>' is not assignable to type 'string'/);
    expect(messages(program(`print(<div>x</div>);`)).join("\n")).toMatch(/Property 'div' does not exist on type 'JSX.IntrinsicElements'/);
    expect(messages(program(`print(<line size={2}>x</line>);`)).join("\n")).toMatch(/Property 'size' does not exist/);
    expect(messages(program(`async function later() { await sleep(frames(1)); return 2; } print(<line>{await later()}</line>);`)).join("\n")).toMatch(/nothing inside it can wait/);
    expect(messages(program(`print(<line color="pink">x</line>);`)).join("\n")).toMatch(/"pink"' is not assignable/);
    expect(messages(program(`print(<line color={300}>x</line>);`)).join("\n")).toMatch(/color is one of white, grey, .* or a colour code from 0 to 255; got number 300/s);
    expect(messages(program(`const xs = [1]; xs.push(2); print(<line>{xs.map((x) => { print("a"); return <cell color={x} />; })}</line>);`)).join("\n")).toMatch(/gives back what is written for each item, and does nothing else/);
  });
});

describe("JSX when the script is built", () => {
  it("makes the text the game would put together", () => {
    const text = builtText(jsxAtBuild(JSX_FRAGMENT, null,
      jsxAtBuild("line", { color: "yellow" }, "Score ", 3, [1, 0].map((c) => jsxAtBuild("cell", { color: c ? "red" : 0 }))),
      jsxAtBuild("line", null, jsxAtBuild("span", { color: "red" }, "red"), " white")));
    // A colour code that another follows changes nothing and is left out.
    expect(text).toBe("\x03Score 3\x08■\x1E□\n\x08red\x04 white");
  });
});
