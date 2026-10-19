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
  sleep(frames(1));

  // E: arrays, read and written at a constant and at a variable index; a cell added to and taken from, below zero. 3 9 -2 7 4 -4 8
  const cells = [0, 0, 0, 0, 0, 0, 0, 0];
  const j = g + 1;
  cells[2] = g;
  cells[j] = g * 3;
  cells[5] = g;
  cells[5] -= 5;
  cells[j - 1] += 4;
  cells[1] = cells[2] + cells[j] - 5;
  cells[j] -= 13;
  cells[7] = 8;
  displayText(`E: ${cells[2]} ${cells[j] + 13} ${cells[5]} ${cells[1]} ${cells[3]} ${cells[j - 1] - 8} ${cells[7]}`);
  sleep(frames(1));

  // F: an array too long to be cells of their own (4 bytes a cell): a subtract wraps there too. -7 -4
  const big: number[] = new Array(3000).fill(0);
  big[j] -= 7;
  big[2999] = 5;
  big[2999] -= 9;
  displayText(`F: ${big[j]} ${big[2999]}`);
  sleep(frames(1));

  // G: & and | with a constant, in a variable's own cell and as values, nested. 0 15 2 1 9 -8
  let r = g + 12;
  r = (r + 1) & 15;
  let q = g;
  q = q | 12;
  const s2 = (g & 6) | 0;
  let u2 = g;
  u2 = (u2 - 10) & 7;
  const z2 = (g + 6) | 1;
  let neg = g - 11;
  neg = neg & -4;
  displayText(`G: ${r} ${q} ${s2} ${u2} ${z2} ${neg}`);
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
test("arrays at constant and variable indexes", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("E: 3 9 -2 7 4 -4 8");
});
test("a long array's subtract wraps", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("F: -7 -4");
});
test("& and | with a constant", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("G: 0 15 2 1 9 -8");
});
