/**
 * Programs end to end under Node: fixture scripts compiled to IR, the IR
 * and the map handed to the eudplib plugin's command-line builder (the same worker the
 * editor runs), the built map opened again. Skipped unless a plugin-eudplib checkout is
 * at `EUDPLIB_DIR` or beside this repository.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { serializeIr } from "../compiler/eud";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";

const EUDPLIB_DIR = process.env.EUDPLIB_DIR ?? resolve(import.meta.dirname, "..", "..", "plugin-eudplib");
const MAP = resolve(import.meta.dirname, "..", "fixtures", "maps", "(2)Binary Burghs.scx");
const have = existsSync(join(EUDPLIB_DIR, "scripts", "build-map.mts")) && existsSync(MAP);

const LIB = defaultLib();
const NAMES = defaultScriptNames();

const FIXTURES: Record<string, string> = {
  counter: `program(() => {
    let n = 0;
    let gold = 0;
    while (true) {
      n += 1;
      gold = n * 5;
      if (gold >= 50 && n % 2 == 0) { setResources(P1, "add", gold, "ore"); displayText("paid"); }
      sleep(frames(24));
    }
  });`,
  nested: `program(() => {
    let i = 0;
    let lives = 3;
    function heal(by: number): number { return by + 1; }
    while (true) {
      i = 0;
      while (i < 3) {
        if (lives > 0) { sleep(frames(2)); lives -= 1; }
        else { lives = heal(lives); }
        i++;
      }
      switch (i) { case 3: lives = 9; break; default: lives = 0; }
      for (const k of [1, 2]) { if (k == 2) break; lives += k; }
      sleep(seconds(1));
    }
  });`,
  arithmetic: `program(() => {
    let a = 7; let b = 3; let q = 0;
    while (true) {
      q = a / b + a % b + a * b;
      if (a - b == 0 || Math.abs(b - a) > 3 || a >= -1) { q = Math.min(q, a) + Math.max(b, 2); }
      b = q / (b - b);
      createUnit(P1, units.TerranMarine, a, locations.Anywhere);
      playWav("sound\\\\glue\\\\mousedown2.wav", 0);
      sleep(seconds(5));
    }
  }, { owner: players.Force1 });`,
  perPlayer: `program(() => {
    let mine = 0;
    let total = shared(0);
    while (true) {
      mine += 1; total += 1;
      if (mine > total / 2) { mine = 0; }
      sleep(frames(12));
    }
  }, { owner: AllPlayers });`,
};

function build(name: string, src: string): { out: number; triggers: number } {
  const r = compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
  expect(r.diagnostics).toEqual([]);
  expect(r.ir.length).toBe(1);
  const ir = serializeIr(r.ir, r.strings);
  const dir = mkdtempSync(join(tmpdir(), "trigscript-eud-"));
  const irPath = join(dir, "trigscript.json");
  const pluginsPath = join(dir, "plugins.json");
  const outPath = join(dir, `${name}-eud.scx`);
  writeFileSync(irPath, ir);
  writeFileSync(pluginsPath, JSON.stringify({ trigscript: { ir: "/work/files/trigscript.json" }, eudTurbo: {} }));
  const res = spawnSync("npx", ["tsx", join(EUDPLIB_DIR, "scripts", "build-map.mts"), MAP, outPath, pluginsPath, `trigscript=${resolve(import.meta.dirname, "..", "python", "trigscript.py")}`, `file=trigscript.json=${irPath}`], { cwd: EUDPLIB_DIR, encoding: "utf8", env: { ...process.env, EUDPLIB_LOG: "1" } });
  if (res.status !== 0) throw new Error(`${name}: build failed\n${res.stdout}\n${res.stderr}`);
  const out = readFileSync(outPath).length;
  rmSync(dir, { recursive: true, force: true });
  // The builder prints "<path>: <bytes> bytes, <n> triggers" once the output opened again.
  const m = /(\d+) triggers/.exec(res.stdout);
  return { out, triggers: m ? Number(m[1]) : 0 };
}

describe.skipIf(!have)("programs build through the eudplib plugin", () => {
  for (const [name, src] of Object.entries(FIXTURES)) {
    it(`${name}: compiles to IR, builds, and the output opens with the payload's triggers`, () => {
      const { out, triggers } = build(name, src);
      expect(out).toBeGreaterThan(10_000);
      // eudplib's bootstrap is a fixed set of triggers on top of the map's own two.
      expect(triggers).toBeGreaterThan(2);
    }, 240_000);
  }
});

describe("the IR as the lowering reads it", () => {
  it("writes a program's text and sounds out, and keeps an index the script named", () => {
    const r = compileScript(ts, { "main.ts": `program(() => { displayText("hello"); playWav("sound\\\\x.wav", 0); });` }, NAMES, { lib: LIB });
    expect(r.diagnostics).toEqual([]);
    const ir = JSON.parse(serializeIr(r.ir, r.strings));
    const actions = ir.programs[0].body.filter((s: { kind: string }) => s.kind === "action").map((s: { record: { text: unknown; wav: unknown } }) => [s.record.text, s.record.wav]);
    expect(actions).toEqual([["hello", 0], [0, "sound\\x.wav"]]);
    expect(ir.version).toBe(2);
  });
});
