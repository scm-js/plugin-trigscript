import { describe, expect, it } from "vitest";
import { isMachineLine, listCellAt, programVariables, readVariableMap, type VariableMap } from "../compiler/gameVariables";

// A memory of 64 KB standing in for the game's, with the cells where a map says they are.
const memory = () => { const u8 = new Uint8Array(1 << 16); return { u8, m: new DataView(u8.buffer) }; };
const STRINGS = 0x8000, HEAP = 0xa000;

const MAP: VariableMap = {
  heap: HEAP,
  strings: STRINGS,
  programs: [
    {
      index: 0, name: "kinds", perPlayer: false, owners: [0],
      vars: [
        { id: "n#0", kind: "number", unsigned: false, rowed: false, cells: { value: 0x100 } },
        { id: "big#1", kind: "number", unsigned: true, rowed: false, cells: { value: 0x104 } },
        { id: "ok#2", kind: "boolean", unsigned: false, rowed: false, cells: { value: 0x108 } },
        { id: "title#3", kind: "text", text: "id", unsigned: false, rowed: false, cells: { value: 0x10c } },
        { id: "said#4", kind: "text", text: "made", unsigned: false, rowed: false, cells: { addr: 0x110, len: 0x114 } },
        { id: "pos.x#5", kind: "number", unsigned: false, rowed: false, cells: { value: 0x118 } },
        { id: "pos.y#6", kind: "number", unsigned: false, rowed: false, cells: { value: null } },
        { id: "who#7", kind: "unit", unsigned: false, rowed: false, cells: { ptr: 0x120, uid: 0x124 } },
        { id: "n#8", kind: "number", unsigned: false, rowed: false, cells: { value: 0x128 } },
      ],
      arrays: [
        { id: "seen#0", kind: "number", unsigned: false, length: 3, rowed: false, at: 0x200 },
        { id: "queue#1", kind: "number", unsigned: false, length: 0, rowed: false, dynamic: true, ptr: 0x300, len: 0x304 },
      ],
    },
    {
      index: 1, name: "each", perPlayer: true, owners: [0, 2],
      vars: [{ id: "mine#0", kind: "number", unsigned: false, rowed: true, cells: { value: 0x400 } }],
      arrays: [{ id: "row#0", kind: "boolean", unsigned: false, length: 2, rowed: true, at: 0x500 }],
    },
  ],
};

function filled() {
  const g = memory(), { m, u8 } = g;
  m.setInt32(0x100, -7, true);
  m.setUint32(0x104, 4000000000, true);
  m.setUint32(0x108, 1, true);
  // String 2 of the table: "three".
  m.setUint32(STRINGS + 8, 0x40, true);
  u8.set(new TextEncoder().encode("three\0"), STRINGS + 0x40);
  m.setUint32(0x10c, 2, true);
  u8.set(new TextEncoder().encode("tick 4 ✓\0"), 0x600);
  m.setUint32(0x110, 0x600, true);
  m.setUint32(0x118, 40, true);
  m.setUint32(0x120, 0x7000, true);
  m.setUint32(0x124, 0x0500, true);
  m.setInt32(0x128, 99, true);
  [1, 2, 3].forEach((v, i) => m.setUint32(0x200 + 4 * i, v, true));
  m.setUint32(0x300, 8, true); m.setUint32(0x304, 2, true);
  m.setUint32(HEAP + 4 * 8, 5, true); m.setUint32(HEAP + 4 * 9, 6, true);
  m.setUint32(0x400 + 4 * 0, 3, true); m.setUint32(0x400 + 4 * 2, 4, true);
  m.setUint32(0x500 + 4 * (2 * 2 + 1), 1, true);
  const unitAt = (ptr: number, uid: number) => (ptr === 0x7000 && uid === 0x0500 ? ({ alive: true, type: 0 } as never) : null);
  return { ...g, unitAt };
}

describe("a program's variables read out of the game", () => {
  it("each kind, as the simulator gives it", () => {
    const k = programVariables(filled(), MAP, "kinds");
    // (Of two with one name, the later.)
    expect(k.n).toBe(99);
    expect(k.big).toBe(4000000000);
    expect(k.ok).toBe(true);
    expect(k.title).toBe("three");
    expect(k.said).toBe("tick 4 ✓");
    expect(k.pos).toEqual({ x: 40, y: 0 });
    expect(k.who).toEqual({ alive: true, type: 0 });
    expect(k.seen).toEqual([1, 2, 3]);
    expect(k.queue).toEqual([5, 6]);
    expect(k.nothing).toBeUndefined();
    expect("seen" in k).toBe(true);
  });

  it("a per-player program's row, by player; the first owner's by default", () => {
    const g = filled();
    expect(programVariables(g, MAP, "each").mine).toBe(3);
    expect(programVariables(g, MAP, "each", 2).mine).toBe(4);
    expect(programVariables(g, MAP, 1, 2).row).toEqual([false, true]);
    expect(() => programVariables(g, MAP, "each", 1)).toThrow(/runs for P2/);
    expect(() => programVariables(g, MAP, "waves")).toThrow(/Named: kinds, each/);
    expect(() => programVariables(g, MAP, 5)).toThrow(/the script has 2/);
  });

  it("an array that grows, from the growing arrays' own cells when the build names them (72 bytes a cell)", () => {
    const g = filled();
    const CELLS = 0xc000;
    g.m.setUint32(CELLS + 72 * 8, 7, true); g.m.setUint32(CELLS + 72 * 9, 8, true);
    expect(programVariables(g, { ...MAP, cells: CELLS }, "kinds").queue).toEqual([7, 8]);
    expect(listCellAt({ ...MAP, cells: CELLS }, 8, 1)).toBe(CELLS + 72 * 9);
    expect(listCellAt(MAP, 8, 1)).toBe(HEAP + 4 * 9);
    const head = `TRIGSCRIPT-VARS {"programs":2,"heap":${HEAP},"cells":${CELLS},"strings":${STRINGS}}`;
    const programs = MAP.programs.map((p) => `TRIGSCRIPT-PROGRAM ${JSON.stringify(p)}`);
    expect(readVariableMap([head, ...programs])?.cells).toBe(CELLS);
  });

  it("a unit that is gone is null; nothing held is null", () => {
    const g = filled();
    g.m.setUint32(0x124, 0x0600, true);
    expect(programVariables(g, MAP, "kinds").who).toBeNull();
    g.m.setUint32(0x120, 0, true);
    expect(programVariables(g, MAP, "kinds").who).toBeNull();
  });
});

describe("the build's lines", () => {
  const lines = [
    "[Stage 3/3] ConstructPayload",
    `TRIGSCRIPT-VARS {"programs":2,"heap":${HEAP},"strings":${STRINGS}}`,
    `TRIGSCRIPT-PROGRAM ${JSON.stringify(MAP.programs[1])}`,
    `TRIGSCRIPT-PROGRAM ${JSON.stringify(MAP.programs[0])}`,
  ];
  it("make the map, in the programs' order", () => { expect(readVariableMap(lines)).toEqual(MAP); });
  it("cut short, make none", () => { expect(readVariableMap(lines.slice(0, 3))).toBeNull(); expect(readVariableMap(["hello"])).toBeNull(); });
  it("are not for a person", () => { expect(lines.map(isMachineLine)).toEqual([false, true, true, true]); expect(isMachineLine("TRIGSCRIPT-ROWS [[0,1,2,\"\"]]")).toBe(true); });
});
