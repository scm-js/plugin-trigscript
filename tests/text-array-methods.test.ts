/**
 * TrigScript 4: the text and array methods a program was missing — trim, replace, replaceAll, toUpperCase /
 * toLowerCase, lastIndexOf, split, parseInt / Number / isNaN on texts; shift, unshift, splice, at, lastIndexOf and join
 * on arrays of every kind. Each body is run in JavaScript too, and the prints compared. Every text starts from a number
 * the program holds, so nothing is worked out when the script is built.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string): CompileResult => compileScript(ts, { "main.ts": `program(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string): CompileResult => { const r = raw(body); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string) => { const r = compile(body); return simulatePrograms(r.ir, 1, { strings: r.strings }); };
const messages = (body: string) => raw(body).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
const js = (body: string): string[] => { const out: string[] = []; new Function("print", ts.transpile(body, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string) => { const sim = run(body); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body)); };

describe("texts", () => {
  it("trim, trimStart, trimEnd", () => {
    same("let k = 3; let a = `  \\t hi ${k}  `; let none = `${k}`.slice(1); print(`[${a.trim()}][${a.trimStart()}][${a.trimEnd()}][${none.trim()}]`);");
  });
  it("replace the first, replaceAll every one, an empty text to find, nothing found", () => {
    same("let k = 2; let s = `a-b-c-${k}`; print(`${s.replace('-', '+')} ${s.replaceAll('-', '')} ${s.replaceAll('', '.')} ${s.replace('x', 'y')} ${s.replaceAll('-', '--')}`);");
  });
  it("toUpperCase and toLowerCase change A to Z only", () => {
    same("let k = 2; let s = `Hello, World ${k}!`; print(`${s.toUpperCase()}|${s.toLowerCase()}`);");
  });
  it("lastIndexOf", () => {
    same("let k = 2; let s = `abcabc${k}`; print(`${s.lastIndexOf('bc')} ${s.lastIndexOf('z')} ${s.lastIndexOf('')} ${s.indexOf('bc')}`);");
  });
  it("split: at a text, at each character, with a limit, and a text with no separator in it", () => {
    same("let k = 2; let s = `a,bb,,c${k}`; const parts = s.split(','); let out = ''; for (const p of parts) out += `[${p}]`; let chars = ''; for (const c of `ab${k}`.split('')) chars += c + '.'; print(`${parts.length} ${out} ${parts[1]} ${chars} ${s.split(',', 2).length} ${s.split(';').length} ${s.split(',')[3]}`);");
  });
  it("split taken apart, and a command typed in chat read from it", () => {
    same("let k = 2; let s = ` -give ${k} 30 `; const [cmd, who, amount] = s.trim().split(' '); if (cmd == '-give') print(`${parseInt(who) * 10} ${Number(amount) + 1}`);");
  });
  it("parseInt: spaces, a sign, stops at what is not a digit, a radix", () => {
    same("let k = 2; print(`${parseInt(` -42abc${k}`)} ${parseInt(`+7${k}`)} ${parseInt(`ff${k}`, 16)} ${parseInt(`101${k}`, 2)} ${Number.parseInt(`0${k}`)}`);");
  });
  it("isNaN of parseInt: whether a text has a number in it", () => {
    same("let k = 2; let a = `x${k}`; let b = `${k}x`; print(`${isNaN(parseInt(a)) ? 'nan' : 'number'} ${isNaN(parseInt(b)) ? 'nan' : 'number'} ${Number.isNaN(Number(a)) ? 'nan' : 'number'}`);");
  });
  it("isNaN of a number of the program is refused, with what to write", () => {
    expect(messages("let k = 2; if (isNaN(k)) k = 0;").join("\n")).toMatch(/never NaN/);
  });
  it("a regular expression is refused", () => {
    expect(messages("let k = 2; let s = `a${k}`; let t = s.replace(/a/, 'b');").join("\n")).toMatch(/not a regular expression/);
  });
});

describe("arrays of numbers", () => {
  it("shift, unshift, splice, at, lastIndexOf, join", () => {
    same("let xs = [1, 2, 3]; let k = 9; xs.push(4); xs.unshift(k, 8); let a = xs.shift()!; xs.splice(1, 2, 70, 71, 72); xs.splice(-1); print(`${a} ${xs.join('-')} ${xs.at(-1)} ${xs.at(0)} ${xs.length} ${xs.lastIndexOf(71)} ${xs.unshift(5)} ${xs.join()}`);");
  });
  it("splice that removes more than it adds, adds more than it removes, and from past the end", () => {
    same("let xs = [0, 1, 2, 3, 4, 5]; let k = 1; xs.splice(k, 3, 9); let a = xs.join(''); xs.splice(k, 0, 7, 7, 7); let b = xs.join(''); xs.splice(99, 1, 6); xs.splice(-2, 1); print(`${a} ${b} ${xs.join('')}`);");
  });
  it("shift and at with ?? for an empty array or a place past the end", () => {
    same("let xs = [1]; let a = xs.shift() ?? -1; let b = xs.shift() ?? -1; xs.push(4); let c = xs.at(5) ?? 7; let d = xs.at(-1) ?? 7; print(`${a} ${b} ${c} ${d}`);");
  });
  it("a queue: push at the back, shift from the front", () => {
    same("const q: number[] = []; let k = 0; let out = ''; while (k < 6) { q.push(k * k); if (k % 2 == 1) out += `${q.shift()} `; k++; } out += q.join(','); print(out);");
  });
  it("a const array that only shift, unshift and splice change is the program's, not a list of the script", () => {
    same("const xs = [1, 2, 3, 4]; xs.splice(-1); xs.shift(); xs.unshift(0); print(xs.join(' '));");
  });
  it("join of booleans", () => {
    same("let fs = [true, false]; let k = 1; fs.push(k > 0); print(fs.join(' '));");
  });
});

describe("arrays of texts, records and units", () => {
  it("texts: shift as a value, unshift, splice, at, lastIndexOf", () => {
    same("const names: string[] = []; let k = 2; names.push(`a${k}`); names.push('b'); names.push('c'); names.unshift('z'); let f = names.shift()!; names.splice(1, 1, 'B1', 'B2'); print(`${f} ${names.join(',')} ${names.at(-1)} ${names.lastIndexOf('c')} ${names.length}`);");
  });
  it("records: shift, unshift and splice keep each row's text with it", () => {
    same("const ws: { n: number; s: string }[] = []; let k = 2; ws.push({ n: 1, s: 'a' }); ws.push({ n: 2, s: `b${k}` }); ws.push({ n: 3, s: 'c' }); ws.shift(); ws.unshift({ n: 0, s: 'z' }); ws.splice(1, 0, { n: 9, s: `y${k}` }); ws.splice(2, 1); let out = ''; for (const w of ws) out += `${w.n}${w.s} `; print(out);");
  });
});

describe("arrays of units", () => {
  it("shift, unshift and splice compile, a unit's three numbers moving together", () => {
    const r = compile("const squad: Unit[] = []; for (const u of unitsOf(P1)) squad.push(u); const lead = first({ owner: P1 }); squad.shift(); if (lead) squad.unshift(lead); squad.splice(1, 1);");
    expect(r.ir.length).toBe(1);
  });
});

describe("closures in arrays that shift and splice", () => {
  it("the closures moved keep their environments; those taken out are let go of", () => {
    same("function tag(n: number) { return () => n; } const hs: (() => number)[] = []; let k = 0; while (k < 5) { hs.push(tag(k * 10)); k++; } hs.shift(); hs.splice(1, 2, tag(99)); hs.unshift(tag(7)); let out = ''; for (const h of hs) out += `${h()} `; print(out);");
  });
});
