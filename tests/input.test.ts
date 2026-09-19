/**
 * What the players do (slice 4): keys, clicks, the mouse and typed lines — what the front end
 * makes of them, what it refuses, what the interpreter does with them, and the settings the
 * build hands to chatEvent and MSQC.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { serializeIr } from "../compiler/eud";
import { buildPlugins, inputPlugins, matchChat, parseChatPattern } from "../compiler/input";
import { defaultScriptNames, scriptNames } from "../compiler/names";
import { ProgramSimulation, type ProgramSimulationOptions } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const MARINE = 0, ZERGLING = 37;

const compileFile = (src: string, names = NAMES): CompileResult => compileScript(ts, { "main.ts": src }, names, { lib: LIB });
const compile = (body: string, options = ""): CompileResult => {
  const r = compileFile(`program(() => {${body}}${options});`);
  expect(r.diagnostics.map((d) => `${d.line}:${d.message}`)).toEqual([]);
  return r;
};
const errors = (body: string): string[] => compileFile(`program(() => {\n${body}\n});`).diagnostics.map((d) => `${d.line}:${d.message}`);
const simulate = (body: string, options: Partial<ProgramSimulationOptions> = {}) => {
  const r = compile(body);
  return new ProgramSimulation(r.ir, { strings: r.strings, ...options });
};
const loop = (inside: string) => `let n = 0; let v = 0; while (true) { ${inside} sleep(frames(1)); }`;
const unitByName = (lower: string) => ({ "terran marine": MARINE, terranmarine: MARINE, "zerg zergling": ZERGLING })[lower];

describe("chat patterns", () => {
  it("are written text and named captures", () => {
    expect(parseChatPattern("-help")).toEqual({ pattern: "-help", segments: ["-help"], captures: [] });
    expect(parseChatPattern("-spawn {n} {unit:unit}")).toMatchObject({ segments: ["-spawn ", 0, " ", 1], captures: [{ name: "n", kind: "number" }, { name: "unit", kind: "unit" }] });
    expect(parseChatPattern("-pay {kind:ore|gas} {n}!")).toMatchObject({ segments: ["-pay ", 0, " ", 1, "!"], captures: [{ name: "kind", kind: "word", words: ["ore", "gas"] }, { name: "n", kind: "number" }] });
  });

  it("say what is wrong with one", () => {
    const why = (p: string) => { try { parseChatPattern(p); return ""; } catch (err) { return (err as Error).message; } };
    expect(why("")).toMatch(/what the player types/);
    expect(why("{n}")).toMatch(/starts with its own word/);
    expect(why("-a {n}{m}")).toMatch(/nothing between them/);
    expect(why("-a {n} {n}")).toMatch(/two captures are called n/);
    expect(why("-a {2x}")).toMatch(/needs a name/);
    expect(why("-a { n }")).toMatch(/needs a name/);
    expect(why("-a {n")).toMatch(/without its \}/);
    expect(why("-a n}")).toMatch(/without its \{/);
    expect(why("-a {u:unit} {n}")).toMatch(/comes last/);
    expect(why("-a {u:unit}!")).toMatch(/comes last/);
    expect(why("-a {k:ore|ore}")).toMatch(/twice/);
    expect(why("-a {k:number}")).toMatch(/alone is a number/);
    expect(why("-a {a} {b} {c} {d}")).toMatch(/at most 3/);
    expect(why(`-${"x".repeat(80)}`)).toMatch(/78 bytes/);
  });

  it("match a whole line: text exactly, digits, words and names whatever the capitals", () => {
    const spawn = parseChatPattern("-spawn {n} {unit:unit}");
    expect(matchChat(spawn, "-spawn 3 Terran Marine", unitByName)).toEqual([3, MARINE]);
    expect(matchChat(spawn, "-spawn 3 terranmarine", unitByName)).toEqual([3, MARINE]);
    expect(matchChat(spawn, "-spawn 3 Nothing", unitByName)).toBeNull();
    expect(matchChat(spawn, "-spawn three Terran Marine", unitByName)).toBeNull();
    expect(matchChat(spawn, "-Spawn 3 Terran Marine", unitByName)).toBeNull();
    const pay = parseChatPattern("-pay {kind:ore|gas} {n}");
    expect(matchChat(pay, "-pay GAS 40", unitByName)).toEqual([1, 40]);
    expect(matchChat(pay, "-pay gas 40 please", unitByName)).toBeNull();
    expect(matchChat(pay, "-pay 99999999999", unitByName)).toBeNull();
    expect(matchChat(parseChatPattern("-set {n}"), "-set 99999999999", unitByName)).toEqual([0xfffff]);
    expect(matchChat(parseChatPattern("-help"), "-help", unitByName)).toEqual([]);
    expect(matchChat(parseChatPattern("-help"), "-helpme", unitByName)).toBeNull();
  });
});

describe("input: the front end", () => {
  it("a key, a click, the mouse and a typed line arrive as IR", () => {
    const r = compile(`while (true) {
      if (keyPressed(P1, "F2") && !clicked(P2, "right")) { const at = mouse(P1); centerLocation(3 as Location, at.x, at.y + 16); }
      const m = chatted(CurrentPlayer, "-give {n}");
      if (m) setResources(CurrentPlayer, "add", m.n, "ore");
      sleep(frames(1));
    }`);
    const ir = JSON.stringify(r.ir);
    expect(ir).toContain(`"input":{"source":"key","key":"F2","player":0}`);
    expect(ir).toContain(`"input":{"source":"click","button":"right","player":1}`);
    expect(ir).toContain(`"input":{"source":"mouse","axis":"x","player":0}`);
    expect(ir).toContain(`"input":{"source":"chat","pattern":"-give {n}","capture":null,"player":13}`);
    expect(ir).toContain(`"input":{"source":"chat","pattern":"-give {n}","capture":0,"player":13}`);
    expect(ir).toContain(`"kind":"centerLocation","location":3`);
    // What chatted() found is the program's: a boolean for the line and a number for each value, all listed as variables.
    expect(r.variables.map((v) => `${v.name}:${v.kind}`)).toEqual(["at.x:number", "at.y:number", "m:boolean", "m.n:number"]);
  });

  it("types a pattern's captures by their names", () => {
    expect(errors(`const m = chatted(P1, "-give {n}"); if (m) setResources(P1, "add", m.amount, "ore");`)[0]).toMatch(/Property 'amount' does not exist/);
    expect(errors(`const m = chatted(P1, "-spawn {u:unit}"); if (m) createUnit(P1, m.u, 1, locations.Anywhere);`)).toEqual([]);
    expect(errors(`if (keyPressed(P1, "F13")) displayText("x");`)[0]).toMatch(/not assignable to parameter of type 'Key'/);
    // The game reports no press of F6 (the probe, twice): not a Key, and said plainly to a script that gets past the types.
    expect(errors(`if (keyPressed(P1, "F6")) displayText("x");`)[0]).toMatch(/not assignable to parameter of type 'Key'/);
    expect(errors(`if (keyPressed(P1, "f6" as Key)) displayText("x");`)[0]).toMatch(/keeps F6 to itself/);
  });

  it("an action takes a unit type and a count from a typed line at once", () => {
    const r = compile(`const m = chatted(P1, "-spawn {n} {what:unit}"); if (m) createUnit(P1, m.what, m.n, locations.Anywhere);`);
    const action = JSON.stringify(r.ir).match(/"variables":\[[^\]]*\]/)?.[0] ?? "";
    expect(action).toContain(`"field":"unitId","bits":16`);
    expect(action).toContain(`"field":"modifier","bits":8`);
  });

  it("says what is wrong", () => {
    expect(errors(`keyPressed(P1, "F2");`)[0]).toMatch(/does nothing on its own/);
    expect(errors(`if (keyPressed(players.Force1, "F2")) displayText("x");`)[0]).toMatch(/expected one player/);
    expect(errors(`if (chatted(P1, "{n}")) displayText("x");`)[0]).toMatch(/starts with its own word/);
    expect(errors(`let x = mouse(P1) + 1;`)[0]).toBeDefined();
    expect(errors(`let n = 0; centerLocation(locations.Anywhere, n, n);`)[0]).toMatch(/not Anywhere/);
    expect(errors(`const u = underMouse(P1, { within: 0 });`)[0]).toMatch(/distance in pixels/);
    // What the players did does not change within a frame: a loop waiting for it has to sleep.
    expect(errors(`while (!keyPressed(P1, "F2")) { displayText("waiting"); }`)[0]).toMatch(/never changes inside it/);
    expect(errors(`while (!keyPressed(P1, "F2")) { sleep(frames(1)); }`)).toEqual([]);
  });

  it("outside a program the functions say where they belong", () => {
    // Outside, the call would be an object and \`if (keyPressed(…))\` always true: refused at once instead.
    expect(compileFile(`if (keyPressed(P1, "F2")) trigger(P1, [always()], [displayText("x")]);`).diagnostics[0].message).toMatch(/keyPressed\(\) asks what a player does while the game runs: use it inside program\(\)/);
    expect(compileFile(`const m = chatted(P1, "-help");`).diagnostics[0].message).toMatch(/inside program\(\)/);
    // A helper of the script's own, called from a program, is the program's.
    expect(compileFile(`const fire = () => keyPressed(CurrentPlayer, "F2"); program(() => { while (true) { if (fire()) displayText("x"); sleep(frames(1)); } });`).diagnostics).toEqual([]);
    expect(compileFile(`centerLocation(1 as Location, 0, 0);`).diagnostics[0].message).toMatch(/inside program\(\)/);
  });
});

describe("input: the plan and the build's plugins", () => {
  it("no input, no plugins but the lowering", () => {
    const r = compile(`displayText("hi");`);
    expect(r.input).toBeNull();
    expect(Object.keys(buildPlugins(r.input, "/ir.json"))).toEqual(["trigscript", "eudTurbo"]);
    expect(JSON.parse(serializeIr(r.ir, r.strings, r.input)).input).toBeUndefined();
  });

  it("keys and clicks: MSQC with one location of its own, the highest free among the first 63", () => {
    const r = compile(`while (true) { if (keyPressed(P1, "A") || keyPressed(P1, "Escape") || keyPressed(P2, "A") || clicked(P1)) displayText("x"); sleep(frames(1)); }`);
    expect(r.input).toEqual({ keys: ["A", "Escape"], buttons: ["left"], chats: [], qcLocation: 62, mouseBase: null });
    const plugins = buildPlugins(r.input, "/ir.json");
    expect(Object.keys(plugins)).toEqual(["trigscript", "MSQC", "eudTurbo"]);
    expect(plugins.MSQC).toEqual({ QCUnit: 58, QCLoc: 62, QCPlayer: 11, QCDebug: "false", "KeyPress(A); NotTyping": "tsin_key0, 1", "KeyPress(ESC); NotTyping": "tsin_key1, 1", "MouseDown(L)": "tsin_button0, 1" });
  });

  it("the mouse: eight locations in a row, clear of the map's own and of Anywhere", () => {
    const names = scriptNames({ locations: [{ index: 62, name: "Top" }, { index: 58, name: "Gate" }] });
    const r = compileFile(`program(() => { while (true) { const u = underMouse(P1); if (u) u.kill(); sleep(frames(1)); } });`, names);
    expect(r.diagnostics).toEqual([]);
    // Slot 62 and 58 are the map's: MSQC's own is 61, and the run of eight ends below 58.
    expect(r.input).toMatchObject({ qcLocation: 61, mouseBase: 51 });
    expect(inputPlugins(r.input!).after.MSQC.Mouse).toBe(51);
  });

  it("a map with no room is told so, where the input is read", () => {
    const names = scriptNames({ locations: Array.from({ length: 63 }, (_, index) => ({ index, name: `L${index}` })) });
    const r = compileFile(`program(() => {\n while (true) {\n if (clicked(P1)) displayText("x");\n sleep(frames(1)); } });`, names);
    expect(r.diagnostics.map((d) => `${d.line}:${d.message}`)).toEqual([expect.stringMatching(/^3:.*one free location among the map's first 63/)]);
  });

  it("chat: chatEvent before the lowering, MSQC after it, one value channel per capture", () => {
    const r = compile(`while (true) { const m = chatted(P1, "-spawn {n} {unit:unit}"); if (m || chatted(P1, "-help")) displayText("x"); sleep(frames(1)); }`);
    const plugins = buildPlugins(r.input, "/ir.json");
    expect(Object.keys(plugins)).toEqual(["chatEvent", "trigscript", "MSQC", "eudTurbo"]);
    expect(plugins.chatEvent).toEqual({ __addr__: "tsin_heard", __ptrAddr__: "tsin_pointer", __lenAddr__: "tsin_length", __patternAddr__: "tsin_pattern" });
    expect(plugins.MSQC).toMatchObject({ "tsin_chat.AtLeast(1); val, tsin_chat": "tsin_chat_in", "tsin_chat.AtLeast(1); val, tsin_capture0": "tsin_capture0_in", "tsin_chat.AtLeast(1); val, tsin_capture1": "tsin_capture1_in" });
    const ir = JSON.parse(serializeIr(r.ir, r.strings, r.input));
    expect(ir.input.chats.map((c: { pattern: string }) => c.pattern)).toEqual(["-spawn {n} {unit:unit}", "-help"]);
    // A unit's name is known by its identifier and by the name the game shows.
    expect(ir.input.unitNames).toEqual(expect.arrayContaining([["terranmarine", 0], ["terran marine", 0]]));
    expect(ir.input.unitNames.every(([, id]: [string, number]) => id < 228)).toBe(true);
  });
});

describe("input: the interpreter", () => {
  it("a key and a click are true on the one frame they arrive", () => {
    const sim = simulate(loop(`if (keyPressed(CurrentPlayer, "F2")) n += 1; if (clicked(CurrentPlayer, "right")) v += 10;`));
    sim.step();
    sim.press("f2").step();
    sim.step();
    expect(sim.value("n")).toBe(1);
    sim.press("F3").click("left").step();
    expect([sim.value("n"), sim.value("v")]).toEqual([1, 0]);
    sim.press("F2").click("right").step();
    expect([sim.value("n"), sim.value("v")]).toEqual([2, 10]);
  });

  it("another player's key is not this player's", () => {
    const sim = simulate(loop(`if (keyPressed(P2, "A")) n += 1; if (keyPressed(P1, "A")) v += 1;`));
    sim.press("A", 1).step();
    sim.press("A").step();
    expect([sim.value("n"), sim.value("v")]).toEqual([1, 1]);
  });

  it("the mouse stays where it was put, and a const keeps where it was", () => {
    const sim = simulate(`let x = 0; let kept = 0; const at = mouse(P1); while (true) { x = mouse(P1).x + mouse(P1).y; kept = at.x; sleep(frames(1)); }`);
    sim.moveMouse(100, 20).step();
    sim.moveMouse(300, 5).step();
    sim.step();
    expect([sim.value("x"), sim.value("kept")]).toEqual([305, 100]);
  });

  it("centerLocation moves a location onto a point, its size kept", () => {
    const sim = simulate(`const at = mouse(P1); centerLocation(2 as Location, at.x, at.y);`, { locations: { 2: { left: 0, top: 0, right: 64, bottom: 32 } } });
    sim.moveMouse(500, 400).step();
    expect(sim.locations.get(2)).toEqual({ left: 468, top: 384, right: 532, bottom: 416 });
  });

  it("underMouse is the nearest unit within reach of the mouse, or none", () => {
    const units = [{ type: MARINE, owner: 0, x: 100, y: 100, hp: 40 }, { type: ZERGLING, owner: 1, x: 130, y: 100, hp: 35 }];
    const body = loop(`const u = underMouse(P1); n = u ? u.type + 1 : 0; const mine = underMouse(P1, { owner: P1, within: 200 }); v = mine ? mine.x : 0;`);
    const sim = simulate(body, { units });
    sim.moveMouse(125, 100).step();
    expect([sim.value("n"), sim.value("v")]).toEqual([ZERGLING + 1, 100]);
    sim.moveMouse(400, 400).step();
    expect([sim.value("n"), sim.value("v")]).toEqual([0, 0]);
  });

  it("a typed line is the first pattern it fits, for one frame, with its values", () => {
    const sim = simulate(loop(`
      const m = chatted(P1, "-spawn {n} {unit:unit}");
      if (m) { n += m.n; createUnit(P1, m.unit, m.n, locations.Anywhere); }
      const g = chatted(P1, "-pay {kind:ore|gas} {n}");
      if (g != null && g.kind == 1) v += g.n;
      if (chatted(P1, "-help")) v += 1000;
    `), { unitByName });
    sim.type("-spawn 3 Zerg Zergling").step();
    expect(sim.value("n")).toBe(3);
    expect(sim.events.at(-1)?.action).toMatchObject({ unitId: ZERGLING, modifier: 3 });
    sim.step();
    expect(sim.value("n")).toBe(3);
    sim.type("-pay ore 5").step();
    sim.type("-pay Gas 7").step();
    sim.type("-pay wood 9").step();
    sim.type("hello everyone").step();
    expect(sim.value("v")).toBe(7);
    sim.type("-help").step();
    expect(sim.value("v")).toBe(1007);
    // Somebody else's line is not Player 1's.
    sim.type("-help", 1).step();
    expect(sim.value("v")).toBe(1007);
  });
});
