/**
 * Images a script imports: the `.image` format (every pixel back as it was written, grey, colour and transparency),
 * what the build-time `Image` makes of one, and a script that imports one and draws it in the fog.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { describeImage, makeImage, readImage, writeImage } from "../compiler/image";
import { describeMedia, isMediaFile } from "../compiler/media";
import { covers, prepareShapes } from "../compiler/cover";
import { FOG_SHAPES } from "../compiler/fogShapes";
import { readFiles, withFiles } from "../script";

const LIB = defaultLib();

/** A w × h picture from a pixel function giving [r, g, b, a]. */
function pixels(w: number, h: number, f: (x: number, y: number) => readonly number[]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(f(x, y), (y * w + x) * 4);
  return out;
}

let seed = 11;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;

/** A soft colour gradient with a disc of another colour on it, and a transparent corner. */
const scene = (w: number, h: number) => pixels(w, h, (x, y) => {
  const inDisc = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (h / 3) ** 2;
  return inDisc ? [220, 40, 30, 255] : [x * 4 & 255, y * 3 & 255, 128, x + y < 6 ? 0 : 255];
});

describe("the .image format", () => {
  it("reads back every pixel: grey, colour, transparent, and noise", () => {
    const cases: [number, number, Uint8Array][] = [
      [17, 9, pixels(17, 9, (x, y) => { const g = (x * 15 + y * 7) & 255; return [g, g, g, 255]; })],
      [40, 30, scene(40, 30)],
      [13, 11, pixels(13, 11, () => [random(), random(), random(), random()])],
      [1, 1, Uint8Array.from([5, 6, 7, 8])],
    ];
    for (const [w, h, rgba] of cases) {
      const d = readImage(writeImage({ width: w, height: h, rgba, source: "x.png" }));
      expect([d.width, d.height, d.source]).toEqual([w, h, "x.png"]);
      expect(d.rgba).toEqual(rgba);
    }
  });

  it("says whether it kept colour and transparency", () => {
    const grey = readImage(writeImage({ width: 2, height: 1, rgba: Uint8Array.from([9, 9, 9, 255, 200, 200, 200, 255]) }));
    expect([grey.color, grey.alpha]).toEqual([false, false]);
    const colour = readImage(writeImage({ width: 40, height: 30, rgba: scene(40, 30) }));
    expect([colour.color, colour.alpha]).toEqual([true, true]);
  });

  it("keeps grey levels only when asked", () => {
    const d = readImage(writeImage({ width: 40, height: 30, rgba: scene(40, 30), grey: true }));
    expect(d.color).toBe(false);
    // The disc's red, as the import takes a grey: 0.299 × 220 + 0.587 × 40 + 0.114 × 30.
    expect(d.rgba[(15 * 40 + 20) * 4]).toBe(Math.round(0.299 * 220 + 0.587 * 40 + 0.114 * 30));
  });

  it("is smaller than its pixels where the picture is smooth", () => {
    const rgba = pixels(128, 96, (x, y) => [x * 2, y * 2, (x + y) & 255, 255]);
    expect(writeImage({ width: 128, height: 96, rgba }).length).toBeLessThan(128 * 96 * 3 / 10);
  });

  it("says what is wrong with a file that is not one", () => {
    const good = writeImage({ width: 3, height: 2, rgba: scene(3, 2), source: "logo.png" });
    expect(() => readImage("not json")).toThrow(/one line of JSON/);
    expect(() => readImage(JSON.stringify({ trigscript: "image", version: 99, data: "" }))).toThrow(/newer TrigScript/);
    expect(() => readImage(JSON.stringify({ ...JSON.parse(good), width: 4000 }))).toThrow(/1 to 1024 pixels/);
    expect(() => readImage(JSON.stringify({ ...JSON.parse(good), width: 300, height: 300 }))).toThrow(/cut short/);
    expect(describeImage(good)).toBe("An image, 3 × 2 pixels, in colour, with transparency, from logo.png.");
    expect(describeMedia("art/logo.image", good)).toBe(describeImage(good));
  });

  it("is a file of the script, kept in the map", () => {
    expect(isMediaFile("a/logo.image")).toBe(true);
    const files = { "main.ts": "a", "art/logo.image": "b" };
    expect(readFiles(withFiles(new Map(), files))).toEqual(files);
  });
});

describe("an Image when the script is built", () => {
  // 4 × 2: a grey ramp on top, black white black white below.
  const ramp = makeImage({ width: 4, height: 2, color: false, alpha: false, rgba: pixels(4, 2, (x, y) => { const g = y === 0 ? x * 85 : x % 2 ? 255 : 0; return [g, g, g, 255]; }) });

  it("reads pixels", () => {
    expect([ramp.width, ramp.height, ramp.grey(3, 0), ramp.alpha(0, 0)]).toEqual([4, 2, 255, 255]);
    expect(ramp.rgb(2, 0)).toEqual({ r: 170, g: 170, b: 170 });
    expect(() => ramp.grey(4, 0)).toThrow(/4 × 2; there is no pixel \(4, 0\)/);
    expect(() => ramp.grey(0.5, 0)).toThrow(/whole number/);
  });

  it("thresholds, with light or dark ink", () => {
    expect(ramp.threshold()).toEqual(["..##", ".#.#"]);
    expect(ramp.threshold(80, { ink: "dark" })).toEqual(["#...", "#.#."]);
    expect(() => ramp.threshold(128, { ink: "grey" as "light" })).toThrow(/"light" or "dark"/);
  });

  it("crops, flips, turns and inverts", () => {
    expect(ramp.crop(1, 0, 2, 2).threshold()).toEqual([".#", "#."]);
    expect(ramp.flip("horizontal").threshold()).toEqual(["##..", "#.#."]);
    expect(ramp.flip("vertical").threshold()).toEqual([".#.#", "..##"]);
    expect(ramp.rotate(90).threshold()).toEqual(["..", "#.", ".#", "##"]);
    expect(ramp.rotate(180).threshold()).toEqual(["#.#.", "##.."]);
    expect(ramp.rotate(270).threshold()).toEqual(["##", "#.", ".#", ".."]);
    expect(ramp.invert().threshold()).toEqual(["##..", "#.#."]);
    expect(() => ramp.crop(2, 0, 3, 1)).toThrow(/not inside the image/);
    expect(() => ramp.rotate(45 as 90)).toThrow(/90, 180 or 270/);
  });

  it("scales: a block of each pixel growing, an area's average shrinking, the shape kept", () => {
    const big = ramp.scale(8);
    expect([big.width, big.height]).toEqual([8, 4]);
    expect(big.threshold()).toEqual(["....####", "....####", "..##..##", "..##..##"]);
    const small = ramp.scale(2, 1);
    expect([small.grey(0, 0), small.grey(1, 0)]).toEqual([Math.round((0 + 85 + 0 + 255) / 4), Math.round((170 + 255 + 0 + 255) / 4)]);
    expect(() => ramp.scale(2000)).toThrow(/1 to 1024/);
  });

  it("averages colour by how opaque it is, so a transparent pixel darkens no edge", () => {
    const edge = makeImage({ width: 2, height: 1, color: true, alpha: true, rgba: Uint8Array.from([200, 100, 50, 255, 0, 0, 0, 0]) });
    const one = edge.scale(1, 1);
    expect(one.rgb(0, 0)).toEqual({ r: 200, g: 100, b: 50 });
    expect(one.alpha(0, 0)).toBe(128);
    // Not opaque enough is never ink, whichever ink.
    expect(edge.threshold(0)).toEqual(["#."]);
    expect(edge.threshold(256, { ink: "dark" })).toEqual(["#."]);
  });

  it("halftones: an area's share of lit tiles is its grey, at a brush a cell at most", () => {
    const flat = (g: number) => makeImage({ width: 120, height: 98, color: false, alpha: false, rgba: pixels(120, 98, () => [g, g, g, 255]) });
    const lit = (rows: readonly string[]) => rows.join("").split("").filter((c) => c === "#").length / (120 * 98);
    expect(lit(flat(0).halftone(6))).toBe(0);
    // White is lit whole but its top row: a brush's top row is narrower than the rest, and none lights past the picture.
    const white = flat(255).halftone(6);
    expect(white.slice(1).every((r) => r === "#".repeat(120))).toBe(true);
    const shapes = prepareShapes(FOG_SHAPES);
    for (const cell of [4, 6, 8]) for (const g of [40, 100, 160, 220]) {
      const rows = flat(g).halftone(cell);
      expect(Math.abs(lit(rows) - g / 255), `${cell} at ${g}`).toBeLessThan(0.03);
      // The brushes it carries light exactly its rows, one a cell at most.
      const brushes = (rows as unknown as { brushes: { x: number; y: number; shape: number }[] }).brushes;
      expect(covers(brushes, 120, 98, shapes)).toEqual(Uint8Array.from(rows.join(""), (c) => (c === "#" ? 1 : 0)));
      const cells = (size: number, c: number, least: number) => Math.floor(size / c) + (size % c >= least ? 1 : 0);
      expect(brushes.length).toBeLessThanOrEqual(cells(120, cell, 3) * cells(98, cell + 1, 4));
      // Nothing lit in a strip too thin for a brush: what is left over at an edge belongs to the cell before it.
      expect(rows.every((r) => !/(^|\.)#{1,2}$/.test(r)), `${cell} at ${g}`).toBe(true);
    }
    expect(() => flat(9).halftone(2)).toThrow(/3 to 32 tiles across/);
  });

  it("makes tones", () => {
    expect(ramp.tones(4)).toEqual(["0123", "0303"]);
    expect(() => ramp.tones(11)).toThrow(/2 to 10 tones/);
  });
});

describe("a script that imports an image", () => {
  const logo = writeImage({ width: 40, height: 30, rgba: scene(40, 30), source: "logo.png" });
  const compile = (main: string, extra: Record<string, string> = { "art/logo.image": logo }) =>
    compileScript(ts, { "main.ts": main, ...extra }, defaultScriptNames(), { lib: LIB });
  const errors = (r: ReturnType<typeof compile>) => r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`);

  it("knows the image when the script is built", () => {
    const r = compile(`import logo from "./art/logo.image";\nconst half = logo.scale(20);\nif (logo.width !== 40 || half.height !== 15 || !logo.color || !logo.transparent || logo.rgb(20, 15).r !== 220) throw new Error("wrong");\n`);
    expect(errors(r)).toEqual([]);
  });

  it("draws what it makes of the image in the fog", () => {
    const r = compile(`import { fog } from "trigscript/fog";\nimport logo from "./art/logo.image";\nconst disc = fog.picture(logo.flip("vertical").threshold(100, { ink: "dark" }));\nprogram(async () => { fog.reveal(P1); while (true) { fog.light(P1, 10, 10, disc); await nextFrame(); } });\n`);
    expect(errors(r)).toEqual([]);
    expect(r.programs.length).toBeGreaterThan(0);
  });

  it("draws a halftone with the brushes it was made of, a brush a cell at most", () => {
    const r = compile(`import { fog } from "trigscript/fog";\nimport logo from "./art/logo.image";\nconst rows = logo.halftone(4);\nconst made = (rows as unknown as { brushes: unknown[] }).brushes;\nconst p = fog.picture(rows);\nif (made.length === 0 || made.length > 10 * 6 || p.brushes.length !== made.length) throw new Error(\`\${p.brushes.length} of \${made.length}\`);\n`);
    expect(errors(r)).toEqual([]);
  });

  it("is typed: a mistake is the checker's message", () => {
    const r = compile(`import logo from "./art/logo.image";\nlogo.rotate(45);\n`);
    expect(errors(r).join("\n")).toMatch(/main\.ts:2: .*45/);
  });

  it("says where a build-time mistake is", () => {
    const r = compile(`import logo from "./art/logo.image";\nlogo.crop(30, 0, 20, 5);\n`);
    expect(errors(r).join("\n")).toMatch(/not inside the image, which is 40 × 30/);
  });
});
