// TrigScript 4, B1's second part: tasks — start(), void, a Task's running / cancel() / await, max — run in the lifted
// game as well as in the simulator; the two have to agree frame for frame.
//   npx tsx scripts/test-game.mts probes/game-tasks.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home").
import { test, expect, program, displayText, print, setResources, sleep, start, frames, P1 } from "trigscript";

program(async () => {
  async function add(k: number, each: number) { for (let i = 0; i < k; i++) { setResources(P1, "add", each, "gas"); await sleep(frames(1)); } }
  async function forever() { while (true) { setResources(P1, "add", 1, "ore"); await sleep(frames(1)); } }
  async function hold() { await sleep(frames(50)); }
  // Frame 2: two tasks of the one start, +1 gas for three frames and +10 for five, each with its own i.
  let n = 2;
  for (let j = 0; j < n; j++) start(add(3 + j * 2, 1 + j * 9));
  await sleep(frames(10));
  // Frame 12: +1 ore a frame until frame 17, when the program, whose turn comes first, cancels it.
  const f = start(forever());
  await sleep(frames(5));
  f.cancel();
  displayText(f.running ? "still running" : "stopped");
  // Three starts of a start with room for two.
  let made = 0;
  for (let j = 0; j <= n; j++) { const t = start(hold(), { max: 2 }); if (t.running) made++; }
  print(`made ${made}`);
  // +100 gas on frames 17 and 18; the task ends on frame 19 after the program's turn, which sees it on frame 20.
  const w = start(add(2, 100));
  await w;
  displayText("awaited");
  void (async () => { await sleep(frames(20)); displayText("after the end"); })();
}, { owner: P1 });

test("two tasks of one start keep their own cells", (sim) => {
  sim.frames(5);
  expect(sim.resources(P1).gas).toBe(43);
  sim.frames(2);
  expect(sim.resources(P1).gas).toBe(53);
  sim.frames(5);
  expect(sim.resources(P1).gas).toBe(53);
});

test("cancel() stops a task where it is", (sim) => {
  sim.frames(17);
  expect(sim.resources(P1).ore).toBe(5);
  sim.frames(6);
  expect(sim.resources(P1).ore).toBe(5);
  expect(sim).toHavePrinted("stopped");
  expect(sim).toHaveFaulted("did not start");
});

test("max: a start with every slot running starts nothing", (sim) => {
  sim.frames(18);
  expect(sim).toHavePrinted("made 2");
  expect(sim).toHaveFaulted("hold did not start");
});

test("await a task, and a task that runs on after the program ends", (sim) => {
  sim.frames(19);
  expect(sim).toHaveFaulted("did not start");
  expect(sim).not.toHavePrinted("awaited");
  sim.frames(1);
  expect(sim).toHavePrinted("awaited");
  expect(sim.resources(P1).gas).toBe(253);
  sim.frames(19);
  expect(sim).not.toHavePrinted("after the end");
  sim.frames(1);
  expect(sim).toHavePrinted("after the end");
});
