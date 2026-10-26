// TrigScript 4, A2: sim.program() in the lifted game — every kind of variable a program keeps, read back out of the
// game's memory where the build said it put them, and the same test in the simulator beside it.
//   npx tsx scripts/test-game.mts probes/game-program.ts
// Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home" by Player 1's base).
import { test, expect, program, sleep, frames, shared, first, createUnit, units, P1, P2, CurrentPlayer, type Location, type Unit, type u8, type u32 } from "trigscript";

const HOME = 1 as Location;

program(() => {
  let ticks = 0;
  let small: u8 = 0;
  let big: u32 = 0;
  let minus = 0;
  let even = false;
  let title = "start";
  let said = "";
  let pos = { x: 1, y: 2 };
  const seen = [0, 0, 0];
  const queue: number[] = [];
  let marine: Unit | null = null;
  createUnit(P1, units.TerranMarine, 1, HOME);
  while (true) {
    ticks += 1;
    small = ticks * 100;
    big = 4000000000;
    minus = -ticks;
    even = ticks % 2 == 0;
    if (ticks == 3) title = "three";
    said = `tick ${ticks}`;
    pos.x = ticks * 10;
    seen[ticks % 3] = ticks;
    if (queue.length < 4) queue.push(ticks);
    if (!marine) marine = first({ owner: P1, type: units.TerranMarine });
    sleep(frames(1));
  }
}, { owner: P1, name: "kinds" });

program(() => {
  let mine = 0;
  let all = shared(0);
  while (true) { mine += 1; all += 1; sleep(frames(1)); }
}, { owner: [P1, P2], name: "each" });

test("numbers, booleans, texts, a record and arrays", (sim) => {
  sim.frames(5);
  const k = sim.program("kinds");
  const ticks = k.ticks as number;
  expect(ticks).toBeGreaterThan(2);
  expect(k.small).toBe(255);
  expect(k.big).toBe(4000000000);
  expect(k.minus).toBe(-ticks);
  expect(k.even).toBe(ticks % 2 == 0);
  expect(k.title).toBe("three");
  expect(k.said).toBe(`tick ${ticks}`);
  expect(k.pos).toEqual({ x: ticks * 10, y: 2 });
  expect(k.queue).toEqual([1, 2, 3, 4]);
  expect((k.seen as number[])[ticks % 3]).toBe(ticks);
  expect(k.nothing).toBeUndefined();
});

test("a unit a program holds", (sim) => {
  sim.frames(5);
  const marine = sim.program("kinds").marine as { alive: boolean; type: number; owner: number } | null;
  expect(marine).not.toBeNull();
  expect(marine!.type).toBe(units.TerranMarine);
  expect(marine!.owner).toBe(P1);
});

test("a per-player program, by player", (sim) => {
  sim.frames(4);
  const one = sim.program("each", P1).mine as number, two = sim.program("each", P2).mine as number;
  expect(one).toBeGreaterThan(0);
  expect(two).toBe(one);
  // (Each player's run declares the shared cell again when it starts, so it counts from the later start.)
  expect(sim.program("each").all).toBeGreaterThanOrEqual(one);
  expect(() => sim.program("each", CurrentPlayer + 5)).toThrow(/runs for P/);
});
