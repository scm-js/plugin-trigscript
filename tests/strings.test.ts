/**
 * Texts (slice 8½): a `string` of a program is the id of a text of the built map's table when it only ever holds texts
 * written in the script, and a block of the heap when it is made while the map is played. The interpreter here;
 * `eud-build.test.ts` builds the same through eudplib.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, before = ""): CompileResult => compileScript(ts, { "main.ts": `${before}\nprogram(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, before = ""): CompileResult => { const r = raw(body, before); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, before = "", frames = 1, options: { heapCells?: number } = {}) => { const r = compile(body, before); return simulatePrograms(r.ir, frames, { strings: r.strings, ...options }); };
const messages = (body: string, before = "") => raw(body, before).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
const kept = (r: CompileResult, name: string): string | undefined => {
  let found: string | undefined;
  const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { const o = x as Record<string, unknown>; if (o.kind === "declare" && (o.decl as { name: string }).name === name) found = (o.decl as { text?: string }).text; Object.values(o).forEach(walk); } };
  walk(r.ir);
  return found;
};

describe("a text variable", () => {
  it("that only ever holds texts written in the script is kept as the text's id", () => {
    const r = compile("let title = \"Wave\"; let boss = false; if (boss) title = \"Boss\"; title = boss ? \"A\" : \"B\"; print(title);");
    expect(kept(r, "title")).toBe("id");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.text("title")).toBe("B");
    expect(shown(sim)).toEqual(["B"]);
  });
  it("that is given a template is one that is made, and holds what the template said then", () => {
    const r = compile("let n = 3; let s = `Wave ${n}`; n = 4; print(s); s += \"!\"; print(s); print(`${s} of ${n + 1}`);");
    expect(kept(r, "s")).toBe("made");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(shown(sim)).toEqual(["Wave 3", "Wave 3!", "Wave 3! of 5"]);
    expect(sim.faults).toEqual([]);
  });
  it("is a value: assigning copies, and the copy does not follow", () => {
    const sim = run("let n = 1; let a = `x${n}`; let b = a; a += \"y\"; print(a); print(b);");
    expect(shown(sim)).toEqual(["x1y", "x1"]);
  });
  it("String(n), n.toString(), + with a number on either side, a number below zero", () => {
    const sim = run("let n = -7; let a = String(n); let b = n.toString(); let c = \"n=\" + n; let d = n + \"!\"; print(a + b + c + d);");
    expect(shown(sim)).toEqual(["-7-7n=-7-7!"]);
  });
  it("name() in a kept text is filled in when the text is made", () => {
    const sim = run("let who = `${name(P1)} leads`; print(who);");
    expect(shown(sim)).toEqual(["Player 1 leads"]);
  });
});

describe("comparing and asking", () => {
  it("== and != between texts of the map, and with one that was made", () => {
    const sim = run("let a = \"red\"; let n = 5; let m = `r${\"ed\"}`; let made = `re${n}`; let r1 = a == \"red\"; let r2 = a != m; let r3 = made == \"re5\"; let r4 = made == a; let r5 = made < a;");
    expect([sim.value("r1"), sim.value("r2"), sim.value("r3"), sim.value("r4"), sim.value("r5")]).toEqual([true, false, true, false, true]);
  });
  it("length counts characters, not bytes; if (s) asks whether it is empty", () => {
    const sim = run("let n = 1; let s = `저글링${n}`; let len = s.length; let empty = `${\"\"}`; let e = String(\"\"); let a = false; let b = false; if (s) a = true; if (e) b = true;");
    expect(sim.value("len")).toBe(4);
    expect([sim.value("a"), sim.value("b")]).toEqual([true, false]);
  });
  it("startsWith, endsWith, includes, indexOf in characters", () => {
    const sim = run("let n = 2; let s = `저글링 wave ${n}`; let a = s.startsWith(\"저글\"); let b = s.endsWith(\"2\"); let c = s.includes(\"wave\"); let d = s.includes(\"boss\"); let i = s.indexOf(\"wave\"); let j = s.indexOf(\"x\"); let k = s.indexOf(\"e\", 8);");
    expect([sim.value("a"), sim.value("b"), sim.value("c"), sim.value("d")]).toEqual([true, true, true, false]);
    expect([sim.value("i"), sim.value("j"), sim.value("k")]).toEqual([4, -1, -1]);
  });
});

describe("the methods that give a text", () => {
  it("s[i], at, charAt, slice, substring with places from the end and out of range", () => {
    const sim = run("let n = 0; let s = `저글링abc${n}`; print(s[1]); print(s.at(-1) ?? \"\"); print(s.charAt(3)); print(s.slice(1, 4)); print(s.slice(-3)); print(s.substring(5, 2)); print(s.slice(4, 2) + \"|\" + s[99] + \"|\" + s.charAt(-1));");
    expect(shown(sim)).toEqual(["글", "0", "a", "글링a", "bc0", "링ab", "||"]);
    expect(sim.faults).toEqual([]);
  });
  it("padStart, padEnd, repeat", () => {
    const sim = run("let n = 7; let s = String(n); print(s.padStart(3, \"0\")); print(s.padEnd(4, \"ab\") + \"|\"); print(s.padStart(1)); print(s.repeat(3)); print(s.repeat(0) + \"|\");");
    expect(shown(sim)).toEqual(["007", "7aba|", "7", "777", "|"]);
  });
  it("a list of texts the script has, looked up by a variable, is a text of the map", () => {
    const r = compile("let level = 1; let title = titles[level]; print(title); level = 2; print(titles[level] + \"!\");", "const titles = [\"Easy\", \"Hard\", \"Insane\"];");
    expect(kept(r, "title")).toBe("id");
    expect(shown(simulatePrograms(r.ir, 1, { strings: r.strings }))).toEqual(["Hard", "Insane!"]);
  });
});

describe("functions and records", () => {
  it("a function takes a text and returns one", () => {
    const sim = run("function tag(what: string, n: number): string { return `[${what} ${n}]`; } let w = 2; let a = tag(\"wave\", w); let b = tag(a, w + 1); print(b);");
    expect(shown(sim)).toEqual(["[[wave 2] 3]"]);
    expect(sim.faults).toEqual([]);
  });
  it("a parameter the function assigns is its own copy", () => {
    const sim = run("function shout(s: string): string { s += \"!\"; return s; } let n = 1; let a = `hi${n}`; let b = shout(a); print(a); print(b);");
    expect(shown(sim)).toEqual(["hi1", "hi1!"]);
  });
  it("a record holds a text", () => {
    const sim = run("let n = 3; let boss = { name: \"Ultralisk\", hp: 400 }; boss.name = `${boss.name} ${n}`; boss.hp -= 1; print(`${boss.name}: ${boss.hp}`);");
    expect(shown(sim)).toEqual(["Ultralisk 3: 399"]);
  });
});

describe("the heap", () => {
  it("gets every block back: a hundred texts made in a loop leave it as it was", () => {
    const sim = run("let s = \"\"; for (let i = 0; i < 100 + extra; i++) { s = `number ${i}`; } let t = s + \"?\"; print(t);", "const extra = 0;", 1, { heapCells: 1024 });
    expect(shown(sim)).toEqual(["number 99?"]);
    expect(sim.faults).toEqual([]);
  });
  it("runs out where the game does, and says so", () => {
    const sim = run("let s = String(\"\"); let n = 0; while (n < 400) { s += \"0123456789\"; n++; }", "", 1, { heapCells: 1024 });
    expect(sim.faults.map((f) => f.message).join("\n")).toMatch(/cut off|Out of memory/);
  });
});

describe("loops and switch", () => {
  it("for…of walks a text a character at a time", () => {
    const sim = run("let n = 1; let s = `저a${n}`; let out = String(\"\"); let count = 0; for (const ch of s) { if (ch == \"a\") continue; out = ch + out; count++; } print(out); print(String(count));");
    expect(shown(sim)).toEqual(["1저", "2"]);
    expect(sim.faults).toEqual([]);
  });
  it("a loop over the places can sleep between its turns", () => {
    const sim = run("let n = 1; let s = `ab${n}`; let typed = String(\"\"); for (let i = 0; i < s.length; i++) { typed += s[i]; print(typed); sleep(frames(1)); }", "", 5);
    expect(shown(sim)).toEqual(["a", "ab", "ab1"]);
  });
  it("sleep inside a for…of over a text is refused, naming the loop that can", () => {
    expect(messages("let n = 1; let s = `ab${n}`; for (const ch of s) { print(ch); sleep(frames(1)); }").join("\n")).toMatch(/for…of over a text/);
  });
  it("while a text is not what it will be: the condition reads the variable", () => {
    const sim = run("let s = String(\"\"); while (s != \"aaa\") { s += \"a\"; } print(s);");
    expect(shown(sim)).toEqual(["aaa"]);
  });
  it("switch over a text, with fall through and a default", () => {
    const body = (v: string) => `let pick = ${v}; let n = 0; let m = \`x\${n}\`; switch (pick) { case "a": n = 1; break; case "b": case "c": n = 2; break; default: n = 9; } switch (m) { case "x0": n += 10; break; }`;
    expect(run(body("\"a\"") + "").value("n")).toBe(11);
    expect(run("let k = 1; let pick = [\"a\", \"c\", \"z\"][k]; let n = 0; switch (pick) { case \"a\": n = 1; break; case \"b\": case \"c\": n = 2; break; default: n = 9; }").value("n")).toBe(2);
    expect(run("let k = 2; let pick = [\"a\", \"c\", \"z\"][k]; let n = 0; switch (pick) { case \"a\": n = 1; break; case \"b\": case \"c\": n = 2; break; default: n = 9; }").value("n")).toBe(9);
  });
});

describe("a program's text in an action", () => {
  const actionTexts = (sim: ReturnType<typeof run>) => sim.events.map((e) => [e.action.type, e.text]);
  it("a text of the map goes into any action's text; a made one into the objectives, a leaderboard, a transmission", () => {
    const sim = run("let wave = 3; let title = wave > 2 ? \"Late game\" : \"Early game\"; setMissionObjectives(title); setMissionObjectives(`Wave ${wave} of 10`); leaderboardKills(`Kills in wave ${wave}`, units.TerranMarine);");
    expect(actionTexts(sim)).toEqual([[12, "Late game"], [12, "Wave 3 of 10"], [20, "Kills in wave 3"]]);
    expect(sim.faults).toEqual([]);
  });
  it("a made text past what a field shows is cut, and said", () => {
    const sim = run("let n = 1; let long = `${n}`.padEnd(300, \"x\"); setMissionObjectives(long);");
    expect((sim.events[0].text ?? "").length).toBe(255);
    expect(sim.faults.map((f) => f.message).join()).toMatch(/cut off/);
  });
  it("a unit type's name takes a made text", () => {
    const r = compile("let n = 2; stats(units.TerranMarine).name = `Marine Mk ${n}`;");
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.faults).toEqual([]);
  });
});

describe("patterns and closures", () => {
  it("two texts swapped, a text taken out of a record, a text a function given to forEach adds to", () => {
    expect(shown(run("let k = 1; let a = `a${k}`; let b = `b${k}`; [a, b] = [b, a]; print(a + b);"))).toEqual(["b1a1"]);
    expect(shown(run("let p = { name: \"A\", n: 1 }; let k = 2; p.name = `B${k}`; const { name: who, n } = p; print(`${who}${n}`);"))).toEqual(["B21"]);
    const sim = run("let xs = [1, 2, 3]; let s = String(\"\"); xs.forEach((x) => { s += `${x},`; }); print(s);");
    expect(shown(sim)).toEqual(["1,2,3,"]);
    expect(sim.faults).toEqual([]);
  });
});

describe("what is refused", () => {
  it("says what a text of a program can do", () => {
    expect(messages("let n = 1; let s = `a${n}`; let t = s.toUpperCase();").join("\n")).toMatch(/toUpperCase\(\) is not something a text of a program does/);
    expect(messages("let n = 1; let s = `a${n}`; let k = parseInt(s);").join("\n")).toMatch(/parseInt\(\)/);
    expect(messages("let names: string[] = []; names.push(\"a\"); names.sort();").join("\n")).toMatch(/An array of texts has push\(text\), pop\(\)/);
    // A function that calls itself may hold a text since 3.9 (tests/leftovers.test.ts); a loop over one around such a call may not.
    expect(messages("function f(n: number): number { let s = `x${n}`; print(s); if (n <= 0) return 0; return f(n - 1) + f(n - 2); } let k = 3; k = f(k);")).toEqual([]);
    expect(messages("let n = 1; let s = `map ${n}`; setNextScenario(s);").join("\n")).toMatch(/setNextScenario's text is one the game looks up by number/);
  });
});

describe("the probe", () => {
  it("says in the simulator what it expects to say in the game", () => {
    const r = compileScript(ts, { "main.ts": readFileSync(resolve(import.meta.dirname, "..", "probes", "strings.ts"), "utf8") }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]);
    const sim = simulatePrograms(r.ir, 24 * 80, { strings: r.strings });
    const lines = sim.events.map((e) => e.text ?? "").filter((t) => /^[A-Z]: /.test(t));
    const checked: string[] = [];
    for (const line of lines) {
      const m = /^([A-Z]): (.*?)(?: - [^(]*)? \(expect ([^)]*)\)$/.exec(line);
      if (!m || /your name|what is/.test(m[3])) continue;
      expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: ${m[3]}`);
      checked.push(m[1]);
    }
    expect(checked).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "R"]);
    expect(lines.some((t) => t.startsWith("P: Player 1 has 5 lives"))).toBe(true);
    expect(lines.some((t) => t.startsWith("Q: 3 "))).toBe(true);
    // What the actions showed: a text of the map, then made ones.
    const texts = sim.events.filter((e) => e.action.type !== 9 && e.text !== undefined).map((e) => e.text);
    expect(texts).toEqual(["Hold the line", "Wave 3: 12 Zerglings left", "Kills at 53", "Kills at 54", "Kills at 55", "Kills at 56", "Kills at 57", "Marine 7 reporting, wave 3"]);
    // One fault, the one step R is there for.
    expect(sim.faults.map((f) => f.message)).toEqual([expect.stringMatching(/1,200 bytes.*cut off/)]);
  });
});
