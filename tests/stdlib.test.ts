/**
 * The standard library (TrigScript 4): modules of TrigScript shipped with the compiler and imported as
 * "trigscript/<name>" — fog first. What joins a script's files and when, the location a library reserves, and what the
 * fog's functions compile to: a picture's brushes, read back out of the IR, light the picture's tiles.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames, type ScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { STDLIB_SOURCES } from "../compiler/generated/stdlib";
import { stdlibImports } from "../compiler/stdlib";
import type { Program, Stmt } from "../compiler/ir";
import { ProgramSimulation } from "../compiler/simulateIr";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compile = (main: string, names: ScriptNames = NAMES): CompileResult => compileScript(ts, { "main.ts": main }, names, { lib: LIB });
const ok = (main: string, names?: ScriptNames): CompileResult => {
  const r = compile(main, names);
  expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  return r;
};

/** Every statement of a program, depth first. */
function walk(stmts: Stmt[], out: Stmt[] = []): Stmt[] {
  for (const s of stmts) {
    out.push(s);
    for (const key of ["body", "then", "else"] as const) {
      const inner = (s as unknown as Record<string, unknown>)[key];
      if (Array.isArray(inner)) walk(inner as Stmt[], out);
    }
    const call = (s as unknown as { call?: { body?: Stmt[] } }).call;
    if (call?.body) walk(call.body, out);
    // A loop unrolled when the script is built: a copy of its body for each turn.
    const turns = (s as unknown as { iterations?: Stmt[][] }).iterations;
    if (turns) for (const t of turns) walk(t, out);
    const cases = (s as unknown as { cases?: { body: Stmt[] }[] }).cases;
    if (cases) for (const c of cases) walk(c.body, out);
  }
  return out;
}

/** The brushes' unit types, size 1 first, as stdlib/fog.ts has them. */
const BRUSH_UNITS = [55, 56, 57, 22, 82, 28, 29, 21, 86, 80, 88];
const SHAPES = (() => {
  const src = STDLIB_SOURCES.fog;
  const block = src.slice(src.indexOf("export const SHAPES"), src.indexOf("];", src.indexOf("export const SHAPES")));
  return [...block.matchAll(/\[("[^\]]*")\]/g)].map((m) => JSON.parse(`[${m[1]}]`) as string[]);
})();

/** The tiles a program's brushes light, worked out from its IR: each Create Unit at the location centred just before. */
function litBy(p: Program): Set<string> {
  const lit = new Set<string>();
  let at: [number, number] | null = null;
  for (const s of walk(p.body)) {
    if (s.kind === "centerLocation" && s.x.kind === "const" && s.y.kind === "const") at = [(s.x.value - 16) / 32, (s.y.value - 16) / 32];
    if (s.kind === "action" && s.record.type === 44 && at) {
      const size = BRUSH_UNITS.indexOf(s.record.unitId) + 1;
      const shape = SHAPES[size - 1];
      const cy = shape.findIndex((r) => r.includes("@")), cx = shape[cy].indexOf("@");
      shape.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] !== ".") lit.add(`${at![0] + x - cx},${at![1] + y - cy}`); });
    }
  }
  return lit;
}

describe("the standard library", () => {
  it("is embedded as it is in stdlib/", () => {
    const dir = join(import.meta.dirname, "..", "stdlib");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    expect(Object.keys(STDLIB_SOURCES).sort()).toEqual(files.map((f) => f.replace(/\.tsx?$/, "")).sort());
    for (const f of files) expect(STDLIB_SOURCES[f.replace(/\.tsx?$/, "")]).toBe(readFileSync(join(dir, f), "utf8"));
  });

  it("joins a script only when imported: fog's canvas is a program of its own", () => {
    expect(stdlibImports([`import { fog } from "trigscript/fog";`])).toEqual(["fog"]);
    expect(stdlibImports([`import { units } from "trigscript";`])).toEqual([]);
    expect(ok(`program(() => {});`).ir.length).toBe(1);
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { fog.light(P1, 10, 10, 3); await nextFrame(); });`);
    expect(r.ir.map((p) => p.at?.file)).toEqual(["__trigscript__/fog.ts", "main.ts"]);
  });

  it("an unknown module is TypeScript's error", () => {
    expect(compile(`import { x } from "trigscript/nope";`).diagnostics.map((d) => d.message).join()).toMatch(/Cannot find module 'trigscript\/nope'/);
  });

  it("fog's canvas sets every brush's sight and asks for a wiped board, every frame", () => {
    // (An import nothing uses is dropped by TypeScript, and with it the canvas: this one is used.)
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { fog.light(P1, 1, 1, 1); });`);
    const writes = walk(r.ir[0].body).filter((s): s is Extract<Stmt, { kind: "tableWrite" }> => s.kind === "tableWrite");
    expect(writes.filter((w) => w.cell.name === "unit.sight").map((w) => [w.cell.index, w.value])).toEqual(BRUSH_UNITS.map((u, i) => [u, { kind: "const", value: i + 1 }]));
    expect(writes.some((w) => w.cell.name === "memory.vision.countdown")).toBe(true);
  });
});

describe("reserveLocation", () => {
  it("takes the highest location of the first 63 the map does not use, and keeps it for the same reason", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { fog.light(P1, 10, 10, 2); await nextFrame(); });`);
    const centred = walk(r.ir[1].body).filter((s) => s.kind === "centerLocation");
    expect(centred.map((s) => (s as Extract<Stmt, { kind: "centerLocation" }>).location)).toEqual([63]);
  });

  it("steps past a location the map uses", () => {
    const names = defaultScriptNames();
    names.locations.entries.push({ value: 63, keys: ["Mine"] });
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { while (true) { if (keyPressed(P1, "F7")) fog.light(P1, 10, 10, 2); await nextFrame(); } });`, names);
    const centred = walk(r.ir[1].body).find((s) => s.kind === "centerLocation") as Extract<Stmt, { kind: "centerLocation" }>;
    expect(centred.location).toBe(62);
  });

  it("says what it needs", () => {
    expect(compile(`const at = reserveLocation("");`).diagnostics.map((d) => d.message).join()).toMatch(/reserveLocation\(\) takes the reason/);
  });
});

describe("fog", () => {
  it("light() with a known size is one location move, one Create Unit and one Remove Unit", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { fog.light(P1, 30, 20, 5); await nextFrame(); });`);
    const s = walk(r.ir[1].body);
    expect(s.filter((x) => x.kind === "centerLocation")).toMatchObject([{ x: { value: 30 * 32 + 16 }, y: { value: 20 * 32 + 16 }, size: { width: { value: 32 }, height: { value: 32 } } }]);
    const actions = s.filter((x): x is Extract<Stmt, { kind: "action" }> => x.kind === "action").map((a) => [a.record.type, a.record.unitId]);
    expect(actions).toEqual([[44, BRUSH_UNITS[4]], [24, BRUSH_UNITS[4]]]);
    expect(s.some((x) => x.kind === "if")).toBe(false);
    // The size known when the script is built: of disc()'s switch, only its case is built.
    expect(s.filter((x) => x.kind === "switch").map((x) => (x as Extract<Stmt, { kind: "switch" }>).cases.length)).toEqual([1]);
  });

  it("light() with a size the program works out keeps the choice for the game", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { let n = 3; while (true) { fog.light(P1, 30, 20, n); n = n % 11 + 1; await nextFrame(); } });`);
    expect(walk(r.ir[1].body).filter((x) => x.kind === "action" && x.record.type === 44)).toHaveLength(11);
  });

  it("a picture's brushes light exactly its lit tiles, when every part of it is three wide and four tall", () => {
    const rows = ["######......", "######......", "######......", "######......", "############", "############", "############", "############"];
    const r = ok(`import { fog } from "trigscript/fog";\nconst pic = fog.picture(${JSON.stringify(rows)});\nprogram(async () => { fog.light(P1, 40, 30, pic); await nextFrame(); });`);
    const want = new Set<string>();
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "#") want.add(`${40 + x},${30 + y}`); });
    expect([...litBy(r.ir[1])].sort()).toEqual([...want].sort());
  });

  it("a thin line is drawn a tile thick rather than lost", () => {
    const rows = ["##########"];
    const r = ok(`import { fog } from "trigscript/fog";\nconst pic = fog.picture(${JSON.stringify(rows)});\nprogram(async () => { fog.light(P1, 10, 10, pic); await nextFrame(); });`);
    const lit = litBy(r.ir[1]);
    for (let x = 0; x < 10; x++) expect(lit.has(`${10 + x},10`)).toBe(true);
  });

  it("dark ink: the # tiles stay dark — a line one tile wide exactly — and the rest of the rectangle is lit", () => {
    const rows = Array.from({ length: 10 }, () => "......#......");
    const r = ok(`import { fog } from "trigscript/fog";\nconst pic = fog.picture(${JSON.stringify(rows)}, { ink: "dark" });\nprogram(async () => { fog.light(P1, 20, 20, pic); await nextFrame(); });`);
    const want = new Set<string>();
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] !== "#") want.add(`${20 + x},${20 + y}`); });
    expect([...litBy(r.ir[1])].sort()).toEqual([...want].sort());
  });

  it("light() is one function for a size and a picture: only the side its argument takes is compiled", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nconst pic = fog.picture(["####", "####", "####", "####"]);\nprogram(async () => { let n = 2; fog.light(P1, 5, 5, n); fog.light(P1, 20, 20, pic); await nextFrame(); });`);
    const creates = walk(r.ir[1].body).filter((s) => s.kind === "action" && s.record.type === 44);
    expect(creates.length).toBe(11 + 2); // the size the program holds: one Create Unit per size, in the if-chain; the 4 × 4 picture: two size-1 brushes (3 wide each)
    expect(compile(`import { fog } from "trigscript/fog";\nprogram(() => {\n  // @ts-expect-error\n  fog.light(P1, 5, 5, "big");\n});`).diagnostics.length).toBeGreaterThan(0);
  });

  it("reveal() walks the map's own size, read in the game", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { fog.reveal(P1); await nextFrame(); });`);
    expect(JSON.stringify(r.ir[1].body)).toContain(`"name":"memory.map.width"`);
  });
});

describe("typeof in an inlined function", () => {
  it("is known when the script is built, for a value and for a program's variable, and only the live side is compiled", () => {
    const lib = `export const pay = game((player: Player, amount: number | string) => {
  if (typeof amount === "number") setResources(player, "add", amount, "ore");
  else displayText(amount);
});`;
    const run = (body: string) => compileScript(ts, { "main.ts": `import { pay } from "./lib";\nprogram(() => { ${body} });`, "lib.ts": lib }, NAMES, { lib: LIB });
    for (const [body, type] of [[`pay(P1, 5);`, 26], [`let n = 3; pay(P1, n);`, 26], [`pay(P1, "hello");`, 9]] as const) {
      const r = run(body);
      expect(r.diagnostics).toEqual([]);
      const actions = walk(r.ir[0].body).filter((s): s is Extract<Stmt, { kind: "action" }> => s.kind === "action");
      expect(actions.map((a) => a.record.type)).toEqual([type]);
      expect(walk(r.ir[0].body).some((s) => s.kind === "if")).toBe(false);
    }
  });
});

describe("nextFrame() and a sized centerLocation", () => {
  it("nextFrame() is a sleep of one frame", () => {
    const r = ok(`program(async () => { await nextFrame(); });`);
    expect(r.ir[0].body).toMatchObject([{ kind: "sleep", cycles: 1 }]);
    expect(compile(`program(async () => {\n  // @ts-expect-error\n  await nextFrame(2);\n});`).diagnostics.map((d) => d.message).join()).toMatch(/nextFrame\(\) takes nothing/);
  });

  it("centerLocation with a width and a height carries the size; four arguments is an error", () => {
    const r = ok(`program(() => { let x = 5; centerLocation(3 as Location, x, 64, 32, 48); });`);
    expect(walk(r.ir[0].body).find((s) => s.kind === "centerLocation")).toMatchObject({ size: { width: { value: 32 }, height: { value: 48 } } });
    expect(compile(`program(() => {\n  // @ts-expect-error\n  centerLocation(3 as Location, 1, 2, 3);\n});`).diagnostics.map((d) => d.message).join()).toMatch(/a width and a height to size it too/);
  });
});

describe("fog, as the simulator draws it", () => {
  /** A script's fog after `frames` frames of the simulator: player 1's, the top-left `w` × `h` tiles. */
  const fogAfter = (main: string, frames: number, w = 128, h = 96): string[] => {
    const r = ok(main);
    const sim = new ProgramSimulation(r.ir, { strings: r.strings });
    sim.run(frames);
    return sim.fog(0, { x: 0, y: 0, width: w, height: h });
  };

  it("draws a brush's tiles where it is made, and the countdown wipes them the next frame", () => {
    const lit = (rows: string[]) => rows.join("").split("").filter((c) => c === "#").length;
    const once = `import { fog } from "trigscript/fog";\nprogram(async () => { await nextFrame(); fog.light(P1, 30, 20, 3); await nextFrame(); await nextFrame(); });`;
    expect(lit(fogAfter(once, 2))).toBe(52); // size 3: 52 tiles
    expect(lit(fogAfter(once, 4))).toBe(0);
  });

  it("fog.show(n) keeps a picture on the board n frames, then the board is wiped", () => {
    const lit = (rows: string[]) => rows.join("").split("").filter((c) => c === "#").length;
    const shown = `import { fog } from "trigscript/fog";\nprogram(async () => { await nextFrame(); fog.light(P1, 30, 20, 3); await fog.show(3); await nextFrame(); await nextFrame(); });`;
    expect([2, 3, 4, 5].map((f) => lit(fogAfter(shown, f)))).toEqual([52, 52, 52, 0]);
  });

  it("fog.rect is exact from 3 × 4 up", () => {
    const rows = fogAfter(`import { fog } from "trigscript/fog";\nprogram(async () => { let w = 7, h = 9; while (true) { fog.rect(P1, 10, 12, w, h); await nextFrame(); } });`, 3, 40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) expect(rows[y][x] === "#", `${x},${y}`).toBe(x >= 10 && x < 17 && y >= 12 && y < 21);
  });

  // Columns of random heights, with and without shading, in both inks: every tile as the layout says.
  for (const ink of ["light", "dark"] as const) {
    it(`fog.columns, ${ink} ink: each column lit from the middle out (light) or from the edges in (dark), exactly`, () => {
      let seed = ink === "light" ? 7 : 11;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 97);
      const heights = Array.from({ length: 24 }, () => rnd());
      const rows = fogAfter(`import { fog } from "trigscript/fog";
const H = ${JSON.stringify(heights)};
const VIEW = { count: 24, height: 96, ink: "${ink}" } as const;
program(async () => { const hs: number[] = new Array(24).fill(0); let i = 0; while (i < 24) { hs[i] = H[i]; i++; } while (true) { fog.columns(P1, 1, 0, VIEW, hs); await nextFrame(); } });`, 3);
      for (let c = 0; c < 24; c++) {
        const a = Math.min(heights[c] >> 1, 48);
        for (let x = 1 + 3 * c; x < 4 + 3 * c; x++) for (let y = 0; y < 96; y++) {
          const wall = y >= 48 - a && y < 48 + a;
          // (A wall less than 4 tall is drawn a brush tall: the one place the picture may be off, and only by a tile or two.)
          if (ink === "light" && a < 2) continue;
          if (ink === "dark" && a > 46) continue;
          expect(rows[y][x] === "#", `column ${c} (${heights[c]} tall), tile ${x},${y}`).toBe(ink === "light" ? wall : !wall);
        }
      }
    });
  }

  it("fog.columns, outline (the default): every column its top and bottom edges, and whole where one face meets another, on the nearer", () => {
    const rows = fogAfter(`import { fog } from "trigscript/fog";
const VIEW = { count: 4, height: 96 } as const;
program(async () => { const hs: number[] = [60, 60, 80, 80]; const faces: number[] = [3, 3, 8, 8]; while (true) { fog.columns(P1, 1, 0, VIEW, hs, faces); await nextFrame(); } });`, 3);
    const column = (c: number) => rows.map((r) => r[2 + 3 * c]).join("");
    const hollow = (a: number) => ".".repeat(48 - a) + "#".repeat(4) + ".".repeat(2 * a - 8) + "#".repeat(4) + ".".repeat(48 - a);
    expect(column(0)).toBe(hollow(30));
    expect(column(1)).toBe(hollow(30));
    // Faces 3 and 8 meet between columns 1 and 2: the taller, 2, is the edge.
    expect(column(2)).toBe(".".repeat(8) + "#".repeat(80) + ".".repeat(8));
    expect(column(3)).toBe(hollow(40));
  });

  it("fog.columns with shading: a shaded column is hollow, lit a brush deep along its top and bottom edges", () => {
    const rows = fogAfter(`import { fog } from "trigscript/fog";
const VIEW = { count: 2, height: 96, ink: "light", shading: "hollow" } as const;
program(async () => { const hs: number[] = [80, 80]; const sh: number[] = [0, 1]; while (true) { fog.columns(P1, 1, 0, VIEW, hs, sh); await nextFrame(); } });`, 3);
    const column = (x: number) => rows.map((r) => r[x]).join("");
    expect(column(2)).toBe(".".repeat(8) + "#".repeat(80) + ".".repeat(8));
    const want = ".".repeat(8) + "#".repeat(4) + ".".repeat(72) + "#".repeat(4) + ".".repeat(8);
    expect(column(5)).toBe(want);
  });

  it("fog.columns, panelled: hollow, and lit a brush deep across each half's quarters", () => {
    const rows = fogAfter(`import { fog } from "trigscript/fog";
const VIEW = { count: 1, height: 96, ink: "light", shading: "panelled" } as const;
program(async () => { const hs: number[] = [80]; const sh: number[] = [1]; while (true) { fog.columns(P1, 1, 0, VIEW, hs, sh); await nextFrame(); } });`, 3);
    const column = rows.map((r) => r[2]).join("");
    // Half its height is 40: the edges (rows 8–11, 84–87) and bands centred 10, 20 and 30 rows from the middle.
    const lit = new Set<number>();
    for (const r of [8, 9, 10, 11, 84, 85, 86, 87]) lit.add(r);
    for (const at of [10, 20, 30]) for (let d = -2; d < 2; d++) { lit.add(48 - at + d); lit.add(48 + at + d); }
    expect(column).toBe(Array.from({ length: 96 }, (_, y) => (lit.has(y) ? "#" : ".")).join(""));
  });
});
