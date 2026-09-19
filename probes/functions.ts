// TrigScript 3.7's probe (slice 7): functions that are called. A function met a second time is one copy in the
// built map; every call sets its parameters and runs that copy. Play it alone (Use Map Settings): you are Player 1,
// Terran, with a Command Center and four Marines. Every line says what it expects, so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  a called function with two parameters, from constants and from variables   — expect 7 30 -4
//   5 s  B  an argument that is a call of the same function: add(add(1, 2), add(3, 4))   — expect 10
//   8 s  C  a boolean result, and a boolean parameter                                   — expect 1 0 1
//  11 s  D  locals start afresh at every call; a u8 parameter stops at 255               — expect 6 8 255
//  14 s  E  a function that writes a variable of the program, called in a loop           — expect 5 15
//  17 s  F  one copy an array passed: total(hp) and total(shields)                       — expect 6 30 6
//  20 s  G  a function that stores into the array it is passed, and pushes to one that grows — expect 11 12 13 4
//  23 s  H  a called function that calls another, and an early return                    — expect 12 0 99
//  26 s  I  a unit for a result and a unit for a parameter: your weakest Marine (they are all at 40, so the
//           first) loses 30 hit points through hurt(weakest(), 30): ONE Marine is at 10    — expect 40 10
//  30 s  J  2000 calls within one frame: the game must NOT stutter                       — expect 2000 2001000
//  33 s  K  a function inlined because it sleeps, beside the called ones: two lines a second apart — "K1" then "K2"
//  37 s  L  a game() function kept outside the program, called three times               — expect 10 5 0
//  40 s  M  in a program of every player, parameters and results kept per player — expect "M: <your name> 3 6"
//  43 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/functions.ts fixtures/eud/functions.scx`.
import { trigger, program, game, always, displayText, sleep, seconds, unitsOf, name, units, P1, CurrentPlayer, AllPlayers, type Unit } from "trigscript";

trigger(P1, [always()], [displayText("trigger(): hello")]);

const clampTo = game((n: number, top: number) => {
  if (n > top) return top;
  if (n < 0) return 0;
  return n;
});

program(() => {
  let calls = 0;
  function add(a: number, b: number) { return a + b; }
  function big(n: number) { return n >= 10; }
  function either(a: boolean, b: boolean) { return a || b; }
  function twice(n: number) { let t = n; t += t; return t; }
  function small(n: u8) { return n; }
  function bump() { calls += 1; }
  function bumpBy(n: number) { calls += n; }
  function total(xs: number[]) { let t = 0; for (const x of xs) t += x; return t; }
  function raise(xs: number[], by: number) { for (let i = 0; i < xs.length; i++) xs[i] += by; }
  function keep(xs: number[], v: number) { xs.push(v); return xs.length; }
  function inner(n: number) { return n * 2; }
  function outer(n: number) { return inner(n) + inner(n + 1) + 2; }
  function early(n: number) { if (n < 0) return 0; if (n > 50) return 99; return n; }
  function weakest(): Unit | null {
    let best: Unit | null = null; let least = 100000;
    for (const u of unitsOf(P1, { type: units.TerranMarine })) { if (u.hp < least) { least = u.hp; best = u; } }
    return best;
  }
  function hurt(u: Unit | null, by: number) { if (u) u.hp -= by; }
  function hpOf(u: Unit | null) { if (u) return u.hp; return -1; }
  function wait(label: number) { displayText(`K${label}`); sleep(seconds(1)); }

  sleep(seconds(2));
  let three = 3; let four = 4; let minus9 = -9; let five = 5;
  displayText(`A: ${add(3, 4)} ${add(three * 2, four * 6)} ${add(minus9, five)} (expect 7 30 -4)`);

  sleep(seconds(3));
  displayText(`B: ${add(add(1, 2), add(three, four))} (expect 10)`);

  sleep(seconds(3));
  let ten = 10; let yes = true; let no = false;
  displayText(`C: ${big(ten) ? 1 : 0} ${big(ten - 1) ? 1 : 0} ${either(no, yes) && !either(no, no) ? 1 : 0} (expect 1 0 1)`);

  sleep(seconds(3));
  let much = 300;
  displayText(`D: ${twice(three)} ${twice(four)} ${small(much)} (expect 6 8 255)`);
  small(1);

  sleep(seconds(3));
  while (calls < 5) { bump(); }
  const after = calls;
  bumpBy(ten);
  displayText(`E: ${after} ${calls} (expect 5 15)`);

  sleep(seconds(3));
  let hp = [1, 2, 3]; let shields = [10, 20];
  displayText(`F: ${total(hp)} ${total(shields)} ${total(hp)} (expect 6 30 6)`);
  total(shields);

  sleep(seconds(3));
  let grown: number[] = [];
  raise(hp, ten); raise(hp, 0);
  keep(grown, 1); keep(grown, 2); keep(grown, three);
  displayText(`G: ${hp[0]} ${hp[1]} ${hp[2]} ${keep(grown, four)} (expect 11 12 13 4)`);

  sleep(seconds(3));
  let sixty = 60;
  displayText(`H: ${outer(2)} ${early(minus9)} ${early(sixty)} (expect 12 0 99)`);
  outer(three); early(five);

  sleep(seconds(3));
  const before = hpOf(weakest());
  hurt(weakest(), 30);
  hurt(null, 1);
  displayText(`I: ${before} ${hpOf(weakest())} - ONE Marine is at 10 hit points (expect 40 10)`);

  sleep(seconds(4));
  calls = 0; let sum = 0;
  let i = 1;
  while (i <= 2000) { bump(); sum = add(sum, i); i++; }
  displayText(`J: ${calls} ${sum} (expect 2000 2001000)`);

  sleep(seconds(3));
  wait(1);
  wait(2);

  sleep(seconds(2));
  let fifty = 50;
  displayText(`L: ${clampTo(fifty, 10)} ${clampTo(five, 10)} ${clampTo(minus9, 10)} (expect 10 5 0)`);

  sleep(seconds(6));
  displayText("done");
}, { owner: P1 });

program(() => {
  let mine = 0;
  function earn(n: number) { mine += n; return mine; }
  sleep(seconds(40));
  const first = earn(1) + earn(2) - 1;
  // Every player shows this on a screen of their own; yours is the one you see.
  displayText(`M: ${name(CurrentPlayer)} ${first} ${earn(3)} (expect 3 6)`);
}, { owner: AllPlayers });
