// TrigScript 4, the rest of B1: a generator walked by for…of, const [a, b] = await Promise.all, .then((value) => …) and an
// async method, run in the lifted game as well as in the simulator; the two have to agree frame for frame.
//   npx tsx scripts/test-game.mts probes/game-generators.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home").
import { test, expect, program, displayText, setResources, createUnit, sleep, frames, units, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

program(async () => {
  class Squad {
    left: number;
    constructor(n: number) { this.left = n; }
    async drain() { while (this.left > 0) { this.left--; setResources(P1, "add", 1, "gas"); await sleep(frames(1)); } }
  }
  async function slow(n: number): Promise<number> { await sleep(frames(n)); return n * 10; }
  function* waves(n: number) {
    yield { count: 1, unit: units.ZergZergling };
    for (let i = 1; i <= n; i++) yield { count: i + 1, unit: units.ZergZergling };
  }
  // Frames 2, 3, 4: one Zergling, then two, then three (a test's frames(n) has run frame n).
  for (const w of waves(2)) { createUnit(P2, w.unit, w.count, HOME); await sleep(frames(1)); }
  // From frame 5: slow(1) ends on frame 6, slow(3) on frame 8.
  const [a, b] = await Promise.all([slow(3), slow(1)]);
  setResources(P1, "set", a + b, "ore");
  // From frame 8: slow(2) ends on frame 10 and wins, its 20 handed to .then.
  const v = await Promise.race([slow(2).then((k) => k + 1), sleep(frames(10)).then(() => 0)]);
  setResources(P1, "set", v, "ore");
  // From frame 10: a gas a frame for three frames.
  const s = new Squad(3);
  await s.drain();
  displayText("drained");
}, { owner: P1 });

test("a generator: the loop's body at each yield", (sim) => {
  sim.frames(2);
  expect(sim.count(P2, units.ZergZergling, HOME)).toBe(1);
  sim.frames(1);
  expect(sim.count(P2, units.ZergZergling, HOME)).toBe(3);
  sim.frames(1);
  expect(sim.count(P2, units.ZergZergling, HOME)).toBe(6);
});

test("Promise.all's values, and .then handed what a promise gives", (sim) => {
  sim.frames(7);
  expect(sim.resources(P1).ore).toBe(0);
  sim.frames(1);
  expect(sim.resources(P1).ore).toBe(40);
  sim.frames(2);
  expect(sim.resources(P1).ore).toBe(21);
});

test("an async method, awaited", (sim) => {
  sim.frames(14);
  expect(sim.resources(P1).gas).toBe(3);
  expect(sim).toHavePrinted("drained");
});
