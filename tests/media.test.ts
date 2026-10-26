/**
 * Videos a script imports (TrigScript 4, B8): the `.video` format, `cover()` with the fog's shapes, the packed tables
 * the IR carries, and what a script that plays a video compiles to — the brushes read back out of the tables light
 * what the encoder meant, frame by frame. Bad Apple itself is checked in the lifted game (probes/bad-apple.ts).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames, scriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { cover, covers, inkOf, prepareShapes } from "../compiler/cover";
import { FOG_SHAPES } from "../compiler/fogShapes";
import { describeVideo, readVideo, writeVideo } from "../compiler/media";
import { readFiles, withFiles } from "../script";

const LIB = defaultLib();

/** A ball crossing a w × h picture, a frame a step. */
function ball(w: number, h: number, n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, k) => {
    const f = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = (x - 5 - k * 2) ** 2 + (y - h / 2) ** 2 < 28 ? 1 : 0;
    return f;
  });
}

describe("the .video format", () => {
  it("reads back every tile of every frame", () => {
    let seed = 7;
    const noise = Array.from({ length: 9 }, () => Uint8Array.from({ length: 37 * 23 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 1));
    for (const frames of [ball(40, 24, 12), noise, []]) {
      const w = frames === noise ? 37 : 40, h = frames === noise ? 23 : 24;
      const v = readVideo(writeVideo({ width: w, height: h, frameMs: 42, frames, source: "x.mp4" }));
      expect([v.width, v.height, v.length, v.frameMs, v.source]).toEqual([w, h, frames.length, 42, "x.mp4"]);
      frames.forEach((f, i) => expect(v.tiles(i)).toEqual(f));
    }
  });

  it("is far smaller than a byte a tile where frames are like the one before", () => {
    const text = writeVideo({ width: 128, height: 96, frameMs: 42, frames: ball(128, 96, 50) });
    expect(text.length).toBeLessThan(50 * 128 * 96 / 40);
  });

  it("says what is wrong with a file that is not one", () => {
    const good = writeVideo({ width: 8, height: 8, frameMs: 42, frames: ball(8, 8, 3) });
    expect(() => readVideo("not json")).toThrow(/one line of JSON/);
    expect(() => readVideo(JSON.stringify({ trigscript: "video", version: 99, data: "" }))).toThrow(/newer TrigScript/);
    const h = JSON.parse(good);
    expect(() => readVideo(JSON.stringify({ ...h, frames: 500 }))).toThrow(/cut short/);
    expect(describeVideo(good)).toBe("A video, 8 × 8 tiles, 3 frames at the game's speed on Fastest (0:00).");
  });
});

describe("cover()", () => {
  const shapes = prepareShapes(FOG_SHAPES);

  it("holds the fog library's shapes as stdlib/fog.ts has them", () => {
    const src = readFileSync(new URL("../stdlib/fog.ts", import.meta.url), "utf8");
    const at = src.indexOf("export const SHAPES"), end = src.indexOf("];\n", at) + 1;
    const literal = src.slice(src.indexOf("=", at) + 1, end);
    expect(new Function(`return ${literal}`)()).toEqual(FOG_SHAPES);
    expect(shapes.nested).toBe(true);
  });

  it("lights the ink and nothing else where the ink is a shape wide", () => {
    // Blocks at least 3 × 4 (the smallest shape's size), anywhere: covered exactly.
    for (let k = 0; k < 10; k++) {
      const f = new Uint8Array(48 * 32);
      for (let y = 3; y < 3 + 4 + k; y++) for (let x = 2 + k; x < 2 + k + 3 + 2 * k; x++) f[y * 48 + x] = 1;
      for (let y = 20; y < 30; y++) for (let x = 30; x < 30 + 3 + k; x++) f[y * 48 + x] = 1;
      expect(covers(cover(f, 48, 32, shapes), 48, 32, shapes)).toEqual(f);
    }
    // A ball: all its ink lit, and every tile lit that is not ink within a tile of some ink (its thin rim, drawn thicker).
    for (const f of ball(48, 32, 10)) {
      const lit = covers(cover(f, 48, 32, shapes), 48, 32, shapes);
      for (let i = 0; i < f.length; i++) {
        if (f[i]) expect(lit[i]).toBe(1);
        else if (lit[i]) expect([-49, -48, -47, -1, 1, 47, 48, 49].some((d) => f[i + d])).toBe(true);
      }
    }
  });

  it("draws a line thinner than any shape a little thicker, inside the picture", () => {
    const { ink, width, height } = inkOf(["..........", "..........", "#########.", "..........", ".........."]);
    const lit = covers(cover(ink, width, height, shapes), width, height, shapes);
    for (let i = 0; i < ink.length; i++) if (ink[i]) expect(lit[i]).toBe(1);
    const brushes = cover(ink, width, height, shapes);
    for (const b of brushes) for (let k = 0; k < shapes.cells[0].length; k += 2) {
      const x = b.x + shapes.cells[0][k], y = b.y + shapes.cells[0][k + 1];
      expect(x >= 0 && x < width && y >= 0 && y < height).toBe(true);
    }
  });

  it("takes shapes of a script's own", () => {
    const bar = prepareShapes([["#@#"]]);
    const { ink, width, height } = inkOf([".###.###"]);
    expect(cover(ink, width, height, bar)).toEqual([{ x: 2, y: 0, shape: 0 }, { x: 6, y: 0, shape: 0 }]);
    expect(() => prepareShapes([["#.#@"]])).toThrow(/one run of tiles/);
  });
});

describe("a script that plays a video", () => {
  const W = 40, H = 24, frames = ball(W, H, 12);
  const video = writeVideo({ width: W, height: H, frameMs: 42, frames });
  const compile = (main: string, extra: Record<string, string> = { "ball.video": video }): CompileResult => compileScript(ts, { "main.ts": main, ...extra }, defaultScriptNames(), { lib: LIB });
  const PLAY = `import { fog } from "trigscript/fog";\nimport ball from "./ball.video";\nprogram(async () => { fog.reveal(P1); await nextFrame(); while (true) await fog.play(P1, ball, 10, 4); });\n`;

  it("compiles to a table of brushes a frame, read while the game runs", () => {
    const r = compile(PLAY);
    expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
    const arrays = r.ir.flatMap((p) => p.arrays);
    const starts = arrays.find((a) => a.name === "starts")!, words = arrays.find((a) => a.name === "words")!;
    expect(starts.values).toHaveLength(frames.length + 1);
    // Each frame's words, as fog.light reads them, light what the encoder meant.
    const shapes = prepareShapes(FOG_SHAPES);
    frames.forEach((f, k) => {
      const brushes = words.values!.slice(starts.values![k], starts.values![k + 1]).map((w) => ({ x: w & 255, y: (w >> 8) & 255, shape: (w >> 16) - 1 }));
      expect(covers(brushes, W, H, shapes)).toEqual(covers(cover(f, W, H, shapes), W, H, shapes));
    });
  });

  it("knows the video's size and length when the script is built", () => {
    const r = compile(`import ball from "./ball.video";\nif (ball.length !== 12 || ball.width !== 40 || ball.frame(0).length !== 24) throw new Error("wrong");\n`);
    expect(r.diagnostics).toEqual([]);
  });

  it("says when the file is not there", () => {
    const r = compile(PLAY, {});
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/Cannot find "\.\/ball\.video"/);
  });
});

describe("the map's sounds", () => {
  it("are names Play WAV takes", () => {
    const names = scriptNames({ sounds: [{ stringIndex: 9, path: "staredit\\wav\\bad apple.ogg" }] });
    expect(names.sounds.entries).toEqual([{ value: 9, keys: ["BadApple", "staredit\\wav\\bad apple.ogg"] }]);
    const r = compileScript(ts, { "main.ts": "program(() => { playWav(sounds.BadApple, 0); });\n" }, names, { lib: LIB });
    expect(r.diagnostics).toEqual([]);
  });
});

describe("the script in the map", () => {
  it("keeps .tsx and .video files as well as .ts", () => {
    const files = { "main.tsx": "a", "x.ts": "b", "media/ball.video": "c" };
    expect(readFiles(withFiles(new Map(), files))).toEqual(files);
  });
});
