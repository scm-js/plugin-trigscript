// TrigScript 3.8's probe (slice 8): functions that call themselves. Such a function is one copy in the built map; a
// call that may come back into it keeps the function's variables on a stack first and takes them back after. Play it
// alone (Use Map Settings): you are Player 1, Terran, with a Command Center and four Marines. Every line says what it
// expects, so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  fib(15): two calls of itself in one expression, 1973 calls in all           — expect 610
//   5 s  B  a call in one arm of ?:, and a sum a thousand calls deep                     — expect 120 500500
//   8 s  C  && and || run the call only when JavaScript would: how many calls were made  — expect 1 0 12
//  11 s  D  two functions that call each other                                           — expect 0 1 1
//  14 s  E  what stands to the left of the call is worked out before it                  — expect 24
//  17 s  F  a flood fill over an 8 × 8 grid with a wall across it                        — expect 24 32
//  20 s  G  an array declared in the function is each run's own, and the heap gets its blocks back — expect 28 28
//  23 s  H  a unit handed down three calls: ONE Marine loses 30 hit points               — expect 40 10
//  26 s  I  a call in the condition of a while and of a do…while                         — expect 3 3
//  30 s  J  fib(20), 21 891 calls within one frame: say how long the game stops for      — expect 6765
//  34 s  K  in a program of every player, frames kept a row a player — expect "K: <your name> 55"
//  38 s  L  a third program dives without end: the game says "stack overflow in dive, line …, 1024 calls deep.
//           The program has stopped." and "L: NOT to be seen" never appears
//  43 s  "done" — the first program is untouched by the third one's end
//
// Built with `npx tsx scripts/build-fixture.mts probes/recursion.ts fixtures/eud/recursion.scx`.
import { trigger, program, always, displayText, sleep, seconds, unitsOf, name, units, P1, CurrentPlayer, AllPlayers, type Unit } from "trigscript";

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  let calls = 0;
  let total = 10;
  let grid = new Array(64).fill(0);
  let filled = 0;
  function fib(n: number): number { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); }
  function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
  function sum(n: number): number { if (n == 0) return 0; return n + sum(n - 1); }
  function down(n: number): boolean { calls++; return n == 0 || down(n - 1); }
  function both(n: number): boolean { calls++; return n > 0 && both(n - 1); }
  function even(n: number): boolean { if (n == 0) return true; return odd(n - 1); }
  function odd(n: number): boolean { if (n == 0) return false; return even(n - 1); }
  function drain(n: number): number { if (n == 0) return 0; total -= 1; return total + drain(n - 1); }
  function fill(at: number) {
    if (at < 0 || at >= 64) return;
    if (grid[at] != 0) return;
    grid[at] = 2;
    filled++;
    const x = at % 8;
    if (x > 0) fill(at - 1);
    if (x < 7) fill(at + 1);
    fill(at - 8);
    fill(at + 8);
  }
  function spread(n: number): number {
    let mine = [n, n * 2, n * 3];
    let fixed = new Array(4).fill(n);
    if (n > 1) spread(n - 1);
    return mine[0] + mine[1] + mine[2] + fixed[3];
  }
  function weakest(): Unit | null {
    let best: Unit | null = null; let least = 100000;
    for (const u of unitsOf(P1, { type: units.TerranMarine })) { if (u.hp < least) { least = u.hp; best = u; } }
    return best;
  }
  function hpOf(u: Unit | null) { if (u) return u.hp; return -1; }
  function wear(u: Unit | null, times: number) { if (times == 0) return; if (u) u.hp -= 10; wear(u, times - 1); }
  function turns(n: number): number { let s = 0; while (n > 0 && turns(n - 1) >= 0) { s++; n--; } return s; }
  function rounds(n: number): number { let t = 0; do { t++; n--; } while (n > 0 && rounds(0) == 1); return t; }

  sleep(seconds(2));
  let fifteen = 15;
  displayText(`A: ${fib(fifteen)} (expect 610)`);

  sleep(seconds(3));
  let five = 5; let thousand = 1000;
  displayText(`B: ${fact(five)} ${sum(thousand)} (expect 120 500500)`);

  sleep(seconds(3));
  const reached = down(five) ? 1 : 0;
  const held = both(five) ? 1 : 0;
  displayText(`C: ${reached} ${held} ${calls} (expect 1 0 12)`);

  sleep(seconds(3));
  let nine = 9;
  displayText(`D: ${even(nine) ? 1 : 0} ${odd(nine) ? 1 : 0} ${even(nine + 1) ? 1 : 0} (expect 0 1 1)`);

  sleep(seconds(3));
  let three = 3;
  displayText(`E: ${drain(three)} (expect 24)`);

  sleep(seconds(3));
  for (let i = 0; i < 8; i++) grid[24 + i] = 1;
  let start = 0;
  fill(start);
  const above = filled;
  start = 63;
  fill(start);
  displayText(`F: ${above} ${filled - above} (expect 24 32)`);

  sleep(seconds(3));
  let four = 4;
  const once = spread(four);
  displayText(`G: ${once} ${spread(four)} (expect 28 28)`);

  sleep(seconds(3));
  const before = hpOf(weakest());
  wear(weakest(), three);
  displayText(`H: ${before} ${hpOf(weakest())} - ONE Marine is at 10 hit points (expect 40 10)`);

  sleep(seconds(3));
  displayText(`I: ${turns(three)} ${rounds(three)} (expect 3 3)`);

  sleep(seconds(4));
  let twenty = 20;
  displayText(`J: ${fib(twenty)} (expect 6765)`);

  sleep(seconds(13));
  displayText("done");
}, { owner: P1 });

program(() => {
  function sum(n: number): number { if (n == 0) return 0; return n + sum(n - 1); }
  sleep(seconds(34));
  let ten = 10;
  // Every player shows this on a screen of their own; yours is the one you see.
  displayText(`K: ${name(CurrentPlayer)} ${sum(ten)} (expect 55)`);
}, { owner: AllPlayers });

program(() => {
  let deepest = 0;
  function dive(n: number) { deepest = n; if (n >= 0) dive(n + 1); }
  sleep(seconds(38));
  let zero = 0;
  dive(zero);
  displayText("L: NOT to be seen");
}, { owner: P1 });
