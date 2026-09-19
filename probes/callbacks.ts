// TrigScript 3.9's probe (slice 8½), part one: the array methods that take a function. The function is inlined into the
// loop the method becomes, so nothing here is a function when the map is played. Play it alone (Use Map Settings): you
// are Player 1, Terran, with a Command Center and four Marines. Every line says what it expects, so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  forEach with the place, adding into a variable from outside                     — expect 78
//   5 s  B  some, every, findIndex, findLastIndex, find ?? -1 (found, and not)              — expect 1 0 2 -1 30 -1
//   8 s  C  filter of 64 cells growing past its first blocks, and map of a fixed array      — expect 56 63 20
//  11 s  D  a chain: filter, map, reduce                                                    — expect 210
//  14 s  E  records sorted by a field, and the rows a filter keeps                          — expect 649 2
//  17 s  F  forEach over a list the script has makes units: TWO Firebats and ONE Ghost appear by your base
//  20 s  G  every Marine of yours set to 30 hit points through forEach; counted and summed  — expect 4 120
//  23 s  H  your Marines kept in an array, one hurt, sorted by hit points, the weakest killed: ONE Marine dies — expect 4 10 0
//  26 s  I  256 cells nearly in order sorted: no pause to speak of                          — expect 1
//  30 s  J  256 cells the wrong way round sorted within one frame: SAY HOW LONG THE GAME STOPS — expect 1 1 256
//  36 s  K  in a program of every player, a row a player — expect "K: <your name> 15"
//  40 s  "done"
//
// Built with `npx tsx scripts/build-fixture.mts probes/callbacks.ts fixtures/eud/callbacks.scx`.
import { trigger, program, always, displayText, createUnit, sleep, seconds, unitsOf, name, units, P1, CurrentPlayer, AllPlayers, type Location } from "trigscript";

const HOME = 1 as Location;
const arrivals = [{ unit: units.TerranFirebat, n: 2 }, { unit: units.TerranGhost, n: 1 }];

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  let hp = [5, 30, 12, 8];
  // A bound that is a variable keeps a loop a loop: one whose bounds the script knows is written out turn by turn.
  let sixtyFour = 64;
  let many = 256;
  let cells = new Array(64).fill(0);
  for (let i = 0; i < sixtyFour; i++) cells[i] = i;

  sleep(seconds(2));
  let total = 0;
  hp.forEach((h, i) => { total += h * i; });
  displayText(`A: ${total} (expect 78)`);

  sleep(seconds(3));
  const any = hp.some((h) => h > 20) ? 1 : 0;
  const all = hp.every((h) => h > 20) ? 1 : 0;
  const where = hp.findIndex((h) => h == 12);
  const nowhere = hp.findLastIndex((h) => h > 100);
  const found = hp.find((h) => h > 20) ?? -1;
  const missing = hp.find((h) => h > 100) ?? -1;
  displayText(`B: ${any} ${all} ${where} ${nowhere} ${found} ${missing} (expect 1 0 2 -1 30 -1)`);

  sleep(seconds(3));
  const kept = cells.filter((c) => c % 8 != 0);
  const twice = hp.map((h, i) => h * 2 + i);
  displayText(`C: ${kept.length} ${kept[55]} ${twice[3] + 1} (expect 56 63 20)`);

  sleep(seconds(3));
  const sum = cells.filter((c) => c < 20).map((c) => c + 1).reduce((s, c) => s + c, 0);
  displayText(`D: ${sum} (expect 210)`);

  sleep(seconds(3));
  let waves = [{ count: 9, delay: 5 }, { count: 4, delay: 2 }, { count: 6, delay: 1 }];
  waves.sort((a, b) => a.delay - b.delay);
  const slow = waves.filter((w) => w.delay > 1);
  displayText(`E: ${waves[0].count * 100 + waves[1].count * 10 + waves[2].count} ${slow.length} (expect 649 2)`);

  sleep(seconds(3));
  arrivals.forEach((a) => createUnit(P1, a.unit, a.n, HOME));
  displayText("F: TWO Firebats and ONE Ghost by your base");

  sleep(seconds(3));
  unitsOf(P1, { type: units.TerranMarine }).forEach((u) => { u.hp = 30; });
  const marines = unitsOf(P1, { type: units.TerranMarine }).reduce((n, u) => n + 1, 0);
  const life = unitsOf(P1, { type: units.TerranMarine }).reduce((n, u) => n + u.hp, 0);
  displayText(`G: ${marines} ${life} - every Marine at 30 hit points (expect 4 120)`);

  sleep(seconds(3));
  const squad = unitsOf(P1, { type: units.TerranMarine }).filter((u) => u.hp > 0);
  const unlucky = squad[2];
  if (unlucky) unlucky.hp = 10;
  squad.sort((a, b) => a.hp - b.hp);
  const weakest = squad[0];
  let least = -1;
  if (weakest) { least = weakest.hp; weakest.kill(); }
  const giant = squad.find((u) => u.hp > 5000);
  displayText(`H: ${squad.length} ${least} ${giant ? 1 : 0} - ONE Marine dies (expect 4 10 0)`);

  sleep(seconds(3));
  let big = new Array(256).fill(0);
  for (let i = 0; i < many; i++) big[i] = i + 1;
  big[100] = 3;
  big.sort((a, b) => a - b);
  let inOrder = 1;
  for (let i = 1; i < many; i++) if (big[i - 1] > big[i]) inOrder = 0;
  displayText(`I: ${inOrder} - nearly in order, no pause to speak of (expect 1)`);

  sleep(seconds(4));
  for (let i = 0; i < many; i++) big[i] = 256 - i;
  displayText("J: sorting 256 cells the wrong way round NOW - how long does the game stop?");
  big.sort((a, b) => a - b);
  inOrder = 1;
  for (let i = 1; i < many; i++) if (big[i - 1] > big[i]) inOrder = 0;
  displayText(`J: ${inOrder} ${big[0]} ${big[255]} (expect 1 1 256)`);

  sleep(seconds(10));
  displayText("done");
}, { owner: P1 });

program(() => {
  sleep(seconds(36));
  let mine = [1, 2, 3, 4, 5];
  let sum = 0;
  mine.forEach((m) => { sum += m; });
  displayText(`K: ${name(CurrentPlayer)} ${sum} (expect your name and 15)`);
}, { owner: AllPlayers });
