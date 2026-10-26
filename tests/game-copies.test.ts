import { describe, expect, it } from "vitest";
import { desyncMessage, GameSim, variableNames, type Desync, type GameCopy, type GameHandle } from "../compiler/gameSim";
import { listTests, TestRegistry } from "../compiler/testing";
import { readTriggerMap, type VariableMap } from "../compiler/gameVariables";
import { mergeCopies } from "../compiler/gameCopies";

// TrigScript 4, A3: a test of several players, each at a copy of the game of their own (scm-sim's CopyHandle).
const KEYS = 0x596a18;

/** A game handle over memory of its own, one copy of `players`, seated as `local`. */
function copyOf(players: number[], local: number, heard: Record<number, string[]> = {}) {
  const u8 = new Uint8Array(0x700000), m = new DataView(u8.buffer);
  let frame = 0, desync: Desync | null = null;
  const chats: string[] = [];
  const copy: GameCopy = {
    index: players.indexOf(local), copies: players.length, players, label: null,
    get desync() { return desync; },
    linesOf: (slot) => (heard[slot] ?? []).splice(0).map((text) => ({ frame, text })),
  };
  const game: GameHandle = {
    m, u8, get frame() { return frame; }, localPlayer: local, over: false, copy,
    step() { frame++; }, lines: () => [], action: () => 1, chat: (t) => { chats.push(t); }, call: () => 0, reset() { frame = 0; },
  };
  return { game, copy, chats, split: (d: Desync) => { desync = d; } };
}

describe("a test's players", () => {
  it("are two to eight different players", () => {
    const r = new TestRegistry();
    const { test } = r.library() as { test: (name: string, o: unknown, fn: unknown) => void };
    test("two", { players: [0, 1] }, () => {});
    expect(() => test("one", { players: [0] }, () => {})).toThrow(/two to eight/);
    expect(() => test("twice", { players: [1, 1] }, () => {})).toThrow(/two to eight/);
    expect(() => test("P9", { players: [0, 8] }, () => {})).toThrow(/two to eight/);
    expect(listTests(r).list.map((t) => [t.name, t.players])).toEqual([["two", [0, 1]]]);
  });
});

describe("a world that is one copy of several", () => {
  it("a player's key and line are done at that player's copy only", () => {
    const one = copyOf([0, 1], 0), two = copyOf([0, 1], 1);
    for (const c of [one, two]) new GameSim(c.game).press("Q", 1).type("-go", 1);
    expect([one.game.u8[KEYS + 0x51], two.game.u8[KEYS + 0x51]]).toEqual([0, 1]);
    expect([one.chats, two.chats]).toEqual([[], ["-go"]]);
    // No player named: the first of the test's.
    new GameSim(one.game).press("W");
    expect(one.game.u8[KEYS + 0x57]).toBe(1);
  });

  it("a player not in the test is said to be so", () => {
    expect(() => new GameSim(copyOf([0, 1], 0).game).press("Q", 2)).toThrow("press: P3 is not one of this test's players (P1, P2)");
    expect(() => new GameSim(copyOf([0, 1], 0).game).printed(3)).toThrow("not one of this test's players");
  });

  it("every player's screen is read at every copy, a line shown to all once", () => {
    const c = copyOf([0, 1], 0, { 1: ["for two"] });
    const sim = new GameSim(c.game).frames(1);
    expect(sim.printed(1)).toEqual(["for two"]);
    expect(sim.printed(0)).toEqual([]);
    expect(sim.printed()).toEqual(["for two"]);
  });

  it("the copies splitting fails the test at that frame, saying where", () => {
    const c = copyOf([0, 1], 0);
    const sim = new GameSim(c.game).frames(5);
    c.split({ frame: 5, apart: null, players: [0, 1], differences: [{ what: "deaths of unit 7 for P1", values: [1, 0] }], wrote: [["12:5 wrote deaths of unit 7 for P1"], []], readLocal: [["12:5 read the local player"], ["12:5 read the local player"]] });
    expect(() => sim.frames(1)).toThrow("the players' games stopped agreeing at frame 5: deaths of unit 7 for P1 is 1 at P1's computer, 0 at P2's computer. At P1's computer: line 12 wrote deaths of unit 7 for P1; line 12 read the local player. At P2's computer: line 12 read the local player.");
  });
});

describe("a desync's words", () => {
  const map: VariableMap = { heap: null, strings: 0, programs: [{ index: 0, name: "shop", perPlayer: false, owners: [0], vars: [{ id: "gold#0", kind: "number", unsigned: false, rowed: false, cells: { value: 0x100 } }, { id: "turn#1", kind: "number", unsigned: false, rowed: true, cells: { value: 0x200 } }], arrays: [{ id: "slots#0", kind: "number", unsigned: false, length: 3, rowed: false, at: 0x300 }] }] };

  it("name the script's variables by their cells", () => {
    const names = variableNames(map);
    expect([names.get(0x100), names.get(0x204), names.get(0x308)]).toEqual(["gold, in shop", "turn of P2, in shop", "slots[2], in shop"]);
  });

  it("say which variables had come apart before, and how many of the build's own", () => {
    const d: Desync = { frame: 40, apart: null, players: [0, 1], differences: [{ what: "unit slot 3, hit points", values: [10240, 5120] }], wrote: [[], []], readLocal: [[], []], watched: [{ address: 0x100, since: 31, values: [5, 0] }, { address: 0x9000, since: 2, values: [1, 2] }] };
    expect(desyncMessage(d, variableNames(map))).toBe("the players' games stopped agreeing at frame 40: unit slot 3, hit points is 10240 at P1's computer, 5120 at P2's computer. Before that, the script's gold, in shop from frame 31 (5 at P1's computer, 0 at P2's computer) had come apart. (1 of the build's own cells differed too; some are each computer's own on purpose.)");
  });

  it("say when the copies were not even at the same frame", () => {
    expect(desyncMessage({ frame: 9, apart: [9, 12], players: [0, 2], differences: [], wrote: [], readLocal: [] })).toBe("the players' games stopped agreeing: they were at different frames (9 at P1's computer, 12 at P3's computer)");
  });
});

describe("a test of several players' result, from each copy's report", () => {
  const report = (status: "passed" | "failed", message?: string) => ({ list: [], only: [], ms: 0, results: [{ id: "t", status, message, printed: [], events: [], frames: 30, ms: 5 }] });
  it("passes when it passed at every computer", () => {
    expect(mergeCopies(["t"], [{ player: 0, result: report("passed"), error: null }, { player: 1, result: report("passed"), error: null }])[0]).toMatchObject({ status: "passed", frames: 30 });
  });
  it("fails with the first computer's reason, said to be that computer's when the others differ", () => {
    expect(mergeCopies(["t"], [{ player: 0, result: report("passed"), error: null }, { player: 1, result: report("failed", "expected 1, got 0"), error: null }])[0]).toMatchObject({ status: "failed", message: "at P2's computer: expected 1, got 0" });
    expect(mergeCopies(["t"], [{ player: 0, result: report("failed", "split"), error: null }, { player: 1, result: report("failed", "split"), error: null }])[0].message).toBe("split");
  });
  it("fails every test of a copy that could not run", () => {
    expect(mergeCopies(["t"], [{ player: 0, result: null, error: "P2 is not a slot the map opens to a person" }, { player: 1, result: report("passed"), error: null }])[0]).toMatchObject({ status: "failed", message: "at P1's computer: P2 is not a slot the map opens to a person" });
  });
});

describe("the build's map of triggers", () => {
  it("is read from its lines, and is none when cut short", () => {
    const lines = ["TRIGSCRIPT-MAP {\"payload\":4096,\"count\":2}", "TRIGSCRIPT-ROWS [[0,1,2,\"3:1\"]]", "hello", "TRIGSCRIPT-ROWS [[2408,0,1,\"\"]]"];
    expect(readTriggerMap(lines)).toEqual({ payload: 4096, triggers: [[0, 1, 2, "3:1"], [2408, 0, 1, ""]] });
    expect(readTriggerMap(lines.slice(0, 2))).toBeNull();
    expect(readTriggerMap(["hello"])).toBeNull();
  });
});
