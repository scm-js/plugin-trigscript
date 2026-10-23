// TrigScript 4, B9: records and instances as values, and a number or nothing, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-values.ts
import { test, expect, program, displayText, setResources, gas, sleep, frames, P1 } from "trigscript";
import { Vec } from "trigscript/math";

class Cooldown {
  left?: number;
  start(n: number) { this.left = n; }
  tick() { if (this.left !== undefined) { this.left--; if (this.left <= 0) this.left = undefined; } }
}

program(() => {
  setResources(P1, "set", 3, "gas");
  sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: a record given whole, one or the other, and a copy kept. 2 6 big 1
  let r = { x: 1, y: 2 };
  r = { x: r.y, y: r.x + g + 2 };
  const s = g > 2 ? { n: 1, word: "big" } : { n: 2, word: "small" };
  displayText(`A: ${r.x} ${r.y} ${s.word} ${s.n}`);
  sleep(frames(1));

  // B: Vec given whole in a loop: turned a quarter g + 1 times, back where it was. 1 0
  let v = new Vec(1, 0);
  let i = 0;
  while (i <= g) { v = v.rotate(Math.PI / 2); i++; }
  displayText(`B: ${Math.round(v.x)} ${Math.round(v.y)}`);
  sleep(frames(1));

  // C: the largest so far, find(), get(), a field that may be nothing. 9 9 -1 40 2 -1
  const xs = [g + 2, g * 3, g + 1];
  let best: number | undefined = undefined;
  for (const x of xs) if (best === undefined || x > best) best = x;
  const found = xs.find((x) => x > 7);
  const none = xs.find((x) => x > 100);
  const m = new Map<number, number>();
  m.set(g, 40);
  const cd = new Cooldown();
  cd.start(g);
  cd.tick();
  const after = cd.left ?? -1;
  cd.tick(); cd.tick();
  displayText(`C: ${best ?? -1} ${found ?? -1} ${none ?? -1} ${m.get(3) ?? -1} ${after} ${cd.left ?? -1}`);
});

test("a record given whole", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 2 6 big 1");
});
test("Vec given whole", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 1 0");
});
test("a number or nothing", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 9 9 -1 40 2 -1");
});
