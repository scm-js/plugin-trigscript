// TrigScript 3.6's probe (slice 6): arrays, lists a program looks a value up in, and arrays that grow out of a heap.
// Play it alone (Use Map Settings): you are Player 1, Terran; Player 2 is a computer. Every line says what it
// expects. Every index and value comes from a variable, so it is all the game's doing, not the compiler's.
//
//   0 s  "trigger(): hello"
//   2 s  A  a literal array, a constant and a variable index, += and ++      — expect 5 27 31 63
//   5 s  B  values of the program in the literal, new Array(6).fill, booleans — expect 3 6 0 6 4 1
//   8 s  C  a list of the script looked up by a variable                       — expect 251 1
//  11 s  D  cells keep their type: u8[] stops, u32[] wraps, number[] goes below — expect 255 0 4294967295 -1
//  14 s  E  for…of with continue and break                                     — expect 8
//  17 s  F  an array handed to a function is the same array                    — expect 13 14 15
//  20 s  G  past the end: a read is 0, a store does nothing                    — expect 0 1 2 3
//  23 s  H  push, pop, length, xs[xs.length] = v, length = n                   — expect 3 7 579 2 42
//  26 s  I  it grows: 1000 pushes, a block twice the size each time            — expect 2998
//  29 s  J  declared again 100 times over, 40 pushes each: the heap is not eaten — expect 780 40
//  32 s  K  includes, indexOf, fill                                            — expect 1 -1 1 7 7 7
//  35 s  L  the heap runs out: 20000 pushes, 500 a frame (watch for a stutter: tell me if the game hitches).
//           The game says "TrigScript: out of memory" ONCE, in red; then — expect 4096 (the arrays before it hold
//           ground already, and the next block, of 8192, is more than the 16384-cell heap has left: the simulator,
//           which counts as the game does, says 4096 too)
//  41 s  M  after that, a new array still finds room in the blocks given back  — expect 100 99
//  44 s  N  in a program of every player: an array each, and one they share    — expect "N: <your name>: mine 1, all 2"
//  47 s  O  arrays of records: a wave table of the script looked up by a variable, and records of the program
//           pushed, written through and gone over                                — expect 6 38 1 3 112
//  50 s  P  an array of units: your four Marines pushed into it. ONE Marine drops to 10 hit points (look), the sum of
//           their hit points                                                       — expect 4 130
//  52 s  P2 the last Marine of the array is popped and KILLED, and the first is killed through the array: two die.
//           A second later the array has 3 left, of which 2 are still alive       — expect 3 2
//  56 s  Q  a Map gone through with for…of, and a Set                             — expect 2 455 37
//  59 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/arrays.ts fixtures/eud/arrays.scx`.
import { trigger, program, always, displayText, sleep, seconds, frames, shared, name, unitsOf, units, P1, AllPlayers, CurrentPlayer, type Unit, type UnitType } from "trigscript";

const price = [50, 100, 150];
const open = [false, false, true];
const waves = [{ unit: units.ZergZergling, count: 4, boss: false }, { unit: units.ZergHydralisk, count: 6, boss: true }];

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  sleep(seconds(2));
  let hp = [10, 20, 30]; let i = 1;
  hp[0] = 5; hp[i] += 7; hp[i + 1]++;
  displayText(`A: ${hp[0]} ${hp[i]} ${hp[2]} ${hp[0] + hp[i] + hp[i + 1]} (expect 5 27 31 63)`);

  sleep(seconds(3));
  let three = 3;
  let xs = [three, three * 2, 0]; let zeros = new Array(6).fill(0); let full = Array(3).fill(three + 1); let seen = [false, true];
  seen[0] = xs[1] == 6;
  displayText(`B: ${xs[0]} ${xs[i]} ${xs[2]} ${zeros.length} ${full[2]} ${seen[0] && seen[i] ? 1 : 0} (expect 3 6 0 6 4 1)`);

  sleep(seconds(3));
  let level = 2;
  displayText(`C: ${price[level] + price[level - 1] + (open[level] ? 1 : 0)} ${open[level - 1] ? 0 : 1} (expect 251 1)`);

  sleep(seconds(3));
  let small: u8[] = [250, 3]; let wide: u32[] = [0]; let plain = [0]; let z = 0;
  small[z] += 10; small[z + 1] -= 5; wide[z] -= 1; plain[z] -= 1;
  displayText(`D: ${small[0]} ${small[1]} ${wide[z]} ${plain[z]} (expect 255 0 4294967295 -1)`);

  sleep(seconds(3));
  let five = [1, 2, 3, 4, 5]; let sum = 0;
  for (const x of five) { if (x == 2) continue; if (x == 5) break; sum += x; }
  displayText(`E: ${sum} (expect 8)`);

  sleep(seconds(3));
  let list = [1, 2, 3]; let two = 2;
  function bump(of: number[], by: number) { for (let k = 0; k < of.length; k++) of[k] += by; }
  bump(list, 10); bump(list, two);
  displayText(`F: ${list[0]} ${list[1]} ${list[2]} (expect 13 14 15)`);

  sleep(seconds(3));
  let ends = [1, 2, 3]; let past = 3; let below = -1;
  ends[past] = 9; ends[below] = 9;
  displayText(`G: ${ends[past] + ends[below]} ${ends[0]} ${ends[1]} ${ends[2]} (expect 0 1 2 3)`);

  sleep(seconds(3));
  const queue: number[] = [];
  queue.push(5); queue.push(6, 7);
  let n = queue.length;
  let last = queue.pop()!;
  queue[queue.length] = 9; queue[i] += 1;
  let digits = 0;
  for (const q of queue) digits = digits * 10 + q;
  queue.length = 2; queue.length = 9;
  let cut = queue.length;
  queue.length = 0;
  let none = queue.pop() ?? 42;
  displayText(`H: ${n} ${last} ${digits} ${cut} ${none} (expect 3 7 579 2 42)`);

  sleep(seconds(3));
  const many: number[] = []; let m = 0;
  while (m < 1000) { many.push(m * 2); m++; }
  let at999 = 999;
  displayText(`I: ${many[at999] + many.length} (expect 2998)`);

  sleep(seconds(3));
  let round = 0; let total = 0; let held = 0;
  while (round < 100) {
    const scratch: number[] = [];
    let k = 0;
    while (k < 40) { scratch.push(k); k++; }
    total = 0;
    for (const s of scratch) total += s;
    held = scratch.length;
    round++;
  }
  displayText(`J: ${total} ${held} (expect 780 40)`);

  sleep(seconds(3));
  let look = [4, 5, 6]; let v = 5;
  let where = look.indexOf(v); let nowhere = look.indexOf(v + 9); let has = look.includes(6) && !look.includes(v * 3);
  look.fill(v + 2);
  displayText(`K: ${where} ${nowhere} ${has ? 1 : 0} ${look[0]} ${look[1]} ${look[2]} (expect 1 -1 1 7 7 7)`);

  sleep(seconds(3));
  displayText("L: 20000 pushes, 500 a frame - the game says out of memory ONCE, in red. Does the game stutter?");
  const hog: number[] = []; let pushed = 0;
  while (pushed < 20000) {
    let k = 0;
    while (k < 500) { hog.push(pushed); pushed++; k++; }
    sleep(frames(1));
  }
  displayText(`L: the array holds ${hog.length} (expect 4096)`);

  sleep(seconds(3));
  const after: number[] = []; let a = 0;
  while (a < 100) { after.push(a); a++; }
  displayText(`M: ${after.length} ${after.pop() ?? 0} (expect 100 99)`);

  sleep(seconds(6));
  let w = 1;
  interface Hit { who: number; hard: boolean }
  const hits: Hit[] = [];
  hits.push({ who: 1, hard: false }, { who: 2, hard: true });
  hits.push({ who: w + 2, hard: waves[w].boss });
  const second = hits[w];
  w = 0;
  second.who = 100;
  let hard = 0; let who = 0;
  for (const h of hits) { if (h.hard) hard++; who += h.who; h.hard = false; }
  displayText(`O: ${waves[w + 1].count} ${waves[w + 1].unit} ${hits[w].who} ${hits.length} ${who + hard * 4} (expect 6 38 1 3 112)`);

  sleep(seconds(3));
  const squad: Unit[] = [];
  for (const u of unitsOf(P1, { type: units.TerranMarine })) squad.push(u);
  let one = 1;
  squad[one].hp = 10;
  let life = 0;
  for (const u of squad) life += u.hp;
  displayText(`P: ${squad.length} ${life} - ONE Marine is at 10 hit points (expect 4 130)`);

  sleep(seconds(2));
  squad.pop()?.kill();
  squad[one - 1].kill();
  sleep(seconds(1));
  let alive = 0;
  for (const u of squad) { if (u) alive++; }
  displayText(`P2: two Marines died; the array has ${squad.length} left, ${alive} alive (expect 3 2)`);

  sleep(seconds(3));
  const lost = new Map<UnitType, number>([[units.TerranMarine, 5], [units.ProtossZealot, 7]]);
  const met = new Set<UnitType>([units.ZergZergling]);
  lost.set(units.ZergZergling, 1); lost.delete(units.ZergZergling);
  let pairs = 0; let keys = 0;
  for (const [k, v] of lost) pairs += k * v;
  for (const k of met) keys = keys * 100 + k;
  displayText(`Q: ${lost.size} ${pairs} ${keys} (expect 2 455 37)`);

  sleep(seconds(3));
  displayText("done");
}, { owner: P1 });

program(() => {
  const mine: number[] = [];
  const all: number[] = shared([]);
  sleep(seconds(42));
  mine.push(1); all.push(1);
  sleep(seconds(2));
  // Every player shows this on a screen of their own; yours is the one you see.
  displayText(`N: ${name(CurrentPlayer)}: mine ${mine.length}, all ${all.length} (expect mine 1, all 2)`);
}, { owner: AllPlayers });
