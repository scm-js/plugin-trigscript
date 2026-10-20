// TrigScript 4, the backend: step 5 of the way off eudplib in Remastered — the game's conditions and actions in a map
// of our own, what the lifted game cannot show: a print at the centre of the screen, Transmissions in a loop, a print
// to every player, counts read straight after units are made, a location moved and units made there.
//   npx tsx scripts/build-own.mts probes/own-step5.ts own-step5.scx
// Played with own-step5-answers.txt beside it.
import { program, print, sleep, seconds } from "trigscript";

const SPOT = 5;

program(() => {
  sleep(seconds(2));
  // 1: at the centre of the screen, with a number made while the game runs.
  let wave = 2;
  wave += 13;
  print(`Centre: wave ${wave}`, { position: "center" });
  sleep(seconds(3));
  // 2: three Transmissions, two seconds apart, each with its own text.
  let i = 1;
  while (i <= 3) {
    transmission(`Transmission ${i} of 3`, units.TerranMarine, locations.Anywhere, "set", 1500, "sound\\glue\\mousedown2.wav", 0);
    i++;
    sleep(seconds(2));
  }
  // 3: to every player.
  print("To every player: hello", { to: AllPlayers });
  // 4: units made, then counted straight after (Command and Bring), and the count printed.
  createUnit(P1, units.TerranWraith, 3, locations.Anywhere);
  const made = countUnits(P1, units.TerranWraith);
  print(`Wraiths counted: ${made} (should be 3)`);
  sleep(seconds(2));
  // 5: a location centred on a point from a value; two Goliaths made there, counted there.
  let x = 1000;
  x += 536;
  centerLocation(SPOT, x, 1536, 128, 128);
  createUnit(P1, units.TerranGoliath, 2, SPOT);
  print(`Goliaths at the spot: ${countUnits(P1, units.TerranGoliath, SPOT)} (should be 2)`);
  print("Step 5 probe: done.");
});
