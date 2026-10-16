// The debugger's record (TrigScript 4, A5: compiler/gameDebug.ts) over a small game of the test's own: what it writes
// down of each frame, and a picture of a frame played again with the test's own actions between frames. The lifted
// game itself is checked by scripts/debug-game.mts, where a scm-sim checkout is.
import { describe, expect, it } from "vitest";
import { RecordingHandle, STEP_TEST, STEP_UNSEEN, type DebugHost } from "../compiler/gameDebug";
import type { TestResult } from "../compiler/testing";

const FROM = 0x100, END = 0x200, POKED = 0x40;

/**
 * A game of 1 KB. Each frame: line 0 runs (two records), adds the byte at `POKED` (where the test writes) to the
 * dword at FROM; line 1 runs (one record) and counts frames at FROM + 4; with `sneak`, the game also writes FROM + 8
 * itself, which no record says.
 */
function fakeGame(sneak = false) {
  const u8 = new Uint8Array(1024), m = new DataView(u8.buffer);
  let frame = 0;
  const host = {
    m, u8,
    get frame() { return frame; },
    localPlayer: 0, over: false, payloadEnd: END,
    eud: { listen: null as ((record: number, address: number, write: boolean, mask: number, was: number) => void) | null },
    cost: { trace: null as ((record: number, group: number, action: boolean) => void) | null, paused: false, group: null, report: () => { throw new Error("not here"); } },
    write(record: number, address: number, value: number) {
      const was = m.getUint32(address, true);
      m.setUint32(address, value, true);
      this.eud.listen?.(record, address, true, 0xffffffff, was);
    },
    step() {
      frame++;
      const t = this.cost.paused ? null : this.cost.trace;
      t?.(1000, 0, false); t?.(1032, 0, true);
      this.write(1032, FROM, m.getUint32(FROM, true) + u8[POKED]);
      t?.(2000, 1, true);
      this.write(2000, FROM + 4, frame);
      if (sneak && frame === 2) m.setUint32(FROM + 8, 77, true);
    },
    lines: () => [],
    action: () => 0, chat: () => {}, call: () => 0,
    reset() { u8.fill(0); frame = 0; },
    keep: () => ({ frame, u8: u8.slice(), bytes: 1024 }),
    restore(k: { frame: number; u8: Uint8Array }) { u8.set(k.u8); frame = k.frame; },
    portable: (k: { frame: number; u8: Uint8Array }) => ({ kept: { frame: k.frame, u8: k.u8.slice() }, transfer: [] }),
  };
  return host;
}

const passed: TestResult = { id: "t", status: "passed", printed: [], events: [], frames: 0, ms: 0 };
const test = { id: "t", name: "t", file: "main.ts", line: 1 };

describe("the debugger's record", () => {
  it("writes down each frame's steps, by line, and every write with what it held before", () => {
    const game = fakeGame();
    const r = new RecordingHandle(game as unknown as DebugHost<never, never>, () => ({ file: "main.ts", line: 7 }), {}, FROM);
    r.reset();
    r.step(); r.step(); r.step();
    const rec = r.finish(test, passed, [{ file: "main.ts", line: 3 }, { file: "main.ts", line: 4 }]);
    expect(rec.frames).toBe(3);
    expect(rec.first).toBe(1);
    expect([...rec.frameSteps]).toEqual([0, 2, 4, 6]);
    expect([...rec.stepLine]).toEqual([0, 1, 0, 1, 0, 1]);
    expect([...rec.stepRecords]).toEqual([2, 1, 2, 1, 2, 1]);
    expect([...rec.testLine]).toEqual([7, 7, 7]);
    // Nothing was poked, so line 0 writes nothing new; line 1 counts 1, 2, 3 at FROM + 4.
    expect([...rec.writes]).toEqual([FROM + 4, 0, 1, FROM + 4, 1, 2, FROM + 4, 2, 3]);
    expect([...rec.stepWrites]).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(rec.memory.at).toBe(FROM);
    expect(rec.memory.bytes.byteLength).toBe(END - FROM);
  });

  it("puts what no record said down as the frame's last step", () => {
    const game = fakeGame(true);
    const r = new RecordingHandle(game as unknown as DebugHost<never, never>, () => null, {}, FROM);
    r.reset();
    r.step(); r.step(); r.step();
    const rec = r.finish(test, passed, []);
    expect([...rec.stepLine.slice(rec.frameSteps[1], rec.frameSteps[2])]).toEqual([0, 1, STEP_UNSEEN]);
    const w = rec.stepWrites[rec.frameSteps[2] - 1];
    expect([...rec.writes.slice(3 * w, 3 * w + 3)]).toEqual([FROM + 8, 0, 77]);
  });

  it("puts a write the test's own action made between frames under the test, first in the next frame", () => {
    const game = fakeGame();
    const r = new RecordingHandle(game as unknown as DebugHost<never, never>, () => null, {}, FROM);
    r.reset();
    r.step();
    game.write(5000, FROM + 12, 9);
    r.step();
    const rec = r.finish(test, passed, []);
    expect([...rec.stepLine]).toEqual([0, 1, STEP_TEST, 0, 1]);
    expect([...rec.frameSteps]).toEqual([0, 2, 5]);
  });

  it("makes a picture of any frame with the test's writes between frames done again", () => {
    const game = fakeGame();
    const r = new RecordingHandle(game as unknown as DebugHost<{ frame: number; u8: Uint8Array }, { frame: number; u8: Uint8Array }>, () => null, { every: 4 }, FROM);
    r.reset();
    // Frame by frame, the test pokes 1, 2, 3 … at POKED, which the game adds up at FROM.
    const sums: number[] = [];
    for (let f = 1; f <= 10; f++) { game.u8[POKED] = f; r.wrote(POKED, 1); r.step(); sums.push(game.m.getUint32(FROM, true)); }
    r.finish(test, passed, []);
    for (const f of [7, 3, 4, 5, 10, 1]) {
      const pic = r.picture(f);
      expect(pic.frame).toBe(f);
      expect(new DataView(pic.kept.u8.buffer).getUint32(FROM, true)).toBe(sums[f - 1]);
    }
    expect(r.picture(99).frame).toBe(10);
  });

  it("stops writing down past its limits, and says where", () => {
    const game = fakeGame();
    const r = new RecordingHandle(game as unknown as DebugHost<never, never>, () => null, { steps: 5 }, FROM);
    r.reset();
    for (let i = 0; i < 5; i++) r.step();
    const rec = r.finish(test, passed, []);
    expect(rec.frames).toBe(5);
    expect(rec.stepLine.length).toBe(5);
    expect(rec.cut?.frame).toBe(3);
    expect(rec.cut?.why).toMatch(/more than 5 steps/);
  });
});
