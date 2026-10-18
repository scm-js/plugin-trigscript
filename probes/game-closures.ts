// TrigScript 4: closures over locals, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-closures.ts
// Every value starts from a variable the game holds (gas, which the program sets first), so how many environments are
// made, and which closure runs, is decided in the game.
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: makeCounter, two counters of their own; a parameter kept (adder). 3 1 123
  function makeCounter() { let count = 0; return () => ++count; }
  const a = makeCounter();
  const b = makeCounter();
  a(); a(); b();
  function adder(k: number) { return (x: number) => x + k; }
  const add = adder(g * 40);
  displayText(`A: ${a()} ${b()} ${add(g)}`);
  sleep(frames(1));

  // B: one closure for each turn of a while and of a for. 149 012
  const squares: (() => number)[] = [];
  let n = 1;
  while (n <= g) { const sq = n * n; squares.push(() => sq); n++; }
  let s1 = 0;
  for (const f of squares) s1 = s1 * 10 + f();
  const turns: (() => number)[] = [];
  for (let i = 0; i < g; i++) turns.push(() => i);
  let s2 = 0;
  for (const f of turns) s2 = s2 * 10 + f();
  displayText(`B: ${s1} ${s2}`);
  sleep(frames(1));

  // C: shared by the function and its closures, and by two closures of one run. 111 2 3
  function pair() { let x = 1; const bump = () => { x += 10; }; x += 100; bump(); return () => x; }
  function counter() { let c = 0; return { inc: () => { c++; }, get: () => c }; }
  const one = counter();
  const two = counter();
  one.inc(); one.inc(); two.inc(); two.inc(); two.inc();
  displayText(`C: ${pair()()} ${one.get()} ${two.get()}`);
  sleep(frames(1));

  // D: closures made by closures; a text and a unit-free boolean kept. 357 a+-+
  function outer(p: number) { return (q: number) => (r: number) => p * 100 + q * 10 + r; }
  const f2 = outer(g)(5);
  function flipper(label: string) { let on = false; let t = label; return () => { on = !on; t = t + (on ? "+" : "-"); return t; }; }
  const flip = flipper("a");
  flip(); flip();
  displayText(`D: ${f2(g + 4)} ${flip()}`);
  sleep(frames(1));

  // E: handlers registered in a loop, fired frames later. 246
  const hs: ((x: number) => void)[] = [];
  let log = 0;
  let i = 0;
  while (i < g) { const w = i + 1; hs.push((x) => { log = log * 10 + w * x; }); i++; }
  sleep(frames(3));
  for (const h of hs) h(2);
  displayText(`E: ${log}`);
  sleep(frames(1));

  // F: 3000 made and let go of across frames, never running out; the ones kept still there. 4498500 3000
  const keep: (() => number)[] = [];
  let total = 0;
  let last: () => number = () => 0;
  let k = 0;
  while (k < g * 1000) {
    const v = k;
    last = () => v;
    total += last();
    if (k % 1000 == 0) keep.push(last);
    k++;
    if (k % 100 == 0) sleep(frames(1));
  }
  let kept = 0;
  for (const h of keep) kept += h();
  displayText(`F: ${total} ${kept}`);
});

test("makeCounter and a kept parameter", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 3 2 123");
});
test("one closure for each turn", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 149 12");
});
test("shared variables", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 111 2 3");
});
test("closures inside closures, texts and booleans", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: 357 a+-+");
});
test("handlers fired frames later", (sim) => {
  sim.frames(30);
  expect(sim).toHavePrinted("E: 246");
});
test("environments given back", (sim) => {
  sim.frames(80);
  expect(sim).toHavePrinted("F: 4498500 3000");
});
