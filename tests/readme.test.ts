/**
 * The README's examples compile. Every fenced `ts` block is compiled with the real compiler against a map that
 * has the locations the examples name; a block that calls neither `program()` nor `trigger()` is lines of a
 * program's body, and is compiled inside one. A block of several
 * files says so with a `// name.ts` line before each.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { scriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = scriptNames({ locations: ["Beacon Alpha", "Beacon", "Spawn", "Pen", "Exit", "Gate", "Base", "Cursor"].map((name, index) => ({ index, name })) });

function blocks(): { line: number; code: string }[] {
  const lines = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8").split("\n");
  const out: { line: number; code: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```ts") continue;
    const from = i + 1;
    while (lines[++i].trim() !== "```");
    out.push({ line: from + 1, code: lines.slice(from, i).join("\n") });
  }
  return out;
}

function files(code: string): Record<string, string> {
  if (!/^\/\/ \w+\.ts$/m.test(code)) {
    if (/\b(program|trigger)\(/.test(code)) return { "main.ts": code };
    return { "main.ts": `program(() => {\n${code}\n});` };
  }
  const out: Record<string, string> = {};
  let file = "";
  for (const l of code.split("\n")) {
    const named = /^\/\/ (\w+\.ts)$/.exec(l);
    if (named) { file = named[1]; out[file] = ""; } else if (file) out[file] += `${l}\n`;
  }
  return out;
}

describe("the README's examples", () => {
  const all = blocks();
  it("are there", () => expect(all.length).toBeGreaterThan(20));
  it.each(all.map((b) => [b.line, b.code] as const))("README.md:%i compiles, and makes a trigger or a program", (_line, code) => {
    const r = compileScript(ts, files(code), NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => `${d.file}:${d.line} ${d.message}`)).toEqual([]);
    expect(r.triggers.length + (r.ir?.length ?? 0)).toBeGreaterThan(0);
  });
  it("a print with `// what it shows` beside it shows that in Simulate", () => {
    for (const { line, code } of all) {
      const wanted = [...code.matchAll(/\bprint\(.*\);\s*\/\/ (.+)$/gm)].map((m) => m[1].trim());
      if (wanted.length === 0 || !code.includes("program(")) continue;
      const r = compileScript(ts, files(code), NAMES, { lib: LIB });
      const sim = simulatePrograms(r.ir, 30, { strings: r.strings });
      expect([line, sim.faults]).toEqual([line, []]);
      for (const text of wanted) expect([line, sim.events.map((e) => e.text)]).toEqual([line, expect.arrayContaining([text])]);
    }
  });
});
