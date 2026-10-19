// TrigScript 4, the backend: the emitter (compiler/backend/emit.ts). Loops of numbers — counting, sums, signed and
// unsigned comparisons of a variable with a constant and with another variable at the edges, break and continue,
// do-while, while (true), nested loops, if and else — each printed. Built with the emitter (EMITTER=1) the lifted game
// runs the emitter's triggers and the simulator the loops as written, so every line holds the one against the other.
//   EMITTER=1 npx tsx scripts/test-game.mts probes/game-emitter.ts
import { test, expect, program, displayText, setResources, gas, sleep, frames, u32, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 1, "gas");
  sleep(frames(2));
  const one = gas(P1); // 1, read in the game

  // A: counting and sums, a constant bound and a variable one, up and down.
  let a1 = 0, a2 = 0, a3 = 0;
  for (let i = 0; i < 10; i++) a1 += i;
  const n = one * 7;
  for (let i = 0; i < n; i++) { a2 = a2 + i + one; }
  for (let i = n; i > 0; i--) a3 = a3 - i;
  let a4 = 0;
  for (let i = 0; i <= n; i++) a4 += 2;
  displayText(`A: ${a1} ${a2} ${a3} ${a4}`);
  sleep(frames(1));

  // B: break, continue, do-while, while (true), nested.
  let b1 = 0, b2 = 0, b3 = 0, b4 = 0;
  for (let i = 0; i < 100; i++) { if (i == n) break; b1 += i; }
  for (let i = 0; i < 10; i++) { if (i < 3) continue; if (i >= 8) continue; b2 += i; }
  let k = 0;
  do { b3 += k; k++; } while (k < n);
  let j = 0;
  while (true) { j += 3; if (j > 20) break; }
  for (let x = 0; x < 4; x++) { for (let y = 0; y < x; y++) { b4 = b4 + x - y; } }
  displayText(`B: ${b1} ${b2} ${b3} ${j} ${b4}`);
  sleep(frames(1));

  // C: comparisons at the edges, signed and unsigned, a variable with a variable.
  const big = one * 2147483647, small = -2147483647 - one, zero = one - 1;
  let c = 0;
  let w = 0;
  while (w < 1) { w++; if (small < big) c += 1; if (big > small) c += 2; if (zero <= zero) c += 4; if (big >= big) c += 8; if (small == small) c += 16; if (big != small) c += 32; if (zero < small) c += 64; if (big < zero) c += 128; }
  const ubig = u32(-one), uzero = u32(zero);
  let d = 0;
  for (let t = 0; t < 1; t++) { if (uzero < ubig) d += 1; if (ubig > uzero) d += 2; if (ubig <= uzero) d += 4; if (ubig >= ubig) d += 8; if (uzero > ubig) d += 16; }
  let e = 0;
  for (let t = 0; t < 1; t++) { if (zero < big && small < zero) e += 1; if (zero > big || small < zero) e += 2; if (!(zero == small)) e += 4; if (zero != zero) e += 8; }
  displayText(`C: ${c} ${d} ${e}`);
  sleep(frames(1));

  // D: if and else in a loop, a variable set from others, a count down to a negative number.
  let evens = 0, odds = 0, last = 0, low = 0;
  for (let i = 0; i < 9; i++) {
    if (i == 0 || i == 2 || i == 4 || i == 6 || i == 8) evens += one; else odds += one;
    last = i + evens - odds;
  }
  for (let i = 3; i >= -3; i--) low = i;
  displayText(`D: ${evens} ${odds} ${last} ${low}`);
  sleep(frames(1));

  // E: variables set from themselves and read by each other — Fibonacci, a swap, a negation, a difference.
  let f0 = 0, f1 = one, p = 3, q = 5, neg = one * 9, diff = 0;
  const ten = one * 10;
  for (let i = 0; i < ten; i++) {
    const next = f0 + f1;
    f0 = f1;
    f1 = next;
    const t = p;
    p = q;
    q = t;
    neg = -neg;
    diff = i - diff;
  }
  displayText(`E: ${f0} ${f1} ${p} ${q} ${neg} ${diff}`);
  sleep(frames(1));

  // F: products and shifts by constants, wrapping, in a loop whose bound is a variable.
  let g1 = one, g2 = 0, g3 = 0;
  for (let i = 0; i < ten; i++) {
    g1 = g1 * 3 + 1;
    g2 = g2 + (i << 28) - i * 7;
    g3 = (g3 << 1) + g1 * -5;
  }
  displayText(`F: ${g1} ${g2} ${g3}`);
});

test("counting and sums", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("A: 45 28 -28 16");
});
test("break, continue, do-while, while (true), nested", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("B: 21 25 21 21 10");
});
test("comparisons at the edges", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("C: 63 11 7");
});
test("if and else in a loop", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("D: 5 4 9 -3");
});
test("products and shifts by constants", (sim) => {
  sim.frames(14);
  expect(sim).toHavePrinted("F: 88573 -805306683 -1303005");
});
test("variables set from themselves and read by each other", (sim) => {
  sim.frames(12);
  expect(sim).toHavePrinted("E: 55 89 3 5 9 5");
});
