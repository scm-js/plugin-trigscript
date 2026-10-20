// TrigScript 4, the backend: the game's numbers read as values in a map of our own (scripts/build-own.mts) — step 5
// of the way off eudplib, part 3. One player's deaths, kills, ore or gas are read where the game keeps them, a bit at a
// time from the highest group of eight bits the number has; anything else — a sum over a group, units counted, a score,
// the clocks — is the condition asked a bit at a time from the top. Built both ways (through eudplib, and as a map of
// our own), the lifted game should print the same lines at the same frames; every line should end "ok", and a line
// ending "WRONG" names the check that failed (line F prints what it read: the two builds should agree). Frames 2 and 4
// (the lifted game's 4 and 6) are each 200 reads, to weigh.
//   npx tsx scripts/build-own.mts probes/own-reads.ts /tmp/own-reads.scx
//   npx tsx scripts/build-fixture.mts probes/own-reads.ts /tmp/own-reads-eud.scx
// The map build-own makes: Player 1 a person with a Command Center and 4 Marines, Player 2 a computer with a Hatchery
// and 4 Zerglings.
import { program, print, sleep, frames } from "trigscript";

program(() => {
  // A: ore and gas where the game keeps them — under 2^8, 2^16 and past 2^24 — and their sum, asked of the condition.
  setResources(P1, "set", 200, "ore");
  const small = minerals(P1);
  setResources(P1, "set", 1234, "ore");
  setResources(P1, "set", 70000, "gas");
  const ore = minerals(P1), gas = gas_();
  setResources(P2, "set", 123456789, "ore");
  const big = minerals(P2);
  const both = resources(P1, "oreAndGas");
  if (small == 200 && ore == 1234 && gas == 70000 && big == 123456789 && both == 71234 && minerals(P1) - gas_() == -68766) print("A: ore and gas ok");
  else print("A: ore and gas WRONG");
  // B: deaths and kills.
  setDeaths(P1, units.TerranMarine, "set", 7);
  if (deaths(P1, units.TerranMarine) == 7 && kills(P1, units.ZergZergling) == 0) print("B: deaths and kills ok"); else print("B: deaths and kills WRONG");
  // C: units counted — Command, and Bring at a location.
  if (command(P1, units.TerranMarine) == 4 && countUnits(P1, units.TerranMarine, locations.Anywhere) == 4 && countUnits(P2, units.ZergZergling) == 4) print("C: units counted ok");
  else print("C: units counted WRONG");
  // D: the clocks, a score, the opponents.
  setCountdownTimer("set", 90);
  setScore(P1, "set", 4321, "custom");
  if (countdown() == 90 && elapsed() == 0 && score(P1, "custom") == 4321 && opponents(P1) == 1) print("D: clocks, score, opponents ok");
  else print("D: clocks, score, opponents WRONG");
  // E: who the players are.
  if (race(P1) == races.Terran && race(P2) == races.Zerg && slot(P2) == slots.Computer && !isHuman(P2)) print("E: players ok"); else print("E: players WRONG");
  // F: supply, as the top bar shows it (printed: both builds should agree).
  print(`F: supply ${supply(P1)} of ${supply(P1, "provided")}, at most ${supply(P1, "max")}; Zerg ${supply(P2, "used", races.Zerg)}`);
  sleep(frames(2));
  // Frame 2: 200 reads of ore where the game keeps it, under 2^16.
  let j = 0, sum = 0;
  while (j < 200) { sum += minerals(P1); j++; }
  if (sum == 246800) print("G: 200 reads of ore ok"); else print("G: 200 reads of ore WRONG");
  sleep(frames(2));
  // Frame 4: 200 counts of units, the condition asked a bit at a time.
  j = 0; sum = 0;
  while (j < 200) { sum += countUnits(P1, units.TerranMarine); j++; }
  if (sum == 800) print("H: 200 counts of units ok"); else print("H: 200 counts of units WRONG");
  print("Own reads: done.");
});

function gas_(): number { return gas(P1); }
