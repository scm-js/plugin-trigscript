// TrigScript 4, the backend: the game's tables read and written in a map of our own (scripts/build-own.mts) — step 6
// of the way off eudplib. A cell of `stats()` or `memory.*` is at an address known when the map is built: read, its
// bits of the dword it is in moved down; written, a Set Deaths into that dword — masked for a byte, a word or a bit —
// its amount a place of the value. Built both ways (through eudplib, and as a map of our own), the lifted game should
// print the same lines at the same frames; every line should end "ok", and a line ending "WRONG" names the check that
// failed (line G prints what it read: both builds should agree). Frames 2 and 4 (the lifted game's 4 and 6) are each
// 200 reads or writes, to weigh.
//   npx tsx scripts/build-own.mts probes/own-memory.ts /tmp/own-memory.scx
//   npx tsx scripts/build-fixture.mts probes/own-memory.ts /tmp/own-memory-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  // A: a unit type's cost (a word) and hit points (a dword, 256 to a point), read and written from values.
  const cost = stats(units.TerranMarine).minerals;
  let more = cost;
  more += 25;
  stats(units.TerranMarine).minerals = more;
  let hp = 40;
  hp += 20;
  stats(units.TerranMarine).maxHp = hp;
  if (cost == 50 && stats(units.TerranMarine).minerals == 75 && stats(units.TerranMarine).maxHp == 60 && stats(units.TerranFirebat).minerals == 50) print("A: costs and hit points ok");
  else print("A: costs and hit points WRONG");
  // B: a byte beside others (an upgrade level of one player), a bit (a flag of a unit type).
  stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3;
  stats(P2).upgrades[upgrades.TerranInfantryWeapons] = 1;
  const organic = stats(units.TerranMarine).organic;
  stats(units.TerranMarine).detector = true;
  if (stats(P1).upgrades[upgrades.TerranInfantryWeapons] == 3 && stats(P2).upgrades[upgrades.TerranInfantryWeapons] == 1 && organic && stats(units.TerranMarine).detector && !stats(units.TerranGoliath).organic) print("B: bytes and bits ok");
  else print("B: bytes and bits WRONG");
  // C: a weapon's damage added to, a byte stopped at its top (300 into a byte is 255).
  stats(weapons.GaussRifle).damage += 2;
  let big = 300;
  big += 0;
  stats(P1).upgrades[upgrades.TerranVehiclePlating] = big;
  if (stats(weapons.GaussRifle).damage == 8 && stats(P1).upgrades[upgrades.TerranVehiclePlating] == 255 && stats(P1).upgrades[upgrades.TerranInfantryWeapons] == 3) print("C: added to and stopped at the top ok");
  else print("C: added to and stopped at the top WRONG");
  // D: what the game keeps: the map's size, the frame.
  if (memory.map.width == 96 && memory.map.height == 96 && memory.game.frame >= 1) print("D: the map and the frame ok"); else print("D: the map and the frame WRONG");
  // H: top speeds, through the unit type's flingy (the Marine's is flingy 78, the Firebat's 73): the speed, the
  // acceleration a seventeenth of it, the halting distance v² / 2a, table control.
  stats(units.TerranMarine).speed = 6;
  let fast = 3;
  fast += 2;
  stats(units.TerranFirebat).speed = fast;
  const SPEED = 0x6c9ef8, HALT = 0x6c9930;
  if (memory(SPEED + 4 * 78, "==", 1536) && memory(HALT + 4 * 78, "==", 13107) && memory(SPEED + 4 * 73, "==", 1280) && memory(HALT + 4 * 73, "==", 10922)) print("H: top speeds ok");
  else print("H: top speeds WRONG");
  // G: read, printed (both builds should agree).
  print(`G: Marine ${stats(units.TerranMarine).minerals} ore, ${stats(units.TerranMarine).maxHp} hp, range ${stats(weapons.GaussRifle).range}, frame ${memory.game.frame}`);
  sleep(frames(2));
  // Frame 2: 200 reads of a word of the unit table.
  let j = 0, sum = 0;
  while (j < 200) { sum += stats(units.TerranFirebat).minerals; j++; }
  if (sum == 10000) print("E: 200 reads ok"); else print("E: 200 reads WRONG");
  sleep(frames(2));
  // Frame 4: 200 writes of a word from a value that changes every turn.
  j = 0;
  while (j < 200) { stats(units.TerranGhost).minerals = j; j++; }
  if (stats(units.TerranGhost).minerals == 199) print("F: 200 writes ok"); else print("F: 200 writes WRONG");
  print("Own memory: done.");
});
