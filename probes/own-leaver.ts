// probe-players: {"1":{"type":6}}
// TrigScript 4, the backend: a player who leaves, in a map of our own (scripts/build-own.mts) — step 7 of the way off
// eudplib. Two people, P1 and P2; each frame a program for every player adds 1 to its player's Marine deaths, P1's own
// program to P1's Firebat deaths, and P2's own program to P2's Firebat deaths and — once P1 has left — to P2's Ghost
// deaths. When P1 leaves, P1's runs stop and P2's go on, the same in both builds (the lifted game's two-person game,
// scratchpad leave.mts: the deaths read each frame, one person leaving between two turns).
//   npx tsx scripts/build-own.mts probes/own-leaver.ts /tmp/own-leaver.scx
//   npx tsx scripts/build-fixture.mts probes/own-leaver.ts /tmp/own-leaver-eud.scx
import { program, sleep, frames } from "trigscript";

program(() => {
  while (true) {
    setDeaths(CurrentPlayer, units.TerranMarine, "add", 1);
    sleep(frames(1));
  }
}, { owner: AllPlayers });
program(() => {
  while (true) {
    setDeaths(P1, units.TerranFirebat, "add", 1);
    sleep(frames(1));
  }
}, { owner: P1 });
program(() => {
  while (true) {
    setDeaths(P2, units.TerranFirebat, "add", 1);
    if (hasLeft(P1)) setDeaths(P2, units.TerranGhost, "add", 1);
    sleep(frames(1));
  }
}, { owner: P2 });
