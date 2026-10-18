/**
 * The standard library's "trigscript/cutscene" (TrigScript 4): a camera that looks, glides and shakes, a unit sent
 * somewhere and waited for, a line of a scene, and a scene a key skips — in the simulator. The lifted game has its own:
 * probes/game-cutscene.ts.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const HEAD = `import { program, print, start, sleep, frames, units, P1, type Unit } from "trigscript";\nimport { Camera, walk, line, play, SECOND } from "trigscript/cutscene";\n`;
const compile = (text: string): CompileResult => { const r = compileScript(ts, { "main.ts": HEAD + text }, NAMES, { lib: LIB }); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const shown = (text: string, frames: number, press?: { key: string; at: number }) => {
  const r = compile(text);
  const sim = simulatePrograms(r.ir, frames, { strings: r.strings, ...(press ? { inputs: [{ frame: press.at, key: press.key, player: 0 }] } : {}) } as never);
  return sim.events.filter((e) => e.text).map((e) => e.text);
};

describe("trigscript/cutscene", () => {
  it("the camera glides to a point and shakes back to it", () => {
    expect(shown("program(async () => { const cam = new Camera(100, 200); await cam.pan(740, 520, SECOND); print(`${cam.x} ${cam.y}`); await cam.shake(5, 10); print(`${cam.x} ${cam.y}`); });", 60)).toEqual(["740 520", "740 520"]);
  });
  it("a line: the words in the middle of the screen, then the scene goes on after its frames", () => {
    expect(shown("program(async () => { await line(units.TerranMarine, 'Hold the line.', 12); print('next'); });", 30)).toEqual(["Hold the line.", "next"]);
  });
  it("a scene played whole", () => {
    expect(shown("async function s() { await sleep(frames(5)); print('in'); } program(async () => { const skipped = await play(P1, start(s())); print(skipped ? 'skipped' : 'whole'); });", 20)).toEqual(["in", "whole"]);
  });
  it("walk gives up after its limit when the unit does not get there", () => {
    expect(shown("program(async () => { let u: Unit | null = null; const got = u ? await walk(u, 10, 10, 8, 6) : false; print(got ? 'there' : 'not'); });", 20)).toEqual(["not"]);
  });
});
