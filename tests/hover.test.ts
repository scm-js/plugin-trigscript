/**
 * What the editor's hover says of a program's variable, from the variables a compile
 * reports: a `number` is signed, a `u32` is not, the small widths stop at their ends, and
 * a text is not described as a number.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, describeVariable } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();

describe("the hover of a program's variable", () => {
  const r = compileScript(ts, { "main.ts": `
program(() => {
  let n = 3;
  let mask: u32 = 0xffffffff;
  let small: u8 = 1;
  let wide: u16 = 1;
  let on = false;
  let label = "Wave " + String(n);
  n -= 10; mask = u32(n); small++; wide++; on = !on;
  print(label);
});
` }, NAMES, { lib: LIB });
  const said = (name: string) => {
    const v = r.variables.find((x) => x.name === name);
    if (!v) throw new Error(`no variable ${name}: ${r.diagnostics.map((d) => d.message).join("; ")}`);
    return describeVariable(v);
  };

  it("compiles", () => expect(r.diagnostics.map((d) => d.message)).toEqual([]));
  it("says a number is signed", () => {
    expect(said("n")).toContain("−2 147 483 648 … 2 147 483 647");
    expect(said("n")).not.toContain("4 294 967 295");
  });
  it("says a u32 is not", () => expect(said("mask")).toMatch(/^a u32 number \(0 … 4 294 967 295, wrapping/));
  it("says the small widths stop", () => {
    expect(said("small")).toBe("a u8 number (0 … 255, stopping at either end)");
    expect(said("wide")).toBe("a u16 number (0 … 65535, stopping at either end)");
  });
  it("says a boolean and a text are what they are", () => {
    expect(said("on")).toBe("a boolean");
    expect(said("label")).toMatch(/^a text/);
    expect(said("label")).not.toContain("number");
  });
});
