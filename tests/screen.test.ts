/**
 * The standard library's "trigscript/screen" (TrigScript 4): a screen of pixels drawn in a program — rectangles, lines,
 * sprites, digits — shown on the map as units (`present`, which makes and takes away only what changed) and in the text
 * lines as squares (`ScreenView`). Run in the simulator.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compile = (source: string): CompileResult => {
  const r = compileScript(ts, { "main.tsx": source }, NAMES, { lib: LIB });
  expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  return r;
};
const sim = (r: CompileResult) => new ProgramSimulation(r.ir, { strings: r.strings, players: [0] });
/** What a ScreenView showed: a line a row, # for a filled square and . for an empty one. */
const pictures = (s: ProgramSimulation): string[] => s.events.filter((e) => e.action.type === ActionType.DisplayText).map((e) => (e.text ?? "").replace(/[\x01-\x08\x0e-\x1f]/g, "").replace(/■/g, "#").replace(/□/g, "."));
const made = (s: ProgramSimulation) => s.events.filter((e) => e.action.type === ActionType.CreateUnit);
const taken = (s: ProgramSimulation) => s.events.filter((e) => e.action.type === ActionType.RemoveUnitAt);

describe("trigscript/screen", () => {
  it("rect, line, a sprite and set, shown in the text lines", () => {
    const r = compile(`
      import { Screen, ScreenView, sprite } from "trigscript/screen";
      const SHIP = sprite([".1.", "111", "1.1"]);
      program(async () => {
        const s = new Screen(0, 0, 8, 5);
        let k = 2;
        s.rect(0, 4, 8, 1, 5);
        s.line(0, 0, 7, 3, 2);
        s.blit(SHIP, k + 3, 1);
        s.set(k - 2, 3, 1);
        print(<ScreenView screen={s} width={8} height={5} />);
      });`);
    expect(pictures(sim(r).run(1))).toEqual([["##......", "..##..#.", "....####", "#....###", "########"].join("\n")]);
  });

  it("get reads a pixel, and 0 outside; set outside does nothing", () => {
    const r = compile(`
      import { Screen } from "trigscript/screen";
      program(async () => { const s = new Screen(0, 0, 4, 4); let k = 3; s.set(k, k, 6); s.set(k + 9, 0, 6); print(\`\${s.get(3, 3)} \${s.get(9, 0)} \${s.get(-1, 2)}\`); });`);
    expect(sim(r).run(1).events.map((e) => e.text)).toEqual(["6 0 0"]);
  });

  it("number draws a whole number's digits", () => {
    const r = compile(`
      import { Screen, ScreenView } from "trigscript/screen";
      program(async () => { const s = new Screen(0, 0, 7, 5); let k = 21; s.number(k - 4, 0, 0, 3); print(<ScreenView screen={s} width={7} height={5} />); });`);
    expect(pictures(sim(r).run(1))).toEqual([[".#..###", "##....#", ".#....#", ".#...#.", "###..#."].join("\n")]);
  });

  it("present makes a unit a pixel, in its colour's owner's name, then only what changed", () => {
    const r = compile(`
      import { Screen } from "trigscript/screen";
      program(async () => {
        const s = new Screen(4, 4, 3, 2);
        s.set(0, 0, 1); s.set(2, 1, 7);
        s.present();
        await sleep(frames(1));
        s.set(0, 0, 2); s.set(1, 0, 1);
        s.present();
        await sleep(frames(1));
        s.present();
      });`);
    const run = sim(r).run(1);
    // Colour 1 is P3's (slot 2), colour 7 is yours (P1, slot 0).
    expect(made(run).map((e) => e.action.player)).toEqual([2, 0]);
    expect(taken(run)).toEqual([]);
    run.run(1);
    expect(made(run).map((e) => e.action.player)).toEqual([2, 0, 3, 2]);
    expect(taken(run).map((e) => e.action.player)).toEqual([2]);
    run.run(2);
    expect(made(run)).toHaveLength(4);
  });
});
