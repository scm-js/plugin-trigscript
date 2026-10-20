// ledger: step 6, refused: a write of player.researched
// Whether a player has a technology, given: `stats(P1).researched[techs.Lockdown] = true`.
program(() => {
  stats(P1).researched[techs.Lockdown] = true;
});
