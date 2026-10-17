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
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(Object.keys(STDLIB_SOURCES).sort()).toEqual(files.map((f) => f.replace(/\.ts$/, "")).sort());
    for (const f of files) expect(STDLIB_SOURCES[f.replace(/\.ts$/, "")]).toBe(readFileSync(join(dir, f), "utf8"));
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

  it("steps past a location the map uses, and input keeps clear of it", () => {
    const names = defaultScriptNames();
    names.locations.entries.push({ value: 63, keys: ["Mine"] });
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { while (true) { if (keyPressed(P1, "F7")) fog.light(P1, 10, 10, 2); await nextFrame(); } });`, names);
    const centred = walk(r.ir[1].body).find((s) => s.kind === "centerLocation") as Extract<Stmt, { kind: "centerLocation" }>;
    expect(centred.location).toBe(62);
    expect(r.input?.qcLocation).toBe(60); // 0-based: 62 is Mine, 61 is fog's
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
  });

  it("light() with a size the program works out keeps the choice for the game", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { let n = 3; while (true) { fog.light(P1, 30, 20, n); n = n % 11 + 1; await nextFrame(); } });`);
    expect(walk(r.ir[1].body).filter((x) => x.kind === "action" && x.record.type === 44)).toHaveLength(11);
  });

  it("a picture's brushes light exactly its lit tiles, when every part of it is three wide and four tall", () => {
    const rows = ["######......", "######......", "######......", "######......", "############", "############", "############", "############"];
    const r = ok(`import { fog } from "trigscript/fog";\nconst pic = fog.picture(${JSON.stringify(rows)});\nprogram(async () => { fog.draw(P1, pic, 40, 30); await nextFrame(); });`);
    const want = new Set<string>();
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "#") want.add(`${40 + x},${30 + y}`); });
    expect([...litBy(r.ir[1])].sort()).toEqual([...want].sort());
  });

  it("a thin line is drawn a tile thick rather than lost", () => {
    const rows = ["##########"];
    const r = ok(`import { fog } from "trigscript/fog";\nconst pic = fog.picture(${JSON.stringify(rows)});\nprogram(async () => { fog.draw(P1, pic, 10, 10); await nextFrame(); });`);
    const lit = litBy(r.ir[1]);
    for (let x = 0; x < 10; x++) expect(lit.has(`${10 + x},10`)).toBe(true);
  });

  it("reveal() walks the map's own size, read in the game", () => {
    const r = ok(`import { fog } from "trigscript/fog";\nprogram(async () => { fog.reveal(P1); await nextFrame(); });`);
    expect(JSON.stringify(r.ir[1].body)).toContain(`"name":"memory.map.width"`);
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
