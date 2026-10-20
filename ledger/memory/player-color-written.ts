// ledger: step 6, refused: a write of player.color
// A player's colour, one of `colors.*`, at once: `stats(P1).color = colors.green`.
program(() => {
  stats(P1).color = colors.green;
});
