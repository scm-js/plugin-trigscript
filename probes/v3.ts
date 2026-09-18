// TrigScript 3.0's probe: what changed in the lowering, each check announcing what to look for.
// Play it alone (Use Map Settings): you are Player 1, Terran; Player 2 is a computer in the other force.
//
//   0 s   "trigger(): hello" — an ordinary trigger of the same script, beside the programs.
//   1 s   "A: ore 31, gas 15" — then look at your resources: 7 / 2 * 10 + 7 % 2, and Math.abs(5 - 20).
//   4 s   "B: ore 111, gas 1" — a - b < 0 with a = 3, b = 5 is true (111, not 222); x >= -1 is true, and 7 / 0 is 0.
//   7 s   "C: three Marines" — createUnit with a variable count of 3, at the centre of the map.
//  10 s   "D: ore 1111 from the computer's program" — a program owned by Force 2 runs for the computer player.
//  13 s   "E: gas counts up once a second, for you alone" — a per-player program owned by your force.
//  every text above is a program's own: none of them is in the map's string table, eudplib adds them.
//
// Built with `npx tsx scripts/build-fixture.mts probes/v3.ts fixtures/eud/v3.scx`.
import { trigger, program, always, displayText, setResources, createUnit, sleep, seconds, units, locations, players, P1, AllPlayers } from "trigscript";

trigger(AllPlayers, [always()], [displayText("trigger(): hello")]);

program(() => {
  let a = 7; let b = 2; let zero = 0;
  sleep(seconds(1));
  displayText("A: ore 31, gas 15");
  setResources(P1, "set", a / b * 10 + a % b, "ore");
  let lo = 5; let hi = 20;
  setResources(P1, "set", Math.abs(lo - hi), "gas");

  sleep(seconds(3));
  displayText("B: ore 111, gas 1");
  let x = 3; let y = 5; let ore = 222;
  if (x - y < 0) ore = 111;
  setResources(P1, "set", ore, "ore");
  let gas = a / zero;
  if (x >= -1) gas += 1;
  setResources(P1, "set", gas, "gas");

  sleep(seconds(3));
  displayText("C: three Marines");
  let n = 3;
  createUnit(P1, units.TerranMarine, n, locations.Anywhere);
}, { owner: P1 });

program(() => {
  sleep(seconds(10));
  setResources(P1, "set", 1111, "ore");
}, { owner: players.Force2 });

program(() => {
  let ticks = 0;
  sleep(seconds(10));
  displayText("D: ore 1111 from the computer's program");
  sleep(seconds(3));
  displayText("E: gas counts up once a second, for you alone");
  while (true) {
    ticks += 1;
    setResources(P1, "set", ticks, "gas");
    sleep(seconds(1));
  }
}, { owner: players.Force1 });
