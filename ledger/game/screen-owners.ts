// ledger: step 6, refused: a write of player.color
// The screen library's pixel owners, `OWNERS`, a player a colour: each given the colour of its pixels.
import { OWNERS } from "trigscript/screen";
const LOOK = ["teal", "yellow", "purple", "green", "red", "blue", "orange"] as const;
program(() => {
  OWNERS.forEach((owner, k) => {
    stats(owner).color = LOOK[k];
  });
});
