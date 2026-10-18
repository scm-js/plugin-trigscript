// TrigScript 4, B3: functions as values, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-function-values.ts
// Every value starts from a variable the game holds (gas, which the program sets first), so which function runs is
// decided in the game: the dispatchers' switches, not the build.
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: handed down, and one copy for each function handed. 6 13 2
  let total = 0;
  function each(xs: number[], f: (x: number) => void) { for (const x of xs) f(x); }
  function count(xs: number[], test: (x: number) => boolean) { let n = 0; for (const x of xs) if (test(x)) n++; return n; }
  const xs = [1, 2, 3];
  each(xs, (x) => { total += x; });
  let more = 0;
  each(xs, (x) => { more += x * g; });
  const gs = [g];
  each(gs, (x) => { more -= x * 2; });
  displayText(`A: ${total} ${more + 1} ${count(xs, (x) => x >= g - 1)}`);
  sleep(frames(1));

  // B: a state machine, each state a function that names the next. 23
  let ticks = 0;
  let state: () => void = idle;
  function idle() { ticks++; if (ticks == g) state = busy; }
  function busy() { ticks += 10; }
  let i = 0;
  while (i < g + 2) { state(); i++; }
  displayText(`B: ${ticks}`);
  sleep(frames(1));

  // C: an array of functions, by a place the game works out; handlers pushed and all called. 312 303
  function one() { return 1; }
  function two() { return 2; }
  function three() { return 3; }
  const fs = [one, two, three];
  let digits = 0;
  for (let k = 0; k < 3; k++) digits = digits * 10 + fs[(k + g - 1) % 3]();
  let log = 0;
  const handlers: ((n: number) => void)[] = [];
  handlers.push((n) => { log += n; });
  handlers.push((n) => { log += n * 100; });
  for (const h of handlers) h(g);
  displayText(`C: ${digits} ${log}`);
  sleep(frames(1));

  // D: a record of functions, a field given another; a class's handler set from outside. 19 10 3 clicks
  const ops = { add: (a: number, b: number) => a + b, mul: (a: number, b: number) => a * b };
  let r = ops.mul(ops.add(g, 2), 4);
  ops.add = (a: number, b: number) => a - b;
  r = ops.add(r, 1);
  class Btn { clicks = 0; onClick: () => void = () => {}; label = () => `${this.clicks} clicks`; click() { this.clicks++; this.onClick(); } }
  let pressed = 0;
  const b = new Btn();
  b.click();
  b.onClick = () => { pressed += 5; };
  b.click();
  b.click();
  displayText(`D: ${r} ${pressed} ${b.label()}`);
  sleep(frames(1));

  // E: functions that make functions, and one chosen in the game. 7 1112 812
  function adder(k: number) { return (x: number) => x + k; }
  function compose(f: (x: number) => number, h: (x: number) => number) { return (x: number) => f(h(x)); }
  const inc = (x: number) => x + 1;
  const dbl = (x: number) => x * 2;
  const add4 = adder(4);
  let twice = compose(inc, dbl);
  let e1 = twice(g + 2);
  twice = compose(dbl, inc);
  e1 = e1 * 100 + twice(g + 2);
  function pick(n: number): (x: number) => number { if (n > 3) return inc; return dbl; }
  const e2 = pick(g + 1)(7) * 100 + pick(g)(6);
  displayText(`E: ${add4(g)} ${e1} ${e2}`);
  sleep(frames(1));

  // F: calls itself through a variable; a text and a boolean through one; a Map of functions. 720 #3! 11
  let fact: (n: number) => number = (n) => (n <= 1 ? 1 : n * fact(n - 1));
  let name: (n: number) => string = (n) => `#${n}`;
  let odd: (n: number) => boolean = (n) => n % 2 == 1;
  const byKey = new Map<number, () => number>();
  byKey.set(7, two);
  byKey.set(9, one);
  const got = byKey.get(g + 6);
  const fromMap = (got ? got() : 0) * 10 + byKey.get(g * 3)!();
  displayText(`F: ${fact(g * 2)} ${name(g)}${odd(g) ? "!" : "?"} ${fromMap}`);
});

test("handed down", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 6 13 2");
});
test("a state machine", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 23");
});
test("arrays of functions", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 312 303");
});
test("fields", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("D: 19 10 3 clicks");
});
test("functions that make functions", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("E: 7 1112 812");
});
test("recursion, texts, booleans and a Map", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("F: 720 #3! 11");
});
