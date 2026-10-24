/**
 * The build in the editor (TrigScript 4, step 14): a scenario's bytes in, the map of our own out — the programs'
 * payload after the strings, the start-up in TRIG, eudplib's fixes applied, the map's own triggers taken along, a
 * unit-properties slot in transit when the players are read — and a refusal said as one.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { buildOwnMap, isRefused, type OwnBuild } from "../compiler/backend/build";
import { Sections, freeCuwpSlot, intern, readFacts, readStrings, readTriggers, writeChunks, writeStrings } from "../compiler/backend/chk";
import { scenario, u16 } from "./ownScenario";
import { STRINGS } from "../compiler/backend/layout";
import { ActionType, PlayerGroup, decodeTriggers, emptyAction, emptyTrigger, type TriggerRecord } from "../vendor/triggers";
import { programVariables, readTriggerMap, readVariableMap } from "../compiler/gameVariables";
import { simulatePrograms } from "../compiler/simulateIr";
import { walkBuiltMap } from "./ownWalk";
import { defaultLib } from "../bundle/lib.mjs";

let lib: ReturnType<typeof defaultLib> | undefined;
const compile = (source: string, file = "main.ts") => {
  lib ??= defaultLib();
  const r = compileScript(ts, { [file]: source }, defaultScriptNames(), { lib, emitter: false, own: { players: { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, humans: [0], width: 64 * 32, height: 64 * 32 } });
  expect(r.diagnostics).toEqual([]);
  return r;
};

const PROGRAM = `program(() => { let n = 0; while (true) { n++; displayText("tick"); sleep(seconds(1)); } });`;
const WITH_VALUES = `program(() => { let n = 0; while (true) { n++; displayText(\`n is \${n}\`); sleep(seconds(1)); } });`;

function built(source: string, chk = scenario(), more: Partial<Parameters<typeof buildOwnMap>[0]> = {}): OwnBuild {
  const out = buildOwnMap({ chk, compiled: compile(source), ...more });
  if (isRefused(out)) throw new Error(out.refused);
  return out;
}

describe("the build in the editor", () => {
  it("lays the programs out after the strings, the start-up in TRIG, and makes the file a Remastered one", () => {
    const chk = scenario();
    const out = built(PROGRAM, chk);
    const s = new Sections(out.chk);
    expect(readFacts(s).version).toBe(206);
    expect(s.get("STR ")).toBeNull();
    const strx = s.get("STRx")!;
    const table = readStrings(strx, true);
    // The map's strings as they were, then the pool's texts and what the actions show.
    expect(table.entries.slice(0, 2).map((e) => new TextDecoder().decode(e))).toEqual(["Probe", "P1 says hi"]);
    expect(table.entries.map((e) => new TextDecoder().decode(e))).toContain("tick");
    expect(strx.length).toBe(writeStrings(table).data.length + out.stats.payloadBytes);
    expect(out.stats.address).toBe(STRINGS + ((writeStrings(table).data.length + 3) & ~3));
    expect(out.stats.runs).toBe(1);
    expect(out.stats.runNames).toEqual(["program 1 as P1"]);
    expect(out.stats.graphTriggers).toBeGreaterThan(0);
    // The start-up: a few triggers of the map's own, each once; nothing else in the list.
    const trig = decodeTriggers(s.get("TRIG")!);
    expect(trig.length).toBe(out.stats.startUpTriggers);
    expect(trig.length).toBeGreaterThan(0);
    expect(out.stats.input).toBeNull();
    // Nothing of the input: the properties slot untouched.
    expect([...s.get("UPRP")!].every((b) => b === 0)).toBe(true);
    // What was done, said.
    expect(out.lines.join("\n")).toMatch(/a Remastered file \(VER 206, was 59\)/);
    expect(out.lines.join("\n")).toMatch(/the strings written as STRx/);
    expect(out.lines.at(-1)).toMatch(/^1 run \(program 1 as P1\), \d+ triggers of the programs, payload \d+ bytes at 0x[0-9a-f]+, 0 triggers of the map's own \(0 copies\), start-up \d+ triggers, \d+ strings added$/);
    // The sections the build does not touch come back as they were.
    const before = new Sections(chk);
    for (const name of ["DIM ", "OWNR", "FORC"]) expect([...s.get(name)!]).toEqual([...before.get(name)!]);
  });

  it("applies eudplib's fixes: unit flags, settings rows at the defaults, null tiles", () => {
    const out = built(PROGRAM);
    const s = new Sections(out.chk);
    const unit = s.get("UNIT")!;
    // The hit-points flag of a unit at 100 % cleared and the figure zeroed; the energy figure with no flag zeroed.
    expect(unit[14]).toBe(0);
    expect(unit[17]).toBe(0);
    expect(unit[19]).toBe(0);
    expect(s.get("UNIx")![228 + 4 * 7]).toBe(0);
    const mtxm = s.get("MTXM")!;
    expect([mtxm[10], mtxm[11]]).toEqual([1, 0]);
    expect(out.lines.join("\n")).toMatch(/1 placed unit with a figure's flag at odds/);
    expect(out.lines.join("\n")).toMatch(/1 row of UNIx at the defaults/);
    expect(out.lines.join("\n")).toMatch(/1 null tile \(0000\.00\) made 0000\.01.*at \(5, 0\)/);
  });

  it("keeps an STRx table as it is and adds to it; a template is written over its own string", () => {
    const out = built(WITH_VALUES, scenario({ extended: true, strings: ["Probe", "Hello"] }));
    const s = new Sections(out.chk);
    expect(out.lines.join("\n")).not.toMatch(/written as STRx/);
    const strx = s.get("STRx")!;
    const table = readStrings(strx, true);
    expect(table.entries.slice(0, 2).map((e) => new TextDecoder().decode(e))).toEqual(["Probe", "Hello"]);
    // The template's string points at a dword boundary inside the section, past the header.
    const view = new DataView(strx.buffer, strx.byteOffset, strx.byteLength);
    const count = view.getUint32(0, true);
    const offsets = [...Array(count).keys()].map((i) => view.getUint32(4 * (1 + i), true));
    const aligned = offsets.filter((o) => (STRINGS + o) % 4 === 0 && o > 4 * (1 + count));
    expect(aligned.length).toBeGreaterThan(0);
  });

  it("takes the map's own triggers along, hyper triggers left out, and marks a properties slot in transit for the players' input", () => {
    const hand: TriggerRecord = { ...emptyTrigger(), players: Array.from({ length: 27 }, (_, g) => (g === PlayerGroup.AllPlayers ? 1 : 0)), actions: [{ ...emptyAction(), type: ActionType.SetResources, player: PlayerGroup.Player1, target: 5, modifier: 8, unitId: 0 }] };
    const hyper: TriggerRecord = { ...emptyTrigger(), flags: 4, players: hand.players, actions: Array.from({ length: 63 }, () => ({ ...emptyAction(), type: ActionType.Wait, time: 0 })) };
    const cuwp: TriggerRecord = { ...emptyTrigger(), players: hand.players, actions: [{ ...emptyAction(), type: ActionType.CreateUnitWithProperties, player: PlayerGroup.Player1, unitId: 0, modifier: 1, location: 1, target: 1 }] };
    const chk = scenario({ triggers: [hand, hyper, cuwp] });
    expect(freeCuwpSlot(readTriggers(new Sections(chk)))).toBe(2);
    const out = built(`program(() => { while (true) { if (keyPressed(P1, "A")) displayText("A"); sleep(frames(1)); } });`, chk);
    expect(out.stats.mapTriggers).toBe(2);
    expect(out.stats.mapTriggerCopies).toBe(4);
    expect(out.stats.hyperTriggersLeftOut).toBe(1);
    expect(out.stats.input).toMatchObject({ keys: 1, mouse: false, humans: [0], cuwp: 2 });
    const s = new Sections(out.chk);
    const uprp = s.get("UPRP")!;
    const view = new DataView(uprp.buffer, uprp.byteOffset, uprp.byteLength);
    expect(view.getUint16(20, true) & 4).toBe(4);
    expect(view.getUint16(20 + 16, true) & 4).toBe(4);
    expect(s.get("UPUS")![1]).toBe(1);
    expect(out.lines.join("\n")).toMatch(/input: 1 keys, 0 sync slots; carriers of type 58/);
    expect(out.lines.at(-1)).toMatch(/2 triggers of the map's own \(4 copies, 1 hyper triggers left out\)/);
    // A probe on a melee base leaves them out.
    expect(built(PROGRAM, chk, { dropMapTriggers: true }).stats.mapTriggers).toBe(0);
  });

  it("the script's own records go in when the list does not hold them yet, with their texts", () => {
    const out = built(`trigger(P1, [always()], [displayText("from a record")]);\n${PROGRAM}`);
    expect(out.stats.mapTriggers).toBe(1);
    const table = readStrings(new Sections(out.chk).get("STRx")!, true);
    expect(table.entries.map((e) => new TextDecoder().decode(e))).toContain("from a record");
  });

  it("refuses what a map of our own does not take, in the compile too, with the line and the file", () => {
    const r = compile(`program(() => { while (true) { wait(500); sleep(frames(1)); } });`);
    expect(r.ownRefusal).toMatch(/^the action Wait \(.*\), line 1$/);
    const out = buildOwnMap({ chk: scenario(), compiled: r });
    expect(isRefused(out) && out.refused).toBe(r.ownRefusal);
    // The entry file's name is left out; another file's is said.
    const other = compileScript(ts, { "main.ts": `import "./waves";`, "waves.ts": `program(() => {\n  while (true) { wait(500); sleep(frames(1)); }\n});` }, defaultScriptNames(), { lib: lib!, emitter: false, own: { players: { slots: [0], forces: [0, 0, 0, 0, 0, 0, 0, 0] }, humans: [0], width: 2048, height: 2048 } });
    expect(other.diagnostics).toEqual([]);
    expect(other.ownRefusal).toMatch(/^the action Wait \(.*\), line 2 of waves\.ts$/);
    // No programs, or no asking: nothing said.
    expect(compile(`trigger(P1, [always()], [wait(500)]);`).ownRefusal).toBeUndefined();
    expect(compileScript(ts, { "main.ts": PROGRAM }, defaultScriptNames(), { lib: lib!, emitter: false }).ownRefusal).toBeUndefined();
    // Asked for a map none of whose players is among the owners (a force with nobody in it).
    const nobody = compileScript(ts, { "main.ts": `program(() => { displayText("x"); }, { owner: players.Force4 });` }, defaultScriptNames(), { lib: lib!, emitter: false, own: { players: { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, humans: [0], width: 2048, height: 2048 } });
    expect(nobody.diagnostics).toEqual([]);
    expect(nobody.ownRefusal).toBe("no human or computer player of this map is among the program's owners");
  });

  it("the settings reach the build: a stack past what the map lays out is refused, and a lower depth takes", () => {
    const deep = `function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\nprogram(() => { let a: number[] = []; while (true) { a.push(fib(minerals(P1))); displayText("x"); sleep(seconds(1)); } });`;
    const r = compile(deep);
    const refused = buildOwnMap({ chk: scenario(), compiled: r, settings: { stackDepth: 65536 } });
    expect(isRefused(refused) ? refused.refused : "took").toMatch(/^stacks of 131072 cells \(65536 calls deep/);
    const ok = buildOwnMap({ chk: scenario(), compiled: r, settings: { stackDepth: 64, heapCells: 2048 } });
    expect(isRefused(ok)).toBe(false);
    // A smaller heap and a shallower stack are smaller in the payload.
    const whole = buildOwnMap({ chk: scenario(), compiled: r });
    expect(!isRefused(whole) && !isRefused(ok) && ok.stats.payloadBytes < whole.stats.payloadBytes).toBe(true);
  });

  it("says where every trigger and every variable is, in the rows the tools read", () => {
    const r = compile(`program(() => {\n  let n = 0;\n  let title = "Probe";\n  let seen: number[] = [];\n  let fixed = [1, 2, 3];\n  while (true) {\n    n++;\n    seen.push(n);\n    fixed[n % 3] = n;\n    displayText(\`\${title} \${n} \${seen.length} \${fixed[0]}\`);\n    sleep(seconds(1));\n  }\n}, { name: "counting" });`);
    const out = buildOwnMap({ chk: scenario(), compiled: r, maps: true });
    if (isRefused(out)) throw new Error(out.refused);
    const { triggers, variables, lines } = out.maps!;
    // Every trigger of the payload once, by rising offset, the programs' with the line they came from.
    expect(triggers.payload).toBe(out.stats.payloadBytes);
    expect(triggers.triggers.length).toBeGreaterThan(out.stats.graphTriggers);
    expect(triggers.triggers.every(([o], i, xs) => i === 0 || o > xs[i - 1][0])).toBe(true);
    expect(triggers.triggers.every(([o]) => o >= 0 && o < triggers.payload)).toBe(true);
    const origins = new Set(triggers.triggers.map((t) => t[3]));
    expect([...origins].some((o) => /^main\.ts:(7|8|9|10):\d+$/.test(o))).toBe(true);
    expect(origins.has("")).toBe(true);
    // The same rows read back from the log's lines, as the lifted game's scripts read them.
    expect(readTriggerMap(lines)).toEqual(triggers);
    expect(readVariableMap(lines)).toEqual(variables);
    // The program's variables and arrays, each with a cell in the payload (an EPD's address); the heap's cells named.
    expect(variables.strings).toBe(STRINGS);
    expect(variables.cells).not.toBeNull();
    const [p] = variables.programs;
    expect(p).toMatchObject({ index: 0, name: "counting", perPlayer: false, owners: [0] });
    const byName = (id: string) => p.vars.find((v) => v.id === id || v.id.startsWith(`${id}#`))!;
    expect(byName("n").cells.value).toBeGreaterThanOrEqual(out.stats.address);
    expect(byName("title")).toMatchObject({ kind: "text", text: "id" });
    const seen = p.arrays.find((a) => a.id.startsWith("seen"))!, fixed = p.arrays.find((a) => a.id.startsWith("fixed"))!;
    expect(seen).toMatchObject({ dynamic: true });
    expect(seen.ptr).toBeGreaterThanOrEqual(out.stats.address);
    expect(fixed).toMatchObject({ length: 3, stride: 72 });
    expect(fixed.at).toBeGreaterThanOrEqual(out.stats.address);
  });

  it("the built file walked as the game walks it prints what the simulator prints, and its variables read as the simulator's", () => {
    const source = `program(() => {\n  let n = 0;\n  let seen: number[] = [];\n  let fixed = [10, 20, 30];\n  let title = "Probe";\n  while (true) {\n    n++;\n    seen.push(n * 2);\n    fixed[n % 3] += n;\n    if (n === 2) title = "Second";\n    displayText(\`\${title} \${n} \${seen.length} \${fixed[1]}\`);\n    sleep(frames(1));\n  }\n}, { name: "counting" });\nprogram(() => {\n  let mine = 0;\n  while (true) { mine += 3; displayText(\`mine \${mine}\`); sleep(frames(1)); }\n}, { owner: AllPlayers, name: "each" });`;
    const r = compile(source);
    const out = buildOwnMap({ chk: scenario(), compiled: r, maps: true });
    if (isRefused(out)) throw new Error(out.refused);
    const frames = 4;
    const walked = walkBuiltMap(out.chk, out.stats.players, out.stats.entries, frames);
    const sim = simulatePrograms(r.ir, frames, { strings: r.strings });
    const want = sim.events.filter((e) => e.text !== undefined).map((e) => `${e.cycle}:${e.text}`);
    // (A line every player's run showed in one frame is one line, as the lifted game and the simulator have it.)
    const got = [...new Set(walked.printed.map((p) => `${p.frame - 1}:${p.text}`))];
    expect(got).toEqual(want);
    // The variables through the map, as sim.program() reads them in the lifted game.
    const v = (name: string | number, player?: number) => programVariables({ ...walked.memory, unitAt: () => null }, out.maps!.variables, name, player) as Record<string, unknown>;
    expect(v("counting").n).toBe(frames);
    expect(v("counting").seen).toEqual([2, 4, 6, 8]);
    expect(v("counting").fixed).toEqual([10 + 3, 20 + 1 + 4, 30 + 2]);
    expect(v("counting").title).toBe("Second");
    expect(v("each", 0).mine).toBe(3 * frames);
    expect(v("each", 1).mine).toBe(3 * frames);
  });

  it("reads and writes the string table and the chunks faithfully", () => {
    expect(readStrings(new Uint8Array(0), false).entries).toEqual([]);
    const s = new Sections(scenario({ strings: ["a", "b", "a"] }));
    const t = readStrings(s.get("STR ")!, false);
    expect(t.entries.map((e) => new TextDecoder().decode(e))).toEqual(["a", "b", "a"]);
    expect(intern(t, "b")).toBe(2);
    expect(intern(t, "c")).toBe(4);
    const w = writeStrings(t);
    // Two strings alike share their bytes.
    expect(w.offsets[0]).toBe(w.offsets[2]);
    expect(readStrings(w.data, true).entries.map((e) => new TextDecoder().decode(e))).toEqual(["a", "b", "a", "c"]);
    // A chunk with a negative length ends the reading; what follows is kept.
    const odd = new Uint8Array([...writeChunks([{ name: "VER ", data: u16(59) }]), 73, 83, 79, 77, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]);
    const read = new Sections(odd);
    expect(read.chunks.map((c) => c.name)).toEqual(["VER "]);
    expect([...read.bytes()]).toEqual([...odd]);
  });
});
