import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIGSCRIPT_PY } from "../compiler/generated/trigscriptPy";
import { IR_VERSION } from "../compiler/ir";

describe("the embedded Python lowering", () => {
  it("is python/trigscript.py as it stands (run scripts/embed-python.mts after editing it)", () => {
    expect(TRIGSCRIPT_PY).toBe(readFileSync(join(import.meta.dirname, "..", "python", "trigscript.py"), "utf8"));
  });
  it("reads the IR version the compiler writes", () => {
    const m = /^IR_VERSION\s*=\s*(\d+)/m.exec(TRIGSCRIPT_PY);
    expect(m, "python/trigscript.py names IR_VERSION").not.toBeNull();
    expect(Number(m![1])).toBe(IR_VERSION);
  });
});
