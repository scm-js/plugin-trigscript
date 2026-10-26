// TrigScript 4: the standard library's timers, signals, random and math, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-stdlib-core.ts
// Every value starts from a number the game holds (gas, which the program sets first).
import { test, expect, program, displayText, setResources, gas, sleep, frames, nextFrame, P1 } from "trigscript";
import { every, after, Cooldown, over, spread } from "trigscript/timers";
import { memory } from "trigscript";
import { Signal } from "trigscript/signals";
import { Random, range } from "trigscript/random";
import { Vec, lerp, easeOutQuad, radians, degrees } from "trigscript/math";

program(async () => {
  setResources(P1, "set", 3, "gas");
  await sleep(frames(2));
  const g = gas(P1); // 3, read in the game

  // A: timers — every, a limited one, after, a cooldown; handlers written in a loop each keep their own turn. x1 e1 x2 e2 a e3 | 2 | 10 20 30
  let log = "";
  const t = every(5, (n) => { log += `e${n} `; });
  every(3, (n) => { log += `x${n} `; }, 2);
  after(12, () => { log += "a "; });
  let loopLog = "";
  let k = 1;
  while (k <= g) { const tag = k * 10; after(4, () => { loopLog += `${tag} `; }); k++; }
  const cd = new Cooldown(10);
  let uses = 0;
  let i = 0;
  while (i < 16) { if (cd.use()) uses++; i++; await nextFrame(); }
  t.cancel();
  displayText(`A: ${log}| ${uses} | ${loopLog}`);
  await sleep(frames(1));

  // B: signals — on, once, off, a signal of texts. 13 0 [hi3]
  const s = new Signal<number>();
  const said = new Signal<string>();
  let got = 0;
  let words = "";
  const id = s.on((v) => { got += v; });
  s.once((v) => { got += v * 10; });
  said.on((w) => { words += `[${w}]`; });
  s.emit(1);
  s.emit(g - 1);
  s.off(id);
  s.emit(100);
  said.emit(`hi${g}`);
  displayText(`B: ${got} ${s.count()} ${words}`);
  await sleep(frames(1));

  // C: random — a seeded generator's numbers (the same as JavaScript's xorshift), and range staying inside. 14141 1
  const rng = new Random(g * 1000 + 7);
  let seq = "";
  i = 0;
  while (i < 5) { seq += `${rng.range(1, 6)}`; i++; }
  let inside = 1;
  i = 0;
  while (i < 50) { const r = range(2, 4); if (r < 2 || r > 4) inside = 0; i++; }
  displayText(`C: ${seq} ${inside}`);
  await sleep(frames(1));

  // D: math — lerp with easing, a vector turned and measured. 19.375 63 -200
  const v = Vec.fromAngle(radians(fixed(90)), fixed(2)).add(new Vec(fixed(1), fixed(0)));
  displayText(`D: ${lerp(fixed(10), fixed(20), easeOutQuad(fixed(g) / 4))} ${Math.round(degrees(v.angle()))} ${Math.round(v.rotate(radians(fixed(90))).x * 100)}`);
  await sleep(frames(1));

  // E: over and spread — an array that grows walked two a frame, its elements its own; a count three a frame. 10@0 11@0 12@1 13@1 14@2 | 60 | 2 12 22 33
  const bs: Vec[] = [];
  for (let j = 0; j < g + 2; j++) bs.push(new Vec(fixed(j), fixed(10)));
  const from = memory.game.frame;
  let walk = "";
  for await (const b of over(bs, { per: 2 })) { b.x += b.y; walk += `${Math.floor(b.x)}@${memory.game.frame - from} `; }
  let sum = 0;
  for (const b of bs) sum += Math.floor(b.x);
  const xs: number[] = [];
  for await (const j of spread(g + 1, { per: 3 })) xs.push(j * 10 + memory.game.frame - from);
  displayText(`E: ${walk}| ${sum} | ${xs.join(" ")}`);
});

test("timers", (sim) => {
  sim.frames(40);
  expect(sim).toHavePrinted("A: x1 e1 x2 e2 a e3 | 2 | 10 20 30");
});
test("signals", (sim) => {
  sim.frames(40);
  expect(sim).toHavePrinted("B: 13 0 [hi3]");
});
test("random", (sim) => {
  sim.frames(40);
  expect(sim).toHavePrinted("C: 14141 1");
});
test("math", (sim) => {
  sim.frames(40);
  expect(sim).toHavePrinted("D: 19.375 63 -200");
});
test("over and spread", (sim) => {
  sim.frames(50);
  expect(sim).toHavePrinted("E: 10@0 11@0 12@1 13@1 14@2 | 60 | 2 12 22 33");
});
