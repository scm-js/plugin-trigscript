// TrigScript 4, A5: the debugger in the game — a program with some work in every frame (a loop over units, an array
// kept sorted, a wave counter) and tests to debug: one that passes over a long run, and one that fails on purpose,
// so a debugging session starts from a failure.
//   npx tsx scripts/debug-game.mts probes/game-debug.ts
//   npx tsx scripts/test-game.mts probes/game-debug.ts
// Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home" by Player 1's base).
import { test, expect, program, sleep, frames, seconds, createUnit, unitsAt, units, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

program(() => {
  let wave = 0;
  let alive = 0;
  let hp = 0;
  const best: number[] = [];
  while (true) {
    sleep(seconds(2));
    wave += 1;
    createUnit(P2, units.ZergZergling, 2, HOME);
    alive = 0;
    hp = 0;
    for (const z of unitsAt(HOME, { owner: P2 })) { alive += 1; hp += z.hp; }
    // The three highest totals so far, highest first.
    best.push(hp);
    for (let i = best.length - 1; i > 0; i--) {
      if (best[i] > best[i - 1]) { const t = best[i]; best[i] = best[i - 1]; best[i - 1] = t; }
    }
    if (best.length > 3) best.pop();
  }
}, { owner: P1, name: "waves" });

test("waves come every two seconds", (sim) => {
  sim.seconds(9);
  const w = sim.program("waves");
  expect(w.wave).toBe(4);
  expect((w.best as number[]).length).toBe(3);
});

test("the Marines hold Home (fails: there are none)", (sim) => {
  sim.place(P1, units.TerranMarine, HOME, 2);
  sim.until(() => (sim.program("waves").wave as number) >= 3);
  expect(sim.program("waves").alive).toBe(0);
});
