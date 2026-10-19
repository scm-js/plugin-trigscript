// TrigScript 4, arrays at their cost: arrays that grow in cells of their own, reads and writes at a loop's counter
// through the offset kept beside it, and the bounds a loop over a growing array has already checked — in the lifted
// game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-arrays-cost.ts
// Everything starts from a number the game holds (gas, which the program sets first).
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

class P {
  constructor(public x: number, public v: number) {}
}

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: pushed past several block sizes (moved each time), summed by a counter and by for…of, read at another index. 3675 3675 111 50
  const list: number[] = [];
  for (let i = 0; i < g + 47; i++) list.push(i * g);
  let byIndex = 0;
  for (let i = 0; i < list.length; i++) byIndex += list[i];
  let byOf = 0;
  for (const v of list) byOf += v;
  const j = g + 34;
  displayText(`A: ${byIndex} ${byOf} ${list[j]} ${list.length}`);
  sleep(frames(1));

  // B: a loop over one array reading two others at its index, one shorter (written past its end: pushes), one longer. 30 4 4 10
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < g + 1; i++) a.push(g);
  b.push(g + 7);
  b.push(g + 17);
  for (let i = 1; i <= g + 3; i++) c.push(i);
  let s = 0, s2 = 0;
  for (let i = 0; i < a.length; i++) {
    s += i < b.length ? b[i] : 0;
    b[i] = i + 1;
    s2 += c[i];
  }
  displayText(`B: ${s} ${b.length} ${b[3]} ${s2}`);
  sleep(frames(1));

  // C: a loop that pushes onto its own array, and one that pops it: both checked as they go. 4 16 10 4
  const d: number[] = [];
  d.push(g - 2);
  d.push(g - 1);
  for (let i = 0; i < d.length; i++) if (d[i] < 3) d.push(d[i] + 5);
  let dSum = 0;
  for (const v of d) dSum += v;
  const e: number[] = [];
  for (let i = 1; i <= g + 2; i++) e.push(i);
  let eSum = 0;
  for (let i = 0; i < e.length; i++) {
    eSum += e[i];
    if (i == 1) e.pop();
  }
  displayText(`C: ${d.length} ${dSum} ${eSum} ${e.length}`);
  sleep(frames(1));

  // D: xs[i] += v at a counter, in place. 7 4 4 3
  const f: number[] = [];
  f.push(g);
  f.push(0);
  f.push(0);
  for (let i = 0; i < g; i++) f[i] += 4;
  displayText(`D: ${f[0]} ${f[1]} ${f[2]} ${f.length}`);
  sleep(frames(1));

  // E: records in an array that grows, moved by for…of, and read beside a shorter one. 35 41 6
  const ps: P[] = [];
  const qs: P[] = [];
  for (let i = 0; i < g + 2; i++) ps.push(new P(i, g + i));
  qs.push(new P(g * 2, 0));
  for (const p of ps) p.x += p.v;
  let xs = 0;
  for (const p of ps) xs += p.x;
  let mixed = 0;
  for (let i = 0; i < ps.length; i++) mixed += ps[i].x + (i < qs.length ? qs[i].x : 0);
  displayText(`E: ${xs} ${mixed} ${qs.length * 6}`);
  sleep(frames(1));

  // F: a counter counting down over a fixed array; a counter indexing a fixed array and a growing one. 45 12 39
  const fixed = [g - 3, g - 2, g - 1, g, g + 1, g + 2, g + 3, g + 4, g + 5, g + 6];
  let down = 0;
  let k = 10;
  while (k > 0) {
    k--;
    down += fixed[k];
  }
  let both = 0;
  let twice = 0;
  for (let i = 0; i < 3; i = i + 1) both += fixed[i + 1] + 0;
  for (let i = 0; i < list.length; i += 16) twice += fixed[i >> 4] + list[i] / g;
  displayText(`F: ${down} ${both + 6} ${twice - 63}`);
  sleep(frames(1));

  // G: declared again (its block given back) on each turn of a loop, shortened, pushed again, read at a counter;
  // booleans at a counter. 36 2 20 9 2
  let hSum = 0, h2 = 0, hLen = 0, h1 = 0;
  for (let r = 0; r < g - 1; r++) {
    const h: number[] = [];
    for (let i = 1; i <= g + 2 + r; i++) h.push(i);
    for (let i = 0; i < h.length; i++) hSum += h[i];
    h.length = 1;
    h.push(g + 6);
    for (let i = 0; i < h.length; i++) h2 += h[i];
    hLen = h.length;
    h1 = h[1];
  }
  const flags: boolean[] = [];
  flags.push(g == 3);
  flags.push(g == 4);
  flags.push(g > 0);
  let trues = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) trues++;
  displayText(`G: ${hSum} ${hLen} ${h2} ${h1} ${trues}`);
});

test("pushed past several block sizes, read at a counter and by for…of", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("A: 3675 3675 111 50");
});
test("other arrays read at a loop's index, shorter and longer", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("B: 30 4 4 10");
});
test("a loop that pushes, a loop that pops", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("C: 4 16 10 4");
});
test("+= at a counter, in place", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("D: 7 4 4 3");
});
test("records in an array that grows", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("E: 35 41 6");
});
test("counters counting down, and over two kinds of array", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("F: 45 12 39");
});
test("declared again, shortened, booleans", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("G: 36 2 20 9 2");
});
