// The allowlist check (compiler/allowlist.ts) on traces made up for it: the map's own memory, the game's heap,
// what Magenta verified, what the game was seen to refuse or ignore, and what nobody has tried — byte by byte.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTrace, describeFinding, verdictOf, type Allowlist, type Trace, type TraceRow } from "../compiler/allowlist";

const list = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "allowlist.json"), "utf8")) as Allowlist;
const UNIT = (i: number, off: number) => 0x59cca8 + 336 * i + off;
const trace = (rows: TraceRow[]): Trace => ({ frames: 100, strings: { from: 0x19190000, to: 0x191b0000 }, heap: { from: 0x30000000, to: 0x40000000 }, rows });

describe("the allowlist", () => {
  it("has Magenta's verified fields allowed and the failures seen in the game", () => {
    expect(verdictOf(list, UNIT(5, 8), true).verdict).toBe("allowed");      // a unit's hit points
    expect(verdictOf(list, UNIT(5, 0x28), false).verdict).toBe("allowed");  // its position, read
    expect(verdictOf(list, UNIT(5, 0x28), true).verdict).toBe("ends");      // … and written
    expect(verdictOf(list, 0x6cdfd4, true).verdict).toBe("ignored");         // the game speed
    expect(verdictOf(list, 0x7fff0000, false).verdict).toBe("unknown");
  });
  it("names what each verdict rests on", () => {
    const e = verdictOf(list, UNIT(5, 0x28), true).entry!;
    expect(e.evidence.join(" ")).toMatch(/Magenta probe 6/);
  });
});

describe("checkTrace", () => {
  it("lets the map's own memory and eudplib's walk of the game's heap through", () => {
    const r = checkTrace(trace([["12:3", 0x19191000, 1, 0xffffffff, 4], ["eudplib", 0x30a30010, 0, 0xffffffff, 2], ["", 0x30a30014, 1, 0xffffffff, 1]]), list);
    expect(r.findings).toEqual([]);
    expect(r.counted).toMatchObject({ own: 1, heap: 2 });
  });
  it("says at the line when a line of the script reaches into the game's heap", () => {
    const r = checkTrace(trace([["40:7", 0x30a30010, 1, 0xffffffff, 1]]), list);
    expect(r.findings).toMatchObject([{ line: 40, verdict: "unknown", write: true }]);
  });
  it("finds a write Remastered ends the game on, and says why", () => {
    const r = checkTrace(trace([["7:1", UNIT(3, 0x28), 1, 0xffffffff, 1], ["7:1", UNIT(9, 0x28), 1, 0x0000ffff, 1]]), list);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ line: 7, verdict: "ends", entry: "unit table: position", addresses: 2, times: 2 });
    expect(describeFinding(r.findings[0])).toMatch(/^line 7: writes unit table: position .* Remastered ends the game on this \(Magenta probe 6/);
  });
  it("holds a masked write byte by byte: the cloak bits and the invincible bit share a dword", () => {
    const flags = UNIT(2, 0xdc);
    expect(checkTrace(trace([["3:1", flags, 1, 0x00000300, 1]]), list).findings).toMatchObject([{ verdict: "ignored", entry: "unit table: cloak flags" }]);
    expect(checkTrace(trace([["3:1", flags, 1, 0x04000000, 1]]), list).findings).toEqual([]);
  });
  it("says what nobody has tried, and puts the gravest first", () => {
    const r = checkTrace(trace([["20:1", 0x7fff0000, 0, 0xffffffff, 1], ["5:1", 0x6cdfd4, 1, 0xffffffff, 1], ["9:1", UNIT(0, 0x28), 1, 0xffffffff, 1]]), list);
    expect(r.findings.map((f) => f.verdict)).toEqual(["ends", "ignored", "unknown"]);
    expect(describeFinding(r.findings[2])).toBe("line 20: reads 0x7fff0000 — not seen in Remastered: needs a probe");
  });
  it("calls eudplib's own code by its name", () => {
    const r = checkTrace(trace([["fn:f_dwread_epd", 0x7fff0000, 0, 0xffffffff, 1]]), list);
    expect(describeFinding(r.findings[0])).toMatch(/^eudplib's f_dwread_epd: reads/);
  });
});

describe("what no entry covers", () => {
  it("is said by the table of the game it lies in, one finding a field however many units", () => {
    const off = 0x7c; // a field no probe and no catalogue entry has touched
    const r = checkTrace(trace([0, 1, 2, 500].map((i): TraceRow => ["38:3", UNIT(i, off), 0, 0xffffffff, 1])), list);
    expect(r.findings).toHaveLength(1);
    expect(describeFinding(r.findings[0])).toBe("line 38: reads unit table +0x7c (4 dwords from 0x59cd24) — not seen in Remastered: needs a probe");
  });
});
