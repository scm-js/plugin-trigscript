// TrigScript 3.5's probe (slice 5): a number is a signed 32-bit integer, a u32 the unsigned one beside it.
// Play it alone (Use Map Settings): you are Player 1, Terran, with a Command Center and four Marines.
// Every line says what it expects, so a wrong number shows. Every value comes from a variable, so
// nothing below is worked out when the map is built: it is all the game's arithmetic.
//
//   0 s  "trigger(): hello"
//   2 s  A  below zero: 3 - 10, -3 * 2, 0 - 1 - 1            — expect -7 -6 -2
//   5 s  B  the ends: a number wraps at 2^31, a u32 at 2^32   — expect -2147483648 2147483647 0 4294967295
//   8 s  C  signed comparisons, as 1 / 0                      — expect 1 1 1 0 1 0
//  11 s  D  division towards zero, by a variable              — expect -3 -1 -3 1 3 1
//  14 s  D2 the same by a constant, and a divisor of 0        — expect -3 -1 -3 1 0 0
//  17 s  D3 u32s divide from 0 up                             — expect 2147483647 1
//  20 s  E  shifts: >> keeps the sign, >>> does not           — expect -4 -4 15 -2147483648 -1 0
//  23 s  F  Math.min / max / abs / clamp                      — expect -5 3 5 -3 3
//  26 s  G  a number against a u32, exactly                   — expect 1 1 1 0
//  29 s  H  u32(x) and i32(x) read the same bits              — expect 2147483647 -2 2147483647
//  32 s  I  what the game takes nothing below zero of: a u8 of -5 and of 300, then your ORE set from -50
//           (look at the top bar: 0), then from 75 (top bar: 75)
//  36 s  I2 createUnit with a count of -3: NO Marine appears; then a count of 2: two appear next to your base
//  40 s  J  a countdown that ends below zero: while (i >= 0) runs 4 times — expect 4 and -1
//  43 s  K  a switch on a number below zero                   — expect "K: minus one"
//  46 s  L  a u32 past two thousand million                   — expect 4000000005
//  49 s  M  the first Marine of yours loses 1000 hit points through u.hp -= 1000: it DIES (hp below zero is 0)
//  52 s  N  in a program of every player, a debt of -5 kept per player — expect "N: <your name> owes -5"
//  55 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/numbers.ts fixtures/eud/numbers.scx`.
import { trigger, program, always, displayText, createUnit, setResources, sleep, seconds, first, clamp, u32, i32, name, units, players, P1, CurrentPlayer, type Location } from "trigscript";

// Location 1 is "Home", which build-fixture puts next to Player 1's base; the map's names are not known to this script.
const HOME = 1 as Location;

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  sleep(seconds(2));
  let three = 3; let ten = 10; let zero = 0; let one = 1;
  displayText(`A: ${three - ten} ${-three * 2} ${zero - one - one} (expect -7 -6 -2)`);

  sleep(seconds(3));
  let top = 2147483647; let bottom = -2147483648;
  let utop: u32 = 4294967295; let uzero: u32 = 0;
  displayText(`B: ${top + one} ${bottom - one} ${utop + 1} ${uzero - 1} (expect -2147483648 2147483647 0 4294967295)`);

  sleep(seconds(3));
  let minus1 = -1; let minus5 = -5;
  displayText(`C: ${minus1 < one ? 1 : 0} ${minus5 >= minus5 ? 1 : 0} ${bottom < top ? 1 : 0} ${minus1 > zero ? 1 : 0} ${minus5 < -4 ? 1 : 0} ${minus5 == 5 ? 1 : 0} (expect 1 1 1 0 1 0)`);

  sleep(seconds(3));
  let minus7 = -7; let seven = 7; let two = 2; let minus2 = -2;
  displayText(`D: ${minus7 / two} ${minus7 % two} ${seven / minus2} ${seven % minus2} ${minus7 / minus2} ${seven % two} (expect -3 -1 -3 1 3 1)`);

  sleep(seconds(3));
  displayText(`D2: ${minus7 / 2} ${minus7 % 2} ${seven / -2} ${seven % -2} ${minus7 / zero} ${minus7 % zero} (expect -3 -1 -3 1 0 0)`);

  sleep(seconds(3));
  let utwo: u32 = 2;
  displayText(`D3: ${utop / utwo} ${utop % 2} (expect 2147483647 1)`);

  sleep(seconds(3));
  let minus16 = -16; let s28 = 28; let s31 = 31; let s40 = 40; let five = 5;
  displayText(`E: ${minus16 >> two} ${minus16 >> 2} ${minus16 >>> s28} ${one << s31} ${minus5 >> s40} ${five >> s40} (expect -4 -4 15 -2147483648 -1 0)`);

  sleep(seconds(3));
  displayText(`F: ${Math.min(minus5, three)} ${Math.max(minus5, three)} ${Math.abs(minus5)} ${clamp(minus7, -3, 3)} ${clamp(ten, -3, 3)} (expect -5 3 5 -3 3)`);

  sleep(seconds(3));
  displayText(`G: ${minus1 < utop ? 1 : 0} ${minus1 != utop ? 1 : 0} ${utop > minus1 ? 1 : 0} ${minus1 == utop ? 1 : 0} (expect 1 1 1 0)`);

  sleep(seconds(3));
  let almost: u32 = 4294967295;
  displayText(`H: ${u32(minus1) / 2} ${i32(almost) - one} ${(minus1 >>> 0) / 2} (expect 2147483647 -2 2147483647)`);

  sleep(seconds(3));
  let small: u8 = 9; let wide: u8 = 9; let big = 300; let debt = -50; let pay = 75;
  small = minus5; wide = big;
  setResources(P1, "set", debt, "ore");
  displayText(`I: a u8 of -5 is ${small}, of 300 is ${wide} (expect 0 255); your ORE was set from -50: the top bar says 0`);
  sleep(seconds(2));
  setResources(P1, "set", pay, "ore");
  displayText("I: and now from 75: the top bar says 75");

  sleep(seconds(2));
  let none = -3;
  createUnit(P1, units.TerranMarine, none, HOME);
  displayText("I2: createUnit with a count of -3: NO Marine appeared");
  sleep(seconds(2));
  createUnit(P1, units.TerranMarine, two, HOME);
  displayText("I2: and with a count of 2: two Marines appeared next to your base");

  sleep(seconds(2));
  let i = 3; let rounds = 0;
  while (i >= 0) { i--; rounds++; }
  displayText(`J: while (i >= 0) ran ${rounds} times and left i at ${i} (expect 4 and -1)`);

  sleep(seconds(3));
  switch (minus1) {
    case 1: displayText("K: FAILED - plus one"); break;
    case -1: displayText("K: minus one"); break;
    default: displayText("K: FAILED - neither");
  }

  sleep(seconds(3));
  let count: u32 = 4000000000;
  count += 5;
  displayText(`L: ${count} (expect 4000000005)`);

  sleep(seconds(3));
  const marine = first({ owner: P1, type: units.TerranMarine });
  if (marine) { marine.hp -= 1000; displayText("M: one of your Marines lost 1000 hit points: it DIED"); }
  else displayText("M: FAILED - no Marine of yours was found");

  sleep(seconds(6));
  displayText("done");
}, { owner: P1 });

program(() => {
  let debt = 0;
  sleep(seconds(52));
  debt -= 5;
  displayText(`N: ${name(CurrentPlayer)} owes ${debt} (expect -5)`);
}, { owner: players.Force1 });
