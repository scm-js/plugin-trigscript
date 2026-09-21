/** `tree.ts`: the script's files as folders, and a move that takes the imports with it. */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type ScriptFiles } from "../compiler/compiler";
import { scriptNames } from "../compiler/names";
import { applyMoves, buildTree, findSpecifiers, movesOf, refuseMoves, relativePath, tabLabels, validFolder, type TreeNode } from "../tree";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const errorsOf = (files: ScriptFiles) => compileScript(ts, files, scriptNames({}), { lib: LIB }).diagnostics.map((d) => `${d.file}: ${d.message}`);
const shape = (nodes: TreeNode[]): unknown[] => nodes.map((n) => (n.kind === "folder" ? [n.path, shape(n.children)] : n.path));

describe("the tree", () => {
  it("puts folders before files and main.ts first", () => {
    expect(shape(buildTree(["zeta.ts", "main.ts", "waves/spawn.ts", "alpha.ts", "waves/bosses/ultra.ts", "tests/waves.test.ts"]))).toEqual([
      ["tests", ["tests/waves.test.ts"]],
      ["waves", [["waves/bosses", ["waves/bosses/ultra.ts"]], "waves/spawn.ts"]],
      "main.ts", "alpha.ts", "zeta.ts",
    ]);
  });

  it("says the folder on tabs that share a name, and only on those", () => {
    const labels = tabLabels(["main.ts", "spawn.ts", "waves/spawn.ts"]);
    expect(labels.get("main.ts")).toEqual({ label: "main.ts" });
    expect(labels.get("spawn.ts")).toEqual({ label: "spawn.ts", folder: "." });
    expect(labels.get("waves/spawn.ts")).toEqual({ label: "spawn.ts", folder: "waves" });
  });

  it("takes a folder's name as a file's is taken", () => {
    expect(validFolder("tests")).toBe(true);
    expect(validFolder("waves/bosses")).toBe(true);
    expect(validFolder("../up")).toBe(false);
    expect(validFolder("a b")).toBe(false);
    expect(validFolder("")).toBe(false);
  });
});

describe("imports", () => {
  it("finds the specifiers and nothing that only looks like one", () => {
    const text = [
      'import { a } from "./a";',
      "import './side';",
      'export * from "../up/b.ts";',
      'const lazy = import("./lazy");',
      '// import { no } from "./comment";',
      '/* from "./block" */',
      'const s = "from"; const t = "./string";',
      "const u = `import \"./template\" ${ from(\"./inside\") }`;",
    ].join("\n");
    expect(findSpecifiers(text).map((s) => s.text)).toEqual(["./a", "./side", "../up/b.ts", "./lazy"]);
    const first = findSpecifiers(text)[0];
    expect(text.slice(first.start, first.end)).toBe("./a");
  });

  it("writes one path as seen from another", () => {
    expect(relativePath("main.ts", "helpers.ts")).toBe("./helpers.ts");
    expect(relativePath("main.ts", "waves/spawn.ts")).toBe("./waves/spawn.ts");
    expect(relativePath("tests/waves.test.ts", "waves/spawn.ts")).toBe("../waves/spawn.ts");
    expect(relativePath("a/b/c.ts", "a/d.ts")).toBe("../d.ts");
    expect(relativePath("a/b/c.ts", "main.ts")).toBe("../../main.ts");
  });
});

describe("moves", () => {
  const files: ScriptFiles = {
    "main.ts": 'import { wave } from "./spawn";\nimport { boss } from "./bosses/ultra.js";\ntrigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "set", wave + boss)]);\n',
    "spawn.ts": 'import { size } from "./sizes";\nexport const wave = size * 2;\n',
    "sizes.ts": "export const size = 3;\n",
    "bosses/ultra.ts": 'import { size } from "../sizes";\nexport const boss = size + 1;\n',
  };

  it("compiles before", () => {
    expect(errorsOf(files)).toEqual([]);
  });

  it("moves a file into a folder: the imports of it, and its own, follow", () => {
    const moves = movesOf(Object.keys(files), "spawn.ts", "waves/spawn.ts");
    expect(refuseMoves(Object.keys(files), moves)).toBeNull();
    const moved = applyMoves(files, moves);
    expect(Object.keys(moved.files).sort()).toEqual(["bosses/ultra.ts", "main.ts", "sizes.ts", "waves/spawn.ts"]);
    expect(moved.files["main.ts"]).toContain('from "./waves/spawn"');
    expect(moved.files["waves/spawn.ts"]).toContain('from "../sizes"');
    expect(moved.imports).toBe(2);
    expect(moved.edited.sort()).toEqual(["main.ts", "waves/spawn.ts"]);
    expect(errorsOf(moved.files)).toEqual([]);
  });

  it("renames a folder with what is in it, an extension written staying written", () => {
    const moves = movesOf(Object.keys(files), "bosses", "waves/big");
    expect([...moves]).toEqual([["bosses/ultra.ts", "waves/big/ultra.ts"]]);
    const moved = applyMoves(files, moves);
    expect(moved.files["main.ts"]).toContain('from "./waves/big/ultra.js"');
    expect(moved.files["waves/big/ultra.ts"]).toContain('from "../../sizes"');
    expect(errorsOf(moved.files)).toEqual([]);
  });

  it("leaves two files that move together pointing at each other as they did", () => {
    const together: ScriptFiles = { "main.ts": 'import "./lib/a";\n', "lib/a.ts": 'import { b } from "./b";\nexport const a = b;\n', "lib/b.ts": "export const b = 1;\n" };
    const moved = applyMoves(together, movesOf(Object.keys(together), "lib", "shared/lib"));
    expect(moved.files["shared/lib/a.ts"]).toBe(together["lib/a.ts"]);
    expect(moved.files["main.ts"]).toBe('import "./shared/lib/a";\n');
    expect(moved.edited).toEqual(["main.ts"]);
  });

  it("keeps a folder imported by its index a folder", () => {
    const indexed: ScriptFiles = { "main.ts": 'import { x } from "./lib";\n', "lib/index.ts": "export const x = 1;\n" };
    const moved = applyMoves(indexed, movesOf(Object.keys(indexed), "lib", "shared"));
    expect(moved.files["main.ts"]).toBe('import { x } from "./shared";\n');
  });

  it("moves there and back to the text it started from", () => {
    const there = applyMoves(files, movesOf(Object.keys(files), "spawn.ts", "waves/spawn.ts"));
    const back = applyMoves(there.files, movesOf(Object.keys(there.files), "waves/spawn.ts", "spawn.ts"));
    expect(back.files).toEqual(files);
  });

  it("refuses to move main.ts, and to land on a file that stays", () => {
    expect(refuseMoves(Object.keys(files), movesOf(Object.keys(files), "main.ts", "src/main.ts"))).toMatch(/main\.ts/);
    expect(refuseMoves(Object.keys(files), movesOf(Object.keys(files), "spawn.ts", "sizes.ts"))).toBe("There is already a sizes.ts.");
  });
});
