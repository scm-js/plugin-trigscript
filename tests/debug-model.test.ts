// Walking a debugged run (TrigScript 4, A5: compiler/debugModel.ts): steps and frames forward and back, the
// variables at the cursor, breakpoints and watched variables in both directions, over a record made by the
// recorder from a small game of the test's own.
import { describe, expect, it } from "vitest";
import { RecordingHandle, type DebugHost, type DebugRecording } from "../compiler/gameDebug";
import { DebugCursor, show } from "../compiler/debugModel";
import type { VariableMap } from "../compiler/gameVariables";
import type { TestResult } from "../compiler/testing";

const FROM = 0x100, END = 0x200;
const MAP: VariableMap = {
  heap: null, strings: FROM,
  programs: [{
    index: 0, name: "p", perPlayer: false, owners: [0],
    vars: [
      { id: "a#0", kind: "number", unsigned: false, rowed: false, cells: { value: 0x100 } },
      { id: "n#1", kind: "number", unsigned: false, rowed: false, cells: { value: 0x104 } },
    ],
    arrays: [{ id: "arr#0", kind: "number", unsigned: false, length: 2, rowed: false, at: 0x110 }],
  }],
};
const LINES = [{ file: "main.ts", line: 3 }, { file: "main.ts", line: 4 }];

/**
 * Six frames. Line 3 (two records) adds 10 to `a` on even frames; line 4 (one record) sets `n` to the frame; on
 * frame 4 line 4 runs twice and the second time sets `arr[1]` to 9. The test's line is 20, then 21 from frame 4.
 */
function record(): DebugRecording {
  const u8 = new Uint8Array(1024), m = new DataView(u8.buffer);
  let frame = 0;
  const eud = { listen: null as ((record: number, address: number, write: boolean, mask: number, was: number) => void) | null };
  const cost = { trace: null as ((record: number, group: number, action: boolean) => void) | null, paused: false, group: null, report: () => { throw new Error("no"); } };
  const write = (address: number, value: number) => { const was = m.getUint32(address, true); m.setUint32(address, value, true); eud.listen?.(0, address, true, 0xffffffff, was); };
  const host = {
    m, u8, eud, cost, localPlayer: 0, over: false, payloadEnd: END,
    get frame() { return frame; },
    step() {
      frame++;
      cost.trace?.(1, 0, false); cost.trace?.(2, 0, true);
      if (frame % 2 === 0) write(0x100, m.getUint32(0x100, true) + 10);
      cost.trace?.(3, 1, true);
      write(0x104, frame);
      if (frame === 4) { cost.trace?.(4, -1, true); cost.trace?.(3, 1, true); write(0x114, 9); }
    },
    lines: () => [], action: () => 0, chat: () => {}, call: () => 0,
    reset() { u8.fill(0); frame = 0; },
    keep: () => ({ frame, bytes: 0 }), restore() {}, portable: () => ({ kept: null, transfer: [] }),
  };
  let testLine = 20;
  const r = new RecordingHandle(host as unknown as DebugHost<never, never>, () => ({ file: "main.ts", line: testLine }), {}, FROM);
  r.reset();
  for (let f = 1; f <= 6; f++) { if (f === 4) testLine = 21; r.step(); }
  return r.finish({ id: "t", name: "t", file: "main.ts", line: 19 }, { id: "t", status: "passed", printed: [], events: [], frames: 6, ms: 0 } as TestResult, LINES);
}

const value = (c: DebugCursor, name: string) => c.programs()[0].values.find((v) => v.name === name)?.value;

describe("walking a debugged run", () => {
  it("steps by line within a frame, then on to the frame's end and the next frame's first line", () => {
    const c = new DebugCursor(record(), MAP);
    expect(c.where).toEqual({ k: 0, s: 0 });
    expect(c.line()).toEqual({ file: "main.ts", line: 3 });
    c.stepForward();
    expect(c.line()).toEqual({ file: "main.ts", line: 4 });
    expect(value(c, "n")).toBe(0);
    c.stepForward();
    expect(c.atEnd()).toBe(true);
    expect(value(c, "n")).toBe(1);
    c.stepForward();
    expect(c.where.k).toBe(1);
    expect(c.line()).toEqual({ file: "main.ts", line: 3 });
  });

  it("goes back as it went forward, the memory with it", () => {
    const c = new DebugCursor(record(), MAP);
    c.toFrame(5);
    expect(value(c, "a")).toBe(30);
    expect(value(c, "n")).toBe(6);
    expect(value(c, "arr")).toEqual([0, 9]);
    c.toFrame(2);
    expect(value(c, "a")).toBe(10);
    expect(value(c, "arr")).toEqual([0, 0]);
    c.stepBack();
    expect(c.where.k).toBe(2);
    expect(c.line()).toEqual({ file: "main.ts", line: 4 });
    expect(value(c, "n")).toBe(2);
    c.prevFrame();
    expect(c.where).toEqual({ k: 1, s: c.frameEnd(1) });
    c.toFrame(0); c.prevFrame();
    expect(c.where).toEqual({ k: 0, s: 0 });
    expect(value(c, "a")).toBe(0);
  });

  it("skips eudplib's own steps unless asked for every step", () => {
    const c = new DebugCursor(record(), MAP);
    c.moveTo({ k: 3, s: c.frameStart(3) });
    const lines: (number | null)[] = [];
    while (!c.atEnd()) { lines.push(c.line()?.line ?? null); c.stepForward(); }
    expect(lines).toEqual([3, 4, 4]);
    c.moveTo({ k: 3, s: c.frameStart(3) });
    lines.length = 0;
    while (!c.atEnd()) { lines.push(c.line()?.line ?? null); c.stepForward(true); }
    expect(lines).toEqual([3, 4, null, 4]);
  });

  it("continues to a breakpoint, forwards and back, and to the end without one", () => {
    const c = new DebugCursor(record(), MAP);
    const bp = new Set(["main.ts:21"]);
    expect(c.continueForward(bp)).toEqual({ kind: "breakpoint", place: { file: "main.ts", line: 21 } });
    // (A test's line stops at the end of the frame it asked for.)
    expect(c.where).toEqual({ k: 3, s: c.frameEnd(3) });
    expect(c.continueForward(bp).kind).toBe("breakpoint");
    expect(c.where.k).toBe(4);
    expect(c.continueBack(bp)).toEqual({ kind: "breakpoint", place: { file: "main.ts", line: 21 } });
    expect(c.where.k).toBe(3);
    expect(c.continueBack(bp)).toEqual({ kind: "start" });
    expect(c.continueForward(new Set())).toEqual({ kind: "end" });
    expect(c.where).toEqual({ k: 5, s: c.frameEnd(5) });
  });

  it("stops where a watched variable changes, just after the step that changed it", () => {
    const c = new DebugCursor(record(), MAP);
    expect(c.continueForward(new Set(), ["a"])).toEqual({ kind: "watch", name: "a", before: "0", after: "10" });
    expect(c.where.k).toBe(1);
    expect(c.line()).toEqual({ file: "main.ts", line: 4 });
    expect(c.continueForward(new Set(), ["arr"])).toEqual({ kind: "watch", name: "arr", before: "[0, 0]", after: "[0, 9]" });
    expect(c.where.k).toBe(3);
    expect(c.continueBack(new Set(), ["a"])).toEqual({ kind: "watch", name: "a", before: "10", after: "20" });
    expect(c.where.k).toBe(3);
  });

  it("says what each line wrote in the frame so far, and what the frames cost", () => {
    const c = new DebugCursor(record(), MAP);
    c.toFrame(3);
    expect(c.frameLines()).toEqual([
      { place: { file: "main.ts", line: 3 }, steps: 1, names: ["a"] },
      { place: { file: "main.ts", line: 4 }, steps: 2, names: ["n", "arr"] },
    ]);
    expect([...c.frameCosts()]).toEqual([3, 3, 3, 4, 3, 3]);
    expect(c.hits({ file: "main.ts", line: 21 })).toEqual([3, 4, 5]);
    expect(show({ x: 1, s: "hi", u: { unitSlot: 4 }, l: [1, 2] })).toBe('{ x: 1, s: "hi", u: unit 4, l: [1, 2] }');
  });
});
