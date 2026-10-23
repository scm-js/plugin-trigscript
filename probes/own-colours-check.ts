// A player's colour in a printed line, for each of the eight players, beside every colour code the game's texts have:
// the code `color(P)` comes out as is the one nearest the first shade the game keeps for the player (8 bytes a player
// at 0x581D76), through eudplib's table. Built both ways (`build-own`, `build-fixture`), to tell a colour the game keeps
// from one either build picks.
//   npx tsx scripts/build-fixture.mts probes/own-colours-check.ts /tmp/own-colours-check.scx
//   npx tsx scripts/build-fixture.mts probes/own-colours-check.ts /tmp/own-colours-check-eud.scx
import { program, print, sleep, frames } from "trigscript";

program(() => {
  sleep(frames(1));
  print("A: \x088 \x0E14 \x0F15 \x1016 \x1117 \x1521 \x1622 \x1723 \x1824 \x1925 \x1B27 \x1C28 \x1D29 \x1E30 \x1F31");
  print(`B: ${color(P1)}P1 ${color(P2)}P2 ${color(P3)}P3 ${color(P4)}P4 ${color(P5)}P5 ${color(P6)}P6 ${color(P7)}P7 ${color(P8)}P8`);
  sleep(frames(48));
  print(`C: two seconds in, ${color(P1)}${name(P1)}\x04 and ${color(P2)}${name(P2)}`);
});
