/**
 * Libraries of other plugins' (`compiler/libraries.ts`): TrigScript modules a plugin provides, imported by the
 * library's id ("stamps/patrol") as the standard library is by "trigscript/fog". Which modules join the script's
 * files, what they may import, and what a script is told when a library is not there.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { libraryImports, libraryProblem, type ScriptLibraries } from "../compiler/libraries";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";
import { MODULES } from "../examples/library/modules";
import { LIBRARIES_FOLDER, hashFiles, hashSources, pathOf, readFiles, readLibraries, withFiles, withLibraries } from "../script";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const STAMPS: ScriptLibraries = {
  stamps: {
    "index.ts": `export { double } from "./math/double";\nexport const NAME = "stamps";`,
    "math/double.ts": `export function double(n: number) { return n * 2; }`,
    "say.ts": `import { double } from "./math/double";\nexport function say(n: number) { print(\`stamps \${double(n)}\`); }`,
    "ticker.ts": `program(() => { print("ticker"); });\nexport const TICKER = 1;`,
    "fogged.ts": `import { fog } from "trigscript/fog";\nexport const lit = () => fog;`,
  },
  waves: { "index.tsx": `import { double } from "stamps";\nexport const wave = (n: number) => double(n) + 1;` },
};
const raw = (main: string, libraries: ScriptLibraries = STAMPS): CompileResult => compileScript(ts, { "main.ts": main }, NAMES, { lib: LIB, libraries });
const shown = (main: string, libraries?: ScriptLibraries) => {
  const r = raw(main, libraries);
  expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
  expect(sim.faults).toEqual([]);
  return sim.events.map((e) => e.text);
};

describe("libraries of other plugins", () => {
  it("a module by its id and path, with what it imports of its own library", () => {
    expect(shown(`import { say } from "stamps/say";\nprogram(() => { let k = 4; say(k); });`)).toEqual(["stamps 8"]);
  });
  it("beside the library's own names, from the same file", () => {
    expect(shown(`import { units } from "trigscript";\nimport { double } from "stamps";\nprogram(() => { let k = 3; setDeaths(P1, units.TerranMarine, "set", double(k)); print(\`\${double(k)}\`); });`)).toEqual(["6"]);
  });
  it("the library by its id alone is its index module", () => {
    expect(shown(`import { double, NAME } from "stamps";\nprogram(() => { let k = 3; print(\`\${NAME} \${double(k)}\`); });`)).toEqual(["stamps 6"]);
  });
  it("a library that imports another library", () => {
    expect(shown(`import { wave } from "waves";\nprogram(() => { let k = 2; print(\`\${wave(k)}\`); });`)).toEqual(["5"]);
  });
  it("only the modules something imports join the files: a program in another module is not built", () => {
    const r = raw(`import { say } from "stamps/say";\nprogram(() => { say(1); });`);
    expect(Object.keys(libraryImports([`import { say } from "stamps/say";`], STAMPS).files).sort()).toEqual(["__libraries__/stamps/math/double.ts", "__libraries__/stamps/say.ts"]);
    expect(r.ir).toHaveLength(1);
    const ticked = raw(`import { TICKER } from "stamps/ticker";\nprogram(() => { print(\`\${TICKER}\`); });`);
    expect(ticked.ir.map((p) => p.at?.file)).toEqual(["__libraries__/stamps/ticker.ts", "main.ts"]);
  });
  it("says which libraries a set of files uses, through the ones they import", () => {
    expect(libraryImports([`import { wave } from "waves";`], STAMPS).used).toEqual(["stamps", "waves"]);
    expect(libraryImports([`import { units } from "trigscript"; import { x } from "./x";`], STAMPS).used).toEqual([]);
  });
  it("a library module may import the standard library", () => {
    expect(raw(`import { lit } from "stamps/fogged";\nprogram(() => { lit(); });`).diagnostics.filter((d) => /Cannot find module/.test(d.message))).toEqual([]);
  });
  it("a library nobody provides is said as one", () => {
    const r = raw(`import { x } from "nobody/thing";\nprogram(() => {});`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].message).toMatch(/no plugin provides "nobody" here, and the map keeps no copy of it/);
  });
  it("a module the library does not have is said with the ones it has", () => {
    const r = raw(`import { x } from "stamps/nope";\nprogram(() => {});`);
    expect(r.diagnostics[0].message).toMatch(/The library "stamps" has no such module: it has "stamps\/index", "stamps\/math\/double"/);
  });
  it("the standard library's name is never a library's", () => {
    const r = raw(`import { fog } from "trigscript/fog";\nprogram(() => { fog; });`, { trigscript: { "fog.ts": "export const fog = 1;" } });
    expect(r.diagnostics.filter((d) => /fog/.test(d.message))).toEqual([]);
  });
});

describe("what a library may be", () => {
  it("takes ids, paths and modules", () => {
    expect(libraryProblem("stamps", { "a.ts": "", "b/c.tsx": "" })).toBeNull();
    expect(libraryProblem("Stamps", { "a.ts": "" })).toMatch(/not a library id/);
    expect(libraryProblem("trigscript", { "a.ts": "" }, ["trigscript"])).toMatch(/keeps for itself/);
    expect(libraryProblem("stamps", {})).toMatch(/no modules/);
    expect(libraryProblem("stamps", { "../a.ts": "" })).toMatch(/not a module path/);
    expect(libraryProblem("stamps", { "a.js": "" })).toMatch(/not a module path/);
    expect(libraryProblem("stamps", { "a.test.ts": "" })).toMatch(/test file/);
  });
});

describe("the map's copy of a library", () => {
  const copy = { id: "stamps", label: "Stamp Library", version: "1.2.0", modules: { "say.ts": "export const a = 1;", "ai/waves.tsx": "export const b = 2;" } };
  it("is kept under its own folder, apart from the script's files", () => {
    const extras = withLibraries(withFiles(new Map(), { "main.ts": "x", "libraries/own.ts": "y" }), { stamps: copy });
    expect([...extras.keys()].filter((n) => n.startsWith(LIBRARIES_FOLDER)).sort()).toEqual([
      "trigscript\\@libraries\\stamps\\ai\\waves.tsx", "trigscript\\@libraries\\stamps\\library.json", "trigscript\\@libraries\\stamps\\say.ts",
    ]);
    expect(readFiles(extras)).toEqual({ "main.ts": "x", "libraries/own.ts": "y" });
    expect(pathOf("trigscript\\@libraries\\stamps\\say.ts")).toBeNull();
    expect(readLibraries(extras)).toEqual({ stamps: copy });
    // Writing the script's files leaves the copy; writing no libraries removes it.
    expect(readLibraries(withFiles(extras, { "main.ts": "z" }))).toEqual({ stamps: copy });
    expect(readLibraries(withLibraries(extras, {}))).toEqual({});
  });
  it("keeps a member's bytes when its text is the same", () => {
    const extras = withLibraries(new Map(), { stamps: copy });
    const again = withLibraries(extras, { stamps: copy });
    for (const [name, bytes] of again) expect(extras.get(name)).toBe(bytes);
  });
  it("counts in the script's hash, and a script with none hashes as before", () => {
    const files = { "main.ts": "x" };
    expect(hashSources(files)).toBe(hashFiles(files));
    expect(hashSources(files, {})).toBe(hashFiles(files));
    expect(hashSources(files, { stamps: copy })).not.toBe(hashFiles(files));
    expect(hashSources(files, { stamps: { ...copy, modules: { ...copy.modules, "say.ts": "export const a = 2;" } } })).not.toBe(hashSources(files, { stamps: copy }));
  });
});

describe("the example library (examples/library)", () => {
  it("carries lib/ as it is", () => {
    const lib = join(import.meta.dirname, "../examples/library/lib");
    const files = readdirSync(lib).filter((f) => f.endsWith(".ts")).sort();
    expect(Object.keys(MODULES).sort()).toEqual(files);
    for (const f of files) expect(MODULES[f]).toBe(readFileSync(join(lib, f), "utf8"));
  });
  it("is a library TrigScript takes, and its index's example runs", () => {
    expect(libraryProblem("waves", MODULES, ["trigscript"])).toBeNull();
    const example = /\* {3}(import[\s\S]*?\}\);)\n/.exec(MODULES["index.ts"])![1].replace(/^ \*(?: {3})?/gm, "");
    const r = compileScript(ts, { "main.ts": example.replace("locations.Spawn", "locations.Anywhere") }, NAMES, { lib: LIB, libraries: { waves: MODULES } });
    expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.faults).toEqual([]);
    expect(sim.events.map((e) => e.text).filter(Boolean)[0]).toBe("— Wave 1 —");
  });
});
