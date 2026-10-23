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
import { STRINGS } from "../compiler/backend/layout";
import { ActionType, PlayerGroup, decodeTriggers, emptyAction, emptyTrigger, encodeTriggers, type TriggerRecord } from "../vendor/triggers";
import { defaultLib } from "../bundle/lib.mjs";

let lib: ReturnType<typeof defaultLib> | undefined;
const compile = (source: string, file = "main.ts") => {
  lib ??= defaultLib();
  const r = compileScript(ts, { [file]: source }, defaultScriptNames(), { lib, emitter: false, own: { players: { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, humans: [0], width: 64 * 32, height: 64 * 32 } });
  expect(r.diagnostics).toEqual([]);
  return r;
};

const u16 = (...v: number[]) => new Uint8Array(v.flatMap((x) => [x & 0xff, (x >> 8) & 0xff]));

/**
 * A scenario of the few sections the build reads: 64 × 64, P1 human and P2 computer in forces of their own, a string
 * table (STR unless `extended`), a trigger list, a placed unit with a flag at odds with its figure, a null tile,
 * a UNIx row at the defaults with a setting left in.
 */
function scenario(opts: { strings?: string[]; triggers?: TriggerRecord[]; extended?: boolean; version?: number } = {}): Uint8Array {
  const strings = { entries: (opts.strings ?? ["Probe", "P1 says hi"]).map((s) => new TextEncoder().encode(s)) };
  const str = opts.extended ? writeStrings(strings).data : (() => {
    const count = strings.entries.length;
    const header = 2 * (1 + count);
    const size = header + strings.entries.reduce((n, e) => n + e.length + 1, 0);
    const data = new Uint8Array(size);
    const view = new DataView(data.buffer);
    view.setUint16(0, count, true);
    let at = header;
    strings.entries.forEach((e, i) => { view.setUint16(2 * (1 + i), at, true); data.set(e, at); at += e.length + 1; });
    return data;
  })();
  const ownr = new Uint8Array(12); ownr[0] = 6; ownr[1] = 5;
  const forc = new Uint8Array(20); forc[1] = 1;
  const mtxm = new Uint8Array(64 * 64 * 2).fill(1); mtxm[2 * 5] = 0; mtxm[2 * 5 + 1] = 0;
  // One Marine of P1: hit points 100 % with the flag set (at odds), energy flag clear with a figure left in.
  const unit = new Uint8Array(36); const uv = new DataView(unit.buffer);
  uv.setUint16(8, 0, true); uv.setUint16(14, 2, true); unit[16] = 0; unit[17] = 100; unit[19] = 50;
  // UNIx: row 7 at the defaults (byte 1) with its hit points left in.
  const unix = new Uint8Array(228 + 228 * (4 + 2 + 1 + 2 + 2 + 2 + 2)); unix[7] = 1; unix[228 + 4 * 7] = 40;
  return writeChunks([
    { name: "VER ", data: u16(opts.version ?? 59) },
    { name: "DIM ", data: u16(64, 64) },
    { name: "OWNR", data: ownr },
    { name: "FORC", data: forc },
    { name: opts.extended ? "STRx" : "STR ", data: str },
    { name: "MTXM", data: mtxm },
    { name: "UNIT", data: unit },
    { name: "UNIx", data: unix },
    { name: "UPRP", data: new Uint8Array(64 * 20) },
    { name: "UPUS", data: new Uint8Array(64) },
    { name: "TRIG", data: encodeTriggers(opts.triggers ?? []) },
  ]);
}

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
