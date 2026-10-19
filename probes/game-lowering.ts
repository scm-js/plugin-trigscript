// TrigScript 4, the cheaper lowering: every new way a statement is lowered, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-lowering.ts
// Everything starts from a number the game holds (gas, which the program sets first).
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: adds into the variable itself, wrapping; a copy and an add. -2147483648 -2 13 1 -7 -3
  let a = g + 2147483644;
  a += 1;
  let b = g;
  b = b - 5;
  let c = g;
  c = 10 + c;
  let d = 0;
  d = g + b;
  let e = 0;
  e = g - 10;
  let f = g;
  f -= g * 2;
  displayText(`A: ${a} ${b} ${c} ${d} ${e} ${f}`);
  sleep(frames(1));

  // B: loop counters under a bound above zero and one below it, and one written the other way round. 6 0 60
  const n = g + 1;
  const m = g - 5;
  let s = 0, t = 0, u = 0;
  for (let i = 0; i < n; i++) s += i;
  for (let i = 0; i < m; i++) t += 1;
  for (let i = 1; n > i; i++) u += i * 10;
  displayText(`B: ${s} ${t} ${u}`);
  sleep(frames(1));

  // C: one side never below zero against a signed one: above it, below zero, and equal. 110001 001101 010110 010
  const k = g & 7;
  const v = g + 1;
  const w = g - 10;
  const v3 = v - 1;
  displayText(`C: ${k < v ? 1 : 0}${k <= v ? 1 : 0}${k > v ? 1 : 0}${k >= v ? 1 : 0}${k == v ? 1 : 0}${k != v ? 1 : 0} ${k < w ? 1 : 0}${k <= w ? 1 : 0}${k > w ? 1 : 0}${k >= w ? 1 : 0}${k == w ? 1 : 0}${k != w ? 1 : 0} ${k < v3 ? 1 : 0}${k <= v3 ? 1 : 0}${k > v3 ? 1 : 0}${k >= v3 ? 1 : 0}${k == v3 ? 1 : 0}${k != v3 ? 1 : 0} ${v < k ? 1 : 0}${w < k ? 1 : 0}${w >= k ? 1 : 0}`);
  sleep(frames(1));

  // D: && of plain tests, one trigger's conditions; a loop whose body moves its counter. 101 5
  let hits = 0;
  if (k < v && w < k) hits += 1;
  if (k < v && k > v) hits += 10;
  if (g == 3 && k == 3 && v > w) hits += 100;
  let moved = 0;
  for (let i = 0; i < n; i++) { if (i == 1) i = 2; moved += i; }
  displayText(`D: ${hits} ${moved}`);
});

test("adds into the variable itself", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: -2147483648 -2 13 1 -7 -3");
});
test("loop counters", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 6 0 60");
});
test("a side never below zero against a signed one", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 110001 001101 010110 010");
});
test("&& in one trigger, and a counter the body moves", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: 101 5");
});
