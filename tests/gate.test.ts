/**
 * What the random whole programs found (TrigScript 4, step 16: the gate before the Python goes), each held here as
 * the smallest script that showed it: what the front end worked out wrongly when a script was built, and what a map of
 * our own refused or got wrong. Each body is run in the simulator and, where it is a map of our own's, as the built
 * map walked from its bytes (`ownWalk.ts`); the lines are what JavaScript prints for the same code.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { buildOwnMap, isRefused } from "../compiler/backend/build";
import { emitOwn } from "../compiler/backend/own";
import { defaultLib } from "../bundle/lib.mjs";
import { OWN } from "./randomRun";
import { scenario } from "./ownScenario";
import { walkBuiltMap } from "./ownWalk";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const CHK = scenario();
const compile = (body: string): CompileResult => compileScript(ts, { "main.ts": `program(${/\bawait\b/.test(body) ? "async " : ""}() => {\n${body}\n});` }, NAMES, { lib: LIB, emitter: false, own: OWN });
const messages = (body: string) => compile(body).diagnostics.map((d) => d.message);
/** The simulator's lines for a body that compiles. */
function sim(body: string, frames = 2): string[] {
  const r = compile(body);
  expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  const s = simulatePrograms(r.ir, frames, { strings: r.strings });
  expect(s.faults).toEqual([]);
  return s.events.filter((e) => e.text !== undefined).map((e) => e.text!);
}
/** The built map's lines, walked from its bytes; a refusal is the failure. */
function walked(body: string, frames = 2): string[] {
  const r = compile(body);
  expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  const out = buildOwnMap({ chk: CHK, compiled: r });
  if (isRefused(out)) throw new Error(out.refused);
  return walkBuiltMap(out.chk, out.stats.players, out.stats.entries, frames).printed.map((p) => p.text);
}
/** Both agree with what JavaScript prints. */
function same(body: string, lines: string[], frames = 2): void {
  expect(sim(body, frames)).toEqual(lines);
  expect(walked(body, frames)).toEqual(lines);
}
const refusal = (body: string): string | null => { const r = compile(body); expect(r.diagnostics).toEqual([]); const o = emitOwn(r); return typeof o === "string" ? o : null; };

describe("worked out when the script is built", () => {
  it("a condition of the game in a ?:, a loop's bound or a text ternary is tested in the game, not taken as true", () => {
    // (switchIs() is a record when the script is built: an object, true to JavaScript. Switch 3 is clear.)
    same(`let n0 = 1000000; print(\`\${switchIs(switches.Switch3, "set") ? 24 : n0}\`);`, ["1000000"]);
    same(`let n = 0; n = (switchIs(switches.Switch3, "set") ? -77 : -2147483648) & 7; print(\`\${n}\`);`, ["0"]);
    same(`const p = { x: -2147483648, y: -77 }; for (let i = 0; i < ((switchIs(switches.Switch3, "set") ? p.y : p.x) & 7); i++) print(\`a \${i}\`); print("end");`, ["end"]);
    same(`print(switchIs(switches.Switch3, "set") ? "set" : "clear"); print(\`\${!switchIs(switches.Switch3, "set") ? 1 : 2}\`);`, ["clear", "1"]);
  });
  it("whole numbers divide as whole numbers: 7 / 2 is 3, 7 / fixed(2) is 3.5, known or not", () => {
    same(`let a = 0; let b = 7; const p = { y: 7 }; a = (-10) / 7; print(\`\${a} \${7 / 2} \${(-10) / b} \${7 / fixed(2)} \${(-10) / (p.y | 1)} \${3.5 / 2} \${(7 / 2) * 4}\`);`, ["-1 3 -1 3.5 -1 1.75 12"]);
    same(`const HALF = 7 / 2; const Q = 7 / fixed(2); let x = 1.5; print(\`\${HALF} \${Q} \${x / 2}\`);`, ["3 3.5 0.75"]);
  });
  it("whole numbers add, subtract and multiply in 32 bits, and shift as the game shifts", () => {
    same(`print(\`\${5 + 2147483647} \${2147483647 + 1} \${(-2147483648) - 1} \${65536 * 65536} \${u32(4000000000) + u32(1)}\`);`, ["-2147483644 -2147483648 2147483647 0 4000000001"]);
    // (An unrolled loop's counter is a constant: the sum wraps as it would in the game, and Math.abs of the least number is itself.)
    same(`let n = 0; for (let i = 0; i < 2; i++) n = Math.abs(i + 2147483647); print(\`\${n} \${Math.abs(-2147483648)}\`);`, ["-2147483648 -2147483648"]);
    same(`let n = 0; const xs = [0, 0, 0, 0]; for (let i = 0; i < 3; i++) xs[i & 3] = Math.min(7, i << 1000000); n = 65536 >> (-7); print(\`\${xs[2]} \${n} \${(-8) >> 40} \${1 >>> 32}\`);`, ["0 0 -1 0"]);
    const p = { x: -2147483648, y: -2 };
    same(`const p = { x: ${p.x}, y: ${p.y} }; print(\`\${p.x + p.x} \${p.x * p.y}\`);`, [`${(p.x + p.x) | 0} ${Math.imul(p.x, p.y)}`]);
  });
  it("an index with a pop in it is worked out before the value stored, as JavaScript has it", () => {
    same(`const xs = [255, 0]; const ys: number[] = [256, 2]; xs[(ys.pop() ?? 0) & 1] = ys.length ^ 255; print(\`\${xs[0]} \${xs[1]} \${ys.length}\`);`, ["254 0 1"]);
  });
});

describe("a map of our own", () => {
  it("takes a do loop whose test needs a value computed first, a call among them", () => {
    same(`let n0 = -77; let n1 = 65536; let n2 = 0; let g = 0; do { g += 1; if (g > 12) break; } while ((n1 + n2) >= (n2 | n0)); print(\`\${g}\`);`, ["13"]);
    same(`let n0 = -77; let n1 = 65536; let n2 = 0; let g = 0; do { g += 1; n2 += 1; } while (g < 12 && (n1 * 3) >= (n2 | n0)); print(\`\${g} \${n2}\`);`, ["12 12"]);
    same(`let g = 0; let n = 3; function f(): number { return n - g; } do { g += 1; if (g > 12) break; } while (f() > 0); print(\`\${g}\`);`, ["3"]);
    same(`let g = 0; let t: string = "Mf"; function f(): boolean { return t !== t; } do { g += 1; if (g > 12) break; } while (f()); print(\`\${g}\`);`, ["1"]);
    // (A continue lands on what the test needs: the test still sees the turn's values.)
    same(`let n = 0; let g = 0; do { g += 1; if (g > 12) break; if ((g & 1) != 0) continue; n += 1; } while ((n * 3) < (g | 1)); print(\`\${g} \${n}\`);`, ["2 1"]);
  });
  it("compares two made texts in a do loop's test, and in a for loop's bound", () => {
    same(`let t5: string = "x"; let t6: string = "k9"; let g = 0; t5 = \`\${t5}1\`; t6 = \`\${t6}2\`; do { g += 1; if (g > 12) break; } while (t5 === t6); print(\`\${g}\`);`, ["1"]);
    same(`let t5: string = "x"; let t6: string = "k9"; let n1 = 3; let g = 0; t5 = \`\${t5}1\`; t6 = \`\${t6}2\`; do { g += 1; if (g > 12) break; } while (!((t5 === t6) || ((-1) == n1))); print(\`\${g}\`);`, ["13"]);
    same(`let t4: string = "k9"; let z = 3; let g = 0; t4 = \`\${t4}\${z}\`; for (let i = 0; i < (((\`\${t4}\` !== t4) ? z : 2) & 7); i++) g += 1; print(\`\${g}\`);`, ["2"]);
    // (Inside a function, with a push in the body and a cell read in the test: the texts' work before the test and the test's own both stay.)
    same(`let n0 = 255; let t5: string = "ab"; let t6: string = "k9"; const ys: number[] = [2, 65536]; let g = 0; function f(): number { do { g += 1; if (g > 12) break; ys.push(2); } while (("k9".length == ((\`\${t5}\` !== t6) ? n0 : ys[255 % ys.length]))); return ys.length; } t5 = \`\${t5}1\`; print(\`\${f()} \${g}\`);`, ["3 1"]);
  });
  it("compares a cell at a masked index with a constant where the test stands: an if, a ?:, a boolean argument", () => {
    same(`let n0 = 1; let n = 0; const xs = [256, 65535, 1000000, 255]; if (xs[n0 & 3] <= 26) n = 1; else n = 2; print(\`\${n}\`);`, ["2"]);
    same(`let n0 = 3; let n = 0; const xs = [256, 65535, 1000000, 255]; n = (26 >= xs[n0 & 3]) ? 1 : 2; print(\`\${n}\`);`, ["2"]);
    same(`let n0 = 1; const xs = [0, 7, 7, 255]; function f(a: number, b: boolean): number { return b ? a : -a; } n0 = f(3, xs[n0 & 3] > 19); print(\`\${n0}\`);`, ["-3"]);
    expect(refusal(`let n0 = 1; let n = 0; const xs = [256, 65535, 1000000, 255]; while (n0 < 4) { if (xs[n0 & 3] <= 26) n = 1; else n = 2; n0 += 1; } print(\`\${n}\`);`)).toBeNull();
  });
  it("prints a text beside a call that changes it, each read where JavaScript reads it", () => {
    same(`let t: string = "zzz"; function f(a: number): number { t = \`\${t}1\`; return a; } print(\`s \${f(5)} \${t}\`);`, ["s 5 zzz1"]);
    same(`let t: string = "zzz"; function f(a: number): number { t = \`\${t}1\`; return a; } print(\`s \${t} \${f(5)} \${t}\`);`, ["s zzz 5 zzz1"]);
    same(`let t: string = "zzz"; function f(a: number): boolean { t = \`\${t}1\`; return a > 3; } print(\`s \${f(5) ? t : "no"} 0\`);`, ["s zzz1 0"]);
    same(`let t: string = "zzz"; function f(): void { t = "k9"; } function g(): number { f(); return 1; } print(\`s \${t} \${g()} \${t}\`);`, ["s zzz 1 k9"]);
    // (A text chosen among made ones before the call, and among known ones.)
    same(`let n1 = 2147483647; let b = false; let t: string = "zzz"; function f(a: number): number { t = (40 > t.length) ? \`\${t}\${n1}\` : "Marine"; return -10; } print(\`s \${b ? t : t} \${f(2)} \${t}\`);`, ["s zzz -10 zzz2147483647"]);
    same(`let b = false; let t: string = "zzz"; function f(a: number): number { t = "k9"; return -10; } print(\`s \${b ? "ab" : t} \${f(2)} \${b ? "ab" : t}\`);`, ["s zzz -10 k9"]);
  });
  it("compares a number of the game's with a constant below zero as the signed number it is", () => {
    for (const [op, want] of [[">=", "1"], [">", "1"], ["<=", "0"], ["<", "0"], ["==", "0"], ["!=", "1"]] as const) {
      same(`let g = 0; if (i32(deaths(P1, units.ZergZergling)) ${op} (-10)) g = 1; print(\`\${g}\`);`, [want]);
    }
    same(`let g = 0; if ((-10) <= i32(deaths(P1, units.ZergZergling))) g = 1; if (i32(deaths(P1, units.ZergZergling)) >= 0) g += 2; print(\`\${g}\`);`, ["3"]);
  });
  it("asks a text ternary's test for what it does, even when both sides are the same text", () => {
    same(`let t: string = "k9"; function f(): boolean { print("in"); return true; } print(\`s \${f() ? t : t}\`);`, ["in", "s k9"]);
    same(`let t: string = "k9"; function f(): boolean { try { } catch { } finally { print("in"); } return true; } print(\`s \${f() ? t : t}\`);`, ["in", "s k9"]);
  });
  it("runs a program's tasks on after its body ends", () => {
    same(`void (async () => { await sleep(frames(3)); print("after"); })(); print("end");`, ["end", "after"], 6);
    same(`async function add() { await sleep(frames(2)); print("added"); } const w = start(add()); await w; print("awaited"); void (async () => { await sleep(frames(4)); print("after the end"); })();`, ["added", "awaited", "after the end"], 10);
  });
  it("takes sync() inside an if and a loop, where the probes have it", () => {
    expect(refusal(`while (true) { if (keyPressed(P1, "W")) { const [x, y] = await sync(P1, local.camera.x + local.mouse.x, local.camera.y + local.mouse.y); print(\`\${x} \${y}\`); } await sleep(frames(1)); }`)).toBeNull();
  });
  it("calls a function that gives back a text twice in one text, each call's own", () => {
    const T = `function thousands(n: number): string { return n >= 1000 ? \`\${n / 1000}k\` : \`\${n}\`; }`;
    same(`${T} let n = 1500; let m = 3; print(\`\${thousands(n)} and \${thousands(m)}\`);`, ["1k and 3"]);
    same(`${T} let n = 1500; let m = 3; let a: string = ""; let b: string = ""; a = thousands(n); b = thousands(m); print(\`\${a} \${b}\`);`, ["1k 3"]);
    same(`${T} let n = 1500; let t: string = ""; t = thousands(n); t = \`\${t}+\${thousands(n + 1)}+\${thousands(7)}\`; print(t);`, ["1k+1k+7"]);
  });
  it("still refuses a function that calls itself with a finally in it, and says why", () => {
    expect(refusal(`let n = 3; function f(d: number): number { if (d <= 0) return 1; try { n += 1; } finally { n += 2; } return f(d - 1) * 2; } print(\`\${f(3)} \${n}\`);`)).toMatch(/which calls itself/);
  });
  it("a shift by a constant out of range as a value", () => {
    same(`let n0 = 65536; let g = 0; g = n0 >> (-7); let h = n0 << 40; print(\`\${g} \${h}\`);`, ["0 0"]);
  });
  it("a comparison of two constants is not written: TypeScript says it has no overlap", () => {
    expect(messages(`let n = 0; if (20 == -77) n = 1; print(\`\${n}\`);`)).toEqual([expect.stringMatching(/no overlap/)]);
  });
});
