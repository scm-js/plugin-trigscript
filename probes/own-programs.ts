// TrigScript 4, the backend: programs, owners and players in a map of our own (scripts/build-fixture.mts) — step 7 of the
// way off eudplib. Several programs in one map, each with variables of its own; a program for each of several players,
// each run with its own variables and the `shared` ones in common, `CurrentPlayer` the player it runs as; a print to a
// force; `hasLeft`. Built both ways (through eudplib, and as a map of our own), the lifted game should print the same
// lines at the same frames; every line should end "ok", and a line ending "WRONG" names the check that failed. Player 1
// is the person, Player 2 a computer in a force of its own (B prints how many runs there were: both builds should agree).
//   npx tsx scripts/build-fixture.mts probes/own-programs.ts /tmp/own-programs.scx
//   npx tsx scripts/build-fixture.mts probes/own-programs.ts /tmp/own-programs-eud.scx
import { program, print, sleep, frames } from "trigscript";

// A: two programs side by side, each with an n of its own; the second is Player 2's.
program(() => {
  let n = 0;
  while (n < 3) n += 1;
  sleep(frames(1));
  if (n == 3) print("A: the first program ok"); else print("A: the first program WRONG");
});
program(() => {
  let n = 10;
  n += 5;
  sleep(frames(2));
  if (n == 15) print("A: the second program ok", { to: P1 }); else print("A: the second program WRONG", { to: P1 });
}, { owner: P2 });

// B: a program for Player 1 and Player 2, each run with a count of its own and the total shared; C: each run's
// minerals, as `CurrentPlayer` names them, its own.
program(() => {
  let mine = 0;
  let total = shared(0);
  mine += 1;
  total += 1;
  setResources(CurrentPlayer, "set", 100, "ore");
  setResources(CurrentPlayer, "add", 7, "ore");
  sleep(frames(3));
  mine += 10;
  if (mine == 11) print(`B: own variables ok, ${total} runs`, { to: P1 }); else print(`B: own variables WRONG (${mine})`, { to: P1 });
  if (accumulate(CurrentPlayer, "==", 107, "ore") && accumulate(P1, "==", 107, "ore")) print("C: the current player ok", { to: P1 });
  else print("C: the current player WRONG", { to: P1 });
}, { owner: [P1, P2] });

// D: a print to the first force (Player 1's) and none to the second's; E: nobody has left (Player 3 has no slot).
program(() => {
  sleep(frames(5));
  print("D: a print to a force ok", { to: players.Force1 });
  print("D: a print to the other force WRONG", { to: players.Force2 });
  if (!hasLeft(P1) && !hasLeft(P2) && !hasLeft(P3)) print("E: nobody has left ok"); else print("E: nobody has left WRONG");
});
