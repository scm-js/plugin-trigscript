// TrigScript 4, the backend: a location moved in a map of our own (scripts/build-fixture.mts) — step 5 of the way off
// eudplib, part 4. `centerLocation` writes the four sides where the game keeps them (MRGN), each a Set Deaths whose
// amount is a place of the side, then throws Bring's counts away (the game keeps them for a location whose sides are
// written); without a size, the sides are read first and the size kept. Built both ways (through eudplib, and as a map
// of our own), the lifted game should print the same lines at the same frames; every line should end "ok", and a line
// ending "WRONG" names the check that failed. Frame 2 (the lifted game's 4) is 200 moves, to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-locations.ts /tmp/own-locations.scx
//   npx tsx scripts/build-fixture.mts probes/own-locations.ts /tmp/own-locations-eud.scx
// Location 5 is one the map does not use (a location is its number where the map's names are not known).
import { program, print, sleep, frames } from "trigscript";

const MRGN = 0x58dc60, SPOT = 5, AT = MRGN + (SPOT - 1) * 20;

program(() => {
  // A: centred on a point with a size, from values.
  let x = 1000, y = 900, w = 64;
  x += 24;
  centerLocation(SPOT, x, y, w, 32);
  if (memory(AT, "==", 992) && memory(AT + 4, "==", 884) && memory(AT + 8, "==", 1056) && memory(AT + 12, "==", 916)) print("A: centred with a size ok");
  else print("A: centred with a size WRONG");
  // B: moved again with no size: the size kept.
  x = 2000;
  centerLocation(SPOT, x, 500);
  if (memory(AT, "==", 1968) && memory(AT + 4, "==", 484) && memory(AT + 8, "==", 2032) && memory(AT + 12, "==", 516)) print("B: the size kept ok");
  else print("B: the size kept WRONG");
  // C: Bring of the location before and after it moves: counted again (the Wraiths are made at its centre; one at least
  // is inside a box of 64 by 32).
  createUnit(P1, units.TerranWraith, 2, SPOT);
  // (Into a boolean: a condition kept in a `const` is asked where it is used, after the move.)
  let there = false;
  if (bring(P1, units.TerranWraith, SPOT, ">=", 1)) there = true;
  centerLocation(SPOT, 3000, 3000);
  if (there && bring(P1, units.TerranWraith, SPOT, "==", 0)) print("C: Bring after a move ok"); else print("C: Bring after a move WRONG");
  sleep(frames(2));
  // Frame 2: 200 moves of the location, each to a point from a value, its size kept.
  let j = 0;
  while (j < 200) { centerLocation(SPOT, 100 + j, 200, 32, 32); j++; }
  if (memory(AT, "==", 283) && memory(AT + 8, "==", 315)) print("D: 200 moves ok"); else print("D: 200 moves WRONG");
  print("Own locations: done.");
});
