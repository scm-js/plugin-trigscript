/**
 * `memory` (TrigScript 4, B7): cells of the game's memory with no other word in the language, each a table cell with
 * no index — what the front end makes of a read and a write, what the declarations refuse, what they say.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { generateDeclarations } from "../compiler/declarations";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import type { Stmt } from "../compiler/ir";
import { MEMORY_FIELDS } from "../compiler/memory";
import { ProgramSimulation } from "../compiler/simulateIr";
import { placeOfAddress } from "../compiler/eudError";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compileFile = (src: string): CompileResult => compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
const compile = (body: string): CompileResult => {
  const r = compileFile(`program(() => {${body}});`);
  expect(r.diagnostics.map((d) => `${d.line}:${d.message}`)).toEqual([]);
  return r;
};
const errors = (body: string): string[] => compileFile(`program(() => {\n${body}\n});`).diagnostics.map((d) => `${d.line}:${d.message}`);

describe("memory", () => {
  it("a write is a table write of one cell at the field's address", () => {
    const r = compile(`memory.vision.countdown = 1;`);
    expect(r.ir[0].body[0]).toMatchObject({ kind: "tableWrite", cell: { name: "memory.vision.countdown", base: 0x51ce98, stride: 0, index: 0, width: 4 }, value: { kind: "const", value: 1 } });
  });

  it("a read is a table read, in arithmetic and in a condition", () => {
    const r = compile(`let t = memory.game.frame * 2; if (memory.game.frame % 24 == 0) t = 1;`);
    const json = JSON.stringify(r.ir[0].body);
    expect(json.match(/"kind":"tableRead"/g)?.length).toBe(2);
    expect(json).toContain(`"name":"memory.game.frame"`);
  });

  it("+= reads and writes the same cell", () => {
    const r = compile(`memory.vision.countdown += 5;`);
    const s = r.ir[0].body[0] as Extract<Stmt, { kind: "tableWrite" }>;
    expect(s.kind).toBe("tableWrite");
    expect(JSON.stringify(s.value)).toContain(`"name":"memory.vision.countdown"`);
  });

  it("in the simulator a write is kept and the game's frame count is the frame", () => {
    const r = compile(`let at = 0; let kept = 0; memory.vision.countdown = 7; kept = memory.vision.countdown; sleep(frames(5)); at = memory.game.frame;`);
    const sim = new ProgramSimulation(r.ir, {}).run(20);
    expect(sim.value("kept")).toBe(7);
    expect(Number(sim.value("at"))).toBeGreaterThanOrEqual(5);
  });

  it("a field the game keeps for itself is readonly: a type error before anything is built", () => {
    expect(errors(`memory.game.frame = 0;`)).toEqual(["2:Cannot assign to 'frame' because it is a read-only property."]);
  });

  it("outside a program it says where it belongs", () => {
    const r = compileFile(`const n = memory.game.frame + 1;`);
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/memory\.game\.frame is a value the game holds/);
  });

  it("the hover says what Remastered does with each field, and where it is", () => {
    const d = generateDeclarations(NAMES);
    for (const f of MEMORY_FIELDS) {
      expect(d).toContain(f.remastered);
      expect(d).toContain(`@address 0x${f.base.toString(16).toUpperCase()}`);
    }
    expect(d).toMatch(/readonly frame: number;/);
    expect(d).toMatch(/\n {2}countdown: number;/);
  });

  it("an EUD error at a field's address is named by the field", () => {
    expect(placeOfAddress(0x51ce98)).toBe("memory.vision.countdown");
    expect(placeOfAddress(0x57f23e)).toBe("memory.game.frame");
  });
});
