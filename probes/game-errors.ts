// TrigScript 4, B4: try / catch / finally and throw, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-errors.ts
// Every value starts from a variable the game holds (gas, which the program sets first), so which way an error goes is
// decided in the game: the jumps to the catches and the looks after the calls, not the build.
import { test, expect, program, displayText, setResources, gas, sleep, frames, start, P1 } from "trigscript";

program(async () => {
  setResources(P1, "set", 3, "gas");
  await sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: a class of error with a field, thrown from a called function (two calls), told apart. bought 10 need 55 more (55) Closed:shut
  class OutOfGold extends Error { constructor(public need: number) { super(`need ${need} more`); } }
  class Closed extends Error { name = "Closed"; }
  let gold = g * 10;
  function buy(cost: number) { if (cost == 0) throw new Closed("shut"); if (cost > gold) throw new OutOfGold(cost - gold); gold -= cost; }
  let a = "";
  const costs = [g * 2 + 4, g * 25, 0];
  for (const c of costs) {
    try { buy(c); a += ` bought ${c}`; }
    catch (e) { if (e instanceof OutOfGold) a += ` ${e.message} (${e.need})`; else if (e instanceof Error) a += ` ${e.name}:${e.message}`; }
  }
  displayText(`A:${a}`);
  await sleep(frames(1));

  // B: out of a function that calls itself, through every frame; and a stack that runs out, a RangeError. 7 hit 2 RangeError: Maximum call stack size exceeded 11
  function down(n: number, at: number): number { if (n == at) throw new Error(`hit ${n}`); if (n <= 0) return 0; return down(n - 1, at) + 1; }
  function deep(n: number): number { if (n > 100000) return 0; return deep(n + 1) + 1; }
  let b = `${down(g + 4, -1)}`;
  try { b += ` ${down(g + 4, 2)}`; } catch (e) { b += ` ${e instanceof Error ? e.message : "?"}`; }
  try { deep(0); } catch (e) { b += ` ${e}`; }
  b += ` ${down(g * 4 - 1, -1)}`;
  displayText(`B: ${b}`);
  await sleep(frames(1));

  // C: finally on every way out: the end, an error, break, continue, return; thrown on, and one in flight kept. a.f c.g 1.2..4.. r30 F inner kept
  let c = "";
  try { c += "a"; } finally { c += ".f"; }
  try { throw new Error("x"); } catch { c += " c"; } finally { c += ".g"; }
  c += " ";
  let i = 0;
  while (i < g + 3) { i++; try { if (i == g) continue; if (i == g + 2) break; c += `${i}`; } finally { c += "."; } }
  function ret(): number { try { return g * 10; } finally { c += " r"; } }
  const rv = ret();
  c += `${rv}`;
  try { try { throw new RangeError("kept"); } finally { try { throw new Error("inner"); } catch { c += " F"; } } } catch (e) { if (e instanceof RangeError) c += ` inner ${e.message}`; }
  displayText(`C: ${c}`);
  await sleep(frames(1));

  // D: an error after a wait, in a branch of Promise.all (the other stops), and one a task does not catch. 3 b failed 4 alive
  let n = 0;
  let d = "";
  try { while (true) { n++; await sleep(frames(1)); if (n == g) throw new Error(`${n}`); } } catch (e) { if (e instanceof Error) d += e.message; }
  let ticks = 0;
  try { await Promise.all([(async () => { while (true) { ticks++; await sleep(frames(1)); } })(), (async () => { let w = 0; while (w < g) { w++; await sleep(frames(1)); } throw new Error("b failed"); })()]); }
  catch (e) { if (e instanceof Error) d += ` ${e.message} ${ticks}`; }
  async function worker() { await sleep(frames(1)); throw new TypeError(`worker ${g}`); }
  start(worker());
  await sleep(frames(4));
  displayText(`D: ${d} alive`);

  // E: out of loops over a text and over a Map, 4 800 times: what they hold goes back each time (else the heap runs out). 9600 2
  const seen = new Map<number, number>();
  seen.set(1, 10);
  seen.set(2, 20);
  const word = `ab${g}`;
  let caught = 0;
  let turn = 0;
  while (turn < 80) {
    let k = 0;
    while (k < 60) {
      try { for (const ch of word) { if (ch == "b") throw new Error("b"); } } catch { caught++; }
      try { for (const [, v] of seen) { if (v == 20) throw new Error("twenty"); } } catch { caught++; }
      k++;
    }
    turn++;
    await sleep(frames(1));
  }
  displayText(`E: ${caught} ${seen.size}`);
  await sleep(frames(1));

  // F: a generator's finally on a break and on the body's error, which its catch does not take; a caught error's
  // overridden method, chosen in the game; await of a task that failed. 01f 0f body bad: b worse: c! wave 3 lost
  let f = "";
  function* count(n: number) { try { for (let j = 0; j < n; j++) yield j; } catch { f += "gen caught"; } finally { f += "f"; } }
  for (const x of count(g + 2)) { if (x == 2) break; f += `${x}`; }
  f += " ";
  try { for (const x of count(g + 2)) { if (x == 1) throw new Error("body"); f += `${x}`; } } catch (e) { if (e instanceof Error) f += ` ${e.message}`; }
  class Bad extends Error { describe() { return `bad: ${this.message}`; } }
  class Worse extends Bad { describe() { return `worse: ${this.message}!`; } }
  let q = 0;
  while (q < 2) { try { if (q == g - 3) throw new Bad("b"); throw new Worse("c"); } catch (e) { if (e instanceof Bad) f += ` ${e.describe()}`; } q++; }
  async function wave(n: number) { await sleep(frames(2)); if (n == g) throw new RangeError(`wave ${n} lost`); }
  const w = start(wave(g));
  try { await w; } catch (e) { if (e instanceof RangeError) f += ` ${e.message}`; }
  displayText(`F: ${f}`);
});

test("classes of error, from a called function", (sim) => {
  sim.frames(12);
  expect(sim).toHavePrinted("A: bought 10 need 55 more (55) Closed:shut");
});
test("recursion, and a stack that runs out", (sim) => {
  sim.frames(12);
  expect(sim).toHavePrinted("B: 7 hit 2 RangeError: Maximum call stack size exceeded 11");
});
test("finally on every way out", (sim) => {
  sim.frames(12);
  expect(sim).toHavePrinted("C: a.f c.g 1.2..4.. r30 F inner kept");
});
test("errors and waiting", (sim) => {
  sim.frames(40);
  expect(sim).toHavePrinted("D: 3 b failed 4 alive");
  expect(sim).toHaveFaulted("Uncaught TypeError: worker 3");
});
test("what an error leaves behind goes back", (sim) => {
  sim.frames(140);
  expect(sim).toHavePrinted("E: 9600 2");
  expect(sim).toHaveFaulted("Uncaught TypeError: worker 3");
});
test("generators, a caught error's methods, and await of a task", (sim) => {
  sim.frames(150);
  expect(sim).toHavePrinted("F: 01f 0f body bad: b worse: c! wave 3 lost");
  expect(sim).toHaveFaulted("Uncaught TypeError: worker 3");
});
test("what a task does not catch is said, and the task ends", (sim) => {
  sim.frames(40);
  expect(sim).toHavePrinted("uncaught TypeError: worker 3, line 57.");
  expect(sim).toHaveFaulted("Uncaught TypeError: worker 3");
});
