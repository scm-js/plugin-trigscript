// Remastered's "EUD ERROR: 0x…" back to the line (TrigScript 4): the code read, the address named, and a traced run's
// lines found, without a game; a host shaped like scm-sim's taps stands in for one.
import { describe, expect, it } from "vitest";
import { addressOfEudError, eudErrorOf, EudTracer, findEudError, placeOfAddress, UNIT_TABLE, type EudTraceRow } from "../compiler/eudError";
import { CostLines } from "../compiler/gameCost";
import { runGameTests } from "../compiler/gameTests";
import type { Allowlist } from "../compiler/allowlist";
import type { GameHandle } from "../compiler/gameSim";
import type { TriggerMap } from "../compiler/gameVariables";
import { defaultScriptNames } from "../compiler/names";

const END = 0x19200000;
const MAP: TriggerMap = { payload: 4000, triggers: [[0, 1, 2, "main.ts:12:5"], [2400, 0, 1, "eudplib"], [1200, 0, 1, "lib.ts:30:3"]] };
const START = END - 4000;
const cond = (trigger: number, i: number) => START + trigger + 8 + 20 * i;
const act = (trigger: number, i: number) => START + trigger + 8 + 320 + 32 * i;
const unit = (slot: number, offset: number) => UNIT_TABLE.base + slot * UNIT_TABLE.stride + offset;

describe("the code", () => {
  it("is the address with its bits inverted, as the dump probe's step D showed (0x59CD1C, the first unit's +0x74)", () => {
    expect(addressOfEudError("EUD ERROR: 0xFFA632E3")).toBe(0x59cd1c);
    expect(addressOfEudError("eud error 0xffa632e3")).toBe(0x59cd1c);
    expect(addressOfEudError("  0xFFA632E3 ")).toBe(0x59cd1c);
    expect(addressOfEudError("FFA632E3")).toBe(0x59cd1c);
    expect(eudErrorOf(0x59cd1c)).toBe("0xFFA632E3");
    expect(addressOfEudError(eudErrorOf(0x6509b0))).toBe(0x6509b0);
  });

  it("is not found in text that holds none", () => {
    expect(addressOfEudError("the game ended")).toBeNull();
    expect(addressOfEudError("")).toBeNull();
    expect(addressOfEudError("0x123456789")).toBeNull();
  });
});

describe("where an address lies", () => {
  it("names a unit's slot and field", () => {
    expect(placeOfAddress(0x59cd1c)).toBe("the unit table: slot 0 of 1,700, order queue head (+0x74)");
    expect(placeOfAddress(unit(3, 0x08))).toBe("the unit table: slot 3 of 1,700, hit points (+0x8)");
    expect(placeOfAddress(unit(1699, 0x2a))).toBe("the unit table: slot 1699 of 1,700, y (+0x2a)");
    expect(placeOfAddress(unit(2, 0x9a))).toBe("the unit table: slot 2 of 1,700, build queue (+2) (+0x9a)");
  });

  it("names the game's other tables, stats() fields, and an allowlist entry where nothing else knows", () => {
    expect(placeOfAddress(0x58a364 + 4 * (2 + 12 * 7))).toBe("deaths, of unit type 7 for P3");
    expect(placeOfAddress(0x57f0f0 + 4)).toBe("minerals, of P2");
    expect(placeOfAddress(0x640b60 + 218 * 2 + 5)).toBe("text lines, line 3 (+5)");
    expect(placeOfAddress(0x6509b0)).toBe("current player");
    expect(placeOfAddress(0x663888 + 2 * 5)).toBe("stats(): the unit table's minerals, entry 5");
    const list: Allowlist = { version: 1, entries: [
      { name: "0x700000", base: 0x700000, width: 16, read: "allowed", write: "allowed", evidence: [], from: "dump" },
      { name: "the game's clock", base: 0x700000, width: 4, read: "allowed", write: "ends", evidence: ["probe 9"] },
    ] };
    expect(placeOfAddress(0x700000, list)).toBe("the game's clock");
    expect(placeOfAddress(0x700008, list)).toBe("no table TrigScript knows");
  });
});

describe("finding the lines", () => {
  const rows: EudTraceRow[] = [
    { file: "main.ts", line: 20, address: unit(5, 0x74), write: false, mask: 0xffffffff, times: 3 },
    { file: "main.ts", line: 12, address: unit(0, 0x74), write: false, mask: 0xffffffff, times: 1 },
    { file: "main.ts", line: 12, address: unit(0, 0x74), write: true, mask: 0xffffffff, times: 1 },
    { file: "lib.ts", line: 4, address: unit(0, 0x78), write: false, mask: 0xffffffff, times: 9 },
    { file: null, line: null, address: unit(0, 0x74), write: false, mask: 0xffffffff, times: 7 },
    { file: null, line: null, address: unit(9, 0x74), write: false, mask: 0xffffffff, times: 2 },
  ];

  it("puts the lines that touched the very address first, then those that touched the field in another unit", () => {
    const a = findEudError(0x59cd1c, rows);
    expect(a.code).toBe("0xFFA632E3");
    expect(a.lines).toEqual([
      { file: "main.ts", line: 12, match: "exact", read: true, write: true, times: 2 },
      { file: "main.ts", line: 20, match: "field", read: true, write: false, times: 3 },
    ]);
    expect(a.unlined).toEqual({ exact: 7, field: 2 });
  });

  it("matches a byte inside the dword, and only the exact address outside the unit table", () => {
    expect(findEudError(0x59cd1e, rows).lines[0]).toMatchObject({ line: 12, match: "exact" });
    const deaths = 0x58a364 + 4 * 30;
    const a = findEudError(deaths, [
      { file: "main.ts", line: 3, address: deaths, write: true, mask: 0xff, times: 1 },
      { file: "main.ts", line: 4, address: deaths + 4 * 12, write: true, mask: 0xff, times: 1 },
    ]);
    expect(a.lines.map((l) => l.line)).toEqual([3]);
  });

  it("says what the allowlist knows of the address", () => {
    const list: Allowlist = { version: 1, entries: [
      { name: "unit table: order queue head", base: UNIT_TABLE.base + 0x74, stride: 336, count: 1700, width: 4, read: "ends", write: "ends", evidence: ["the dump probe, step D"] },
    ], outside: { verdict: "ends", evidence: ["no region"] } };
    const a = findEudError(0x59cd1c, rows, list);
    expect([a.read, a.write]).toEqual(["ends", "ends"]);
    expect(a.evidence).toEqual(["the dump probe, step D"]);
    const outside = findEudError(0x100, [], list);
    expect([outside.read, outside.evidence]).toEqual(["ends", ["no region"]]);
  });
});

/** The two taps, in small: the cost tap tells of each record (CARRY resolved) before the EUD tap tells of its access. */
function taps() {
  const lines = new CostLines(MAP, END);
  let last = -1;
  const cost = { group: lines.group as ((r: number) => number) | null, trace: null as ((record: number, group: number, action: boolean) => void) | null, report: () => { throw new Error("not read here"); } };
  const eud = { listen: null as ((record: number, address: number, write: boolean, mask: number, was: number) => void) | null };
  /** A record runs and touches `address`. */
  const run = (record: number, address: number, write = false, mask = 0xffffffff) => {
    let g = cost.group!(record);
    if (g === -2) g = last; else last = g;
    cost.trace?.(record, g < 0 ? -1 : g, write);
    eud.listen?.(record, address, write, mask, 0);
  };
  return { lines, cost, eud, run, frame: () => { last = -1; } };
}

describe("EudTracer", () => {
  it("writes each access down under the line its record ran for, eudplib's functions under the line that called them", () => {
    const { lines, cost, eud, run, frame } = taps();
    const tracer = new EudTracer({ cost, eud }, lines);
    tracer.start();
    run(act(2400, 0), unit(0, 0x0c));          // eudplib's work at the top of the frame: no line yet
    run(cond(0, 0), unit(0, 0x08));            // line 12
    run(act(2400, 0), unit(0, 0x74));          // eudplib's f_dwread_epd, called by line 12
    run(act(1200, 0), unit(1, 0x08), true, 0xff00);
    run(act(1200, 0), unit(1, 0x08), true, 0x00ff);
    frame();
    run(0x51a284, 0x58a364);                   // the map's own triggers, outside the payload
    tracer.stop();
    expect(cost.trace).toBeNull();
    expect(eud.listen).toBeNull();
    expect(tracer.rows()).toEqual([
      { file: null, line: null, address: unit(0, 0x0c), write: false, mask: 0xffffffff, times: 1 },
      { file: "main.ts", line: 12, address: unit(0, 0x08), write: false, mask: 0xffffffff, times: 1 },
      { file: "main.ts", line: 12, address: unit(0, 0x74), write: false, mask: 0xffffffff, times: 1 },
      { file: "lib.ts", line: 30, address: unit(1, 0x08), write: true, mask: 0xffff, times: 2 },
      { file: null, line: null, address: 0x58a364, write: false, mask: 0xffffffff, times: 1 },
    ]);
  });

  it("needs a host with both taps", () => {
    const { cost, eud } = taps();
    expect(EudTracer.can({ cost, eud })).toBe(true);
    expect(EudTracer.can({ cost })).toBe(false);
    expect(EudTracer.can({ eud, cost: { } })).toBe(false);
  });
});

describe("runGameTests with a trace", () => {
  /** A game that runs line 12's read of unit 0's +0x74 every frame; tests are not asked for. */
  function game(withEud = true) {
    const t = taps();
    let frame = 0;
    const handle = {
      m: new DataView(new ArrayBuffer(8)), u8: new Uint8Array(8), localPlayer: 0, over: false,
      get frame() { return frame; },
      step() { frame++; t.frame(); t.run(cond(0, 0), 0x59cd1c); },
      reset() { frame = 0; },
      lines: () => [], action: () => 0, chat() {}, call: () => 0,
      cost: t.cost, payloadEnd: END, ...(withEud ? { eud: t.eud } : {}),
    } as unknown as GameHandle;
    return handle;
  }

  it("plays the map with nobody at it and hands the trace back, for a script with no tests", () => {
    const report = runGameTests(game(), { modules: [], names: defaultScriptNames(), triggers: MAP, trace: true, play: 5 });
    expect(report.error).toBeUndefined();
    expect(report.trace?.frames).toBe(5);
    expect(report.trace?.rows).toEqual([{ file: "main.ts", line: 12, address: 0x59cd1c, write: false, mask: 0xffffffff, times: 5 }]);
    expect(findEudError(addressOfEudError("EUD ERROR: 0xFFA632E3")!, report.trace!.rows).lines).toMatchObject([{ file: "main.ts", line: 12, match: "exact" }]);
  });

  it("says why there is no trace when the host or the build cannot give one", () => {
    expect(runGameTests(game(false), { modules: [], names: defaultScriptNames(), triggers: MAP, trace: true, play: 1 }).traceError).toMatch(/before EUD traces/);
    expect(runGameTests(game(), { modules: [], names: defaultScriptNames(), triggers: null, trace: true, play: 1 }).traceError).toMatch(/where its triggers are/);
  });
});
