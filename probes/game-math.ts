// TrigScript 4, the cheaper lowering of numbers: fixed products, quotients and roots, floors, shifts, products by a
// constant and signed comparisons, over values the game gives, in the lifted game and the simulator. Every expected
// line is the simulator's answer; the game has to give the same.
//   npx tsx scripts/test-game.mts probes/game-math.ts
import { test, expect, program, displayText, setResources, gas, sleep, frames, fixed, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 1, "gas");
  sleep(frames(2));
  const one = gas(P1); // 1, read in the game
  const f1 = fixed(one); // 1.0, a fixed number the build cannot know

  // A: fixed products and quotients, small, large (a divisor of 256 or more), below zero and tiny.
  const xs: fixed[] = [f1 * 1.5, f1 * -2.25, f1 * 0.0625, f1 * 300.5, f1 * -0.75, f1 * 7, f1 * 0.001, f1 * -1000];
  let a = "";
  for (let i = 0; i < 8; i++) {
    const p = xs[i], q = xs[(i + 3) % 8];
    a += `${Math.round(p * q * 100)},${Math.round((p / q) * 1000)} `;
  }
  displayText(`A: ${a}`);
  sleep(frames(1));

  // B: roots and floors.
  let b = "";
  for (let i = 0; i < 8; i++) b += `${Math.round(Math.sqrt(xs[i] < 0 ? -xs[i] : xs[i]) * 1000)},${Math.floor(xs[i])} `;
  displayText(`B: ${b}`);
  sleep(frames(1));

  // C: whole numbers: products by constants (the variable smaller and larger than the constant, below zero), shifts.
  const ns = [one * 3, one * -7, one * 100000, one * -1, one * 12, one * 2147483, one * -65536, one * 0];
  // (Two numbers a line: the game breaks a line longer than its text area.)
  for (let i = 0; i < 8; i += 2) {
    let c = "";
    for (let j = i; j < i + 2; j++) {
      const n = ns[j];
      c += `${n * 12},${n * -5},${n * 32},${n << 5},${n >> 2},${n >>> 3},${n >> 17} `;
    }
    displayText(`C${i / 2}: ${c}`);
  }
  sleep(frames(1));

  // D: signed comparisons of two variables, every order of signs, and equal.
  let d = "";
  for (let i = 0; i < 8; i++) {
    const x = ns[i], y = ns[(i + 5) % 8];
    d += `${x < y ? 1 : 0}${x <= y ? 1 : 0}${x > y ? 1 : 0}${x >= y ? 1 : 0}${x < x ? 1 : 0}${x <= x ? 1 : 0} `;
  }
  displayText(`D: ${d}`);
});

test("fixed products and quotients", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: -20461,5 169,3000 44,9 30,1986 9464,1 1050,4667 0,0 -6250,-9216 ");
});
test("roots and floors", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 1225,1 1500,-3 250,0 17335,300 866,-1 2646,7 32,0 31623,-1000 ");
});
test("whole numbers by constants, and shifts", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C0: 36,-15,96,96,0,0,0 -84,35,-224,-224,-2,536870911,-1 ");
  expect(sim).toHavePrinted("C1: 1200000,-500000,3200000,3200000,25000,12500,0 -12,5,-32,-32,-1,536870911,-1 ");
  expect(sim).toHavePrinted("C2: 144,-60,384,384,3,1,0 25769796,-10737415,68719456,68719456,536870,268435,16 ");
  expect(sim).toHavePrinted("C3: -786432,327680,-2097152,-2097152,-16384,536862720,-1 0,0,0,0,0,0,0 ");
});
test("signed comparisons", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: 110001 001101 001101 110001 001101 001101 110001 110001 ");
});
