// && and || stop at the first item that settles them, in the lifted game as in JavaScript: a call to the right of one
// that settled it never runs. Found in the Tetris showpiece (TrigScript 4, S2), where `pressed && !move(…)` moved the
// piece every frame in the game and never in the simulator.
//   npx tsx scripts/test-game.mts probes/game-short-circuit.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer).
import { test, expect, program, setResources, sleep, frames, P1 } from "trigscript";

program(async () => {
  let calls = 0;
  let yes = 0;
  function bump(answer: boolean): boolean { calls++; return answer; }
  let off = false;
  let on = true;
  await sleep(frames(1));
  if (off && bump(true)) yes += 1;           // bump does not run
  if (on || bump(true)) yes += 10;           // bump does not run
  if (on && bump(false) && bump(true)) yes += 100;   // the first bump runs, the second does not
  if (off || bump(true) || bump(true)) yes += 1000;  // the first bump runs, the second does not
  setResources(P1, "set", calls, "ore");
  setResources(P1, "set", yes, "gas");
}, { owner: P1 });

test("a call to the right of && or || runs only when what is before it did not settle it", (sim) => {
  sim.frames(5);
  expect(sim.resources(P1).ore).toBe(2);
  expect(sim.resources(P1).gas).toBe(1010);
});
