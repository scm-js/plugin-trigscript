// TrigScript 4, B6: numbers with a fraction (fixed, 16.16) and Math, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-fixed.ts
// Every value starts from a variable the game holds (gas, which the first program sets), so nothing below is worked
// out when the map is built: it is the game's arithmetic, printed, and the same lines from the simulator.
import { test, expect, program, displayText, setResources, gas, sleep, frames, fixed, game, P1, type fixed as Fixed } from "trigscript";

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game
  // A: arithmetic. 1.25 3.75 1.5625 3.5 -0.75 0.3333
  let x = 1;
  x += 0.25;
  const y = x * g;
  const z = x * x;
  const q = 7 / fixed(2);
  const neg = 0.5 - x;
  const third = 1 / fixed(g);
  displayText(`A: ${x} ${y} ${z} ${q} ${neg} ${third}`);
  sleep(frames(1));
  // B: rounding. -3 -2 -2 -2 2 3 -2
  const m = -2.5 + (g - 3);
  displayText(`B: ${Math.floor(m)} ${Math.ceil(m)} ${Math.round(m)} ${Math.trunc(m)} ${Math.round(x * 2 - 0.1)} ${Math.trunc(y)} ${m | 0}`);
  sleep(frames(1));
  // C: roots. 1.4142 1.732 5 0 181.0221 3.75
  const two = fixed(g) - 1;
  displayText(`C: ${Math.sqrt(two)} ${Math.sqrt(g)} ${Math.hypot(g, g + 1)} ${Math.sqrt(-x)} ${Math.sqrt(32769 - g * 0)} ${Math.hypot(y, 0)}`);
  sleep(frames(1));
  // D: angles. 0.5 0.866 0.5403 1.5573 -1 2.3562 -0.7854 1.5708
  const a = Math.PI / 6 + (g - 3);
  const one = fixed(g) - 2;
  displayText(`D: ${Math.sin(a)} ${Math.cos(a)} ${Math.cos(one)} ${Math.tan(one)} ${Math.cos(Math.PI * one)} ${Math.atan2(one, -one)} ${Math.atan2(-one, one)} ${Math.atan2(g, 0)}`);
  sleep(frames(1));
  // E: comparisons and mixing. yes yes yes 12 4.5
  const half: Fixed = fixed(1) / 2;
  let count = 0;
  for (let i = 0; i < g * 4; i++) count++;
  displayText(`E: ${half < x ? "yes" : "no"} ${x > 1 ? "yes" : "no"} ${z == 1.5625 ? "yes" : "no"} ${count} ${Math.max(half, g + 1.5)}`);
  sleep(frames(1));
  // F: a fixed value kept in an array and a function. 0.25 0.5 0.75 2.25
  const steps: Fixed[] = [0, 0, 0];
  for (let i = 0; i < 3; i++) steps[i] = (i + 1) * 0.25 * (g - 2);
  displayText(`F: ${steps[0]} ${steps[1]} ${steps[2]} ${square(1.5 * (g - 2))}`);
});

const square = game((v: Fixed): Fixed => v * v);

test("fixed arithmetic", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("A: 1.25 3.75 1.5625 3.5 -0.75 0.3333");
});
test("rounding", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("B: -3 -2 -2 -2 2 3 -2");
});
test("roots", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("C: 1.4142 1.732 5 0 181.0221 3.75");
});
test("angles", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("D: 0.5 0.866 0.5403 1.5573 -1 2.3562 -0.7854 1.5708");
});
test("comparisons and mixing", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("E: yes yes yes 12 4.5");
});
test("arrays and functions", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("F: 0.25 0.5 0.75 2.25");
});
