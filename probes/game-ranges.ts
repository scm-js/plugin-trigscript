// TrigScript 4, value ranges (compiler/ranges.ts): numbers whose range the compiler knows though not their values —
// masked, counted, clamped, a unit's field — through every lowering that takes only the bits a range has: products by
// a constant, quotients and remainders by a constant and by a variable, shifts, min / max / abs settled, comparisons
// settled or read unsigned. In the lifted game and the simulator; every expected line is worked out in plain JavaScript.
//   npx tsx scripts/test-game.mts probes/game-ranges.ts
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 1, "gas");
  sleep(frames(2));
  const one = gas(P1); // 1, read in the game

  // Eight values in 0 … 1023 (the mask says so), from the game.
  const vs = [one * 0, one * 1, one * 7, one * 200, one * 511, one * 512, one * 999, one * 1023];
  const m: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) m[i] = vs[i] & 1023;

  // A: products by constants of both signs, small and large. (Two values a line: the game breaks a longer one.)
  for (let i = 0; i < 8; i += 2) {
    let a = "";
    for (let j = i; j < i + 2; j++) a += `${m[j] * 12},${m[j] * -5},${m[j] * 1000},${m[j] * 65537} `;
    displayText(`A${i / 2}: ${a}`);
  }
  sleep(frames(1));

  // B: quotients and remainders by constants: odd, a power of two, one, larger than any value.
  for (let i = 0; i < 8; i += 2) {
    let b = "";
    for (let j = i; j < i + 2; j++) b += `${m[j] / 3 | 0},${m[j] % 3},${m[j] / 16 | 0},${m[j] % 16},${m[j] / 1 | 0},${m[j] / 2000 | 0},${m[j] % 10} `;
    displayText(`B${i / 2}: ${b}`);
  }
  sleep(frames(1));

  // C: by a variable known to be 1 … 64, and a constant over one; the divisor larger than the dividend too.
  for (let i = 0; i < 8; i += 4) {
    let c = "";
    for (let j = i; j < i + 4; j++) {
      const d = (vs[(j + 3) % 8] & 63) + 1;
      c += `${m[j] / d | 0},${m[j] % d},${1000 / d | 0} `;
    }
    displayText(`C${i / 4}: ${c}`);
  }
  sleep(frames(1));

  // D: shifts, min / max / abs the ranges settle or not, and comparisons settled or read unsigned.
  for (let i = 0; i < 8; i += 2) {
    let dd = "";
    for (let j = i; j < i + 2; j++) {
      const v = m[j];
      dd += `${v >> 3},${v >>> 9},${v << 3},${Math.min(v, 5000)},${Math.max(v, -1)},${Math.abs(v)},${Math.min(v, 300)},${v < 2000 ? 1 : 0}${v >= 0 ? 1 : 0}${v < 300 ? 1 : 0} `;
    }
    displayText(`D${i / 2}: ${dd}`);
  }
  sleep(frames(1));

  // E: a loop's counter (0 … 16 by its test) multiplied and divided, and a value clamped by an if.
  let acc = 0;
  for (let i = 0; i < 16; i++) acc += (i * 37) / 5 | 0;
  let k = vs[6];
  if (k > 600) k = 600;
  let e = `${acc},${(k * 3) / 7 | 0},${k % 9}`;
  // A counter wrapped by a mask: always 0 … 15, so the comparison below is never settled.
  let w = 0;
  for (let t = 0; t < 40; t++) w = (w + 7) & 15;
  e += `,${w},${w < 8 ? 1 : 0}`;
  displayText(`E: ${e}`);
});

test("products by constants", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A0: 0,0,0,0 12,-5,1000,65537 ");
  expect(sim).toHavePrinted("A1: 84,-35,7000,458759 2400,-1000,200000,13107400 ");
  expect(sim).toHavePrinted("A2: 6132,-2555,511000,33489407 6144,-2560,512000,33554944 ");
  expect(sim).toHavePrinted("A3: 11988,-4995,999000,65471463 12276,-5115,1023000,67044351 ");
});
test("quotients and remainders by constants", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B0: 0,0,0,0,0,0,0 0,1,0,1,1,0,1 ");
  expect(sim).toHavePrinted("B1: 2,1,0,7,7,0,7 66,2,12,8,200,0,0 ");
  expect(sim).toHavePrinted("B2: 170,1,31,15,511,0,1 170,2,32,0,512,0,2 ");
  expect(sim).toHavePrinted("B3: 333,0,62,7,999,0,9 341,0,63,15,1023,0,3 ");
});
test("quotients by a variable", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C0: 0,0,111 0,1,15 7,0,1000 5,0,25 ");
  expect(sim).toHavePrinted("C1: 7,63,15 512,0,1000 499,1,500 127,7,125 ");
});
test("shifts, min / max / abs, comparisons", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D0: 0,0,0,0,0,0,0,111 0,0,8,1,1,1,1,111 ");
  expect(sim).toHavePrinted("D1: 0,0,56,7,7,7,7,111 25,0,1600,200,200,200,200,111 ");
  expect(sim).toHavePrinted("D2: 63,0,4088,511,511,511,300,110 64,1,4096,512,512,512,300,110 ");
  expect(sim).toHavePrinted("D3: 124,1,7992,999,999,999,300,110 127,1,8184,1023,1023,1023,300,110 ");
});
test("a counter, a clamp, a mask", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("E: 882,257,6,8,0");
});
